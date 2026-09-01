import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 観測用ログ。ユーザー本文・個人情報は保存しない(長さと分類などのメタのみ)
const FILE = fileURLToPath(new URL('../../logs/harness.jsonl', import.meta.url));

export function anonId(raw) {
  return raw ? createHash('sha256').update(String(raw)).digest('hex').slice(0, 12) : null;
}

export function logTurn(record) {
  const line = {
    ts: new Date().toISOString(),
    conversation: record.conversation ?? null, // 生IDではなくハッシュを渡す想定
    classification: record.classification,
    mode: record.mode ?? 'normal',
    moderationFlagged: record.moderationFlagged,
    moderationCategories: record.moderationCategories ?? [],
    model: record.model,
    toolRounds: record.toolRounds ?? 0,
    refused: record.refused,
    retried: record.retried,
    answered: record.answered,
    outcome: record.outcome,
    // 品質レイヤの観測値。あとで「批評が実際に効いているか」を測るために残す
    angles: record.angles ?? 0,
    surprise: record.surprise ?? null,
    concrete: record.concrete ?? null,
    revised: record.revised ?? false,
    inputChars: record.inputChars ?? null, // 本文ではなく文字数だけ
    outputChars: record.outputChars ?? null,
    // トークンの内訳。tokens(=total)だけだと「入力が重い/推論が重い/キャッシュが効いてない」を
    // 区別できず、改善したかどうかが後から言えなくなる
    tokens: record.tokens ?? 0,
    inputTokens: record.inputTokens ?? 0,
    cachedTokens: record.cachedTokens ?? 0,
    cachedRatio: record.cachedRatio ?? 0,
    outputTokens: record.outputTokens ?? 0,
    reasoningTokens: record.reasoningTokens ?? 0,
    apiCalls: record.apiCalls ?? 0,
    stageTokens: record.stageTokens ?? {},
    stageMs: record.stageMs ?? {},
    streamed: record.streamed ?? false,
    ttfbMs: record.ttfbMs ?? null, // 最初の1文字がユーザーに出るまで(体感レイテンシ)
    latencyMs: record.latencyMs ?? null,
    error: record.error ?? null,
  };
  console.log(
    `[harness] class=${line.classification} mode=${line.mode} model=${line.model} refused=${line.refused} retried=${line.retried} answered=${line.answered} outcome=${line.outcome} surprise=${line.surprise ?? '-'} concrete=${line.concrete ?? '-'} revised=${line.revised} tokens=${line.tokens} cached=${Math.round(line.cachedRatio * 100)}% ttfb=${line.ttfbMs ?? '-'}ms`,
  );
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, `${JSON.stringify(line)}\n`);
  } catch {
    // ログが書けなくても会話は続行する
  }
  return line;
}
