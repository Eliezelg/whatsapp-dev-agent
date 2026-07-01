import { test } from 'node:test';
import assert from 'node:assert/strict';

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
