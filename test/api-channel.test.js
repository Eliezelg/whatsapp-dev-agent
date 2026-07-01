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
