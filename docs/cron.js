// Expression cron à 5 champs → planning cron-job.org.
// Partagé entre la web-app (validation) et src/sync-schedule.mjs (envoi à l'API cron-job.org).
// Syntaxe acceptée par champ : *  5  1,15  9-18  */5  9-18/2  (jour de semaine : 0 ou 7 = dimanche).

const FIELDS = [
  { key: 'minutes', name: 'minute', lo: 0, hi: 59 },
  { key: 'hours', name: 'heure', lo: 0, hi: 23 },
  { key: 'mdays', name: 'jour du mois', lo: 1, hi: 31 },
  { key: 'months', name: 'mois', lo: 1, hi: 12 },
  { key: 'wdays', name: 'jour de semaine', lo: 0, hi: 7 },
];

function parseField(text, { name, lo, hi }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Cron : « ${part} » invalide (${name}).`);
    const [, a, b, stepText] = m;
    let from = a === '*' ? lo : Number(a);
    let to = a === '*' ? hi : b != null ? Number(b) : stepText ? hi : from;
    if (a === '*' && b != null) throw new Error(`Cron : « ${part} » invalide (${name}).`);
    const step = stepText ? Number(stepText) : 1;
    if (from < lo || to > hi || from > to) throw new Error(`Cron : ${name} entre ${lo} et ${hi} attendu (« ${part} »).`);
    if (step < 1) throw new Error(`Cron : pas invalide (« ${part} »).`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

// Retourne { minutes, hours, mdays, months, wdays } au format cron-job.org ([-1] = tous).
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron : 5 champs attendus (minute heure jour mois jour-semaine).');
  const out = {};
  FIELDS.forEach((f, i) => {
    const set = parseField(parts[i], f);
    if (f.key === 'wdays' && set.delete(7)) set.add(0);
    const full = f.key === 'wdays' ? 7 : f.hi - f.lo + 1;
    out[f.key] = set.size >= full ? [-1] : [...set].sort((x, y) => x - y);
  });
  return out;
}

