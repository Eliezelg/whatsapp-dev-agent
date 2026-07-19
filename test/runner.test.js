import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResult, extractPreview } from '../runner.js';

// ─── formatResult ────────────────────────────────────────────────────────

test('formatResult: exit 0 -> status ok, label Terminé', () => {
  const r = formatResult('tout va bien', 0, null, false);
  assert.equal(r.status, 'ok');
  assert.match(r.text, /✅ Terminé/);
  assert.match(r.text, /tout va bien/);
});

test('formatResult: exit code != 0 sans kill -> status ok (pas une panne infra)', () => {
  const r = formatResult('erreur applicative', 1, null, false);
  assert.equal(r.status, 'ok');
  assert.match(r.text, /code 1/);
});

test('formatResult: killed=true -> status killed quel que soit exitCode', () => {
  const r = formatResult('sortie partielle', null, null, true);
  assert.equal(r.status, 'killed');
  assert.match(r.text, /Tué \(limite atteinte\)/);
});

test('formatResult: signal reçu sans killed explicite -> status killed', () => {
  const r = formatResult('sortie partielle', null, 'SIGTERM', false);
  assert.equal(r.status, 'killed');
  assert.match(r.text, /Tué par signal SIGTERM/);
});

test('formatResult: output vide -> "(aucune sortie)"', () => {
  const r = formatResult('   ', 0, null, false);
  assert.match(r.text, /\(aucune sortie\)/);
});

test('formatResult: output <= 3800 chars -> pas de troncature', () => {
  const output = 'x'.repeat(3800);
  const r = formatResult(output, 0, null, false);
  assert.doesNotMatch(r.text, /tronqué/);
  assert.match(r.text, new RegExp('x'.repeat(3800)));
});

test('formatResult: output > 3800 chars -> tronqué, garde la fin', () => {
  const output = 'a'.repeat(100) + 'b'.repeat(4000);
  const r = formatResult(output, 0, null, false);
  assert.match(r.text, /tronqué/);
  // La fin (les 'b') doit être présente, le début ('a') doit avoir disparu.
  assert.match(r.text, /b{100}/);
  assert.doesNotMatch(r.text, /a{100}/);
});

test('formatResult: redacte les secrets même dans un output ok', () => {
  const r = formatResult('ANTHROPIC_API_KEY=sk-ant-abcdef1234567890abcdef', 0, null, false);
  assert.doesNotMatch(r.text, /sk-ant-abcdef1234567890abcdef/);
});

// ─── extractPreview ───────────────────────────────────────────────────────

test('extractPreview: garde au plus les 10 dernières lignes non vides', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `ligne ${i + 1}`);
  const preview = extractPreview(lines.join('\n'));
  const previewLines = preview.split('\n');
  assert.equal(previewLines.length, 10);
  assert.equal(previewLines[0], 'ligne 11');
  assert.equal(previewLines[9], 'ligne 20');
});

test('extractPreview: filtre les lignes vides/blanches', () => {
  const preview = extractPreview('a\n\n   \nb\n\nc');
  assert.equal(preview, 'a\nb\nc');
});

test('extractPreview: redacte les secrets', () => {
  const preview = extractPreview('GEMINI_API_KEY=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567');
  assert.doesNotMatch(preview, /AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567/);
});
