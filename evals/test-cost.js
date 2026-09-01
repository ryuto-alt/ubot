// コスト/レイテンシ設計の回帰テスト。APIキー不要。
//   node evals/test-cost.js
//
// ここで守っているのは「品質」ではなく「同じ品質のまま安く速く保つための構造」:
//   - instructions は毎ターン完全一致(プロンプトキャッシュのプレフィックスを壊さない)
//   - 可変の指示は input 末尾の developer メッセージへ
//   - 履歴は1件ずつではなくブロックで捨てる
//   - 下書きはストリームで先に出し、批評/改稿は送信後に回す
// このどれかが壊れると、テストは通るのに課金だけ数倍になる。だから配線として固定する。
import assert from 'node:assert/strict';
import { buildInstructions, buildTurnNote, chat } from '../src/harness/index.js';
import { HISTORY_KEEP, HISTORY_MAX, trimHistory } from '../src/harness/history.js';
import { cachedRatio, makeMeter, meter } from '../src/harness/meter.js';
import { reset } from '../src/harness/ledger.js';
import { makeMock } from './mock.js';

const MODEL = 'mock-model';
let pass = 0;
const fail = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail.push(name);
    console.log(`❌ ${name}\n   ${e.message}`);
  }
}

const ask = (content, transport, extra = {}) =>
  chat({ input: [{ role: 'user', content }], model: MODEL, transport, ...extra });

const devNote = (body) =>
  (Array.isArray(body.input) ? body.input.filter((m) => m.role === 'developer') : [])
    .map((m) => m.content).join('\n');

// --- A. プロンプトキャッシュのプレフィックス ---

