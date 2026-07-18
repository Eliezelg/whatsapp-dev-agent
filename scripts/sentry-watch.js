#!/usr/bin/env node
/**
 * sentry-watch — source Sentry pour le WhatsApp Dev Agent.
 *
 * Lancé périodiquement par sentry-watch.timer (systemd, toutes les 5 min).
 * Poll l'API Sentry pour les nouvelles issues non résolues, puis les injecte
 * dans le pipeline EXISTANT de l'agent via POST /api/dispatch (canal API,
 * autoConfirm) : Gemini route → dispatcher (sécurité, rate limit, sessions)
 * → Claude Code corrige, teste, commit, push. Le propriétaire est prévenu
 * sur WhatsApp via POST /notify.
 *
 * Config (dans /etc/whatsapp-agent.env) :
 *   SENTRY_TOKEN     token API Sentry (scopes org:read, project:read, event:read)
 *   SENTRY_ORG       slug de l'organisation Sentry
 *   SENTRY_PROJECTS  mapping "slugSentry:projetAgent" séparés par des virgules
 *                    ex : "tzedakal-api:tzedakal,familink-web:familink"
 *   SENTRY_HOST      optionnel, défaut sentry.io (self-hosted possible)
 *
 * Anti-boucle : chaque issue n'est dispatchée qu'UNE fois (état persistant
 * dans $STATE_DIRECTORY/handled.json), max 2 dispatchs par run, et le rate
 * limiter + activeSessions du dispatcher s'appliquent par-dessus.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SENTRY_TOKEN = process.env.SENTRY_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG;
const SENTRY_HOST = process.env.SENTRY_HOST || 'sentry.io';
const API_TOKEN = process.env.API_TOKEN;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN;
const AGENT_BASE = 'http://127.0.0.1:5111';

// Sécurité alignée sur l'agent : MAX_MESSAGE_LENGTH = 4000 côté dispatcher.
const MAX_DISPATCH_CHARS = 3500;
const MAX_DISPATCH_PER_RUN = 2;
const MAX_ISSUES_PER_PROJECT = 10;

const STATE_DIR = process.env.STATE_DIRECTORY || './sentry-watch-state';
const STATE_FILE = join(STATE_DIR, 'handled.json');

function parseProjectMap(raw) {
  // "slugSentry:projetAgent,slug2:projet2" -> { slugSentry: projetAgent, ... }
  const map = {};
  for (const pair of (raw || '').split(',')) {
    const [slug, project] = pair.split(':').map((s) => s && s.trim());
    if (slug && project) map[slug] = project;
  }
  return map;
}

const PROJECT_MAP = parseProjectMap(process.env.SENTRY_PROJECTS);

if (!SENTRY_TOKEN || !SENTRY_ORG || Object.keys(PROJECT_MAP).length === 0) {
  console.log('[sentry-watch] non configuré (SENTRY_TOKEN / SENTRY_ORG / SENTRY_PROJECTS manquants) — rien à faire.');
  process.exit(0);
}
if (!API_TOKEN) {
  console.error('[sentry-watch] API_TOKEN manquant — impossible de dispatcher.');
  process.exit(1);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { handled: [] };
  }
}
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  // Borne mémoire : on garde les 2000 derniers ids.
  if (state.handled.length > 2000) state.handled = state.handled.slice(-2000);
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function sentryGet(path) {
  const res = await fetch(`https://${SENTRY_HOST}${path}`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Sentry GET ${path} → ${res.status}`);
  return res.json();
}

async function agentRequest(method, path, token, body) {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

/** Notification WhatsApp best-effort : ne bloque jamais le flux principal. */
async function notifyOwner(text) {
  if (!NOTIFY_TOKEN) return;
  try {
    await agentRequest('POST', '/notify', NOTIFY_TOKEN, { text });
  } catch (err) {
    console.warn('[sentry-watch] notify WhatsApp échoué:', err.message);
  }
}

/** Extrait les frames applicatives (in_app) de la stacktrace du dernier event. */
function compactStacktrace(event) {
  const lines = [];
  const exceptions = (event?.entries || []).find((e) => e.type === 'exception');
  for (const value of exceptions?.data?.values || []) {
    lines.push(`${value.type}: ${(value.value || '').slice(0, 200)}`);
    const frames = (value.stacktrace?.frames || []).filter((f) => f.inApp !== false);
    // Les frames Sentry sont de la plus ancienne à la plus récente : on garde
    // les 8 dernières (les plus proches de l'erreur), ordre inversé pour lecture.
    for (const f of frames.slice(-8).reverse()) {
      lines.push(`  at ${f.function || '?'} (${f.filename || f.absPath || '?'}:${f.lineNo ?? '?'})`);
    }
  }
  if (lines.length === 0) {
    // Pas d'exception structurée (erreur message-only) : titre + logger.
    lines.push(event?.title || '(pas de stacktrace)');
  }
  return lines.join('\n');
}

