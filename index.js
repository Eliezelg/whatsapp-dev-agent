import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Agent } from './agent.js';
import { runClaude } from './runner.js';

const OWNER_JID = process.env.WHATSAPP_OWNER;
if (!OWNER_JID) {
  console.error('❌ WHATSAPP_OWNER manquant dans .env (ex: 33612345678@s.whatsapp.net)');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY manquant dans .env');
  process.exit(1);
}

const logger = pino({ level: 'silent' }); // silence Baileys logs
const agent = new Agent(process.env.GEMINI_API_KEY);
let activeSessions = new Set(); // évite les doubles exécutions simultanées

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scanne ce QR code avec WhatsApp :\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connecté !');
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
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
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid !== OWNER_JID) continue; // sécurité : whitelist

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      await handleMessage(sock, OWNER_JID, text.trim());
    }
  });
}

async function handleMessage(sock, jid, text) {
  // Confirmation d'une exécution en attente
  if (agent.pendingExecution && isConfirmation(text)) {
    const exec = agent.consumePendingExecution();
    await send(sock, jid, `🚀 Lancement sur *${exec.project}*...\nJe t'envoie un update toutes les minutes.`);

    activeSessions.add(exec.project);
    try {
      const result = await runClaude(
        exec.prompt,
        exec.projectPath,
        (update) => send(sock, jid, update)
      );
      await send(sock, jid, result);
    } finally {
      activeSessions.delete(exec.project);
    }
    return;
  }

  // Refus d'une exécution en attente
  if (agent.pendingExecution && isRefusal(text)) {
    agent.consumePendingExecution();
    await send(sock, jid, '↩️ Annulé. Dis-moi ce que tu veux changer.');
    return;
  }

  // Commande reset
  const response = await agent.chat(text);

  if (response.type === 'reset') {
    agent.resetHistory();
    await send(sock, jid, '🔄 Conversation réinitialisée.');
    return;
  }

  if (response.type === 'confirm') {
    const confirmMsg =
      `📋 *Voici ce que je vais faire :*\n\n${response.summary}\n\n` +
      `📁 Projet : *${response.project}*\n` +
      `📂 Chemin : ${response.projectPath}\n\n` +
      `Confirme avec *oui* / *ok* / *go*, ou dis-moi ce que tu veux changer.`;
    await send(sock, jid, confirmMsg);
    return;
  }

  await send(sock, jid, response.text);
}

async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur envoi message:', err.message);
  }
}

function isConfirmation(text) {
  return /^(oui|ok|go|yes|yep|✅|כן|ouais|validé|confirme?|lance|c'est bon|c est bon)$/i.test(
    text.trim()
  );
}

function isRefusal(text) {
  return /^(non|no|nop|nope|annule?|cancel|stop|❌|attends?)$/i.test(text.trim());
}

console.log('🤖 Démarrage du WhatsApp Agent...');
startBot().catch(console.error);
