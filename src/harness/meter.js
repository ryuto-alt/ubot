// トークン/レイテンシの計量器。
//
// なぜ要るか:
//   これまで total_tokens しか記録していなかったので、「入力が重いのか・推論が重いのか・
//   キャッシュが効いていないのか」が事後に一切分からなかった。チューニングの前に、
//   まず内訳が見えるようにする。cachedRatio が改善の主指標。
export function makeMeter() {
  return {
    total: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    stageTokens: {}, // classify / angles / main / tool / recovery / critique / revise
    stageMs: {},
    calls: 0,
  };
}

// res.usage を1回ぶん足す。usage が無い/形が違っても落とさない(全レイヤ fail-soft の方針)
export function meter(m, stage, res, ms) {
  m.calls++;
  m.stageMs[stage] = (m.stageMs[stage] ?? 0) + (ms ?? 0);
  const u = res?.usage;
  if (!u) return m;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const total = u.total_tokens ?? input + output;
  m.input += input;
  m.output += output;
  m.total += total;
  m.cached += u.input_tokens_details?.cached_tokens ?? 0;
  m.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
  m.stageTokens[stage] = (m.stageTokens[stage] ?? 0) + total;
  return m;
}

// キャッシュ命中率。0 に張り付いていたらプレフィックスが毎ターン壊れている
export function cachedRatio(m) {
  return m.input > 0 ? +(m.cached / m.input).toFixed(3) : 0;
}
