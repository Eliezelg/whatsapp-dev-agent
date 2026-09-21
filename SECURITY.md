# Guide de sécurité — Hardening VPS + WhatsApp Agent

> Ce guide couvre la sécurisation maximale d'un VPS Ubuntu 24.04 hébergeant
> l'agent WhatsApp + Claude Code CLI, et accessoirement Asterisk.
>
> Lis-le **avant** de mettre l'agent en production. Chaque section est
> critique : ne saute pas d'étape.

---

## 1. Couches de sécurité (vue d'ensemble)

```
┌─────────────────────────────────────────────────────┐
│ Couche 7 — Application (whatsapp-agent)             │
│   • Whitelist JID stricte                           │
│   • Rate limiting (msg/min, exec/h, exec/jour)      │
│   • Validation chemins projets                      │
│   • Détection prompts dangereux                     │
│   • Sanitization secrets dans outputs               │
│   • Audit log JSONL                                 │
├─────────────────────────────────────────────────────┤
│ Couche 6 — Process (systemd)                        │
│   • User dédié non-root                             │
│   • ProtectSystem, ProtectHome, NoNewPrivileges     │
│   • Capabilities minimales                          │
│   • Resource limits (RAM, FD, processes)            │
├─────────────────────────────────────────────────────┤
│ Couche 5 — Réseau (UFW + fail2ban)                  │
│   • Default deny inbound                            │
│   • SSH port custom + key-only                      │
│   • fail2ban anti-bruteforce                        │
│   • Pas d'exposition publique de l'agent            │
├─────────────────────────────────────────────────────┤
│ Couche 4 — OS (kernel + sysctl)                     │
│   • Auto-updates sécurité                           │
│   • sysctl hardening                                │
│   • SSH hardening (no root, no password, MFA)       │
├─────────────────────────────────────────────────────┤
│ Couche 3 — Filesystem                               │
│   • chmod stricts (.env=600, auth/=700)             │
│   • Audit ownership                                 │
│   • /tmp noexec                                     │
├─────────────────────────────────────────────────────┤
│ Couche 2 — Monitoring                               │
│   • journald → audit central                        │
│   • Alertes sur events critiques                    │
│   • Backups chiffrés hors-site                      │
├─────────────────────────────────────────────────────┤
│ Couche 1 — Provider VPS                             │
│   • Hetzner : 2FA compte + cloud firewall           │
│   • Snapshots automatiques                          │
└─────────────────────────────────────────────────────┘
```

---

## 2. Hardening initial du VPS (à faire en premier)

### 2.1 Compte Hetzner / cloud firewall

1. **Activer 2FA** sur ton compte Hetzner Cloud Console
2. Créer un **Cloud Firewall** Hetzner avec ces règles inbound :
   - SSH : ton IP fixe uniquement (ou plage VPN)
   - ICMP : autorisé (debug ping)
   - Tout le reste : DROP
3. Attacher le firewall au VPS
4. Activer les **snapshots automatiques** (prix négligeable)

### 2.2 SSH hardening

Sur ta machine locale, génère une clé Ed25519 si tu n'en as pas :

```bash
ssh-keygen -t ed25519 -C "vps-tzedakal-$(date +%Y%m%d)"
```

Sur le VPS :

```bash
# Ajoute ta clé publique
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... user@machine" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Édite /etc/ssh/sshd_config
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
# Authentification
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no

# Limites
MaxAuthTries 3
MaxSessions 4
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2

# Restrictions
AllowUsers root deploy
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no

# Algos forts uniquement
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com

# Logs verbose pour fail2ban
LogLevel VERBOSE

# Port custom (optionnel mais utile contre les scans automatisés)
Port 2222
EOF

sshd -t  # vérifie la syntaxe
systemctl restart ssh
```

> ⚠️ Avant de fermer ta session SSH, ouvre un **second terminal** pour
> vérifier que la nouvelle config marche. Si tu es lock out, tu utilises
> le KVM console Hetzner pour récupérer.

Si tu changes de port (recommandé) :

```bash
ufw allow 2222/tcp comment 'SSH custom'
ufw delete allow 22/tcp
```

