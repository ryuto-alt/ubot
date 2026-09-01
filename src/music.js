import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { spawn } from 'node:child_process';

// ギルドごとの再生状態。キュー/ループ/操作パネルを持つ
// ponytail: 状態はメモリのみ。再起動で消えるが、VC接続も切れるので保存する意味がない
const states = new Map();

// 以前は web_embedded が必要だったが、そっちが死んだのでデフォルトクライアントに戻した(2026-08-20)
// yt-dlp が古いと形式が取れないので、取得できなくなったら yt-dlp を更新すること
// .env に YTDLP_COOKIES=firefox 等を入れると、そのブラウザのCookieでYouTubeにアクセスする。
// YouTubeの「ボットではないことを確認」で弾かれるときの対策。ログイン情報を渡すことになるので既定は無効
// -4 (IPv4強制) が必須: この回線はIPv6が固定アドレスなので、叩きすぎるとYouTubeに
// 「ボットではないことを確認」で個別に弾かれる。MAP-EのIPv4側は別アドレスなので回避できる。
// 将来IPv4側が弾かれたら、逆に -6 にするか時間を置く
const IPV4 = ['-4'];
const YTDLP_BASE = !process.env.YTDLP_COOKIES
  ? []
  : process.env.YTDLP_COOKIES.endsWith('.txt')
    ? ['--cookies', process.env.YTDLP_COOKIES] // cookies.txt を書き出した場合
    : ['--cookies-from-browser', process.env.YTDLP_COOKIES]; // ブラウザ名(要ブラウザ完全終了)

export const LOOP_LABEL = { off: 'オフ', track: '1曲', queue: 'リスト' };

function getState(guildId) {
  let s = states.get(guildId);
  if (!s) {
    s = { queue: [], current: null, loop: 'off', player: null, panel: null, procs: [], skipping: false };
    states.set(guildId, s);
  }
  return s;
}

const fmt = (sec) =>
  sec == null || Number.isNaN(sec) ? 'LIVE' : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---- 曲情報の取得(URL / 検索語 / プレイリスト) ----
export function resolveTracks(query) {
  const isUrl = /^https?:\/\//.test(query);
  const isPlaylist = isUrl && /[?&]list=/.test(query);
  const args = [
    ...IPV4,
    ...YTDLP_BASE,
    '--ignore-errors',
    '--print',
    '%(title)s\t%(duration)s\t%(webpage_url)s',
    isPlaylist ? '--yes-playlist' : '--no-playlist',
    ...(isPlaylist ? ['--flat-playlist'] : []),
    isUrl ? query : `ytsearch1:${query}`,
  ];
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const tracks = out
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((c) => c.length >= 3 && c[2].startsWith('http'))
        .map(([title, duration, url]) => ({
          title,
          duration: duration === 'NA' ? null : Number(duration),
          url,
        }));
      resolve(tracks);
    });
    p.on('error', () => resolve([]));
  });
}

// ---- 再生 ----
function startStream(state, track) {
  killProcs(state);
  const dl = spawn('yt-dlp', [...IPV4, ...YTDLP_BASE, '-f', 'bestaudio', '--no-playlist', '-q', '-o', '-', track.url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  dl.stderr.on('data', (d) => (err = (err + d).slice(-300)));
  dl.on('close', (code) => {
    if (code) console.error('[music] yt-dlp exit', code, err.trim());
  });
  // opusエンコードはffmpegに任せる(@discordjs/opusはPiでビルドできないため)
  const ff = spawn(
    'ffmpeg',
    ['-loglevel', 'quiet', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  dl.stdout.pipe(ff.stdin);
  ff.stdin.on('error', () => {}); // 停止時のEPIPEは無視
  state.procs = [dl, ff];
  state.player.play(createAudioResource(ff.stdout, { inputType: StreamType.OggOpus }));
}

function killProcs(state) {
  for (const p of state.procs) p.kill('SIGKILL');
  state.procs = [];
}

function nextTrack(state) {
  if (state.loop === 'track' && state.current) return state.current;
  const t = state.queue.shift() ?? null;
  if (t && state.loop === 'queue') state.queue.push(t); // リストループ: 末尾に戻す
  return t;
}

async function advance(state, guild) {
  const track = nextTrack(state);
  state.current = track;
  if (!track) {
    await updatePanel(state, guild, true);
    leave(guild);
    return;
  }
  startStream(state, track);
  await updatePanel(state, guild);
}

// ---- 操作パネル ----
function buildPanel(state, finished) {
  const cur = state.current;
  const embed = new EmbedBuilder()
    .setColor(finished ? 0x99aab5 : 0x5865f2)
    .setTitle(finished ? '⏹️ 再生終了' : '🎵 再生中')
    .setDescription(cur && !finished ? `**[${cur.title}](${cur.url})**\n\`${fmt(cur.duration)}\`` : 'キューは空っぽ')
    .addFields(
      { name: 'ループ', value: LOOP_LABEL[state.loop], inline: true },
      { name: '待機中', value: `${state.queue.length} 曲`, inline: true },
    );
  if (state.queue.length) {
    embed.addFields({
      name: '次の曲',
      value: state.queue.slice(0, 5).map((t, i) => `${i + 1}. ${t.title} \`${fmt(t.duration)}\``).join('\n'),
    });
  }

  const paused = state.player?.state.status === AudioPlayerStatus.Paused;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:pause').setLabel(paused ? '再生' : '一時停止').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:skip').setLabel('スキップ').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:stop').setLabel('停止').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:loop').setLabel('1曲ループ').setEmoji('🔂').setStyle(state.loop === 'track' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:qloop').setLabel('リストループ').setEmoji('🔁').setStyle(state.loop === 'queue' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:queue').setLabel('キュー').setEmoji('📜').setStyle(ButtonStyle.Primary),
    ),
  ];
  return { embeds: [embed], components: finished ? [] : rows };
}

