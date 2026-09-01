// いびき検出 → 自動でVC切断。
// ponytail: 音声はデコードせず「発話ON/OFFの周期性」だけを見る。いびきは呼吸=メトロノーム、
//           会話はバラバラ、という差だけで判る。opus/FFT依存なし、CPUほぼゼロ。
//           精度が足りなくなったら初めて音量スペクトルを見る。
import { readFileSync, writeFileSync } from 'node:fs';
import { PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } from '@discordjs/voice';

// --- 監視対象（/nemuochi で増減）。ponytail: 生JSON1ファイル、数千人になったらDBへ。 ---
const FILE = new URL('../nemuochi.json', import.meta.url);
export const watched = (() => {
  try { return new Set(JSON.parse(readFileSync(FILE, 'utf8'))); } catch { return new Set(); }
})();
export const save = () => writeFileSync(FILE, JSON.stringify([...watched]));

// --- 調整ノブ。人・マイク・部屋で全部変わるのでここだけ触れば効く ---
export const T = {
  minBurst: 0.6,  // いびき1回の最短(秒)。これ未満は相槌・物音
  maxBurst: 5.0,  // 最長(秒)。これ超えは会話/BGM垂れ流し
  minPeriod: 1.5, // 呼吸周期の下限(秒)
  maxPeriod: 9.0, // 上限(秒)。空けすぎたらカウントリセット
  jitter: 1.2,    // 周期のばらつき許容(秒)。狭いほど厳しい
  cycles: 6,      // 連続何周期そろったら「いびき」と断定するか
};

const SPEAKING_DELAY = 100; // @discordjs/voice が end を出すまでの猶予。burst から引く

const fresh = () => ({ lastStart: 0, periods: [] });

// 発話1回ぶんを食わせる。いびき確定なら true。
function onBurst(s, startedAt, endedAt) {
  const burst = (endedAt - startedAt - SPEAKING_DELAY) / 1000;
  const period = s.lastStart ? (startedAt - s.lastStart) / 1000 : 0;
  s.lastStart = startedAt;
  if (burst < T.minBurst || burst > T.maxBurst || period < T.minPeriod || period > T.maxPeriod) {
    s.periods.length = 0; // 規則が途切れたら最初から数え直し
    return false;
  }
  s.periods.push(period);
  if (s.periods.length > T.cycles) s.periods.shift();
  return s.periods.length >= T.cycles && Math.max(...s.periods) - Math.min(...s.periods) <= T.jitter;
}

// self-check: 規則的＝いびき / それ以外 を取り違えたら起動時に落ちる。[発話秒, 無音秒] の列
{
  const sim = (pattern) => {
    const s = fresh();
    let t = 0, hit = false;
    for (const [burst, gap] of pattern) {
      hit = onBurst(s, t, t + burst * 1000 + SPEAKING_DELAY) || hit;
      t += (burst + gap) * 1000;
    }
    return hit;
  };
  const snoring = Array.from({ length: 10 }, () => [1.5, 2.4]);
  // 長さも間隔も許容内だが周期がバラバラな会話（jitter だけが弾ける形）
  const talking = [[1.0, 1.2], [2.4, 6.0], [0.9, 1.4], [3.0, 4.5], [1.2, 1.0], [2.0, 6.5], [1.0, 1.5], [2.8, 5.0], [1.1, 1.1], [2.2, 6.2]];
  const tapping = Array.from({ length: 10 }, () => [0.2, 3.0]); // 規則的だが短すぎる物音
  if (!sim(snoring)) throw new Error('snore: いびきを検出できていない');
  if (sim(talking)) throw new Error('snore: 会話を誤検出している');
  if (sim(tapping)) throw new Error('snore: 物音を誤検出している');
}

// --- ここから Discord 側 ---

const states = new Map(); // `${guildId}:${userId}` -> 検出状態
const kill = (conn) => { try { conn?.destroy(); } catch { /* もう死んでる */ } };

// 監視対象がVCに居ればそこへ入り直す、居なければ抜ける。呼び直しても安全。
// ponytail: 1ギルドにつき1VCだけ見る。複数VC同時に見たくなったら Bot を増やすのが早い。
export function sync(guild) {
  const conn = getVoiceConnection(guild.id);
  const target = guild.voiceStates.cache.find((v) => v.channelId && watched.has(v.id));
  console.log(`[snore] sync ${guild.name}: 監視対象=${watched.size}人 / VC内の対象=${target ? target.id + '@' + target.channelId : 'なし'} / 接続中=${conn?.joinConfig.channelId ?? 'なし'}`);
  if (!target) return kill(conn);
  if (conn?.joinConfig.channelId === target.channelId) return;
  kill(conn);

  // 権限が無いと joinVoiceChannel は例外も投げず signalling のまま固まる。先に潰して理由を出す。
  const ch = guild.channels.cache.get(target.channelId);
  const need = ch?.permissionsFor(guild.members.me)?.missing([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.Connect,
  ]);
  if (need?.length) return console.warn(`[snore] ${ch.name} に入れない。不足権限: ${need.join(', ')}`);

  const c = joinVoiceChannel({
    channelId: target.channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // 聞こえないと検出できない
    selfMute: true,
  });
  listen(c, guild);
  entersState(c, VoiceConnectionStatus.Ready, 15_000)
    .then(() => console.log(`[snore] ${ch?.name ?? target.channelId} で待機中`))
    .catch(() => { console.warn('[snore] VC接続が15秒で確立せず。切断してやり直し'); kill(c); });
}

function listen(conn, guild) {
  conn.on(VoiceConnectionStatus.Disconnected, () => kill(conn)); // 蹴られたら諦める
  conn.on('error', (e) => console.warn('[snore] connection:', e.message));
  conn.on('stateChange', (o, n) => console.log(`[snore] 接続 ${o.status} → ${n.status}`));

  const startedAt = new Map();
  conn.receiver.speaking.on('start', (id) => { if (watched.has(id)) startedAt.set(id, Date.now()); });
  conn.receiver.speaking.on('end', async (id) => {
    const t0 = startedAt.get(id);
    if (!t0) return;
    startedAt.delete(id);
    const key = `${guild.id}:${id}`;
    let s = states.get(key);
    if (!s) states.set(key, (s = fresh()));
    const hit = onBurst(s, t0, Date.now());
    // しきい値を実測で詰めるための可視化。対象ユーザーの発話時だけなので量は出ない。
    console.log(`[snore] ${id} 発話${((Date.now() - t0 - SPEAKING_DELAY) / 1000).toFixed(1)}秒 周期=[${s.periods.map((p) => p.toFixed(1))}]`);
    if (!hit) return;
    states.delete(key);

    const member = await guild.members.fetch(id).catch(() => null);
    if (!member?.voice.channelId) return;
    console.log(`[snore] ${member.user.tag} いびき検出 → 切断`);
    await member.voice.disconnect('いびき検出（寝落ち）')
      .catch((e) => console.warn('[snore] 切断失敗（Move Members 権限は？）:', e.message));
    await member.send('😴 いびきを検出したのでVCから切断しました。おやすみ。').catch(() => {});
  });
}
