// Discordの2000字制限で分割する。単純なslice()だとコードフェンス(```)の途中で切れて
// 表示が崩れるので、フェンスを跨ぐときは閉じて→次チャンクの頭で同じ言語で開き直す。
const LIMIT = 2000;
const FENCE = /^```(\S*)/;

export function splitMessage(text, limit = LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let cur = '';
  let fenceLang = null; // フェンス内なら言語(''含む)、外ならnull

  const flush = (reopen) => {
    if (fenceLang !== null) cur += (cur.endsWith('\n') ? '' : '\n') + '```'; // 閉じる
    if (cur) chunks.push(cur);
    cur = reopen && fenceLang !== null ? '```' + fenceLang + '\n' : '';
  };

  for (const rawLine of text.split('\n')) {
    // 1行が長すぎる場合はフェンスを保ったまま強制分割
    const pieces = [];
    for (let i = 0; i < rawLine.length || i === 0; i += limit - 8) {
      pieces.push(rawLine.slice(i, i + (limit - 8)));
    }

    for (const line of pieces) {
      const willClose = fenceLang !== null ? 4 : 0; // 閉じフェンス分の余白
      if (cur.length + line.length + 1 + willClose > limit) flush(true);
      cur += (cur ? '\n' : '') + line;

      const m = line.match(FENCE);
      if (m) fenceLang = fenceLang === null ? m[1] : null; // 開き/閉じtrueで反転
    }
  }
  if (cur) {
    if (fenceLang !== null) cur += '\n```';
    chunks.push(cur);
  }
  return chunks;
}

// フェンスの釣り合いチェック用の自己診断
export function demo() {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const balanced = (s) => (s.match(/```/g)?.length ?? 0) % 2 === 0;

  // 長いコードブロック + 途中解説 + 別コードブロック
  const long = '```js\n' + Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```\n\n途中の解説テキスト。\n\n```css\n.a { color: red; }\n```';
  const parts = splitMessage(long);
  assert(parts.length > 1, '分割されるべき');
  for (const p of parts) {
    assert(p.length <= LIMIT, `各チャンク<=${LIMIT}: ${p.length}`);
    assert(balanced(p), 'フェンスが各チャンク内で閉じている');
  }
  // 短文はそのまま
  assert(splitMessage('hello').length === 1, '短文は1チャンク');
  console.log(`✅ splitMessage demo: ${parts.length}分割, 全チャンクでフェンス釣り合いOK`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('splitMessage.js')) demo();
