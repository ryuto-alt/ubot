import { Encoders, Streamer, playStream, prepareStream } from '@dank074/discord-video-stream';
import { Client } from 'discord.js-selfbot-v13';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTracks } from './music.js';

// Botは Go Live できない(Discord側が弾く)ので、サブ垢のユーザートークンで配信する。
//
// 構成は「ローカルに落としたファイル → prepareStream → playStream」の一本道。
// 以前はシークで配信を切らないために mpegts の中継バスを挟んでいたが、映像だけ
// タイムスタンプの辻褄が合わなくなり(スロー再生・音とのズレ)、素直な経路に戻した。
// 代わりにシーク/一時停止/曲送りのたびに Go Live は張り直しになる。
const TMP = join(tmpdir(), 'ubot-douga');
const HEIGHT = Number(process.env.STREAM_HEIGHT) || 720;
// YouTubeにボット判定で弾かれるときは .env に YTDLP_COOKIES=firefox 等(ブラウザ名)を入れる
// -4 必須。IPv6は固定アドレスで、叩きすぎるとYouTubeにボット判定される(MAP-EのIPv4側は別アドレス)
const IPV4 = ['-4'];
const COOKIES = !process.env.YTDLP_COOKIES
  ? []
  : process.env.YTDLP_COOKIES.endsWith('.txt')
    ? ['--cookies', process.env.YTDLP_COOKIES] // cookies.txt を書き出した場合
    : ['--cookies-from-browser', process.env.YTDLP_COOKIES]; // ブラウザ名(要ブラウザ完全終了)
// 上げすぎると受信側で取りこぼし、Discordに「エラー2002(品質を落としています)」が出て、
// 続くと配信ごと切られる(2012)。画質が欲しいときはビットレートではなく解像度を下げる方が効く
const BITRATE = Number(process.env.STREAM_BITRATE) || 1500; // kbps

let streamer;
let gpu; // GPUエンコードが実際に通るか(一度だけ実測して決める)
const state = {
  queue: [], // [{ title, url, duration, file, info, ready }]
  current: null,
  pos: 0, // 今の再生開始位置(秒)
  startedAt: null, // 再生中ならDate.now()、停止中はnull
  session: null, // { abort, command } — 今流している配信
  vc: null,
  retries: 0, // 起動直後に落ち続けるとき諦めるためのカウンタ
};

export const position = () =>
  state.current ? state.pos + (state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0) : 0;

export const getState = () => ({
  vc: state.vc,
  playing: !!state.startedAt,
  position: position(),
  current: state.current && {
    title: state.current.title,
    duration: state.current.duration,
    id: state.current.file,
    info: state.current.info,
  },
  queue: state.queue.map((t) => ({ title: t.title, duration: t.duration })),
  output: state.current && {
    height: Math.min(HEIGHT, state.current.info?.height || HEIGHT),
    fps: (state.current.info?.fps ?? 30) > 30 ? (state.current.info.fps ?? 30) / 2 : (state.current.info?.fps ?? 30),
    kbps: BITRATE,
  },
});

// ---- ログイン ----
async function getStreamer() {
  if (streamer) return streamer;
  if (!process.env.STREAM_TOKEN) throw new Error('.env に STREAM_TOKEN(サブ垢のユーザートークン)が無い');
  const s = new Streamer(new Client());
  await s.client.login(process.env.STREAM_TOKEN);
  try {
    s.client.user.setStatus('online'); // 放っておくと退席(月マーク)扱いになる
  } catch {}
  streamer = s;
  return s;
}

export async function getStreamerClient() {
  return (await getStreamer()).client;
}

export const liveConn = () => streamer?.voiceConnection?.streamConnection?.webRtcConn ?? null;

