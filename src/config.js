// guild ごとのチャンネル設定を JSON で保存。/config で設定、未設定ならチャンネル名から自動検出。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'data', 'config.json');

// ponytail: 設定は小さいので毎回ファイル全読み/全書き。件数が増えたら sqlite 等に。
function loadAll() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveAll(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function getConfig(guildId) {
  return loadAll()[guildId] ?? {};
}
export function setConfig(guildId, key, channelId) {
  const all = loadAll();
  all[guildId] ??= {};
  all[guildId][key] = channelId;
  saveAll(all);
}

// 通話チャンネル → 通知先テキストチャンネル の対応。VCごとに別の通知先を持てる。
export function getVcMap(guildId) {
  return loadAll()[guildId]?.vcmap ?? {};
}
export function setVc(guildId, voiceId, textId) {
  const all = loadAll();
  all[guildId] ??= {};
  all[guildId].vcmap ??= {};
  all[guildId].vcmap[voiceId] = textId;
  saveAll(all);
}
export function unsetVc(guildId, voiceId) {
  const all = loadAll();
  if (all[guildId]?.vcmap) {
    delete all[guildId].vcmap[voiceId];
    saveAll(all);
  }
}

// 未設定時のチャンネル名フォールバック（部分一致）
const FALLBACK = {
  welcome: ['ようこそ', 'welcome'],
  leave: ['退出', '退室', 'leave', 'bye'],
};

export function resolveChannel(guild, key) {
  const id = getConfig(guild.id)[key];
  if (id) {
    const c = guild.channels.cache.get(id);
    if (c) return c;
  }
  const names = FALLBACK[key] ?? [];
  return (
    guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && names.some((n) => c.name.includes(n)),
    ) ?? null
  );
}
