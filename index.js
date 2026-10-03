const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// 1. Web Server for Render
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.status(200).send('Bot is running healthy.');
});

app.listen(PORT, () => {
  console.log(`[HTTP] Express running on port ${PORT}`);
});

// ==========================================
// 2. Token Validation
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN is missing in environment variables.');
  process.exit(1);
}

// ==========================================
// 3. Client Initialization
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();

function createGuildQueue(guildId, voiceChannel, textChannel) {
  const player = createAudioPlayer();

  const queue = {
    guildId,
    voiceChannel,
    textChannel,
    connection: null,
    player,
    songs: [],
    currentSong: null,
    currentResource: null,
    volume: 100,
    loopMode: 'off',
    isPlaying: false,
    isPaused: false,
    currentSeconds: 0,
    timeInterval: null,
    isHandlingManualTransition: false
  };

  attachPlayerEvents(queue);
  queues.set(guildId, queue);
  return queue;
}

function attachPlayerEvents(queue) {
  queue.player.on('stateChange', (oldState, newState) => {
    console.log(`[PLAYER] ${oldState.status} -> ${newState.status}`);

    if (newState.status === AudioPlayerStatus.Playing) {
      queue.isPlaying = true;
      queue.isPaused = false;
      startProgressTimer(queue);
    } else if (newState.status === AudioPlayerStatus.Paused) {
      queue.isPaused = true;
      stopProgressTimer(queue);
    } else if (newState.status === AudioPlayerStatus.Idle) {
      queue.isPlaying = false;
      stopProgressTimer(queue);

      if (queue.isHandlingManualTransition) {
        queue.isHandlingManualTransition = false;
        return;
      }

      handleSongFinished(queue);
    }
  });

  queue.player.on('error', (error) => {
    console.error(`[PLAYER ERROR]`, error.message);
    queue.textChannel.send(`⚠️ خطأ في تشغيل الصوت: ${error.message}`).catch(() => {});
    queue.isHandlingManualTransition = false;
    handleSongFinished(queue);
  });
}

function startProgressTimer(queue) {
  stopProgressTimer(queue);
  queue.timeInterval = setInterval(() => {
    if (queue.isPlaying && !queue.isPaused) {
      queue.currentSeconds += 1;
    }
  }, 1000);
}

function stopProgressTimer(queue) {
  if (queue.timeInterval) {
    clearInterval(queue.timeInterval);
    queue.timeInterval = null;
  }
}

async function handleSongFinished(queue) {
  if (queue.loopMode === 'single' && queue.currentSong) {
    await playSong(queue, queue.currentSong, 0);
    return;
  }

  queue.songs.shift();

  if (queue.songs.length > 0) {
    await playSong(queue, queue.songs[0], 0);
  } else {
    queue.textChannel.send('✅ انتهت قائمة التشغيل.').catch(() => {});
    destroyQueue(queue.guildId);
  }
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  stopProgressTimer(queue);

  if (queue.player) {
    queue.player.stop(true);
  }

  if (queue.connection) {
    try {
      queue.connection.destroy();
    } catch (e) {
      console.error(`[VOICE] Error destroying:`, e.message);
    }
  }

  queues.delete(guildId);
}

async function ensureVoiceConnection(queue) {
  const channel = queue.voiceChannel;

  if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
    console.log(`[VOICE] Joining channel: ${channel.name}...`);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (error) {
        destroyQueue(queue.guildId);
      }
    });

    queue.connection = connection;
  }

  try {
    if (queue.connection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000);
      queue.connection.subscribe(queue.player);
    }
    return true;
  } catch (error) {
    queue.textChannel.send('❌ تعذر تثبيت الاتصال الصوتي مع ديسكورد.').catch(() => {});
    destroyQueue(queue.guildId);
    return false;
  }
}

