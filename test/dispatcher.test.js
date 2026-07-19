import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, isConfirmation, isRefusal } from '../core/dispatcher.js';

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
    return { status: 'ok', text: '✅ Terminé\n\nfix appliqué' };
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
  const runClaude = mock.fn(async () => ({ status: 'ok', text: '✅ ne doit jamais être appelé' }));

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
  const runClaude = mock.fn(async () => ({ status: 'ok', text: '✅' }));

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
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅' })),
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
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅' })),
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
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅' })),
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/x' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'fais un truc');

  assert.match(channel.sent[0].text, /Quota Gemini atteint/);
});

test('executeConfirmed: alerte email envoyée si runClaude échoue (status error)', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'audit', summary: 's' };
  const channel = makeChannel();
  const alertEmail = mock.fn(async () => {});

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => ({ status: 'error', text: '❌ Erreur process Claude Code : spawn ENOENT' })),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
    alertEmail,
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  // Le message d'erreur part quand même sur le canal + une alerte email.
  assert.match(channel.sent.at(-1).text, /Erreur process Claude Code/);
  assert.equal(alertEmail.mock.callCount(), 1);
  assert.match(alertEmail.mock.calls[0].arguments[0], /vps/);
});

test('executeConfirmed: alerte email envoyée si runClaude est tué (status killed)', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'audit', summary: 's' };
  const channel = makeChannel();
  const alertEmail = mock.fn(async () => {});

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => ({ status: 'killed', text: '⛔ Tué (limite atteinte)' })),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
    alertEmail,
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  assert.equal(alertEmail.mock.callCount(), 1);
});

test('executeConfirmed: PAS d\'alerte email sur succès (status ok)', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'audit', summary: 's' };
  const channel = makeChannel();
  const alertEmail = mock.fn(async () => {});

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅ Terminé\n\nfait' })),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
    alertEmail,
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  assert.equal(alertEmail.mock.callCount(), 0);
});

