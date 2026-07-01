# Orchestrateur multi-canal (WhatsApp, canal email différé) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réduire le coût du dispatcher Gemini de `whatsapp-agent` en basculant sur un modèle moins cher adapté à sa charge réelle (classification + JSON, pas de raisonnement complexe), puis extraire son cœur métier (`core/dispatcher.js`) en module canal-agnostique pour préparer proprement de futures extensions (app Android v2), sans construire ces extensions maintenant.

**Architecture:** Task 0 est un changement de config pur (variable d'env), zéro risque de régression fonctionnelle. Task 1 extrait la logique de confirmation/refus/dispatch de `index.js` (aujourd'hui couplée à Baileys/WhatsApp) vers `core/dispatcher.js`, injectée par dépendances et testable sans WhatsApp réel — le comportement WhatsApp observable ne change pas. Task 2 livre un squelette d'API HTTP token-authentifiée pour une future app Android, testé mais volontairement non branché en production (YAGNI : pas de client à servir aujourd'hui).

**Tech Stack:** Node.js 22+ (ESM), Baileys (WhatsApp, inchangé), `@google/generative-ai` (Gemini), `node --test` (tests, introduit ici — aucun framework de test n'existe actuellement dans `whatsapp-agent`, on suit le pattern déjà utilisé côté `familink-agent/agent`).

---

## Contexte VPS (tzedakal-prod, 178.105.99.77)

- `/opt/whatsapp-agent/app` — repo git `wa-agent` user (pas root), remote `github.com/Eliezelg/whatsapp-dev-agent`, branche `main`, déjà 1 commit local en avance sur `origin/main`. **Ne pas toucher** à `package-lock.json` (déjà modifié par un autre process/agent) ni au dossier `auth.corrupt.20260623_210821/` — ce ne sont pas des changements de ce plan. Toujours `git status` avant chaque commit et n'ajouter QUE les fichiers listés explicitement dans chaque tâche — jamais `git add -A`/`git add .`.
- **Règle transverse : avant tout commit ou push, faire tourner toutes les vérifications de qualité disponibles pour ce projet** (tests, typecheck, build). Ici, `whatsapp-agent` est du JS pur (ESM natif, aucun `tsconfig.json`, aucun script `build` dans `package.json`) — donc pas de typecheck/build à exécuter, seule `node --test` s'applique. Chaque tâche de ce plan a un step explicite "Vérifications avant commit" avant son step "Commit" ; ne jamais committer si un test échoue.
- `/opt/familink-agent/repo` — Familink (produit), a son propre agent autonome `agent/` (feedback→fix→push), **on n'y touche pas**, il continue de notifier via le `/notify` de whatsapp-agent comme aujourd'hui.
- systemd réellement déployé (`/etc/systemd/system/whatsapp-agent.service`, vérifié en direct sur le VPS) a `ReadWritePaths=/opt/whatsapp-agent` (tout le home du user `wa-agent`), **différent** du fichier versionné dans le repo (`/opt/whatsapp-agent/app/whatsapp-agent.service`, plus restrictif avec `ReadWritePaths=/opt/whatsapp-agent/auth /opt/whatsapp-agent/logs` + hardening supplémentaire jamais appliqué). C'est une dérive de configuration pré-existante, hors scope de ce plan — la noter ici pour que personne ne suppose à tort que le service tournant est aussi durci que le fichier du repo le suggère.
- **Canal email écarté pour cette itération** : une tentative précédente de ce plan prévoyait un canal email via webhook Resend Inbound. Vérifié en direct : `ufw status` montre le port 443 restreint à la seule IP egress Railway (`80.246.130.58`), et `/etc/caddy/Caddyfile` ne contient qu'un vhost pour `asterisk.tzedakal.com` — aucun DNS/vhost n'expose ce VPS pour recevoir un webhook public. Exposer un webhook nécessiterait d'ouvrmir le firewall plus largement sur un VPS qui héberge aussi de la téléphonie (Asterisk), ce qui a été explicitement refusé. Le canal email est donc **hors scope** de ce plan ; à reconsidérer plus tard via une autre architecture (ex: relai par l'API Familink sur Railway, qui a déjà une IP autorisée par UFW) si le besoin redevient prioritaire.

---

## File Structure

