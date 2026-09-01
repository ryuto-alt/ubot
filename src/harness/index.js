import { DIVERGE_MODES, angles } from './angles.js';
import { classify } from './classify.js';
import { critique, needsRevision } from './critic.js';
import { recall, record } from './ledger.js';
import { logTurn } from './log.js';
import { cachedRatio, makeMeter, meter } from './meter.js';
import { moderate } from './moderation.js';
import {
  ANSWER_FIRST, FRESH_INFO_NOTE, MODERATION_NOTE, RECOVERY_NOTE,
  angleNote, avoidNote, contextNote, dateNote, modeNote, reviseNote,
} from './policy.js';
import { looksLikeRefusal } from './refusal.js';
import { openaiTransport } from './transport.js';

// answer-first チャットハーネス(OpenAI Responses API)
//
// パイプライン:
//   1. 分類 / モデレーション            … 何を訊かれているか
//   2. 発散(philosophy/archive のみ)     … 平凡な枠組みを名指しし、候補角度を作る
//   3. 本応答 + ツールループ(可能ならストリーム)
//   4. 拒否の再評価(最大1回)
//   5. 批評 → 改稿(最大1回、philosophy/archive のみ)
//   6. 反復回避台帳に骨格と具体物を記録  … 次のターンで同じ手を避けさせる
//
// 設計上の約束:
//  - ユーザー入力は verbatim でモデルへ渡す。分類器は label を出すだけで書き換えない
//  - 再評価も改稿も最大1回。表現を変えて突破を狙う再送はしない
//  - プロバイダ側の安全機構は無効化も回避もしない
//  - 追加レイヤは全部 fail-soft。落ちたら素通りして会話は続ける
//
// コスト設計(ここが崩れると、同じ品質のまま課金だけ数倍になる):
//  - instructions は「毎ターン完全に同じ文字列」に保つ。プロバイダの自動プロンプト
//    キャッシュは先頭からの完全一致プレフィックスにしか効かないので、可変の文言を
//    1つでも前に混ぜると persona と craft note(合計で数千トークン)が永久に
//    キャッシュされない。可変分は必ず input 末尾の developer メッセージへ置く
//  - 品質レイヤ(発散・批評)は消さない。消すのではなく、ストリームで下書きを先に
//    見せてから後ろで回すことで、体感レイテンシから外す

