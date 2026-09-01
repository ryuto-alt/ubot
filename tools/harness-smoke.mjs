// 実APIスモークテスト(課金あり・数円程度)。本番と同じ構成で3ターン回して、
// プロンプトキャッシュが実際に乗っているかと体感レイテンシを測る。
//   node --env-file=.env tools/harness-smoke.mjs
//
// 見るところ: 2ターン目以降の cached が 80% を切っていたら、どこかで
// instructions か input のプレフィックスを壊している(= 課金が数倍になる)。
import { chat } from '../src/harness/index.js';
import { systemPrompt, toolsFor } from '../src/events/gptChat.js';
import { MODELS } from '../src/gptsol.js';

const conversation = 'e2e-' + Date.now();
const hist = [];

async function turn(text, { stream = true } = {}) {
  hist.push({ role: 'user', content: `ryuto: ${text}` });
  let first = null;
  const t0 = Date.now();
  const { text: reply, telemetry } = await chat({
    input: hist,
    model: MODELS.terra.id,
    classifierModel: MODELS.terra.id,
    auxModel: MODELS.terra.id,
    persona: systemPrompt(),
    tools: toolsFor,
    conversation,
    onProgress: stream ? () => { if (first === null) first = Date.now() - t0; } : null,
  });
  hist.push({ role: 'assistant', content: reply });
  const t = telemetry;
  console.log(
    `[${t.mode}] tok=${t.tokens} in=${t.inputTokens} cached=${t.cachedTokens}(${Math.round(t.cachedRatio * 100)}%) out=${t.outputTokens} reasoning=${t.reasoningTokens} calls=${t.apiCalls}`,
  );
  console.log(`   体感=${first ?? '-'}ms 完了=${t.latencyMs}ms stage=${JSON.stringify(t.stageTokens)}`);
  console.log(`   > ${reply.slice(0, 90).replace(/\n/g, ' ')}`);
}

await turn('おはよう、調子どう?');
await turn('今日は何しようかな');
await turn('ラーメンって太る?');