function buildMessage(issue, stacktrace) {
  const header =
    `[AUTOFIX SENTRY] Une erreur de production est remontée par Sentry sur ce projet. ` +
    `Transmets à Claude Code le contexte complet ci-dessous, tel quel, avec ces consignes : ` +
    `analyser la CAUSE RACINE, corriger proprement (pas de patch symptôme, pas de catch silencieux), ` +
    `lancer les tests du projet, puis si le fix est sûr et les tests verts : ` +
    `git add des seuls fichiers modifiés (chemins explicites), ` +
    `commit "fix: <description> (Sentry ${issue.shortId})", git push sur la branche courante. ` +
    `Si le fix n'est pas sûr : ne rien committer et écrire l'analyse dans AUTOFIX-REPORT-${issue.shortId}.md.\n\n` +
    `Erreur : ${issue.title}\n` +
    `Issue : ${issue.shortId} — ${issue.permalink}\n` +
    `Occurrences : ${issue.count} (première : ${issue.firstSeen})\n` +
    `Culprit : ${issue.culprit || 'inconnu'}\n\n` +
    `Stacktrace :\n`;
  const budget = MAX_DISPATCH_CHARS - header.length;
  return header + stacktrace.slice(0, Math.max(0, budget));
}

async function main() {
  const state = loadState();
  const handled = new Set(state.handled);
  let dispatched = 0;

  for (const [slug, project] of Object.entries(PROJECT_MAP)) {
    if (dispatched >= MAX_DISPATCH_PER_RUN) break;

    // Une exécution est déjà en cours sur ce projet → on réessaiera au
    // prochain tick (l'issue n'est pas marquée handled).
    try {
      const res = await agentRequest('GET', `/api/status/${encodeURIComponent(project)}`, API_TOKEN);
      if (res.ok && (await res.json()).active) {
        console.log(`[sentry-watch] ${project} : exécution en cours, on saute ce tour.`);
        continue;
      }
    } catch (err) {
      console.error(`[sentry-watch] agent injoignable (${err.message}) — abandon du run.`);
      return;
    }

    let issues;
    try {
      issues = await sentryGet(
        `/api/0/projects/${SENTRY_ORG}/${slug}/issues/?query=is%3Aunresolved&statsPeriod=24h&limit=${MAX_ISSUES_PER_PROJECT}`,
      );
    } catch (err) {
      console.error(`[sentry-watch] échec poll Sentry pour ${slug}:`, err.message);
      continue;
    }

    for (const issue of issues) {
      if (handled.has(issue.id)) continue;
      if (dispatched >= MAX_DISPATCH_PER_RUN) break;

      let stacktrace = '(stacktrace indisponible)';
      try {
        const event = await sentryGet(`/api/0/organizations/${SENTRY_ORG}/issues/${issue.id}/events/latest/`);
        stacktrace = compactStacktrace(event);
      } catch (err) {
        console.warn(`[sentry-watch] pas d'event pour l'issue ${issue.id}:`, err.message);
      }

      const message = buildMessage(issue, stacktrace);
      const res = await agentRequest('POST', '/api/dispatch', API_TOKEN, {
        message,
        senderId: 'sentry-watch',
        project,
      });
      if (res.status !== 202) {
        console.error(`[sentry-watch] dispatch refusé (${res.status}) pour ${issue.shortId} → ${project}`);
        continue; // pas marqué handled : retentative au prochain tick
      }

      // Marqué handled dès le dispatch accepté : une issue = une seule tentative
      // d'autofix (anti-boucle). Le résultat arrive sur WhatsApp + transcript.
      handled.add(issue.id);
      state.handled = [...handled];
      saveState(state);
      dispatched++;
      console.log(`[sentry-watch] issue ${issue.shortId} (${slug}) dispatché sur ${project}.`);
      await notifyOwner(
        `🚨 *Sentry ${issue.shortId}* sur *${project}*\n${issue.title.slice(0, 300)}\n${issue.permalink}\n\n🤖 Autofix lancé — résultat à suivre ici.`,
      );

      break; // un seul dispatch par projet par run (le dispatcher bloque la concurrence de toute façon)
    }
  }

  if (dispatched === 0) console.log('[sentry-watch] aucune nouvelle issue à traiter.');
}

main().catch((err) => {
  console.error('[sentry-watch] erreur fatale:', err);
  process.exit(1);
});
