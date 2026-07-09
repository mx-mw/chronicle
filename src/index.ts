import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  SlashCommandBuilder,
  type SendableChannels,
} from 'discord.js';
import path from 'node:path';
import { config } from './config.js';
import { describeProvider } from './llm.js';
import { processMeeting } from './pipeline.js';
import { recall } from './recall.js';
import { RecordingSession } from './recorder.js';
import { assertParakeetReady } from './transcribe.js';

const sessions = new Map<string, RecordingSession>(); // guildId -> active session

const commands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Record the current voice channel into the knowledge base')
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Join your voice channel and start recording'),
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
  const { segments, speakers, durationMs } = await session.stop();

  // Long meetings can take a while to transcribe; the interaction token only
  // lives 15 minutes, so all further updates go through the channel directly.
  const channel = interaction.channel as SendableChannels | null;
  const say = async (msg: string) => channel?.send(msg).catch(() => {});

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
