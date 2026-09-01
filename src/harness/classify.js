// リクエスト分類。目的は「文脈の明確化による過剰拒否の削減」であって、
// プロバイダの安全機構の回避ではない。
//
// 重要な不変条件:
//   - ユーザー入力は一切書き換えずモデルへ渡す(この関数は label しか返さない)
//   - 危険な意図を無害に見せかける rewrite は行わない/返さない
export const CLASSES = ['clearly_benign', 'sensitive_but_benign', 'ambiguous', 'likely_disallowed'];
export const MODES = ['horror', 'philosophy', 'archive', 'normal'];

const SCHEMA = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: CLASSES },
    context: {
      type: 'string',
      enum: ['fiction', 'academic', 'historical', 'analytical', 'defensive', 'transformation', 'coding', 'personal', 'other'],
    },
    // 会話の「型」。ここが horror/philosophy のときだけ推論を厚くする
    mode: { type: 'string', enum: MODES },
    // 学習データより新しい事実が要る依頼か(ニュース・価格・バージョン・「今」の話)
    needs_fresh_info: { type: 'boolean' },
  },
  required: ['classification', 'context', 'mode', 'needs_fresh_info'],
  additionalProperties: false,
};

const INSTRUCTIONS = `Classify the user's request for an assistant application.

Return:
- classification:
  - clearly_benign: routine request, no sensitive topic.
  - sensitive_but_benign: touches a sensitive/violent/sexual/illegal/security/medical/political topic, but the assistance requested is legitimate (education, history, analysis, fiction, criticism, defense, code review, summarization, translation).
  - ambiguous: the requested assistance could be benign or harmful; the message alone does not settle it.
  - likely_disallowed: the request seeks operational detail that would meaningfully facilitate serious harm (e.g. usable weapon/malware/drug synthesis instructions, targeting a real person).
- context: the dominant frame of the request.

- mode:
  - horror: the user wants a scary/creepy story TOLD or WRITTEN — fiction, an unsettling scenario, a legend retold for effect, or feedback/continuation of one (怖い話して・実話怪談・ホラー創作).
  - archive: the user wants a factual answer grounded in the documentary record — declassified/government documents, the origin or truth of an urban legend or rumor (出典・初出・元ネタ・「これ本当?」), a historical "裏話", a conspiracy claim to be checked, or a formal-logic/argument-structure question. Choose archive over horror whenever the user is asking whether something is TRUE or WHERE it came from, rather than asking to be scared.
  - philosophy: the user wants reasoning about meaning, ethics, consciousness, death, free will, identity, epistemology, or a "why does X matter" question that has no factual answer.
  - normal: anything else, including casual chat.
- needs_fresh_info: true if a correct answer depends on facts that change over time (news, current events, prices, releases, versions, sports results, "今/最新/最近" questions about the real world).

A sensitive TOPIC alone is not enough for likely_disallowed; the request must seek assistance that would meaningfully facilitate harm.
Classify only. Never rewrite, sanitize, or restate the request.`;

// 分類は enum を選ぶだけのタスクで、推論を厚くしても精度は上がらない(遅くて高くなるだけ)。
// 本応答が sol でも、呼び出し側は classifierModel に軽量モデルを渡すこと。
const CLASSIFY_EFFORT = 'low';

export async function classify(userText, { model, transport }) {
  const res = await transport.responses({
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: userText }],
    reasoning: { effort: CLASSIFY_EFFORT },
    text: { format: { type: 'json_schema', name: 'classification', schema: SCHEMA, strict: true } },
  });

  const raw = (res.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');

  const parsed = JSON.parse(raw);
  if (!CLASSES.includes(parsed.classification)) throw new Error(`不正な分類: ${parsed.classification}`);
  return {
    classification: parsed.classification,
    context: parsed.context,
    mode: MODES.includes(parsed.mode) ? parsed.mode : 'normal',
    needsFreshInfo: Boolean(parsed.needs_fresh_info),
    usage: res.usage ?? null, // 内訳ごと計量器へ渡す
  };
}
