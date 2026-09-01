import { Events } from 'discord.js';

// ponytail: 音を出さないので @discordjs/voice は不要。ゲートウェイ op4 を投げるだけで VC に居座れる。
const GUILD_ID = '1524616969964359720';
const CHANNEL_ID = '1534208916219498689'; // ゲーム2

export const name = Events.ClientReady;
export const once = true;

export function execute(client) {
  const join = () => {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    if (guild.members.me?.voice?.channelId === CHANNEL_ID) return; // 既に居るなら何もしない
    guild.shard.send({
      op: 4,
      d: { guild_id: GUILD_ID, channel_id: CHANNEL_ID, self_mute: true, self_deaf: true },
    });
    console.log('[vcstay] 接続要求を送信');
  };
  join();
  setInterval(join, 60_000); // 再接続で voice state が消えたら入り直す
}
