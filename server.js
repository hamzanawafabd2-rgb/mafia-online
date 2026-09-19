const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const os = require("os");

const app = express();
const server = http.createServer(app);

// زيادة حجم الرسائل الصوتية
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  pingTimeout: 60000
});

app.set("trust proxy", 1);
app.get("/health", function(req, res) { res.json({ ok: true, service: "mafia" }); });
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// إدارة الغرف
// ============================================
const rooms = {};

const ROLE_INFO = {
  godfather: { name: "زعيم المافيا", team: "mafia", emoji: "👑", desc: "زعيم المافيا. تظهر كمواطن عند التحقيق." },
  mafia:     { name: "مافيا", team: "mafia", emoji: "🔪", desc: "أنت مافيا. تقتل مع فريقك كل ليلة." },
  sniper:    { name: "القناص", team: "city", emoji: "🎯", desc: "تقتل لاعباً مرة واحدة. لو أخطأت تموت معه." },
  doctor:    { name: "الطبيب", team: "city", emoji: "💉", desc: "تحمي لاعباً كل ليلة." },
  sheriff:   { name: "الشريف", team: "city", emoji: "🔍", desc: "تحقق في لاعب كل ليلة." },
  citizen:   { name: "مواطن", team: "city", emoji: "👤", desc: "ناقش وصوّت خلال النهار." }
};

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function createRoom(hostId, hostName, maxPlayers, sessionId) {
  const id = generateRoomId();
  rooms[id] = {
    id: id,
    hostId: hostId,
    maxPlayers: Math.min(Math.max(Number(maxPlayers) || 60, 4), 60),
    players: [],
    state: "lobby",
    day: 0,
    nightActions: {},
    votes: {},
    messages: [],
    voiceMessages: [],
    timer: null,
    timeLeft: 0,
    winner: null,
    sniperUsed: false,
    voteRound: 1,
    revoteCandidates: [],
    hostMuteAll: false,
    hostMuteOverrides: {}
  };
  return rooms[id];
}

function getRoleDistribution(count) {
  count = Math.max(4, Math.min(Number(count) || 4, 60));
  var roles = [];

  if (count <= 5) roles = ["mafia", "doctor", "citizen", "citizen", "citizen"];
  else if (count <= 7) roles = ["godfather", "doctor", "sheriff", "citizen", "citizen", "citizen", "citizen"];
  else if (count <= 9) roles = ["godfather", "mafia", "doctor", "sheriff", "sniper", "citizen", "citizen", "citizen", "citizen"];
  else {
    // For larger rooms keep roughly one fifth mafia and add special city roles.
    var mafiaCount = Math.max(2, Math.round(count * 0.20));
    mafiaCount = Math.min(mafiaCount, Math.floor((count - 2) / 2));
    roles.push("godfather");
    for (var m = 1; m < mafiaCount; m++) roles.push("mafia");
    if (count >= 10) roles.push("doctor");
    if (count >= 12) roles.push("sheriff");
    if (count >= 15) roles.push("sniper");
    while (roles.length < count) roles.push("citizen");
  }

  while (roles.length > count) roles.pop();
  while (roles.length < count) roles.push("citizen");

  for (var i = roles.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = roles[i]; roles[i] = roles[j]; roles[j] = tmp;
  }
  return roles;
}

