# App mobile Android — whatsapp-agent

## Contexte

`channels/api.js` (squelette non branché, livré lors d'une itération
précédente) expose déjà un contrat minimal `handleApiDispatch` : token
Bearer + dispatch d'un message vers un projet. Ce document étend ce
squelette en une petite API REST complète, et spécifie l'app Android qui la
consomme — vue multi-sessions (liste des projets + état d'exécution) avec
possibilité d'ouvrir de nouvelles conversations, discutée avec l'utilisateur
en complément du spec observabilité/alerting (2026-07-01).

## Objectif

Une app Android qui permet de :
1. Voir la liste des projets configurés et leur état (session active ou non)
2. Ouvrir une nouvelle conversation sur un projet (comme WhatsApp aujourd'hui :
   message → confirmation → exécution)
3. Voir l'historique de conversation par projet
4. Suivre l'avancement d'une exécution en cours, uniquement quand l'écran de
   ce projet est ouvert (pas de polling permanent en arrière-plan)

## Décisions de conception explicites

- **Historique partagé par projet entre canaux** : WhatsApp et mobile
  partagent le même `Agent` (donc le même historique de conversation) par
  projet. Une action proposée sur WhatsApp peut être confirmée depuis
  mobile et vice-versa. Choix délibéré, différent du canal email (qui avait
  un `Agent` dédié) — ici l'utilisateur veut explicitement voir "toutes les
  sessions en cours" depuis l'app, donc la vue doit refléter l'état réel
  partagé, pas une vue isolée.
- **Auth par token statique**, cohérent avec `NOTIFY_TOKEN` existant — pas de
  système de login/mot de passe. Nouveau `API_TOKEN` distinct de
  `NOTIFY_TOKEN` (surface différente : `NOTIFY_TOKEN` est pour des services
  internes du VPS type familink-agent, `API_TOKEN` est pour un client externe
  sur le réseau mobile de l'utilisateur).
- **Polling scopé, pas de websocket** : l'app interroge l'état d'exécution
  uniquement quand l'écran de détail d'un projet est affiché à l'écran, pas
  en tâche de fond permanente. Économise batterie/requêtes, reste simple à
  implémenter des deux côtés.
- **Android uniquement pour cette version**, via React Native/Expo (cohérent
  avec la stack JS/TS du reste des projets de l'utilisateur — Familink en
  Next.js, whatsapp-agent en Node.js).

## Architecture serveur

Extension de `channels/api.js` (déjà existant, testé, non branché) en 4
routes, toutes protégées par le même token Bearer statique. Câblées dans
`notify-server.js` à côté des routes `/notify` et (si le spec précédent est
implémenté) `/webhook/email` — même serveur HTTP `127.0.0.1:5111`.

⚠️ **Point d'attention réseau, déjà rencontré sur ce VPS** : comme pour le
canal email écarté précédemment, ce serveur n'écoute qu'en local
(`127.0.0.1`). Pour qu'une app mobile sur le réseau cellulaire de
l'utilisateur puisse l'atteindre, il faut une exposition publique — UFW
n'autorise aujourd'hui le port 443 que depuis l'IP Railway, et aucun
vhost/DNS n'existe pour ce service. **Ce point doit être retravaillé avant
implémentation** (contrairement à l'email, l'app mobile a besoin d'un accès
sortant réel — pas de contournement possible via un service tiers comme
Railway/Resend qui a déjà un accès autorisé). Options à trancher dans le
plan d'implémentation :
  a) Nouveau sous-domaine dédié + vhost Caddy + règle UFW ouverte sur ce port
     uniquement (pas tout 443)
  b) VPN (ex: Tailscale) entre le téléphone et le VPS — pas d'exposition
     publique du tout, mais nécessite d'installer un client VPN sur le
     téléphone
  c) Tunnel via un service déjà exposé (ex: passer par l'API Familink sur
     Railway comme relais, similaire à l'option écartée pour l'email)

### Routes

**`GET /api/projects`**
Liste les projets (`projects.js:listProjects()`), enrichie de l'état
d'exécution :
```json
[
  { "name": "tzedakal", "description": "...", "isDefault": false, "active": false },
  { "name": "familink", "description": "...", "isDefault": true, "active": true }
]
```
`active` = `activeSessions.has(project.name)` (le même `Set` déjà partagé
entre canaux depuis le refactor du dispatcher).

**`GET /api/history/:project`**
Retourne l'historique de conversation du projet. Nécessite d'exposer
`Agent.history` (actuellement propriété privée d'instance, un seul `Agent`
par canal aujourd'hui — voir Composant 1 ci-dessous pour le changement
requis afin de passer à un `Agent` par projet, partagé entre canaux).
```json
{ "project": "familink", "history": [{ "role": "user", "text": "..." }, { "role": "model", "text": "..." }] }
```

