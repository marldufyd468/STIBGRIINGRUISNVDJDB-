const { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder 
} = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus 
} = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// خادم الويب المدمج لـ Render
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('Bot is Alive & Running 24/7!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// التوكن والمعرف
const TOKEN = process.env.DISCORD_TOKEN || 'MTU1NTcxNDIzODI0NzQ3NzMzOQ.GwnlDQ.koWRiY0HCZAfcVxhbYiFPXQSkamoZ6nK9lp4aY';
const CLIENT_ID = process.env.CLIENT_ID || '1555714238247477339';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      player: createAudioPlayer(),
      connection: null,
      isPlaying: false,
      isPaused: false,
      loopMode: 'off',
      volume: 1.0,
      currentResource: null
    });
  }
  return queues.get(guildId);
}

function createControlButtons(queue) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_back')
      .setLabel('⏪ 10s')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_pause_resume')
      .setLabel(queue.isPaused ? '▶ تشغيل' : '⏸️ إيقاف مؤقت')
      .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_forward')
      .setLabel('10s ⏩')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_skip')
      .setLabel('⏭️ تخطي')
      .setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_replay')
      .setLabel('🔄 إعادة المقطع')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_loop_toggle')
      .setLabel(queue.loopMode === 'single' ? '🔂 تكرار مستمر (مفعل)' : '🔁 تكرار مستمر (معطل)')
      .setStyle(queue.loopMode === 'single' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_vol_down')
      .setLabel('🔉 خفض الصوت')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_vol_up')
      .setLabel('🔊 رفع الصوت (+350%)')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function playSong(guildId, channel, seekTime = 0) {
  const queue = queues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    if (queue && queue.connection) {
      queue.connection.destroy();
      queues.delete(guildId);
    }
    return;
  }

  const currentSong = queue.songs[0];

  try {
    const stream = await play.stream(currentSong.url, { seek: seekTime });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });

    resource.volume.setVolume(queue.volume);
    queue.currentResource = resource;

    queue.player.play(resource);
    queue.connection.subscribe(queue.player);
    queue.isPlaying = true;
    queue.isPaused = false;

    if (seekTime === 0) {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎶 يتم التشغيل الآن')
        .setDescription(`[${currentSong.title}](${currentSong.url})`)
        .addFields(
          { name: 'المدة', value: currentSong.durationRaw || 'غير محدد', inline: true },
          { name: 'مستوى الصوت', value: `${Math.round(queue.volume * 100)}%`, inline: true },
          { name: 'التكرار', value: queue.loopMode === 'single' ? 'مفعل' : 'معطل', inline: true }
        )
        .setThumbnail(currentSong.thumbnail);

      await channel.send({ embeds: [embed], components: createControlButtons(queue) });
    }
  } catch (err) {
    console.error('Error playing track:', err);
    channel.send('حدث خطأ أثناء تشغيل المقطع.');
    queue.songs.shift();
    playSong(guildId, channel);
  }
}

