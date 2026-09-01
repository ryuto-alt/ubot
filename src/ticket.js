// お問い合わせチケット。パネル → ボタン → 入力フォーム → 専用チャンネル → close。
// ponytail: チケットの実体は「チャンネルのトピックに ticket:<userId> と書いてあるチャンネル」だけ。
//           DBもJSONも持たない。Discord自身が状態を持っているので二重管理しない。
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  ModalBuilder, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle,
} from 'discord.js';

const TAG = 'ticket:';
export const tagOf = (userId) => TAG + userId;
export const openerOf = (channel) => (channel?.topic?.startsWith(TAG) ? channel.topic.slice(TAG.length) : null);

// チャンネル名に使える形へ。日本語名などで空になったらIDで代用する。
export const slug = (user) => 'ticket-' + (user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || user.id);

// self-check: トピック解析とチャンネル名生成が壊れたら起動時に落ちる
{
  const ok = (c, e) => { if (JSON.stringify(c) !== JSON.stringify(e)) throw new Error(`ticket: ${JSON.stringify(c)} != ${JSON.stringify(e)}`); };
  ok(openerOf({ topic: tagOf('123') }), '123');
  ok(openerOf({ topic: '雑談' }), null);
  ok(openerOf({}), null);
  ok(slug({ username: 'Ryuto_99', id: '1' }), 'ticket-ryuto99');
  ok(slug({ username: 'りゅうと', id: '42' }), 'ticket-42');
}

export function panel() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📩 お問い合わせ')
      .setDescription('下のボタンから運営に問い合わせできます。\nフォームを送ると、**あなたと管理者だけが見える**専用チャンネルが作られます。')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('お問い合わせする').setEmoji('📩').setStyle(ButtonStyle.Primary))],
  };
}

export function form() {
  const field = (id, label, style, max) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(true));
  return new ModalBuilder().setCustomId('ticket_form').setTitle('お問い合わせ内容')
    .addComponents(field('subject', '件名', TextInputStyle.Short, 80), field('body', '内容', TextInputStyle.Paragraph, 1000));
}

// 専用チャンネルを作る。管理者は Administrator 権限で自動的に見えるので上書きは不要。
export async function open(guild, user, parentId, subject, body) {
  const ch = await guild.channels.create({
    name: slug(user),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: tagOf(user.id),
    reason: `お問い合わせ: ${user.tag}`,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [P.ViewChannel] },
      { id: user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
      { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
    ],
  });
  await ch.send({
    content: `${user} お問い合わせありがとうございます。担当者が来るまでここに詳細を書いてください。`,
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(subject)
      .setDescription(body)
      .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
      .setFooter({ text: '管理者は /close で閉じられます' })
      .setTimestamp()],
  });
  return ch;
}

// 閉じる = 削除ではなく「相談者の閲覧権を剥がして改名」。履歴は管理者に残る。
// ponytail: チャンネル改名は10分に2回までのレート制限あり。連打すると名前だけ遅れて変わる。
export async function close(channel, opener) {
  await channel.permissionOverwrites.delete(opener, 'チケットをクローズ');
  if (!channel.name.startsWith('closed-')) await channel.setName(`closed-${channel.name}`.slice(0, 100));
}
