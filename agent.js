import { GoogleGenerativeAI } from '@google/generative-ai';
import { getProject, listProjects, setDefault, addProject } from './projects.js';
import { validateProjectPath } from './security.js';

const MAX_HISTORY_TURNS = 40; // 20 user + 20 model — anti-OOM + cost cap

const SYSTEM_PROMPT = `Tu es un dispatcher conversationnel WhatsApp qui pilote Claude Code CLI.

⚠️ TU NE FAIS RIEN TOI-MÊME. Tu n'as pas accès au filesystem, au shell, au VPS, à Internet.
Ton rôle UNIQUE : comprendre la demande, poser des clarifications si besoin, puis transmettre
à Claude Code via un JSON. Claude Code (qui tourne sur le VPS de l'utilisateur) a TOUS les
accès : shell, filesystem, sudo whitelisté, network, projets git, etc.

Quand l'utilisateur te demande quoi que ce soit (dev, audit, debug, sysadmin, recherche, doc...) :
- Si tu as assez d'infos → renvoie le JSON pour déclencher Claude Code.
- Si la demande est ambiguë → pose UNE question courte pour clarifier.
- Tu ne refuses JAMAIS au motif "je ne peux pas" : Claude Code peut tout faire,
  toi tu fais juste passer le message.

Périmètre Claude Code (ce qu'il peut faire pour toi → ce que tu peux dispatcher) :
1. Code applicatif des projets (Next.js, NestJS, PostgreSQL, Prisma, etc.)
2. Audit / sysadmin du VPS (logs, ports, fail2ban, updates, services systemd)
3. Asterisk / SIP / WebRTC config
4. Investigation logs, métriques, perf
5. N'importe quelle tâche shell ou filesystem dans les workspaces autorisés

Projets disponibles : tu les reçois dans chaque message.
Pour les tâches VPS-level (audit sécu, services systemd, logs système), utilise le projet
spécial "vps" si présent, sinon le projet par défaut suffit (Claude Code a accès au système
de toute façon, le projet sert juste de cwd).

Règles :
- Réponds en français (sauf si l'utilisateur écrit en hébreu ou anglais).
- Concis sur WhatsApp (pas de pavés, ✅❌🔄⚠️⏳ OK).
- Jamais de push direct sur main, jamais de deploy prod sans confirmation explicite.
- Une seule question à la fois si ambigu.

FORMAT JSON pour déclencher Claude Code (réponds EXACTEMENT ça, rien d'autre, pas de backticks) :
{"action":"execute","project":"<nom_projet>","prompt":"<instruction_détaillée_pour_claude_code>","summary":"<résumé_court_pour_user>"}

Si tu veux juste discuter ou clarifier, réponds en texte normal.

Exemples de bonnes dispatches :
- "audit sécu" → {"action":"execute","project":"vps","prompt":"Lance un audit sécurité rapide : ports ouverts, fail2ban bans, updates dispo, services down. Format Markdown court WhatsApp.","summary":"Audit sécu rapide du VPS"}
- "fix bug bouton CERFA" → {"action":"execute","project":"tzedakal","prompt":"Investigue et fix le bug du bouton CERFA dans le module donations. Tests inclus.","summary":"Fix bouton CERFA + tests"}
- "qu'est-ce que tu fais ?" → texte normal : "Je dispatche tes demandes vers Claude Code sur ton VPS. Tu peux me demander n'importe quoi : dev, audit, debug, sysadmin..."`;

