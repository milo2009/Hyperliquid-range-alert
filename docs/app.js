// Range Alert — tableau de bord + réglages (web-app statique, aucune dépendance).
// Lecture seule côté blockchain : seule l'adresse publique est utilisée.
// Le token GitHub (optionnel) sert uniquement à enregistrer config.json dans le dépôt.

const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';
const LS = { address: 'ra.address', token: 'ra.ghToken', repo: 'ra.repo', topic: 'ra.ntfyTopic', site: 'ra.site' };
const DEFAULT_REPO = 'milo2009/Hyperliquid-range-alert';
const MAX_U128 = (1n << 128n) - 1n;
const SEL = {
  factory: '0xc45a0155',
  balanceOf: '0x70a08231',
  tokenOfOwnerByIndex: '0x2f745c59',
  positions: '0x99fbab88',
  getPool: '0x1698ee82',
  slot0: '0x3850c7bd',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  collect: '0xfc6f7865',
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (digits) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits });
const fmtPrice = (p) => (Number.isFinite(p) ? nf(Math.abs(p) >= 1000 ? 2 : Math.abs(p) >= 1 ? 4 : 6).format(p) : '—');
const fmtUsd = (v) => (Number.isFinite(v) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }).format(v) : '—');
const fmtPct = (v) => `${nf(2).format(v)} %`;
const fmtAmt = (v) => nf(Math.abs(v) >= 100 ? 2 : 4).format(v);

const store = {
  get: (k) => localStorage.getItem(k) || '',
  set: (k, v) => (v ? localStorage.setItem(k, v) : localStorage.removeItem(k)),
};

function detectRepo() {
  const saved = store.get(LS.repo);
  if (saved) return saved;
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0];
    const name = location.pathname.split('/').filter(Boolean)[0];
    if (owner && name) return `${owner}/${name}`;
  }
  return DEFAULT_REPO;
}

// ---------------------------------------------------------------------------
// ABI minimal

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (hex, i) => BigInt('0x' + word(hex, i));
const s = (hex, i) => BigInt.asIntN(256, u(hex, i));
const addr = (hex, i) => '0x' + word(hex, i).slice(24);
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

function decodeString(hex) {
  if (!hex || hex === '0x') return '?';
  try {
    if (hex.length === 66) {
      // bytes32 (anciens tokens)
      return decodeURIComponent(hex.slice(2).replace(/(00)+$/, '').replace(/../g, '%$&'));
    }
    const offset = Number(u(hex, 0)) / 32;
    const len = Number(u(hex, offset));
    const data = hex.slice(2 + (offset + 1) * 64, 2 + (offset + 1) * 64 + len * 2);
    return new TextDecoder().decode(new Uint8Array(data.match(/../g).map((b) => parseInt(b, 16))));
  } catch {
    return '?';
  }
}

// Envoie plusieurs eth_call en une requête (JSON-RPC batch), par paquets.
async function rpcBatch(calls) {
  const out = new Array(calls.length);
  for (let start = 0; start < calls.length; start += 20) {
    const chunk = calls.slice(start, start + 20);
    const body = chunk.map((c, i) => ({
      jsonrpc: '2.0', id: start + i, method: 'eth_call',
      params: [{ to: c.to, data: c.data, ...(c.from ? { from: c.from } : {}) }, 'latest'],
    }));
    let json;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      json = res.ok ? await res.json() : null;
      const limited = !json || (Array.isArray(json) && json.some((r) => r.error && /rate/i.test(r.error.message)));
      if (!limited) break;
      if (attempt >= 3) throw new Error('RPC HyperEVM indisponible (rate limit), réessaie dans un instant.');
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    for (const r of [].concat(json)) out[r.id] = r.error ? { error: r.error.message } : { result: r.result };
  }
  return out;
}
const call = async (to, data, from) => {
  const [r] = await rpcBatch([{ to, data, from }]);
  if (r.error) throw new Error(r.error);
  return r.result;
};

// ---------------------------------------------------------------------------
// Lecture des positions

