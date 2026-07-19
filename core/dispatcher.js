import { listProjects } from '../projects.js';

/**
 * Cœur métier canal-agnostique : gère confirmation/refus/dispatch d'une
 * exécution Claude Code, indépendamment du canal de messagerie (WhatsApp,
 * futur Android). Toute la sécurité (path, dangerous prompt, rate limit,
 * concurrence) reste appliquée ici pour ne pas la dupliquer par canal.
 *
 * @param {object} deps
 * @param {{pendingExecution: object|null, chat: Function, consumePendingExecution: Function, resetHistory: Function}} deps.agent
 * @param {(prompt: string, path: string, onUpdate: (msg: string) => void) => Promise<string>} deps.runClaude
 * @param {(path: string) => {valid: boolean, reason?: string, realPath?: string}} deps.validateProjectPath
 * @param {(prompt: string) => string|null} deps.detectDangerousPrompt
 * @param {{checkExecution: () => {allowed: boolean, reason?: string}}} deps.rateLimiter
 * @param {Set<string>} deps.activeSessions - clé = nom de projet, partagé entre canaux
 *   pour empêcher deux canaux différents de lancer Claude Code sur le même projet en même temps.
 * @param {(event: string, details?: object) => void} deps.audit
 * @param {(realPath: string) => boolean} [deps.cancelRunningClaude] - kill le process
 *   claude en cours pour ce chemin (runner.js). Optionnel : si absent, /cancel répond
 *   qu'aucune annulation n'est possible plutôt que de planter.
 */