### 2.3 fail2ban

```bash
apt install -y fail2ban

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3
backend = systemd

[sshd]
enabled = true
port = 2222
filter = sshd
maxretry = 3
bantime = 86400

[recidive]
enabled = true
filter = recidive
logpath = /var/log/fail2ban.log
banaction = iptables-allports
bantime = 604800
findtime = 86400
maxretry = 5
EOF

systemctl enable --now fail2ban
fail2ban-client status
```

### 2.4 UFW firewall

```bash
apt install -y ufw

ufw default deny incoming
ufw default allow outgoing

# SSH custom port
ufw allow 2222/tcp comment 'SSH'

# Si Asterisk : SIP + RTP (voir docs/asterisk-migration/)
# ufw allow 5060/udp comment 'SIP'
# ufw allow 10000:20000/udp comment 'RTP'

# Si WireGuard tunnel privé
# ufw allow from <RAILWAY_PUBLIC_IP> to any port 51820 proto udp

ufw enable
ufw status verbose
```

> L'agent WhatsApp **n'a aucun port à ouvrir** en inbound. Baileys sort
> uniquement en HTTPS sortant vers les serveurs WhatsApp.

### 2.5 Auto-updates sécurité

```bash
apt install -y unattended-upgrades apt-listchanges

cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Mail "ton-email@example.com";
Unattended-Upgrade::MailReport "on-change";
EOF

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

systemctl enable --now unattended-upgrades
```

### 2.6 Sysctl hardening

```bash
cat > /etc/sysctl.d/99-hardening.conf <<'EOF'
# Network — anti-spoofing
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.log_martians = 1

# Network — anti-DDoS
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Kernel
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.yama.ptrace_scope = 1
kernel.unprivileged_bpf_disabled = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
EOF

sysctl --system
```

### 2.7 Filesystem hardening

```bash
# /tmp en noexec, nosuid, nodev (si pas déjà fait)
# Édite /etc/fstab pour rendre persistant
mount -o remount,noexec,nosuid,nodev /tmp 2>/dev/null || \
  echo "tmpfs /tmp tmpfs defaults,noexec,nosuid,nodev,size=1G 0 0" >> /etc/fstab
```

---

## 3. User dédié pour l'agent (pas root !)

```bash
# Crée un user dédié sans shell login direct
useradd -r -s /bin/bash -d /opt/whatsapp-agent -m wa-agent
mkdir -p /opt/whatsapp-agent
chown wa-agent:wa-agent /opt/whatsapp-agent
chmod 750 /opt/whatsapp-agent
```

**Pourquoi pas root ?** Si Claude Code fait n'importe quoi (fichier malveillant,
prompt injection, bug), il n'aura accès qu'au home du user `wa-agent`, pas au
système entier.

---

## 4. Installation sécurisée de l'agent

```bash
sudo -u wa-agent bash <<'EOF'
cd /opt/whatsapp-agent
git clone https://github.com/Eliezelg/whatsapp-dev-agent.git .
npm ci --omit=dev  # pas de deps de dev en prod
EOF

# .env hors du repo, propriété root, lisible par wa-agent
cat > /etc/whatsapp-agent.env <<EOF
GEMINI_API_KEY=...
WHATSAPP_OWNER=33612345678@s.whatsapp.net
ANTHROPIC_API_KEY=sk-ant-...
ALLOWED_PROJECT_ROOTS=/workspaces,/opt/projects
EOF

chown root:wa-agent /etc/whatsapp-agent.env
chmod 640 /etc/whatsapp-agent.env

# Permissions strictes sur auth/ (credentials WhatsApp = très sensibles)
mkdir -p /opt/whatsapp-agent/auth
chown wa-agent:wa-agent /opt/whatsapp-agent/auth
chmod 700 /opt/whatsapp-agent/auth
```

### 4.1 Première connexion (scan QR)

```bash
sudo -u wa-agent bash -c 'cd /opt/whatsapp-agent && node index.js'
# Scanne le QR code, attends "✅ WhatsApp connecté !", Ctrl+C
```

---

## 5. Systemd hardening (durci)