await t('instructions は分類結果が変わっても同一(キャッシュのプレフィックスを壊さない)', () => {
  const a = buildInstructions({ persona: 'ペルソナ', mode: 'normal' });
  const b = buildInstructions({ persona: 'ペルソナ', mode: 'normal' });
  assert.equal(a, b);
  // 可変になりうるものが混ざっていないこと
  assert.doesNotMatch(a, /Today's date is/, '日付が固定側に入るとキャッシュが日をまたいで壊れる');
  assert.doesNotMatch(a, /App-side context signal/, '分類結果は固定側に入れてはいけない');
  assert.doesNotMatch(a, /ALREADY SPENT/, '候補角度は固定側に入れてはいけない');
});

await t('persona は craft note より前(短く返せより作法を優先させる並び)', () => {
  const s = buildInstructions({ persona: 'PERSONA_MARK', mode: 'philosophy' });
  assert.ok(s.indexOf('PERSONA_MARK') < s.indexOf('Craft note'), '並びが逆になっている');
});

await t('可変分はターンノートに集約され、実際に input 末尾の developer へ載る', async () => {
  reset();
  const note = buildTurnNote({ classification: 'clearly_benign', moderation: null });
  assert.match(note, /Today's date is/);
  assert.match(note, /App-side context signal/);

  let mainBody = null;
  const mock = makeMock({ onCall: (kind, body) => { if (kind === 'main') mainBody = body; } });
  await ask('おはよう', mock);
  assert.ok(mainBody, '本応答が呼ばれていない');
  const last = mainBody.input[mainBody.input.length - 1];
  assert.equal(last.role, 'developer', '可変分は input の末尾でなければキャッシュを壊す');
  assert.match(devNote(mainBody), /App-side context signal/);
});

await t('同じ会話なら instructions が2ターン目もバイト単位で一致する', async () => {
  reset();
  const seen = [];
  const mock = makeMock({ onCall: (kind, body) => { if (kind === 'main') seen.push(body.instructions); } });
  const persona = 'ペルソナ本文';
  await chat({ input: [{ role: 'user', content: 'おはよう' }], model: MODEL, transport: mock, persona, conversation: 'c1' });
  await chat({ input: [{ role: 'user', content: '今日なにする?' }], model: MODEL, transport: mock, persona, conversation: 'c1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], '2ターン目で instructions が変わるとキャッシュが毎回捨てられる');
});

await t('prompt_cache_key が会話ごとに付く', async () => {
  reset();
  let mainBody = null;
  const mock = makeMock({ onCall: (kind, body) => { if (kind === 'main') mainBody = body; } });
  await ask('おはよう', mock, { conversation: 'conv-x' });
  assert.equal(mainBody.prompt_cache_key, 'ubot:conv-x');
});

// --- B. 履歴 ---

await t('履歴は1件ずつではなくブロックで落ちる(先頭が数ターン動かない)', () => {
  const hist = Array.from({ length: HISTORY_MAX }, (_, i) => ({ role: 'user', content: `m${i}` }));
  hist.push({ role: 'user', content: 'new' });
  trimHistory(hist);
  assert.equal(hist.length, HISTORY_KEEP, `${HISTORY_KEEP}件まで一気に落とすはず`);
  const head = hist[0].content;
  // 以後しばらくは先頭が動かない = プレフィックスが生き続ける
  for (let i = 0; i < HISTORY_MAX - HISTORY_KEEP - 1; i++) {
    hist.push({ role: 'user', content: `x${i}` });
    trimHistory(hist);
    assert.equal(hist[0].content, head, `${i + 1}ターン後に先頭が動いた(キャッシュが毎回壊れる)`);
  }
});

await t('文字数上限を超えたら余裕を持って削る(毎ターンぎりぎりを削らない)', () => {
  const big = 'あ'.repeat(3000);
  const hist = Array.from({ length: 6 }, () => ({ role: 'user', content: big }));
  trimHistory(hist);
  const total = hist.reduce((s, m) => s + m.content.length, 0);
  assert.ok(total <= 12_000, `上限を超えている: ${total}`);
  assert.ok(total <= 9_000, `ぎりぎりまでしか削れていない(次ターンでまた削れて先頭が動き続ける): ${total}`);
});

// --- C/E. 補助レイヤのモデルとツール設定 ---

await t('tools は関数で渡せて、mode ごとに解決される', async () => {
  reset();
  const seen = {};
  const mock = makeMock({ onCall: (kind, body) => { if (kind === 'main') seen.tools = body.tools; } });
  const toolsFor = (mode) => [{ type: 'web_search', search_context_size: mode === 'archive' ? 'high' : 'low' }];

  await ask('おはよう', mock, { tools: toolsFor });
  assert.equal(seen.tools[0].search_context_size, 'low', '雑談で検索を厚く取り込むと無駄に高い');

  await ask('この都市伝説の初出っていつ?', mock, { tools: toolsFor });
  assert.equal(seen.tools[0].search_context_size, 'high', 'archive は裏取りが命なので厚く取る');
});

await t('分類は classifierModel、発散/批評は auxModel で回る', async () => {
  reset();
  const models = {};
  const mock = makeMock({ onCall: (kind, body) => { models[kind] = body.model; } });
  await chat({
    input: [{ role: 'user', content: '自由意志ってあると思う?' }],
    model: 'main-model', classifierModel: 'cheap-model', auxModel: 'cheap-model', transport: mock,
  });
  assert.equal(models.classify, 'cheap-model', '分類が本応答と同じモデルで回ると毎ターン高い');
  assert.equal(models.angles, 'cheap-model');
  assert.equal(models.critique, 'cheap-model');
  assert.equal(models.main, 'main-model');
});

// --- D. ストリーム ---

await t('ストリーム対応の transport なら途中経過が流れ、最後は最終文と一致する', async () => {
  reset();
  const seen = [];
  const mock = makeMock({ withStream: true });
  const { text, telemetry } = await ask('おはよう', mock, { onProgress: (s) => seen.push(s) });
  assert.ok(seen.length > 1, '途中経過が1回しか来ていない(ストリームできていない)');
  assert.equal(seen[seen.length - 1], text, '最後の途中経過が最終文と一致していない');
  assert.ok(seen[0].length < text.length, '最初から全文が来ている');
  assert.equal(telemetry.streamed, true);
  assert.ok(telemetry.ttfbMs !== null, '体感レイテンシ(ttfb)が記録されていない');
});

await t('onProgress を渡さなければ従来どおり(ストリームしない)', async () => {
  reset();
  const mock = makeMock({ withStream: true });
  const { text, telemetry } = await ask('おはよう', mock);
  assert.ok(text.length > 0);
  assert.equal(telemetry.streamed, false);
});

await t('ストリームが落ちても非ストリームへフォールバックして回答が返る', async () => {
  reset();
  const mock = makeMock({ withStream: true, streamFails: true });
  const { text } = await ask('おはよう', mock, { onProgress: () => {} });
  assert.match(text, /通常どおり/, 'ストリーム障害で回答が消えている');
});

await t('改稿されたら、表示済みの下書きが最終文へ差し替えられる', async () => {
  reset();
  const seen = [];
  const mock = makeMock({
    withStream: true,
    critique: { surprise: 1, formulaic: true, verdict: 'revise', fix: '骨格から組み直す' },
  });
  const { text } = await ask('自由意志ってあると思う?', mock, { onProgress: (s) => seen.push(s) });
  assert.match(text, /改稿版/);
  assert.equal(seen[seen.length - 1], text, '改稿後に画面が更新されていない');
  // 下書きが先に出ている = 批評/改稿は体感レイテンシに乗っていない
  assert.ok(seen.some((s) => /通常どおり/.test(s)), '下書きが送信前に表示されていない');
});

// --- F. 計量 ---

await t('テレメトリにトークンの内訳が残る', async () => {
  reset();
  const mock = makeMock();
  const { telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.ok(telemetry.tokens > 0);
  assert.ok(telemetry.inputTokens > 0, '入力トークンが取れていない');
  assert.ok(telemetry.cachedRatio > 0, 'キャッシュ率が取れていない(改善が測れない)');
  assert.ok(telemetry.apiCalls >= 3, `発散+本応答+批評で3往復以上のはず: ${telemetry.apiCalls}`);
  assert.ok(telemetry.stageTokens.main > 0, '段ごとの内訳が無いとどこが重いか分からない');
  assert.ok(telemetry.stageTokens.classify > 0);
  assert.ok(typeof telemetry.stageMs.main === 'number');
});

await t('meter は usage が無くても落ちない(fail-soft)', () => {
  const m = makeMeter();
  meter(m, 'main', {}, 10);
  meter(m, 'main', null, 10);
  meter(m, 'main', { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80 } } }, 10);
  assert.equal(m.total, 110);
  assert.equal(cachedRatio(m), 0.8);
  assert.equal(m.calls, 3);
});

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) {
  console.log('失敗:', fail.join(', '));
  process.exit(1);
}
