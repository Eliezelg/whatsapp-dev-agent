import { spawn } from 'child_process';
import { redactSecrets } from './security.js';

const UPDATE_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 Mo max (anti-OOM)

/**
 * Lance Claude Code CLI dans le dossier du projet.
 *
 * SÉCURITÉ :
 * - Le prompt est passé via stdin, PAS argv (anti-injection de flags CLI).
 * - Spawn sans shell=true (pas d'interprétation shell).
 * - Output limité à MAX_OUTPUT_BYTES (anti-OOM).
 * - Timeout dur à 30 min (kill du process).
 * - Updates redacted des secrets avant envoi WhatsApp.
 *
 * @param {string} prompt - L'instruction utilisateur (passée via stdin).
 * @param {string} projectPath - Chemin du projet (déjà validé en amont).
 * @param {(msg: string) => void} onUpdate - Callback updates intermédiaires.
 */
export async function runClaude(prompt, projectPath, onUpdate) {
  return new Promise((resolve) => {
    // Le prompt est lu depuis stdin via le flag -p sans valeur (mode pipe).
    // Cela évite l'injection de flags malicieux dans argv.
    const args = ['--dangerously-skip-permissions', '--print'];

    let proc;
    try {
      proc = spawn('claude', args, {
        cwd: projectPath,
        timeout: MAX_TIMEOUT_MS,
        env: {
          // Whitelist des env vars passées à Claude Code
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          // Pas de GEMINI_API_KEY, pas de WHATSAPP_*, etc.
        },
        shell: false, // CRITIQUE : pas de shell=true
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(`❌ Impossible de lancer Claude Code : ${err.message}`);
      return;
    }

    // Envoie le prompt via stdin (pas argv → pas d'injection)
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch (err) {
      resolve(`❌ Erreur stdin : ${err.message}`);
      return;
    }

    let output = '';
    let outputBytes = 0;
    let killed = false;

    const updateTimer = setInterval(() => {
      if (output.length > 0 && !killed) {
        const preview = extractPreview(output);
        onUpdate?.(`⏳ En cours...\n${preview}`);
      }
    }, UPDATE_INTERVAL_MS);

    const handleData = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!killed) {
          killed = true;
          proc.kill('SIGKILL');
          output += `\n\n[OUTPUT KILLED: dépassé ${MAX_OUTPUT_BYTES / 1024 / 1024} Mo]`;
        }
        return;
      }
      output += chunk.toString();
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code, signal) => {
      clearInterval(updateTimer);
      const result = formatResult(output, code, signal, killed);
      resolve(result);
    });

    proc.on('error', (err) => {
      clearInterval(updateTimer);
      resolve(`❌ Erreur lancement Claude Code : ${err.message}`);
    });
  });
}

function extractPreview(output) {
  const cleaned = redactSecrets(output);
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-10).join('\n');
}

function formatResult(output, exitCode, signal, killed) {
  let status;
  if (killed) status = '⛔ Tué (limite atteinte)';
  else if (signal) status = `⚠️ Tué par signal ${signal}`;
  else if (exitCode === 0) status = '✅ Terminé';
  else status = `⚠️ Terminé (code ${exitCode})`;

  const clean = redactSecrets(output.trim());

  if (!clean) return `${status}\n(aucune sortie)`;

  const MAX = 3800;
  if (clean.length <= MAX) return `${status}\n\n${clean}`;
  const truncated = clean.slice(-MAX);
  return `${status}\n\n[...tronqué]\n${truncated}`;
}
