/**
 * Module de sécurité pour l'agent WhatsApp.
 *
 * Couvre :
 * - Rate limiting (anti-spam / anti-DDoS via WhatsApp)
 * - Validation des chemins de projets (anti path traversal)
 * - Détection de patterns de prompt dangereux
 * - Audit log de toutes les actions
 * - Limite de longueur des messages entrants
 */

import { existsSync, mkdirSync, appendFileSync, realpathSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = resolve(__dir, 'logs');
const AUDIT_FILE = resolve(AUDIT_DIR, 'audit.log');

if (!existsSync(AUDIT_DIR)) {
  mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMITS = {
  // Messages par minute (toutes catégories)
  MESSAGES_PER_MIN: 30,
  // Exécutions Claude Code par heure (coûteux)
  EXECUTIONS_PER_HOUR: 20,
  // Exécutions Claude Code par jour
  EXECUTIONS_PER_DAY: 100,
};

class RateLimiter {
  constructor() {
    this.messageTimestamps = [];
    this.executionTimestamps = [];
  }

  checkMessage() {
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    this.messageTimestamps = this.messageTimestamps.filter((t) => t > oneMinAgo);
    if (this.messageTimestamps.length >= RATE_LIMITS.MESSAGES_PER_MIN) {
      return {
        allowed: false,
        reason: `Trop de messages (${RATE_LIMITS.MESSAGES_PER_MIN}/min max). Attends 1 minute.`,
      };
    }
    this.messageTimestamps.push(now);
    return { allowed: true };
  }

  checkExecution() {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const oneDayAgo = now - 86_400_000;
    this.executionTimestamps = this.executionTimestamps.filter((t) => t > oneDayAgo);

    const lastHour = this.executionTimestamps.filter((t) => t > oneHourAgo).length;
    const lastDay = this.executionTimestamps.length;

    if (lastHour >= RATE_LIMITS.EXECUTIONS_PER_HOUR) {
      return {
        allowed: false,
        reason: `Limite Claude Code atteinte (${RATE_LIMITS.EXECUTIONS_PER_HOUR}/h). Attends 1 heure.`,
      };
    }
    if (lastDay >= RATE_LIMITS.EXECUTIONS_PER_DAY) {
      return {
        allowed: false,
        reason: `Limite Claude Code atteinte (${RATE_LIMITS.EXECUTIONS_PER_DAY}/jour). Attends demain.`,
      };
    }

    this.executionTimestamps.push(now);
    return { allowed: true };
  }
}

export const rateLimiter = new RateLimiter();

// ─────────────────────────────────────────────────────────────────────────────
// Validation des chemins de projets (anti path traversal)
// ─────────────────────────────────────────────────────────────────────────────

const RAW_ROOTS = process.env.ALLOWED_PROJECT_ROOTS;
if (!RAW_ROOTS) {
  throw new Error(
    'ALLOWED_PROJECT_ROOTS doit être défini dans .env (ex: /workspaces,/opt/projects).\n' +
    'Pas de défaut permissif pour des raisons de sécurité.',
  );
}
const ALLOWED_PROJECT_ROOTS = RAW_ROOTS.split(',')
  .map((p) => p.trim())
  .filter(Boolean);
if (ALLOWED_PROJECT_ROOTS.length === 0) {
  throw new Error('ALLOWED_PROJECT_ROOTS ne peut pas être vide.');
}

/**
 * Vérifie qu'un chemin de projet est dans une racine autorisée.
 * Empêche l'agent de naviguer vers /etc, /root, ~/.ssh, etc.
 */
export function validateProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return { valid: false, reason: 'Chemin manquant ou invalide' };
  }

  if (!isAbsolute(projectPath)) {
    return { valid: false, reason: 'Le chemin doit être absolu' };
  }

  // Bloque les patterns dangereux
  if (projectPath.includes('..') || projectPath.includes('\0')) {
    return { valid: false, reason: 'Caractères dangereux dans le chemin' };
  }

  // Résout les liens symboliques pour éviter les contournements
  let realPath;
  try {
    realPath = existsSync(projectPath) ? realpathSync(projectPath) : resolve(projectPath);
  } catch {
    realPath = resolve(projectPath);
  }

  // Vérifie qu'on est bien dans une racine autorisée
  const inAllowedRoot = ALLOWED_PROJECT_ROOTS.some((root) => {
    const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    return realPath === realRoot || realPath.startsWith(realRoot + '/') || realPath.startsWith(realRoot + '\\');
  });

  if (!inAllowedRoot) {
    return {
      valid: false,
      reason: `Chemin hors racines autorisées (${ALLOWED_PROJECT_ROOTS.join(', ')})`,
    };
  }

  // Bloque explicitement les chemins sensibles
  const FORBIDDEN_PATTERNS = [
    /\/\.ssh(\/|$)/,
    /\/\.gnupg(\/|$)/,
    /\/etc(\/|$)/,
    /\/root(\/|$)/,
    /\/var\/log(\/|$)/,
    /\/proc(\/|$)/,
    /\/sys(\/|$)/,
    /\/boot(\/|$)/,
  ];
  if (FORBIDDEN_PATTERNS.some((p) => p.test(realPath))) {
    return { valid: false, reason: 'Chemin système interdit' };
  }

  return { valid: true, realPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Détection de prompts dangereux
// ─────────────────────────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // Destruction massive
  { pattern: /\brm\s+-[rf]+\s+\/(\s|$)/, reason: 'rm -rf /' },
  { pattern: /\brm\s+-[rf]+\s+~/, reason: 'rm -rf ~' },
  { pattern: /\bmkfs\.|format\s+[a-z]:/i, reason: 'formatage disque' },
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: 'écriture brute /dev' },
  { pattern: /:\(\)\{.*:\|:&\s*\};:/, reason: 'fork bomb' },

  // Exfiltration de secrets
  { pattern: /cat\s+.*\.env|cat\s+\/etc\/passwd|cat\s+\/etc\/shadow/i, reason: 'lecture secrets' },
  { pattern: /\.ssh\/id_(rsa|ed25519|ecdsa)/i, reason: 'lecture clés SSH' },
  { pattern: /curl.*\|\s*(bash|sh)\s*$/i, reason: 'pipe to shell' },
  { pattern: /wget.*\|\s*(bash|sh)\s*$/i, reason: 'pipe to shell' },

  // Modification système
  { pattern: /\b(passwd|usermod|userdel|useradd)\s+/i, reason: 'modification utilisateurs' },
  { pattern: /\bchmod\s+777/i, reason: 'chmod 777' },
  { pattern: /\bchown\s+.*:.*\s+\//i, reason: 'chown system root' },
  { pattern: /systemctl\s+(stop|disable|mask)\s+(sshd|ufw|fail2ban)/i, reason: 'désactivation sécurité' },
  { pattern: /\bufw\s+disable\b/i, reason: 'désactivation firewall' },

  // Exposition réseau
  { pattern: /\b(ngrok|cloudflared|localtunnel)\b/i, reason: 'tunnel public' },
  { pattern: /-A\s+(INPUT|FORWARD)\s+.*ACCEPT/i, reason: 'iptables ACCEPT' },
];

/**
 * Détecte les patterns dangereux dans un prompt utilisateur.
 * Retourne null si OK, sinon une raison de blocage.
 */
export function detectDangerousPrompt(text) {
  if (!text) return null;
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Limites de taille
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_PROMPT_LENGTH = 8000;

export function validateMessageLength(text) {
  if (!text) return { valid: false, reason: 'Message vide' };
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, reason: `Message trop long (max ${MAX_MESSAGE_LENGTH} chars)` };
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log une action dans /logs/audit.log avec timestamp ISO.
 * Format JSON Lines pour parsing facile.
 */
export function audit(event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelist JID stricte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie que le JID expéditeur est bien le owner.
 * Format JID WhatsApp : <numéro>@s.whatsapp.net (pas @g.us pour groupes).
 */
export function isAuthorizedSender(jid, ownerJid) {
  if (!jid || !ownerJid) return false;
  // Refuse explicitement les groupes
  if (jid.endsWith('@g.us')) return false;
  // Refuse les broadcasts/status
  if (jid === 'status@broadcast') return false;
  // Match exact uniquement
  return jid === ownerJid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitization des secrets dans les outputs
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // API keys (Anthropic, OpenAI, Google, etc.)
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g, // Google API
  // AWS
  /AKIA[0-9A-Z]{16}/g,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  // Generic JWT
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Lignes contenant des secrets explicites
  /(password|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/gi,
];

/**
 * Remplace les secrets potentiels par [REDACTED] avant envoi WhatsApp.
 */
export function redactSecrets(text) {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}
