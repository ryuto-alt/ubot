import { SlashCommandBuilder } from 'discord.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The PPDS BepInEx plugin drains this file once a second, one name per line.
// ponytail: a file, not a socket — no port to pick, and either side can restart freely.
// APPDATA is Windows-only; on Linux the plugin isn't there anyway, so just don't crash the loader.
const QUEUE = join(process.env.APPDATA ?? process.env.HOME ?? '/tmp', 'ppds-discord-duck', 'queue.txt');

export const data = new SlashCommandBuilder()
  .setName('duck')
  .setDescription('プールにあなたの名前のアヒルを浮かべます')
  .addStringOption((o) =>
    o.setName('name').setDescription('アヒルにつける名前（省略時は表示名）').setMaxLength(24)
  );

export async function execute(interaction) {
  const raw = interaction.options.getString('name') ?? interaction.user.displayName;

  // Newlines would forge extra queue entries; the plugin splits on them.
  const name = raw.replace(/[\r\n]+/g, ' ').trim().slice(0, 24);
  if (!name) {
    await interaction.reply({ content: '名前が空です', ephemeral: true });
    return;
  }

  mkdirSync(dirname(QUEUE), { recursive: true });
  appendFileSync(QUEUE, name + '\n', 'utf8');

  await interaction.reply(`🦆 **${name}** をプールに投入しました`);
}
