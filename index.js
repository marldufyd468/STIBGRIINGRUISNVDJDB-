const {
Client,
GatewayIntentBits,
PermissionsBitField
} = require(“discord.js”);

const {
joinVoiceChannel,
createAudioPlayer,
createAudioResource,
AudioPlayerStatus,
VoiceConnectionStatus,
NoSubscriberBehavior,
entersState
} = require(”@discordjs/voice”);

const play = require(“play-dl”);

// ============================================================
// CONFIG
// ============================================================

// إذا عندك التوكن موجود بطريقة ثانية، حافظ على طريقتك الحالية.
// الأفضل وضعه في Environment Variable باسم DISCORD_TOKEN.
const TOKEN = process.env.DISCORD_TOKEN || “PUT_YOUR_BOT_TOKEN_HERE”;

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildVoiceStates,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
]
});

// ============================================================
// SERVER MUSIC STATES
// ============================================================

const guildStates = new Map();

function getState(guildId) {
if (!guildStates.has(guildId)) {
const player = createAudioPlayer({
behaviors: {
noSubscriber: NoSubscriberBehavior.Pause
}
});

const state = {
  player,
  connection: null,
  queue: [],
  current: null,
  volume: 1.0,
  repeat: false,
  autoplay: false,
  paused: false,
  loading: false,
  generation: 0
};
guildStates.set(guildId, state);
// --------------------------------------------------------
// TRACK ENDED
// --------------------------------------------------------
player.on(AudioPlayerStatus.Idle, async () => {
  if (state.loading) return;
  // إذا التراك الحالي انتهى
  if (state.current) {
    // تكرار نفس المقطع
    if (state.repeat) {
      const sameTrack = state.current;
      state.current = null;
      await playTrack(state, sameTrack);
      return;
    }
    state.current = null;
  }
  // تشغيل التالي من الطابور
  if (state.queue.length > 0) {
    const next = state.queue.shift();
    await playTrack(state, next);
    return;
  }
  // لا يوجد شيء في الطابور
  // إذا autoplay ON نحاول تشغيل اقتراح/مقطع مرتبط
  if (state.autoplay && state.current === null) {
    console.log(`[${guildId}] Autoplay is enabled but queue is empty.`);
  }
});
// --------------------------------------------------------
// ERROR
// --------------------------------------------------------
player.on("error", async (error) => {
  console.error(`[PLAYER ERROR] ${error.message}`);
  state.loading = false;
  state.paused = false;
  // لا نخلي خطأ مقطع واحد يوقف البوت بالكامل
  if (state.queue.length > 0) {
    const next = state.queue.shift();
    setTimeout(() => {
      playTrack(state, next).catch(console.error);
    }, 1000);
  }
});

}

return guildStates.get(guildId);
}

// ============================================================
// YOUTUBE URL CHECK
// ============================================================

function isYouTubeUrl(text) {
return (
/^https?://(www.)?(youtube.com|youtu.be)//i.test(text)
);
}

// ============================================================
// SEARCH YOUTUBE
// ============================================================

async function findYouTube(query) {
// إذا المستخدم حط رابط
if (isYouTubeUrl(query)) {
try {
const info = await play.video_basic_info(query);

  return {
    url: query,
    title: info.video_details.title,
    durationRaw: info.video_details.durationRaw || "Unknown",
    thumbnail:
      info.video_details.thumbnails?.[0]?.url || null
  };
} catch (error) {
  throw new Error("ما قدرت أقرأ رابط اليوتيوب.");
}

}

// بحث بالعنوان
const results = await play.search(query, {
limit: 1,
source: {
youtube: “video”
}
});

if (!results || results.length === 0) {
throw new Error(“ما لقيت أي مقطع بهذا الاسم.”);
}

const video = results[0];

return {
url: video.url,
title: video.title,
durationRaw: video.durationRaw || “Unknown”,
thumbnail: video.thumbnails?.[0]?.url || null
};
}

