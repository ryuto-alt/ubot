import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { play, resolveTracks } from '../music.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('音楽を流す(URL・プレイリスト・検索語)')
  .addStringOption((o) =>
    o.setName('query').setDescription('YouTubeのURL / プレイリストURL / 曲名').setRequired(true),
  );

export async function execute(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: '先にVCに入って', flags: MessageFlags.Ephemeral });

  await interaction.deferReply();
  const query = interaction.options.getString('query');
  const tracks = await resolveTracks(query);
  if (!tracks.length) return interaction.editReply('曲が見つからなかった…URLか曲名を確認して');

  await play(interaction.guild, vc, tracks, interaction.channel);
  await interaction.editReply(
    tracks.length === 1 ? `🎵 キューに追加: **${tracks[0].title}**` : `🎵 ${tracks.length}曲をキューに追加した`,
  );
}
