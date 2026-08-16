#!/usr/bin/env node
/**
 * claude-auth-watch — sonde de santé de l'authentification Claude Code.
 *
 * Lancé périodiquement par claude-auth-watch.timer (systemd, 1×/jour).
 * Exécute un prompt trivial via le binaire Claude Code, dans les conditions
 * EXACTES du runner (même HOME, même env), et alerte par email si la
 * commande échoue — typiquement quand le token OAuth a expiré.
 *
 * Pourquoi une sonde active plutôt qu'une lecture de date d'expiration :
 * l'auth passe par CLAUDE_CODE_OAUTH_TOKEN, une variable d'environnement qui
 * n'expose aucune date. Seul un appel réel dit si le pipeline fonctionne —
 * et ça couvre aussi les pannes non liées à l'expiration (révocation, quota,
 * binaire cassé, réseau).
 *
 * Contexte : le pipeline est resté muet 26 jours en juillet-août 2026 après
 * une expiration de token, sans qu'aucun signal ne remonte. D'où ce watcher.
 *
 * Config (dans /etc/whatsapp-agent.env) :
 *   CLAUDE_BIN                chemin du binaire (défaut /usr/bin/claude)
 *   CLAUDE_HOME               HOME du runtime Claude Code (défaut $HOME)
 *   CLAUDE_CODE_OAUTH_TOKEN   token d'auth, transmis au sous-processus
 *   RESEND_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO  canal d'alerte
 *
 * Anti-spam : une alerte est envoyée au premier échec, puis au plus une tous
 * les ALERT_COOLDOWN_HOURS (état dans $STATE_DIRECTORY/last-alert.json).
 * Le retour à la normale envoie un email de rétablissement.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { sendAlertEmail } from '../notify-email.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/bin/claude';
const CLAUDE_HOME = process.env.CLAUDE_HOME || process.env.HOME;
const PROBE_TIMEOUT_MS = 120_000;
const ALERT_COOLDOWN_HOURS = 12;

const STATE_DIR = process.env.STATE_DIRECTORY || './claude-auth-watch-state';
const STATE_FILE = join(STATE_DIR, 'last-alert.json');

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Premier run, ou état corrompu : on repart d'un état sain plutôt que de
    // faire échouer la sonde. Au pire une alerte de plus, jamais une de moins.
    return { failing: false, lastAlertAt: null };
  }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    // L'état n'est qu'un anti-spam : son échec ne doit pas masquer le
    // résultat de la sonde, qui est l'information importante.
    console.warn('[claude-auth-watch] écriture état impossible:', err?.message || err);
  }
}

/**
 * Exécute un prompt trivial et retourne le verdict.
 * Ne throw jamais : toute anomalie devient un échec décrit.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function probeClaude() {
  return new Promise((resolve) => {
    // L'environnement reproduit EXACTEMENT la liste blanche de runner.js
    // (PATH / HOME / USER + token), et non `{...process.env}`. C'est le coeur
    // de la sonde : le runner n'expose au sous-processus qu'une poignée de
    // variables, donc hériter de tout l'env systemd testerait un chemin que
    // le pipeline n'emprunte jamais. Cette erreur a réellement été commise le
    // 2026-08-16 — la sonde passait au vert pendant que l'autofix échouait sur
    // "OAuth session expired". Toute divergence avec runner.js:147+ rend cette
    // sonde mensongère : les deux listes doivent rester synchronisées.
    const childEnv = {
      PATH: process.env.PATH,
      HOME: CLAUDE_HOME,
      USER: 'wa-agent',
    };
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      childEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    const child = spawn(CLAUDE_BIN, ['-p', 'Reponds exactement: OK'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    // Timer manuel plutôt que l'option timeout de spawn() : même correctif que
    // le commit d1f1660 côté runner (l'option ne tue pas toujours le process).
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, detail: `timeout après ${PROBE_TIMEOUT_MS / 1000}s` });
    }, PROBE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `exec impossible: ${err?.message || err}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      if (code === 0 && /\bOK\b/i.test(stdout)) {
        resolve({ ok: true, detail: 'auth valide' });
        return;
      }
      resolve({ ok: false, detail: `code=${code} sortie="${output.slice(0, 500)}"` });
    });
  });
}

function shouldAlert(state, now) {
  if (!state.lastAlertAt) return true;
  const elapsedHours = (now - new Date(state.lastAlertAt).getTime()) / 3_600_000;
  return elapsedHours >= ALERT_COOLDOWN_HOURS;
}

async function main() {
  const result = await probeClaude();
  const state = loadState();
  const now = Date.now();

  if (result.ok) {
    console.log('[claude-auth-watch] OK — auth Claude Code fonctionnelle.');
    if (state.failing) {
      await sendAlertEmail(
        'Auth Claude Code rétablie',
        `La sonde répond de nouveau correctement.\n\nHOME : ${CLAUDE_HOME}\nBinaire : ${CLAUDE_BIN}`,
      );
      saveState({ failing: false, lastAlertAt: null });
    }
    return;
  }

  console.error('[claude-auth-watch] ÉCHEC —', result.detail);

  if (!shouldAlert(state, now)) {
    console.log('[claude-auth-watch] alerte déjà envoyée récemment — pas de relance.');
    return;
  }

  const sent = await sendAlertEmail(
    'Auth Claude Code en échec — pipeline à l’arrêt',
    [
      "La sonde d'authentification Claude Code a échoué.",
      'Tant que ce n’est pas corrigé, le pipeline whatsapp-agent et les autofix Sentry ne fonctionnent plus.',
      '',
      `Détail : ${result.detail}`,
      `HOME : ${CLAUDE_HOME}`,
      `Binaire : ${CLAUDE_BIN}`,
      '',
      'Cause la plus probable : le token CLAUDE_CODE_OAUTH_TOKEN a expiré ou été révoqué.',
      '',
      'Pour régénérer un token (sur le VPS, en root) :',
      `  sudo -u wa-agent env HOME=${CLAUDE_HOME} ${CLAUDE_BIN} setup-token`,
      'puis remplacer la ligne CLAUDE_CODE_OAUTH_TOKEN= dans /etc/whatsapp-agent.env',
      'et redémarrer : systemctl restart whatsapp-agent.service',
    ].join('\n'),
  );

  saveState({ failing: true, lastAlertAt: sent ? new Date(now).toISOString() : state.lastAlertAt });
  process.exitCode = 1;
}

main();
