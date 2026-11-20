#!/usr/bin/env node
// Surveillance de positions Hyperliquid / HyperEVM -> notifications ntfy.
//
//   node src/monitor.mjs              vérifie et notifie si besoin
//   node src/monitor.mjs --status     affiche l'état sans notifier ni toucher au state
//   node src/monitor.mjs --test       envoie une notification de test
//
// Variables d'environnement :
//   NTFY_TOPIC       (obligatoire pour notifier) topic ntfy secret
//   WALLET_ADDRESS   (optionnel) remplace "address" du config.json
//   NTFY_SERVER      (optionnel) défaut https://ntfy.sh
//   HYPEREVM_RPC     (optionnel) défaut https://rpc.hyperliquid.xyz/evm
//   CONFIG_PATH / STATE_PATH (optionnels)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, defineChain, parseAbi, getAddress } from 'viem';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.CONFIG_PATH || resolve(ROOT, 'config.json');
const STATE_PATH = process.env.STATE_PATH || resolve(ROOT, '.state', 'state.json');
const HL_API = 'https://api.hyperliquid.xyz/info';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

const args = new Set(process.argv.slice(2));
const STATUS_ONLY = args.has('--status');
const TEST = args.has('--test');

// Niveaux de gravité : plus le chiffre est haut, plus c'est grave.
const LEVEL = { ok: 0, near: 1, out: 2 };

