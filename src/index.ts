import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  SlashCommandBuilder,
  type SendableChannels,
  type VoiceBasedChannel,
} from 'discord.js';
import path from 'node:path';
import { config } from './config.js';
import { describeProvider } from './llm.js';
import { processMeeting } from './pipeline.js';
import { recall } from './recall.js';
import { RecordingSession } from './recorder.js';
import { assertParakeetReady } from './transcribe.js';
import { shouldAutoStart, shouldAutoStop } from './voice-policy.js';

const sessions = new Map<string, RecordingSession>(); // guildId -> active session
// Guilds whose session is being set up right now. RecordingSession.start awaits
// the voice connection, so two people joining at once could otherwise both pass
// the "not recording yet" check and start two sessions for one channel.
const startingGuilds = new Set<string>();

/** Count non-bot members in a voice channel. The bot must never count itself. */
function humanCount(channel: VoiceBasedChannel): number {
  return channel.members.filter((m) => !m.user.bot).size;
}

/**
 * Stop a session, run the pipeline, and report back into `channel`. Shared by
 * the manual `/record stop` and the automatic "everyone left" path so both file
 * meetings identically.
 */
async function finishAndFile(
  session: RecordingSession,
  channel: SendableChannels | null,
): Promise<void> {
  const say = async (msg: string) => channel?.send(msg).catch(() => {});
  const { segments, speakers, durationMs } = await session.stop();

  try {
    const result = await processMeeting(segments, speakers, durationMs, (status) => void say(status));
    if (!result) {
      await say('No usable speech was captured, so nothing was added to the knowledge base.');
      return;
    }
    const { summary, written } = result;
    const embed = new EmbedBuilder()
      .setTitle(`📚 ${summary.title}`)
      .setDescription(summary.summary.slice(0, 4000))
      .addFields(
        summary.decisions.length
          ? [{ name: 'Decisions', value: summary.decisions.map((d) => `• ${d}`).join('\n').slice(0, 1024) }]
          : [],
      )
      .addFields(
        summary.action_items.length
          ? [{
              name: 'Action items',
              value: summary.action_items.map((a) => `• **${a.owner}**: ${a.task}`).join('\n').slice(0, 1024),
            }]
          : [],
      )
      .setFooter({
        text: `Filed as ${path.relative(process.cwd(), written.meetingPath)} · ${written.topicPaths.length} topic(s) updated`,
      });
    await channel?.send({ embeds: [embed] });
  } catch (err) {
    console.error('Meeting pipeline failed:', err);
    await say(`⚠️ Failed to process the meeting: ${err instanceof Error ? err.message : err}`);
  }
}

/** Join a voice channel and start recording it. No-op if already recording/starting the guild. */
async function autoStartRecording(channel: VoiceBasedChannel): Promise<void> {
  const guildId = channel.guild.id;
  if (sessions.has(guildId) || startingGuilds.has(guildId)) return;

  startingGuilds.add(guildId);
  try {
    const session = await RecordingSession.start(channel, config.sessionsDir, async (userId) => {
      const m = await channel.guild.members.fetch(userId);
      return m.displayName;
    });
    sessions.set(guildId, session);
    // Consent matters more here than for a manual start: people are recorded the
    // moment they join, without typing anything. Announce it in the voice
    // channel's own text chat, where they'll see it.
    await (channel as unknown as SendableChannels)
      .send(
        `🔴 **Recording ${channel.name}.** Everyone here is being recorded — ` +
          `it stops and files itself automatically when the last person leaves.`,
      )
      .catch(() => {});
  } catch (err) {
    console.error('Auto-start recording failed:', err);
  } finally {
    startingGuilds.delete(guildId);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Record the current voice channel into the knowledge base')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Force-start recording (Chronicle already auto-joins when someone enters a call)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop recording, then transcribe and summarise the meeting'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show whether a recording is in progress'),
    ),
  new SlashCommandBuilder()
    .setName('recall')
    .setDescription('Search the knowledge base')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('What to look for').setRequired(true),
    ),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async () => {
  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
  } else {
    await client.application!.commands.set(commands);
  }
  console.log(`Chronicle is ready as ${client.user!.tag}`);
  console.log(`Distilling and answering with ${describeProvider()}`);
});

