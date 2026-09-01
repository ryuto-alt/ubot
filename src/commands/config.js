import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { getConfig, setConfig, getVcMap, setVc, unsetVc } from '../config.js';

const LABELS = { welcome: 'ようこそ', leave: '退出' };

const textOpt = (o) =>
  o
    .setName('channel')
    .setDescription('対象のテキストチャンネル')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true);

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Bot の各種チャンネルを設定')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('welcome').setDescription('ようこそチャンネルを設定').addChannelOption(textOpt))
  .addSubcommand((s) => s.setName('leave').setDescription('退出チャンネルを設定').addChannelOption(textOpt))
  .addSubcommand((s) =>
    s
      .setName('vcset')
      .setDescription('通話チャンネルと、その通知先テキストチャンネルを設定')
      .addChannelOption((o) =>
        o
          .setName('voice')
          .setDescription('対象の通話チャンネル')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true),
      )
      .addChannelOption((o) =>
        o
          .setName('notify')
          .setDescription('入退室を通知するテキストチャンネル')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('vcunset')
      .setDescription('通話チャンネルの通知設定を解除')
      .addChannelOption((o) =>
        o
          .setName('voice')
          .setDescription('解除する通話チャンネル')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) => s.setName('show').setDescription('現在の設定を表示'));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const ephemeral = { flags: MessageFlags.Ephemeral };

  if (sub === 'vcset') {
    const voice = interaction.options.getChannel('voice');
    const notify = interaction.options.getChannel('notify');
    setVc(interaction.guildId, voice.id, notify.id);
    return interaction.reply({ content: `✅ 🔊 ${voice} の入退室を ${notify} に通知します。`, ...ephemeral });
  }

  if (sub === 'vcunset') {
    const voice = interaction.options.getChannel('voice');
    unsetVc(interaction.guildId, voice.id);
    return interaction.reply({ content: `🗑️ ${voice} の通知設定を解除しました。`, ...ephemeral });
  }

  if (sub === 'show') {
    const cfg = getConfig(interaction.guildId);
    const vcmap = getVcMap(interaction.guildId);
    const fmt = (id) => (id ? `<#${id}>` : '未設定（チャンネル名から自動検出）');
    const vcLines =
      Object.entries(vcmap)
        .map(([v, t]) => `<#${v}> → <#${t}>`)
        .join('\n') || '未設定';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('⚙️ 現在の設定')
      .addFields(
        { name: '🎉 ようこそ', value: fmt(cfg.welcome), inline: false },
        { name: '👋 退出', value: fmt(cfg.leave), inline: false },
        { name: '🔊 通話通知', value: vcLines, inline: false },
      );
    return interaction.reply({ embeds: [embed], ...ephemeral });
  }

  const channel = interaction.options.getChannel('channel');
  setConfig(interaction.guildId, sub, channel.id);
  await interaction.reply({ content: `✅ ${LABELS[sub]}チャンネルを ${channel} に設定しました。`, ...ephemeral });
}
