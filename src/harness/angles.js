// 発散レイヤ(メタハーネス・前段)。本応答を書く前に「角度」を複数作らせる。
//
// なぜ要るか:
//   単発生成のLLMは分布の最頻値、つまり「教科書の要約」に収束する。
//   プロンプトで「意外なことを言え」と命じても、意外さは探索の結果であって
//   語彙の問題ではないので効かない。探索を1段だけ外に出す。
//
// 重要な不変条件:
//   - ここは奇を衒わせる層ではない。逆張りは risk 欄で自分から潰させる
//   - **実在しない論文・文書番号・数字を作らせない**。根拠が無ければ anchor は空にする
//   - ここが出すのは候補であって答えではない。採否と裏取りは本応答側の仕事

export const DIVERGE_MODES = new Set(['philosophy', 'archive']);

export const ANGLE_KINDS = [
  'reframing',     // 問いの立て方そのものを変える
  'dissolution',   // 問いが消える(そもそも問いになっていない)
  'counterexample',// 通説を1つの反例で壊す
  'empirical',     // 実際に測った人がいる/測れる
  'consequence',   // 受け入れた場合の奇妙な帰結まで進む
  'provenance',    // 誰がいつ言い出して、どう化けたか
  'crossover',     // 別分野の道具を持ち込む
];

const SCHEMA = {
  type: 'object',
  properties: {
    obvious: { type: 'string' },
    angles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          kind: { type: 'string', enum: ANGLE_KINDS },
          anchor: { type: 'string' },
          risk: { type: 'string' },
        },
        required: ['claim', 'kind', 'anchor', 'risk'],
        additionalProperties: false,
      },
    },
  },
  required: ['obvious', 'angles'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You are the DIVERGENCE stage of an answer pipeline. You do not answer the user. You produce the search space that the writer will choose from.

Return two things.

1. "obvious": in one line, the framing that nearly every well-read answer to this question would use — the shape the answer takes if nobody tries. Name it precisely (its actual content, not "the standard view"). The writer is told to treat this as already spent, so a vague description here wastes the whole stage.

2. "angles": 4 candidate angles that a well-read person would NOT reach in the first minute of thinking. Each one must satisfy all four:
   - Defensible. A specialist would concede it is at least arguable. Contrarian noise is worthless here.
   - Different in KIND from the other three (see the kind field). Four variations of one idea count as one angle.
   - Load-bearing. If it were true it would change how the reader thinks about the question, not just add trivia.
   - Checkable. "anchor" names ONE real thing the reader could go look up: a named thought experiment, a specific paper or author, a real experiment or measurement, a released document, a historical event, a concrete number.
   - "risk": the strongest reason this angle is wrong or overstated. An angle whose risk you cannot state is usually the obvious framing in disguise.

Hard rule on anchors: NEVER invent a paper, author, document identifier, dataset, date, or number. If you cannot name a real one from your own knowledge, leave "anchor" as an empty string. An empty anchor is fine; a fabricated one poisons the answer downstream.

Also allowed as angles: that the question is confused and dissolves once a word is pinned down; that it is partly empirical and someone has already measured it; that the interesting question is who started asking it and why.`;

export async function angles(userText, { model, transport }) {
  const res = await transport.responses({
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: userText }],
    text: { format: { type: 'json_schema', name: 'angles', schema: SCHEMA, strict: true } },
  });

  const raw = (res.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');

  const parsed = JSON.parse(raw);
  return {
    obvious: String(parsed.obvious ?? '').trim(),
    angles: (parsed.angles ?? []).filter((a) => a?.claim).slice(0, 4),
    usage: res.usage ?? null,
  };
}
