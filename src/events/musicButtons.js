import { Events, MessageFlags } from 'discord.js';
import { queueText, setLoop, skip, stop, togglePause } from '../music.js';

export const name = Events.InteractionCreate;

// 操作パネルのボタン。VCにいる人なら誰でも押せる
export async function execute(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('music:')) return;

  const action = interaction.customId.slice('music:'.length);
  if (action === 'queue') {
    return interaction.reply({ content: queueText(interaction.guild), flags: MessageFlags.Ephemeral });
  }
  if (!interaction.member?.voice?.channel) {
    return interaction.reply({ content: 'VCに入ってから押して', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (action === 'skip') await skip(guild);
  else if (action === 'stop') await stop(guild);
  else if (action === 'pause') await togglePause(guild);
  else if (action === 'loop') await setLoop(guild, 'track', true);
  else if (action === 'qloop') await setLoop(guild, 'queue', true);
}