function addMessage(room, text, type, playerName) {
  room.messages.push({
    id: Date.now() + Math.random(),
    text: text,
    type: type || "system",
    playerName: playerName || null,
    time: Date.now()
  });
  if (room.messages.length > 200) room.messages.shift();
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function startTimer(room, seconds, onEnd) {
  clearRoomTimer(room);
  room.timeLeft = seconds;
  broadcastRoom(room);
  room.timer = setInterval(function() {
    room.timeLeft--;
    io.to(room.id).emit("timer", room.timeLeft);
    if (room.timeLeft <= 0) {
      clearRoomTimer(room);
      onEnd();
    }
  }, 1000);
}

function sanitizeRoom(room, forPlayerId) {
  var me = room.players.find(function(p) { return p.id === forPlayerId; });
  return {
    id: room.id,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    state: room.state,
    day: room.day,
    timeLeft: room.timeLeft,
    winner: room.winner,
    messages: room.messages.slice(-100),
    voiceMessages: room.voiceMessages.slice(-30),
    sniperUsed: room.sniperUsed,
    voteRound: room.voteRound || 1,
    revoteCandidates: room.revoteCandidates || [],
    players: room.players.map(function(p) {
      var isMafiaMate = null;
      if (me && me.role && ["mafia","godfather"].indexOf(me.role) >= 0 && ["mafia","godfather"].indexOf(p.role) >= 0) {
        isMafiaMate = true;
      }
      return {
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.id === room.hostId,
        role: (p.id === forPlayerId || room.state === "ended") ? p.role : null,
        votedFor: (room.state === "voting" || room.state === "revote") ? (room.votes[p.id] || null) : null,
        nightTarget: (room.state === "night" && p.id === forPlayerId && room.nightActions[p.id]) ? room.nightActions[p.id] : null,
        isMafiaMate: isMafiaMate,
        hostMuted: Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, p.id) ? !!room.hostMuteOverrides[p.id] : !!room.hostMuteAll,
        selfMuted: !!p.selfMuted,
        micMuted: (Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, p.id) ? !!room.hostMuteOverrides[p.id] : !!room.hostMuteAll) || !!p.selfMuted
      };
    })
  };
}

function broadcastRoom(room) {
  room.players.forEach(function(p) {
    io.to(p.id).emit("roomUpdate", sanitizeRoom(room, p.id));
  });
}

function startGame(room) {
  if (room.players.length < 4) return false;
  var roles = getRoleDistribution(room.players.length);
  room.players.forEach(function(p, i) {
    p.role = roles[i];
    p.alive = true;
  });
  room.state = "night";
  room.day = 0;
  room.winner = null;
  room.nightActions = {};
  room.votes = {};
  room.messages = [];
  room.voiceMessages = [];
  room.sniperUsed = false;
  room.voteRound = 1;
  room.revoteCandidates = [];
  addMessage(room, "🎭 بدأت اللعبة بـ " + room.players.length + " لاعبين", "system");
  room.players.forEach(function(p) {
    io.to(p.id).emit("yourRole", { role: p.role, info: ROLE_INFO[p.role] });
  });
  setTimeout(function() { startNight(room); }, 3000);
  return true;
}

function startNight(room) {
  var winner = checkWinner(room);
  if (winner) return endGame(room, winner);
  room.state = "night";
  room.day++;
  room.nightActions = {};
  addMessage(room, "🌙 الليلة " + room.day + " — الجميع ينام...", "night");

  var mafiaMembers = room.players.filter(function(p) {
    return p.alive && ["mafia","godfather"].indexOf(p.role) >= 0;
  });
  mafiaMembers.forEach(function(m) {
    io.to(m.id).emit("mafiaTeam", mafiaMembers.map(function(x) {
      return { id: x.id, name: x.name, role: x.role };
    }));
  });

  room.players.filter(function(p) { return p.alive; }).forEach(function(p) {
    if (p.role === "doctor") io.to(p.id).emit("nightPrompt", { action: "save" });
    if (p.role === "sheriff") io.to(p.id).emit("nightPrompt", { action: "investigate" });
    if (p.role === "sniper" && !room.sniperUsed) io.to(p.id).emit("nightPrompt", { action: "snipe" });
  });

  broadcastRoom(room);
  startTimer(room, 45, function() { resolveNight(room); });
}