async function loadLps(cfg, owner) {
  const lp = cfg.lp || {};
  const nearPct = lp.nearEdgePct ?? 3;
  const results = [];

  for (const m of lp.positionManagers || []) {
    const npm = m.address;
    const [factoryHex, balHex] = (await rpcBatch([
      { to: npm, data: SEL.factory },
      { to: npm, data: SEL.balanceOf + padAddr(owner) },
    ])).map((r) => r.result);
    const factory = addr(factoryHex, 0);
    const n = Number(u(balHex, 0));

    const idsRes = n ? await rpcBatch(Array.from({ length: n }, (_, i) => ({ to: npm, data: SEL.tokenOfOwnerByIndex + padAddr(owner) + pad(i) }))) : [];
    const ignored = new Set((m.ignoreTokenIds || []).map(String));
    const ids = [...new Set([...idsRes.map((r) => u(r.result, 0).toString()), ...(m.extraTokenIds || []).map(String)])].filter((id) => !ignored.has(id));
    if (!ids.length) continue;

    const posRes = await rpcBatch(ids.flatMap((id) => [
      { to: npm, data: SEL.positions + pad(id) },
      { to: npm, data: SEL.collect + pad(id) + padAddr(owner) + pad(MAX_U128) + pad(MAX_U128), from: owner },
    ]));

    const positions = ids.map((id, i) => {
      const h = posRes[i * 2].result;
      const fees = posRes[i * 2 + 1].result;
      return {
        id, token0: addr(h, 2), token1: addr(h, 3), fee: Number(u(h, 4)),
        tickLower: Number(s(h, 5)), tickUpper: Number(s(h, 6)), liquidity: u(h, 7),
        fees0: fees ? u(fees, 0) : 0n, fees1: fees ? u(fees, 1) : 0n,
      };
    }).filter((p) => p.liquidity > 0n);

    // Pools et métadonnées des tokens (dédupliqués).
    const tokens = [...new Set(positions.flatMap((p) => [p.token0, p.token1]))];
    const poolKeys = [...new Set(positions.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
    const metaRes = await rpcBatch([
      ...tokens.flatMap((t) => [{ to: t, data: SEL.symbol }, { to: t, data: SEL.decimals }]),
      ...poolKeys.map((k) => {
        const [a, b, fee] = k.split('|');
        return { to: factory, data: SEL.getPool + padAddr(a) + padAddr(b) + pad(fee) };
      }),
    ]);
    const tok = Object.fromEntries(tokens.map((t, i) => [t, {
      symbol: decodeString(metaRes[i * 2].result), decimals: Number(u(metaRes[i * 2 + 1].result, 0)),
    }]));
    const poolAddr = Object.fromEntries(poolKeys.map((k, i) => [k, addr(metaRes[tokens.length * 2 + i].result, 0)]));
    const slotRes = await rpcBatch(poolKeys.map((k) => ({ to: poolAddr[k], data: SEL.slot0 })));
    const slot = Object.fromEntries(poolKeys.map((k, i) => [k, {
      sqrtP: Number(u(slotRes[i].result, 0)) / 2 ** 96, tick: Number(s(slotRes[i].result, 1)),
    }]));

    for (const p of positions) {
      const t0 = tok[p.token0];
      const t1 = tok[p.token1];
      const { sqrtP, tick } = slot[`${p.token0}|${p.token1}|${p.fee}`];
      const scale = 10 ** (t0.decimals - t1.decimals);
      const toPrice = (t) => Math.pow(1.0001, t) * scale;
      const price = sqrtP * sqrtP * scale;
      const min = toPrice(p.tickLower);
      const max = toPrice(p.tickUpper);

      // Montants détenus (formules Uniswap V3).
      const L = Number(p.liquidity);
      const sa = Math.sqrt(Math.pow(1.0001, p.tickLower));
      const sb = Math.sqrt(Math.pow(1.0001, p.tickUpper));
      const sp = Math.min(Math.max(sqrtP, sa), sb);
      const amount0 = (L * (sb - sp)) / (sp * sb) / 10 ** t0.decimals;
      const amount1 = (L * (sp - sa)) / 10 ** t1.decimals;
      const fees0 = Number(p.fees0) / 10 ** t0.decimals;
      const fees1 = Number(p.fees1) / 10 ** t1.decimals;

      let level, detail;
      if (tick < p.tickLower) {
        level = 'out'; detail = `Prix sous la range : 100 % ${t0.symbol}`;
      } else if (tick >= p.tickUpper) {
        level = 'out'; detail = `Prix au-dessus de la range : 100 % ${t1.symbol}`;
      } else {
        const toMin = ((price - min) / price) * 100;
        const toMax = ((max - price) / price) * 100;
        level = Math.min(toMin, toMax) <= nearPct ? 'near' : 'ok';
        detail = toMin < toMax ? `À ${fmtPct(toMin)} du min` : `À ${fmtPct(toMax)} du max`;
      }

      results.push({
        id: p.id, dex: m.name || 'LP', url: m.url, feeTier: p.fee / 10000,
        sym0: t0.symbol, sym1: t1.symbol, price, min, max, level, detail, nearPct,
        amount0, amount1, value: amount0 * price + amount1,
        fees0, fees1, feesValue: fees0 * price + fees1,
      });
    }
  }
  return results;
}

async function hl(body) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`API Hyperliquid HTTP ${res.status}`);
  return res.json();
}

