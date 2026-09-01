import { Events, EmbedBuilder } from 'discord.js';
import { resolveChannel } from '../config.js';

export const name = Events.GuildMemberAdd;

export async function execute(member) {
  const channel = resolveChannel(member.guild, 'welcome');
  if (!channel) return;

  const created = Math.floor(member.user.createdTimestamp / 1000);
  const now = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎉 ようこそ！')
    .setDescription(`${member} さんが参加しました！\nこれで **${member.guild.memberCount}人** 目のメンバーです 🎊`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '👤 ユーザー', value: member.user.tag, inline: true },
      { name: '🗓️ アカウント作成', value: `<t:${created}:R>`, inline: true },
      { name: '⏰ 参加日時', value: `<t:${now}:F>`, inline: false },
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();

  await channel.send({ content: `${member}`, embeds: [embed] });
}