// ---------------------------------------------------------------------------
// Utilitaires

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Lecture de ${path} impossible : ${e.message}`);
  }
}

async function retry(fn, label, tries = 4) {
  let delay = 1500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw new Error(`${label} : ${e.shortMessage || e.message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function hlInfo(body) {
  return retry(async () => {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, `API Hyperliquid (${body.type})`);
}

const fmtPrice = (p) => {
  if (!Number.isFinite(p)) return String(p);
  const abs = Math.abs(p);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return p.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};
const fmtPct = (x) => `${x.toFixed(2)}%`;

// ---------------------------------------------------------------------------
// LP concentrée (forks Uniswap V3 sur HyperEVM)

const hyperEvm = defineChain({
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

const npmAbi = parseAbi([
  'function factory() view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);
const factoryAbi = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']);
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
]);
const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

async function checkLps(cfg, address) {
  const lpCfg = cfg.lp || {};
  const managers = lpCfg.positionManagers || [];
  if (!managers.length) return [];
  const nearPct = lpCfg.nearEdgePct ?? 3;

  const client = createPublicClient({
    chain: hyperEvm,
    transport: http(undefined, { retryCount: 4, retryDelay: 1500 }),
    batch: { multicall: { wait: 50 } },
  });
  const read = (address, abi, functionName, args) =>
    retry(() => client.readContract({ address, abi, functionName, args }), `${functionName}@${address}`);

  const tokenCache = new Map();
  const tokenInfo = async (addr) => {
    if (!tokenCache.has(addr)) {
      tokenCache.set(addr, Promise.all([read(addr, erc20Abi, 'symbol'), read(addr, erc20Abi, 'decimals')])
        .then(([symbol, decimals]) => ({ symbol, decimals: Number(decimals) })));
    }
    return tokenCache.get(addr);
  };

  const results = [];
  for (const m of managers) {
    const npm = getAddress(m.address);
    const name = m.name || npm;

    // Découverte automatique des NFT détenus + IDs ajoutés à la main (ex. positions stakées dans une gauge).
    const [factory, balance] = await Promise.all([
      read(npm, npmAbi, 'factory'),
      read(npm, npmAbi, 'balanceOf', [address]),
    ]);
    const owned = await Promise.all(
      Array.from({ length: Number(balance) }, (_, i) => read(npm, npmAbi, 'tokenOfOwnerByIndex', [address, BigInt(i)])),
    );
    const ids = [...new Set([...owned.map(String), ...(m.extraTokenIds || []).map(String)])];
    const ignored = new Set((m.ignoreTokenIds || []).map(String));

    const poolCache = new Map();
    for (const id of ids) {
      if (ignored.has(id)) continue;
      const p = await read(npm, npmAbi, 'positions', [BigInt(id)]);
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p;
      if (liquidity === 0n) continue; // position vidée/fermée

      const poolKey = `${token0}-${token1}-${fee}`;
      if (!poolCache.has(poolKey)) {
        poolCache.set(poolKey, (async () => {
          const pool = await read(factory, factoryAbi, 'getPool', [token0, token1, fee]);
          const [slot0, spacing] = await Promise.all([read(pool, poolAbi, 'slot0'), read(pool, poolAbi, 'tickSpacing')]);
          return { pool, tick: Number(slot0[1]), spacing: Number(spacing) };
        })());
      }
      const [{ tick, spacing }, t0, t1] = await Promise.all([poolCache.get(poolKey), tokenInfo(token0), tokenInfo(token1)]);

      // Prix de token0 exprimé en token1 (ex. USDC par WHYPE).
      const toPrice = (t) => Math.pow(1.0001, t) * 10 ** (t0.decimals - t1.decimals);
      const price = toPrice(tick);
      const min = toPrice(Number(tickLower));
      const max = toPrice(Number(tickUpper));

      // Uniswap V3 : la position est active si tickLower <= tick < tickUpper.
      let level, detail;
      if (tick < Number(tickLower)) {
        level = 'out';
        detail = `prix SOUS la range (100% ${t0.symbol})`;
      } else if (tick >= Number(tickUpper)) {
        level = 'out';
        detail = `prix AU-DESSUS de la range (100% ${t1.symbol})`;
      } else {
        const toMin = ((price - min) / price) * 100;
        const toMax = ((max - price) / price) * 100;
        const closest = Math.min(toMin, toMax);
        const side = toMin < toMax ? 'min' : 'max';
        level = closest <= nearPct ? 'near' : 'ok';
        detail = `in range, à ${fmtPct(closest)} du ${side}`;
      }

      // Suggestion : même largeur de range, recentrée sur le prix actuel (alignée sur le tickSpacing du pool).
      let suggestion;
      if (level !== 'ok') {
        const width = Number(tickUpper) - Number(tickLower);
        const lower = Math.round((tick - width / 2) / spacing) * spacing;
        suggestion = `Nouvelle range suggérée (même largeur, centrée) : ${fmtPrice(toPrice(lower))} → ${fmtPrice(toPrice(lower + width))}`;
      }

      results.push({
        key: `lp:${npm}:${id}`,
        kind: 'lp',
        level,
        label: `${t0.symbol}/${t1.symbol} #${id}`,
        source: `${name} ${Number(fee) / 10000}%`,
        detail,
        line: `Prix ${fmtPrice(price)} ${t1.symbol}/${t0.symbol} | range ${fmtPrice(min)} → ${fmtPrice(max)}`,
        suggestion,
        click: m.url,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Perps Hyperliquid

async function checkPerps(cfg, address) {
  const pc = cfg.perps || {};
  if (pc.enabled === false) return [];
  const warnPct = pc.liqWarnPct ?? 15;
  const dangerPct = pc.liqDangerPct ?? 7;
  const ranges = pc.ranges || {}; // { "BTC": { "min": 90000, "max": 120000 } }

  const [state, mids] = await Promise.all([
    hlInfo({ type: 'clearinghouseState', user: address }),
    hlInfo({ type: 'allMids' }),
  ]);

  const results = [];
  for (const { position: p } of state.assetPositions || []) {
    const size = Number(p.szi);
    if (!size) continue;
    const coin = p.coin;
    const mark = Number(mids[coin] ?? (Number(p.positionValue) / Math.abs(size)));
    const side = size > 0 ? 'LONG' : 'SHORT';
    const liq = p.liquidationPx == null ? null : Number(p.liquidationPx);
    const lev = p.leverage ? `${p.leverage.value}x ${p.leverage.type}` : '';

    let level = 'ok';
    const parts = [];
    if (liq != null && liq > 0) {
      const dist = (Math.abs(mark - liq) / mark) * 100;
      if (dist <= dangerPct) level = 'out';
      else if (dist <= warnPct) level = 'near';
      parts.push(`liquidation à ${fmtPct(dist)} (${fmtPrice(liq)})`);
    } else {
      parts.push('pas de prix de liquidation');
    }

    const r = ranges[coin];
    if (r) {
      if ((r.min != null && mark < r.min) || (r.max != null && mark > r.max)) {
        level = 'out';
        parts.push(`HORS de ta range ${r.min ?? '-∞'} → ${r.max ?? '+∞'}`);
      }
    }

    results.push({
      key: `perp:${coin}:${side}`,
      kind: 'perp',
      level,
      label: `${coin} ${side} ${lev}`.trim(),
      source: 'Hyperliquid perps',
      detail: parts.join(', '),
      line: `Mark ${fmtPrice(mark)} | entrée ${fmtPrice(Number(p.entryPx))} | PnL ${Number(p.unrealizedPnl).toFixed(2)} $`,
      click: 'https://app.hyperliquid.xyz/trade/' + encodeURIComponent(coin),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Notifications

// actions : boutons ntfy (max 3), ex. [{ label: 'HyperSwap', url: 'https://…' }]
async function notify({ title, message, priority = 3, click, actions = [] }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[ntfy désactivé: NTFY_TOPIC absent] ${title}\n${message}${actions.length ? `\n[boutons: ${actions.map((a) => a.label).join(', ')}]` : ''}`);
    return;
  }
  const payload = {
    topic, title, message, priority,
    ...(click ? { click } : {}),
    ...(actions.length ? { actions: actions.slice(0, 3).map((a) => ({ action: 'view', label: a.label, url: a.url, clear: true })) } : {}),
  };
  await retry(async () => {
    const res = await fetch(NTFY_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  }, 'ntfy');
}

const TEXT = {
  lp: {
    out: { title: '🚨 OUT OF RANGE', priority: 5 },
    near: { title: '⚠️ Proche du bord de range', priority: 4 },
    ok: { title: '✅ De retour dans la range', priority: 3 },
  },
  perp: {
    out: { title: '🚨 Liquidation proche', priority: 5 },
    near: { title: '⚠️ Liquidation à surveiller', priority: 4 },
    ok: { title: '✅ Position perp sécurisée', priority: 3 },
  },
};

// Décide s'il faut notifier : aggravation, retour à la normale après un "out",
// ou rappel périodique tant que la position reste "out".
function decide(item, prev, now, cfg) {
  const remindMs = (cfg.remindEveryHours ?? 4) * 3600_000;
  if (!prev) return item.level === 'ok' ? null : 'new';
  if (LEVEL[item.level] > LEVEL[prev.level]) return 'worse';
  if (prev.level === 'out' && item.level !== 'out') return 'recovered';
  if (item.level === 'out' && remindMs > 0 && now - (prev.notifiedAt || 0) >= remindMs) return 'reminder';
  return null;
}

// Heures calmes : config.quietHours = { enabled, start: "23:00", end: "08:00", timezone: "Europe/Paris" }.
function isQuietTime(qh, date = new Date()) {
  if (!qh?.enabled) return false;
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: qh.timezone || 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const now = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  const start = toMin(qh.start ?? '23:00');
  const end = toMin(qh.end ?? '08:00');
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end; // plage qui passe minuit
}

// Pendant les heures calmes, seule la première alerte 🚨 passe (pas les ⚠️, rappels ni retours à la normale).
// Une alerte retenue n'est pas « consommée » : elle part à la fin des heures calmes si la situation dure.
function allowedDuringQuiet(item, reason) {
  return item.level === 'out' && (reason === 'new' || reason === 'worse');
}

// ---------------------------------------------------------------------------

async function main() {
  const cfg = await loadJson(CONFIG_PATH);
  const rawAddress = process.env.WALLET_ADDRESS || cfg.address;
  if (!rawAddress || /^0x0+$/.test(rawAddress)) throw new Error('Adresse manquante (WALLET_ADDRESS ou "address" dans config.json)');
  const address = getAddress(rawAddress.trim());

  if (TEST) {
    await notify({
      title: '🔔 Test Hyperliquid range alert',
      message: `Les notifications fonctionnent pour ${address.slice(0, 6)}…${address.slice(-4)}.`,
      click: cfg.dashboardUrl,
      actions: cfg.dashboardUrl ? [{ label: 'Tableau de bord', url: cfg.dashboardUrl }] : [],
    });
    console.log('Notification de test envoyée.');
    return;
  }

  const state = await loadJson(STATE_PATH, { items: {}, failures: 0 });
  const now = Date.now();

  // Les deux sources sont indépendantes : une panne de l'une ne bloque pas l'autre.
  const sources = await Promise.allSettled([checkLps(cfg, address), checkPerps(cfg, address)]);
  const items = [];
  const errors = [];
  for (const [i, s] of sources.entries()) {
    if (s.status === 'fulfilled') items.push(...s.value);
    else errors.push(`${i === 0 ? 'LP' : 'Perps'}: ${s.reason.message}`);
  }

  for (const it of items) {
    const icon = { ok: '🟢', near: '🟠', out: '🔴' }[it.level];
    console.log(`${icon} [${it.source}] ${it.label} — ${it.detail}\n    ${it.line}`);
  }
  if (!items.length) console.log('Aucune position ouverte détectée.');
  for (const e of errors) console.error(`⚠ ${e}`);

  if (STATUS_ONLY) return;

  const quiet = isQuietTime(cfg.quietHours);
  if (quiet) console.log('(heures calmes : seules les nouvelles alertes 🚨 sont envoyées)');

  const next = { items: {}, failures: errors.length ? (state.failures || 0) + 1 : 0, failureNotified: state.failureNotified };
  for (const it of items) {
    const prev = state.items[it.key];
    const reason = decide(it, prev, now, cfg);
    if (reason && quiet && !allowedDuringQuiet(it, reason)) {
      // On garde l'ancien état tel quel pour que l'alerte parte après les heures calmes si besoin.
      if (prev) next.items[it.key] = prev;
      console.log(`→ notification retenue (heures calmes, ${reason})`);
      continue;
    }
    let notifiedAt = prev?.notifiedAt || 0;
    if (reason) {
      const t = TEXT[it.kind][it.level];
      const prefix = reason === 'reminder' ? '(rappel) ' : '';
      // Le wallet reste sur le PC : sur le téléphone, la notif ouvre le tableau de bord (pas le DEX).
      await notify({
        title: `${prefix}${t.title} — ${it.label}`,
        message: [it.source, it.detail, it.line, it.suggestion].filter(Boolean).join('\n'),
        priority: t.priority,
        click: cfg.dashboardUrl || it.click,
        actions: cfg.dashboardUrl ? [{ label: 'Tableau de bord', url: cfg.dashboardUrl }] : [],
      });
      notifiedAt = now;
      console.log(`→ notification envoyée (${reason})`);
    }
    next.items[it.key] = { level: it.level, notifiedAt };
  }
  // Si une source a planté, on garde l'état précédent de ses positions pour ne pas renotifier au retour.
  if (errors.length) {
    for (const [k, v] of Object.entries(state.items)) if (!(k in next.items)) next.items[k] = v;
  }

  // Alerte si la surveillance elle-même est cassée plusieurs fois de suite (une seule fois).
  const failAfter = cfg.notifyAfterConsecutiveFailures ?? 3;
  if (next.failures >= failAfter && !state.failureNotified) {
    await notify({ title: '❗ Surveillance en échec', message: errors.join('\n'), priority: 4 });
    next.failureNotified = true;
  } else if (next.failures === 0) {
    next.failureNotified = false;
  }

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(next, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