export class Agent {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    // systemInstruction doit être passé au moment de getGenerativeModel(), pas
    // dans startChat(). Format : { parts: [{ text }] }, pas une string brute.
    this.model = this.genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    });
    this.history = [];
    this.pendingExecution = null; // stocke l'action en attente de confirmation
  }

  async chat(userMessage) {
    const projects = listProjects();
    const projectList = projects
      .map((p) => `- ${p.name}${p.isDefault ? ' (défaut)' : ''}: ${p.description} → ${p.path}`)
      .join('\n');

    const contextualMessage = `[Projets disponibles:\n${projectList}]\n\nMessage: ${userMessage}`;

    this.history.push({ role: 'user', parts: [{ text: contextualMessage }] });

    // Truncate history to limit Gemini cost + RAM
    if (this.history.length > MAX_HISTORY_TURNS) {
      this.history = this.history.slice(-MAX_HISTORY_TURNS);
    }

    const chat = this.model.startChat({
      history: this.history.slice(0, -1),
    });

    // Retry sur 429/503 (Gemini saturé) avec backoff exponentiel.
    // Les 4xx sauf 429 ne sont pas retryables (clé invalide, quota dépassé...).
    let result;
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        result = await chat.sendMessage(contextualMessage);
        break;
      } catch (err) {
        lastErr = err;
        const msg = err?.message || String(err);
        const transient = /\b(429|503|500|502|504|fetch failed|ECONNRESET|ETIMEDOUT)\b/i.test(msg);
        if (!transient || attempt === 4) throw err;
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.warn(`[gemini] transient error (attempt ${attempt}/4), retry in ${delay}ms: ${msg.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (!result) throw lastErr;

    const responseText = result.response.text().trim();

    this.history.push({ role: 'model', parts: [{ text: responseText }] });

    // Tenter de parser une action execute
    const action = tryParseAction(responseText);
    if (action) {
      const project = getProject(action.project);
      if (!project) {
        return {
          type: 'text',
          text: `❌ Projet "${action.project}" introuvable. Projets disponibles : ${projects.map((p) => p.name).join(', ')}`,
        };
      }
      this.pendingExecution = { ...action, projectPath: project.path };
      return {
        type: 'confirm',
        summary: action.summary,
        project: action.project,
        projectPath: project.path,
        prompt: action.prompt,
      };
    }

    // Commandes locales gérées par l'agent
    const command = parseCommand(userMessage);
    if (command) return command;

    return { type: 'text', text: responseText };
  }

  consumePendingExecution() {
    const exec = this.pendingExecution;
    this.pendingExecution = null;
    return exec;
  }

  resetHistory() {
    this.history = [];
    this.pendingExecution = null;
  }
}

function tryParseAction(text) {
  try {
    // Le modèle peut wrapper le JSON dans des backticks
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const obj = JSON.parse(clean);
    if (obj.action === 'execute' && obj.project && obj.prompt) return obj;
  } catch {}
  return null;
}

function parseCommand(text) {
  const t = text.trim().toLowerCase();

  if (t === '/projets' || t === '/projects') {
    const list = listProjects()
      .map((p) => `${p.isDefault ? '✅' : '▫️'} *${p.name}* — ${p.description}`)
      .join('\n');
    return { type: 'text', text: `📋 Projets :\n${list}` };
  }

  const defaultMatch = text.match(/^\/default\s+(\w+)$/i);
  if (defaultMatch) {
    try {
      setDefault(defaultMatch[1]);
      return { type: 'text', text: `✅ Projet par défaut : *${defaultMatch[1]}*` };
    } catch (e) {
      return { type: 'text', text: `❌ ${e.message}` };
    }
  }

  const addMatch = text.match(/^\/add\s+(\w+)\s+(.+)$/i);
  if (addMatch) {
    const [, name, rawPath] = addMatch;
    const check = validateProjectPath(rawPath);
    if (!check.valid) {
      return {
        type: 'text',
        text: `🚫 Chemin refusé : ${check.reason}\nVérifie ALLOWED_PROJECT_ROOTS dans .env.`,
      };
    }
    addProject(name, check.realPath);
    return { type: 'text', text: `✅ Projet *${name}* ajouté → ${check.realPath}` };
  }

  if (t === '/reset') {
    return { type: 'reset' };
  }

  if (t === '/help' || t === '/aide') {
    return {
      type: 'text',
      text: `🤖 *Commandes disponibles :*\n\n` +
        `/projets — liste les projets\n` +
        `/default <nom> — changer le projet par défaut\n` +
        `/add <nom> <path> — ajouter un projet\n` +
        `/reset — réinitialiser la conversation\n\n` +
        `Ou envoie simplement ta demande en texte libre !`,
    };
  }

  return null;
}
