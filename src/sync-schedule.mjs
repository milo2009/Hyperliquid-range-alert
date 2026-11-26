// Reporte le rythme de vérification (config.json → schedule.cron) sur le job cron-job.org
// qui déclenche le workflow monitor.yml. Lancé par .github/workflows/schedule.yml à chaque
// modification de config.json (donc aussi quand on enregistre les réglages depuis la web-app).
//
// Variables d'environnement :
//   CRONJOB_API_KEY    clé API cron-job.org (Console → Settings → API)          obligatoire
//   CRONJOB_JOB_ID     n° du job ; sinon recherché par son URL (…/monitor.yml/dispatches)
//   GITHUB_REPOSITORY  owner/depot (fourni par GitHub Actions), sert à trouver le job
//   --dry-run          affiche le planning sans rien envoyer

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCron } from '../docs/cron.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cron-job.org';
const DEFAULT_CRON = '0 * * * *';

const cfg = JSON.parse(await readFile(process.env.CONFIG_PATH || resolve(ROOT, 'config.json'), 'utf8'));
const cron = cfg.schedule?.cron || DEFAULT_CRON;
const timezone = cfg.schedule?.timezone || cfg.quietHours?.timezone || 'Europe/Paris';
const schedule = { timezone, expiresAt: 0, ...parseCron(cron) };

console.log(`Rythme demandé : "${cron}" (${timezone})`);
console.log(JSON.stringify(schedule));
if (process.argv.includes('--dry-run')) process.exit(0);

const key = process.env.CRONJOB_API_KEY;
if (!key) {
  console.error('::error::Secret CRONJOB_API_KEY manquant : crée une clé API sur cron-job.org (Settings → API) et ajoute-la aux secrets du dépôt (voir README).');
  process.exit(1);
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = { 401: 'clé API invalide', 403: 'clé API restreinte à certaines IP : retire la restriction', 404: 'job introuvable (CRONJOB_JOB_ID ?)', 429: 'quota API cron-job.org dépassé (100 requêtes/jour)' }[res.status] || '';
    throw new Error(`cron-job.org ${opts.method || 'GET'} ${path} → HTTP ${res.status}${hint ? ` (${hint})` : ''} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

let jobId = process.env.CRONJOB_JOB_ID?.trim();
if (!jobId) {
  const repo = (process.env.GITHUB_REPOSITORY || '').toLowerCase();
  const { jobs = [] } = await api('/jobs');
  const matches = jobs.filter((j) => {
    const url = String(j.url || '').toLowerCase();
    return url.includes('/actions/workflows/monitor.yml/dispatches') && (!repo || url.includes(`/repos/${repo}/`));
  });
  if (matches.length !== 1) {
    const list = jobs.map((j) => `  #${j.jobId} ${j.title || ''} ${j.url}`).join('\n');
    console.error(`::error::${matches.length ? 'Plusieurs jobs' : 'Aucun job'} cron-job.org ne pointe vers monitor.yml de ${repo || 'ce dépôt'}. Renseigne le secret CRONJOB_JOB_ID.\n${list}`);
    process.exit(1);
  }
  jobId = matches[0].jobId;
}

await api(`/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify({ job: { schedule } }) });
const { jobDetails } = await api(`/jobs/${jobId}`);
const next = jobDetails?.nextExecution ? new Date(jobDetails.nextExecution * 1000).toLocaleString('fr-FR', { timeZone: timezone }) : '?';
console.log(`Job cron-job.org #${jobId} mis à jour ✓ — prochain passage : ${next}${jobDetails?.enabled === false ? ' (⚠️ job désactivé sur cron-job.org)' : ''}`);
