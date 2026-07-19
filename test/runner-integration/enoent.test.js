import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Voir env.test.js pour le détail : /tmp est noexec sur ce VPS. Ce test ne
// crée pas d'exécutable réel (le binaire est censé ne pas exister), mais on
// reste cohérent avec les autres fichiers du dossier par précaution.
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

test('runClaude: binaire introuvable (ENOENT) -> status error avec message clair, retry unique puis abandon', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    process.env.CLAUDE_BIN = join(dir, 'binaire-inexistant');
    process.env.CLAUDE_HOME = dir;

    const { runClaude } = await import('../../runner.js');
    const start = Date.now();
    const result = await runClaude('x', dir, () => {});
    const elapsedMs = Date.now() - start;

    assert.equal(result.status, 'error');
    assert.match(result.text, /Erreur process Claude Code|Impossible de lancer/);
    // runner.js retry une fois sur ENOENT avec un délai de 2s avant de
    // retenter — le test doit refléter ce comportement documenté (voir
    // TODO-ERRORS.md), pas juste échouer immédiatement.
    assert.ok(elapsedMs >= 2000, `attendu >= 2000ms (retry ENOENT), obtenu ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
