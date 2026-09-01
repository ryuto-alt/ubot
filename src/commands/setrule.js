import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';

// 無機質・敬語の既定規約。文面を変えたい場合はここを編集。
const RULES = [
  ['§1　相互の尊重', '他の参加者に対する**誹謗中傷・差別的言動・嫌がらせ行為**を禁止いたします。'],
  ['§2　投稿内容', '**法令ならびに公序良俗に反する内容**の投稿を禁止いたします。'],
  ['§3　スパム行為', '**過度な連続投稿・無差別なメンション・広告および勧誘行為**を禁止いたします。'],
  ['§4　チャンネルの用途', '各チャンネルに**定められた用途**に従ってご利用ください。'],
  ['§5　個人情報の保護', 'ご自身および第三者の**個人情報の掲載**を禁止いたします。'],
  ['§6　サーバー外でのやり取り', '**個人間のDM・LINE等、当サーバー外でのやり取りは全て自己責任**といたします。これらに起因する一切のトラブルについて、当サーバーは責任を負いかねます。'],
  ['§7　運営の裁量', '本規約に明記されない事項は、運営の判断に従うものといたします。違反が確認された場合、**警告または退室処分**を実施する場合がございます。'],
];

export const data = new SlashCommandBuilder()
  .setName('setrule')
  .setDescription('サーバー利用規約を配置します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('配置先チャンネル（省略時は現在のチャンネル）')
      .addChannelTypes(ChannelType.GuildText),
  );

export async function execute(interaction) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('サーバー利用規約')
    .setDescription(
      '本サーバーをご利用いただくにあたり、以下の規約を定めます。\n参加された時点で、全ての条項に同意したものとみなします。\n\n━━━━━━━━━━━━━━━━━━',
    )
    .addFields(RULES.map(([name, value]) => ({ name, value, inline: false })))
    .setFooter({ text: '本規約は予告なく改定される場合がございます。' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  await interaction.reply({
    content: `規約を ${channel} に配置いたしました。`,
    flags: MessageFlags.Ephemeral,
  });
}
