# WhatsApp Dev Agent

Pilote Claude Code CLI depuis WhatsApp via un agent Gemini Flash conversationnel.

```
Toi (WhatsApp)
    ↓
Gemini Flash (comprend, pose des questions, demande confirmation)
    ↓  (après ton "ok")
Claude Code CLI (exécute dans le dossier du projet)
    ↓
Updates toutes les 60s + résultat final → WhatsApp
```

## Fonctionnalités

- **Conversation multi-turns** — Gemini Flash comprend ta demande, pose des questions si besoin
- **Confirmation avant exécution** — résumé de ce qui va être fait, tu approuves avec "ok"
- **Updates en temps réel** — toutes les 60 secondes pendant l'exécution
- **Multi-projets** — `/projets`, `/default <nom>`, `/add <nom> <path>`
- **Sécurité** — whitelist sur ton numéro uniquement

## Prérequis

- Node.js 22+
- Claude Code CLI installé globalement : `npm install -g @anthropic-ai/claude-code`
- Clé API Google Gemini (gratuite sur [Google AI Studio](https://aistudio.google.com/))

## Installation

```bash
git clone https://github.com/Eliezelg/whatsapp-dev-agent.git
cd whatsapp-dev-agent
npm install
cp .env.example .env
```

Remplis `.env` :

```env
GEMINI_API_KEY=ta_clé_gemini
WHATSAPP_OWNER=33612345678@s.whatsapp.net
```

> Format `WHATSAPP_OWNER` : indicatif international sans `+`, suivi de `@s.whatsapp.net`
> Ex : France `33612345678@s.whatsapp.net` · Israël `972501234567@s.whatsapp.net`

Configure tes projets dans `projects.json` :

```json
{
  "default": "monprojet",
  "projects": {
    "monprojet": {
      "path": "/workspaces/monprojet",
      "description": "Next.js 15 + NestJS"
    }
  }
}
```

## Lancement

```bash
npm start
```

Un QR code s'affiche dans le terminal. Scanne-le avec WhatsApp :
**Paramètres → Appareils liés → Lier un appareil**

## Utilisation

Envoie n'importe quel message en langage naturel :

```
"Ajoute la pagination sur la liste des utilisateurs"
```

L'agent Gemini comprend, te résume ce qu'il va faire, et attend ton accord :

```
📋 Voici ce que je vais faire :
Ajouter la pagination (10 éléments/page) sur UserList.tsx
avec React Query pour le fetching côté client.

📁 Projet : monprojet
📂 Chemin : /workspaces/monprojet

Confirme avec ok / oui / go, ou dis-moi ce que tu veux changer.
```

Tu réponds `ok` → Claude Code se lance → updates toutes les 60s → résultat final.

### Commandes

| Commande | Description |
|----------|-------------|
| `/projets` | Liste les projets configurés |
| `/default <nom>` | Changer le projet par défaut |
| `/add <nom> <path>` | Ajouter un projet |
| `/reset` | Réinitialiser la conversation |
| `/help` | Aide |

### Mots de confirmation

`ok` · `oui` · `go` · `yes` · `validé` · `confirme` · `lance` · `c'est bon` · `כן`

### Mots d'annulation

`non` · `no` · `annule` · `cancel` · `stop` · `attends`

---

## Installation sur VPS (Ubuntu 24.04)

Recommandé : **Hetzner CX32** — 4 vCPU, 8 Go RAM, 80 Go SSD, ~9€/mois.

### 1. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v  # doit afficher v22.x.x
```

### 2. Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Authentifie Claude Code avec ta clé Anthropic :

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# Ajoute dans ~/.bashrc pour la persistance
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
```

### 3. Cloner et installer l'agent

```bash
git clone https://github.com/Eliezelg/whatsapp-dev-agent.git /opt/whatsapp-agent
cd /opt/whatsapp-agent
npm install
cp .env.example .env
nano .env  # remplir GEMINI_API_KEY et WHATSAPP_OWNER
```

Configure tes projets dans `projects.json` avec les vrais chemins Linux.

### 4. Scanner le QR code (première fois)

```bash
cd /opt/whatsapp-agent
npm start
# → QR code dans le terminal, scanne avec WhatsApp
# → Ctrl+C après la connexion réussie
```

Les credentials WhatsApp sont sauvegardés dans `./auth/` — pas besoin de rescanner.

### 5. Systemd service (démarrage automatique)

```bash
cp whatsapp-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now whatsapp-agent
systemctl status whatsapp-agent
```

### 6. Vérification

```bash
journalctl -u whatsapp-agent -f
# Doit afficher : ✅ WhatsApp connecté !
```

Envoie `/help` depuis WhatsApp → tu dois recevoir la liste des commandes.

---

## 🔒 Sécurité

**Lis [SECURITY.md](./SECURITY.md) avant la mise en production.**

L'agent intègre par défaut :

| Couche | Protection |
|--------|-----------|
| **Whitelist JID stricte** | Seul `WHATSAPP_OWNER` peut interagir. Groupes et broadcasts refusés. |
| **Rate limiting** | 30 msg/min, 20 exécutions Claude Code/heure, 100/jour |
| **Validation chemins** | `ALLOWED_PROJECT_ROOTS` — refus de `/etc`, `/root`, `~/.ssh`, `..`, etc. |
| **Détection prompts dangereux** | `rm -rf /`, fork bomb, lecture `.env`/`/etc/passwd`, `chmod 777`, désactivation firewall, tunnels publics |
| **Sandbox env** | Claude Code ne reçoit que `PATH`, `HOME`, `USER`, `ANTHROPIC_API_KEY` |
| **Output sanitization** | Secrets (`sk-ant-*`, `AIza*`, JWT, `password=...`) remplacés par `[REDACTED]` avant envoi WhatsApp |
| **Limits runtime** | timeout 30 min, output max 10 Mo, RAM max 2 Go (systemd) |
| **Audit log JSONL** | Toutes les actions tracées dans `logs/audit.log` |
| **Systemd hardened** | User dédié non-root, `ProtectSystem=strict`, capabilities vides, syscall filter |

Hardening complet du VPS (UFW, fail2ban, SSH key-only, sysctl, backups
chiffrés, monitoring) → voir [SECURITY.md](./SECURITY.md).

---

## Coexistence avec Asterisk (VPS TzedaKal)

Si le VPS fait tourner Asterisk (voir `docs/asterisk-migration/`), l'agent
tourne en parallèle sans conflit : Asterisk utilise les ports 5060/UDP et
8088/TCP (bind WireGuard), l'agent Node.js n'utilise aucun port réseau
(Baileys sort en HTTPS sortant uniquement).

Ressources typiques avec les deux en parallèle :

| Service | RAM | CPU idle |
|---------|-----|----------|
| Asterisk | ~150 Mo | < 1% |
| whatsapp-agent (Node.js) | ~150 Mo | < 1% |
| Claude Code CLI (session active) | 1-2 Go | 2-4 cœurs (pic) |
| **Total sans session active** | ~400 Mo | < 2% |
| **Total avec 1 session Claude Code** | ~2 Go | variable |

Le CX32 (8 Go) gère les deux confortablement.

---

## Structure du projet

```
whatsapp-agent/
├── index.js                    # Entry point : Baileys + routing messages
├── agent.js                    # Gemini Flash + mémoire conversation
├── runner.js                   # Claude Code CLI + streaming + updates 60s
├── projects.js                 # Gestion multi-projets (CRUD projects.json)
├── projects.json               # Config des projets (à modifier)
├── whatsapp-agent.service      # Systemd unit pour VPS
├── .env.example                # Template variables d'environnement
└── package.json
```

## Variables d'environnement

| Variable | Obligatoire | Description |
|----------|-------------|-------------|
| `GEMINI_API_KEY` | ✅ | Clé API Google Gemini |
| `WHATSAPP_OWNER` | ✅ | JID WhatsApp autorisé (format : `33612345678@s.whatsapp.net`) |

## Licence

MIT
