// 品質レイヤ(発散 / 批評 / 反復回避台帳)の配線テスト。APIキー不要。
//   node evals/test-quality.js
//
// ここで検証するのは「配線と分岐」であって、実際に面白くなったかではない。
// 面白さは実モデルでしか測れないので、それは logs/harness.jsonl の surprise で追う。
import assert from 'node:assert/strict';
import { chat } from '../src/harness/index.js';
import { needsRevision } from '../src/harness/critic.js';
import { recall, reset } from '../src/harness/ledger.js';
import { angleNote, avoidNote, reviseNote } from '../src/harness/policy.js';
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

// 可変の指示はキャッシュを守るため input 末尾の developer メッセージに載る
const devNote = (body) =>
  (Array.isArray(body.input) ? body.input.filter((msg) => msg.role === 'developer') : [])
    .map((msg) => msg.content).join('\n');

const ask = (content, transport, extra = {}) =>
  chat({ input: [{ role: 'user', content }], model: MODEL, transport, ...extra });

// --- 発散レイヤ ---

await t('philosophy では発散レイヤが走り、候補角度がターンノートに載る', async () => {
  reset();
  const calls = [];
  let mainNote = '';
  const mock = makeMock({
    onCall: (kind, body) => {
      calls.push(kind);
      if (kind === 'main') mainNote = devNote(body);
    },
  });
  const { telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.ok(calls.includes('angles'), '発散が呼ばれていない');
  assert.ok(calls.indexOf('angles') < calls.indexOf('main'), '発散は本応答より前に走る必要がある');
  assert.match(mainNote, /ALREADY SPENT/, '平凡な枠組みが本応答に渡っていない');
  assert.match(mainNote, /Candidate angles/, '候補角度が本応答に渡っていない');
  assert.equal(telemetry.angles, 4);
});

await t('normal(雑談)では発散も批評も走らない', async () => {
  reset();
  const calls = [];
  const mock = makeMock({ onCall: (k) => calls.push(k) });
  const { telemetry } = await ask('おはよう', mock);
  assert.ok(!calls.includes('angles'), '雑談で発散が走っている(遅くて高いだけ)');
  assert.ok(!calls.includes('critique'), '雑談で批評が走っている');
  assert.equal(telemetry.angles, 0);
  assert.equal(telemetry.surprise, null);
});

await t('archive でも発散と批評が走る', async () => {
  reset();
  const calls = [];
  const mock = makeMock({ onCall: (k) => calls.push(k) });
  await ask('この都市伝説の初出っていつ?', mock);
  assert.ok(calls.includes('angles') && calls.includes('critique'));
});

await t('発散が落ちても回答は返る(fail-soft)', async () => {
  reset();
  const mock = makeMock({ failAngles: true });
  const { text, telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.ok(text.length > 0, '発散の失敗で回答が消えている');
  assert.equal(telemetry.angles, 0);
});

// --- 批評レイヤ ---

await t('ship 判定なら改稿しない', async () => {
  reset();
  const calls = [];
  const mock = makeMock({ onCall: (k) => calls.push(k) });
  const { text, telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.ok(!calls.includes('revise'), 'ship なのに改稿が走っている');
  assert.equal(telemetry.revised, false);
  assert.match(text, /通常どおり/);
});

await t('平凡(surprise低・formulaic)なら1回だけ改稿する', async () => {
  reset();
  const calls = [];
  const mock = makeMock({
    onCall: (k) => calls.push(k),
    critique: { surprise: 1, formulaic: true, verdict: 'revise', fix: '三択の羅列を切って、参照クラス問題1点に絞る' },
  });
  const { text, telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.match(text, /改稿版/, '改稿結果が採用されていない');
  assert.equal(telemetry.revised, true);
  assert.equal(calls.filter((k) => k === 'revise').length, 1, '改稿は1回だけのはず');
});

await t('事実の問題があれば surprise が高くても改稿する', async () => {
  reset();
  const mock = makeMock({
    critique: { problems: ['存在しない論文を引用している'], surprise: 5, concrete: 5, verdict: 'ship', fix: '' },
  });
  const { telemetry } = await ask('自由意志ってあると思う?', mock);
  assert.equal(telemetry.revised, true, '事実の問題は verdict より優先されるべき');
});

await t('批評が落ちても下書きが返る(fail-soft)', async () => {
  reset();
  const mock = makeMock();
  const orig = mock.responses.bind(mock);
  mock.responses = async (body) => {
    if (/quality gate/.test(body.instructions ?? '')) throw new Error('critique down');
    return orig(body);
  };
  const { text } = await ask('自由意志ってあると思う?', mock);
  assert.match(text, /通常どおり/, '批評の失敗で回答が消えている');
});

await t('needsRevision: fix も problems も無い revise は空回りさせない', () => {
  assert.equal(needsRevision({ problems: [], surprise: 1, concrete: 1, formulaic: true, verdict: 'revise', fix: '' }), false);
  assert.equal(needsRevision({ problems: [], surprise: 1, concrete: 4, formulaic: false, verdict: 'revise', fix: 'これを切れ' }), true);
  assert.equal(needsRevision({ problems: ['嘘'], surprise: 5, concrete: 5, formulaic: false, verdict: 'ship', fix: '' }), true);
  assert.equal(needsRevision(null), false);
});

// --- 反復回避台帳(システムハーネス) ---

await t('使った骨格と具体物が台帳に積まれ、次のターンで避けさせる', async () => {
  reset();
  const conversation = 'conv-test';
  let secondNote = '';
  let turn = 0;
  const mock = makeMock({
    onCall: (kind, body) => {
      if (kind === 'main') {
        turn++;
        if (turn === 2) secondNote = devNote(body);
      }
    },
  });
  await ask('自由意志ってあると思う?', mock, { conversation });
  const led = recall(conversation);
  assert.deepEqual(led.shapes, ['前提を1つ外して壊れ方を見る']);
  assert.deepEqual(led.anchors, ['ボルツマン脳']);

  await ask('意識ってなんで存在するんだろう', mock, { conversation });
  assert.match(secondNote, /Skeletons you have already used/, '骨格の回避指示が渡っていない');
  assert.match(secondNote, /ボルツマン脳/, '使用済みの具体物が渡っていない');
});

await t('台帳はチャンネルごとに分かれる', async () => {
  reset();
  const mock = makeMock();
  await ask('自由意志ってあると思う?', mock, { conversation: 'conv-a' });
  assert.equal(recall('conv-b').shapes.length, 0, '別チャンネルに漏れている');
  assert.equal(recall(null).shapes.length, 0, 'conversation 無しで積んではいけない');
});

// --- 指示文の組み立て ---

await t('angleNote は anchor を「未検証の手がかり」として渡す', () => {
  const note = angleNote({
    obvious: 'ありがちな枠組み',
    angles: [{ claim: 'X', kind: 'empirical', anchor: 'ある論文', risk: 'Y' }],
  });
  assert.match(note, /ALREADY SPENT/);
  assert.match(note, /confirm it with the web_search tool/, '裏取り指示が無いと捏造が下流に流れる');
  assert.match(note, /at most one or two/, '4つ全部なぞらせない指示が要る');
});

await t('angleNote / avoidNote は材料が無ければ空を返す', () => {
  assert.equal(angleNote(null), '');
  assert.equal(angleNote({ obvious: '', angles: [] }), '');
  assert.equal(avoidNote(null), '');
  assert.equal(avoidNote({ shapes: [], anchors: [] }), '');
});

await t('reviseNote は長さを要求せず、パイプラインの存在も明かさない', () => {
  const note = reviseNote({ problems: ['嘘がある'], surprise: 1, concrete: 1, stance: false, formulaic: true, fix: 'ここを切れ' });
  assert.match(note, /mandatory fixes/);
  assert.match(note, /do not make it longer/);
  assert.match(note, /Do not mention this critique/);
  assert.doesNotMatch(note, /\bexpand\b/i);
});

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) {
  console.log('失敗:', fail.join(', '));
  process.exit(1);
}
