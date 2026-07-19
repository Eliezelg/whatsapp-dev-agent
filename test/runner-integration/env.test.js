import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// runner.js résout CLAUDE_BIN au chargement du module (top-level), avant
// même le premier appel à runClaude(). Pour tester ce que reçoit réellement
// le process enfant (env, stdin) sans dépendre du vrai CLI `claude`, il faut
// positionner CLAUDE_BIN AVANT l'import du module — d'où l'import dynamique
// (hors du top-level, où un import statique serait hoisté avant qu'on ait
// pu toucher process.env). Chaque cas est dans son propre fichier car
// `node --test` isole chaque fichier dans un process séparé (vérifié
// empiriquement) — sans ça, le module runner.js resterait en cache avec le
// CLAUDE_BIN du premier test importé, faussant tous les suivants.
//
// Le faux binaire est créé sous test/.tmp/ (repo), PAS os.tmpdir() : ce VPS
// monte /tmp en noexec (voir SECURITY.md §2.7), donc un script exécutable
// créé dans /tmp échouerait au spawn avec EACCES, pas testable tel quel.
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeFakeClaudeBin(dir, scriptBody) {
  const script = join(dir, 'fake-claude.js');
  writeFileSync(script, scriptBody, { mode: 0o755 });
  const wrapper = join(dir, 'claude');
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

test('runClaude: env transmis au process enfant = PATH minimal + HOME isolé, sans fuite des vars du parent', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    const claudeBin = makeFakeClaudeBin(
      dir,
      `process.stdout.write(JSON.stringify(process.env));\nprocess.exit(0);`,
    );
    process.env.CLAUDE_BIN = claudeBin;
    process.env.CLAUDE_HOME = dir;
    // Simule une variable sensible présente dans l'environnement du parent
    // (ex: GEMINI_API_KEY, WHATSAPP_OWNER) — ne doit PAS atteindre l'enfant.
    process.env.SHOULD_NOT_LEAK = 'secret-parent-var';

    const { runClaude } = await import('../../runner.js');
    const result = await runClaude('peu importe', dir, () => {});
    delete process.env.SHOULD_NOT_LEAK;

    assert.equal(result.status, 'ok');
    const childEnv = JSON.parse(result.text.split('\n\n').slice(1).join('\n\n'));
    assert.equal(childEnv.SHOULD_NOT_LEAK, undefined);
    assert.equal(childEnv.USER, 'wa-agent');
    assert.ok(childEnv.PATH, 'PATH doit être présent');
    assert.equal(childEnv.HOME, dir, 'HOME doit être le CLAUDE_HOME isolé (ici = dir), pas le HOME du parent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
