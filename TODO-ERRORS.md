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

**MAJ 2026-07-19** : `auth.corrupt.20260623_210821/` (13 Mo) a été supprimé —
aucune investigation n'a été menée dessus en presque un mois, la session
`auth/` actuelle est stable depuis, et le lien supposé avec le bruit Bad MAC
n'a jamais été établi. Si le bruit Bad MAC réapparaît en rafale après un futur
redémarrage, ce ne sera donc plus une piste disponible — repartir de zéro sur
l'hypothèse d'origine (re-livraison de messages chiffrés avec une clé de
session périmée) si besoin.

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

**MAJ 2026-07-19** : partiellement traité. `SECURITY.md` §5 documente
désormais explicitement l'écart (avertissements en tête de section + inline
sur les 3 directives concernées) — un lecteur de la doc ne peut plus croire à
un hardening plus fort que la réalité. `StartLimitIntervalSec`/`StartLimitBurst`
étaient en plus mal placés dans les DEUX fichiers ([Service] au lieu de
[Unit], anti-boucle de crash inopérant) — corrigé dans le repo et en prod
(`systemd-analyze verify` propre depuis). Reste non fait : le fichier
`whatsapp-agent.service` du repo n'a toujours pas été régénéré pour retirer
les 3 directives incompatibles (`SystemCallFilter`, `MemoryDenyWriteExecute`,
`RestrictRealtime`) — elles y figurent toujours comme exemple de référence,
maintenant avec des avertissements, mais un `cp` naïf du repo vers
`/etc/systemd/system/` casserait encore le service. Si l'action de fond est
faite un jour, retirer aussi les avertissements devenus inutiles.

---

## 2026-07-19 — `projects.json` — chemins `/workspaces/*` fantômes (résolu)

**Contexte** : `tzedakal`, `familink`, `gmah` pointaient vers `/workspaces/*`,
un dossier vide sur le VPS — seul le projet spécial `vps` (cwd neutre, pas un
vrai repo) était valide. Les vrais projets vivent sous `/opt/projects/*`.
Cassait systématiquement toute tâche WhatsApp sur 3 des 4 projets déclarés
(erreur de chemin renvoyée à l'utilisateur, sans exécution dans le mauvais
dossier — `validateProjectPath` a bien fait son travail de garde-fou).

**Trouvé** : lors d'un audit à 4 agents (sécu/fiabilité/architecture/UX), pas
mentionné dans ce fichier avant cette date — dette non trackée jusqu'ici.

**Résolu** : `tzedakal` → `/opt/projects/tzedakal`, `gmah` →
`/opt/projects/gmah`, ajout de `villaaviv` → `/opt/projects/villaaviv`
(existait sur disque, jamais déclaré). `familink` retiré : son seul repo
connu (`/opt/familink-agent/repo`) appartient à l'utilisateur
`familink-agent` avec des permissions (`750`, pas de groupe partagé) qui
bloquent l'accès à `wa-agent` — à ré-ajouter si l'accès est un jour ouvert
(ACL ou groupe partagé), pas avant.
