import { SlashCommandBuilder } from 'discord.js';
import { panel } from '../ticket.js';

// 誰が打てるかは .env の COMMAND_ALLOW だけで決める。
// ponytail: ここに setDefaultMemberPermissions を足すと、権限の無い人には予測変換にすら出なくなる。ゲートは一箇所。
export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('このチャンネルにお問い合わせパネルを設置する');

export async function execute(interaction) {
  await interaction.reply(panel());
}