```
/opt/whatsapp-agent/app/
├── index.js                    # MODIFIÉ — n'importe plus la logique métier inline,
│                                  délègue à core/dispatcher.js pour le canal WhatsApp
├── agent.js                    # MODIFIÉ — défaut GEMINI_MODEL passe à gemini-2.5-flash-lite
├── runner.js                   # INCHANGÉ (déjà générique, pas de dépendance WhatsApp)
├── security.js                 # INCHANGÉ
├── projects.js                 # INCHANGÉ
├── notify-server.js            # INCHANGÉ dans ce plan (pas de webhook email)
├── core/
│   └── dispatcher.js           # NOUVEAU — extrait handleMessage()/isConfirmation()/
│                                  isRefusal() de index.js, paramétré par un objet
│                                  "channel adapter" (send)
├── channels/
│   └── api.js                  # NOUVEAU — squelette route API token-auth pour future
│                                  app Android v2, testé, non branché en prod
├── test/
│   ├── dispatcher.test.js      # NOUVEAU — tests handleMessage (confirm/refuse/text) avec
│   │                              un Agent et un runner mockés (injection de dépendances)
│   └── api-channel.test.js     # NOUVEAU — tests handleApiDispatch
├── .env.example                # MODIFIÉ — documente GEMINI_MODEL avec le nouveau défaut
├── package.json                # MODIFIÉ — ajoute script "test"
└── README.md                   # MODIFIÉ — documente le changement de modèle + le squelette API v2
```

---

## Task 0: Basculer le dispatcher Gemini sur un modèle moins cher (Flash-Lite)

Le rôle de `agent.js` est de la classification + extraction structurée (comprendre une phrase courte, décider execute/clarify, sortir un JSON à un seul format fixe) — aucun raisonnement multi-étapes, le vrai travail est délégué à Claude Code Sonnet 5 via `runner.js`. `gemini-2.5-flash` (défaut actuel codé en dur) est sur-dimensionné pour ce rôle. `gemini-2.5-flash-lite` coûte ~$0.10/M input et ~$0.40/M output contre ~$0.30/M et ~$2.50/M pour Flash — un facteur 3 à 6x moins cher, avec une capacité largement suffisante pour cette tâche de routing.

**Files:**
- Modify: `/opt/whatsapp-agent/app/agent.js:59` (défaut du modèle), `agent.js` (export `tryParseAction`)
- Create: `/opt/whatsapp-agent/app/test/agent.test.js`
- Modify: `/opt/whatsapp-agent/app/.env.example`
- Modify: `/opt/whatsapp-agent/app/README.md`

- [ ] **Step 1: Changer le défaut dans `agent.js`**

Code actuel (vérifié sur le VPS, `agent.js` ligne ~57-61) :

```js
this.model = this.genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
});
```

Remplacer par :

```js
this.model = this.genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
});
```

- [ ] **Step 2: Test de non-régression du parsing JSON**

Avant de basculer le modèle par défaut, ajouter un test qui verrouille le contrat `tryParseAction`/`agent.chat()` : même si Flash-Lite reformule différemment, la sortie JSON attendue doit toujours être parsée correctement. Ce test ne teste pas Gemini lui-même (pas d'appel réseau réel dans la suite `node --test`), mais verrouille le comportement de parsing de `agent.js` pour détecter toute régression future de `tryParseAction` — utile indépendamment du modèle choisi.

**Files:**
- Create: `/opt/whatsapp-agent/app/test/agent.test.js`

```js
// test/agent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// tryParseAction n'est pas exporté par agent.js aujourd'hui (fonction privée).
// On l'exporte pour la rendre testable — voir modification agent.js ci-dessous.
import { tryParseAction } from '../agent.js';

test('tryParseAction: parse un JSON action propre', () => {
  const text = '{"action":"execute","project":"tzedakal","prompt":"fix le bug X","summary":"Fix bug X"}';
  const action = tryParseAction(text);
  assert.deepEqual(action, {
    action: 'execute',
    project: 'tzedakal',
    prompt: 'fix le bug X',
    summary: 'Fix bug X',
  });
});

test('tryParseAction: parse un JSON wrappé dans des backticks ```json', () => {
  const text = '```json\n{"action":"execute","project":"vps","prompt":"audit","summary":"Audit"}\n```';
  const action = tryParseAction(text);
  assert.equal(action.action, 'execute');
  assert.equal(action.project, 'vps');
});

test('tryParseAction: retourne null sur du texte libre (pas une action)', () => {
  const text = "Qu'est-ce que tu veux dire par \"fix le bug\" ? Peux-tu préciser lequel ?";
  assert.equal(tryParseAction(text), null);
});

test('tryParseAction: retourne null sur un JSON incomplet/tronqué (sortie modèle coupée)', () => {
  const text = '{"action":"execute","project":"tzedakal","prompt":"fix le b';
  assert.equal(tryParseAction(text), null);
});