function resolveNight(room) {
  var mafiaVotes = {};
  var savedTarget = null;
  var sniperTarget = null;

  Object.entries(room.nightActions).forEach(function(entry) {
    var playerId = entry[0];
    var action = entry[1];
    var player = room.players.find(function(p) { return p.id === playerId; });
    if (!player || !player.alive) return;
    if (["mafia","godfather"].indexOf(player.role) >= 0 && action.target) {
      mafiaVotes[action.target] = (mafiaVotes[action.target] || 0) + 1;
    }
    if (player.role === "doctor" && action.target) savedTarget = action.target;
    if (player.role === "sniper" && action.target && !room.sniperUsed) {
      sniperTarget = action.target;
      room.sniperUsed = true;
    }
  });

  var mafiaTarget = null;
  var maxVotes = 0;
  Object.entries(mafiaVotes).forEach(function(entry) {
    if (entry[1] > maxVotes) { maxVotes = entry[1]; mafiaTarget = entry[0]; }
  });

  Object.entries(room.nightActions).forEach(function(entry) {
    var playerId = entry[0];
    var action = entry[1];
    var player = room.players.find(function(p) { return p.id === playerId; });
    if (player && player.role === "sheriff" && action.target) {
      var target = room.players.find(function(p) { return p.id === action.target; });
      if (target) {
        var isMafia = ["mafia","godfather"].indexOf(target.role) >= 0;
        var isGodfather = target.role === "godfather";
        io.to(playerId).emit("investigationResult", {
          targetName: target.name,
          result: isGodfather ? "city" : (isMafia ? "mafia" : "city")
        });
      }
    }
  });

  var deaths = [];

  if (mafiaTarget && mafiaTarget !== savedTarget) {
    var victim = room.players.find(function(p) { return p.id === mafiaTarget; });
    if (victim && victim.alive) {
      victim.alive = false;
      deaths.push({ name: victim.name, by: "mafia" });
    }
  }

  if (sniperTarget) {
    var sniperVictim = room.players.find(function(p) { return p.id === sniperTarget; });
    var sniperPlayer = room.players.find(function(p) { return p.role === "sniper"; });
    if (sniperVictim && sniperVictim.alive) {
      sniperVictim.alive = false;
      deaths.push({ name: sniperVictim.name, by: "sniper" });
      if (["mafia","godfather"].indexOf(sniperVictim.role) < 0) {
        if (sniperPlayer) sniperPlayer.alive = false;
        addMessage(room, "💥 القناص أخطأ وأصاب مواطناً! مات معه.", "death");
      }
    }
  }

  if (deaths.length > 0) {
    deaths.forEach(function(d) {
      if (d.by === "mafia") addMessage(room, "💀 في الصباح، وجدوا " + d.name + " مقتولاً!", "death");
      else if (d.by === "sniper") addMessage(room, "🎯 القناص قتل " + d.name + "!", "death");
    });
  } else if (savedTarget) {
    addMessage(room, "🛡️ الطبيب أنقذ أحد اللاعبين هذه الليلة!", "system");
  } else {
    addMessage(room, "☀️ صباح هادئ... لم يمت أحد.", "system");
  }

  broadcastRoom(room);
  setTimeout(function() { startDay(room); }, 3000);
}

function startDay(room) {
  var winner = checkWinner(room);
  if (winner) return endGame(room, winner);
  room.state = "day";
  addMessage(room, "☀️ النهار " + room.day + " — ناقشوا واشتبهوا بالمافيا", "day");
  broadcastRoom(room);
  startTimer(room, 70, function() { startVoting(room); });
}

function getVoteTally(room, allowedIds) {
  var allowed = allowedIds ? new Set(allowedIds) : null;
  var tally = {};
  Object.values(room.votes).forEach(function(targetId) {
    if (!targetId) return; // abstain / withdrawn vote
    if (allowed && !allowed.has(targetId)) return;
    tally[targetId] = (tally[targetId] || 0) + 1;
  });
  return tally;
}

