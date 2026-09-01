import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { watched, save, sync } from '../snore.js';

export const data = new SlashCommandBuilder()
  .setName('nemuochi')
  .setDescription('寝落ち（いびき）を検出したらVCから切ってもらう(自分専用)')
  .addStringOption((o) =>
    o.setName('mode').setDescription('on / off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }));

export async function execute(interaction) {
  const on = interaction.options.getString('mode') === 'on';
  on ? watched.add(interaction.user.id) : watched.delete(interaction.user.id);
  save();
  sync(interaction.guild); // 今VCに居るなら即その場で聞き始める / 抜ける
  await interaction.reply({
    content: on ? '🛏️ 見張ります。いびきを検出したらVCから切断します。' : '👋 見張りを解除しました。',
    flags: MessageFlags.Ephemeral,
  });
}
