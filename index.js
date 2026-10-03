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
  entersState,
  getVoiceConnection
} = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// 1. Web Server for Render Hosting
// ==========================================
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.status(200).send('Bot web service is healthy and active.');
});

app.listen(PORT, () => {
  console.log(`[HTTP] Express server running on port ${PORT}`);
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

// Per-guild queue map
const queues = new Map();

/**
 * Creates and initializes a Guild Queue structure.
 */
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
    volume: 100, // 0 - 350
    loopMode: 'off', // 'off' | 'single'
    isPlaying: false,
    isPaused: false,
    currentSeconds: 0,
    seekOffset: 0,
    timeInterval: null,
    isHandlingManualTransition: false
  };

  attachPlayerEvents(queue);
  queues.set(guildId, queue);
  return queue;
}

/**
 * Attaches audio player event listeners once per player.
 */
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

      // If transition was triggered by Skip/Seek/Replay, do not process natural finish
      if (queue.isHandlingManualTransition) {
        queue.isHandlingManualTransition = false;
        return;
      }

      handleSongFinished(queue);
    }
  });

  queue.player.on('error', (error) => {
    console.error(`[PLAYER ERROR] Error on current resource:`, error.message);
    queue.textChannel.send(`⚠️ خطأ في تشغيل الصوت: ${error.message}`).catch(() => {});
    
    // Auto recover to next song
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

/**
 * Handles transition when a track completes naturally.
 */
async function handleSongFinished(queue) {
  if (queue.loopMode === 'single' && queue.currentSong) {
    console.log(`[QUEUE] Replaying current song due to loop mode.`);
    await playSong(queue, queue.currentSong, 0);
    return;
  }

  // Remove finished song
  queue.songs.shift();

  if (queue.songs.length > 0) {
    console.log(`[QUEUE] Playing next track in queue.`);
    await playSong(queue, queue.songs[0], 0);
  } else {
    console.log(`[QUEUE] Queue ended. Cleaning up connection.`);
    queue.textChannel.send('✅ انتهت قائمة التشغيل. تم مغادرة الروم الصوتي.').catch(() => {});
    destroyQueue(queue.guildId);
  }
}

/**
 * Safely disconnects and removes guild queue.
 */
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
      console.error(`[VOICE] Error destroying connection:`, e.message);
    }
  }

  queues.delete(guildId);
  console.log(`[QUEUE] Cleaned up state for guild ${guildId}`);
}

/**
 * Ensures VoiceConnection is Ready and healthy.
 */
async function ensureVoiceConnection(queue) {
  const channel = queue.voiceChannel;

  if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
    console.log(`[VOICE] Joining channel: ${channel.name} (${channel.id})...`);
    console.log(`[VOICE] Connecting...`);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE STATE] ${oldState.status} -> ${newState.status}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        console.warn(`[VOICE] Connection disconnected, attempting to reconnect...`);
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (error) {
        console.error(`[VOICE] Reconnect failed, destroying connection.`);
        destroyQueue(queue.guildId);
      }
    });

    queue.connection = connection;
  }

  try {
    if (queue.connection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000);
      console.log(`[VOICE] Ready`);
      queue.connection.subscribe(queue.player);
    }
    return true;
  } catch (error) {
    console.error(`[VOICE] Failed to achieve Ready state within 15 seconds:`, error.message);
    queue.textChannel.send('❌ تعذر تثبيت الاتصال الصوتي مع ديسكورد. تأكد من صلاحيات البوت.').catch(() => {});
    destroyQueue(queue.guildId);
    return false;
  }
}

/**
 * Extracts stream and plays a song at given seek time.
 */
async function playSong(queue, song, seekSeconds = 0) {
  try {
    const isReady = await ensureVoiceConnection(queue);
    if (!isReady) return;

    console.log(`[PLAY] Getting audio stream for: ${song.title}`);
    console.log(`[PLAY] URL: ${song.url} (Seek: ${seekSeconds}s)`);

    // Flag to ignore Idle triggered by stopping existing stream
    queue.isHandlingManualTransition = true;
    queue.player.stop(true);

    const streamOptions = {
      quality: 2
    };
    if (seekSeconds > 0) {
      streamOptions.seek = seekSeconds;
    }

    const streamResult = await play.stream(song.url, streamOptions);
    console.log(`[PLAY] Stream type: ${streamResult.type}`);

    console.log(`[PLAY] Creating resource...`);
    const resource = createAudioResource(streamResult.stream, {
      inputType: streamResult.type,
      inlineVolume: true
    });

    // Apply current volume
    if (resource.volume) {
      resource.volume.setVolume(queue.volume / 100);
    }

    queue.currentResource = resource;
    queue.currentSong = song;
    queue.currentSeconds = seekSeconds;
    queue.seekOffset = seekSeconds;

    queue.player.play(resource);
    console.log(`[PLAY] Playing successfully`);

    if (seekSeconds === 0) {
      sendControlPanel(queue, song);
    }
  } catch (error) {
    console.error(`[PLAY] Failed`);
    console.error(`[PLAY] Error:`, error);
    queue.isHandlingManualTransition = false;
    queue.textChannel.send(`❌ فشل استخراج أو تشغيل المقطع: ${song.title}\nالسبب: ${error.message}`).catch(() => {});
    
    // Skip to next track on stream extraction failure
    handleSongFinished(queue);
  }
}

