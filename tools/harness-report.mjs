// ハーネスの使用状況レポート。
//   node tools/harness-report.mjs                  … 全期間
//   node tools/harness-report.mjs --since 2026-09-01
//   node tools/harness-report.mjs --file path/to/harness.jsonl
//
// 見るべき数字は3つだけ:
//   cached%  … プロンプトキャッシュ命中率。0%に張り付いていたらプレフィックスが壊れている
//   ttfb     … 最初の1文字が出るまで(体感レイテンシ)。total より重要
//   stage    … どの段がトークンを食っているか
import { readFileSync } from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const FILE = arg('--file', new URL('../logs/harness.jsonl', import.meta.url).pathname.replace(/^\//, ''));
const SINCE = arg('--since', null);

let lines;
try {
  lines = readFileSync(FILE, 'utf8').trim().split('\n');
} catch (e) {
  console.error(`ログが読めない: ${FILE} (${e.code})`);
  process.exit(1);
}

const rows = lines
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  // モック/テストの行は実トラフィックではないので外す
  .filter((r) => r.model !== 'mock-model' && (r.latencyMs ?? 0) > 500)
  .filter((r) => !SINCE || r.ts >= SINCE);

if (!rows.length) {
  console.log('対象データなし');
  process.exit(0);
}

const pc = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const med = (a, f) => pc(a.map(f).filter((n) => n != null).sort((x, y) => x - y), 0.5);
const p90 = (a, f) => pc(a.map(f).filter((n) => n != null).sort((x, y) => x - y), 0.9);
const sum = (a, f) => a.reduce((s, r) => s + (f(r) ?? 0), 0);

const fmt = (n) => Math.round(n).toLocaleString();
const secs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

const table = (title, groups) => {
  console.log(`\n=== ${title} ===`);
  console.log('mode        n    tok中央  tok合計   cached%  ttfb中央  total中央  totalP90');
  for (const [key, a] of groups) {
    const cachedRatio = sum(a, (r) => r.inputTokens) > 0
      ? (sum(a, (r) => r.cachedTokens) / sum(a, (r) => r.inputTokens)) * 100
      : null;
    console.log(
      key.padEnd(11),
      String(a.length).padStart(3),
      fmt(med(a, (r) => r.tokens)).padStart(8),
      fmt(sum(a, (r) => r.tokens)).padStart(8),
      (cachedRatio == null ? 'n/a' : `${cachedRatio.toFixed(0)}%`).padStart(9),
      secs(med(a.filter((r) => r.ttfbMs != null), (r) => r.ttfbMs) || null).padStart(9),
      secs(med(a, (r) => r.latencyMs)).padStart(10),
      secs(p90(a, (r) => r.latencyMs)).padStart(9),
    );
  }
};

const byMode = new Map();
for (const r of rows) {
  const k = r.mode ?? 'unknown';
  if (!byMode.has(k)) byMode.set(k, []);
  byMode.get(k).push(r);
}
table(`実トラフィック ${rows.length}ターン (${rows[0].ts.slice(0, 10)} → ${rows[rows.length - 1].ts.slice(0, 10)})`,
  [...byMode.entries()].sort((a, b) => b[1].length - a[1].length).concat([['ALL', rows]]));

// --- 段ごとの内訳(新しいログにしか入っていない) ---
const staged = rows.filter((r) => r.stageTokens && Object.keys(r.stageTokens).length);
if (staged.length) {
  const acc = {};
  for (const r of staged) {
    for (const [k, v] of Object.entries(r.stageTokens)) acc[k] = (acc[k] ?? 0) + v;
  }
  const total = Object.values(acc).reduce((s, v) => s + v, 0);
  console.log(`\n=== 段ごとのトークン (${staged.length}ターン) ===`);
  for (const [k, v] of Object.entries(acc).sort((a, b) => b[1] - a[1])) {
    console.log(`${k.padEnd(10)} ${fmt(v).padStart(9)}  ${((v / total) * 100).toFixed(1)}%`);
  }
  const inTok = sum(staged, (r) => r.inputTokens);
  const cached = sum(staged, (r) => r.cachedTokens);
  console.log(`\n入力 ${fmt(inTok)} / うちキャッシュ済み ${fmt(cached)} = ${inTok ? ((cached / inTok) * 100).toFixed(1) : 0}%`);
  console.log(`出力 ${fmt(sum(staged, (r) => r.outputTokens))} / うち推論 ${fmt(sum(staged, (r) => r.reasoningTokens))}`);
  console.log(`平均API往復 ${(sum(staged, (r) => r.apiCalls) / staged.length).toFixed(1)}回/ターン`);
} else {
  console.log('\n(段ごとの内訳なし = 計測レイヤ導入前のログ)');
}

// --- 品質側の指標。コストを削った結果ここが落ちていないかを必ず併せて見る ---
const deep = rows.filter((r) => r.surprise != null);
console.log('\n=== 品質(落ちていないかの確認用) ===');
console.log(`回答できた率      ${((rows.filter((r) => r.answered).length / rows.length) * 100).toFixed(1)}%`);
console.log(`拒否             ${rows.filter((r) => r.outcome === 'refused').length}`);
console.log(`改稿された        ${rows.filter((r) => r.revised).length}`);
if (deep.length) {
  console.log(`surprise中央値    ${med(deep, (r) => r.surprise)}  concrete中央値 ${med(deep, (r) => r.concrete)}  (n=${deep.length})`);
}
