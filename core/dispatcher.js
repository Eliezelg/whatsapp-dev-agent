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
 */
export function createDispatcher({ agent, runClaude, validateProjectPath, detectDangerousPrompt, rateLimiter, activeSessions, audit }) {
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
    await channel.send(senderId, `🚀 Lancement sur *${exec.project}*...\nJe t'envoie un update toutes les minutes.`);

    activeSessions.add(exec.project);
    const startTime = Date.now();
    try {
      const result = await runClaude(exec.prompt, pathCheck.realPath, (update) => channel.send(senderId, update));
      const durationMs = Date.now() - startTime;
      audit('exec_end', { project: exec.project, durationMs, ok: true, channel: channel.name });
      await channel.send(senderId, result);
    } catch (err) {
      audit('exec_error', { project: exec.project, error: err.message, channel: channel.name });
      await channel.send(senderId, `❌ Erreur : ${err.message}`);
    } finally {
      activeSessions.delete(exec.project);
    }
  }

  return { handleMessage };
}

export function isConfirmation(text) {
  return /^(oui|ok|go|yes|yep|✅|כן|ouais|validé|confirme?|lance|c'est bon|c est bon)$/i.test(text.trim());
}

export function isRefusal(text) {
  return /^(non|no|nop|nope|annule?|cancel|stop|❌|attends?)$/i.test(text.trim());
}