> **Note** : les directives `SystemCallFilter`, `MemoryDenyWriteExecute=true`
> et `RestrictRealtime=true` ont été retirées le 2026-05-06 (commit `7b5ce4c`)
> suite à un crash `V8 Fatal error: SIGSYS` : Claude Code (Bun-compiled)
> appelle `sched_setscheduler` au boot et fait du JIT mémoire (V8), ce qui
> est incompatible avec elles. Ne pas les réintroduire sans tester.
>
> Le bloc ci-dessous est désormais la copie conforme du fichier versionné
> (`whatsapp-agent.service`), lui-même aligné sur l'unité active. L'écart
> doc/prod tracké dans `TODO-ERRORS.md` (2026-07-02) est résorbé.

Copie conforme de `whatsapp-agent.service` (repo) et de l’unité active :

```ini
[Unit]
Description=WhatsApp Dev Agent (hardened)
# Auto-restart limits (anti boucle de crash) — doit être en [Unit], pas [Service].
# En [Service] systemd les ignore silencieusement : le garde-fou devient inopérant.
StartLimitIntervalSec=600
StartLimitBurst=5
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wa-agent
Group=wa-agent
# Le code vit dans app/ ; /opt/whatsapp-agent ne contient que ce sous-dossier.
# ExecStart résout index.js relativement à WorkingDirectory — sans /app le
# service ne démarre pas.
WorkingDirectory=/opt/whatsapp-agent/app
# HOME pointe le parent : c'est la racine inscriptible (ReadWritePaths) et le
# HOME du compte de service, distinct du CLAUDE_HOME du sous-processus.
Environment=HOME=/opt/whatsapp-agent
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10

# Variables d'environnement
EnvironmentFile=/etc/whatsapp-agent.env

# === Hardening systemd ===
# NoNewPrivileges + capabilities vides + ProtectSystem couvrent l'essentiel.
# On NE met PAS SystemCallFilter ni RestrictRealtime parce que Claude Code
# (Bun-compiled) appelle sched_setscheduler au boot → SIGSYS sinon.

NoNewPrivileges=true

# Filesystem
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/whatsapp-agent
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible

# Network — uniquement IPv4/IPv6 (pas de raw sockets)
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Capabilities — aucune privilégiée
CapabilityBoundingSet=
AmbientCapabilities=

# Resource limits
LimitNOFILE=4096
LimitNPROC=512
MemoryMax=2G
TasksMax=200

# Defense-in-depth (ces options ne cassent pas Claude Code)
LockPersonality=true
# Redondant avec le défaut systemd (=no), conservé explicitement : Claude Code
# fait du JIT mémoire (V8) et segfaulte si on active cette option. La ligne
# documente la décision et protège d'un durcissement applique sans la tester.
MemoryDenyWriteExecute=false
RestrictNamespaces=true
RestrictSUIDSGID=true
RemoveIPC=true

# Logs
StandardOutput=journal
StandardError=journal
SyslogIdentifier=whatsapp-agent

[Install]
WantedBy=multi-user.target
```

Active le service :

```bash
cp /opt/whatsapp-agent/whatsapp-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now whatsapp-agent
systemctl status whatsapp-agent

# Vérifier les protections actives
systemd-analyze security whatsapp-agent
# Score cible : "OK" ou "GOOD" (< 3.0)

# Vérifier qu'aucune directive n'est silencieusement ignorée (clé mal placée,
# typo) — doit ne rien afficher :
systemd-analyze verify whatsapp-agent.service
```

---

## 6. Sécurité côté WhatsApp / Baileys

### 6.1 Protection du dossier `auth/`

Le dossier `auth/` contient les **credentials de session WhatsApp** —
si quelqu'un les vole, il peut prendre le contrôle de ton WhatsApp Web.

