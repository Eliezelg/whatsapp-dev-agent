/**
 * Filtre du bruit de logs internes à libsignal (dépendance de Baileys).
 *
 * libsignal écrit directement via console.log/error/warn — non contrôlé par le
 * `level: 'silent'` de pino (qui ne pilote que les logs Baileys eux-mêmes). Ces
 * messages ("Bad MAC", "Closing session", dumps de SessionEntry avec des Buffers
 * de clés) noient journalctl et n'apportent aucune valeur opérationnelle : ce
 * sont des désynchronisations de session Signal que WhatsApp re-synchronise seul.
 *
 * On patche console.* pour supprimer UNIQUEMENT ces lignes connues, en laissant
 * passer intégralement tout le reste (logs applicatifs, erreurs réelles).
 */

// Patterns du bruit libsignal à masquer. Volontairement spécifiques pour ne
// jamais avaler un log applicatif légitime.
const NOISE_PATTERNS = [
  /Bad MAC/,
  /Failed to decrypt message with any known session/,
  /^Session error:/,
  /^Closing session:/,
  /^Closing open session in favor of incoming prekey bundle/,
  /SessionEntry \{/,
];

/**
 * Décide si un appel console (dont le 1er argument est `firstArg`) est du bruit
 * libsignal à supprimer.
 * @param {unknown} firstArg
 * @returns {boolean}
 */
export function isLibsignalNoise(firstArg) {
  if (typeof firstArg !== 'string') return false;
  return NOISE_PATTERNS.some((p) => p.test(firstArg));
}

/**
 * Installe le filtre en patchant console.log/error/warn. Idempotent.
 */
export function installLogFilter() {
  if (globalThis.__logFilterInstalled) return;
  globalThis.__logFilterInstalled = true;

  for (const method of ['log', 'error', 'warn']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (isLibsignalNoise(args[0])) return; // avale le bruit libsignal
      original(...args);
    };
  }
}