export async function listVoiceChannels() {
  const s = await getStreamer();
  const owner = (process.env.COMMAND_ALLOW ?? '').split(',')[0]?.trim();
  let here = null; // 自分が今いるVC。既定でこれを選ばせないと別サーバーに入って「動かない」に見える
  const guilds = s.client.guilds.cache.map((g) => {
    const ch = owner && g.voiceStates.cache.get(owner)?.channelId;
    if (ch) here = { guildId: g.id, channelId: ch };
    return {
      guild: g.name,
      channels: g.channels.cache
        .filter((c) => c.type === 'GUILD_VOICE')
        .map((c) => ({ id: c.id, name: c.name, guildId: g.id })),
    };
  });
  return { guilds, here };
}

export async function joinVC(guildId, channelId) {
  const s = await getStreamer();
  const c = s.voiceConnection;
  // 既に同じVCに入っているなら何もしない。ここで入り直すと接続がセッション未確立のものに
  // 置き換わり、以後の配信開始が「Session doesn't exist yet」で失敗し続ける
  if (c?.guildId === guildId && c?.channelId === channelId && c.session_id) {
    state.vc = { guildId, channelId, name: s.client.channels.cache.get(channelId)?.name ?? 'VC' };
    return;
  }
  if (c) s.leaveVoice(); // 中途半端な接続が残っている場合は一度抜けてから入り直す
  await Promise.race([
    s.joinVoice(guildId, channelId),
    new Promise((_, rej) => setTimeout(() => rej(new Error('VCに入れなかった(サブ垢はこのサーバーに居る?)')), 15000)),
  ]);
  state.vc = { guildId, channelId, name: s.client.channels.cache.get(channelId)?.name ?? 'VC' };
}

// ---- 取得(シークを効かせるため一旦ローカルに落とす) ----
function download(url, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'yt-dlp',
      // デコードが軽い H.264 + AAC の mp4 に寄せる。fpsをフィルタに入れると解像度を犠牲にして
      // 低fps版を掴むので、並べ替えで「解像度優先 → 同解像度なら低fps」にする
      [...IPV4, ...COOKIES, '-f', `bv*[height<=?${HEIGHT}][vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/b`, '-S', `res:${HEIGHT},+fps`,
       '--merge-output-format', 'mp4', '--no-playlist', '-q', '-o', file, url],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-300)));
    p.on('close', (code) => (code ? reject(new Error(`ダウンロード失敗: ${err.trim().slice(-150)}`)) : resolve(file)));
    p.on('error', reject);
  });
}

// 実寸とfpsを見てから送出設定を決める(拡大や中途半端なfps変換をしないため)
function probe(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const [w, h, rate] = out.trim().split(',');
      const [num, den] = (rate ?? '30/1').split('/').map(Number);
      resolve({ width: Number(w) || 0, height: Number(h) || 0, fps: den ? num / den : 30 });
    });
    p.on('error', () => resolve({ width: 0, height: 0, fps: 30 }));
  });
}

// 失敗したときに yt-dlp が何と言ったのかを拾う(「見つからなかった」だけだと原因が分からない)
function whyFailed(query) {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', [...IPV4, ...COOKIES, '--no-playlist', '--print', '%(title)s', query], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve(err.split(/\r?\n/).filter((l) => l.includes('ERROR')).pop()?.trim() ?? ''));
    p.on('error', (e) => resolve(e.message));
  });
}

export async function enqueue(query) {
  const [track] = await resolveTracks(query);
  if (!track) throw new Error(`動画が見つからなかった: ${(await whyFailed(query)) || 'URLか検索語を確認して'}`);
  mkdirSync(TMP, { recursive: true });
  const item = { ...track, file: join(TMP, `${Date.now()}.mp4`) };
  item.ready = download(item.url, item.file).then(async () => {
    item.info = await probe(item.file);
  });
  item.ready.catch(() => {});
  if (state.current) {
    state.queue.push(item);
  } else {
    await playItem(item);
  }
  return item.title;
}

