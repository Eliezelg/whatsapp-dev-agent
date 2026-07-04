# TODO-ERRORS

Dette technique et bugs identifiés mais non corrigés dans le scope courant.
Format : date, fichier:ligne, description, contexte, action proposée.

---

## 2026-07-02 — `node_modules/libsignal` — erreurs "Bad MAC" récurrentes au déchiffrement

**Contexte** : les logs montrent des rafales de `Session error: Bad MAC` /
`Failed to decrypt message with any known session` (libsignal), notamment après
un redémarrage du service. Observé sans impact confirmé sur la réception (les
messages suivants arrivent bien), mais c'est du bruit qui masque de vrais
problèmes et signale une désynchronisation partielle de session Signal côté
Baileys.

**Pourquoi pas corrigé maintenant** : hors scope de la vague observabilité ;
cause probable = re-livraison d'anciens messages chiffrés avec une clé de
session périmée (auto-résolu par WhatsApp la plupart du temps). Nécessite
investigation dédiée (peut-être lié à `auth.corrupt.20260623_210821/`, une
session corrompue jamais nettoyée).

**Action proposée** : surveiller si ça coïncide avec des pertes réelles de
messages. Si oui, envisager un reset propre de la session (`./auth` +
re-scan QR) et supprimer le dossier `auth.corrupt.*` résiduel.

**MAJ 2026-07-04** : le BRUIT de ces logs est désormais filtré (`log-filter.js`,
installé au boot de `index.js` — supprime Bad MAC / Closing session / dumps
SessionEntry de journalctl, sans toucher aux logs applicatifs). La cause racine
de la désync Signal reste non résolue mais bénigne (aucune perte de message
observée à ce jour). L'entrée reste ouverte tant que la cause n'est pas comprise.

---

## 2026-07-02 — `runner.js` — cause racine du `spawn ENOENT` transitoire non identifiée

**Contexte** : le 2026-07-02, `spawn /usr/bin/claude ENOENT` a fait échouer une
exécution alors que le binaire était parfaitement accessible avant et après
(vérifié : `which claude`, exécution directe sous `wa-agent`, inspection du
mount namespace du process via `nsenter`). `CLAUDE_BIN` est pourtant fixé en
dur via l'env. Non reproductible.

**Pourquoi pas corrigé (à la racine)** : cause non identifiée avec certitude.
Un retry unique borné sur ENOENT a été ajouté (`runner.js:runClaude`) pour
absorber le glitch, mais ce n'est qu'une ceinture de sécurité.

**Action proposée** : hypothèse la plus plausible non écartée =
**auto-update du CLI Claude Code** qui remplace le binaire sur disque pendant
une fenêtre courte (le `.exe` bun-compilé fait ~248 Mo, l'écriture n'est pas
atomique). Si le retry ENOENT se déclenche à nouveau (voir événement
`claude_spawn_enoent_retry` dans `logs/audit.log`), vérifier la corrélation
temporelle avec un update du paquet `@anthropic-ai/claude-code`, et le cas
échéant désactiver l'auto-update ou pinner une version.

---

## 2026-07-02 — systemd unit versionné ≠ unit déployé (dérive de config)

**Contexte** : `/opt/whatsapp-agent/app/whatsapp-agent.service` (dans le repo)
diffère du `/etc/systemd/system/whatsapp-agent.service` réellement actif —
notamment `ReadWritePaths` (repo : `.../auth .../logs` ; déployé :
`/opt/whatsapp-agent` entier) et l'absence de `SystemCallFilter` /
`MemoryDenyWriteExecute` dans le déployé (retirés car ils tuaient Claude Code
avec SIGSYS — voir commit `7b5ce4c`).

**Pourquoi pas corrigé** : le fichier déployé est correct fonctionnellement ;
c'est le fichier du repo qui est périmé et trompeur (laisse croire à un
hardening plus strict que la réalité).

**Action proposée** : régénérer `whatsapp-agent.service` dans le repo à partir
du fichier déployé réel, pour que la source de vérité versionnée corresponde à
la prod.
