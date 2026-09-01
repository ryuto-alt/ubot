import { Events, EmbedBuilder } from 'discord.js';
import { resolveChannel } from '../config.js';

export const name = Events.GuildMemberRemove;

export async function execute(member) {
  const channel = resolveChannel(member.guild, 'leave');
  if (!channel) return;

  const now = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('👋 退出')
    .setDescription(`**${member.user.tag}** さんが退出しました。\n現在のメンバー数: **${member.guild.memberCount}人**`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields({ name: '⏰ 退出日時', value: `<t:${now}:F>`, inline: false })
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();

  // joinedTimestamp はキャッシュにあれば在籍期間を出す
  if (member.joinedTimestamp) {
    embed.addFields({
      name: '📅 参加していた期間',
      value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R> から`,
      inline: false,
    });
  }

  await channel.send({ embeds: [embed] });
}