/**
 * Builds interactive media control row.
 */
function createControlComponents(queue) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_back')
      .setEmoji('⏪')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_toggle')
      .setEmoji(queue.isPaused ? '▶️' : '⏸️')
      .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music_forward')
      .setEmoji('⏩')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_replay')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_voldown')
      .setLabel('الصوت -10')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_volup')
      .setLabel('الصوت +10')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setLabel(queue.loopMode === 'single' ? 'التكرار: مفعل' : 'التكرار: معطل')
      .setStyle(queue.loopMode === 'single' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('إيقاف')
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

/**
 * Sends track info embed with controls.
 */
async function sendControlPanel(queue, song) {
  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('🎵 قيد التشغيل الآن')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: 'المدة', value: song.durationRaw || 'غير محدد', inline: true },
      { name: 'الصوت', value: `${queue.volume}%`, inline: true },
      { name: 'التكرار', value: queue.loopMode === 'single' ? 'مفعل' : 'معطل', inline: true }
    )
    .setThumbnail(song.thumbnail || null)
    .setFooter({ text: `طلب بواسطة: ${song.requester}` });

  await queue.textChannel.send({
    embeds: [embed],
    components: createControlComponents(queue)
  }).catch(() => {});
}

// ==========================================
// 4. Message Command Handler (!play, !vol, etc)
// ==========================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === '!play' || command === '!p') {
    const query = args.join(' ');
    if (!query) {
      return message.reply('يرجى كتابة اسم الأغنية أو الرابط بعد الأمر.');
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('يجب أن تكون داخل روم صوتي لتشغيل البوت.');
    }

    // Permission checks
    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect)) {
      return message.reply('❌ البوت يفتقر إلى صلاحية الانضمام للروم الصوتي (`Connect`).');
    }
    if (!permissions.has(PermissionsBitField.Flags.Speak)) {
      return message.reply('❌ البوت يفتقر إلى صلاحية التحدث في الروم الصوتي (`Speak`).');
    }

    let songInfo = null;

    try {
      console.log(`[PLAY] Searching for: "${query}"`);
      const validate = await play.validate(query);

      if (validate === 'yt_video') {
        const info = await play.video_info(query);
        const details = info.video_details;
        songInfo = {
          title: details.title || 'Unknown Title',
          url: details.url,
          durationRaw: details.durationRaw || '00:00',
          durationInSec: details.durationInSec || 0,
          thumbnail: details.thumbnails?.[0]?.url || null,
          requester: message.author.tag
        };
      } else {
        const searchResults = await play.search(query, { limit: 1 });
        if (!searchResults || searchResults.length === 0) {
          return message.reply('❌ لم يتم العثور على أي نتائج مطابقة في YouTube.');
        }
        const first = searchResults[0];
        songInfo = {
          title: first.title || 'Unknown Title',
          url: first.url,
          durationRaw: first.durationRaw || '00:00',
          durationInSec: first.durationInSec || 0,
          thumbnail: first.thumbnails?.[0]?.url || null,
          requester: message.author.tag
        };
      }

      console.log(`[PLAY] Found: ${songInfo.title}`);
    } catch (searchError) {
      console.error(`[SEARCH ERROR]`, searchError);
      return message.reply(`❌ تعذر البحث في YouTube: ${searchError.message}`);
    }

    let queue = queues.get(message.guild.id);
    const isNewQueue = !queue;

    if (!queue) {
      queue = createGuildQueue(message.guild.id, voiceChannel, message.channel);
    } else {
      queue.voiceChannel = voiceChannel;
      queue.textChannel = message.channel;
    }

    queue.songs.push(songInfo);

    if (isNewQueue || (!queue.isPlaying && !queue.isPaused)) {
      await playSong(queue, queue.songs[0], 0);
    } else {
      message.reply(`📥 تمت إضافة **${songInfo.title}** إلى قائمة الانتظار.`);
    }
  }

  // Volume command: !vol <0-350>
  if (command === '!vol' || command === '!volume') {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply('لا يوجد شيء قيد التشغيل حالياً.');

    const newVol = parseInt(args[0], 10);
    if (isNaN(newVol) || newVol < 0 || newVol > 350) {
      return message.reply('يرجى تحديد رقم صحيح للصوت بين 0 و 350.');
    }

    queue.volume = newVol;
    if (queue.currentResource && queue.currentResource.volume) {
      queue.currentResource.volume.setVolume(newVol / 100);
    }
    return message.reply(`🔊 تم ضبط الصوت إلى: ${newVol}%`);
  }
});

