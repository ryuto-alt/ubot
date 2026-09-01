import { Events, PermissionFlagsBits } from 'discord.js';
import { readFileSync } from 'node:fs';
import { MODELS, addUsage, currentAlias } from '../gptsol.js';
import { chat } from '../harness/index.js';
import { trimHistory } from '../harness/history.js';
import { anonId } from '../harness/log.js';
import { play, resolveTracks, setLoop, skip, stop } from '../music.js';
import { splitMessage } from '../splitMessage.js';

// gptsol: メンション/リプライ/DM で会話。Responses API + web検索 + Discord操作ツール
// モデルは /model で sol(高性能) / terra(軽量) を切替
export const name = Events.MessageCreate;
const SYSTEM = [
  'あなたは「gptsol」。Discordサーバーに住んでいる、物知りで話しやすいAI。',
  '- 丁寧語(ですます調)で話す。堅苦しくはせず、距離は近いまま。絵文字もたまに使う',
  '- 返答はチャットのテンポで短め(1〜3文)。説明が必要なときだけ長く書いていい',
  '- 3行を超えるときは必ずMarkdownで構造化する(見出し ## / 箇条書き - / **太字** / 表)。ベタ書きの長文は禁止',
  '- 長さより整理を優先する。同じ中身なら短いほうが良い返答',
  '- プログラミングのコードを書くときは必ず ```言語 〜 ``` のコードブロックで囲む',
  '- 複数人の発言が「名前: 内容」形式で来る。名前で呼びかけてOK',
  '- 最新情報やニュース、知らないことを聞かれたら web検索してから答える',
  '- 「メッセージ消して」「曲流して」「止めて」等の頼み事は対応するツールで実行して、結果を一言で報告する',
].join('\n');

// ユーザーが書くシステムプロンプトは この1ファイルだけ。編集したら即反映(再起動不要)
// ponytail: 数KBなので毎回読む。キャッシュは不要
const PROMPT_FILE = new URL('../../gptsol-prompt.txt', import.meta.url);

export function systemPrompt() {
  let extra = '';
  try {
    extra = readFileSync(PROMPT_FILE, 'utf8').trim();
  } catch (e) {
    console.error('[gptsol] プロンプト読み込み失敗:', e.code, PROMPT_FILE.pathname);
  }
  return extra ? `${SYSTEM}\n\n# 追加指示(こちらを優先)\n${extra}` : SYSTEM;
}

// 起動時に読み込み状況をログに出す(内容は出さない)
{
  const n = systemPrompt().length - SYSTEM.length;
  console.log(n > 0 ? `✅ システムプロンプト読み込み: +${n}文字` : '⚠️ システムプロンプト未読み込み(gptsol-prompt.txt なし/空)');
}

const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'delete_messages',
    description: 'このチャンネルの直近メッセージを一括削除する(最大100件、14日以内のもののみ)',
    parameters: {
      type: 'object',
      properties: { count: { type: 'integer', description: '削除する件数(1-100)。「全部」と言われたら100' } },
      required: ['count'],
    },
  },
  {
    type: 'function',
    name: 'play_music',
    description: '頼んだ人が入っているVCで曲を流す。キューに追加され、操作パネルが自動で出る(YouTube検索・URL・プレイリストURL対応)',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '曲名・アーティスト名の検索語、またはURL' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'stop_music',
    description: '音楽の再生を止めてボイスチャンネルから退出する',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'skip_music',
    description: '今流れている曲をスキップして次の曲へ進む',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'set_loop',
    description: 'ループ設定を変える。track=1曲ループ、queue=再生リストループ、off=ループ解除',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['track', 'queue', 'off'] } },
      required: ['mode'],
    },
  },
];

// web検索の取り込み量はモードで変える。archive は出典の裏取りが命なので厚く、
// それ以外は low(既定は medium)。雑談で検索が走ると数千トークン持っていかれる。
export function toolsFor(mode) {
  return [
    { type: 'web_search', search_context_size: mode === 'archive' ? 'high' : 'low' },
    ...FUNCTION_TOOLS,
  ];
}

async function runTool(name, args, message) {
  try {
    if (name === 'delete_messages') {
      // 破壊的操作は頼んだ本人の権限を確認
      if (!message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
        return '拒否: 頼んだ本人にメッセージ管理権限がない';
      }
      const n = Math.min(Math.max(args.count ?? 10, 1), 100);
      const deleted = await message.channel.bulkDelete(n, true);
      return `成功: ${deleted.size}件削除した(14日より古いものは仕様で消せない)`;
    }
    if (name === 'play_music') {
      const vc = message.member?.voice?.channel;
      if (!vc) return '失敗: 頼んだ本人がVCに入ってない。先にVCに入ってと伝えて';
      const tracks = await resolveTracks(args.query);
      if (!tracks.length) return '失敗: 曲が見つからなかった';
      await play(message.guild, vc, tracks, message.channel);
      return tracks.length === 1
        ? `成功: 「${tracks[0].title}」をVC「${vc.name}」のキューに入れた。操作パネルも出した`
        : `成功: ${tracks.length}曲をキューに入れた。操作パネルも出した`;
    }
    if (name === 'stop_music') return message.guild ? await stop(message.guild) : '失敗: サーバー内でしか使えない';
    if (name === 'skip_music') return message.guild ? await skip(message.guild) : '失敗: サーバー内でしか使えない';
    if (name === 'set_loop') return message.guild ? await setLoop(message.guild, args.mode) : '失敗: サーバー内でしか使えない';
    return `不明なツール: ${name}`;
  } catch (e) {
    return `エラー: ${e.message}`;
  }
}

// ---- 会話本体 ----
const DEBATE_BOT_ID = '1541425821044969543'; // Claude_Code(ディベート相手)
const histories = new Map(); // channelId -> [{role, content}]

