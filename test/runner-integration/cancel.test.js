import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Voir env.test.js pour le détail : /tmp est noexec sur ce VPS.
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeFakeClaudeBin(dir, scriptBody) {
  const script = join(dir, 'fake-claude.js');
  writeFileSync(script, scriptBody, { mode: 0o755 });
  const wrapper = join(dir, 'claude');
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

test('cancelRunningClaude: tue le process en cours et runClaude résout status "cancelled"', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    // Process qui ne se termine jamais tout seul (attend indéfiniment) —
    // simule une tâche Claude Code longue, seule une action externe (kill)
    // peut le terminer.
    const claudeBin = makeFakeClaudeBin(dir, `setInterval(() => {}, 1000);`);
    process.env.CLAUDE_BIN = claudeBin;
    process.env.CLAUDE_HOME = dir;

    const { runClaude, cancelRunningClaude } = await import('../../runner.js');

    const resultPromise = runClaude('tâche longue', dir, () => {});

    // Laisse le temps au spawn() de s'exécuter et de s'enregistrer dans
    // activeProcesses avant de tenter l'annulation.
    await new Promise((r) => setTimeout(r, 300));

    const killed = cancelRunningClaude(dir);
    assert.equal(killed, true, 'cancelRunningClaude doit trouver et tuer le process actif');

    const result = await resultPromise;
    assert.equal(result.status, 'cancelled');
    assert.match(result.text, /Annulée|cancel/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelRunningClaude: renvoie false si aucun process actif pour ce chemin', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    const { cancelRunningClaude } = await import('../../runner.js');
    assert.equal(cancelRunningClaude(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