export function extractText(res) {
  return (res.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('')
    .trim();
}

// 毎ターン同じになる部分だけ。ここに可変の文言を足さないこと(キャッシュが死ぬ)
export function buildInstructions({ persona, mode }) {
  // 作法の指示はペルソナの後ろに置く(「短く返せ」より優先させたい)
  return [ANSWER_FIRST, persona, modeNote(mode)].filter(Boolean).join('\n\n');
}

// ターンごとに変わる分。input の末尾に developer として積む(= プレフィックスを壊さない)
export function buildTurnNote({ classification, moderation, needsFreshInfo, angleSet, avoid }) {
  const parts = [dateNote(), contextNote(classification)];
  if (moderation?.categories?.length) parts.push(MODERATION_NOTE + moderation.categories.join(', '));
  if (needsFreshInfo) parts.push(FRESH_INFO_NOTE);
  // 探索の材料は最後。「どう書くか」より「何を書くか」を最後に読ませる
  const ang = angleNote(angleSet);
  if (ang) parts.push(ang);
  const av = avoidNote(avoid);
  if (av) parts.push(av);
  return parts.join('\n\n');
}

// 怖い話・哲学・資料掘りだけ推論を厚くする。日常会話まで上げると遅くて高いだけ。
// ponytail: 2段階で十分。細かいチューニングは効果を測ってから
function effortFor(mode) {
  return mode === 'horror' || mode === 'philosophy' || mode === 'archive' ? 'high' : undefined;
}

export async function chat({
  input,                       // [{role, content}] 最後がユーザー発言(書き換え禁止)
  model,
  classifierModel = model,
  auxModel = classifierModel,  // 発散・批評は安いモデルで回す(本応答が sol でも terra)
  tools = [],                  // 配列、または (mode) => 配列(モード別にツール設定を変える)
  runTool,                     // async (name, argsObject) => string
  persona = '',
  transport = openaiTransport,
  maxToolRounds = 3,
  conversation = null,         // 匿名化済みID
  useModeration = true,
  useClassifier = true,
  useDivergence = true,
  useCritic = true,
  onProgress = null,           // (fullText) => void 途中経過。毎回「現時点の全文」を渡す
  useStreaming = true,         // transport が stream を持つときだけ有効
}) {
  const started = Date.now();
  const userText = [...input].reverse().find((m) => m.role === 'user')?.content ?? '';
  const m = makeMeter();
  let toolRounds = 0;
  let refused = false;
  let retried = false;
  let ttfbMs = null;

  // --- 途中経過の配線。ツールを挟んで書き直しになったらラウンド頭でリセットする ---
  const canStream = Boolean(useStreaming && onProgress && typeof transport.stream === 'function');
  let roundText = '';
  const show = (text) => {
    if (!onProgress || !text) return;
    try {
      onProgress(text);
    } catch (e) {
      console.error('[harness] onProgress失敗:', e.message);
    }
  };
  const onDelta = (delta) => {
    if (ttfbMs === null) ttfbMs = Date.now() - started;
    roundText += delta;
    show(roundText);
  };

  // 全API呼び出しはここを通す(計量とストリームの分岐を1箇所に集める)
  const call = async (stage, body, { streamed = false } = {}) => {
    const t0 = Date.now();
    let res;
    if (streamed && canStream) {
      roundText = '';
      try {
        res = await transport.stream(body, onDelta);
      } catch (e) {
        // 400番台(安全機構のブロック等)はそのまま上へ。それ以外は非ストリームへ落ちる
        if (e.status >= 400 && e.status < 500) throw e;
        console.error('[harness] streamフォールバック:', e.message);
        res = await transport.responses(body);
      }
    } else {
      res = await transport.responses(body);
    }
    meter(m, stage, res, Date.now() - t0);
    return res;
  };

  // 補助レイヤ(classify/angles/critique)は自前でAPIを叩くので、usage だけ受け取って計量する
  const meterAux = (stage, usage, t0) => meter(m, stage, { usage }, Date.now() - t0);

  // --- 1. 分類 & モデレーション(どちらも失敗しても会話は続行する) ---
  const clsStart = Date.now();
  const [cls, mod] = await Promise.all([
    useClassifier
      ? classify(userText, { model: classifierModel, transport }).catch((e) => {
          console.error('[harness] classify失敗:', e.message);
          return null;
        })
      : null,
    useModeration
      ? moderate(userText, { transport }).catch((e) => {
          console.error('[harness] moderation失敗:', e.message);
          return null;
        })
      : null,
  ]);
  meterAux('classify', cls?.usage, clsStart);
  const classification = cls?.classification ?? 'unknown';
  const mode = cls?.mode ?? 'normal';
  const effort = effortFor(mode);
  const reasoning = effort ? { reasoning: { effort } } : {};
  const deep = DIVERGE_MODES.has(mode);
  const toolList = typeof tools === 'function' ? tools(mode) : tools;

  // 計量値をテレメトリ形へ。どの分岐から抜けても同じ内訳が残るように1箇所にまとめる
  const usageFields = () => ({
    tokens: m.total,
    inputTokens: m.input,
    cachedTokens: m.cached,
    cachedRatio: cachedRatio(m),
    outputTokens: m.output,
    reasoningTokens: m.reasoning,
    apiCalls: m.calls,
    stageTokens: m.stageTokens,
    stageMs: m.stageMs,
  });

  // アプリの取扱範囲外だけはここで断る(単語フィルタではなくカテゴリ判断)
  if (mod?.hardDecline) {
    const telemetry = logTurn({
      conversation, classification, mode, model,
      moderationFlagged: true, moderationCategories: mod.categories,
      refused: true, retried: false, answered: false, outcome: 'app_declined',
      inputChars: userText.length, outputChars: 0,
      ...usageFields(),
      latencyMs: Date.now() - started,
    });
    return { text: 'その内容はこのアプリでは扱えない。', telemetry };
  }

  // --- 2. 発散(メタハーネス前段)。深い型のときだけ、探索を1段外に出す ---
  let angleSet = null;
  if (deep && useDivergence) {
    const t0 = Date.now();
    angleSet = await angles(userText, { model: auxModel, transport }).catch((e) => {
      console.error('[harness] angles失敗:', e.message);
      return null;
    });
    meterAux('angles', angleSet?.usage, t0);
  }
  const avoid = deep ? recall(conversation) : null;

  const instructions = buildInstructions({ persona, mode });
  const turnNote = buildTurnNote({
    classification, moderation: mod, needsFreshInfo: cls?.needsFreshInfo, angleSet, avoid,
  });

  // 固定プレフィックス + 可変分は末尾。prompt_cache_key で同じ会話を同じキャッシュへ寄せる
  const base = () => ({
    model,
    instructions,
    ...reasoning,
    ...(toolList.length ? { tools: toolList } : {}),
    ...(conversation ? { prompt_cache_key: `ubot:${conversation}` } : {}),
  });

  // --- 3. 本応答 + ツールループ ---
  const mainInput = turnNote ? [...input, { role: 'developer', content: turnNote }] : input;
  let res;
  try {
    res = await call('main', { ...base(), input: mainInput }, { streamed: true });
  } catch (e) {
    // プロバイダ側の安全機構がプロンプト段階でブロック(400 invalid_prompt など)。
    // これは回避しない。例外を投げる代わりにきれいな辞退文を返す。
    if (e.status === 400 && /content|policy|invalid_prompt|safety|flagged/i.test(e.message)) {
      const telemetry = logTurn({
        conversation, classification, mode, model,
        moderationFlagged: Boolean(mod?.flagged), moderationCategories: mod?.categories ?? [],
        refused: true, retried: false, answered: false, outcome: 'provider_blocked',
        inputChars: userText.length, outputChars: 0,
        ...usageFields(),
        latencyMs: Date.now() - started,
      });
      return { text: 'その依頼はさすがに無理。他のことなら手伝うよ。', telemetry };
    }
    throw e;
  }

  for (let i = 0; i < maxToolRounds; i++) {
    const calls = (res.output ?? []).filter((o) => o.type === 'function_call');
    if (!calls.length) break;
    toolRounds++;
    const outputs = [];
    for (const c of calls) {
      const result = runTool ? await runTool(c.name, JSON.parse(c.arguments || '{}')) : 'ツール未実装';
      outputs.push({ type: 'function_call_output', call_id: c.call_id, output: String(result) });
    }
    res = await call('tool', {
      ...base(), input: outputs, previous_response_id: res.id,
    }, { streamed: true });
  }

  let text = extractText(res);
  let lastId = res.id;

  // --- 4. Refusal recovery(1回だけ。原文はそのまま、言い換え再送はしない) ---
  if (looksLikeRefusal(text)) {
    refused = true;
    retried = true;
    try {
      const retry = await call('recovery', {
        ...base(),
        input: [{ role: 'developer', content: RECOVERY_NOTE }],
        previous_response_id: lastId,
      }, { streamed: true });
      // 再評価後の判断を採用する。まだ拒否ならそれがモデルの結論なので押し切らない
      const retryText = extractText(retry);
      if (retryText) {
        text = retryText;
        lastId = retry.id;
      }
    } catch (e) {
      console.error('[harness] recovery失敗:', e.message);
    }
  }

  const stillRefusing = looksLikeRefusal(text);

  // ここで下書きは完成。ストリームしていればユーザーはもう読み始めている。
  // 以降の品質レイヤは「送信後」に回るので、体感レイテンシには乗らない。
  if (!canStream) show(text);

  // --- 5. 批評 → 改稿(メタハーネス後段。深い型 & 回答できているときだけ) ---
  let crit = null;
  let revised = false;
  if (deep && useCritic && text && !stillRefusing) {
    const t0 = Date.now();
    crit = await critique({ question: userText, draft: text, model: auxModel, transport }).catch((e) => {
      console.error('[harness] critique失敗:', e.message);
      return null;
    });
    meterAux('critique', crit?.usage, t0);

    if (needsRevision(crit)) {
      try {
        // 改稿はストリームしない。表示済みの下書きが1文字ずつ書き換わると読みにくい
        const rev = await call('revise', {
          ...base(),
          input: [{ role: 'developer', content: reviseNote(crit) }],
          previous_response_id: lastId,
        });
        const revText = extractText(rev);
        // 改稿が空/拒否になったら下書きを採用する。品質ゲートで会話を壊さない
        if (revText && !looksLikeRefusal(revText)) {
          text = revText;
          lastId = rev.id;
          revised = true;
          show(text); // 表示済みの下書きを差し替える
        }
      } catch (e) {
        console.error('[harness] revise失敗:', e.message);
      }
    }

    // --- 6. 使った手を台帳へ。次のターンで同じ骨格・同じ例を避けさせる ---
    if (crit) record(conversation, { shape: crit.shape, anchors: crit.anchors });
  }

  const telemetry = logTurn({
    conversation, classification, mode, model,
    moderationFlagged: Boolean(mod?.flagged), moderationCategories: mod?.categories ?? [],
    toolRounds, refused, retried,
    answered: Boolean(text) && !stillRefusing,
    outcome: !text ? 'empty' : stillRefusing ? 'refused' : refused ? 'recovered' : 'answered',
    angles: angleSet?.angles?.length ?? 0,
    surprise: crit?.surprise ?? null,
    concrete: crit?.concrete ?? null,
    revised,
    inputChars: userText.length, outputChars: text.length,
    ...usageFields(),
    streamed: canStream, ttfbMs,
    latencyMs: Date.now() - started,
  });

  return { text, telemetry };
}
