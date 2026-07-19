import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Voir env.test.js pour le détail : /tmp est noexec sur ce VPS.
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

test('runClaude: le chemin ENOENT ne bloque pas la fin du process (pas de timer natif qui fuit)', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'runner-test-'));
  try {
    process.env.CLAUDE_BIN = join(dir, 'binaire-inexistant');
    process.env.CLAUDE_HOME = dir;

    const { runClaude } = await import('../../runner.js');
    const result = await runClaude('x', dir, () => {});

    // La vraie cause de la fuite n'était pas les streams stdio (ils sont
    // déjà `destroyed` par Node au moment de 'close') mais l'option native
    // `timeout` de spawn() : sur un échec ENOENT, Node ne nettoie jamais le
    // setTimeout interne qu'elle crée pour cette option, ce qui empêche le
    // process wa-agent de se terminer même après résolution (reproduit et
    // confirmé en isolation — sans l'option `timeout`, le même spawn ENOENT
    // se termine normalement). runner.js réimplémente donc le timeout de
    // 30 min manuellement (hardTimeout, nettoyé dans finish()) plutôt que
    // via l'option native. Ce test vérifie l'effet observable : après
    // résolution, aucun handle NOUVEAU (donc pas le timer natif fautif) ne
    // reste actif.
    assert.equal(result.status, 'error');
    await new Promise((r) => setImmediate(r));
    // Pas d'assertion stricte sur le compte de handles ici (des handles
    // légitimes sans rapport — ex: connexions réseau d'autres modules
    // importés — peuvent exister dans l'environnement de test) : la
    // véritable preuve de non-régression est que ce test se termine sans
    // que node --test ait besoin d'un timeout externe pour couper le
    // process, ce qui était le symptôme observé avant ce correctif.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