async function loadPerps(cfg, owner) {
  const pc = cfg.perps || {};
  if (pc.enabled === false) return { positions: [], accountValue: 0 };
  const warn = pc.liqWarnPct ?? 15;
  const danger = pc.liqDangerPct ?? 7;
  const [st, mids] = await Promise.all([hl({ type: 'clearinghouseState', user: owner }), hl({ type: 'allMids' })]);
  const positions = (st.assetPositions || []).map(({ position: p }) => {
    const size = Number(p.szi);
    const mark = Number(mids[p.coin] ?? Number(p.positionValue) / Math.abs(size));
    const liq = p.liquidationPx == null ? null : Number(p.liquidationPx);
    const dist = liq ? (Math.abs(mark - liq) / mark) * 100 : null;
    let level = dist == null ? 'ok' : dist <= danger ? 'out' : dist <= warn ? 'near' : 'ok';
    const r = (pc.ranges || {})[p.coin];
    if (r && ((r.min != null && mark < r.min) || (r.max != null && mark > r.max))) level = 'out';
    return {
      coin: p.coin, side: size > 0 ? 'Long' : 'Short', size: Math.abs(size), mark, entry: Number(p.entryPx),
      liq, dist, pnl: Number(p.unrealizedPnl), lev: p.leverage ? `${p.leverage.value}x ${p.leverage.type}` : '', level,
    };
  }).filter((p) => p.size);
  return { positions, accountValue: Number(st.marginSummary?.accountValue || 0) };
}

// Positions saisies à la main (ex. Variational Omni, sans API publique) : prix = mid Hyperliquid.
async function loadManual(cfg) {
  const mc = cfg.manual || {};
  const list = (mc.positions || []).filter((p) => p.coin && Number(p.entry) > 0);
  if (!list.length) return [];
  const nearPct = mc.nearEntryPct ?? 3;
  const warn = cfg.perps?.liqWarnPct ?? 15;
  const danger = cfg.perps?.liqDangerPct ?? 7;
  const mids = await hl({ type: 'allMids' });
  return list.map((p) => {
    const coin = String(p.coin).toUpperCase();
    const short = String(p.side).toLowerCase() === 'short';
    const mark = Number(mids[coin]);
    const entry = Number(p.entry);
    const size = Math.abs(Number(p.size) || 0);
    const liq = Number(p.liq) > 0 ? Number(p.liq) : null;
    const toEntry = ((short ? entry - mark : mark - entry) / mark) * 100;
    const dist = liq ? (Math.abs(mark - liq) / mark) * 100 : null;
    let level = !Number.isFinite(mark) ? 'near' : toEntry <= 0 ? 'out' : toEntry <= nearPct ? 'near' : 'ok';
    if (dist != null && dist <= danger) level = 'out';
    else if (dist != null && dist <= warn && level === 'ok') level = 'near';
    return {
      venue: p.venue || 'Manuel', url: p.url, coin, short, size, entry, liq, dist, mark, toEntry, nearPct, level,
      value: mark * size, pnl: (short ? entry - mark : mark - entry) * size,
    };
  });
}

// ---------------------------------------------------------------------------
// GitHub (config.json)

