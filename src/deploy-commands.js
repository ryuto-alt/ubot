// スラッシュコマンドを Discord に登録する。コマンドを追加/変更したら実行: npm run deploy
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const commands = [];
const commandsDir = join(__dirname, 'commands');
for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const cmd = await import(pathToFileURL(join(commandsDir, file)).href);
  if (cmd.data) commands.push(cmd.data.toJSON());
}

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const rest = new REST().setToken(DISCORD_TOKEN);

// GUILD_ID があればそのサーバーに即時登録（カンマ区切りで複数可）。無ければグローバル登録（反映に最大1時間）。
const guilds = (GUILD_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (!guilds.length) {
  const data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`✅ ${data.length} 個のコマンドをグローバルに登録しました。`);
}
for (const id of guilds) {
  const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, id), { body: commands });
  console.log(`✅ ${data.length} 個のコマンドを サーバー ${id} に登録しました。`);
}
