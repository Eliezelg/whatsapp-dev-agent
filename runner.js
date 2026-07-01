import { spawn, execSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { redactSecrets, audit } from './security.js';

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

const ENOENT_RETRY_DELAY_MS = 2000; // delai avant l'unique retry sur ENOENT transitoire

/**
 * Lance Claude Code CLI dans le dossier du projet, avec un unique retry si le
 * spawn echoue avec ENOENT (glitch transitoire observe le 2026-07-02 : binaire
 * accessible avant/apres, cause racine non identifiee). Le contrat public reste
 * `runClaude(prompt, projectPath, onUpdate)`.
 *
 * @param {string} prompt - L'instruction utilisateur (passée via stdin).
 * @param {string} projectPath - Chemin du projet (déjà validé en amont).
 * @param {(msg: string) => void} onUpdate - Callback updates intermédiaires.
 * @returns {Promise<{status: 'ok'|'killed'|'error', text: string}>}
 *   status : 'ok' = terminaison propre (exit 0 ou code != 0 sans kill),
 *            'killed' = tué par limite (idle/output/signal),
 *            'error' = echec spawn/stdin/process (jamais lance ou crash immediat).
 *   text : message formaté prêt à afficher à l'utilisateur (secrets redactés).
 */
export async function runClaude(prompt, projectPath, onUpdate) {
  const first = await runClaudeOnce(prompt, projectPath, onUpdate);
  // Retry unique et borné : uniquement sur ENOENT au spawn (transitoire), pas
  // sur les autres erreurs (qui traduisent un vrai probleme de config/binaire).
  if (first.status === 'error' && first.enoent) {
    audit('claude_spawn_enoent_retry', { project: projectPath });
    await new Promise((r) => setTimeout(r, ENOENT_RETRY_DELAY_MS));
    const second = await runClaudeOnce(prompt, projectPath, onUpdate);
    return stripInternal(second);
  }
  return stripInternal(first);
}

// Retire les champs internes (enoent) avant de rendre le resultat au dispatcher.
function stripInternal({ status, text }) {
  return { status, text };
}

/**
 * Une seule exécution de Claude Code. Résout TOUJOURS (jamais de rejet) avec un
 * objet structuré. Tous les timers sont nettoyés via finish() sur chaque chemin
 * de sortie — pas de fuite de setInterval possible.
 *
 * @returns {Promise<{status: string, text: string, enoent?: boolean}>}
 */
function runClaudeOnce(prompt, projectPath, onUpdate) {
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
      // spawn synchrone qui throw (rare) — classe ENOENT pour beneficier du retry.
      resolveOuter({
        status: 'error',
        text: `❌ Impossible de lancer Claude Code : ${err.message}`,
        enoent: err.code === 'ENOENT',
      });
      return;
    }

    let output = '';
    let outputBytes = 0;
    let killed = false;
    let resolved = false;

    // Resultat structure calcule une seule fois, quel que soit l'ordre des
    // evenements (error/close/stdin-error peuvent tous survenir sur un echec).
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearInterval(updateTimer);
      clearInterval(idleTimer);
      resolveOuter(result);
    };

    let lastDataAt = Date.now();

    // Gestion EPIPE : si claude crash avant lecture stdin
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('runner stdin error:', err.message);
    });

    proc.stdin.write(prompt, (err) => {
      if (err) {
        // EPIPE ici = le process est deja mort (souvent double avec proc.on error).
        // On ne finish PAS ici sur EPIPE : on laisse proc.on('error')/('close')
        // produire le resultat classifie (evite un finish premature qui masquerait
        // un ENOENT retryable). Sur une autre erreur stdin, on finish en 'error'.
        if (err.code === 'EPIPE') return;
        if (!killed) {
          killed = true;
          try { proc.kill('SIGKILL'); } catch {}
        }
        finish({ status: 'error', text: `❌ Erreur écriture stdin : ${err.message}` });
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
      // Echec de spawn (ENOENT le plus souvent) : classe en 'error' + flag enoent
      // pour que le wrapper runClaude() puisse retenter une fois.
      finish({
        status: 'error',
        text: `❌ Erreur process Claude Code : ${err.message}`,
        enoent: err.code === 'ENOENT',
      });
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

/**
 * Construit le resultat structure d'une terminaison de process (pas un echec
 * de spawn — ceux-ci sont geres directement en 'error' dans runClaudeOnce).
 * @returns {{status: 'ok'|'killed', text: string}}
 *   'killed' = tué par une limite (idle/output/signal) ; 'ok' = terminaison
 *   normale meme si exit code != 0 (Claude a tourné, c'est un resultat legitime
 *   a montrer, pas une panne d'infra a alerter).
 */
function formatResult(output, exitCode, signal, killed) {
  let label;
  let status;
  if (killed) { label = '⛔ Tué (limite atteinte)'; status = 'killed'; }
  else if (signal) { label = `⚠️ Tué par signal ${signal}`; status = 'killed'; }
  else if (exitCode === 0) { label = '✅ Terminé'; status = 'ok'; }
  else { label = `⚠️ Terminé (code ${exitCode})`; status = 'ok'; }

  const clean = redactSecrets(output.trim());

  let text;
  if (!clean) {
    text = `${label}\n(aucune sortie)`;
  } else {
    const MAX = 3800;
    text = clean.length <= MAX
      ? `${label}\n\n${clean}`
      : `${label}\n\n[...tronqué]\n${clean.slice(-MAX)}`;
  }
  return { status, text };
}
