import { readFileSync, writeFileSync } from 'node:fs';

// gptsol共有状態: モデル切替(/model) + 日次トークン集計(モデル別、UTC日付)
export const MODELS = {
  sol: { id: 'gpt-5.6-sol', limit: 250_000, desc: '高性能・重い推論用' },
  terra: { id: 'gpt-5.6-terra', limit: 2_500_000, desc: '軽量・日常会話用' },
};
export const DEFAULT_ALIAS = 'terra';

const MODEL_FILE = new URL('../gptsol-model.json', import.meta.url);
const USAGE_FILE = new URL('../gptsol-usage.json', import.meta.url);
const WARN_RATIO = 0.9;

export function currentAlias() {
  try {
    const a = JSON.parse(readFileSync(MODEL_FILE, 'utf8')).alias;
    return MODELS[a] ? a : DEFAULT_ALIAS;
  } catch {
    return DEFAULT_ALIAS;
  }
}

export function setAlias(alias) {
  writeFileSync(MODEL_FILE, JSON.stringify({ alias }));
}

function load() {
  let u = {};
  try { u = JSON.parse(readFileSync(USAGE_FILE, 'utf8')); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  if (u.date !== today || !u.totals) u = { date: today, totals: {}, warned: {} };
  return u;
}

export function addUsage(alias, n) {
  const u = load();
  u.totals[alias] = (u.totals[alias] ?? 0) + n;
  const limit = MODELS[alias]?.limit ?? Infinity;
  const warn = !u.warned[alias] && u.totals[alias] >= limit * WARN_RATIO;
  if (warn) u.warned[alias] = true;
  writeFileSync(USAGE_FILE, JSON.stringify(u));
  return { warn, total: u.totals[alias], limit };
}

export function usageToday() {
  const u = load();
  return { date: u.date, totals: u.totals };
}