// Discordのメッセージ編集はレート制限があるので、途中経過はこの間隔まで間引く
const EDIT_INTERVAL_MS = 1500;
const STREAM_PREVIEW_LIMIT = 1900; // 2000字制限。確定時に splitMessage で正しく割り直す

export async function execute(message, client) {
  // ディベート相手のAI(Claude_Code)だけは相手にする。bot同士の無限ループを避けるため1IDのみ許可
  if (message.author.bot && message.author.id !== DEBATE_BOT_ID) return;

  const isDM = !message.guild;
  // @UBot はユーザーでなくボット付属ロールへのメンションになることが多いので、ロール側も見る
  const me = message.guild?.members?.me;
  const myRoles = me ? message.mentions.roles.filter((r) => me.roles.cache.has(r.id)) : null;
  const mentioned = message.mentions.users.has(client.user.id) || (myRoles?.size ?? 0) > 0;
  let isReplyToMe = false;
  if (!isDM && !mentioned && message.reference) {
    const ref = await message.fetchReference().catch(() => null);
    isReplyToMe = ref?.author.id === client.user.id;
  }
  if (!isDM && !mentioned && !isReplyToMe) return;

  let text = message.content
    .replaceAll(`<@${client.user.id}>`, '')
    .replaceAll(`<@!${client.user.id}>`, '');
  if (myRoles) for (const r of myRoles.values()) text = text.replaceAll(`<@&${r.id}>`, '');
  text = text.trim();
  if (!text) return;

  const hist = histories.get(message.channelId) ?? [];
  hist.push({ role: 'user', content: `${message.member?.displayName ?? message.author.username}: ${text}` });
  trimHistory(hist);
  histories.set(message.channelId, hist);

  // 発散→本応答→批評→改稿と重なると数十秒かかる。Discordのタイピング表示は約10秒で切れるので
  // 最初の1文字が出るまでは打ち直す(無いと「無視された」ように見える)
  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

  // --- 途中経過をメッセージ1本に流し込む ---
  // ハーネスは「現時点の全文」を毎回渡してくるので、こちらは置き換えるだけでよい
  // (ツールを挟んで書き直しになったら全文がリセットされて届く)。
  let msgRef = null;      // 最初のメッセージ(以後 edit で更新)
  let pending = null;     // まだ画面に出していない最新の全文
  let inflight = false;   // 送信中の多重発行を防ぐ
  let closed = false;     // 確定表示に入ったら途中経過は止める
  let lastEditAt = 0;
  let timer = null;

  const push = async (body) => {
    if (!msgRef) msgRef = await message.reply(body).catch(() => message.channel.send(body));
    else await msgRef.edit(body);
  };

  const flush = async () => {
    if (closed || inflight || pending === null) return;
    const wait = EDIT_INTERVAL_MS - (Date.now() - lastEditAt);
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, wait);
      return;
    }
    const body = pending.length > STREAM_PREVIEW_LIMIT
      ? `${pending.slice(0, STREAM_PREVIEW_LIMIT)}…`
      : pending;
    pending = null;
    inflight = true;
    lastEditAt = Date.now();
    try {
      await push(body);
    } catch (e) {
      console.error('[gptsol] 途中経過の表示に失敗:', e.message);
    } finally {
      inflight = false;
      flush();
    }
  };

  const onProgress = (full) => {
    if (closed || !full?.trim()) return;
    pending = full;
    flush();
  };

  try {
    const alias = currentAlias();
    const model = MODELS[alias].id;

    // answer-first ハーネス経由(分類→モデレーション→応答→ツール→拒否時1回再評価)
    const { text: reply, telemetry } = await chat({
      input: hist,
      model,
      // 分類は enum を選ぶだけ。本応答が sol でも常に軽量モデルで回す(毎ターン1往復ぶん効く)
      classifierModel: MODELS.terra.id,
      // 発散・批評は品質レイヤの補助なので、これも常に軽量モデル
      auxModel: MODELS.terra.id,
      persona: systemPrompt(),
      tools: toolsFor,
      runTool: (name, argsObject) => runTool(name, argsObject, message),
      conversation: anonId(message.channelId),
      onProgress,
    });
    const used = telemetry?.tokens ?? 0;

    // 途中経過を止めて、送信中のedit が終わるのを待つ(確定表示を上書きされないように)
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    while (inflight) await new Promise((r) => setTimeout(r, 50));
    clearInterval(typing);

    if (!reply) {
      if (msgRef) await msgRef.delete().catch(() => {});
      return;
    }

    hist.push({ role: 'assistant', content: reply });
    trimHistory(hist);

    // コードフェンスを跨がないよう分割(単純slice()だと```が途中で切れて崩れる)。
    // 元メッセージが削除済みだとreplyが400になるのでsendにフォールバック
    const chunks = splitMessage(reply);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) await push(chunks[i]).catch(() => message.channel.send(chunks[i]));
      else await message.channel.send(chunks[i]);
    }

    const { warn, total, limit } = addUsage(alias, used);
    if (warn) {
      await message.channel.send(
        `⚠️ **gptsol 無料枠アラート**: **${alias}** の今日の使用量が ${total.toLocaleString()} トークンに到達(無料枠 ${limit.toLocaleString()} の90%超え)。そろそろ上限だよ。`,
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[gptsol]', err);
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    while (inflight) await new Promise((r) => setTimeout(r, 50));
    // 途中まで流していたら、そのメッセージをエラー表示に差し替える(半端な文を残さない)
    const note = '⚠️ gptsol がエラっちゃった。ちょっと待ってもう一回試して。';
    await (msgRef ? msgRef.edit(note) : message.reply(note)).catch(() => {});
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    clearInterval(typing);
  }
}
