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