// ============================================================
// CREATE AUDIO RESOURCE
// ============================================================

async function createTrackResource(track, volume) {
// نحاول أخذ stream من YouTube
const stream = await play.stream(track.url, {
quality: 2,
discordPlayerCompatibility: false
});

const resource = createAudioResource(stream.stream, {
inputType: stream.type,
inlineVolume: true
});

// 1.0 = 100%
// 3.5 = 350%
resource.volume.setVolume(volume);

return resource;
}

// ============================================================
// PLAY TRACK
// ============================================================

async function playTrack(state, track) {
if (!state.connection) {
throw new Error(“البوت غير متصل بالروم الصوتي.”);
}

state.loading = true;
state.paused = false;

try {
console.log([PLAY] ${track.title});

const resource = await createTrackResource(
  track,
  state.volume
);
state.current = track;
state.player.play(resource);
state.loading = false;
return true;

} catch (error) {
state.loading = false;

console.error(
  `[TRACK ERROR] ${track.title}:`,
  error.message
);
throw error;

}
}

// ============================================================
// CONNECT TO VOICE
// ============================================================

async function connectToVoice(message, state) {
const member = message.member;

if (!member || !member.voice.channel) {
throw new Error(“ادخل روم صوتي أول.”);
}

const channel = member.voice.channel;

const permissions = channel.permissionsFor(message.client.user);

if (
permissions &&
!permissions.has(PermissionsBitField.Flags.Connect)
) {
throw new Error(“ما عندي صلاحية Connect في الروم.”);
}

if (
permissions &&
!permissions.has(PermissionsBitField.Flags.Speak)
) {
throw new Error(“ما عندي صلاحية Speak في الروم.”);
}

// إذا البوت أصلاً في نفس الروم
if (
state.connection &&
state.connection.joinConfig.channelId === channel.id
) {
return state.connection;
}

// إذا كان في روم ثاني، ننقله
if (state.connection) {
try {
state.connection.destroy();
} catch {}
}

state.connection = joinVoiceChannel({
channelId: channel.id,
guildId: message.guild.id,
adapterCreator: message.guild.voiceAdapterCreator,
selfDeaf: true
});

state.connection.subscribe(state.player);

try {
await entersState(
state.connection,
VoiceConnectionStatus.Ready,
30000
);
} catch (error) {
try {
state.connection.destroy();
} catch {}

state.connection = null;
throw new Error(
  "البوت حاول يدخل الروم لكنه ما قدر يثبت اتصال الصوت خلال 30 ثانية."
);

}

return state.connection;
}

// ============================================================
// MESSAGE COMMAND HANDLER
// ============================================================

