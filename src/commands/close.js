import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { openerOf, close } from '../ticket.js';

export const data = new SlashCommandBuilder()
  .setName('close')
  .setDescription('このお問い合わせチケットを閉じる');

export async function execute(interaction) {
  const opener = openerOf(interaction.channel);
  if (!opener) {
    return interaction.reply({ content: '⚠️ ここはお問い合わせチャンネルではありません。', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply(`🔒 ${interaction.user} がこのお問い合わせを閉じました。履歴は管理者にだけ残ります。`);
  await close(interaction.channel, opener);
}