```bash
# Permissions strictes
chmod 700 /opt/whatsapp-agent/auth
chmod 600 /opt/whatsapp-agent/auth/*

# Backup chiffré (optionnel mais recommandé)
apt install -y age
age-keygen -o ~/.age-key.txt
chmod 600 ~/.age-key.txt

# Backup quotidien chiffré
cat > /usr/local/bin/backup-wa-auth.sh <<'EOF'
#!/bin/bash
set -e
DEST="/var/backups/wa-auth"
mkdir -p "$DEST"
tar czf - -C /opt/whatsapp-agent auth/ | \
  age -r "$(grep public ~/.age-key.txt | cut -d' ' -f4)" > \
  "$DEST/auth-$(date +%Y%m%d).tar.gz.age"
# Garde 14 jours
find "$DEST" -name 'auth-*.tar.gz.age' -mtime +14 -delete
EOF
chmod 700 /usr/local/bin/backup-wa-auth.sh

# Cron quotidien
echo "0 3 * * * root /usr/local/bin/backup-wa-auth.sh" >> /etc/crontab
```

### 6.2 Whitelist JID stricte

Le code (`security.js → isAuthorizedSender`) refuse :
- ✅ Tout JID différent du `WHATSAPP_OWNER`
- ✅ Les groupes (`@g.us`) — l'agent ne répond JAMAIS dans un groupe
- ✅ Les broadcasts (`status@broadcast`)

**À vérifier régulièrement** dans `logs/audit.log` :

```bash
sudo -u wa-agent jq 'select(.event=="unauthorized_sender")' /opt/whatsapp-agent/logs/audit.log
```

Si tu vois des entrées, quelqu'un essaie de te joindre — pas de risque,
mais tu sais qu'on tente.

### 6.3 Rotation des credentials WhatsApp

Tous les **3 mois** ou après tout incident suspect :

```bash
# 1. Sur ton téléphone : WhatsApp → Paramètres → Appareils liés → Déconnecter
# 2. Sur le VPS :
systemctl stop whatsapp-agent
rm -rf /opt/whatsapp-agent/auth/*
systemctl start whatsapp-agent
# 3. Re-scanner le QR (logs systemd)
journalctl -u whatsapp-agent -f
```

### 6.4 Risques Baileys (WhatsApp non-officiel)

Baileys utilise l'API WhatsApp Web non officielle. Risques :

| Risque | Probabilité | Mitigation |
|--------|-------------|------------|
| Ban du compte WhatsApp | Faible si usage perso | N'utiliser que pour soi, pas de spam |
| Breaking change API WhatsApp | Moyenne | Pin la version Baileys, surveiller GitHub |
| Vol des creds `auth/` | Faible (chmod 700) | Backups chiffrés, rotation périodique |
| Détection bot par WhatsApp | Faible | Latence réaliste, pas de mass send |

**Compte de test recommandé** : crée un numéro WhatsApp dédié à l'agent
(eSIM, numéro virtuel) plutôt que ton numéro personnel.

---

## 7. Sécurité Claude Code CLI

Claude Code tourne avec `--dangerously-skip-permissions` — il a tous les
droits du user `wa-agent` dans le workspace.

### 7.1 Cloisonnement par projet

Tous les projets doivent être dans **une racine autorisée** définie par
`ALLOWED_PROJECT_ROOTS`. L'agent **refuse** :

```
/etc/*           → BLOQUÉ
/root/*          → BLOQUÉ
~/.ssh/*         → BLOQUÉ
/var/log/*       → BLOQUÉ
chemins relatifs → BLOQUÉ
chemins avec ..  → BLOQUÉ
```

### 7.2 Détection de prompts dangereux

Le module `security.js` détecte et bloque automatiquement :

- `rm -rf /`, `rm -rf ~`
- Formatage de disque (`mkfs`, `dd if=/dev/zero of=/dev/...`)
- Fork bombs
- Lecture de secrets (`cat /etc/passwd`, `.env`, clés SSH)
- Pipe to shell (`curl ... | bash`)
- Modification utilisateurs (`passwd`, `usermod`)
- Désactivation firewall (`ufw disable`)
- Tunnels publics (`ngrok`, `cloudflared`)

Si Gemini Flash propose une de ces actions, l'agent répond **🚫 Action
bloquée** sans exécuter.

### 7.3 Whitelist des env vars + apiKeyHelper (prod)

`runner.js` ne passe à Claude Code que :

