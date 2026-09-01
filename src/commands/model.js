import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { MODELS, currentAlias, setAlias } from '../gptsol.js';

export const data = new SlashCommandBuilder()
  .setName('model')
  .setDescription('gptsol のモデルを切り替え')
  .addStringOption((o) =>
    o
      .setName('name')
      .setDescription('使うモデル')
      .setRequired(true)
      .addChoices(
        { name: 'sol — 高性能(無料枠 25万/日)', value: 'sol' },
        { name: 'terra — 軽量(無料枠 250万/日)', value: 'terra' },
      ),
  );

export async function execute(interaction) {
  const alias = interaction.options.getString('name');
  const before = currentAlias();
  setAlias(alias);
  await interaction.reply({
    content:
      before === alias
        ? `🧠 もう **${alias}** (\`${MODELS[alias].id}\`) だよ`
        : `🧠 モデルを **${before}** → **${alias}** (\`${MODELS[alias].id}\`) に切り替えた。${MODELS[alias].desc}`,
    flags: MessageFlags.Ephemeral,
  });
}