client.on(“messageCreate”, async (message) => {
if (message.author.bot) return;

if (!message.guild) return;

const content = message.content.trim();

if (!content) return;

const state = getState(message.guild.id);

// ========================================================
// HELP
// ========================================================

if (
content === “مساعدة” ||
content === “help”
) {
return message.reply(
[
“أوامر الموسيقى:”,
“”,
“شغل اسم المقطع — يبحث في YouTube ويشغله”,
“شغل رابط اليوتيوب — يشغل الرابط مباشرة”,
“تخطي — المقطع التالي”,
“ايقاف — إيقاف التشغيل ومسح الطابور”,
“مؤقت — إيقاف مؤقت”,
“كمل — استئناف”,
“اعادة — إعادة المقطع الحالي”,
“تكرار on — تكرار المقطع الحالي”,
“تكرار off — إيقاف التكرار”,
“تلقائي on — تشغيل الوضع التلقائي”,
“تلقائي off — إيقاف الوضع التلقائي”,
“صوت 1-350 — تغيير الصوت”,
“اطلع — خروج البوت من الروم”,
“مساعدة — عرض الأوامر”
].join(”\n”)
);
}

// ========================================================
// PLAY
// ========================================================

if (
content.startsWith(“شغل “) ||
content.startsWith(“شغّل “) ||
content.startsWith(“play “)
) {
const query = content
.replace(/^شغل\s+/i, “”)
.replace(/^شغّل\s+/i, “”)
.replace(/^play\s+/i, “”)
.trim();

if (!query) {
  return message.reply(
    "اكتب اسم المقطع أو رابط YouTube."
  );
}
try {
  await connectToVoice(message, state);
  await message.reply(
    "🔎 أدور على المقطع وأتصل بـ YouTube..."
  );
  const track = await findYouTube(query);
  // إذا ما فيه مقطع شغال
  if (
    !state.current &&
    state.player.state.status === AudioPlayerStatus.Idle
  ) {
    await playTrack(state, track);
    return message.reply(
      `▶️ **${track.title}**\nالمدة: ${track.durationRaw}`
    );
  }
  // إذا فيه مقطع شغال، نضيفه للطابور
  state.queue.push(track);
  return message.reply(
    `➕ تمت الإضافة للطابور: **${track.title}**\n` +
    `المركز: ${state.queue.length}`
  );
} catch (error) {
  console.error(error);
  return message.reply(
    `❌ ${error.message || "صار خطأ أثناء تشغيل المقطع."}`
  );
}

}

// ========================================================
// PAUSE
// ========================================================

if (
content === “مؤقت” ||
content === “pause”
) {
if (!state.current) {
return message.reply(“ما فيه مقطع شغال.”);
}

const success = state.player.pause();
if (success) {
  state.paused = true;
  return message.reply("⏸️ تم الإيقاف المؤقت.");
}
return message.reply("ما قدرت أوقف المقطع مؤقتًا.");

}

// ========================================================
// RESUME
// ========================================================

if (
content === “كمل” ||
content === “استئناف” ||
content === “resume”
) {
if (!state.current) {
return message.reply(“ما فيه مقطع متوقف.”);
}

const success = state.player.unpause();
if (success) {
  state.paused = false;
  return message.reply("▶️ كملنا التشغيل.");
}
return message.reply("ما قدرت أستأنف التشغيل.");

}

// ========================================================
// SKIP
// ========================================================

if (
content === “تخطي” ||
content === “التالي” ||
content === “skip”
) {
if (!state.current) {
return message.reply(“ما فيه مقطع شغال.”);
}

// إيقاف الحالي
state.player.stop();
// إذا التكرار شغال، نخليه يتجاوز التكرار
// ونشغل التالي فعليًا
if (state.repeat) {
  state.repeat = false;
  setTimeout(() => {
    state.repeat = true;
  }, 100);
}
return message.reply("⏭️ تم التخطي.");

}

// ========================================================
// STOP
// ========================================================

if (
content === “ايقاف” ||
content === “وقف” ||
content === “stop”
) {
state.queue = [];
state.current = null;
state.paused = false;
state.loading = false;

state.player.stop();
return message.reply(
  "⏹️ تم إيقاف التشغيل ومسح الطابور."
);

}

// ========================================================
// REPLAY CURRENT
// ========================================================

if (
content === “اعادة” ||
content === “إعادة” ||
content === “اعادة تشغيل” ||
content === “إعادة تشغيل” ||
content === “replay”
) {
if (!state.current) {
return message.reply(“ما فيه مقطع حالي لإعادته.”);
}

const track = state.current;
try {
  state.player.stop();
  await playTrack(state, track);
  return message.reply(
    `🔄 تمت إعادة: **${track.title}**`
  );
} catch (error) {
  return message.reply(
    `❌ فشلت إعادة المقطع: ${error.message}`
  );
}

}

// ========================================================
// REPEAT
// ========================================================

if (
content.startsWith(“تكرار “) ||
content.startsWith(“repeat “)
) {
const value = content
.replace(/^تكرار\s+/i, “”)
.replace(/^repeat\s+/i, “”)
.trim()
.toLowerCase();

if (
  value === "on" ||
  value === "تشغيل" ||
  value === "1"
) {
  state.repeat = true;
  return message.reply(
    "🔁 **التكرار اللانهائي للمقطع الحالي: ON**"
  );
}
if (
  value === "off" ||
  value === "ايقاف" ||
  value === "إيقاف" ||
  value === "0"
) {
  state.repeat = false;
  return message.reply(
    "🔁 **التكرار اللانهائي: OFF**"
  );
}
return message.reply(
  "استخدم: `تكرار on` أو `تكرار off`"
);

}

// ========================================================
// AUTOPLAY
// ========================================================

if (
content.startsWith(“تلقائي “) ||
content.startsWith(“autoplay “)
) {
const value = content
.replace(/^تلقائي\s+/i, “”)
.replace(/^autoplay\s+/i, “”)
.trim()
.toLowerCase();

if (
  value === "on" ||
  value === "تشغيل" ||
  value === "1"
) {
  state.autoplay = true;
  return message.reply(
    "▶️ **التشغيل التلقائي: ON**"
  );
}
if (
  value === "off" ||
  value === "ايقاف" ||
  value === "إيقاف" ||
  value === "0"
) {
  state.autoplay = false;
  return message.reply(
    "⏹️ **التشغيل التلقائي: OFF**"
  );
}
return message.reply(
  "استخدم: `تلقائي on` أو `تلقائي off`"
);

}

// ========================================================
// VOLUME
// ========================================================

if (
content.startsWith(“صوت “) ||
content.startsWith(“volume “)
) {
const value = content
.replace(/^صوت\s+/i, “”)
.replace(/^volume\s+/i, “”)
.trim();

const volume = Number(value);
if (!Number.isFinite(volume)) {
  return message.reply(
    "اكتب رقم الصوت من `1` إلى `350`."
  );
}
if (volume < 1 || volume > 350) {
  return message.reply(
    "الصوت لازم يكون بين `1` و `350`."
  );
}
state.volume = volume / 100;
// إذا فيه resource حالي، نحاول تغيير الصوت مباشرة
const resource = state.player.state.resource;
if (
  resource &&
  resource.volume
) {
  resource.volume.setVolume(state.volume);
}
return message.reply(
  `🔊 تم ضبط الصوت على **${volume}%**.`
);

}

// ========================================================
// LEAVE
// ========================================================

if (
content === “اطلع” ||
content === “اخرج” ||
content === “leave” ||
content === “disconnect”
) {
state.queue = [];
state.current = null;
state.paused = false;

state.player.stop();
if (state.connection) {
  try {
    state.connection.destroy();
  } catch {}
  state.connection = null;
}
return message.reply(
  "👋 طلعت من الروم."
);

}

// ========================================================
// QUEUE
// ========================================================

if (
content === “قائمة” ||
content === “طابور” ||
content === “queue”
) {
if (
!state.current &&
state.queue.length === 0
) {
return message.reply(
“📭 الطابور فاضي.”
);
}

let text = "🎵 **قائمة التشغيل**\n\n";
if (state.current) {
  text += `▶️ الآن: **${state.current.title}**\n\n`;
}
if (state.queue.length > 0) {
  state.queue.slice(0, 20).forEach((track, index) => {
    text += `${index + 1}. ${track.title}\n`;
  });
  if (state.queue.length > 20) {
    text += `\n... و ${state.queue.length - 20} مقاطع أخرى`;
  }
}
return message.reply(text);

}
});

// ============================================================
// READY
// ============================================================

client.once(“ready”, () => {
console.log(”=================================”);
console.log(Logged in as ${client.user.tag});
console.log(“YouTube Music Bot is ONLINE”);
console.log(”=================================”);
});

// ============================================================
// LOGIN
// ============================================================

if (
!TOKEN ||
TOKEN === “PUT_YOUR_BOT_TOKEN_HERE”
) {
console.error(
“ERROR: ضع DISCORD_TOKEN في Environment Variables.”
);
process.exit(1);
}

client.login(TOKEN);
