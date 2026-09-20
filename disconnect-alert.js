/**
 * Machine à états de l'alerte de déconnexion WhatsApp.
 *
 * Contrat : UNE alerte par incident.
 *   - un mail quand la déconnexion dépasse `thresholdMs` ;
 *   - un mail à la reconnexion, mais seulement si l'alerte de déconnexion
 *     était partie (sinon les cycles close→open normaux de ~1s spammeraient
 *     des "reconnecté") ;
 *   - rien entre les deux.
 *
 * Historiquement l'alerte se reprogrammait toutes les 30min tant que la
 * déconnexion persistait. Sur une panne longue (QR à rescanner, donc aucune
 * reconnexion automatique possible) ça produisait un mail toutes les 30min
 * pendant des jours — le rappel n'apportait aucune information nouvelle,
 * l'incident étant déjà signalé. Ne pas réintroduire de boucle de rappel ici.
 *
 * Les dépendances temporelles sont injectables pour rendre l'état testable
 * sans attendre les délais réels.
 */
export function createDisconnectAlert({
  sendAlert,
  thresholdMs = 5 * 60 * 1000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let disconnectedSince = null;
  let alerted = false;

  return {
    /** Idempotent : un seul suivi en cours, même sur des 'close' rapprochés. */
    onDisconnected() {
      // Comparaison explicite : un timestamp vaut 0 sur une horloge injectée,
      // et `if (disconnectedSince)` laisserait alors passer un second suivi.
      if (disconnectedSince !== null) return;
      disconnectedSince = now();
      alerted = false;
      const since = disconnectedSince;
      timer = setTimer(() => {
        alerted = true;
        timer = null;
        const minutes = Math.round((now() - since) / 60000);
        sendAlert(
          'WhatsApp déconnecté',
          `whatsapp-agent est déconnecté de WhatsApp depuis ~${minutes}min et ne parvient pas à se reconnecter. Vérifie le service (journalctl -u whatsapp-agent) — un rescan du QR est peut-être nécessaire.`,
        );
      }, thresholdMs);
    },

    onReconnected() {
      if (disconnectedSince === null) return;
      const minutes = Math.round((now() - disconnectedSince) / 60000);
      const wasAlerted = alerted;
      if (timer) clearTimer(timer);
      timer = null;
      disconnectedSince = null;
      alerted = false;
      if (wasAlerted) {
        sendAlert(
          'WhatsApp reconnecté',
          `whatsapp-agent a retrouvé la connexion WhatsApp après ~${minutes}min d'indisponibilité.`,
        );
      }
    },
  };
}
