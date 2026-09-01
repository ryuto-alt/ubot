// 反復回避台帳(システムハーネス)。ターンをまたいで生きる唯一の品質状態。
//
// なぜ要るか:
//   1ターン内でどれだけ品質を上げても、次の質問で同じ骨格・同じ具体例が出れば
//   会話全体としては退屈になる。「テセウスの船」を毎回出すbotは1回目しか面白くない。
//   批評レイヤが抽出した骨格と具体物をチャンネル単位で覚えておき、次のターンで避けさせる。
//
// ponytail: プロセス内Mapで十分。再起動で忘れるが、再起動をまたいだ反復は実害が無い。
//           DBを持ち込む理由がない。

const KEEP = 6;              // 直近いくつを避けるか。多すぎると書けなくなる
const MAX_CONVERSATIONS = 200; // 野放図に増やさない

const ledger = new Map(); // conversation -> { shapes: string[], anchors: string[] }

export function recall(conversation) {
  if (!conversation) return { shapes: [], anchors: [] };
  return ledger.get(conversation) ?? { shapes: [], anchors: [] };
}

export function record(conversation, { shape, anchors = [] } = {}) {
  if (!conversation) return;
  const cur = ledger.get(conversation) ?? { shapes: [], anchors: [] };
  if (shape) cur.shapes = [shape, ...cur.shapes.filter((s) => s !== shape)].slice(0, KEEP);
  for (const a of anchors) {
    cur.anchors = [a, ...cur.anchors.filter((x) => x !== a)].slice(0, KEEP * 2);
  }
  ledger.delete(conversation); // 挿入順=LRU にするため入れ直す
  ledger.set(conversation, cur);
  while (ledger.size > MAX_CONVERSATIONS) ledger.delete(ledger.keys().next().value);
}

export function reset() {
  ledger.clear();
}
