/**
 * Alerting par email (canal indépendant de WhatsApp) — filet de sécurité
 * best-effort. Utilisé pour notifier les pannes silencieuses : déconnexion
 * WhatsApp prolongée, échec d'exécution Claude Code, crash du process.
 *
 * Envoi SORTANT uniquement via Resend (pas de réception) — aucune contrainte
 * réseau entrante (trafic HTTPS sortant déjà autorisé, comme Gemini/Anthropic).
 *
 * Contrat : ne throw JAMAIS, ne bloque jamais le flux principal. Si l'email
 * n'est pas configuré ou échoue, l'incident est journalisé (console) et on
 * continue. Timeout dur de 5s pour éviter qu'un fetch qui pend (réseau down,
 * DNS) ne fige un appelant — critique pour le handler uncaughtException.
 */
import { Resend } from 'resend';
import { redactSecrets } from './security.js';

const SEND_TIMEOUT_MS = 5000;

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.RESEND_API_KEY) return null;
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

/**
 * @param {string} subject - objet court (préfixé automatiquement).
 * @param {string} text - corps de l'alerte.
 * @returns {Promise<boolean>} true si envoyé, false si non configuré/échec/timeout.
 */
export async function sendAlertEmail(subject, text) {
  const resend = getClient();
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!resend || !to || !from) {
    console.warn(
      '[alert-email] non configuré (RESEND_API_KEY/ALERT_EMAIL_TO/ALERT_EMAIL_FROM manquant) — alerte perdue:',
      subject,
    );
    return false;
  }

  // Defense in depth : redaction des secrets au point d'envoi. Les appelants
  // passent des contenus non maîtrisés (stack traces de crash, sortie Claude
  // Code, err.message) qui peuvent contenir des clés/tokens — ne jamais les
  // laisser partir en clair vers un service email externe.
  const safeSubject = redactSecrets(subject);
  const safeText = redactSecrets(text);

  const sendPromise = resend.emails
    .send({ from, to, subject: `[whatsapp-agent] ${safeSubject}`, text: safeText })
    .then(() => true)
    .catch((err) => {
      console.error('[alert-email] échec envoi:', err?.message || err);
      return false;
    });

  // Timeout dur : ne jamais laisser un fetch pendant bloquer l'appelant.
  const timeoutPromise = new Promise((r) => setTimeout(() => r(false), SEND_TIMEOUT_MS));
  return Promise.race([sendPromise, timeoutPromise]);
}