export async function updatePanel(state, guild, finished = false) {
  const payload = buildPanel(state, finished);
  if (state.panel) {
    const ok = await state.panel.edit(payload).then(() => true).catch(() => false);
    if (ok) return;
    state.panel = null;
  }
  if (finished) return;
  // まずVC内蔵チャットへ。権限が無ければ頼まれたテキストチャンネルへ
  for (const ch of [state.panelChannel, state.fallbackChannel]) {
    if (!ch) continue;
    state.panel = await ch.send(payload).catch(() => null);
    if (state.panel) return;
  }
}

// ---- 外部API ----
export async function play(guild, voiceChannel, tracks, panelChannel) {
  const state = getState(guild.id);
  state.panelChannel = voiceChannel; // パネルはVCのチャットに出す
  state.fallbackChannel = panelChannel ?? null;

  if (!state.player) {
    state.player = createAudioPlayer();
    state.player.on('error', (e) => console.error('[music]', e.message));
    state.player.on(AudioPlayerStatus.Idle, () => {
      if (state.skipping) return; // 手動スキップ側で進めるので二重に進めない
      advance(state, guild).catch((e) => console.error('[music]', e));
    });
  }

  let conn = getVoiceConnection(guild.id);
  if (!conn || conn.joinConfig.channelId !== voiceChannel.id) {
    conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000).catch(() => {});
  }
  conn.subscribe(state.player);

  state.queue.push(...tracks);
  if (!state.current) await advance(state, guild);
  else await updatePanel(state, guild);
  return state;
}

export async function skip(guild) {
  const state = getState(guild.id);
  if (!state.current) return 'なにも再生してない';
  const skipped = state.current.title;
  state.skipping = true;
  killProcs(state);
  state.player?.stop(true);
  if (state.loop === 'track') state.current = null; // 1曲ループ中でも次に進む
  await advance(state, guild);
  state.skipping = false;
  return `⏭️ 「${skipped}」をスキップした`;
}

export function leave(guild) {
  const state = getState(guild.id);
  killProcs(state);
  state.player?.stop(true);
  state.queue = [];
  state.current = null;
  getVoiceConnection(guild.id)?.destroy();
}

export async function stop(guild) {
  const state = getState(guild.id);
  const had = state.current || state.queue.length;
  state.skipping = true;
  leave(guild);
  await updatePanel(state, guild, true);
  state.panel = null;
  state.skipping = false;
  return had ? '⏹️ 停止してVCから抜けた' : 'なにも再生してなかった';
}

export async function togglePause(guild) {
  const state = getState(guild.id);
  if (!state.player) return 'なにも再生してない';
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  paused ? state.player.unpause() : state.player.pause();
  await updatePanel(state, guild);
  return paused ? '▶️ 再開' : '⏸️ 一時停止';
}

// toggle=true(ボタン)のときは同じモードを押すと解除。AIからの指示は明示的に設定する
export async function setLoop(guild, mode, toggle = false) {
  const state = getState(guild.id);
  state.loop = toggle && state.loop === mode ? 'off' : mode;
  await updatePanel(state, guild);
  return `🔁 ループ: **${LOOP_LABEL[state.loop]}**`;
}

export function queueText(guild) {
  const state = getState(guild.id);
  if (!state.current) return 'キューは空っぽ';
  const list = state.queue.slice(0, 15).map((t, i) => `${i + 1}. ${t.title} \`${fmt(t.duration)}\``);
  return [
    `**再生中:** ${state.current.title} \`${fmt(state.current.duration)}\``,
    list.length ? `**待機中(${state.queue.length}曲):**\n${list.join('\n')}` : '待機中の曲はなし',
    state.queue.length > 15 ? `…ほか${state.queue.length - 15}曲` : '',
  ].filter(Boolean).join('\n');
}

export { getState };
