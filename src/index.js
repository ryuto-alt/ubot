import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Client({
  // 汎用なので主要 intent を全部入れてある。不要なら削ってよい。
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // DM を受けるのに必要
});

// 機能追加 = src/commands/ にファイルを置くだけ。{ data, execute } を export する。
client.commands = new Collection();
const commandsDir = join(__dirname, 'commands');
for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const cmd = await import(pathToFileURL(join(commandsDir, file)).href);
  if (cmd.data && cmd.execute) client.commands.set(cmd.data.name, cmd);
  else console.warn(`[commands] ${file} に data/execute が無いのでスキップ`);
}

// イベント追加 = src/events/ にファイルを置くだけ。{ name, once?, execute } を export する。
const eventsDir = join(__dirname, 'events');
for (const file of readdirSync(eventsDir).filter((f) => f.endsWith('.js'))) {
  const ev = await import(pathToFileURL(join(eventsDir, file)).href);
  const handler = (...args) => ev.execute(...args, client);
  ev.once ? client.once(ev.name, handler) : client.on(ev.name, handler);
}

client.login(process.env.DISCORD_TOKEN);
