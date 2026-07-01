import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Agent } from './agent.js';
import { runClaude } from './runner.js';
import { startNotifyServer } from './notify-server.js';
import { createDispatcher } from './core/dispatcher.js';
import {
  rateLimiter,
  validateProjectPath,
  detectDangerousPrompt,
  validateMessageLength,
  isAuthorizedSender,
  redactSecrets,
  audit,
} from './security.js';

const OWNER_JID = process.env.WHATSAPP_OWNER;
// (optionnel) Identifiant @lid du owner — WhatsApp route certains messages
// (notamment le self-chat) avec ce format anonyme au lieu de @s.whatsapp.net.
// Voir security.js:isAuthorizedSender pour le détail.
const OWNER_LID = process.env.WHATSAPP_OWNER_LID || undefined;
if (!OWNER_JID) {
  console.error('❌ WHATSAPP_OWNER manquant dans .env (ex: 33612345678@s.whatsapp.net)');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY manquant dans .env');
  process.exit(1);
}
if (!OWNER_JID.endsWith('@s.whatsapp.net')) {
  console.error('❌ WHATSAPP_OWNER doit se terminer par @s.whatsapp.net');
  process.exit(1);
}

const logger = pino({ level: 'silent' });
const agent = new Agent(process.env.GEMINI_API_KEY);
let activeSessions = new Set();

audit('boot', { owner: OWNER_JID, pid: process.pid });

// Reference vivante de la socket courante. Reassignee a chaque (re)connexion
// pour que le notify-server n'utilise jamais une socket morte (stale socket).
let currentSock = null;

const dispatcher = createDispatcher({
  agent,
  runClaude,
  validateProjectPath,
  detectDangerousPrompt,
  rateLimiter,
  activeSessions,
  audit,
});

const whatsappChannel = {
  name: 'whatsapp',
  send: (jid, text) => send(currentSock, jid, text),
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['WhatsApp Agent', 'Chrome', '1.0'],
  });

  currentSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scanne ce QR code avec WhatsApp :\n');
      qrcode.generate(qr, { small: true });
      audit('qr_displayed');
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connecté !');
      audit('connection_open');
      // Lance le notify server (idempotent : ne fait rien si déjà démarré)
      if (!global.__notifyStarted) {
        startNotifyServer(() => currentSock, OWNER_JID);
        global.__notifyStarted = true;
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      audit('connection_close', { shouldReconnect });
      if (shouldReconnect) {
        console.log('🔄 Reconnexion...');
        startBot();
      } else {
        console.log('❌ Déconnecté (logged out). Supprime ./auth et relance.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Quand on envoie à son propre numéro (self-chat), fromMe peut être true.
      // On accepte les messages "fromMe" UNIQUEMENT si le destinataire est l'owner
      // (auquel cas c'est l'owner qui se parle à lui-même via WhatsApp).
      // Pour les vrais messages venant d'un autre, fromMe est false et remoteJid
      // est le JID de l'expéditeur.
      const senderJid = msg.key.remoteJid;
      const isSelfChat = msg.key.fromMe && isAuthorizedSender(senderJid, OWNER_JID, OWNER_LID);

      if (msg.key.fromMe && !isSelfChat) continue;

      // Sécurité : whitelist stricte
      if (!isAuthorizedSender(senderJid, OWNER_JID, OWNER_LID)) {
        audit('unauthorized_sender', { jid: senderJid });
        continue;
      }

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      // Validation longueur
      const lenCheck = validateMessageLength(text);
      if (!lenCheck.valid) {
        audit('message_rejected', { reason: lenCheck.reason });
        await send(sock, senderJid, `⚠️ ${lenCheck.reason}`);
        continue;
      }

      // Rate limiting messages
      const rateMsg = rateLimiter.checkMessage();
      if (!rateMsg.allowed) {
        audit('rate_limit_message', { reason: rateMsg.reason });
        await send(sock, senderJid, `⛔ ${rateMsg.reason}`);
        continue;
      }

      await dispatcher.handleMessage(whatsappChannel, senderJid, text.trim());
    }
  });
}

async function send(sock, jid, text) {
  try {
    // Defense in depth : redact ALL outgoing messages, pas seulement les outputs Claude.
    // Couvre err.message, summary Gemini, response.text, etc.
    await sock.sendMessage(jid, { text: redactSecrets(text) });
  } catch (err) {
    console.error('Erreur envoi message:', err.message);
    audit('send_error', { error: err.message });
  }
}

// Gestion arrêt propre
process.on('SIGTERM', () => {
  audit('shutdown', { signal: 'SIGTERM' });
  process.exit(0);
});
process.on('SIGINT', () => {
  audit('shutdown', { signal: 'SIGINT' });
  process.exit(0);
});

console.log('🤖 Démarrage du WhatsApp Agent...');
startBot().catch((err) => {
  audit('boot_error', { error: err.message });
  console.error(err);
});
