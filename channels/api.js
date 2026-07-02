/**
 * API REST interne pour l'app mobile (Android). Auth par token Bearer statique
 * dédié (API_TOKEN, distinct de NOTIFY_TOKEN). Le serveur reste bind sur
 * 127.0.0.1 — l'exposition au réseau mobile passera par Tailscale (pas
 * d'ouverture publique du port).
 *
 * 4 routes :
 *   GET  /api/projects            → liste des projets + état actif
 *   GET  /api/transcript/:project → journal des messages d'exécution du projet
 *   GET  /api/status/:project     → état d'exécution en cours (pour polling)
 *   POST /api/dispatch            → { message, senderId, project } ; répond 202
 *                                    immédiatement, exécution async (pas d'await
 *                                    30min qui ferait timeout le client mobile).
 *
 * Ce module ne dépend que d'interfaces injectées (dispatcher, listProjects,
 * apiToken) → testable sans réseau ni serveur HTTP réel.
 */

/**
 * Construit le routeur API. Retourne une fonction `handle(req, res, rawBody)`
 * qui renvoie true si la requête a été prise en charge (route /api/*), false
 * sinon (pour laisser le serveur gérer /notify ou 404).
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {{ handleMessage: Function, getTranscript: Function, getExecutionState: Function }} opts.dispatcher
 * @param {() => Array<{name,description,isDefault}>} opts.listProjects
 * @param {(name: string) => object|null} opts.getProject
 * @param {{ name: string, send: Function }} opts.channel - canal 'api' (send no-op ou log)
 * @param {(event: string, details?: object) => void} opts.audit
 */
export function createApiRouter({ apiToken, dispatcher, listProjects, getProject, channel, audit }) {
  function unauthorized(res) { res.writeHead(401).end('unauthorized'); }
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(body);
  }

  async function handle(req, res, rawBody) {
    const url = req.url || '';
    if (!url.startsWith('/api/')) return false; // pas une route API

    // Auth sur toutes les routes /api/*.
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${apiToken}`) { unauthorized(res); return true; }

    // GET /api/projects
    if (req.method === 'GET' && url === '/api/projects') {
      const projects = listProjects().map((p) => ({
        name: p.name,
        description: p.description,
        isDefault: p.isDefault,
        active: dispatcher.getExecutionState(p.name).active,
      }));
      json(res, 200, projects);
      return true;
    }

    // GET /api/transcript/:project
    const mTranscript = url.match(/^\/api\/transcript\/([^/?]+)$/);
    if (req.method === 'GET' && mTranscript) {
      const project = decodeURIComponent(mTranscript[1]);
      if (!getProject(project)) { json(res, 404, { error: 'projet inconnu' }); return true; }
      json(res, 200, { project, messages: dispatcher.getTranscript(project) });
      return true;
    }

    // GET /api/status/:project
    const mStatus = url.match(/^\/api\/status\/([^/?]+)$/);
    if (req.method === 'GET' && mStatus) {
      const project = decodeURIComponent(mStatus[1]);
      if (!getProject(project)) { json(res, 404, { error: 'projet inconnu' }); return true; }
      json(res, 200, dispatcher.getExecutionState(project));
      return true;
    }

    // POST /api/dispatch
    if (req.method === 'POST' && url === '/api/dispatch') {
      let payload;
      try { payload = JSON.parse(rawBody); } catch { json(res, 400, { error: 'invalid json' }); return true; }
      const { message, senderId, project } = payload;
      if (!message || !senderId || !project) {
        json(res, 400, { error: 'message, senderId et project requis' });
        return true;
      }
      if (!getProject(project)) { json(res, 404, { error: 'projet inconnu' }); return true; }

      // Réponse immédiate : on n'attend PAS l'exécution (jusqu'à 30min).
      // Le client mobile suit l'avancement via GET /api/status/:project.
      audit('api_dispatch', { project, senderId });
      json(res, 202, { accepted: true, project });
      // Exécution en tâche de fond. L'app connaît déjà le projet ciblé (écran
      // de conversation d'un projet), donc on préfixe le message d'un hint que
      // l'agent Gemini interprète pour router sans ambiguïté — sans modifier le
      // contrat handleMessage(channel, senderId, text) partagé avec WhatsApp.
      const hintedMessage = `[Projet ciblé : ${project}] ${message}`;
      dispatcher
        .handleMessage(channel, senderId, hintedMessage)
        .catch((err) => console.error('[api] dispatch échoué:', err?.message || err));
      return true;
    }

    json(res, 404, { error: 'route inconnue' });
    return true;
  }

  return { handle };
}