test('getTranscript: journalise prompt + lancement + résultat par projet', async () => {
  const agent = makeAgent();
  agent.pendingExecution = { project: 'familink', projectPath: '/workspaces/familink', prompt: 'ajoute un bouton', summary: 's' };
  const channel = makeChannel();

  const dispatcher = createDispatcher({
    agent,
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅ Terminé\n\nbouton ajouté' })),
    validateProjectPath: () => ({ valid: true, realPath: '/workspaces/familink' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user-1', 'ok');

  const t = dispatcher.getTranscript('familink');
  assert.equal(t.length, 3); // user prompt + lancement + résultat
  assert.equal(t[0].role, 'user');
  assert.match(t[0].text, /ajoute un bouton/);
  assert.match(t[1].text, /Lancement/);
  assert.match(t[2].text, /bouton ajouté/);
  // Un projet non touché a un transcript vide.
  assert.deepEqual(dispatcher.getTranscript('tzedakal'), []);
});

test('getExecutionState: reflète active via activeSessions', () => {
  const activeSessions = new Set(['vps']);
  const dispatcher = createDispatcher({
    agent: makeAgent(),
    runClaude: mock.fn(async () => ({ status: 'ok', text: '✅' })),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions,
    audit: () => {},
  });

  assert.deepEqual(dispatcher.getExecutionState('vps'), { project: 'vps', active: true, lastUpdate: null });
  assert.deepEqual(dispatcher.getExecutionState('familink'), { project: 'familink', active: false, lastUpdate: null });
});

test('autoConfirm: canal API exécute directement sans étape de confirmation', async () => {
  // agent.chat renvoie type:confirm ; sur un canal autoConfirm, on doit
  // enchaîner directement sur l'exécution (pas de message "confirme avec ok").
  const agent = makeAgent({
    chat: mock.fn(async () => ({
      type: 'confirm',
      summary: 'Audit rapide',
      project: 'vps',
      projectPath: '/opt/projects/vps',
      prompt: 'fais un audit',
    })),
  });
  // Le dispatcher lit pendingExecution sur l'agent : chat() le pose normalement.
  agent.chat = mock.fn(async () => {
    agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'fais un audit', summary: 'Audit rapide' };
    return { type: 'confirm', summary: 'Audit rapide', project: 'vps', projectPath: '/opt/projects/vps', prompt: 'fais un audit' };
  });
  const channel = { name: 'api', autoConfirm: true, sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const runClaude = mock.fn(async () => ({ status: 'ok', text: '✅ Terminé\n\naudit ok' }));

  const dispatcher = createDispatcher({
    agent, runClaude,
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'android', 'fais un audit du vps');

  // Pas de message "confirme avec ok" ; runClaude appelé directement.
  assert.equal(runClaude.mock.callCount(), 1);
  assert.ok(!channel.sent.some((m) => /confirme avec/i.test(m.text)), 'ne doit pas demander de confirmation');
  assert.ok(channel.sent.some((m) => /audit ok/.test(m.text)), 'le résultat doit être envoyé');
});

test('WhatsApp (sans autoConfirm): garde l\'étape de confirmation', async () => {
  const agent = makeAgent();
  agent.chat = mock.fn(async () => {
    agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'p', summary: 's' };
    return { type: 'confirm', summary: 's', project: 'vps', projectPath: '/opt/projects/vps', prompt: 'p' };
  });
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const runClaude = mock.fn(async () => ({ status: 'ok', text: '✅' }));

  const dispatcher = createDispatcher({
    agent, runClaude,
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user', 'fais un audit');

  // WhatsApp : demande confirmation, n'exécute PAS encore.
  assert.equal(runClaude.mock.callCount(), 0);
  assert.ok(channel.sent.some((m) => /confirme avec/i.test(m.text)), 'doit demander confirmation');
});

// ─── isConfirmation / isRefusal ─────────────────────────────────────────────

test('isConfirmation: mots simples exacts', () => {
  for (const t of ['oui', 'ok', 'go', 'yes', 'yalla', 'בסדר', 'ouais']) {
    assert.equal(isConfirmation(t), true, `${t} devrait confirmer`);
  }
});

test('isConfirmation: tolère un message enrichi (mot-clé + suite)', () => {
  assert.equal(isConfirmation('ok vas-y'), true);
  assert.equal(isConfirmation('oui parfait'), true);
  assert.equal(isConfirmation('oui, lance ça'), true);
});

test('isConfirmation: emojis reconnus', () => {
  assert.equal(isConfirmation('✅'), true);
  assert.equal(isConfirmation('👍'), true);
  assert.equal(isConfirmation('👍 vas-y'), true);
});

test('isConfirmation: ne matche pas un message qui contient le mot ailleurs qu\'au début', () => {
  assert.equal(isConfirmation('fais un audit du serveur'), false);
  assert.equal(isConfirmation('pas ok pour moi'), false);
});

test('isRefusal: mots simples exacts', () => {
  for (const t of ['non', 'no', 'stop', 'annule', 'nan']) {
    assert.equal(isRefusal(t), true, `${t} devrait refuser`);
  }
});

test('isRefusal: tolère un message enrichi', () => {
  assert.equal(isRefusal('non merci'), true);
  assert.equal(isRefusal('attends une seconde'), true);
});

test('isRefusal: emojis reconnus', () => {
  assert.equal(isRefusal('❌'), true);
  assert.equal(isRefusal('👎'), true);
});

test('isConfirmation et isRefusal: un message neutre ne matche ni l\'un ni l\'autre', () => {
  const neutral = 'fais un audit du vps stp';
  assert.equal(isConfirmation(neutral), false);
  assert.equal(isRefusal(neutral), false);
});

// ─── /status et /cancel ──────────────────────────────────────────────────────

test('/status sans argument liste tous les projets avec leur état', async () => {
  const agent = makeAgent();
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const activeSessions = new Set(['vps']);

  const dispatcher = createDispatcher({
    agent, runClaude: mock.fn(),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions,
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user', '/status');

  assert.equal(agent.chat.mock.callCount(), 0, 'ne doit pas appeler Gemini');
  const msg = channel.sent[0].text;
  assert.match(msg, /vps.*en cours/s);
});

test('/status <projet> donne le détail d\'un projet précis', async () => {
  const agent = makeAgent();
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };

  const dispatcher = createDispatcher({
    agent, runClaude: mock.fn(),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user', '/status vps');

  assert.match(channel.sent[0].text, /aucune exécution en cours/);
});

test('/status <projet inconnu> renvoie une erreur claire', async () => {
  const agent = makeAgent();
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };

  const dispatcher = createDispatcher({
    agent, runClaude: mock.fn(),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
  });

  await dispatcher.handleMessage(channel, 'user', '/status projet-qui-n-existe-pas');

  assert.match(channel.sent[0].text, /introuvable/);
});

test('/cancel sans exécution active répond clairement, sans appeler cancelRunningClaude', async () => {
  const agent = makeAgent();
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const cancelRunningClaude = mock.fn(() => true);

  const dispatcher = createDispatcher({
    agent, runClaude: mock.fn(),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions: new Set(),
    audit: () => {},
    cancelRunningClaude,
  });

  await dispatcher.handleMessage(channel, 'user', '/cancel');

  assert.equal(cancelRunningClaude.mock.callCount(), 0);
  assert.match(channel.sent[0].text, /Aucune exécution en cours/);
});

test('/cancel <projet> avec exécution active appelle cancelRunningClaude sur le bon realPath', async () => {
  const agent = makeAgent();
  agent.chat = mock.fn(async () => {
    agent.pendingExecution = { project: 'vps', projectPath: '/opt/projects/vps', prompt: 'longue tache', summary: 's' };
    return { type: 'confirm', summary: 's', project: 'vps', projectPath: '/opt/projects/vps', prompt: 'longue tache' };
  });
  // autoConfirm: true — sinon handleMessage n'affiche que le message de
  // confirmation et n'appelle jamais executeConfirmed (qui pose
  // activeSessions/activeRealPaths), il faudrait un second message "oui".
  const channel = { name: 'api', autoConfirm: true, sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const cancelRunningClaude = mock.fn(() => true);
  const activeSessions = new Set();

  // runClaude qui ne se résout jamais dans ce test (simule une exécution
  // longue) — on n'attend pas cette promesse, juste executeConfirmed qui
  // pose activeSessions/activeRealPaths avant d'attendre le résultat.
  const runClaude = mock.fn(() => new Promise(() => {}));

  const dispatcher = createDispatcher({
    agent, runClaude,
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions,
    audit: () => {},
    cancelRunningClaude,
  });

  // Lance l'exécution SANS attendre (elle ne se termine jamais dans ce test,
  // runClaude() ne résout jamais). handleMessage() await agent.chat() (résolu
  // immédiatement) puis, avec autoConfirm, appelle executeConfirmed() qui pose
  // activeSessions/activeRealPaths de façon synchrone AVANT d'awaiter
  // runClaude() — donc dès que le premier microtask (agent.chat) est vidé,
  // l'état est déjà posé.
  dispatcher.handleMessage(channel, 'user', 'fais un audit du vps');
  await new Promise((r) => setImmediate(r));

  assert.equal(activeSessions.has('vps'), true, 'activeSessions doit être posé avant le /cancel');

  await dispatcher.handleMessage(channel, 'user', '/cancel vps');

  assert.equal(cancelRunningClaude.mock.callCount(), 1);
  assert.equal(cancelRunningClaude.mock.calls[0].arguments[0], '/opt/projects/vps');
  assert.match(channel.sent.at(-1).text, /Annulation demandée/);
});

test('/cancel sans cancelRunningClaude injecté répond non disponible plutôt que de planter', async () => {
  const agent = makeAgent();
  const channel = { name: 'whatsapp', sent: [], send: mock.fn(async function (id, t) { this.sent.push({ id, text: t }); }) };
  const activeSessions = new Set(['vps']);

  const dispatcher = createDispatcher({
    agent, runClaude: mock.fn(),
    validateProjectPath: () => ({ valid: true, realPath: '/opt/projects/vps' }),
    detectDangerousPrompt: () => null,
    rateLimiter: { checkExecution: () => ({ allowed: true }) },
    activeSessions,
    audit: () => {},
    // cancelRunningClaude non injecté volontairement.
  });

  await dispatcher.handleMessage(channel, 'user', '/cancel vps');

  assert.match(channel.sent[0].text, /non disponible/);
});