function attachPlayerEvents(queue, guildId, channel) {
  queue.player.on(AudioPlayerStatus.Idle, () => {
    if (queue.loopMode === 'single') {
      playSong(guildId, channel, 0);
    } else {
      queue.songs.shift();
      if (queue.songs.length > 0) {
        playSong(guildId, channel, 0);
      } else {
        channel.send('انتهت قائمة التشغيل.');
        if (queue.connection) queue.connection.destroy();
        queues.delete(guildId);
      }
    }
  });

  queue.player.on('error', error => {
    console.error(`Audio Error: ${error.message}`);
    queue.songs.shift();
    playSong(guildId, channel);
  });
}

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'play' || command === 'p') {
    const query = args.join(' ');
    if (!query) return message.reply('اكتب اسم أو رابط المقطع.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('ادخل روم صوتي أولاً!');

    const queue = getQueue(message.guild.id);

    try {
      let videoInfo;
      if (play.yt_validate(query) === 'video') {
        const info = await play.video_basic_info(query);
        videoInfo = {
          title: info.video_details.title,
          url: info.video_details.url,
          durationRaw: info.video_details.durationRaw,
          thumbnail: info.video_details.thumbnails[0]?.url
        };
      } else {
        const searchResults = await play.search(query, { limit: 1 });
        if (!searchResults || searchResults.length === 0) {
          return message.reply('لم يتم العثور على أي مقطع.');
        }
        videoInfo = {
          title: searchResults[0].title,
          url: searchResults[0].url,
          durationRaw: searchResults[0].durationRaw,
          thumbnail: searchResults[0].thumbnails[0]?.url
        };
      }

      queue.songs.push(videoInfo);

      if (!queue.connection) {
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator
        });
        attachPlayerEvents(queue, message.guild.id, message.channel);
      }

      if (!queue.isPlaying) {
        playSong(message.guild.id, message.channel);
      } else {
        message.reply(`تمت إضافة: **${videoInfo.title}** إلى الطابور.`);
      }
    } catch (e) {
      console.error(e);
      message.reply('حدث خطأ في جلب المقطع.');
    }
  }

  if (command === 'volume' || command === 'vol') {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.currentResource) return message.reply('لا يوجد شيء شغال.');

    const target = parseInt(args[0], 10);
    if (isNaN(target) || target < 0 || target > 350) {
      return message.reply('حدد رقماً بين 0 و 350.');
    }

    queue.volume = target / 100;
    queue.currentResource.volume.setVolume(queue.volume);
    message.reply(`تم ضبط الصوت على: **${target}%**`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const queue = queues.get(interaction.guildId);
  if (!queue || !queue.currentResource) {
    return interaction.reply({ content: 'لا يوجد مقطع يعمل حالياً.', ephemeral: true });
  }

  const currentSeconds = Math.floor(queue.player.state.playbackDuration / 1000);

  switch (interaction.customId) {
    case 'btn_pause_resume':
      if (queue.isPaused) {
        queue.player.unpause();
        queue.isPaused = false;
      } else {
        queue.player.pause();
        queue.isPaused = true;
      }
      await interaction.update({ components: createControlButtons(queue) });
      break;

    case 'btn_skip':
      queue.player.stop();
      await interaction.reply({ content: 'تم تخطي المقطع.', ephemeral: true });
      break;

    case 'btn_forward':
      await interaction.deferUpdate();
      playSong(interaction.guildId, interaction.channel, currentSeconds + 10);
      break;

    case 'btn_back':
      await interaction.deferUpdate();
      playSong(interaction.guildId, interaction.channel, Math.max(0, currentSeconds - 10));
      break;

    case 'btn_replay':
      await interaction.deferUpdate();
      playSong(interaction.guildId, interaction.channel, 0);
      break;

    case 'btn_loop_toggle':
      queue.loopMode = queue.loopMode === 'single' ? 'off' : 'single';
      await interaction.update({ components: createControlButtons(queue) });
      break;

    case 'btn_vol_up':
      if (queue.volume < 3.5) {
        queue.volume = Math.min(3.5, queue.volume + 0.25);
        queue.currentResource.volume.setVolume(queue.volume);
        await interaction.reply({ content: `مستوى الصوت: ${Math.round(queue.volume * 100)}%`, ephemeral: true });
      } else {
        await interaction.reply({ content: 'الصوت في الحد الأقصى (350%)!', ephemeral: true });
      }
      break;

    case 'btn_vol_down':
      if (queue.volume > 0.1) {
        queue.volume = Math.max(0.0, queue.volume - 0.25);
        queue.currentResource.volume.setVolume(queue.volume);
        await interaction.reply({ content: `مستوى الصوت: ${Math.round(queue.volume * 100)}%`, ephemeral: true });
      } else {
        await interaction.reply({ content: 'الصوت في الحد الأدنى!', ephemeral: true });
      }
      break;
  }
});

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

client.login(TOKEN);