async function playSong(queue, song, seekSeconds = 0) {
  try {
    const isReady = await ensureVoiceConnection(queue);
    if (!isReady) return;

    console.log(`[PLAY] Getting stream for: ${song.title}`);
    queue.isHandlingManualTransition = true;
    queue.player.stop(true);

    const streamOptions = { quality: 2 };
    if (seekSeconds > 0) streamOptions.seek = seekSeconds;

    const streamResult = await play.stream(song.url, streamOptions);

    const resource = createAudioResource(streamResult.stream, {
      inputType: streamResult.type,
      inlineVolume: true
    });

    if (resource.volume) {
      resource.volume.setVolume(queue.volume / 100);
    }

    queue.currentResource = resource;
    queue.currentSong = song;
    queue.currentSeconds = seekSeconds;

    queue.player.play(resource);
    console.log(`[PLAY] Playing successfully`);

    if (seekSeconds === 0) {
      sendControlPanel(queue, song);
    }
  } catch (error) {
    console.error(`[PLAY] Failed:`, error.message);
    queue.isHandlingManualTransition = false;
    queue.textChannel.send(`❌ فشل تشغيل: ${song.title}`).catch(() => {});
    handleSongFinished(queue);
  }
}

function createControlComponents(queue) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_back').setEmoji('⏪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_toggle').setEmoji(queue.isPaused ? '▶️' : '⏸️').setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_forward').setEmoji('⏩').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_replay').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_voldown').setLabel('الصوت -10').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_volup').setLabel('الصوت +10').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_loop').setLabel(queue.loopMode === 'single' ? 'التكرار: مفعل' : 'التكرار: معطل').setStyle(queue.loopMode === 'single' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setLabel('إيقاف').setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

async function sendControlPanel(queue, song) {
  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('🎵 قيد التشغيل الآن')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: 'المدة', value: song.durationRaw || 'غير محدد', inline: true },
      { name: 'الصوت', value: `${queue.volume}%`, inline: true },
      { name: 'المصدر', value: song.source || 'SoundCloud', inline: true }
    )
    .setThumbnail(song.thumbnail || null)
    .setFooter({ text: `طلب بواسطة: ${song.requester}` });

  await queue.textChannel.send({
    embeds: [embed],
    components: createControlComponents(queue)
  }).catch(() => {});
}

// ==========================================
// 4. Message Commands
// ==========================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === '!play' || command === '!p') {
    const query = args.join(' ');
    if (!query) return message.reply('اكتب اسم المقطع أو الرابط بعد الأمر.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('ادخل روم صوتي أولاً.');

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
      return message.reply('❌ ينقص البوت صلاحية Connect أو Speak.');
    }

    let songInfo = null;

    try {
      console.log(`[SEARCH] Query: "${query}"`);
      const validate = await play.validate(query);

      if (validate === 'so_track') {
        const info = await play.soundcloud(query);
        songInfo = {
          title: info.name,
          url: info.url,
          durationRaw: info.durationInSec ? `${Math.floor(info.durationInSec / 60)}:${(info.durationInSec % 60).toString().padStart(2, '0')}` : '00:00',
          thumbnail: info.thumbnail,
          source: 'SoundCloud',
          requester: message.author.tag
        };
      } else if (validate === 'yt_video') {
        const info = await play.video_info(query);
        songInfo = {
          title: info.video_details.title,
          url: info.video_details.url,
          durationRaw: info.video_details.durationRaw,
          thumbnail: info.video_details.thumbnails?.[0]?.url || null,
          source: 'YouTube',
          requester: message.author.tag
        };
      } else {
        // البحث التلقائي عبر SoundCloud لتفادي حظر 429
        const results = await play.search(query, {
          source: { soundcloud: 'tracks' },
          limit: 1
        });

        if (!results || results.length === 0) {
          return message.reply('❌ لم يتم العثور على نتائج.');
        }

        const first = results[0];
        songInfo = {
          title: first.name,
          url: first.url,
          durationRaw: first.durationInSec ? `${Math.floor(first.durationInSec / 60)}:${(first.durationInSec % 60).toString().padStart(2, '0')}` : '00:00',
          thumbnail: first.thumbnail,
          source: 'SoundCloud',
          requester: message.author.tag
        };
      }
    } catch (err) {
      console.error(`[SEARCH ERROR]`, err.message);
      return message.reply(`❌ تعذر إيجاد المقطع: ${err.message}`);
    }

    let queue = queues.get(message.guild.id);
    const isNew = !queue;

    if (!queue) {
      queue = createGuildQueue(message.guild.id, voiceChannel, message.channel);
    } else {
      queue.voiceChannel = voiceChannel;
      queue.textChannel = message.channel;
    }

    queue.songs.push(songInfo);

    if (isNew || (!queue.isPlaying && !queue.isPaused)) {
      await playSong(queue, queue.songs[0], 0);
    } else {
      message.reply(`📥 تمت الإضافة: **${songInfo.title}**`);
    }
  }

  if (command === '!vol' || command === '!volume') {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply('لا يوجد شيء قيد التشغيل حالياً.');

    const newVol = parseInt(args[0], 10);
    if (isNaN(newVol) || newVol < 0 || newVol > 350) {
      return message.reply('اختر رقماً بين 0 و 350.');
    }

    queue.volume = newVol;
    if (queue.currentResource && queue.currentResource.volume) {
      queue.currentResource.volume.setVolume(newVol / 100);
    }
    return message.reply(`🔊 تم ضبط الصوت إلى: ${newVol}%`);
  }
});

