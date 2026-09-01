import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';

export const name = Events.InteractionCreate;

// コマンドを打てる人。.env の COMMAND_ALLOW（カンマ区切り）。未設定なら全員可。
// サーバーの管理者権限持ち(鯖主含む)はリストに関係なく常に許可。
// ponytail: チケットのボタン/フォームは対象外。問い合わせは誰でも出せないと意味がないので。
const ALLOW = (process.env.COMMAND_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// 誰でも使えるコマンド(VCの音楽操作は参加者全員に開放)
const PUBLIC = new Set(['play', 'ping']);

export async function execute(interaction, client) {
  if (!interaction.isChatInputCommand()) return;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  if (ALLOW.length && !isAdmin && !PUBLIC.has(interaction.commandName) && !ALLOW.includes(interaction.user.id)) {
    return interaction.reply({ content: '⛔ このBotのコマンドを使う権限がありません。', flags: MessageFlags.Ephemeral });
  }
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    const reply = { content: '⚠️ コマンド実行中にエラーが発生しました。', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}
