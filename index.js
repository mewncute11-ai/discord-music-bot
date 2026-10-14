require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

const play = require("play-dl");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();
const players = new Map();
const connections = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("เปิดเพลงจาก YouTube")
    .addStringOption(option =>
      option.setName("url")
        .setDescription("ลิงก์ YouTube")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("หยุดเพลง"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("ข้ามเพลง"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("ดูคิวเพลง"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("พักเพลง"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("เล่นเพลงต่อ")
].map(command => command.toJSON());

async function playNext(guildId) {
  const queue = queues.get(guildId);
  const player = players.get(guildId);

  if (!queue || !player || queue.length === 0) {
    return;
  }

  const song = queue.shift();

  try {
    const stream = await play.stream(song.url);

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });

    player.play(resource);
  } catch (error) {
    console.error("เล่นเพลงไม่สำเร็จ:", error);
    await playNext(guildId);
  }
}

client.once("ready", async () => {
  console.log(`บอตออนไลน์แล้ว: ${client.user.tag}`);

  try {
    const rest = new REST({ version: "10" })
      .setToken(process.env.DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("ลงทะเบียนคำสั่งสำเร็จ");
  } catch (error) {
    console.error("ลงทะเบียนคำสั่งไม่สำเร็จ:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;

  if (interaction.commandName === "play") {
    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: "❌ มึงต้องเข้าห้องเสียงก่อนนะ",
        ephemeral: true
      });
    }

    const url = interaction.options.getString("url");

    if (!play.yt_validate(url)) {
      return interaction.reply({
        content: "❌ กรุณาใส่ลิงก์วิดีโอ YouTube ที่ถูกต้อง",
        ephemeral: true
      });
    }

    await interaction.deferReply();

    try {
      const info = await play.video_basic_info(url);

      const song = {
        title: info.video_details.title,
        url
      };

      if (!queues.has(guildId)) queues.set(guildId, []);

      const queue = queues.get(guildId);
      queue.push(song);

      if (!players.has(guildId)) {
        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
          }
        });

        player.on(AudioPlayerStatus.Idle, () => {
          playNext(guildId);
        });

        player.on("error", error => {
          console.error("Audio player error:", error);
        });

        players.set(guildId, player);
      }

      if (!connections.has(guildId)) {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator
        });

        connections.set(guildId, connection);

        connection.on(VoiceConnectionStatus.Disconnected, () => {
          connections.delete(guildId);
        });

        await entersState(
          connection,
          VoiceConnectionStatus.Ready,
          20_000
        );

        connection.subscribe(players.get(guildId));
      }

      const player = players.get(guildId);

      if (player.state.status === AudioPlayerStatus.Idle) {
        await playNext(guildId);
      }

      await interaction.editReply(
        `🎵 เพิ่มเพลง **${song.title}** เข้าคิวแล้ว!`
      );
    } catch (error) {
      console.error(error);
      await interaction.editReply(
        "❌ เปิดเพลงไม่สำเร็จ ลองตรวจสอบลิงก์หรือการเชื่อมต่ออีกครั้ง"
      );
    }
  }

  if (interaction.commandName === "stop") {
    queues.set(guildId, []);

    const player = players.get(guildId);
    if (player) player.stop(true);

    return interaction.reply("⏹️ หยุดเพลงและล้างคิวแล้ว");
  }

  if (interaction.commandName === "skip") {
    const player = players.get(guildId);

    if (!player || player.state.status === AudioPlayerStatus.Idle) {
      return interaction.reply("❌ ตอนนี้ไม่มีเพลงที่กำลังเล่น");
    }

    player.stop(true);
    return interaction.reply("⏭️ ข้ามเพลงแล้ว");
  }

  if (interaction.commandName === "queue") {
    const queue = queues.get(guildId) || [];

    if (queue.length === 0) {
      return interaction.reply("📭 ไม่มีเพลงในคิว");
    }

    const list = queue
      .slice(0, 10)
      .map((song, index) => `${index + 1}. ${song.title}`)
      .join("\n");

    return interaction.reply(`🎶 **คิวเพลง**\n${list}`);
  }

  if (interaction.commandName === "pause") {
    const player = players.get(guildId);

    if (!player || !player.pause()) {
      return interaction.reply("❌ ไม่มีเพลงให้พัก");
    }

    return interaction.reply("⏸️ พักเพลงแล้ว");
  }

  if (interaction.commandName === "resume") {
    const player = players.get(guildId);

    if (!player || !player.unpause()) {
      return interaction.reply("❌ ไม่มีเพลงให้เล่นต่อ");
    }

    return interaction.reply("▶️ เล่นเพลงต่อแล้ว");
  }
});

client.login(process.env.DISCORD_TOKEN);
