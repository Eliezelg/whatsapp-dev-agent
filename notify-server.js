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

export function startNotifyServer(getSock, ownerJid, apiRouter = null) {
  // getSock() retourne TOUJOURS la socket courante (vivante), pas une socket
  // capturee au boot. Evite les echecs 'Connection Closed' apres reconnexion.
  // apiRouter (optionnel) : routeur des routes /api/* (app mobile). Consulté en
  // premier ; si absent ou route non /api/*, on retombe sur la logique /notify.
  if (!NOTIFY_TOKEN) {
    console.warn('⚠️ NOTIFY_TOKEN non défini → endpoint /notify désactivé');
    return null;
  }

  const server = createServer((req, res) => {
    // Les routes /api/* ont besoin du body brut (GET : vide) → on lit toujours
    // le body d'abord, puis on dispatche vers l'API ou vers /notify.
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

      // 1) Routes /api/* (app mobile) — si prises en charge, on s'arrête là.
      if (apiRouter) {
        try {
          const handled = await apiRouter.handle(req, res, body);
          if (handled) return;
        } catch (err) {
          console.error('[api] erreur routeur:', err?.message || err);
          if (!res.headersSent) res.writeHead(500).end('internal error');
          return;
        }
      }

      // 2) Sinon : logique /notify historique (méthode + path strict).
      if (req.method !== 'POST' || req.url !== '/notify') {
        res.writeHead(404).end('not found');
        return;
      }

      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${NOTIFY_TOKEN}`) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      const now = Date.now();
      while (recentNotifications.length && recentNotifications[0] < now - 60_000) {
        recentNotifications.shift();
      }
      if (recentNotifications.length >= 10) {
        res.writeHead(429).end('rate limit');
        return;
      }

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

      // Retry up to 3 times with exponential backoff because WhatsApp socket
      // can momentarily be in a transitional state ('Connection Closed').
      recentNotifications.push(now);
      const safeText = redactSecrets(text);
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const sock = getSock();
          if (!sock) throw new Error('socket not ready');
          await sock.sendMessage(ownerJid, { text: safeText });
          res.writeHead(200).end('ok');
          return;
        } catch (err) {
          lastErr = err;
          console.error(`[notify] send attempt ${attempt}/3 failed:`, err.message);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        }
      }
      res.writeHead(500).end(`send failed: ${lastErr?.message || 'unknown'}`);
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
