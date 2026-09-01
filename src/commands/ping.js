import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Pong! 応答速度を返します');

export async function execute(interaction) {
  await interaction.reply(`🏓 Pong! \`${Math.round(interaction.client.ws.ping)}ms\``);
}
