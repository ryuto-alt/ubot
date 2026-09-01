import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { MODELS, currentAlias, usageToday } from '../gptsol.js';

export const data = new SlashCommandBuilder()
  .setName('usage')
  .setDescription('gptsol の今日のトークン使用量を表示');

export async function execute(interaction) {
  const { date, totals } = usageToday();
  const cur = currentAlias();

  const lines = Object.entries(MODELS).map(([alias, m]) => {
    const total = totals[alias] ?? 0;
    const pct = (total / m.limit) * 100;
    const bar = '█'.repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, '░');
    const mark = alias === cur ? '👉 ' : '　 ';
    return `${mark}**${alias}** \`${bar}\` ${pct.toFixed(1)}% — ${(total / 10000).toFixed(2)}万 / ${m.limit / 10000}万`;
  });

  await interaction.reply({
    content: `📊 **gptsol 今日の使用量** (UTC ${date})\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}