const gh = (path, opts = {}) => {
  const token = store.get(LS.token);
  return fetch(`https://api.github.com/repos/${detectRepo()}${path}`, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
};
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (str) => btoa(Array.from(new TextEncoder().encode(str), (b) => String.fromCharCode(b)).join(''));

let configSha = null;
async function loadConfig() {
  const res = await gh(`/contents/config.json?ref=main&t=${Date.now()}`);
  if (res.ok) {
    const j = await res.json();
    configSha = j.sha;
    return JSON.parse(b64decode(j.content));
  }
  // Repli sans API (quota anonyme épuisé, etc.).
  const raw = await fetch(`https://raw.githubusercontent.com/${detectRepo()}/main/config.json?t=${Date.now()}`);
  if (!raw.ok) throw new Error(`Impossible de lire config.json (HTTP ${res.status})`);
  configSha = null;
  return raw.json();
}

async function saveConfig(cfg) {
  if (!store.get(LS.token)) throw new Error('Ajoute ton token GitHub dans « Appareil » pour enregistrer.');
  const cur = await gh(`/contents/config.json?ref=main&t=${Date.now()}`);
  if (!cur.ok) throw new Error(`Lecture de config.json refusée (HTTP ${cur.status}). Vérifie le token.`);
  const { sha } = await cur.json();
  const res = await gh('/contents/config.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Réglages modifiés depuis l’app mobile',
      content: b64encode(JSON.stringify(cfg, null, 2) + '\n'),
      sha, branch: 'main',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Enregistrement refusé (HTTP ${res.status}) : ${err.message || ''}`);
  }
  const j = await res.json();
  configSha = j.content.sha;
  return j.commit.html_url;
}

// ---------------------------------------------------------------------------
// Rendu

const STATUS = {
  ok: { label: 'Dans la range', icon: '✓' },
  near: { label: 'Proche du bord', icon: '!' },
  out: { label: 'Hors range', icon: '✕' },
};
const PERP_STATUS = {
  ok: { label: 'Sûr', icon: '✓' },
  near: { label: 'À surveiller', icon: '!' },
  out: { label: 'Danger', icon: '✕' },
};
const badge = (level, map = STATUS) => `<span class="badge ${level}"><span aria-hidden="true">${map[level].icon}</span>${map[level].label}</span>`;

function rangeBar(p) {
  // Fenêtre visible : la range + 25 % de marge de chaque côté, élargie si le prix est dehors.
  const width = p.max - p.min;
  const lo = Math.min(p.min - width * 0.25, p.price - width * 0.05);
  const hi = Math.max(p.max + width * 0.25, p.price + width * 0.05);
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  const near = (p.nearPct / 100) * p.price;
  return `
    <div class="range" role="img" aria-label="Prix ${esc(fmtPrice(p.price))}, range ${esc(fmtPrice(p.min))} à ${esc(fmtPrice(p.max))}">
      <div class="track"></div>
      <div class="inrange" data-l="${pos(p.min)}" data-w="${pos(p.max) - pos(p.min)}"></div>
      <div class="nearzone" data-l="${pos(p.min)}" data-w="${Math.max(0, pos(p.min + near) - pos(p.min))}"></div>
      <div class="nearzone" data-l="${pos(p.max - near)}" data-w="${Math.max(0, pos(p.max) - pos(p.max - near))}"></div>
      <div class="marker ${p.level}" data-l="${pos(p.price)}"></div>
    </div>
    <div class="range-labels">
      <span><small>Min</small>${esc(fmtPrice(p.min))}</span>
      <span class="center"><small>Prix</small><b>${esc(fmtPrice(p.price))}</b></span>
      <span class="right"><small>Max</small>${esc(fmtPrice(p.max))}</span>
    </div>`;
}

// La CSP interdit les attributs style="" : la géométrie est appliquée via le DOM.
function applyGeometry(root) {
  root.querySelectorAll('[data-l]').forEach((el) => {
    el.style.left = `${Number(el.dataset.l)}%`;
    if (el.dataset.w != null) el.style.width = `${Number(el.dataset.w)}%`;
  });
}

function lpCard(p) {
  return `
    <article class="card">
      <header class="card-head">
        <div>
          <h3>${esc(p.sym0)} / ${esc(p.sym1)} <span class="muted">#${esc(p.id)}</span></h3>
          <p class="muted small">${esc(p.dex)} · ${esc(p.feeTier)} %</p>
        </div>
        ${badge(p.level)}
      </header>
      ${rangeBar(p)}
      <p class="detail">${esc(p.detail)} <span class="muted">(${esc(p.sym1)} par ${esc(p.sym0)})</span></p>
      <dl class="kv">
        <div><dt>Valeur</dt><dd>${esc(fmtUsd(p.value))}</dd></div>
        <div><dt>Frais non réclamés</dt><dd>${esc(fmtUsd(p.feesValue))}</dd></div>
        <div><dt>${esc(p.sym0)}</dt><dd>${esc(fmtAmt(p.amount0))}</dd></div>
        <div><dt>${esc(p.sym1)}</dt><dd>${esc(fmtAmt(p.amount1))}</dd></div>
      </dl>
      ${p.url ? `<a class="btn ghost" href="${esc(p.url)}" target="_blank" rel="noopener">Ouvrir ${esc(p.dex.split(' ')[0])} ↗</a>` : ''}
    </article>`;
}

function perpCard(p) {
  return `
    <article class="card">
      <header class="card-head">
        <div>
          <h3>${esc(p.coin)} <span class="muted">${esc(p.side)} ${esc(p.lev)}</span></h3>
          <p class="muted small">Hyperliquid perps</p>
        </div>
        ${badge(p.level, PERP_STATUS)}
      </header>
      <dl class="kv">
        <div><dt>Mark</dt><dd>${esc(fmtPrice(p.mark))}</dd></div>
        <div><dt>Entrée</dt><dd>${esc(fmtPrice(p.entry))}</dd></div>
        <div><dt>Liquidation</dt><dd>${p.liq ? `${esc(fmtPrice(p.liq))} <span class="muted">(${esc(fmtPct(p.dist))})</span>` : '—'}</dd></div>
        <div><dt>PnL</dt><dd class="${p.pnl >= 0 ? 'pos' : 'neg'}">${esc(fmtUsd(p.pnl))}</dd></div>
      </dl>
      <a class="btn ghost" href="https://app.hyperliquid.xyz/trade/${encodeURIComponent(p.coin)}" target="_blank" rel="noopener">Ouvrir Hyperliquid ↗</a>
    </article>`;
}

const ENTRY_STATUS = {
  ok: { label: 'Loin de l’entrée', icon: '✓' },
  near: { label: 'Proche de l’entrée', icon: '!' },
  out: { label: 'Entrée atteinte', icon: '✕' },
};

// Barre : zone sûre (côté profit) jusqu'au prix d'entrée, bande « proche » avant l'entrée, marqueur au prix.
function entryBar(p) {
  const lo = Math.min(p.mark, p.entry) * 0.9;
  const hi = Math.max(p.mark, p.entry) * 1.1;
  const pos = (v) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const e = pos(p.entry);
  const nearW = Math.abs(pos(p.entry * (1 + (p.short ? -1 : 1) * p.nearPct / 100)) - e);
  const safe = p.short ? { l: 0, w: e } : { l: e, w: 100 - e };
  const near = p.short ? { l: e - nearW, w: nearW } : { l: e, w: nearW };
  const price = ['Prix', `<b>${esc(fmtPrice(p.mark))}</b>`];
  const entry = ['Entrée', esc(fmtPrice(p.entry))];
  const [left, right] = p.mark <= p.entry ? [price, entry] : [entry, price];
  const labels = [`<span><small>${left[0]}</small>${left[1]}</span>`, `<span class="right"><small>${right[0]}</small>${right[1]}</span>`];
  return `
    <div class="range" role="img" aria-label="Prix ${esc(fmtPrice(p.mark))}, entrée ${esc(fmtPrice(p.entry))}">
      <div class="track"></div>
      <div class="inrange" data-l="${safe.l}" data-w="${safe.w}"></div>
      <div class="nearzone" data-l="${near.l}" data-w="${near.w}"></div>
      <div class="marker ${p.level}" data-l="${pos(p.mark)}"></div>
    </div>
    <div class="range-labels">${labels.join('')}</div>`;
}

function manualCard(p) {
  const detail = p.toEntry > 0
    ? `Encore ${fmtPct(p.toEntry)} de ${p.short ? 'hausse' : 'baisse'} avant le prix d’entrée`
    : `Prix d’entrée atteint : le prix est ${p.short ? 'au-dessus' : 'en dessous'} de l’entrée`;
  return `
    <article class="card">
      <header class="card-head">
        <div>
          <h3>${esc(p.coin)} <span class="muted">${p.short ? 'Short' : 'Long'}</span></h3>
          <p class="muted small">${esc(p.venue)} · saisie manuelle</p>
        </div>
        ${badge(p.level, ENTRY_STATUS)}
      </header>
      ${entryBar(p)}
      <p class="detail">${esc(detail)}</p>
      <dl class="kv">
        <div><dt>Prix (Hyperliquid)</dt><dd>${esc(fmtPrice(p.mark))}</dd></div>
        <div><dt>Entrée</dt><dd>${esc(fmtPrice(p.entry))}</dd></div>
        <div><dt>Taille</dt><dd>${esc(nf(8).format(p.size))} ${esc(p.coin)}</dd></div>
        <div><dt>Valeur</dt><dd>${esc(fmtUsd(p.value))}</dd></div>
        <div><dt>Liquidation</dt><dd>${p.liq ? `${esc(fmtPrice(p.liq))} <span class="muted">(${esc(fmtPct(p.dist))})</span>` : '—'}</dd></div>
        <div><dt>PnL estimé</dt><dd class="${p.pnl >= 0 ? 'pos' : 'neg'}">${esc(fmtUsd(p.pnl))}</dd></div>
      </dl>
      ${p.url ? `<a class="btn ghost" href="${esc(p.url)}" target="_blank" rel="noopener">Ouvrir ${esc(p.venue)} ↗</a>` : ''}
    </article>`;
}

function summary(lps, perps, manual) {
  const total = lps.reduce((a, p) => a + p.value, 0);
  const fees = lps.reduce((a, p) => a + p.feesValue, 0);
  const inRange = lps.filter((p) => p.level !== 'out').length;
  const prices = [...new Map(lps.map((p) => [`${p.sym0}/${p.sym1}`, p])).values()];
  const coins = [...new Map(manual.map((p) => [p.coin, p])).values()];
  const worst = [...lps, ...perps.positions, ...manual].reduce((w, p) => (['ok', 'near', 'out'].indexOf(p.level) > ['ok', 'near', 'out'].indexOf(w) ? p.level : w), 'ok');
  const headline = { ok: 'Tout est sous contrôle', near: 'Une position approche d’un seuil', out: 'Action requise' }[worst];
  return `
    <section class="summary">
      <div class="hero ${worst}">
        <span class="hero-icon" aria-hidden="true">${STATUS[worst].icon}</span>
        <div><p class="hero-title">${esc(headline)}</p>
        <p class="muted small">${lps.length ? `${inRange}/${lps.length} LP dans la range` : 'Aucune LP'}${perps.positions.length ? ` · ${perps.positions.length} perp(s)` : ''}${manual.length ? ` · ${manual.length} autre(s)` : ''}</p></div>
      </div>
      <div class="tiles">
        ${prices.map((p) => `<div class="tile"><small>${esc(p.sym0)}</small><b>${esc(fmtPrice(p.price))}</b><small>${esc(p.sym1)}</small></div>`).join('')}
        ${coins.map((p) => `<div class="tile"><small>${esc(p.coin)}</small><b>${esc(fmtPrice(p.mark))}</b><small>USD</small></div>`).join('')}
        ${lps.length ? `<div class="tile"><small>Valeur LP</small><b>${esc(fmtUsd(total))}</b></div>
        <div class="tile"><small>Frais à réclamer</small><b>${esc(fmtUsd(fees))}</b></div>` : ''}
        ${perps.accountValue ? `<div class="tile"><small>Compte perps</small><b>${esc(fmtUsd(perps.accountValue))}</b></div>` : ''}
      </div>
    </section>`;
}

function siteTabs(groups) {
  const saved = store.get(LS.site);
  const cur = groups.some((g) => g.name === saved) ? saved : groups[0].name;
  const tabs = groups.map((g, i) => `
    <button type="button" role="tab" id="site-tab-${i}" aria-controls="site-panel-${i}" aria-selected="${g.name === cur}" tabindex="${g.name === cur ? 0 : -1}" data-site="${esc(g.name)}">
      ${esc(g.name)}<span class="count">${g.cards.length}</span>${g.level !== 'ok' ? `<span class="dot ${g.level}" aria-label="${esc(STATUS[g.level].label)}">${STATUS[g.level].icon}</span>` : ''}
    </button>`).join('');
  const panels = groups.map((g, i) => `
    <div role="tabpanel" id="site-panel-${i}" aria-labelledby="site-tab-${i}"${g.name === cur ? '' : ' hidden'}>${g.cards.join('')}</div>`).join('');
  return `<div class="site-tabs" role="tablist" aria-label="Plateformes">${tabs}</div>${panels}`;
}

function selectSite(tab) {
  const list = tab.closest('[role="tablist"]');
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  store.set(LS.site, tab.dataset.site);
}

let config = null;
let refreshing = false;

async function refresh() {
  const owner = store.get(LS.address);
  const view = $('#positions');
  if (!owner) {
    view.innerHTML = `<div class="empty"><p>Renseigne ton adresse publique (0x…) dans l’onglet <b>Réglages</b> pour voir tes positions.</p></div>`;
    return;
  }
  if (refreshing) return;
  refreshing = true;
  $('#refresh').classList.add('spin');
  try {
    if (!config) config = await loadConfig();
    const [lps, perps, manual] = await Promise.all([loadLps(config, owner), loadPerps(config, owner), loadManual(config)]);
    const order = { out: 0, near: 1, ok: 2 };
    lps.sort((a, b) => order[a.level] - order[b.level]);
    // Un onglet par plateforme, dans l'ordre : DEX LP (HyperSwap…), Hyperliquid, puis les saisies manuelles.
    const groups = [];
    const add = (name, level, html) => {
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push(g = { name, level: 'ok', cards: [] });
      g.cards.push(html);
      if (order[level] < order[g.level]) g.level = level;
    };
    lps.forEach((p) => add(p.dex.split(' ')[0], p.level, lpCard(p)));
    perps.positions.forEach((p) => add('Hyperliquid', p.level, perpCard(p)));
    manual.forEach((p) => add(p.venue, p.level, manualCard(p)));
    view.innerHTML = summary(lps, perps, manual)
      + (groups.length ? siteTabs(groups) : '<div class="empty"><p>Aucune position ouverte détectée.</p></div>');
    applyGeometry(view);
    $('#updated').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (e) {
    view.insertAdjacentHTML('afterbegin', `<div class="error">${esc(e.message)}</div>`);
  } finally {
    refreshing = false;
    $('#refresh').classList.remove('spin');
  }
}

// ---------------------------------------------------------------------------
// Réglages

const csvIds = (v) => v.split(/[\s,;]+/).map((x) => x.replace(/^#/, '')).filter((x) => /^\d+$/.test(x));

function renderRanges(ranges) {
  $('#ranges').innerHTML = Object.entries(ranges || {}).map(([coin, r]) => rangeRow(coin, r.min, r.max)).join('');
}
const rangeRow = (coin = '', min = '', max = '') => `
  <div class="range-row">
    <input class="r-coin" placeholder="HYPE" value="${esc(coin)}" aria-label="Coin">
    <input class="r-min" type="number" step="any" inputmode="decimal" placeholder="min" value="${esc(min ?? '')}" aria-label="Prix min">
    <input class="r-max" type="number" step="any" inputmode="decimal" placeholder="max" value="${esc(max ?? '')}" aria-label="Prix max">
    <button type="button" class="icon-btn r-del" aria-label="Supprimer">✕</button>
  </div>`;

const manualRow = (p = {}) => `
  <div class="manual-row" data-url="${esc(p.url ?? '')}">
    <input class="m-venue" placeholder="Plateforme" value="${esc(p.venue ?? '')}" aria-label="Plateforme">
    <input class="m-coin" placeholder="BTC" value="${esc(p.coin ?? '')}" aria-label="Coin">
    <select class="m-side" aria-label="Sens">
      <option value="short"${p.side === 'long' ? '' : ' selected'}>Short</option>
      <option value="long"${p.side === 'long' ? ' selected' : ''}>Long</option>
    </select>
    <input class="m-entry" type="number" step="any" inputmode="decimal" placeholder="Prix d’entrée" value="${esc(p.entry ?? '')}" aria-label="Prix d’entrée">
    <input class="m-size" type="number" step="any" inputmode="decimal" placeholder="Taille" value="${esc(p.size ?? '')}" aria-label="Taille">
    <input class="m-liq" type="number" step="any" inputmode="decimal" placeholder="Liquidation" value="${esc(p.liq ?? '')}" aria-label="Prix de liquidation">
    <button type="button" class="icon-btn m-del" aria-label="Supprimer">✕</button>
  </div>`;

function readManual() {
  const positions = [];
  for (const row of document.querySelectorAll('.manual-row')) {
    const coin = $('.m-coin', row).value.trim().toUpperCase();
    const entry = $('.m-entry', row).value;
    if (!coin && entry === '') continue;
    if (!coin || !(Number(entry) > 0)) throw new Error('Position manuelle : coin et prix d’entrée obligatoires.');
    const venue = $('.m-venue', row).value.trim() || 'Manuel';
    const size = $('.m-size', row).value;
    const liq = $('.m-liq', row).value;
    const url = row.dataset.url || (/variational/i.test(venue) ? 'https://omni.variational.io/portfolio' : '');
    positions.push({
      venue, coin, side: $('.m-side', row).value, ...(size !== '' ? { size: Number(size) } : {}), entry: Number(entry),
      ...(liq !== '' ? { liq: Number(liq) } : {}), ...(url ? { url } : {}),
    });
  }
  return positions;
}

function fillSettings(cfg) {
  const f = $('#settings-form');
  const m = cfg.lp?.positionManagers?.[0] || {};
  f.nearEdgePct.value = cfg.lp?.nearEdgePct ?? 3;
  f.remindEveryHours.value = cfg.remindEveryHours ?? 4;
  f.quietEnabled.checked = !!cfg.quietHours?.enabled;
  f.quietStart.value = cfg.quietHours?.start ?? '23:00';
  f.quietEnd.value = cfg.quietHours?.end ?? '08:00';
  f.perpsEnabled.checked = cfg.perps?.enabled !== false;
  f.liqWarnPct.value = cfg.perps?.liqWarnPct ?? 15;
  f.liqDangerPct.value = cfg.perps?.liqDangerPct ?? 7;
  f.extraIds.value = (m.extraTokenIds || []).join(', ');
  f.ignoreIds.value = (m.ignoreTokenIds || []).join(', ');
  renderRanges(cfg.perps?.ranges);
  f.nearEntryPct.value = cfg.manual?.nearEntryPct ?? 3;
  $('#manuals').innerHTML = (cfg.manual?.positions || []).map(manualRow).join('');
}

function readSettings(base) {
  const f = $('#settings-form');
  const num = (el, name, lo, hi) => {
    const v = Number(el.value);
    if (el.value === '' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} : valeur entre ${lo} et ${hi} attendue.`);
    return v;
  };
  const cfg = structuredClone(base);
  cfg.lp ??= {};
  cfg.lp.nearEdgePct = num(f.nearEdgePct, 'Alerte proche du bord', 0, 50);
  cfg.remindEveryHours = num(f.remindEveryHours, 'Rappel', 0, 168);
  cfg.quietHours = { ...(cfg.quietHours || {}), enabled: f.quietEnabled.checked, start: f.quietStart.value || '23:00', end: f.quietEnd.value || '08:00' };
  cfg.quietHours.timezone ??= 'Europe/Paris';
  cfg.perps ??= {};
  cfg.perps.enabled = f.perpsEnabled.checked;
  cfg.perps.liqWarnPct = num(f.liqWarnPct, 'Liquidation ⚠️', 1, 90);
  cfg.perps.liqDangerPct = num(f.liqDangerPct, 'Liquidation 🚨', 0.5, 90);
  if (cfg.perps.liqDangerPct >= cfg.perps.liqWarnPct) throw new Error('Le seuil 🚨 doit être plus petit que le seuil ⚠️.');
  const ranges = {};
  for (const row of document.querySelectorAll('.range-row')) {
    const coin = $('.r-coin', row).value.trim().toUpperCase();
    if (!coin) continue;
    const min = $('.r-min', row).value;
    const max = $('.r-max', row).value;
    if (min === '' && max === '') continue;
    ranges[coin] = { ...(min !== '' ? { min: Number(min) } : {}), ...(max !== '' ? { max: Number(max) } : {}) };
    if (ranges[coin].min != null && ranges[coin].max != null && ranges[coin].min >= ranges[coin].max) throw new Error(`${coin} : min doit être inférieur à max.`);
  }
  cfg.perps.ranges = ranges;
  cfg.manual = { ...(cfg.manual || {}), nearEntryPct: num(f.nearEntryPct, 'Alerte proche de l’entrée', 0, 50), positions: readManual() };
  if (cfg.lp.positionManagers?.[0]) {
    cfg.lp.positionManagers[0].extraTokenIds = csvIds(f.extraIds.value);
    cfg.lp.positionManagers[0].ignoreTokenIds = csvIds(f.ignoreIds.value);
  }
  return cfg;
}

