// 批評レイヤ(メタハーネス・後段)。書き上がった答えを1回だけ検査して、必要なら改稿させる。
//
// なぜ要るか:
//   既存ハーネスの出口検査は「拒否かどうか」しか見ていない。拒否でなければ
//   どれだけ平凡でも素通りする。品質の下限を上げるにはここに門が要る。
//
// 重要な不変条件:
//   - **正しさが意外さに優先する。** 間違っていて面白い改稿は最悪の失敗
//   - 改稿は1回だけ。何度も回して「もっと尖らせる」のはやらない(逆張りへ暴走する)
//   - 長さの要求はしない。ここは「削って濃くする」ための層

const SCHEMA = {
  type: 'object',
  properties: {
    // 事実として怪しい箇所。ここが空でないなら意外さに関係なく改稿
    problems: { type: 'array', items: { type: 'string' } },
    surprise: { type: 'integer' },   // 1-5
    concrete: { type: 'integer' },   // 1-5
    stance: { type: 'boolean' },     // 自分の立場を出し、翻意条件を書いたか
    formulaic: { type: 'boolean' },  // 定型の骨格をなぞっただけか
    shape: { type: 'string' },       // 使った骨格の一行要約(反復回避台帳に積む)
    anchors: { type: 'array', items: { type: 'string' } }, // 使った具体物(同上)
    fix: { type: 'string' },         // 最も効く修正指示を1つだけ
    verdict: { type: 'string', enum: ['ship', 'revise'] },
  },
  required: ['problems', 'surprise', 'concrete', 'stance', 'formulaic', 'shape', 'anchors', 'fix', 'verdict'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You are the quality gate of an answer pipeline. A draft reply has been written for the user's question. Judge it. You are not the audience and not a cheerleader.

"problems": every statement that is false, misattributed, an invented citation, or a real source described wrongly. Quote the offending fragment. THIS FIELD OVERRIDES EVERYTHING BELOW — a draft with problems must be revised no matter how good it reads. If you are unsure whether something is true, say so here rather than staying silent.

"surprise" (1-5): would a reader who ALREADY knows this topic get anything from this draft? 5 = a genuine reframing, or a fact that rearranges what they thought they knew. 3 = competent, adds one thing. 1 = the encyclopedia summary, correct and inert. Judge against a well-read reader, not a beginner.

"concrete" (1-5): does it name real things the reader could go look up — a named experiment, a specific paper or person, a released document, a real measured number? 5 = several, load-bearing. 1 = only vague gestures ("some philosophers", "studies show"), or numbers the draft invented as illustration rather than facts that exist.

"stance": does it commit to a position AND say what would change its mind? A both-sides shrug is false.

"formulaic": true if it runs the generic skeleton — list the positions, note that it is unresolved, close on a mild summary — rather than following this particular question's real shape.

"shape": one line naming the skeleton this draft actually used, so later answers can avoid repeating it.
"anchors": the specific named things it used (experiments, people, documents, numbers).

"fix": the ONE change that would most improve it. Be specific and surgical: name what to cut and what goes in its place. "Add more detail", "be more interesting", and "expand" are useless — do not write them.

"verdict": "revise" if problems is non-empty, or surprise <= 2, or formulaic is true, or concrete <= 2. Otherwise "ship".

Rules you must not break:
- Never ask for a claim you do not believe is true. A correct dull answer beats a striking false one, every time.
- Never ask for contrarianism, edginess, or a hot take. Surprise means the reader sees something real they had not assembled; it does not mean disagreeing with the consensus.
- Never ask for more length. If it needs more substance, say what to cut to make room.
- Judge the draft in the language it is written in; do not penalise it for being in Japanese.`;

export async function critique({ question, draft, model, transport }) {
  const res = await transport.responses({
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: `# 質問\n${question}\n\n# 下書き\n${draft}` }],
    text: { format: { type: 'json_schema', name: 'critique', schema: SCHEMA, strict: true } },
  });

  const raw = (res.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');

  const p = JSON.parse(raw);
  return {
    problems: p.problems ?? [],
    surprise: p.surprise ?? 3,
    concrete: p.concrete ?? 3,
    stance: Boolean(p.stance),
    formulaic: Boolean(p.formulaic),
    shape: String(p.shape ?? '').trim(),
    anchors: (p.anchors ?? []).map(String).filter(Boolean),
    fix: String(p.fix ?? '').trim(),
    verdict: p.verdict === 'revise' ? 'revise' : 'ship',
    usage: res.usage ?? null,
  };
}

// 改稿するか。判定はモデルに任せきりにせず、コード側でも同じ条件を持つ
// (verdict だけ信じると、fix が空なのに revise が返ってきたときに空回りする)
export function needsRevision(c) {
  if (!c) return false;
  const failed = c.problems.length > 0 || c.surprise <= 2 || c.concrete <= 2 || c.formulaic;
  return (c.verdict === 'revise' || failed) && Boolean(c.fix || c.problems.length);
}