export function createDispatcher({ agent, runClaude, validateProjectPath, detectDangerousPrompt, rateLimiter, activeSessions, audit, alertEmail, cancelRunningClaude }) {
  // alertEmail est optionnel : si non injecté (tests, ou email non configuré),
  // les notifications d'échec sont simplement ignorées. Best-effort, jamais
  // bloquant pour le flux principal.
  const notifyFailure = typeof alertEmail === 'function' ? alertEmail : () => {};

  // ─── Transcript & état par projet (pour l'API mobile) ──────────────────────
  // Agent.history ne contient QUE les tours user/Gemini, pas les messages
  // sortants (confirmations, "🚀 Lancement", updates, résultat Claude Code).
  // On journalise ici, par projet, les messages liés aux exécutions — c'est ce
  // que l'app mobile affiche. Alimenté quand le projet est connu (executeConfirmed).
  const MAX_TRANSCRIPT_PER_PROJECT = 100; // borne mémoire
  const transcript = new Map(); // project -> [{ ts, role: 'user'|'agent', text }]
  const lastUpdate = new Map(); // project -> string (dernier "⏳ En cours..." d'une exec)
  const activeRealPaths = new Map(); // project -> realPath (pour /cancel, le temps de l'exec)

  function recordMessage(project, role, text) {
    if (!project) return;
    let msgs = transcript.get(project);
    if (!msgs) { msgs = []; transcript.set(project, msgs); }
    msgs.push({ ts: Date.now(), role, text });
    if (msgs.length > MAX_TRANSCRIPT_PER_PROJECT) msgs.splice(0, msgs.length - MAX_TRANSCRIPT_PER_PROJECT);
  }

  // Getters exposés à l'API (lecture seule côté appelant).
  function getTranscript(project) {
    return (transcript.get(project) || []).map((m) => ({ ...m }));
  }
  function getExecutionState(project) {
    return {
      project,
      active: activeSessions.has(project),
      lastUpdate: lastUpdate.get(project) || null,
    };
  }

  /**
   * Annule l'exécution en cours sur ce projet, si elle existe.
   * @returns {{cancelled: boolean, reason?: string}}
   */
  function cancelExecution(project) {
    if (!activeSessions.has(project)) {
      return { cancelled: false, reason: 'no_active_execution' };
    }
    if (typeof cancelRunningClaude !== 'function') {
      return { cancelled: false, reason: 'not_supported' };
    }
    const realPath = activeRealPaths.get(project);
    if (!realPath) {
      // Ne devrait pas arriver (activeSessions et activeRealPaths sont posés
      // ensemble dans executeConfirmed) — filet de sécurité défensif.
      return { cancelled: false, reason: 'no_active_execution' };
    }
    const killed = cancelRunningClaude(realPath);
    audit('exec_cancel_requested', { project, killed });
    return { cancelled: killed, reason: killed ? undefined : 'no_active_execution' };
  }

  /**
   * Formate la réponse à /status [projet]. Sans argument : état de tous les
   * projets déclarés. Avec argument : détail d'un seul projet (ou erreur
   * s'il n'existe pas dans projects.json).
   */
  function formatStatusMessage(projectArg) {
    const projects = listProjects();
    if (projectArg) {
      const known = projects.find((p) => p.name === projectArg);
      if (!known) {
        return `❌ Projet "${projectArg}" introuvable. Projets : ${projects.map((p) => p.name).join(', ')}`;
      }
      const state = getExecutionState(projectArg);
      return state.active
        ? `⏳ *${projectArg}* — exécution en cours.\n${state.lastUpdate || '(pas encore d\'update)'}`
        : `✅ *${projectArg}* — aucune exécution en cours.`;
    }
    const lines = projects.map((p) => {
      const state = getExecutionState(p.name);
      return `${state.active ? '⏳' : '▫️'} *${p.name}*${state.active ? ' — en cours' : ''}`;
    });
    return `📋 *Statut des projets :*\n${lines.join('\n')}`;
  }

  /**
   * Traite /cancel [projet]. Sans argument : annule toutes les exécutions
   * actives trouvées. Avec argument : cible un seul projet.
   */
  function handleCancelCommand(projectArg) {
    if (projectArg) {
      const result = cancelExecution(projectArg);
      if (result.cancelled) return `🛑 Annulation demandée sur *${projectArg}*.`;
      if (result.reason === 'not_supported') return `❌ Annulation non disponible.`;
      return `ℹ️ Aucune exécution en cours sur *${projectArg}*.`;
    }
    const activeProjects = [...activeSessions];
    if (activeProjects.length === 0) return 'ℹ️ Aucune exécution en cours.';
    const results = activeProjects.map((p) => ({ project: p, result: cancelExecution(p) }));
    const cancelled = results.filter((r) => r.result.cancelled).map((r) => r.project);
    if (cancelled.length === 0) return '❌ Annulation non disponible.';
    return `🛑 Annulation demandée sur : ${cancelled.join(', ')}.`;
  }

  async function handleMessage(channel, senderId, text) {
    audit('message_received', { length: text.length, channel: channel.name });

    if (agent.pendingExecution && isConfirmation(text)) {
      await executeConfirmed(channel, senderId);
      return;
    }

    if (agent.pendingExecution && isRefusal(text)) {
      audit('exec_refused', { channel: channel.name });
      agent.consumePendingExecution();
      await channel.send(senderId, '↩️ Annulé. Dis-moi ce que tu veux changer.');
      return;
    }

    // /status et /cancel court-circuitent Gemini : ce sont des commandes
    // système sur l'état d'exécution, pas des demandes à router vers un
    // projet. Interceptées ici (canal-agnostique) plutôt que dans agent.js
    // pour avoir un accès direct à activeSessions/cancelExecution sans
    // faire remonter cet état jusqu'à l'agent Gemini.
    const statusMatch = text.trim().match(/^\/status(?:\s+(\S+))?$/i);
    if (statusMatch) {
      await channel.send(senderId, formatStatusMessage(statusMatch[1]));
      return;
    }

    const cancelMatch = text.trim().match(/^\/cancel(?:\s+(\S+))?$/i);
    if (cancelMatch) {
      await channel.send(senderId, handleCancelCommand(cancelMatch[1]));
      return;
    }

    let response;
    try {
      response = await agent.chat(text);
    } catch (err) {
      audit('agent_error', { error: err.message, channel: channel.name });
      const msg = err?.message || String(err);
      let userMsg;
      if (/\b503\b/.test(msg)) userMsg = '⚠️ Gemini saturé (503). Réessaie dans 30s.';
      else if (/\b429\b/.test(msg)) userMsg = '⚠️ Quota Gemini atteint. Réessaie dans 1min.';
      else if (/\b403\b/.test(msg)) userMsg = '⚠️ Accès Gemini refusé. Vérifie la clé API.';
      else if (/\b401\b/.test(msg)) userMsg = '⚠️ Clé Gemini invalide.';
      else userMsg = `⚠️ Erreur Gemini : ${msg.slice(0, 200)}`;
      await channel.send(senderId, userMsg);
      return;
    }

    if (response.type === 'reset') {
      agent.resetHistory();
      audit('history_reset', { channel: channel.name });
      await channel.send(senderId, '🔄 Conversation réinitialisée.');
      return;
    }

    if (response.type === 'confirm') {
      // Canal auto-confirmant (API mobile) : l'utilisateur a explicitement tapé
      // une tâche pour un projet précis, pas besoin d'une étape de confirmation
      // "ok" (qui n'a pas de sens dans le flux app). On enchaîne directement sur
      // l'exécution. Sur WhatsApp (autoConfirm absent), le comportement reste
      // inchangé : on affiche la confirmation et on attend le "ok".
      if (channel.autoConfirm) {
        audit('exec_autoconfirm', { project: response.project, channel: channel.name });
        await executeConfirmed(channel, senderId);
        return;
      }
      audit('exec_pending', { project: response.project, channel: channel.name });
      const confirmMsg =
        `📋 *Voici ce que je vais faire :*\n\n${response.summary}\n\n` +
        `📁 Projet : *${response.project}*\n` +
        `📂 Chemin : ${response.projectPath}\n\n` +
        `Confirme avec *oui* / *ok* / *go*, ou dis-moi ce que tu veux changer.`;
      await channel.send(senderId, confirmMsg);
      return;
    }

    await channel.send(senderId, response.text);
  }

  async function executeConfirmed(channel, senderId) {
    const exec = agent.consumePendingExecution();

    const pathCheck = validateProjectPath(exec.projectPath);
    if (!pathCheck.valid) {
      audit('exec_blocked_path', { project: exec.project, reason: pathCheck.reason, channel: channel.name });
      await channel.send(senderId, `🚫 *Chemin refusé* : ${pathCheck.reason}\nProjet : ${exec.project}`);
      return;
    }

    const danger = detectDangerousPrompt(exec.prompt);
    if (danger) {
      audit('exec_blocked_dangerous', { project: exec.project, reason: danger, channel: channel.name });
      await channel.send(
        senderId,
        `🚫 *Action bloquée* : pattern dangereux détecté (${danger}).\nReformule sans cette opération.`
      );
      return;
    }

    const rateExec = rateLimiter.checkExecution();
    if (!rateExec.allowed) {
      audit('rate_limit_exec', { reason: rateExec.reason, channel: channel.name });
      await channel.send(senderId, `⛔ ${rateExec.reason}`);
      return;
    }

    if (activeSessions.has(exec.project)) {
      audit('exec_blocked_concurrent', { project: exec.project, channel: channel.name });
      await channel.send(senderId, `⏳ Une session est déjà active sur *${exec.project}*. Attends qu'elle finisse.`);
      return;
    }

    audit('exec_start', { project: exec.project, path: pathCheck.realPath, channel: channel.name });
    // Journalise l'intention utilisateur + le lancement dans le transcript projet.
    recordMessage(exec.project, 'user', exec.prompt);
    const launchMsg = `🚀 Lancement sur *${exec.project}*...\nJe t'envoie un update toutes les minutes.`;
    recordMessage(exec.project, 'agent', launchMsg);
    await channel.send(senderId, launchMsg);

    activeSessions.add(exec.project);
    activeRealPaths.set(exec.project, pathCheck.realPath);
    const startTime = Date.now();
    try {
      // runClaude retourne { status: 'ok'|'killed'|'cancelled'|'error', text }.
      // Il ne rejette jamais : le catch ci-dessous ne couvre que des bugs
      // internes du dispatcher, pas les échecs d'exécution Claude Code eux-mêmes.
      const result = await runClaude(exec.prompt, pathCheck.realPath, (update) => {
        lastUpdate.set(exec.project, update); // dernier update, pour GET /api/status
        return channel.send(senderId, update);
      });
      const durationMs = Date.now() - startTime;
      const ok = result.status === 'ok';
      const cancelled = result.status === 'cancelled';
      audit('exec_end', { project: exec.project, durationMs, status: result.status, ok, channel: channel.name });
      recordMessage(exec.project, 'agent', result.text);
      await channel.send(senderId, result.text);
      // Duplication email sur echec reel (kill par limite ou erreur spawn/process).
      // Ni un succes (status 'ok', meme avec exit code != 0) ni une annulation
      // volontaire (/cancel, l'utilisateur sait déjà) ne generent d'alerte.
      if (!ok && !cancelled) {
        notifyFailure(
          `Exécution ${result.status === 'killed' ? 'interrompue' : 'échouée'} sur ${exec.project}`,
          `Projet : ${exec.project}\nCanal : ${channel.name}\nDurée : ${Math.round(durationMs / 1000)}s\n\n${result.text}`,
        );
      }
    } catch (err) {
      audit('exec_error', { project: exec.project, error: err.message, channel: channel.name });
      const errMsg = `❌ Erreur : ${err.message}`;
      recordMessage(exec.project, 'agent', errMsg);
      await channel.send(senderId, errMsg);
      notifyFailure(
        `Erreur interne dispatcher sur ${exec.project}`,
        `Projet : ${exec.project}\nCanal : ${channel.name}\n\n${err.stack || err.message}`,
      );
    } finally {
      activeSessions.delete(exec.project);
      activeRealPaths.delete(exec.project);
      lastUpdate.delete(exec.project); // plus d'exécution en cours -> pas d'update "live"
    }
  }

  return { handleMessage, getTranscript, getExecutionState, cancelExecution };
}

