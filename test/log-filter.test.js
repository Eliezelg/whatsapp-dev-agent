import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLibsignalNoise } from '../log-filter.js';

test('isLibsignalNoise: masque les patterns libsignal connus', () => {
  assert.equal(isLibsignalNoise('Session error:Error: Bad MAC Error: Bad MAC'), true);
  assert.equal(isLibsignalNoise('Failed to decrypt message with any known session...'), true);
  assert.equal(isLibsignalNoise('Closing session: SessionEntry {'), true);
  assert.equal(isLibsignalNoise('SessionEntry {'), true);
  assert.equal(isLibsignalNoise('Closing open session in favor of incoming prekey bundle'), true);
});

test('isLibsignalNoise: laisse passer les logs applicatifs', () => {
  assert.equal(isLibsignalNoise('✅ WhatsApp connecté !'), false);
  assert.equal(isLibsignalNoise('📬 Endpoint /notify écoute sur 127.0.0.1:5111'), false);
  assert.equal(isLibsignalNoise('[uncaught_exception] TypeError: ...'), false);
  assert.equal(isLibsignalNoise('Echec reconnexion, nouvelle tentative dans 10s'), false);
});

test('isLibsignalNoise: robuste sur premier arg non-string', () => {
  assert.equal(isLibsignalNoise(undefined), false);
  assert.equal(isLibsignalNoise(42), false);
  assert.equal(isLibsignalNoise({ some: 'object' }), false);
  assert.equal(isLibsignalNoise(null), false);
});