// ---- 送出 ----
// GPUエンコードが通るかは一度だけ実際に走らせて確かめる(ビルドにあってもGPUが無ければ落ちる)
async function pickEncoder() {
  if (gpu !== undefined) return gpu;
  gpu = await new Promise((res) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'nullsrc=s=640x360:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { stdio: 'ignore' });
    p.on('close', (code) => res(code === 0));
    p.on('error', () => res(false));
  });
  console.log(`[douga] エンコード: ${gpu ? 'NVENC (GPU)' : 'libx264 (CPU)'}`);
  return gpu;
}

// 受信側に許すバッファ量が映像100ms/音声10msと非対称で、その差だけ音が先に出る。
// ライブラリが公開していない値なので、存在を確かめた上で音声側を映像側に合わせる
function fixPlayoutDelay(tries = 15) {
  const a = liveConn()?._audioPacketizer?.rtpConfig;
  const v = liveConn()?._videoPacketizer?.rtpConfig;
  if (a && v && typeof v.playoutDelayMax === 'number' && typeof a.playoutDelayMax === 'number') {
    a.playoutDelayMax = v.playoutDelayMax;
    return;
  }
  if (tries > 0 && state.session) setTimeout(() => fixPlayoutDelay(tries - 1), 2000);
}

function stopSession() {
  const s = state.session;
  state.session = null;
  if (!s) return;
  s.abort.abort();
  try {
    s.command.kill('SIGKILL');
  } catch {}
  streamer?.stopStream();
}

async function startAt(pos) {
  stopSession();
  if (!state.vc) throw new Error('先にVCを選んで');
  const s = await getStreamer();
  // 音声セッションが確立していないまま配信を始めると「Session doesn't exist yet」で失敗する
  if (!s.voiceConnection?.session_id) await joinVC(state.vc.guildId, state.vc.channelId);
  await pickEncoder();
  const { height = 0, fps = 30 } = state.current.info ?? {};
  state.pos = Math.max(0, pos);
  state.startedAt = Date.now();

  const abort = new AbortController();
  const { output, command } = prepareStream(
    state.current.file,
    {
      customInputOptions: ['-ss', String(state.pos)],
      // 素材より大きく引き伸ばさない。60fpsは半分に間引く(30への直接変換だと25fps素材が不均等になる)
      height: Math.min(HEIGHT, height || HEIGHT),
      frameRate: fps > 30 ? fps / 2 : fps,
      bitrateVideo: BITRATE,
      bitrateVideoMax: Math.round(BITRATE * 1.15), // 瞬間的な山も抑える(山が取りこぼしの原因になる)
      hardwareAcceleratedDecoding: gpu,
      encoder: gpu ? Encoders.nvenc() : Encoders.software({ x264: { preset: 'veryfast' } }),
    },
    abort.signal,
  );
  state.session = { abort, command };
  command.on('error', (e) => abort.signal.aborted || console.error('[douga] ffmpeg', e.message));

  // 最後まで流れたら次の動画へ。途中で落ちた場合は同じ位置から張り直す(たまに止まる対策)。
  // ただし張り直し直後にまた落ちるなら無限ループになるので、続けて失敗したら諦める
  const finish = async () => {
    if (state.session?.abort !== abort || !state.startedAt) return;
    const left = (state.current?.duration ?? 0) - position();
    const soon = Date.now() - state.startedAt < 5000; // すぐ落ちた = 繰り返しても直らない類
    if (!soon) state.retries = 0;
    if (left > 2 && (!soon || ++state.retries <= 2)) {
      console.error(`[douga] 送出が途切れた。${Math.round(position())}秒から張り直す`);
      await startAt(position());
      return;
    }
    state.retries = 0;
    await next();
  };
  playStream(output, s, { type: 'go-live' }, abort.signal)
    .then(finish)
    .catch((e) => {
      if (abort.signal.aborted) return;
      console.error('[douga] playStream', e);
      finish();
    });
  setTimeout(() => fixPlayoutDelay(), 3000);
}

async function playItem(item) {
  await item.ready;
  state.current = item;
  await startAt(0);
}

