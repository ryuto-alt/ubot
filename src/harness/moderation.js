// OpenAI Moderation API。独自のキーワードブラックリストは作らない。
// 結果は「アプリ側の判断シグナル」として扱い、単純な足切りフィルタにはしない。
//
// 唯一の例外として、アプリのポリシー上どうしても扱わないカテゴリ(未成年の性的表現)は
// アプリ側で断る。これは回避ではなく、アプリの取扱範囲の定義。
const HARD_DECLINE = ['sexual/minors'];
const SIGNAL_THRESHOLD = 0.5;

export async function moderate(userText, { transport, model = 'omni-moderation-latest' }) {
  const res = await transport.moderations({ model, input: userText });
  const r = res.results?.[0] ?? {};
  const scores = r.category_scores ?? {};

  // flagged が立ったカテゴリ + スコアが高いカテゴリを「シグナル」として集める
  const categories = Object.entries(r.categories ?? {})
    .filter(([name, on]) => on || (scores[name] ?? 0) >= SIGNAL_THRESHOLD)
    .map(([name]) => name);

  return {
    flagged: Boolean(r.flagged),
    categories,
    hardDecline: categories.some((c) => HARD_DECLINE.includes(c)),
  };
}
