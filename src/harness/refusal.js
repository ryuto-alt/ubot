// 「モデルが依頼全体を拒否したか」の判定。
// 誤検知すると無駄な再評価が走るので、冒頭付近 + 短さ の両方を条件にする。
const PATTERNS = [
  // English
  /\bi (?:can(?:'|’)?t|cannot|am not able to|won(?:'|’)?t)\b[^.]{0,40}\b(?:help|assist|provide|comply|do that|with (?:that|this))\b/i,
  /\bi(?:'|’)?m (?:sorry|afraid)[^.]{0,30}\bbut\b[^.]{0,40}\bcan(?:'|’)?t\b/i,
  /\bi (?:can(?:'|’)?t|cannot) (?:help|assist) with (?:that|this)\b/i,
  /\b(?:that|this) (?:request|content) (?:is|falls) (?:outside|against)\b/i,
  // 日本語
  /(?:お手伝い|協力|対応|回答|お答え|提供)(?:は)?(?:でき(?:ま[せﾞ]ん|かねます)|いたしかねます)/,
  /(?:申し訳(?:あり|ござい)ませんが|すみませんが)[^。]{0,30}(?:でき(?:ませ|かね)|お答えできません)/,
  /(?:その|この)(?:ような)?(?:ご)?(?:依頼|要求|内容|質問)(?:に)?は(?:お)?(?:応え|答え)でき(?:ませ|かね)/,
];

const HEAD = 300;
const MAX_REFUSAL_LEN = 1200; // 本文をちゃんと書いている回答は拒否とみなさない

export function looksLikeRefusal(text) {
  if (!text) return false;
  const head = text.slice(0, HEAD);
  if (!PATTERNS.some((re) => re.test(head))) return false;
  // 長文なら「一部だけ断って残りは回答している」= 部分回答なので拒否扱いしない
  return text.length <= MAX_REFUSAL_LEN;
}