// ==========================================
// 5. Button Interactions (Controls)
// ==========================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: 'لا توجد قائمة تشغيل نشطة حالياً.', ephemeral: true });
  }

  if (interaction.member.voice.channelId !== queue.voiceChannel.id) {
    return interaction.reply({ content: 'يجب أن تكون في نفس الروم الصوتي لاستخدام الأزرار.', ephemeral: true });
  }

  await interaction.deferUpdate().catch(() => {});

  switch (interaction.customId) {
    case 'music_toggle': {
      if (queue.isPaused) {
        queue.player.unpause();
        queue.isPaused = false;
        console.log(`[CONTROL] Unpaused track`);
      } else {
        queue.player.pause();
        queue.isPaused = true;
        console.log(`[CONTROL] Paused track`);
      }
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_forward': {
      if (!queue.currentSong) return;
      const targetTime = queue.currentSeconds + 10;
      if (queue.currentSong.durationInSec && targetTime >= queue.currentSong.durationInSec) {
        return interaction.followUp({ content: 'لا يمكن التقديم لما بعد نهاية الأغنية.', ephemeral: true });
      }
      console.log(`[CONTROL] Forwarding 10s to ${targetTime}s`);
      await playSong(queue, queue.currentSong, targetTime);
      break;
    }

    case 'music_back': {
      if (!queue.currentSong) return;
      const targetTime = Math.max(0, queue.currentSeconds - 10);
      console.log(`[CONTROL] Rewinding 10s to ${targetTime}s`);
      await playSong(queue, queue.currentSong, targetTime);
      break;
    }

    case 'music_replay': {
      if (!queue.currentSong) return;
      console.log(`[CONTROL] Replaying track from start`);
      await playSong(queue, queue.currentSong, 0);
      break;
    }

    case 'music_skip': {
      console.log(`[CONTROL] Skipping track`);
      queue.isHandlingManualTransition = true;
      queue.player.stop(true);
      queue.songs.shift();

      if (queue.songs.length > 0) {
        await playSong(queue, queue.songs[0], 0);
      } else {
        queue.textChannel.send('✅ تم تخطي الأغنية وانتهت قائمة التشغيل.').catch(() => {});
        destroyQueue(queue.guildId);
      }
      break;
    }

    case 'music_voldown': {
      queue.volume = Math.max(0, queue.volume - 10);
      if (queue.currentResource && queue.currentResource.volume) {
        queue.currentResource.volume.setVolume(queue.volume / 100);
      }
      console.log(`[CONTROL] Volume decreased to ${queue.volume}%`);
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_volup': {
      queue.volume = Math.min(350, queue.volume + 10);
      if (queue.currentResource && queue.currentResource.volume) {
        queue.currentResource.volume.setVolume(queue.volume / 100);
      }
      console.log(`[CONTROL] Volume increased to ${queue.volume}%`);
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_loop': {
      queue.loopMode = queue.loopMode === 'single' ? 'off' : 'single';
      console.log(`[CONTROL] Loop mode set to: ${queue.loopMode}`);
      await interaction.editReply({ components: createControlComponents(queue) }).catch(() => {});
      break;
    }

    case 'music_stop': {
      console.log(`[CONTROL] Stop requested`);
      destroyQueue(queue.guildId);
      await interaction.editReply({ content: '🛑 تم إيقاف التشغيل ومغادرة الروم الصوتي.', components: [] }).catch(() => {});
      break;
    }
  }
});

// ==========================================
// 6. Bot Lifecycle Events & Login
// ==========================================
client.once('ready', () => {
  console.log(`[DISCORD] Logged in successfully as ${client.user.tag}`);
});

client.login(TOKEN).catch((err) => {
  console.error('[FATAL] Client login error:', err.message);
  process.exit(1);
});