function getLeaders(tally) {
  var maxVotes = 0;
  var leaders = [];
  Object.entries(tally).forEach(function(entry) {
    if (entry[1] > maxVotes) { maxVotes = entry[1]; leaders = [entry[0]]; }
    else if (entry[1] === maxVotes) leaders.push(entry[0]);
  });
  return { maxVotes: maxVotes, leaders: leaders };
}

function startVoting(room) {
  var winner = checkWinner(room);
  if (winner) return endGame(room, winner);
  room.state = "voting";
  room.voteRound = 1;
  room.revoteCandidates = [];
  room.votes = {};
  addMessage(room, "🗳️ وقت التصويت! يمكنك تغيير اختيارك أو التراجع عنه قبل انتهاء الوقت.", "vote");
  broadcastRoom(room);
  startTimer(room, 35, function() { resolveVoting(room); });
}

function startRevote(room, candidates) {
  room.state = "revote";
  room.voteRound = 2;
  room.revoteCandidates = candidates.slice();
  room.votes = {};
  addMessage(room, "🔁 إعادة التصويت بين: " + candidates.map(function(id) {
    var p = room.players.find(function(x) { return x.id === id; });
    return p ? p.name : "";
  }).filter(Boolean).join(" و ") + ". يمكن تغيير الاختيار أو التراجع عنه.", "vote");
  broadcastRoom(room);
  startTimer(room, 25, function() { resolveRevote(room); });
}

function eliminateByVote(room, targetId) {
  var target = room.players.find(function(p) { return p.id === targetId; });
  if (!target || !target.alive) return false;
  target.alive = false;
  addMessage(room, "⚖️ تم إقصاء " + target.name + ". دوره كان: " + ROLE_INFO[target.role].name + " " + ROLE_INFO[target.role].emoji, "death");
  return true;
}

function resolveVoting(room) {
  var aliveIds = room.players.filter(function(p) { return p.alive; }).map(function(p) { return p.id; });
  var result = getLeaders(getVoteTally(room, aliveIds));

  if (result.leaders.length === 1 && result.maxVotes > 0) {
    eliminateByVote(room, result.leaders[0]);
    room.votes = {};
    room.revoteCandidates = [];
    broadcastRoom(room);
    setTimeout(function() { startNight(room); }, 3000);
    return;
  }

  if (result.leaders.length > 1 && result.maxVotes > 0) {
    return startRevote(room, result.leaders);
  }

  addMessage(room, "🤷 لم يحصل أي لاعب على أصوات كافية — لا أحد يُقصى.", "system");
  room.votes = {};
  room.revoteCandidates = [];
  broadcastRoom(room);
  setTimeout(function() { startNight(room); }, 3000);
}

function resolveRevote(room) {
  var result = getLeaders(getVoteTally(room, room.revoteCandidates));

  if (result.leaders.length === 1 && result.maxVotes > 0) {
    eliminateByVote(room, result.leaders[0]);
  } else if (result.leaders.length > 1 && result.maxVotes > 0) {
    addMessage(room, "🤝 تعادل مرة ثانية — لا أحد يُقصى اليوم.", "system");
  } else {
    addMessage(room, "🤷 لم يُحسم التصويت — لا أحد يُقصى اليوم.", "system");
  }

  room.votes = {};
  room.revoteCandidates = [];
  broadcastRoom(room);
  setTimeout(function() { startNight(room); }, 3000);
}

function checkWinner(room) {
  var alive = room.players.filter(function(p) { return p.alive; });
  var mafiaAlive = alive.filter(function(p) {
    return ["mafia","godfather"].indexOf(p.role) >= 0;
  }).length;
  var cityAlive = alive.length - mafiaAlive;
  if (mafiaAlive === 0) return "city";
  if (mafiaAlive >= cityAlive) return "mafia";
  return null;
}

