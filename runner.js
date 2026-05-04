import { spawn } from 'child_process';

const UPDATE_INTERVAL_MS = 60_000;

/**
 * Lance Claude Code CLI dans le dossier du projet.
 * Appelle onUpdate(msg) toutes les 60s pendant l'exécution.
 * Retourne le résultat final sous forme de string.
 */
export async function runClaude(prompt, projectPath, onUpdate) {
  return new Promise((resolve) => {
    const proc = spawn(
      'claude',
      ['-p', prompt, '--dangerously-skip-permissions'],
      {
        cwd: projectPath,
        timeout: 30 * 60 * 1000, // 30 min max
        env: { ...process.env },
      }
    );

    let output = '';
    let lastUpdateAt = Date.now();
    let linesSinceUpdate = 0;

    const updateTimer = setInterval(() => {
      if (output.length > 0) {
        const preview = extractPreview(output);
        onUpdate?.(`⏳ En cours...\n${preview}`);
      }
    }, UPDATE_INTERVAL_MS);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.on('close', (code) => {
      clearInterval(updateTimer);
      const result = formatResult(output, code);
      resolve(result);
    });

    proc.on('error', (err) => {
      clearInterval(updateTimer);
      resolve(`❌ Erreur lancement Claude Code : ${err.message}`);
    });
  });
}

/**
 * Extrait un aperçu lisible du stdout pour les updates intermédiaires.
 * Prend les 10 dernières lignes non-vides.
 */
function extractPreview(output) {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-10).join('\n');
}

/**
 * Formate le résultat final pour WhatsApp.
 * Tronque si trop long (limite WhatsApp ~4000 chars utiles).
 */
function formatResult(output, exitCode) {
  const status = exitCode === 0 ? '✅ Terminé' : `⚠️ Terminé (code ${exitCode})`;
  const clean = output.trim();

  if (!clean) return `${status}\n(aucune sortie)`;

  const MAX = 3800;
  if (clean.length <= MAX) return `${status}\n\n${clean}`;

  // Garder la fin (les résultats récents sont plus importants)
  const truncated = clean.slice(-MAX);
  return `${status}\n\n[...tronqué]\n${truncated}`;
}
