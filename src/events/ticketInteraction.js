// パネルのボタン → フォーム → 専用チャンネル作成。スラッシュコマンドは interactionCreate.js が見ている。
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { form, open, tagOf } from '../ticket.js';

export const name = Events.InteractionCreate;

export async function execute(interaction) {
  if (interaction.isButton() && interaction.customId === 'ticket_open') {
    return interaction.showModal(form());
  }
  if (!interaction.isModalSubmit() || interaction.customId !== 'ticket_form') return;

  const { guild, user } = interaction;
  const ephemeral = { flags: MessageFlags.Ephemeral };

  // 権限が無いと channels.create が例外で落ちるだけなので、理由を先に出す
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({ content: '⚠️ Botに「チャンネルの管理」権限が無いのでチケットを作れません。', ...ephemeral });
  }
  // 二重に立てさせない。1人1チケット。
  const dup = guild.channels.cache.find((c) => c.topic === tagOf(user.id));
  if (dup) return interaction.reply({ content: `⚠️ 対応中のお問い合わせがあります: ${dup}`, ...ephemeral });

  try {
    const ch = await open(
      guild, user, interaction.channel.parentId,
      interaction.fields.getTextInputValue('subject'),
      interaction.fields.getTextInputValue('body'),
    );
    await interaction.reply({ content: `📩 お問い合わせを受け付けました: ${ch}`, ...ephemeral });
  } catch (err) {
    console.error('[ticket] チャンネル作成に失敗:', err);
    await interaction.reply({ content: `⚠️ チケットの作成に失敗しました: ${err.message}`, ...ephemeral });
  }
}