function endGame(room, winner) {
  clearRoomTimer(room);
  room.state = "ended";
  room.winner = winner;
  var text = winner === "mafia" ? "🔪 فازت المافيا!" : "🏛️ فازت المدينة!";
  addMessage(room, "🏆 " + text, "end");
  broadcastRoom(room);
}

// ============================================
// Socket.IO
// ============================================
io.on("connection", function(socket) {
  console.log("🔌 اتصال:", socket.id);

  socket.on("createRoom", function(data, cb) {
    if (!data.name || data.name.trim().length < 2) return cb({ error: "الاسم قصير" });
    var room = createRoom(socket.id, data.name.trim(), data.maxPlayers || 60, data.sessionId);
    var player = { id: socket.id, sessionId: String(data.sessionId || ""), name: data.name.trim(), alive: true, role: null, connected: true, selfMuted: false, micMuted: false };
    room.players.push(player);
    socket.join(room.id);
    socket.roomId = room.id;
    cb({ success: true, roomId: room.id });
    addMessage(room, player.name + " أنشأ الغرفة", "join");
    broadcastRoom(room);
  });

  socket.on("joinRoom", function(data, cb) {
    var room = rooms[data.roomId ? data.roomId.toUpperCase() : ""];
    if (!room) return cb({ error: "الغرفة غير موجودة" });
    if (room.state !== "lobby") return cb({ error: "اللعبة بدأت" });
    if (room.players.length >= room.maxPlayers) return cb({ error: "الغرفة ممتلئة" });
    if (!data.name || data.name.trim().length < 2) return cb({ error: "الاسم قصير" });
    if (room.players.some(function(p) { return p.name === data.name.trim(); })) return cb({ error: "الاسم مستخدم" });
    var player = { id: socket.id, sessionId: String(data.sessionId || ""), name: data.name.trim(), alive: true, role: null, connected: true, selfMuted: false, micMuted: false };
    room.players.push(player);
    socket.join(room.id);
    socket.roomId = room.id;
    cb({ success: true, roomId: room.id });
    addMessage(room, player.name + " انضم للغرفة", "join");
    broadcastRoom(room);
  });

  // استعادة اللاعب بعد تحديث الصفحة/إعادة الاتصال.
  socket.on("resumeRoom", function(data, cb) {
    var roomId = data && data.roomId ? String(data.roomId).toUpperCase() : "";
    var sessionId = data && data.sessionId ? String(data.sessionId) : "";
    var room = rooms[roomId];
    if (!room || !sessionId) return cb && cb({ error: "تعذر استعادة الغرفة" });
    var player = room.players.find(function(p) { return p.sessionId === sessionId; });
    if (!player) return cb && cb({ error: "لاعب غير موجود" });
    // إذا كان هذا اللاعب هو المضيف، انقل هوية المضيف إلى Socket ID الجديد بعد الرفرش.
    // وانقل قفل المايك الفردي إلى الـ Socket ID الجديد حتى لا تضيع حالة الكتم.
    var oldPlayerId = player.id;
    var wasHost = room.hostId === oldPlayerId;
    if (room.hostMuteOverrides && Object.prototype.hasOwnProperty.call(room.hostMuteOverrides, oldPlayerId)) {
      room.hostMuteOverrides[socket.id] = room.hostMuteOverrides[oldPlayerId];
      delete room.hostMuteOverrides[oldPlayerId];
    }
    player.id = socket.id;
    player.connected = true;
    if (wasHost) room.hostId = socket.id;
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    socket.roomId = room.id;
    socket.join(room.id);
    cb && cb({ success: true, roomId: room.id, name: player.name });
    addMessage(room, player.name + " عاد إلى الغرفة", "join");
    broadcastRoom(room);
  });

  socket.on("leaveRoom", function(cb) {
    var room = rooms[socket.roomId];
    if (!room) return cb && cb({ success: true });
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player) return cb && cb({ success: true });
    room.players = room.players.filter(function(p) { return p.id !== socket.id; });
    addMessage(room, player.name + " غادر الغرفة", "leave");
    if (room.hostId === socket.id && room.players.length) {
      room.hostId = room.players[0].id;
      addMessage(room, room.players[0].name + " أصبح المضيف", "system");
    }
    socket.leave(room.id);
    socket.roomId = null;
    if (room.players.length === 0) {
      clearRoomTimer(room);
      delete rooms[room.id];
    } else broadcastRoom(room);
    cb && cb({ success: true });
  });

  // إشارات WebRTC للمكالمة الصوتية المباشرة.
  socket.on("callJoin", function() {
    var room = rooms[socket.roomId];
    if (!room) return;
    console.log("📞 callJoin", socket.id, "room", room.id);
    var me = room.players.find(function(p) { return p.id === socket.id; });
    if (me) {
      var hostLocked = Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, socket.id) ? !!room.hostMuteOverrides[socket.id] : !!room.hostMuteAll;
      me.micMuted = hostLocked || !!me.selfMuted;
    }
    var peers = room.players.filter(function(p) { return p.id !== socket.id && p.connected; }).map(function(p) {
      var hostMuted = Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, p.id) ? !!room.hostMuteOverrides[p.id] : !!room.hostMuteAll;
      return { id: p.id, name: p.name, muted: hostMuted || !!p.selfMuted, hostMuted: hostMuted, selfMuted: !!p.selfMuted };
    });
    socket.emit("callPeers", peers);
    // طبّق حالة كتم المضيف الحالية على الداخل الجديد.
    var currentHostMuted = Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, socket.id) ? !!room.hostMuteOverrides[socket.id] : !!room.hostMuteAll;
    socket.emit("callForceMute", { muted: currentHostMuted || !!(me && me.selfMuted), hostMuted: currentHostMuted, selfMuted: !!(me && me.selfMuted), byHost: currentHostMuted });
    socket.to(room.id).emit("callPeerJoined", { id: socket.id, name: (room.players.find(function(p){return p.id===socket.id;}) || {}).name || "" });
  });
  socket.on("callOffer", function(data) { if (data && data.to && data.offer) { console.log("📡 callOffer", socket.id, "->", data.to); io.to(data.to).emit("callOffer", { from: socket.id, offer: data.offer }); } });
  socket.on("callAnswer", function(data) { if (data && data.to && data.answer) { console.log("📡 callAnswer", socket.id, "->", data.to); io.to(data.to).emit("callAnswer", { from: socket.id, answer: data.answer }); } });
  socket.on("callIce", function(data) { if (data && data.to && data.candidate) io.to(data.to).emit("callIce", { from: socket.id, candidate: data.candidate }); });
  socket.on("callLeave", function() { socket.to(socket.roomId || "").emit("callPeerLeft", { id: socket.id }); });

  // اللاعب يغيّر مايكه من زر المايك الموجود بجانب اسمه.
  socket.on("callSelfMute", function(data) {
    var room = rooms[socket.roomId];
    if (!room) return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player) return;
    var requested = !!(data && data.muted);
    var hostLocked = Object.prototype.hasOwnProperty.call(room.hostMuteOverrides || {}, player.id) ? !!room.hostMuteOverrides[player.id] : !!room.hostMuteAll;
    if (hostLocked && !requested) {
      player.micMuted = true;
      socket.emit("callForceMute", { muted: true, hostMuted: true, selfMuted: !!player.selfMuted, byHost: true });
      socket.emit("callSelfMuteState", { muted: true, hostMuted: true, selfMuted: !!player.selfMuted });
      return;
    }
    player.selfMuted = requested;
    player.micMuted = hostLocked || requested;
    io.to(room.id).emit("callPlayerMuteState", { playerId: player.id, muted: player.micMuted, hostMuted: hostLocked, selfMuted: requested });
    socket.emit("callSelfMuteState", { muted: player.micMuted, hostMuted: hostLocked, selfMuted: requested });
  });

  // المضيف يستطيع كتم/تشغيل مايك جميع الموجودين في المكالمة.
  socket.on("callHostMuteAll", function(data) {
    var room = rooms[socket.roomId];
    if (!room || room.hostId !== socket.id) return;
    var muted = !!(data && data.muted);
    room.hostMuteAll = muted;
    room.hostMuteOverrides = {};
    room.players.forEach(function(p) {
      var effective = muted && p.id !== socket.id ? true : !!p.selfMuted;
      p.micMuted = effective;
      if (p.id !== socket.id && p.connected) io.to(p.id).emit("callForceMute", { muted: effective, hostMuted: muted, selfMuted: !!p.selfMuted, byHost: true, reason: "all" });
    });
    socket.emit("callHostMuteAck", { muted: muted });
    broadcastRoom(room);
  });

  // المضيف يستطيع كتم أو تشغيل لاعب واحد بالاسم/المعرف.
  socket.on("callHostMutePlayer", function(data) {
    var room = rooms[socket.roomId];
    if (!room || room.hostId !== socket.id) return;
    var targetId = data && data.playerId;
    if (!targetId || targetId === socket.id) return;
    var target = room.players.find(function(p) { return p.id === targetId; });
    if (!target) return;
    var muted = !!(data && data.muted);
    room.hostMuteOverrides = room.hostMuteOverrides || {};
    room.hostMuteOverrides[targetId] = muted;
    target.micMuted = muted || !!target.selfMuted;
    if (target.connected) io.to(targetId).emit("callForceMute", { muted: target.micMuted, hostMuted: muted, selfMuted: !!target.selfMuted, byHost: true, reason: "player", playerId: targetId });
    io.to(room.id).emit("callPlayerMuteState", { playerId: targetId, muted: target.micMuted, hostMuted: muted, selfMuted: !!target.selfMuted });
    broadcastRoom(room);
  });

  socket.on("startGame", function() {
    var room = rooms[socket.roomId];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 4) {
      addMessage(room, "⚠️ تحتاج 4 لاعبين على الأقل", "system");
      return broadcastRoom(room);
    }
    startGame(room);
  });

  socket.on("nightAction", function(data) {
    var room = rooms[socket.roomId];
    if (!room || room.state !== "night") return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player || !player.alive) return;
    if (["mafia","godfather","doctor","sheriff","sniper"].indexOf(player.role) < 0) return;
    if (player.role === "sniper" && room.sniperUsed) return;
    var target = room.players.find(function(p) { return p.id === data.target; });
    if (!target || !target.alive || target.id === socket.id) return;
    if (["mafia","godfather"].indexOf(player.role) >= 0 && ["mafia","godfather"].indexOf(target.role) >= 0) return;
    room.nightActions[socket.id] = { target: target.id, role: player.role };
    socket.emit("actionAck", { message: "✅ تم اختيار " + target.name });
    broadcastRoom(room);
  });

  socket.on("vote", function(data) {
    var room = rooms[socket.roomId];
    if (!room || (room.state !== "voting" && room.state !== "revote")) return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player || !player.alive) return;

    // إرسال null يعني سحب التصويت (التراجع عنه).
    if (!data || !data.target) {
      delete room.votes[socket.id];
      socket.emit("actionAck", { message: "↩️ تم سحب تصويتك" });
      broadcastRoom(room);
      return;
    }

    if (data.target === socket.id) return;
    var target = room.players.find(function(p) { return p.id === data.target; });
    if (!target || !target.alive) return;
    if (room.state === "revote" && room.revoteCandidates.indexOf(data.target) < 0) return;

    room.votes[socket.id] = data.target;
    socket.emit("actionAck", { message: "✅ تم تحديث تصويتك" });
    broadcastRoom(room);
  });

  socket.on("chat", function(data) {
    var room = rooms[socket.roomId];
    if (!room || typeof data.text !== "string" || !data.text.trim() || data.text.length > 300) return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player || !player.alive) return;

    // ليلاً: الدردشة سرية للمافيا فقط.
    if (room.state === "night") {
      if (["mafia","godfather"].indexOf(player.role) < 0) return;
      room.players.filter(function(p) {
        return p.alive && ["mafia","godfather"].indexOf(p.role) >= 0;
      }).forEach(function(m) {
        io.to(m.id).emit("chatMessage", { name: player.name, text: data.text, type: "mafia" });
      });
      return;
    }

    // نهاراً/وقت التصويت: الأحياء فقط يتكلمون.
    if (room.state === "day" || room.state === "voting" || room.state === "revote" || room.state === "lobby") {
      addMessage(room, player.name + ": " + data.text, "chat", player.name);
      broadcastRoom(room);
    }
  });

  // ============================================
  // الرسالة الصوتية
  // ============================================
  socket.on("voiceMessage", function(data) {
    var room = rooms[socket.roomId];
    if (!room || !data || typeof data.audio !== "string" || data.audio.length > 9000000) return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player || !player.alive) return;

    // في الليل: فقط المافيا ترسل لبعضها
    var channel = "public";
    if (room.state === "night" && ["mafia","godfather"].indexOf(player.role) >= 0) {
      channel = "mafia";
    }

    var voiceMsg = {
      id: "v_" + Date.now() + Math.random(),
      name: player.name,
      playerId: player.id,
      audio: data.audio,
      duration: data.duration || 0,
      time: Date.now(),
      channel: channel
    };

    room.voiceMessages.push(voiceMsg);
    if (room.voiceMessages.length > 50) room.voiceMessages.shift();

    if (channel === "mafia") {
      room.players.filter(function(p) {
        return ["mafia","godfather"].indexOf(p.role) >= 0;
      }).forEach(function(m) {
        io.to(m.id).emit("newVoiceMessage", voiceMsg);
      });
    } else {
      io.to(room.id).emit("newVoiceMessage", voiceMsg);
    }
  });

  socket.on("restart", function() {
    var room = rooms[socket.roomId];
    if (!room || room.hostId !== socket.id) return;
    room.state = "lobby";
    room.day = 0;
    room.winner = null;
    room.nightActions = {};
    room.votes = {};
    room.messages = [];
    room.voiceMessages = [];
    room.sniperUsed = false;
    room.players.forEach(function(p) { p.alive = true; p.role = null; });
    addMessage(room, "🔄 العودة لصالة الانتظار", "system");
    broadcastRoom(room);
  });

  socket.on("disconnect", function() {
    var roomId = socket.roomId;
    if (!roomId) return;
    var room = rooms[roomId];
    if (!room) return;
    var player = room.players.find(function(p) { return p.id === socket.id; });
    if (!player) return;
    // التحديث/انقطاع الشبكة لا يخرج اللاعب. يبقى في الغرفة حتى يضغط "خروج".
    player.connected = false;
    player.lastSeen = Date.now();
    addMessage(room, player.name + " انقطع اتصاله (سيبقى في الغرفة)", "leave");
    socket.to(room.id).emit("callPeerLeft", { id: socket.id });
    broadcastRoom(room);
  });

  socket.on("sync", function() {
    var room = rooms[socket.roomId];
    if (room) socket.emit("roomUpdate", sanitizeRoom(room, socket.id));
  });
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", function() {
  var ip = getLocalIP();
  console.log("");
  console.log("🎭 ═══════════════════════════════════════");
  console.log("   سيرفر المافيا يعمل!");
  console.log("═══════════════════════════════════════");
  console.log("   💻 http://localhost:" + PORT);
  console.log("   📱 http://" + ip + ":" + PORT);
  console.log("═══════════════════════════════════════");
  console.log("");
});
