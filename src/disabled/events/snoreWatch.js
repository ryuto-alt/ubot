// 監視対象がVCを出入りしたら、いびき監視の接続を張り直す。
import { Events } from 'discord.js';
import { sync } from '../snore.js';

export const name = Events.VoiceStateUpdate;

export function execute(oldState, newState) {
  if (oldState.channelId === newState.channelId) return; // ミュート等は無視
  sync(newState.guild);
}
