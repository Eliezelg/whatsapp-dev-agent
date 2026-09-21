import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisconnectAlert } from '../disconnect-alert.js';

/**
 * Horloge et timers factices : on pilote le temps à la main pour ne pas
 * attendre les délais réels (seuil de 5min, et anciennement rappel de 30min).
 */
function harness({ thresholdMs = 5 * 60 * 1000 } = {}) {
  const sent = [];
  let clock = 0;
  let nextId = 1;
  const timers = new Map();

  const alert = createDisconnectAlert({
    sendAlert: (subject, text) => sent.push({ subject, text }),
    thresholdMs,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });

  // Avance l'horloge et déclenche tout timer arrivé à échéance.
  function advance(ms) {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
  }

  return { alert, sent, advance, pendingTimers: () => timers.size };
}

test('une seule alerte par incident, même sur une panne très longue', () => {
  const { alert, sent, advance, pendingTimers } = harness();

  alert.onDisconnected();
  advance(5 * 60 * 1000);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /déconnecté/);

  // Régression : la version initiale reprogrammait un rappel toutes les 30min,
  // ce qui produisait un mail toutes les demi-heures pendant des jours.
  advance(72 * 60 * 60 * 1000); // 3 jours de déconnexion
  assert.equal(sent.length, 1, 'aucun rappel ne doit être envoyé');
  assert.equal(pendingTimers(), 0, 'aucun timer ne doit rester armé');
});

test('reconnexion après alerte : un mail de reprise, avec la durée', () => {
  const { alert, sent, advance } = harness();

  alert.onDisconnected();
  advance(5 * 60 * 1000);
  advance(25 * 60 * 1000);
  alert.onReconnected();

  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /reconnecté/);
  assert.match(sent[1].text, /~30min/);
});

test('cycle close→open court : aucun mail', () => {
  const { alert, sent, advance, pendingTimers } = harness();

  alert.onDisconnected();
  advance(1000); // reconnexion en 1s, sous le seuil
  alert.onReconnected();

  assert.deepEqual(sent, []);
  assert.equal(pendingTimers(), 0, 'le timer en attente doit être annulé');
});

test('onDisconnected est idempotent sur des close rapprochés', () => {
  const { alert, sent, advance } = harness();

  alert.onDisconnected();
  advance(60 * 1000);
  alert.onDisconnected(); // ne doit pas réarmer ni redémarrer le compteur
  alert.onDisconnected();
  advance(4 * 60 * 1000); // seuil atteint depuis le PREMIER close

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /~5min/);
});

test('onReconnected sans déconnexion en cours est un no-op', () => {
  const { alert, sent } = harness();

  alert.onReconnected();
  alert.onReconnected();

  assert.deepEqual(sent, []);
});
