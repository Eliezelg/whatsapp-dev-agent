import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../channels/api.js';

// Mock d'un ServerResponse minimal : capture status, headers et body.
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || null; return this; },
    end(b) { this.body = b; },
  };
}

function makeDeps(overrides = {}) {
  return {
    apiToken: 'tok',
    dispatcher: {
      handleMessage: mock.fn(async () => {}),
      getTranscript: mock.fn(() => [{ ts: 1, role: 'user', text: 'salut' }]),
      getExecutionState: mock.fn((p) => ({ project: p, active: p === 'familink', lastUpdate: null })),
    },
    listProjects: mock.fn(() => [
      { name: 'familink', description: 'Next.js', isDefault: true },
      { name: 'vps', description: 'sysadmin', isDefault: false },
    ]),
    getProject: mock.fn((name) => (['familink', 'vps'].includes(name) ? { name } : null)),
    channel: { name: 'api', send: mock.fn(async () => {}) },
    audit: mock.fn(),
    ...overrides,
  };
}

test('router: retourne false si la route n\'est pas /api/*', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  const handled = await handle({ method: 'POST', url: '/notify', headers: {} }, res, '');
  assert.equal(handled, false);
  assert.equal(res.statusCode, null); // pas touché
});

test('router: 401 sans token valide', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  const handled = await handle({ method: 'GET', url: '/api/projects', headers: { authorization: 'Bearer wrong' } }, res, '');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test('GET /api/projects: liste avec état actif', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle({ method: 'GET', url: '/api/projects', headers: { authorization: 'Bearer tok' } }, res, '');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.length, 2);
  assert.equal(data.find((p) => p.name === 'familink').active, true);
  assert.equal(data.find((p) => p.name === 'vps').active, false);
});

test('GET /api/transcript/:project: renvoie le transcript', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle({ method: 'GET', url: '/api/transcript/familink', headers: { authorization: 'Bearer tok' } }, res, '');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.project, 'familink');
  assert.equal(data.messages[0].text, 'salut');
});

test('GET /api/transcript/:project: 404 si projet inconnu', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle({ method: 'GET', url: '/api/transcript/inconnu', headers: { authorization: 'Bearer tok' } }, res, '');
  assert.equal(res.statusCode, 404);
});

test('GET /api/status/:project: renvoie l\'état', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle({ method: 'GET', url: '/api/status/familink', headers: { authorization: 'Bearer tok' } }, res, '');
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.active, true);
});

test('POST /api/dispatch: 202 immédiat + dispatch async', async () => {
  const deps = makeDeps();
  const { handle } = createApiRouter(deps);
  const res = makeRes();
  await handle(
    { method: 'POST', url: '/api/dispatch', headers: { authorization: 'Bearer tok' } },
    res,
    JSON.stringify({ message: 'ajoute un bouton', senderId: 'android', project: 'familink' }),
  );
  assert.equal(res.statusCode, 202);
  // Le dispatch part en tâche de fond (pas d'await côté route).
  await new Promise((r) => setImmediate(r));
  assert.equal(deps.dispatcher.handleMessage.mock.callCount(), 1);
  const args = deps.dispatcher.handleMessage.mock.calls[0].arguments;
  assert.equal(args[1], 'android');
  assert.match(args[2], /Projet ciblé : familink/);
  assert.match(args[2], /ajoute un bouton/);
});

test('POST /api/dispatch: 400 si champ manquant', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle(
    { method: 'POST', url: '/api/dispatch', headers: { authorization: 'Bearer tok' } },
    res,
    JSON.stringify({ message: 'x', senderId: 'android' }), // project manquant
  );
  assert.equal(res.statusCode, 400);
});

test('POST /api/dispatch: 404 si projet inconnu', async () => {
  const { handle } = createApiRouter(makeDeps());
  const res = makeRes();
  await handle(
    { method: 'POST', url: '/api/dispatch', headers: { authorization: 'Bearer tok' } },
    res,
    JSON.stringify({ message: 'x', senderId: 'android', project: 'inconnu' }),
  );
  assert.equal(res.statusCode, 404);
});
