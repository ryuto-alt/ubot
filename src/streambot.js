import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enqueue,
  getState,
  getStreamerClient,
  joinVC,
  listVoiceChannels,
  next,
  pause,
  resume,
  seek,
  stop,
} from './stream.js';

// Go Live配信の操作パネル。起動: npm run douga → ブラウザが開く
// ponytail: 認証もHTTPSも無し。localhost限定で自分しか叩かないので要らない
const PORT = Number(process.env.DOUGA_PORT) || 8787;
const UI = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');

const body = async (req) => {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
};
const json = (res, data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

const routes = {
  '/join': async (d) => (await joinVC(d.guildId, d.channelId), { ok: true }),
  '/play': async (d) => ({ title: await enqueue(d.url) }),
  '/seek': async (d) => (await seek(Number(d.t)), { ok: true }),
  '/pause': async () => (pause(), { ok: true }),
  '/resume': async () => (await resume(), { ok: true }),
  '/next': async () => (await next(), { ok: true }),
  '/stop': async () => (stop(), { ok: true }),
};

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  try {
    if (req.method === 'POST' && routes[path]) return json(res, await routes[path](await body(req)));
    if (path === '/state') return json(res, getState());
    if (path === '/channels') return json(res, await listVoiceChannels());
    if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(await readFile(UI));
    res.writeHead(404).end();
  } catch (e) {
    console.error('[douga]', e);
    json(res, { error: e.message });
  }
});

const client = await getStreamerClient();
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`配信垢: ${client.user.tag} — ${url}`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});

process.on('SIGINT', () => (stop(), process.exit(0)));
