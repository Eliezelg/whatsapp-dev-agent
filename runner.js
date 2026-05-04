import { spawn, execSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { redactSecrets } from './security.js';

const UPDATE_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 Mo
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // kill si pas de stdout depuis 5 min
const MIN_PATH = '/usr/local/bin:/usr/bin:/bin';

// ─────────────────────────────────────────────────────────────────────────────
// Résolution une seule fois du binaire claude (pin chemin absolu)
// Évite l'attaque PATH-hijacking sur ~/.local/bin/claude.
// ─────────────────────────────────────────────────────────────────────────────
const CLAUDE_BIN = resolveClaudeBin();

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execSync(`${which} claude`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split('\n')[0];
  } catch {
    throw new Error(
      'Claude Code CLI introuvable dans PATH. Installe-le (`npm i -g @anthropic-ai/claude-code`) ' +
      'ou définis CLAUDE_BIN dans .env avec le chemin absolu.',
    );
  }
}

// HOME isolé pour Claude Code (évite la lecture de ~/.claude/ de l'utilisateur).
// Override via CLAUDE_HOME si besoin.
const CLAUDE_HOME = process.env.CLAUDE_HOME || resolve(process.cwd(), '.claude-runtime-home');

// API key helper : si défini, on NE passe PAS ANTHROPIC_API_KEY en env.
// Claude Code lit la clé via le helper script à la demande.
// Voir scripts/anthropic-key-helper.sh.
const API_KEY_HELPER = process.env.CLAUDE_API_KEY_HELPER;

/**
 * Prépare CLAUDE_HOME au boot :
 * - crée le dossier s'il n'existe pas
 * - installe settings.json avec apiKeyHelper UNIQUEMENT si configuré ET
 *   qu'aucun settings.json n'existe (ne pas écraser une session Claude Max
 *   déjà initialisée par `claude setup-token`).
 */
function setupClaudeHome() {
  if (!existsSync(CLAUDE_HOME)) {
    mkdirSync(CLAUDE_HOME, { recursive: true, mode: 0o700 });
  }
  const claudeDir = join(CLAUDE_HOME, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  }
  if (API_KEY_HELPER) {
    const settingsPath = join(claudeDir, 'settings.json');
    if (!existsSync(settingsPath)) {
      const settings = { apiKeyHelper: API_KEY_HELPER };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    }
  }
}
setupClaudeHome();

/**
 * Lance Claude Code CLI dans le dossier du projet.
 *
 * SÉCURITÉ :
 * - Binaire `claude` résolu en chemin absolu au boot (anti PATH hijack).
 * - Prompt via stdin (pas argv) → anti-injection de flags CLI.
 * - PATH et HOME minimaux passés à l'enfant.
 * - shell: false, stdio piped, kill SIGKILL sur dépassement.
 * - Idle timeout 5 min, output max 10 Mo, total max 30 min.
 * - Updates redacted des secrets avant WhatsApp.
 *
 * @param {string} prompt - L'instruction utilisateur (passée via stdin).
 * @param {string} projectPath - Chemin du projet (déjà validé en amont).
 * @param {(msg: string) => void} onUpdate - Callback updates intermédiaires.
 */
export async function runClaude(prompt, projectPath, onUpdate) {
  return new Promise((resolveOuter) => {
    const args = ['--dangerously-skip-permissions', '--print'];

    let proc;
    try {
      // Build env :
      // - Si CLAUDE_API_KEY_HELPER défini → la clé est lue par le helper.
      // - Si ANTHROPIC_API_KEY définie → on la passe en env (mode API key).
      // - Sinon → mode "compte Claude Max/Pro" : Claude Code lit son token
      //   de session depuis ~/.claude/ (HOME = CLAUDE_HOME). Aucune clé en env.
      const childEnv = {
        PATH: MIN_PATH,
        HOME: CLAUDE_HOME,
        USER: 'wa-agent',
      };
      if (!API_KEY_HELPER && process.env.ANTHROPIC_API_KEY) {
        childEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }

      proc = spawn(CLAUDE_BIN, args, {
        cwd: projectPath,
        timeout: MAX_TIMEOUT_MS,
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveOuter(`❌ Impossible de lancer Claude Code : ${err.message}`);
      return;
    }

    let output = '';
    let outputBytes = 0;
    let killed = false;
    let lastDataAt = Date.now();
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearInterval(updateTimer);
      clearInterval(idleTimer);
      resolveOuter(result);
    };

    // Gestion EPIPE : si claude crash avant lecture stdin
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('runner stdin error:', err.message);
    });

    proc.stdin.write(prompt, (err) => {
      if (err) {
        if (!killed) {
          killed = true;
          try { proc.kill('SIGKILL'); } catch {}
        }
        finish(`❌ Erreur écriture stdin : ${err.message}`);
        return;
      }
      proc.stdin.end();
    });

    const updateTimer = setInterval(() => {
      if (output.length > 0 && !killed) {
        const preview = extractPreview(output);
        onUpdate?.(`⏳ En cours...\n${preview}`);
      }
    }, UPDATE_INTERVAL_MS);

    const idleTimer = setInterval(() => {
      if (killed) return;
      if (Date.now() - lastDataAt > IDLE_TIMEOUT_MS) {
        killed = true;
        try { proc.kill('SIGKILL'); } catch {}
        output += `\n\n[KILLED: aucune activité depuis ${IDLE_TIMEOUT_MS / 60000} min]`;
      }
    }, 30_000);

    const handleData = (chunk) => {
      lastDataAt = Date.now();
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!killed) {
          killed = true;
          try { proc.kill('SIGKILL'); } catch {}
          output += `\n\n[OUTPUT KILLED: dépassé ${MAX_OUTPUT_BYTES / 1024 / 1024} Mo]`;
        }
        return;
      }
      output += chunk.toString();
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code, signal) => {
      finish(formatResult(output, code, signal, killed));
    });

    proc.on('error', (err) => {
      finish(`❌ Erreur process Claude Code : ${err.message}`);
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