- `PATH` (whitelist `/usr/local/bin:/usr/bin:/bin`)
- `HOME` (CLAUDE_HOME isolé, défaut `<projet>/.claude-runtime-home`)
- `USER` (`wa-agent`)
- `ANTHROPIC_API_KEY` **uniquement si `CLAUDE_API_KEY_HELPER` n'est pas défini**

**Pas** de `GEMINI_API_KEY`, `WHATSAPP_OWNER`, autres secrets.

**Recommandation prod : utiliser apiKeyHelper.**

Avec `ANTHROPIC_API_KEY` en env, un attaquant via prompt injection peut faire
imprimer la clé via `process.env.ANTHROPIC_API_KEY` ou base64-encoder et
contourner `redactSecrets`. Avec apiKeyHelper, la clé n'est **pas** dans
`process.env` du process Claude Code — elle est lue par un script externe à
la demande.

```bash
# 1. Stocker la clé dans un fichier chmod 600
echo "sk-ant-..." > /opt/whatsapp-agent/.anthropic-key
chown wa-agent:wa-agent /opt/whatsapp-agent/.anthropic-key
chmod 600 /opt/whatsapp-agent/.anthropic-key

# 2. Activer le helper dans /etc/whatsapp-agent.env
echo 'CLAUDE_API_KEY_HELPER=/opt/whatsapp-agent/scripts/anthropic-key-helper.sh' \
  >> /etc/whatsapp-agent.env

# 3. Retirer ANTHROPIC_API_KEY de /etc/whatsapp-agent.env (plus nécessaire)
#    Le runner détecte CLAUDE_API_KEY_HELPER et NE la passe pas en env.

# 4. Permissions sur le helper
chmod 750 /opt/whatsapp-agent/scripts/anthropic-key-helper.sh
chown root:wa-agent /opt/whatsapp-agent/scripts/anthropic-key-helper.sh

# 5. Restart
systemctl restart whatsapp-agent
```

`runner.js` génère automatiquement `<CLAUDE_HOME>/.claude/settings.json` au
boot avec `apiKeyHelper` configuré. Claude Code lira la clé via ce script
à chaque appel API.

### 7.4 Limites runtime

| Limite | Valeur | Code |
|--------|--------|------|
| Timeout exécution | 30 min | `runner.js → MAX_TIMEOUT_MS` |
| Output max | 10 Mo | `runner.js → MAX_OUTPUT_BYTES` |
| RAM max process | 2 Go | systemd `MemoryMax=2G` |
| Exécutions/heure | 20 | `security.js → RATE_LIMITS` |
| Exécutions/jour | 100 | idem |
| Messages/min | 30 | idem |

---

### 7.5 Exposition réseau — canal API mobile (port 5111) et Tailscale

`notify-server.js` bind sur `127.0.0.1:5111` en local, mais **ce port est
déjà exposé sur le tailnet Tailscale en prod** (`tailscale status` montre
`100.94.195.126:5111 LISTEN`) — ce n'est pas une exposition "prévue pour
plus tard" comme le laissaient penser les commentaires historiques du code,
c'est actif dès aujourd'hui, dès qu'un device rejoint le tailnet.

Ce que ça implique concrètement :

- **Le canal API (`channels/api.js`) a `autoConfirm: true`** — contrairement
  au canal WhatsApp, une requête `POST /api/dispatch` valide (bon token)
  déclenche l'exécution Claude Code **sans étape de confirmation "oui"**.
- La seule barrière est le token `API_TOKEN` (Bearer). Depuis le
  2026-07-19, la comparaison est en temps constant
  (`auth-utils.js:safeTokenEqual`, voir git log) — avant cette date, une
  comparaison `!==` classique était théoriquement vulnérable à une timing
  attack réseau.
- Aujourd'hui (état constaté), 2 devices sont sur le tailnet (le VPS + un
  Android hors-ligne). La fenêtre d'exploitation réelle est faible, mais
  **grandit avec chaque device ajouté au tailnet** — un device compromis ou
  mal configuré sur le tailnet pourrait atteindre ce port.

**Recommandations non appliquées (à ta discrétion, pas critiques vu le
nombre de devices actuel)** :