// Liste de mots-clés suivie du premier mot du message (pas d'ancrage exact
// ^...$) : couvre "ok vas-y", "oui parfait", "👍 lance" sans être trop large
// (on ne matche que si le message COMMENCE par un des mots-clés, pas s'il
// apparaît n'importe où — évite qu'"annule pas le rdv" soit lu comme un oui
// à cause d'un mot piégé plus loin dans la phrase).
const CONFIRMATION_WORDS = [
  'oui', 'ok', 'okay', 'go', 'yes', 'yep', 'yalla', 'בסדר', 'כן', 'ouais',
  'validé', 'valide', 'confirme', 'confirmé', 'lance', "c'est bon", 'c est bon',
  'vas-y', 'vasy', 'nickel', 'parfait',
];
const REFUSAL_WORDS = [
  'non', 'no', 'nop', 'nope', 'annule', 'annulé', 'cancel', 'stop', 'attends',
  'attend', 'nan', 'pas encore', 'négatif',
];

// Emojis reconnus tels quels (avant tout mot), indépendamment du texte qui suit.
const CONFIRMATION_EMOJIS = ['✅', '👍', '👌'];
const REFUSAL_EMOJIS = ['❌', '🛑', '👎'];

function startsWithAny(text, words) {
  // Normalise la ponctuation collée au premier mot ("oui,", "ok!") en la
  // retirant avant comparaison — "oui, vas-y" doit matcher "oui" comme
  // "oui vas-y" le ferait déjà.
  const t = text.trim().toLowerCase().replace(/^([^\s,!.?;:]+)[,!.?;:]+/, '$1');
  return words.some((w) => t === w || t.startsWith(w + ' '));
}

export function isConfirmation(text) {
  const t = text.trim();
  if (CONFIRMATION_EMOJIS.some((e) => t.startsWith(e))) return true;
  return startsWithAny(t, CONFIRMATION_WORDS);
}

export function isRefusal(text) {
  const t = text.trim();
  if (REFUSAL_EMOJIS.some((e) => t.startsWith(e))) return true;
  return startsWithAny(t, REFUSAL_WORDS);
}
