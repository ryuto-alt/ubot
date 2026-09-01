import { Events, EmbedBuilder } from 'discord.js';
import { getVcMap } from '../config.js';

export const name = Events.VoiceStateUpdate;

// `${guildId}:${userId}` -> 通話開始時刻(ms)。
// ponytail: プロセス内メモリのみ。Bot 再起動を跨いだ通話は時間不明（その場合は時間欄を出さない）。
const joinedAt = new Map();

export async function execute(oldState, newState) {
  const oldCh = oldState.channelId;
  const newCh = newState.channelId;
  if (oldCh === newCh) return; // ミュート等は無視（入退室・移動だけ）

  const guild = newState.guild;
  const map = getVcMap(guild.id);
  const user = (newState.member ?? oldState.member)?.user;
  if (!user) return;
  const key = `${guild.id}:${user.id}`;

  // 通話開始（初参加）= 開始時刻を記録。移動は継続なので触らない。
  if (!oldCh) joinedAt.set(key, Date.now());

  // 参加先への通知
  if (newCh && map[newCh]) {
    await notify(guild, map[newCh], user, {
      color: 0x57f287,
      emoji: '🔊',
      title: '通話に参加',
      channelName: newState.channel.name,
    });
  }

  // 退出元への通知（完全切断のときだけ通話時間を出す）
  if (oldCh && map[oldCh]) {
    const disconnected = !newCh;
    const start = disconnected ? joinedAt.get(key) : null;
    await notify(guild, map[oldCh], user, {
      color: 0xed4245,
      emoji: '🔇',
      title: disconnected ? '通話を切断' : '通話から退出',
      channelName: oldState.channel.name,
      duration: start ? fmtDuration(Date.now() - start) : null,
    });
  }

  // 切断したら開始時刻を破棄
  if (!newCh) joinedAt.delete(key);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
// self-check: フォーマットが壊れたら起動時に落ちる
if (fmtDuration(3661000) !== '01:01:01') throw new Error('fmtDuration broken');

async function notify(guild, channelId, user, { color, emoji, title, channelName, duration }) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return;
  const now = Math.floor(Date.now() / 1000);

  const fields = [
    { name: '👤 ユーザー', value: user.tag, inline: true },
    { name: '🔊 チャンネル', value: channelName, inline: true },
  ];
  if (duration) fields.push({ name: '⏱️ 通話時間', value: `\`${duration}\``, inline: true });
  fields.push({ name: '🕐 時刻', value: `<t:${now}:F>`, inline: false });

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${title}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(`## ${user}\n${emoji} **${channelName}**`)
    .addFields(...fields)
    .setFooter({ text: `ID: ${user.id}` })
    .setTimestamp();

  await ch.send({ embeds: [embed] });
}