- Restreindre l'accès au port 5111 via les **ACLs Tailscale** (console
  Tailscale → Access controls) pour que seuls les devices explicitement
  autorisés (ton téléphone, pas tout le tailnet) puissent l'atteindre.
- Envisager de retirer `autoConfirm` du canal API si l'app mobile n'est pas
  encore activement utilisée, ou d'ajouter une seconde barrière (liste
  stricte de `senderId` autorisés, pas seulement le token).

Voir aussi la section "12.2 Si l'agent fait n'importe quoi" pour la marche à
suivre en cas de doute sur ce canal.

### 7.6 Autofix Sentry (`sentry-watch`) — autonomie assumée jusqu'au push

`scripts/sentry-watch.js` (timer systemd, poll toutes les 5 min) dispatch
automatiquement les nouvelles issues Sentry vers le pipeline `/api/dispatch`
(donc via le canal API `autoConfirm` décrit ci-dessus) avec pour instruction
d'aller **jusqu'au `git commit` + `git push`** si Claude Code juge le fix
sûr — sans confirmation humaine.

**C'est un choix de design assumé**, pas un oubli : l'objectif est un
autofix vraiment autonome 24/7. Le risque principal est l'injection
indirecte — les champs Sentry (`title`, `culprit`, message d'exception)
peuvent contenir des données saisies par un utilisateur final de l'app (un
champ de formulaire mal validé qui finit dans une stacktrace), qui sont
injectées telles quelles dans le prompt envoyé à Claude Code.

Mitigations en place (depuis le 2026-07-19, voir git log) :

- `sanitizeUntrustedField()` neutralise les tournures d'injection de prompt
  connues (`ignore/disregard/forget` + instructions, faux marqueurs
  `system:`/`assistant:`, tentatives de casser la délimitation du bloc).
- Le bloc de données Sentry est explicitement délimité dans le prompt
  (`--- DONNÉES SENTRY (non fiables) ---` / `--- FIN DONNÉES SENTRY ---`)
  avec une consigne claire de ne pas traiter son contenu comme des
  instructions.
- `detectDangerousPrompt` (section 7.2) s'applique sur ce prompt comme sur
  n'importe quel autre — filet de dernière ligne, contournable en théorie
  (voir limite en 7.2), pas une garantie absolue.
- Chaque dispatch autonome est loggé explicitement (`AUTOFIX AUTONOME` dans
  journalctl) et notifié sur WhatsApp avec la mention "autonome, sans
  confirmation" — traçabilité, pas prévention.

Si tu veux revenir sur ce choix : la modification à faire est de retirer
`autoConfirm` du canal API pour les dispatches provenant de `sentry-watch`
spécifiquement (nécessite de distinguer ce sender dans le dispatcher), ou
plus simplement de désactiver `sentry-watch.timer` et de traiter les issues
Sentry manuellement via WhatsApp.

---

## 8. Sanitization des outputs

Avant d'envoyer un message à WhatsApp, `redactSecrets()` remplace par
`[REDACTED]` :

- Clés API Anthropic (`sk-ant-...`)
- Clés API OpenAI (`sk-...`)
- Clés Google (`AIza...`)
- Tokens GitHub (`ghp_...`, `ghs_...`)
- AWS access keys
- JWT tokens
- Lignes `password=`, `secret=`, `token=`, `api_key=`

Cela empêche un `cat .env` accidentel de leaker tes credentials sur WhatsApp.

---

## 9. Audit log

Toutes les actions sont loguées dans `/opt/whatsapp-agent/logs/audit.log`
au format JSONL :

```jsonl
{"ts":"2026-05-04T14:23:00Z","event":"message_received","length":42}
{"ts":"2026-05-04T14:23:01Z","event":"exec_pending","project":"tzedakal"}
{"ts":"2026-05-04T14:23:05Z","event":"exec_start","project":"tzedakal","path":"/workspaces/tzedakal"}
{"ts":"2026-05-04T14:35:12Z","event":"exec_end","project":"tzedakal","durationMs":727000,"ok":true}
```

### 9.1 Events à surveiller

