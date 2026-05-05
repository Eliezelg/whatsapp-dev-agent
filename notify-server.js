/**
 * Serveur HTTP local (127.0.0.1 only) pour recevoir des notifications
 * système (audit sécurité, alertes cron, etc.) et les forwarder sur WhatsApp.
 *
 * SÉCURITÉ :
 * - Bind 127.0.0.1 uniquement (pas accessible depuis Internet).
 * - Auth par token partagé via /etc/whatsapp-agent.env (NOTIFY_TOKEN).
 * - Rate limit : 10 notifications par minute (anti-spam interne).
 * - Limite 8 Ko par message (assez pour un rapport audit).
 */

import { createServer } from 'http';
import { redactSecrets } from './security.js';

const NOTIFY_PORT = 5111;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN;
const MAX_BODY_BYTES = 8192;

const recentNotifications = [];

export function startNotifyServer(sock, ownerJid) {
  if (!NOTIFY_TOKEN) {
    console.warn('⚠️ NOTIFY_TOKEN non défini → endpoint /notify désactivé');
    return null;
  }

  const server = createServer((req, res) => {
    // Méthode + path strict
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404).end('not found');
      return;
    }

    // Auth header obligatoire
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${NOTIFY_TOKEN}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }

    // Rate limit
    const now = Date.now();
    while (recentNotifications.length && recentNotifications[0] < now - 60_000) {
      recentNotifications.shift();
    }
    if (recentNotifications.length >= 10) {
      res.writeHead(429).end('rate limit');
      return;
    }

    // Lire le body
    let body = '';
    let bytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413).end('payload too large');
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      if (aborted) return;

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end('invalid json');
        return;
      }

      const text = typeof payload.text === 'string' ? payload.text : null;
      if (!text || text.trim().length === 0) {
        res.writeHead(400).end('missing text');
        return;
      }

      try {
        recentNotifications.push(now);
        await sock.sendMessage(ownerJid, { text: redactSecrets(text) });
        res.writeHead(200).end('ok');
      } catch (err) {
        console.error('[notify] send failed:', err.message);
        res.writeHead(500).end('send failed');
      }
    });

    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end('bad request');
    });
  });

  server.listen(NOTIFY_PORT, '127.0.0.1', () => {
    console.log(`📬 Endpoint /notify écoute sur 127.0.0.1:${NOTIFY_PORT}`);
  });

  server.on('error', (err) => {
    console.error('[notify] server error:', err.message);
  });

  return server;
}