// ---- 操作 ----
export async function seek(t) {
  if (!state.current) return;
  const target = Math.max(0, Math.min(t, (state.current.duration ?? Number.POSITIVE_INFINITY) - 1));
  if (!state.startedAt) state.pos = target; // 停止中は位置だけ覚える
  else await startAt(target);
}

export function pause() {
  if (!state.current || !state.startedAt) return;
  state.pos = position();
  state.startedAt = null;
  stopSession();
}

export async function resume() {
  if (state.current && !state.startedAt) await startAt(state.pos);
}

const tryDelete = (file) => {
  try {
    rmSync(file, { force: true }); // kill直後はまだ掴まれていて消せないことがある
  } catch {}
};

export async function next() {
  const finished = state.current;
  state.current = null;
  stopSession();
  const item = state.queue.shift();
  if (item) await playItem(item);
  else stop();
  if (finished) tryDelete(finished.file);
}

export function stop() {
  stopSession();
  streamer?.leaveVoice();
  for (const t of [state.current, ...state.queue]) if (t?.file) tryDelete(t.file);
  Object.assign(state, { queue: [], current: null, pos: 0, startedAt: null, vc: null });
}

// 自己チェック: `node src/stream.js [URL]`
// Discordに繋がず、「実際に出てくるフレーム枚数」と「受信側に伝わる1枚の長さ」が噛み合うかを見る。
// ここがズレると受信側でスロー再生や音ズレになる(=今回の不具合の再発検知)。
if (process.argv[1]?.endsWith('stream.js')) {
  const { demux } = await import('@dank074/discord-video-stream');
  mkdirSync(TMP, { recursive: true });
  const [track] = await resolveTracks(process.argv[2] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const file = join(TMP, 'selfcheck.mp4');
  await download(track.url, file);
  const info = await probe(file);
  await pickEncoder();
  const abort = new AbortController();
  const { output, command } = prepareStream(
    file,
    {
      height: Math.min(HEIGHT, info.height || HEIGHT),
      frameRate: info.fps > 30 ? info.fps / 2 : info.fps,
      bitrateVideo: BITRATE,
      hardwareAcceleratedDecoding: gpu,
      encoder: gpu ? Encoders.nvenc() : Encoders.software({ x264: { preset: 'veryfast' } }),
    },
    abort.signal,
  );
  const { video, audio } = await demux(output, { format: 'nut' });
  const c = { v: { n: 0, dur: 0 }, a: { n: 0, dur: 0 } };
  const ms = (x, p) => (Number(x) / p.timeBase.den) * p.timeBase.num * 1000;
  for (const [s, k] of [[video, 'v'], [audio, 'a']])
    s.stream.on('data', (p) => {
      c[k].n++;
      c[k].dur += ms(p.duration, p);
      p.free?.();
    });
  const t0 = Date.now();
  setTimeout(() => {
    const wall = (Date.now() - t0) / 1000;
    const vSpeed = c.v.dur / 1000 / wall;
    const aSpeed = c.a.dur / 1000 / wall;
    console.log(`素材 ${info.width}x${info.height}@${info.fps}fps`);
    console.log(`映像: ${(c.v.n / wall).toFixed(1)}枚/秒, 1枚=${(c.v.dur / c.v.n).toFixed(2)}ms → 中身の進み ${vSpeed.toFixed(3)}x`);
    console.log(`音声: ${(c.a.n / wall).toFixed(1)}個/秒, 1個=${(c.a.dur / c.a.n).toFixed(2)}ms → 中身の進み ${aSpeed.toFixed(3)}x`);
    const ok = Math.abs(vSpeed - aSpeed) < 0.05;
    console.log(ok ? 'ok: 映像と音声の進みが一致している' : 'FAIL: 映像と音声で進み方が違う(スローや音ズレの原因)');
    abort.abort();
    command.kill('SIGKILL');
    process.exit(ok ? 0 : 1);
  }, 20000);
}