/**
 * Auto-record: join when a human enters a voice channel, stop and file when the
 * last one leaves. `/record start|stop` still work as manual overrides.
 *
 * Fires on every voice change (join, leave, move, mute, deafen). We act only on
 * channel changes, and route the two channels involved through the pure
 * decisions in voice-policy.ts.
 */
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (oldState.channelId === newState.channelId) return; // mute/deafen/etc — not a move
    const guildId = (newState.guild ?? oldState.guild).id;

    // Someone left oldState.channel — if it's the room we're recording and it's
    // now empty of humans, wrap up. Done first so a move (leave A → join B) can
    // free the guild before the join check below.
    const session = sessions.get(guildId);
    if (session && oldState.channelId && oldState.channel) {
      const decision = shouldAutoStop({
        leftChannelId: oldState.channelId,
        recordingChannelId: session.voiceChannelId,
        humansRemaining: humanCount(oldState.channel),
      });
      if (decision) {
        sessions.delete(guildId);
        // Fire-and-forget: processing takes ~seconds and must not block a
        // simultaneous join from starting a fresh session.
        void finishAndFile(session, oldState.channel as unknown as SendableChannels);
      }
    }

    // Someone joined newState.channel — start recording if we aren't already.
    if (
      newState.channel &&
      shouldAutoStart({
        joinerIsBot: newState.member?.user.bot ?? false,
        channelId: newState.channelId,
        alreadyRecording: sessions.has(guildId) || startingGuilds.has(guildId),
        humansInChannel: humanCount(newState.channel),
      })
    ) {
      await autoStartRecording(newState.channel);
    }
  } catch (err) {
    console.error('voiceStateUpdate handler failed:', err);
  }
});

async function handleRecordStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (sessions.has(guildId)) {
    await interaction.reply({ content: 'Already recording in this server.', ephemeral: true });
    return;
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    await interaction.reply({
      content: 'Join a voice channel first, then run `/record start`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const session = await RecordingSession.start(channel, config.sessionsDir, async (userId) => {
    const m = await interaction.guild!.members.fetch(userId);
    return m.displayName;
  });
  sessions.set(guildId, session);

  await interaction.editReply(
    `🔴 **Recording ${channel.name}.** Everyone in the channel is being recorded — ` +
      `run \`/record stop\` to end the meeting and file it into the knowledge base.`,
  );
}

async function handleRecordStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.get(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: 'Nothing is being recorded here.', ephemeral: true });
    return;
  }
  sessions.delete(interaction.guildId!);

  await interaction.reply('⏹️ Recording stopped. Processing the meeting…');
  // Long meetings can take a while to transcribe; the interaction token only
  // lives 15 minutes, so all further updates go through the channel directly.
  await finishAndFile(session, interaction.channel as SendableChannels | null);
}

async function handleRecordStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.get(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: 'Not recording.', ephemeral: true });
    return;
  }
  const minutes = Math.round((Date.now() - session.startedAt) / 60_000);
  await interaction.reply({
    content: `🔴 Recording for ${minutes} min. Speakers so far: ${
      [...session.speakers.values()].join(', ') || 'none yet'
    }`,
    ephemeral: true,
  });
}

async function handleRecall(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString('query', true);
  // Retrieval embeds the query and a model writes the answer, so this runs well
  // past Discord's 3-second reply deadline.
  await interaction.deferReply();

  const { answer, hits } = await recall(query);
  if (hits.length === 0) {
    await interaction.editReply(`Nothing in the knowledge base is relevant to “${query}”.`);
    return;
  }

  const sources = [...new Set(hits.map((h) => h.file.replace(/\.md$/, '')))];
  const embed = new EmbedBuilder()
    .setTitle(`🔎 ${query}`.slice(0, 256))
    .setDescription(answer.slice(0, 4000))
    .setFooter({ text: `Sources: ${sources.join(' · ')}`.slice(0, 2048) });
  await interaction.editReply({ embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Chronicle only works inside a server.', ephemeral: true });
    return;
  }
  try {
    if (interaction.commandName === 'record') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'start') await handleRecordStart(interaction);
      else if (sub === 'stop') await handleRecordStop(interaction);
      else await handleRecordStatus(interaction);
    } else if (interaction.commandName === 'recall') {
      await handleRecall(interaction);
    }
  } catch (err) {
    console.error(`Command /${interaction.commandName} failed:`, err);
    const msg = `⚠️ ${err instanceof Error ? err.message : 'Something went wrong.'}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

process.on('SIGINT', () => {
  for (const session of sessions.values()) void session.stop();
  client.destroy();
  process.exit(0);
});

await assertParakeetReady();
await client.login(config.discordToken);
