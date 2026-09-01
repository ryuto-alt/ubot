// 会話履歴の刈り込み。
//
// なぜ「1件ずつ捨てる」のが最悪手か:
//   プロバイダの自動プロンプトキャッシュは、先頭からの完全一致プレフィックスにしか効かない。
//   上限に当たるたび先頭を1件 shift すると、毎ターン input の先頭がズレて、
//   履歴ぶん(長い会話だと1万トークン級)が毎回まるごと未キャッシュの入力として課金される。
//   まとめて落として、しばらく同じ形を保つほうが安い。
export const HISTORY_MAX = 20;         // これを超えたら
export const HISTORY_KEEP = 12;        // ここまで一気に落とす(以後8ターンは先頭が動かない)
export const HISTORY_CHARS = 12_000;   // 文字数の上限。返信が長い会話では件数より先にこちらが効く
export const HISTORY_CHARS_KEEP = 7_000; // 削るときはここまで下げる(毎ターンぎりぎりを削らない)

export function trimHistory(hist) {
  if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_KEEP);
  let total = hist.reduce((s, msg) => s + msg.content.length, 0);
  // 上限に「触れたら」KEEP まで一気に下げる。上限ちょうどで止めると、次のターンでまた
  // 削ることになり、結局毎ターン先頭が動く(=キャッシュが毎回壊れる)
  if (total > HISTORY_CHARS) {
    while (total > HISTORY_CHARS_KEEP && hist.length > 2) total -= hist.shift().content.length;
  }
  return hist;
}
