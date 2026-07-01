import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendAlertEmail } from '../notify-email.js';

// Ces tests vérifient le contrat best-effort : sendAlertEmail ne throw JAMAIS
// et retourne false quand l'email n'est pas configuré. On ne teste pas l'envoi
// Resend réel (SDK tiers, testé par ses auteurs ; nécessiterait un réseau).

test('sendAlertEmail: retourne false si RESEND_API_KEY absent (dégradé, pas de throw)', async () => {
  const saved = { ...process.env };
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_EMAIL_TO;
  delete process.env.ALERT_EMAIL_FROM;
  try {
    const result = await sendAlertEmail('test', 'corps');
    assert.equal(result, false);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('sendAlertEmail: retourne false si ALERT_EMAIL_TO/FROM manquants même avec clé', async () => {
  const saved = { ...process.env };
  process.env.RESEND_API_KEY = 're_fake_for_test';
  delete process.env.ALERT_EMAIL_TO;
  delete process.env.ALERT_EMAIL_FROM;
  try {
    const result = await sendAlertEmail('test', 'corps');
    assert.equal(result, false);
  } finally {
    // Nettoyage : restaurer l'env, y compris supprimer la clé factice.
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});
