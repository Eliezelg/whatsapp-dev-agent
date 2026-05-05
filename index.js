import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Agent } from './agent.js';
import { runClaude } from './runner.js';
import { startNotifyServer } from './notify-server.js';
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
      audit('qr_displayed');
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connecté !');
      audit('connection_open');
      // Lance le notify server (idempotent : ne fait rien si déjà démarré)
      if (!global.__notifyStarted) {
        startNotifyServer(sock, OWNER_JID);
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
      const isSelfChat = msg.key.fromMe && isAuthorizedSender(senderJid, OWNER_JID);

      if (msg.key.fromMe && !isSelfChat) continue;

      // Sécurité : whitelist stricte
      if (!isAuthorizedSender(senderJid, OWNER_JID)) {
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

      await handleMessage(sock, senderJid, text.trim());
    }
  });
}

async function handleMessage(sock, jid, text) {
  audit('message_received', { length: text.length });

  // Confirmation d'une exécution en attente
  if (agent.pendingExecution && isConfirmation(text)) {
    const exec = agent.consumePendingExecution();

    // Validation chemin projet
    const pathCheck = validateProjectPath(exec.projectPath);
    if (!pathCheck.valid) {
      audit('exec_blocked_path', { project: exec.project, reason: pathCheck.reason });
      await send(sock, jid, `🚫 *Chemin refusé* : ${pathCheck.reason}\nProjet : ${exec.project}`);
      return;
    }

    // Détection prompt dangereux
    const danger = detectDangerousPrompt(exec.prompt);
    if (danger) {
      audit('exec_blocked_dangerous', { project: exec.project, reason: danger });
      await send(
        sock,
        jid,
        `🚫 *Action bloquée* : pattern dangereux détecté (${danger}).\nReformule sans cette opération.`
      );
      return;
    }

    // Rate limit exécutions
    const rateExec = rateLimiter.checkExecution();
    if (!rateExec.allowed) {
      audit('rate_limit_exec', { reason: rateExec.reason });
      await send(sock, jid, `⛔ ${rateExec.reason}`);
      return;
    }

    // Pas de double exécution sur le même projet
    if (activeSessions.has(exec.project)) {
      audit('exec_blocked_concurrent', { project: exec.project });
      await send(sock, jid, `⏳ Une session est déjà active sur *${exec.project}*. Attends qu'elle finisse.`);
      return;
    }

    audit('exec_start', { project: exec.project, path: pathCheck.realPath });
    await send(sock, jid, `🚀 Lancement sur *${exec.project}*...\nJe t'envoie un update toutes les minutes.`);

    activeSessions.add(exec.project);
    const startTime = Date.now();
    try {
      const result = await runClaude(
        exec.prompt,
        pathCheck.realPath,
        (update) => send(sock, jid, redactSecrets(update))
      );
      const durationMs = Date.now() - startTime;
      audit('exec_end', { project: exec.project, durationMs, ok: true });
      await send(sock, jid, redactSecrets(result));
    } catch (err) {
      audit('exec_error', { project: exec.project, error: err.message });
      await send(sock, jid, `❌ Erreur : ${err.message}`);
    } finally {
      activeSessions.delete(exec.project);
    }
    return;
  }

  // Refus d'une exécution en attente
  if (agent.pendingExecution && isRefusal(text)) {
    audit('exec_refused');
    agent.consumePendingExecution();
    await send(sock, jid, '↩️ Annulé. Dis-moi ce que tu veux changer.');
    return;
  }

  // Conversation normale avec l'agent Gemini
  let response;
  try {
    response = await agent.chat(text);
  } catch (err) {
    audit('agent_error', { error: err.message });
    await send(sock, jid, `⚠️ Erreur Gemini : ${err.message}`);
    return;
  }

  if (response.type === 'reset') {
    agent.resetHistory();
    audit('history_reset');
    await send(sock, jid, '🔄 Conversation réinitialisée.');
    return;
  }

  if (response.type === 'confirm') {
    audit('exec_pending', { project: response.project });
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
    // Defense in depth : redact ALL outgoing messages, pas seulement les outputs Claude.
    // Couvre err.message, summary Gemini, response.text, etc.
    await sock.sendMessage(jid, { text: redactSecrets(text) });
  } catch (err) {
    console.error('Erreur envoi message:', err.message);
    audit('send_error', { error: err.message });
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