```bash
# Events critiques
jq 'select(.event | test("blocked|unauthorized|rate_limit"))' /opt/whatsapp-agent/logs/audit.log

# Stats du jour
jq -s 'group_by(.event) | map({event: .[0].event, count: length})' \
  /opt/whatsapp-agent/logs/audit.log
```

### 9.2 Rotation des logs

```bash
cat > /etc/logrotate.d/whatsapp-agent <<'EOF'
/opt/whatsapp-agent/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0600 wa-agent wa-agent
}
EOF
```

---

## 10. Monitoring et alertes

### 10.1 Healthcheck systemd

```bash
# Watcher : si le service crash plus de 5 fois en 10 min, alerte
mkdir -p /etc/systemd/system/whatsapp-agent.service.d
cat > /etc/systemd/system/whatsapp-agent.service.d/override.conf <<'EOF'
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Restart=always
RestartSec=10
EOF

systemctl daemon-reload
```

### 10.2 Alertes par email (optionnel)

```bash
apt install -y postfix mailutils
# Configure postfix en mode "Internet site" → smtp.example.com

# Alert si service down > 5 min
cat > /usr/local/bin/check-wa-agent.sh <<'EOF'
#!/bin/bash
if ! systemctl is-active --quiet whatsapp-agent; then
  echo "WhatsApp agent DOWN sur $(hostname) à $(date)" | \
    mail -s "[ALERT] WA agent down" ton-email@example.com
fi
EOF
chmod 700 /usr/local/bin/check-wa-agent.sh
echo "*/5 * * * * root /usr/local/bin/check-wa-agent.sh" >> /etc/crontab
```

### 10.3 Audit hebdomadaire

```bash
cat > /usr/local/bin/weekly-audit.sh <<'EOF'
#!/bin/bash
{
  echo "=== Failed SSH (7 derniers jours) ==="
  journalctl --since="7 days ago" -u ssh | grep -i "failed\|invalid" | wc -l

  echo ""
  echo "=== fail2ban bans ==="
  fail2ban-client status sshd

  echo ""
  echo "=== WA agent : events bloqués ==="
  jq -r 'select(.event | test("blocked|unauthorized|rate_limit")) | "\(.ts) \(.event) \(.reason // "")"' \
    /opt/whatsapp-agent/logs/audit.log | tail -50

  echo ""
  echo "=== Mises à jour disponibles ==="
  apt list --upgradable 2>/dev/null | head -20

  echo ""
  echo "=== Espace disque ==="
  df -h /
} | mail -s "[VPS Audit] $(hostname) $(date +%Y-%m-%d)" ton-email@example.com
EOF
chmod 700 /usr/local/bin/weekly-audit.sh
echo "0 8 * * 1 root /usr/local/bin/weekly-audit.sh" >> /etc/crontab
```

---

## 11. Backups chiffrés hors-site

```bash
# Install restic + rclone
apt install -y restic rclone

# Configure rclone vers Cloudflare R2 / Backblaze B2 / S3
rclone config

# Init le repo restic
export RESTIC_REPOSITORY="rclone:r2-backups:vps-tzedakal"
export RESTIC_PASSWORD="$(openssl rand -hex 32)"
echo "RESTIC_PASSWORD=$RESTIC_PASSWORD" >> /root/secrets.txt
chmod 600 /root/secrets.txt
restic init

# Script backup quotidien
cat > /usr/local/bin/backup-vps.sh <<'EOF'
#!/bin/bash
set -e
export RESTIC_REPOSITORY="rclone:r2-backups:vps-tzedakal"
export RESTIC_PASSWORD_FILE=/root/.restic-pwd

restic backup \
  /opt/whatsapp-agent/auth \
  /opt/whatsapp-agent/logs \
  /etc/whatsapp-agent.env \
  /etc/asterisk \
  /etc/wireguard \
  --tag daily

# Garde 7 daily, 4 weekly, 12 monthly
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
EOF

echo "$RESTIC_PASSWORD" > /root/.restic-pwd
chmod 600 /root/.restic-pwd
chmod 700 /usr/local/bin/backup-vps.sh

echo "0 4 * * * root /usr/local/bin/backup-vps.sh" >> /etc/crontab
```

---

