import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Voir env.test.js pour le détail : /tmp est noexec sur ce VPS, le faux
// binaire doit être créé sous test/.tmp/ (repo), pas os.tmpdir().
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeFakeClaudeBin(dir, scriptBody) {
  const script = join(dir, 'fake-claude.js');
  writeFileSync(script, scriptBody, { mode: 0o755 });
  const wrapper = join(dir, 'claude');
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

test('runClaude: le prompt est bien transmis via stdin', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    const claudeBin = makeFakeClaudeBin(
      dir,
      `let input = '';\nprocess.stdin.on('data', (c) => (input += c));\nprocess.stdin.on('end', () => { process.stdout.write('reçu: ' + input); process.exit(0); });`,
    );
    process.env.CLAUDE_BIN = claudeBin;
    process.env.CLAUDE_HOME = dir;

    const { runClaude } = await import('../../runner.js');
    const result = await runClaude('mon prompt de test unique 12345', dir, () => {});

    assert.equal(result.status, 'ok');
    assert.match(result.text, /mon prompt de test unique 12345/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