**`POST /api/dispatch`**
Contrat étendu par rapport au squelette existant : `{ message, senderId, project }`
— `project` devient **obligatoire** (contrairement au flow WhatsApp où
Gemini détermine le projet à partir du texte libre). L'app mobile connaît
déjà le projet ciblé puisque l'utilisateur a tapé depuis l'écran de
conversation de ce projet précis — pas besoin de faire deviner le projet
par Gemini comme sur WhatsApp. Nécessaire de toute façon avec le Composant 1
(Agent par projet) : le serveur doit savoir quel `Agent` utiliser sans
ambiguïté.

**`GET /api/status/:project`**
```json
{ "project": "familink", "active": true, "lastUpdate": "⏳ En cours...\n<preview>" }
```
Pollé par l'app uniquement quand l'écran de détail du projet est ouvert
(intervalle proposé : 3-5s, aligné sur la cadence des updates de
`runner.js` qui sont eux-mêmes toutes les 60s — donc le polling n'a de
valeur ajoutée que pour capter le `lastUpdate` dès qu'il change, pas pour
un vrai temps réel).

## Composant 1 : passage d'un Agent par canal à un Agent par projet

**Changement structurel nécessaire**, plus profond que les specs précédentes.
Aujourd'hui `index.js` crée un seul `Agent` pour tout WhatsApp (tous
projets confondus, un seul historique global). Pour que "voir toutes les
sessions en cours par projet" ait un sens, et pour partager l'historique
entre WhatsApp et mobile *par projet*, il faut :

- Une `Map<projectName, Agent>` au lieu d'un `Agent` unique, créée à la
  demande (lazy) quand un projet est utilisé pour la première fois.
- `core/dispatcher.js` doit résoudre quel `Agent` utiliser selon le projet
  cible de la conversation en cours — aujourd'hui `agent.pendingExecution`
  suppose un seul agent par dispatcher. Ceci change le contrat de
  `createDispatcher()` : `agent` devient soit une factory
  `getAgentForProject(project)`, soit le dispatcher accepte un `project`
  explicite en paramètre de `handleMessage()`.

C'est un changement d'architecture non trivial qui touche le cœur du
dispatcher déjà en prod — **à isoler dans une tâche dédiée du plan
d'implémentation**, avec ses propres tests de non-régression avant de
toucher aux routes API elles-mêmes.

## Composant 2 : câblage des routes dans `notify-server.js`

Suivre le pattern déjà en place pour `/notify` et (si applicable)
`/webhook/email` : ajout de branches `if (req.method === 'GET' && req.url === '/api/projects')` etc. dans le `createServer()` existant, toutes vérifiant
`Authorization: Bearer ${API_TOKEN}` avant tout traitement.

## Composant 3 : app React Native / Expo

**Écrans** :
- **Liste des projets** (écran d'accueil) : nom, description, badge "actif"
  si `active: true`. Pull-to-refresh sur `GET /api/projects`. Tap sur un
  projet → écran conversation.
- **Conversation** : historique (`GET /api/history/:project` au chargement),
  champ de saisie en bas (`POST /api/dispatch`), badge d'état en cours si
  `active: true` avec polling actif sur `GET /api/status/:project` tant que
  l'écran est au premier plan (arrêt du polling si l'app passe en
  arrière-plan ou si l'utilisateur quitte l'écran).

**Config initiale** : URL du serveur + token, saisis une fois, stockés via
`expo-secure-store` (Android Keystore).

**Stack** : Expo (managed workflow pour simplifier le build/déploiement),
TypeScript, pas de state management lourd nécessaire vu la simplicité (state
local + fetch, pas de Redux/Zustand).

## Tests

- Routes API : tests `node --test` sur le pattern déjà établi
  (`channels/api.js`, injection de dépendances) — `GET /api/projects` avec
  `activeSessions` mocké, `GET /api/history/:project` avec un `Agent` mocké
  exposant un historique, auth Bearer sur les 4 routes.
- Composant 1 (Agent par projet) : tests dédiés sur `core/dispatcher.js`
  vérifiant qu'une conversation démarrée sur le projet A n'affecte pas
  l'historique du projet B, et qu'un même projet partage bien son historique
  entre deux appels `handleMessage` avec des `channel` différents (simulant
  WhatsApp vs mobile).
- App mobile : hors scope des tests automatisés de ce repo (projet React
  Native séparé) — vérification manuelle documentée dans le plan
  d'implémentation.

## Risques et points ouverts

- **Exposition réseau non résolue** (voir encadré ci-dessus) — bloquant pour
  l'implémentation tant qu'une option (a/b/c) n'est pas tranchée avec
  l'utilisateur. Ne pas commencer le développement de l'app avant ce point.
- **Changement de contrat du dispatcher** (Composant 1) touche du code en
  prod déjà utilisé quotidiennement par WhatsApp — nécessite la même
  rigueur de non-régression que le refactor précédent (tests avant/après,
  vérification manuelle WhatsApp après déploiement).
- **`Agent.history` actuellement privé** : `agent.js` ne l'expose pas
  aujourd'hui en lecture externe — ajout d'un getter à prévoir, changement
  mineur mais à faire consciemment (pas juste accéder à la propriété privée
  par convention JS, qui n'est pas réellement privée en l'absence de `#`).