test('tryParseAction: retourne null si action != "execute" ou champs requis manquants', () => {
  assert.equal(tryParseAction('{"action":"ask","question":"quoi ?"}'), null);
  assert.equal(tryParseAction('{"action":"execute","project":"x"}'), null); // prompt manquant
});
```

Ce test capture explicitement le cas signalé comme risque (Important, review DeepSeek) : un modèle plus économique qui tronque ou wrap différemment sa sortie JSON. Si `gemini-2.5-flash-lite` s'avère moins fiable que Flash sur ce contrat en usage réel, ce test ne le détectera pas automatiquement (aucun appel réseau ici) — mais il garantit que le code de parsing lui-même reste correct, et sert de base pour ajouter facilement un test d'intégration réel plus tard si le besoin s'en fait sentir.

Modifier `agent.js` pour exporter `tryParseAction` (actuellement déclarée `function tryParseAction(text) {`, non exportée) :

```js
// agent.js — changer la déclaration de la fonction privée en export nommé
export function tryParseAction(text) {
  // ... corps inchangé
}
```

Run: `cd /opt/whatsapp-agent/app && node --test test/agent.test.js`
Expected: PASS — 5 tests, 0 failures

- [ ] **Step 3: Documenter la variable dans `.env.example`**

Ajouter après la ligne `GEMINI_API_KEY=...` dans `.env.example` :

```bash
# (optionnel) Modèle Gemini utilisé par le dispatcher conversationnel.
# Défaut : gemini-2.5-flash-lite (le moins cher, largement suffisant : le rôle
# de ce modèle est de classifier/router, pas de raisonner — le vrai travail est
# fait par Claude Code Sonnet 5 via runner.js). Repasser à gemini-2.5-flash si
# le taux d'erreurs de parsing JSON augmente anormalement (voir logs/audit.log).
# GEMINI_MODEL=gemini-2.5-flash-lite
```

- [ ] **Step 4: Déployer sur le VPS et redémarrer**

```bash
ssh root@178.105.99.77 "sudo -u wa-agent sed -i \"s/gemini-2.5-flash'/gemini-2.5-flash-lite'/\" /opt/whatsapp-agent/app/agent.js && sudo -u wa-agent grep -n \"process.env.GEMINI_MODEL\" /opt/whatsapp-agent/app/agent.js"
```

Expected: la ligne affichée montre `gemini-2.5-flash-lite` comme fallback.

```bash
ssh root@178.105.99.77 "sudo systemctl restart whatsapp-agent && sleep 3 && sudo systemctl status whatsapp-agent --no-pager"
```

Expected: `active (running)`, pas de crash au boot.

- [ ] **Step 5: Vérification manuelle sur une semaine d'usage réel**

Pas un test automatisé — surveillance manuelle via `journalctl -u whatsapp-agent -f` et `cat /opt/whatsapp-agent/app/logs/audit.log | grep agent_error` après quelques jours d'usage WhatsApp normal. Si le taux d'événements `agent_error` (échec de parsing JSON, réponses Gemini mal formées) augmente sensiblement par rapport à l'historique, redéfinir `GEMINI_MODEL=gemini-2.5-flash` dans `/etc/whatsapp-agent.env` pour revenir en arrière — c'est une simple variable d'env, pas un rollback de code.

- [ ] **Step 6: Vérifications avant commit**

`whatsapp-agent` est du JS pur (ESM natif, pas de TypeScript, pas de script `build` dans `package.json`) — donc pas de typecheck/build à lancer ici. La vérification qui s'applique est la suite de tests complète :

Run: `cd /opt/whatsapp-agent/app && node --test`
Expected: PASS — tous les tests (agent, dispatcher — Task 1 pas encore fait à ce stade donc seul `agent.test.js` existe), 0 failures. Ne pas committer si un test échoue.

- [ ] **Step 7: Commit**

```bash
cd /opt/whatsapp-agent/app
git add agent.js .env.example test/agent.test.js
git commit -m "perf(agent): basculer le dispatcher Gemini sur flash-lite (3-6x moins cher)

Le rôle de ce modèle est de classifier/router une demande vers Claude Code,
pas de raisonner — flash-lite est largement suffisant pour ce contrat JSON
strict et coûte une fraction de flash. Rollback trivial via GEMINI_MODEL=
gemini-2.5-flash dans /etc/whatsapp-agent.env si le taux d'erreurs augmente."
```

---

## Task 1: Extraire le cœur dispatcher (canal-agnostique)

Aujourd'hui toute la logique de confirmation/refus/dispatch vit dans `handleMessage()` de `index.js`, couplée à `sock`/`jid` Baileys. On l'extrait dans `core/dispatcher.js` pour qu'elle soit réutilisable par de futurs canaux (ex: l'API Android de Task 2) sans dupliquer ~90 lignes de logique métier (confirmation, sécurité, rate limit, exécution Claude Code). Ce refactor ne change aucun comportement observable côté WhatsApp — c'est une extraction pure.

**Files:**
- Create: `/opt/whatsapp-agent/app/core/dispatcher.js`
- Create: `/opt/whatsapp-agent/app/test/dispatcher.test.js`
- Modify: `/opt/whatsapp-agent/app/index.js:132-224` (la fonction `handleMessage`), `index.js:262-268` (`isConfirmation`/`isRefusal`)

- [ ] **Step 1: Write the failing test**

```js
// test/dispatcher.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../core/dispatcher.js';

function makeAgent(overrides = {}) {
  return {
    pendingExecution: null,
    chat: mock.fn(async () => ({ type: 'text', text: 'réponse par défaut' })),
    consumePendingExecution: mock.fn(function () {
      const exec = this.pendingExecution;
      this.pendingExecution = null;
      return exec;
    }),
    resetHistory: mock.fn(),
    ...overrides,
  };
}

function makeChannel() {
  const sent = [];
  return {
    name: 'test-channel',
    sent,
    send: mock.fn(async (id, text) => { sent.push({ id, text }); }),
  };
}

test('handleMessage: exécute Claude Code sur confirmation avec chemin+prompt valides', async () => {
  const agent = makeAgent();
  agent.pendingExecution = {
    project: 'tzedakal',
    projectPath: '/workspaces/tzedakal',
    prompt: 'fix le bug X',
    summary: 'Fix bug X',
  };
  const channel = makeChannel();
  const runClaude = mock.fn(async (prompt, path, onUpdate) => {
    onUpdate('⏳ update intermédiaire');
    return '✅ Terminé\n\nfix appliqué';
  });

  const dispatcher = createDispatcher({
    agent,
    runClaude,
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/tzedakal' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  assert.equal(channel.sent.length, 3); // lancement + update + résultat
  assert.match(channel.sent[0].text, /Lancement/);
  assert.match(channel.sent[1].text, /update intermédiaire/);
  assert.match(channel.sent[2].text, /fix appliqué/);
  assert.equal(runClaude.mock.callCount(), 1);
});

test('handleMessage: bloque si chemin projet invalide', async () => {
  const agent = makeAgent();
  agent.pendingExecution = {
    project: 'evil',
    projectPath: '/etc/passwd',
    prompt: 'lis ce fichier',
    summary: 'x',
  };
  const channel = makeChannel();
  const runClaude = mock.fn(async () => '✅ ne doit jamais être appelé');

  const dispatcher = createDispatcher({
    agent,
    runClaude,
    validateProjectPath: () => ({ valid: false, reason: 'Chemin système interdit' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  assert.equal(runClaude.mock.callCount(), 0);
  assert.match(channel.sent[0].text, /Chemin refusé/);
});

test('handleMessage: refus annule l\'exécution en attente', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'x', projectPath: '/workspaces/x', prompt: 'p', summary: 's' };
  const channel = makeChannel();
  const runClaude = mock.fn(async () => '✅');

  const dispatcher = createDispatcher({
    agent, runClaude,
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/x' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'non');

  assert.equal(runClaude.mock.callCount(), 0);
  assert.equal(agent.pendingExecution, null);
  assert.match(channel.sent[0].text, /Annulé/);
});

test('handleMessage: message texte normal renvoie une confirmation à afficher', async () => {
  const agent = makeAgent({
    chat: mock.fn(async () => ({
      type: 'confirm',
      summary: 'Ajouter la pagination',
      project: 'tzedakal',
      projectPath: '/workspaces/tzedakal',
      prompt: 'ajoute la pagination',
    })),
  });
  const channel = makeChannel();

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => '✅'),
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/tzedakal' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ajoute la pagination stp');

  assert.equal(channel.sent.length, 1);
  assert.match(channel.sent[0].text, /Ajouter la pagination/);
  assert.match(channel.sent[0].text, /tzedakal/);
});

test('handleMessage: refuse une double exécution concurrente sur le même projet', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'tzedakal', projectPath: '/workspaces/tzedakal', prompt: 'p', summary: 's' };
  const channel = makeChannel();
  const activeSessions = new Set(['tzedakal']);

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => '✅'),
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/tzedakal' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions,
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  assert.match(channel.sent[0].text, /déjà active/);
});

test('handleMessage: erreur Gemini 429 renvoie un message clair sans planter', async () => {
  const agent = makeAgent({
    chat: mock.fn(async () => { throw new Error('429 Too Many Requests'); }),
  });
  const channel = makeChannel();

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => '✅'),
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/x' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'fais un truc');

  assert.match(channel.sent[0].text, /Quota Gemini atteint/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/whatsapp-agent/app && node --test test/dispatcher.test.js`
Expected: FAIL — `Cannot find module '../core/dispatcher.js'`

- [ ] **Step 3: Write minimal implementation**

Extrait fidèle de `index.js` (fonction `handleMessage`, lignes ~132-224, et `isConfirmation`/`isRefusal`, lignes ~262-268), généralisé pour ne plus dépendre de `sock`/Baileys mais d'un `channel` avec une méthode `send(id, text)`. Chaque branche (confirmation, refus, erreur Gemini 503/429/403/401, reset, confirm, text, path invalide, prompt dangereux, rate limit, concurrence) est reprise avec les mêmes messages exacts que le code actuel — aucune reformulation, pour garantir la non-régression du texte affiché à l'utilisateur.

```js
// core/dispatcher.js

/**
 * Cœur métier canal-agnostique : gère confirmation/refus/dispatch d'une
 * exécution Claude Code, indépendamment du canal de messagerie (WhatsApp,
 * futur Android). Toute la sécurité (path, dangerous prompt, rate limit,
 * concurrence) reste appliquée ici pour ne pas la dupliquer par canal.
 *
 * @param {object} deps
 * @param {{pendingExecution: object|null, chat: Function, consumePendingExecution: Function, resetHistory: Function}} deps.agent
 * @param {(prompt: string, path: string, onUpdate: (msg: string) => void) => Promise<string>} deps.runClaude
 * @param {(path: string) => {valid: boolean, reason?: string, realPath?: string}} deps.validateProjectPath
 * @param {(prompt: string) => string|null} deps.detectDangerousPrompt
 * @param {{checkExecution: () => {allowed: boolean, reason?: string}}} deps.rateLimiter
 * @param {Set<string>} deps.activeSessions - clé = nom de projet, partagé entre canaux
 *   pour empêcher deux canaux différents de lancer Claude Code sur le même projet en même temps.
 * @param {(event: string, details?: object) => void} deps.audit
 */
export function createDispatcher({ agent, runClaude, validateProjectPath, detectDangerousPrompt, rateLimiter, activeSessions, audit }) {
  async function handleMessage(channel, senderId, text) {
    audit('message_received', { length: text.length, channel: channel.name });

    if (agent.pendingExecution && isConfirmation(text)) {
      await executeConfirmed(channel, senderId);
      return;
    }

    if (agent.pendingExecution && isRefusal(text)) {
      audit('exec_refused', { channel: channel.name });
      agent.consumePendingExecution();
      await channel.send(senderId, '↩️ Annulé. Dis-moi ce que tu veux changer.');
      return;
    }

    let response;
    try {
      response = await agent.chat(text);
    } catch (err) {
      audit('agent_error', { error: err.message, channel: channel.name });
      const msg = err?.message || String(err);
      let userMsg;
      if (/\b503\b/.test(msg)) userMsg = '⚠️ Gemini saturé (503). Réessaie dans 30s.';
      else if (/\b429\b/.test(msg)) userMsg = '⚠️ Quota Gemini atteint. Réessaie dans 1min.';
      else if (/\b403\b/.test(msg)) userMsg = '⚠️ Accès Gemini refusé. Vérifie la clé API.';
      else if (/\b401\b/.test(msg)) userMsg = '⚠️ Clé Gemini invalide.';
      else userMsg = `⚠️ Erreur Gemini : ${msg.slice(0, 200)}`;
      await channel.send(senderId, userMsg);
      return;
    }

    if (response.type === 'reset') {
      agent.resetHistory();
      audit('history_reset', { channel: channel.name });
      await channel.send(senderId, '🔄 Conversation réinitialisée.');
      return;
    }

    if (response.type === 'confirm') {
      audit('exec_pending', { project: response.project, channel: channel.name });
      const confirmMsg =
        `📋 *Voici ce que je vais faire :*\n\n${response.summary}\n\n` +
        `📁 Projet : *${response.project}*\n` +
        `📂 Chemin : ${response.projectPath}\n\n` +
        `Confirme avec *oui* / *ok* / *go*, ou dis-moi ce que tu veux changer.`;
      await channel.send(senderId, confirmMsg);
      return;
    }

    await channel.send(senderId, response.text);
  }

  async function executeConfirmed(channel, senderId) {
    const exec = agent.consumePendingExecution();

    const pathCheck = validateProjectPath(exec.projectPath);
    if (!pathCheck.valid) {
      audit('exec_blocked_path', { project: exec.project, reason: pathCheck.reason, channel: channel.name });
      await channel.send(senderId, `🚫 *Chemin refusé* : ${pathCheck.reason}\nProjet : ${exec.project}`);
      return;
    }

    const danger = detectDangerousPrompt(exec.prompt);
    if (danger) {
      audit('exec_blocked_dangerous', { project: exec.project, reason: danger, channel: channel.name });
      await channel.send(
        senderId,
        `🚫 *Action bloquée* : pattern dangereux détecté (${danger}).\nReformule sans cette opération.`
      );
      return;
    }

    const rateExec = rateLimiter.checkExecution();
    if (!rateExec.allowed) {
      audit('rate_limit_exec', { reason: rateExec.reason, channel: channel.name });
      await channel.send(senderId, `⛔ ${rateExec.reason}`);
      return;
    }

    if (activeSessions.has(exec.project)) {
      audit('exec_blocked_concurrent', { project: exec.project, channel: channel.name });
      await channel.send(senderId, `⏳ Une session est déjà active sur *${exec.project}*. Attends qu'elle finisse.`);
      return;
    }

    audit('exec_start', { project: exec.project, path: pathCheck.realPath, channel: channel.name });
    await channel.send(senderId, `🚀 Lancement sur *${exec.project}*...\nJe t'envoie un update toutes les minutes.`);

    activeSessions.add(exec.project);
    const startTime = Date.now();
    try {
      const result = await runClaude(exec.prompt, pathCheck.realPath, (update) => channel.send(senderId, update));
      const durationMs = Date.now() - startTime;
      audit('exec_end', { project: exec.project, durationMs, ok: true, channel: channel.name });
      await channel.send(senderId, result);
    } catch (err) {
      audit('exec_error', { project: exec.project, error: err.message, channel: channel.name });
      await channel.send(senderId, `❌ Erreur : ${err.message}`);
    } finally {
      activeSessions.delete(exec.project);
    }
  }

  return { handleMessage };
}

export function isConfirmation(text) {
  return /^(oui|ok|go|yes|yep|✅|כן|ouais|validé|confirme?|lance|c'est bon|c est bon)$/i.test(text.trim());
}

export function isRefusal(text) {
  return /^(non|no|nop|nope|annule?|cancel|stop|❌|attends?)$/i.test(text.trim());
}
```

Remarque : dans les tests ci-dessus, `channel.send` reçoit déjà le texte tel qu'envoyé par le dispatcher — `redactSecrets` reste appliqué **dans l'adaptateur de canal** (comme aujourd'hui dans `send()` de `index.js`), pas dans le dispatcher, qui ne connaît pas `redactSecrets`. C'est une responsabilité de canal (defense in depth déjà en place côté WhatsApp, conservée par construction dans le Step 5 ci-dessous).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/whatsapp-agent/app && node --test test/dispatcher.test.js`
Expected: PASS — 6 tests, 0 failures

- [ ] **Step 5: Rebrancher `index.js` sur le dispatcher extrait**

Remplacer la fonction `handleMessage` locale de `index.js` par un appel à `createDispatcher`. Le `send(sock, jid, text)` existant (ligne ~236 de `index.js`, qui applique déjà `redactSecrets(text)` avant `sock.sendMessage`) est conservé tel quel — c'est lui qui devient l'implémentation de `channel.send`, donc la redaction des secrets reste garantie sans rien dupliquer :

```js
// index.js — ajouts, après la création de `agent` et avant startBot()
import { createDispatcher } from './core/dispatcher.js';

const dispatcher = createDispatcher({
  agent,
  runClaude,
  validateProjectPath,
  detectDangerousPrompt,
  rateLimiter,
  activeSessions,
  audit,
});

// send(sock, jid, text) existe déjà plus bas dans index.js (applique redactSecrets).
// currentSock est déjà une variable module-level maintenue à jour par connection.update.
const whatsappChannel = {
  name: 'whatsapp',
  send: (jid, text) => send(currentSock, jid, text),
};
```

Dans `sock.ev.on('messages.upsert', ...)`, remplacer l'appel `await handleMessage(sock, senderJid, text.trim())` par `await dispatcher.handleMessage(whatsappChannel, senderJid, text.trim())`. Supprimer ensuite l'ancienne fonction `handleMessage` locale de `index.js` (désormais dans `core/dispatcher.js`) ainsi que les fonctions locales `isConfirmation`/`isRefusal` (désormais importées si besoin ailleurs, sinon simplement supprimées car uniquement utilisées en interne par le dispatcher).

`activeSessions` reste le `Set` module-level déjà existant dans `index.js` (déclaré `let activeSessions = new Set();` en haut du fichier) — inchangé, juste passé en dépendance au lieu d'être fermé implicitement par la fonction locale.

- [ ] **Step 6: Vérifier manuellement que WhatsApp fonctionne toujours**

Run: `ssh root@178.105.99.77 "sudo systemctl restart whatsapp-agent && sleep 3 && sudo systemctl status whatsapp-agent --no-pager"`
Expected: `active (running)`, pas de crash au boot.

Envoyer `/help` depuis WhatsApp doit répondre avec la même liste de commandes qu'avant (comportement inchangé du point de vue utilisateur). Envoyer une vraie demande de tâche, confirmer avec "ok", vérifier que l'exécution se lance et que les messages reçus sont identiques à avant (mêmes emojis, même formulation).

- [ ] **Step 7: Vérifications avant commit**

Pas de TypeScript/build dans ce repo (JS pur, `package.json` sans script `build`) — seule la suite de tests s'applique :

Run: `cd /opt/whatsapp-agent/app && node --test`
Expected: PASS — tous les tests (`agent.test.js` de Task 0 + `dispatcher.test.js`), 0 failures. Ne pas committer si un test échoue ou si la vérification manuelle du Step 6 a révélé une régression.

- [ ] **Step 8: Commit**

```bash
cd /opt/whatsapp-agent/app
git add core/dispatcher.js test/dispatcher.test.js index.js
git commit -m "refactor: extraire le dispatcher métier en module canal-agnostique

Prépare de futures extensions (API Android v2) en factorisant
handleMessage()/isConfirmation()/isRefusal() hors de index.js (couplé à
Baileys) vers core/dispatcher.js, injecté par dépendances et testable sans
WhatsApp ni Claude Code réel. Comportement WhatsApp observable inchangé."
```

---

## Task 2: Squelette API HTTP interne pour future app Android (v2 — non branché)

Ne PAS construire l'app Android maintenant. On prépare uniquement une route HTTP token-authentifiée réutilisant le dispatcher extrait en Task 1, pour qu'un futur client (app Android ou autre) puisse déclencher une tâche sans passer par WhatsApp. Cette tâche est volontairement minimale (une seule route, pas de gestion de session avancée, pas de branchement en prod) — YAGNI au-delà de ce socle.

**Files:**
- Create: `/opt/whatsapp-agent/app/channels/api.js`
- Create: `/opt/whatsapp-agent/app/test/api-channel.test.js`
- Modify: `/opt/whatsapp-agent/app/README.md`

- [ ] **Step 1: Write the failing test**

```js
// test/api-channel.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiDispatch } from '../channels/api.js';

test('handleApiDispatch: rejette sans token valide', async () => {
  const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } };
  await handleApiDispatch(
    { headers: { authorization: 'Bearer wrong' } },
    res,
    '{"message":"fais un audit"}',
    { apiToken: 'correct-token', dispatcher: { handleMessage: mock.fn() }, channel: { name: 'api', send: mock.fn() } }
  );
  assert.equal(res.statusCode, 401);
});

test('handleApiDispatch: accepte avec token valide et dispatch le message', async () => {
  const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } };
  const handleMessage = mock.fn(async () => {});
  await handleApiDispatch(
    { headers: { authorization: 'Bearer correct-token' } },
    res,
    '{"message":"fais un audit","senderId":"android-client"}',
    { apiToken: 'correct-token', dispatcher: { handleMessage }, channel: { name: 'api', send: mock.fn() } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(handleMessage.mock.callCount(), 1);
  assert.equal(handleMessage.mock.calls[0].arguments[1], 'android-client');
  assert.equal(handleMessage.mock.calls[0].arguments[2], 'fais un audit');
});

test('handleApiDispatch: rejette un payload JSON invalide', async () => {
  const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } };
  await handleApiDispatch(
    { headers: { authorization: 'Bearer correct-token' } },
    res,
    'not json',
    { apiToken: 'correct-token', dispatcher: { handleMessage: mock.fn() }, channel: { name: 'api', send: mock.fn() } }
  );
  assert.equal(res.statusCode, 400);
});

test('handleApiDispatch: rejette si message ou senderId manquant', async () => {
  const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; return this; }, end(b) { this.body = b; } };
  await handleApiDispatch(
    { headers: { authorization: 'Bearer correct-token' } },
    res,
    '{"message":"fais un audit"}',
    { apiToken: 'correct-token', dispatcher: { handleMessage: mock.fn() }, channel: { name: 'api', send: mock.fn() } }
  );
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/whatsapp-agent/app && node --test test/api-channel.test.js`
Expected: FAIL — `Cannot find module '../channels/api.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// channels/api.js

/**
 * Route API interne pour un futur client (app Android v2). Auth par token
 * statique simple (Bearer), symétrique au NOTIFY_TOKEN déjà utilisé pour
 * /notify dans notify-server.js. Non branché en production par ce plan —
 * squelette prêt à l'emploi pour quand un client existera réellement.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} rawBody - JSON: { message: string, senderId: string }
 * @param {{apiToken: string, dispatcher: {handleMessage: Function}, channel: {name: string, send: Function}}} opts
 */
export async function handleApiDispatch(req, res, rawBody, { apiToken, dispatcher, channel }) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${apiToken}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }

  const { message, senderId } = payload;
  if (!message || !senderId) {
    res.writeHead(400).end('message et senderId requis');
    return;
  }

  await dispatcher.handleMessage(channel, senderId, message);
  res.writeHead(200).end('ok');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/whatsapp-agent/app && node --test test/api-channel.test.js`
Expected: PASS — 4 tests, 0 failures

- [ ] **Step 5: Ne PAS brancher cette route en production**

Ce module `channels/api.js` est créé et testé mais **jamais importé** dans `index.js`/`notify-server.js` — pas de route active, pas de nouveau port ouvert, aucun changement du comportement en production. Documenter ce choix dans le README :

```markdown
## v2 — App Android (prévu, non actif)

Un squelette d'API HTTP token-authentifiée (`channels/api.js`) existe pour
préparer une future app Android minimale, mais n'est pas branché en
production — pas de client à servir aujourd'hui. Pour l'activer un jour :
ajouter une route dans `notify-server.js` qui appelle `handleApiDispatch`
avec un token dédié (`API_TOKEN` dans `.env`, jamais réutiliser NOTIFY_TOKEN),
brancher `dispatcher` (celui déjà créé dans `index.js` pour WhatsApp, ou un
dispatcher dédié avec son propre Agent si on veut un historique de
conversation séparé) et un `channel` dont `send()` répond effectivement au
client (websocket, long-polling, ou push notification — à définir selon le
transport choisi pour l'app).
```

- [ ] **Step 6: Vérifications avant commit**

Run: `cd /opt/whatsapp-agent/app && node --test`
Expected: PASS — tous les tests (`agent.test.js`, `dispatcher.test.js`, `api-channel.test.js`), 0 failures. Toujours pas de TypeScript/build dans ce repo — la suite de tests complète est la seule vérification requise. Ne pas committer si un test échoue.

- [ ] **Step 7: Commit**

```bash
cd /opt/whatsapp-agent/app
git add channels/api.js test/api-channel.test.js README.md
git commit -m "feat(api): squelette route API token-auth pour future app Android (v2, non branché)

Prépare le terrain sans construire l'app ni l'activer — dispatcher déjà
réutilisable tel quel depuis Task 1, seule la route HTTP est ajoutée et
testée. Aucun nouveau port/route actif en production."
```

---

## Task 3: Ajouter le script de test à `package.json` et pousser

**Files:**
- Modify: `/opt/whatsapp-agent/app/package.json`

- [ ] **Step 1: Ajouter le script `test`**

Dans `package.json`, section `scripts` (actuellement `{ "start": "node index.js", "audit": "npm audit --omit=dev" }`) :

```json
{
  "scripts": {
    "start": "node index.js",
    "test": "node --test",
    "audit": "npm audit --omit=dev"
  }
}
```

- [ ] **Step 2: Vérifier**

Run: `cd /opt/whatsapp-agent/app && npm test`
Expected: PASS — tous les tests (dispatcher + api-channel), 0 failures

- [ ] **Step 3: Commit et push**

```bash
cd /opt/whatsapp-agent/app
git status
# Vérifier qu'aucun fichier hors scope (package-lock.json, auth.corrupt.*) n'est stagé
git add package.json
git commit -m "chore: ajouter le script npm test (node --test)"
git push origin main
```

---

## Self-Review Notes

- **Couverture** : bascule modèle moins cher ✅ (Task 0), cœur dispatcher canal-agnostique extrait sans régression WhatsApp ✅ (Task 1, tous les messages/branches repris à l'identique), squelette Android v2 préparé sans le construire ni le brancher ✅ (Task 2), familink-agent inchangé ✅ (aucune tâche ne le touche), canal email explicitement écarté avec la raison documentée ✅ (contexte VPS).
- **Cohérence des types** : `channel` = `{ name: string, send(senderId: string, text: string): Promise<void> }` — identique dans `dispatcher.test.js`, `api-channel.test.js` et l'usage réel dans `index.js` (Task 1 Step 5).
- **Rollback simple à chaque étape** : Task 0 = variable d'env réversible instantanément ; Task 1 = extraction pure, testée avant rebranchement, avec vérification manuelle WhatsApp explicite avant de committer ; Task 2 = code mort tant que non branché, aucun risque de régression.
- **Hygiène git** : chaque commit liste explicitement ses fichiers, jamais `git add -A`/`.`, rappel explicite en Task 3 de vérifier `git status` avant le commit final pour ne pas embarquer `package-lock.json`/`auth.corrupt.*` déjà présents dans le working tree pour d'autres raisons.
- **Revue DeepSeek (2026-07-01)** : plan soumis à une review indépendante DeepSeek. Verdict FAIL initial avec 2 issues Critical — vérifiées contre le code réel et écartées : (1) la redaction des secrets a été jugée "fragile pour de futurs canaux", mais `redactSecrets` est en réalité appliqué **à l'intérieur** de `send()` dans `index.js:252`, systématiquement, indépendamment de l'appelant — le plan branche `channel.send` directement dessus, donc la garantie tient ; (2) `consumePendingExecution()` appelé avant validation du path a été jugé comme une régression introduite par le plan, mais c'est le comportement **déjà en production** (`index.js:140-141` actuel) que Task 1 reproduit fidèlement par design (extraction sans changement de comportement) — corriger ce point serait un changement de scope produit, pas une correction de régression.
- **Amélioration retenue de la review DeepSeek** : ajout d'un test de non-régression du parsing JSON (`test/agent.test.js`, Task 0 Step 2) pour verrouiller le contrat `tryParseAction` indépendamment du modèle Gemini utilisé.
- **Amélioration notée mais explicitement hors scope** : `activeSessions` (Set sans TTL) pourrait bloquer un projet indéfiniment si `runClaude()` résout sans que le process ait réellement terminé (crash non catché). Ce risque existe déjà identiquement dans le code de production actuel (le `Set` module-level d'`index.js` a le même comportement) — ce plan ne fait qu'extraire ce mécanisme tel quel, il ne l'introduit pas. À traiter dans un plan séparé si cette robustesse devient prioritaire (ex: `Map<project, timestamp>` avec TTL + commande `/unlock <project>`).
