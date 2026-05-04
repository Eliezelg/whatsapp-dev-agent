import { GoogleGenerativeAI } from '@google/generative-ai';
import { getProject, listProjects, setDefault, addProject } from './projects.js';

const SYSTEM_PROMPT = `Tu es un assistant de développement piloté depuis WhatsApp.
Tu aides à gérer des projets web (Next.js, NestJS, PostgreSQL).

Ton rôle :
1. Comprendre les demandes de développement en conversant (pose des questions si besoin).
2. Quand tu as toutes les infos, proposer un résumé de ce que tu vas faire et demander confirmation.
3. Une fois confirmé, exécuter via Claude Code CLI.

Projets disponibles : tu les recevras dans chaque message.

Règles :
- Réponds en français (sauf si l'utilisateur écrit en hébreu ou anglais).
- Sois concis sur WhatsApp (pas de pavés, utilise ✅❌🔄⚠️⏳).
- Jamais de push direct sur main, jamais de deploy prod sans confirmation explicite.
- Si la demande est ambiguë, pose UNE question précise, pas plusieurs.

Quand tu es prêt à lancer Claude Code, réponds EXACTEMENT avec ce format JSON (rien d'autre) :
{"action":"execute","project":"<nom_projet>","prompt":"<instruction_pour_claude_code>","summary":"<résumé_pour_user>"}

Si tu as besoin de plus d'infos ou que tu veux juste converser, réponds normalement en texte.`;

export class Agent {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
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

    const chat = this.model.startChat({
      history: this.history.slice(0, -1),
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await chat.sendMessage(contextualMessage);
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
    addProject(addMatch[1], addMatch[2]);
    return { type: 'text', text: `✅ Projet *${addMatch[1]}* ajouté → ${addMatch[2]}` };
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