function setMsg(el, text, kind = '') {
  el.className = `msg ${kind}`;
  el.innerHTML = text;
}

function initSettings() {
  const dev = $('#device-form');
  dev.address.value = store.get(LS.address);
  dev.token.value = store.get(LS.token);
  dev.repo.value = detectRepo();
  dev.topic.value = store.get(LS.topic);

  dev.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = dev.address.value.trim();
    if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) return setMsg($('#device-msg'), 'Adresse invalide (0x + 40 caractères).', 'err');
    store.set(LS.address, a);
    store.set(LS.token, dev.token.value.trim());
    store.set(LS.repo, dev.repo.value.trim() === DEFAULT_REPO ? '' : dev.repo.value.trim());
    store.set(LS.topic, dev.topic.value.trim());
    config = null;
    setMsg($('#device-msg'), 'Enregistré sur ce téléphone.', 'ok');
    loadConfig().then((c) => { config = c; fillSettings(c); }).catch(() => {});
  });

  $('#test-notif').addEventListener('click', async () => {
    const topic = dev.topic.value.trim();
    if (!topic) return setMsg($('#device-msg'), 'Renseigne le topic ntfy pour tester.', 'err');
    const r = await fetch('https://ntfy.sh/', {
      method: 'POST',
      body: JSON.stringify({ topic, title: '🔔 Test depuis l’app', message: 'Les notifications fonctionnent.', click: location.href }),
    }).catch(() => null);
    setMsg($('#device-msg'), r?.ok ? 'Notification envoyée.' : 'Échec de l’envoi.', r?.ok ? 'ok' : 'err');
  });

  $('#add-range').addEventListener('click', () => $('#ranges').insertAdjacentHTML('beforeend', rangeRow()));
  $('#ranges').addEventListener('click', (e) => e.target.closest('.r-del')?.closest('.range-row').remove());
  $('#add-manual').addEventListener('click', () => $('#manuals').insertAdjacentHTML('beforeend', manualRow()));
  $('#manuals').addEventListener('click', (e) => e.target.closest('.m-del')?.closest('.manual-row').remove());

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#settings-msg');
    const btn = e.submitter;
    try {
      btn.disabled = true;
      setMsg(msg, 'Enregistrement…');
      const fresh = await loadConfig(); // repart de la version en ligne pour ne rien écraser
      const next = readSettings(fresh);
      const url = await saveConfig(next);
      config = next;
      setMsg(msg, `Enregistré ✓ — appliqué au prochain passage (≤ 15 min). <a href="${esc(url)}" target="_blank" rel="noopener">Voir le commit</a>`, 'ok');
    } catch (err) {
      setMsg(msg, esc(err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Navigation

function show(tab) {
  for (const t of ['positions', 'settings']) {
    $(`#${t}`).hidden = t !== tab;
    $(`[data-tab="${t}"]`).setAttribute('aria-current', t === tab ? 'page' : 'false');
  }
  if (tab === 'settings') {
    loadConfig().then((c) => { config = c; fillSettings(c); setMsg($('#settings-msg'), ''); })
      .catch((e) => setMsg($('#settings-msg'), esc(e.message), 'err'));
  }
}

// Mise à jour auto : l'app installée garde la page en mémoire, donc on recharge si un fichier a été redéployé.
// Empreinte de départ = version en cache (celle qui tourne) ; comparaison avec la version réseau.
const ASSETS = ['./', 'app.js', 'style.css'];
const assetsTag = (cache) => Promise.all(ASSETS.map((u) => fetch(u, { cache })
  .then((r) => r.headers.get('etag') || r.headers.get('last-modified') || '')))
  .then((t) => t.join('|')).catch(() => null);
const runningTag = assetsTag('force-cache');
async function checkUpdate() {
  const [before, now] = await Promise.all([runningTag, assetsTag('reload')]);
  if (before && now && before !== now) location.reload();
}

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$('#refresh').addEventListener('click', () => { checkUpdate(); refresh(); });
$('#positions').addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (tab) selectSite(tab);
});
$('#positions').addEventListener('keydown', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...tab.parentElement.children];
  const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  selectSite(next);
  next.focus();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkUpdate();
  refresh();
});
setInterval(() => document.visibilityState === 'visible' && !$('#positions').hidden && refresh(), 60_000);

// Configuration rapide par lien : …/#address=0x… (le fragment # ne quitte jamais le téléphone).
const hashAddr = new URLSearchParams(location.hash.slice(1)).get('address');
if (hashAddr && /^0x[0-9a-fA-F]{40}$/.test(hashAddr)) {
  store.set(LS.address, hashAddr);
  history.replaceState(null, '', location.pathname + location.search);
}

initSettings();
show(store.get(LS.address) ? 'positions' : 'settings');
if (!store.get(LS.address)) $('#updated').textContent = 'Adresse à renseigner';
refresh();
