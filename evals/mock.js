// APIを叩かないモック。ハーネスの配線・分類・拒否検知・recovery・品質レイヤの分岐を
// 決定的に検証するためのもの(実モデルの安全判断や実際の面白さそのものは検証できない)。
import { CLASSES } from '../src/harness/classify.js';

const msg = (text, id = 'resp_mock') => ({
  id,
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  // 本物と同じ内訳の形にしておく(計量器がここを読む)
  usage: {
    input_tokens: 8,
    output_tokens: 2,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
});
const json = (obj, id = 'resp_mock') => msg(JSON.stringify(obj), id);

// 呼び出しの種類を instructions から見分ける。ハーネス側の文言に依存するので、
// 文言を変えたらここも直す(テストが黙って素通りしないよう、未知の構造化呼び出しは投げる)
export function kindOf(body) {
  const ins = body.instructions ?? '';
  if (/Classify the user's request/.test(ins)) return 'classify';
  if (/DIVERGENCE stage/.test(ins)) return 'angles';
  if (/quality gate of an answer pipeline/.test(ins)) return 'critique';
  // recovery / revise は「直前の応答に developer 指示だけを継ぎ足す」形。
  // 本応答も developer のターンノート(可変分)を積むようになったので、
  // role だけでは見分けられない。previous_response_id の有無で切る
  if (body.previous_response_id) {
    const dev = Array.isArray(body.input) ? body.input.find((m) => m.role === 'developer') : null;
    if (dev) return /full refusal/.test(dev.content) ? 'recovery' : 'revise';
    return 'tool';
  }
  return 'main';
}

const REFUSE_ONCE = /阿片|阿へん|アヘン/;

// opts で挙動を差し替えられるようにして、品質レイヤのテストから使う
export function makeMock({
  mode,                 // 分類器に返させる mode を固定する
  critique: critOverride = {},
  onCall = () => {},
  failAngles = false,
  withStream = false,   // ストリーム対応の transport にする(途中経過の配線テスト用)
  streamFails = false,  // ストリームだけ落として非ストリームへのフォールバックを見る
} = {}) {
  const refused = new Set();
  const self = {
    async responses(body) {
      const kind = kindOf(body);
      onCall(kind, body);

      if (kind === 'classify') {
        const t = body.input?.[0]?.content ?? '';
        const cls = /合成|検知されない|untraceable/.test(t)
          ? 'likely_disallowed'
          : /鍵|爆薬|マルウェア|毒|核|銃|過剰摂取|SQL|XSS/.test(t)
            ? 'sensitive_but_benign'
            : CLASSES[0];
        const autoMode = /怖い話|怪談|ホラー/.test(t)
          ? 'horror'
          : /出典|初出|元ネタ|公文書|本当\?|都市伝説/.test(t)
            ? 'archive'
            : /哲学|なぜ生き|意味とは|自由意志|シミュレーション|意識|死んだら|倫理/.test(t)
              ? 'philosophy'
              : 'normal';
        return json({
          classification: cls,
          context: 'other',
          mode: mode ?? autoMode,
          needs_fresh_info: /最新|今日|ニュース|現在/.test(t),
        }, 'resp_classify');
      }

      if (kind === 'angles') {
        if (failAngles) throw new Error('angles mock failure');
        return json({
          obvious: '教科書どおりの三択を並べて「未解決」で閉じる枠組み',
          angles: [
            { claim: '問いが参照クラスの選び方に還元される', kind: 'dissolution', anchor: '自己標本仮説', risk: '還元しきれない残余がある' },
            { claim: '実際に測ろうとした人がいる', kind: 'empirical', anchor: '格子QCDによる予測', risk: '前提が特定の実装に依存' },
            { claim: '受け入れると別の奇妙な帰結が出る', kind: 'consequence', anchor: 'ボルツマン脳', risk: '帰結が強すぎる' },
            { claim: '誰が言い出したかで問いの形が決まった', kind: 'provenance', anchor: '1970年代の議論', risk: '起源と正しさは別' },
          ],
        }, 'resp_angles');
      }

      if (kind === 'critique') {
        return json({
          problems: [],
          surprise: 4,
          concrete: 4,
          stance: true,
          formulaic: false,
          shape: '前提を1つ外して壊れ方を見る',
          anchors: ['ボルツマン脳'],
          fix: '',
          verdict: 'ship',
          ...critOverride,
        }, 'resp_critique');
      }

      if (kind === 'recovery') {
        return msg('了解。無害な範囲で回答すると、これは歴史的な説明として問題なく答えられる内容だ。…(本文)', 'resp_recovery');
      }

      if (kind === 'revise') {
        return msg('改稿版の本文。指摘を踏まえて骨格から組み直した。…(本文)', 'resp_revise');
      }

      // 通常応答: 特定ケースだけ最初は拒否文を返す
      const userText = Array.isArray(body.input) ? body.input.map((m) => m.content).join(' ') : '';
      if (REFUSE_ONCE.test(userText) && !refused.has('once')) {
        refused.add('once');
        return msg('申し訳ありませんが、その内容にはお答えできません。', 'resp_main');
      }
      return msg('これは通常どおり回答できる内容だ。…(本文をしっかり書く)', 'resp_main');
    },

    async moderations() {
      return { results: [{ flagged: false, categories: {}, category_scores: {} }] };
    },
  };

  if (withStream) {
    // 本物と同じ契約: delta を流しつつ、最後に非ストリームと同じ形の response を返す
    self.stream = async (body, onDelta) => {
      if (streamFails) {
        const e = new Error('mock stream down');
        e.status = 500;
        throw e;
      }
      const res = await self.responses(body);
      const text = (res.output ?? [])
        .flatMap((o) => o.content ?? [])
        .map((c) => c.text ?? '')
        .join('');
      for (let i = 0; i < text.length; i += 8) onDelta?.(text.slice(i, i + 8));
      return res;
    };
  }
  return self;
}

// 既存の false refusal 測定はこれまでどおりのデフォルト挙動で回す
export const mockTransport = makeMock();