## 12. Plan de réponse aux incidents

### 12.1 Si tu suspectes un compromis

```bash
# 1. Couper tout
systemctl stop whatsapp-agent asterisk

# 2. Couper SSH externe (sauf depuis IP de confiance)
ufw delete allow 2222/tcp
ufw allow from <TON_IP> to any port 2222

# 3. Snapshot Hetzner avant investigation
# (via console Hetzner Cloud)

# 4. Audit
last -a | head -50              # connexions récentes
journalctl --since="24 hours ago" -u ssh | grep -i "accepted\|invalid"
ps auxf                          # process tree
ss -tunap                        # connexions actives
find / -mtime -1 -type f 2>/dev/null | grep -v /proc | grep -v /sys

# 5. Si compromis confirmé :
# - Restaure depuis snapshot Hetzner ou backup restic
# - Régénère TOUTES les clés (SSH, ARI, WireGuard, API keys)
# - Déconnecte WhatsApp depuis le téléphone (Paramètres → Appareils liés)
# - Révoke clés API Anthropic + Gemini
```

### 12.2 Si l'agent fait n'importe quoi (prompt injection)

```bash
# Stop immédiat
systemctl stop whatsapp-agent

# Inspecte les derniers commits dans les workspaces
for proj in /workspaces/*; do
  echo "=== $proj ==="
  cd "$proj" && git log --since="1 hour ago" --oneline
done

# Rollback si nécessaire
cd /workspaces/<projet>
git reflog
git reset --hard <commit-stable>

# Ajoute le pattern fautif à security.js → DANGEROUS_PATTERNS
# Redéploie l'agent
```

---

## 13. Checklist finale (à imprimer / cocher)

### Avant de mettre en production

- [ ] Hetzner Cloud Firewall actif + 2FA compte
- [ ] SSH : port custom, key-only, no root login direct, fail2ban
- [ ] UFW : default deny, seul SSH ouvert (+ Asterisk si applicable)
- [ ] Auto-updates sécurité actifs
- [ ] User `wa-agent` créé, pas root
- [ ] `.env` : chmod 640, owner `root:wa-agent`
- [ ] `auth/` : chmod 700, owner `wa-agent:wa-agent`
- [ ] Systemd hardened (`systemd-analyze security whatsapp-agent` < 3.0)
- [ ] Logs : audit.log + rotation configurée
- [ ] Backups chiffrés vers R2/B2 quotidiens
- [ ] Numéro WhatsApp dédié à l'agent (pas perso)
- [ ] Test : envoi message depuis numéro NON whitelisté → ignoré
- [ ] Test : prompt `rm -rf /` → bloqué
- [ ] Test : projet hors `ALLOWED_PROJECT_ROOTS` → refusé
- [ ] Test : `cat .env` dans output → secrets redacted
- [ ] Audit hebdo configuré (cron + email)

### Mensuel

- [ ] Vérifier `apt list --upgradable` et appliquer les CVE
- [ ] Vérifier `fail2ban-client status` (bans actifs ?)
- [ ] Vérifier `journalctl -u whatsapp-agent --since="1 month ago" | grep ERROR`
- [ ] Vérifier que les backups restic sont OK (`restic snapshots`)
- [ ] Lire les events `blocked|unauthorized` du mois

### Trimestriel

- [ ] Rotation des credentials WhatsApp (re-scan QR)
- [ ] Rotation API keys (Anthropic, Gemini)
- [ ] Test de restauration backup restic (sur un VPS de test)
- [ ] Review du code `security.js` — patterns à ajouter ?

---

## 14. Ressources

- [Hetzner Cloud Firewall](https://docs.hetzner.com/cloud/firewalls/overview/)
- [systemd security analyzer](https://www.freedesktop.org/software/systemd/man/systemd-analyze.html#security%20%5BUNIT...%5D)
- [Mozilla SSH guidelines](https://infosec.mozilla.org/guidelines/openssh)
- [CIS Ubuntu 24.04 Benchmark](https://www.cisecurity.org/benchmark/ubuntu_linux)
- [Baileys security best practices](https://github.com/WhiskeySockets/Baileys#security)