// ==========================================
// 5. Button Handling
// ==========================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const queue = queues.get(interaction.guildId);
  if (!queue) return interaction.reply({ content: 'لا توجد قائمة نشطة.', ephemeral: true });

  if (interaction.member.voice.channelId !== queue.voiceChannel.id) {
    return interaction.reply({ content: 'يجب أن تكون في نفس الروم.', ephemeral: true });
  }

  await interaction.deferUpdate().catch(() => {});

  switch (interaction.customId) {
    case 'music_toggle': {
      if (queue.isPaused) {
        queue.player.unpause();
        queue.isPaused = false;
      } else {
        queue.player.pause();
        queue.isPaused = true;
      }
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_forward': {
      if (!queue.currentSong) return;
      await playSong(queue, queue.currentSong, queue.currentSeconds + 10);
      break;
    }

    case 'music_back': {
      if (!queue.currentSong) return;
      await playSong(queue, queue.currentSong, Math.max(0, queue.currentSeconds - 10));
      break;
    }

    case 'music_replay': {
      if (!queue.currentSong) return;
      await playSong(queue, queue.currentSong, 0);
      break;
    }

    case 'music_skip': {
      queue.isHandlingManualTransition = true;
      queue.player.stop(true);
      queue.songs.shift();

      if (queue.songs.length > 0) {
        await playSong(queue, queue.songs[0], 0);
      } else {
        queue.textChannel.send('✅ انتهت القائمة.').catch(() => {});
        destroyQueue(queue.guildId);
      }
      break;
    }

    case 'music_voldown': {
      queue.volume = Math.max(0, queue.volume - 10);
      if (queue.currentResource && queue.currentResource.volume) {
        queue.currentResource.volume.setVolume(queue.volume / 100);
      }
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_volup': {
      queue.volume = Math.min(350, queue.volume + 10);
      if (queue.currentResource && queue.currentResource.volume) {
        queue.currentResource.volume.setVolume(queue.volume / 100);
      }
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_loop': {
      queue.loopMode = queue.loopMode === 'single' ? 'off' : 'single';
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_stop': {
      destroyQueue(queue.guildId);
      await interaction.editReply({ content: '🛑 تم إيقاف التشغيل.', components: [] }).catch(() => {});
      break;
    }
  }
});

client.once('ready', () => {
  console.log(`[DISCORD] Logged in as ${client.user.tag}`);
});

client.login(TOKEN).catch((err) => {
  console.error('[FATAL] Login error:', err.message);
  process.exit(1);
});
