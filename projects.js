import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dir, 'projects.json');

function load() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function listProjects() {
  const { projects, default: def } = load();
  return Object.entries(projects).map(([name, info]) => ({
    name,
    path: info.path,
    description: info.description,
    isDefault: name === def,
  }));
}

export function getProject(name) {
  const { projects, default: def } = load();
  const key = name || def;
  const project = projects[key];
  if (!project) return null;
  return { name: key, ...project };
}

export function setDefault(name) {
  const config = load();
  if (!config.projects[name]) throw new Error(`Projet "${name}" introuvable`);
  config.default = name;
  save(config);
}

export function addProject(name, path, description = '') {
  const config = load();
  config.projects[name] = { path, description };
  save(config);
}
