// Claude_Code ボットとして発言し、UBot(gptsol)の返事を待って表示する。
//   node --env-file=.env tools/debate.js list
//   node --env-file=.env tools/debate.js say <channelId> "本文"

import { Client, GatewayIntentBits, Partials } from 'discord.js';

const [, , cmd, channelId, ...rest] = process.argv;
const body = rest.join(' ');
const UBOT_ID = process.env.CLIENT_ID;
const WAIT_MS = 90_000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once('clientReady', async () => {
  console.log(`# logged in as ${client.user.tag} (${client.user.id})`);
  try {
    if (cmd === 'list') {
      for (const g of client.guilds.cache.values()) {
        console.log(`\n[guild] ${g.name} (${g.id})`);
        const chans = await g.channels.fetch();
        for (const c of chans.values()) {
          if (c?.isTextBased?.() && !c.isThread()) console.log(`  #${c.name}  ${c.id}`);
        }
      }
    } else if (cmd === 'read') {
      const ch = await client.channels.fetch(channelId);
      const msgs = await ch.messages.fetch({ limit: Number(body) || 10 });
      for (const m of [...msgs.values()].reverse()) {
        console.log(`
=== ${m.author.tag} ${m.createdAt.toISOString()}
${m.content}`);
      }
    } else if (cmd === 'say') {
      const ch = await client.channels.fetch(channelId);
      const parts = [];
      const reply = new Promise((res) => {
        let idle;
        const hard = setTimeout(() => res(parts), WAIT_MS);
        client.on('messageCreate', (m) => {
          if (m.channelId !== channelId || m.author.id !== UBOT_ID) return;
          parts.push(m.content);
          clearTimeout(idle);
          // UBot splits long answers into several messages: wait for the stream to go quiet
          idle = setTimeout(() => { clearTimeout(hard); res(parts); }, 12_000);
        });
      });
      const sent = await ch.send(`<@${UBOT_ID}> ${body}`);
      console.log(`--- sent (${sent.id})`);
      const r = await reply;
      console.log(r ? `--- UBot:\n${r.content}` : '--- UBot: (no reply within 90s)');
    } else {
      console.log('usage: list | read <channelId> <n> | say <channelId> "text"');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  }
  client.destroy();
});

client.login(process.env.CLAUDE_TOKEN);
