console.log("🎭 بدء");

window.onload = function() {
  console.log("✅ الصفحة محمّلة");

  var socket = io({ transports: ["websocket", "polling"] });
  var myId = null;
  var myRoom = null;
  var myName = "";
  var currentRoom = null;
  var myRole = null;
  var sessionId = localStorage.getItem("mafiaSessionId");
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random()).replace(".", ""));
    localStorage.setItem("mafiaSessionId", sessionId);
  }

  function $(id) { return document.getElementById(id); }
  function esc(str) { var d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

  var urlRoom = new URLSearchParams(window.location.search).get("room");
  if (urlRoom) {
    $("inputRoomId").value = urlRoom.trim().toUpperCase();
    $("inputName").focus();
  }

  function showError(msg) {
    var el = $("authError");
    if (el) { el.textContent = msg; setTimeout(function(){ el.textContent = ""; }, 4000); }
  }

  function toast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timeout);
    t._timeout = setTimeout(function(){ t.classList.remove("show"); }, 2800);
  }

  function getRoleInfo(role) {
    var r = {
      godfather: { name: "زعيم المافيا", team: "mafia", emoji: "👑", desc: "زعيم المافيا. تظهر كمواطن عند التحقيق" },
      mafia:     { name: "مافيا", team: "mafia", emoji: "🔪", desc: "تقتل مع فريقك كل ليلة" },
      sniper:    { name: "القناص", team: "city", emoji: "🎯", desc: "تقتل لاعباً مرة واحدة. لو أخطأت تموت" },
      doctor:    { name: "الطبيب", team: "city", emoji: "💉", desc: "تحمي لاعباً كل ليلة" },
      sheriff:   { name: "الشريف", team: "city", emoji: "🔍", desc: "تحقق في لاعب كل ليلة" },
      citizen:   { name: "مواطن", team: "city", emoji: "👤", desc: "ناقش وصوّت خلال النهار" }
    };
    return r[role];
  }

  // ============ ربط الأزرار ============
  console.log("فحص الأزرار:", {
    btnCreate: !!$("btnCreate"),
    btnJoin: !!$("btnJoin"),
    inputName: !!$("inputName")
  });

  $("btnCreate").onclick = function() {
    console.log("🖱️ إنشاء");
    var name = $("inputName").value.trim();
    if (name.length < 2) return showError("الاسم قصير");
    myName = name;
    socket.emit("createRoom", { name: name, maxPlayers: 60, sessionId: sessionId }, function(res) {
      console.log("📨", res);
      if (res.error) return showError(res.error);
      localStorage.setItem("mafiaRoomId", res.roomId);
      localStorage.setItem("mafiaPlayerName", myName);
      enterGame(res.roomId);
    });
  };

  $("btnJoin").onclick = function() {
    var name = $("inputName").value.trim();
    var roomId = $("inputRoomId").value.trim().toUpperCase();
    if (name.length < 2) return showError("الاسم قصير");
    if (roomId.length < 4) return showError("رمز الغرفة غير صحيح");
    myName = name;
    socket.emit("joinRoom", { name: name, roomId: roomId, sessionId: sessionId }, function(res) {
      if (res.error) return showError(res.error);
      localStorage.setItem("mafiaRoomId", res.roomId);
      localStorage.setItem("mafiaPlayerName", myName);
      enterGame(res.roomId);
    });
  };

  function enterGame(roomId) {
    myRoom = roomId;
    myId = socket.id;
    history.replaceState(null, "", "?room=" + encodeURIComponent(myRoom));
    $("screen-auth").style.display = "none";
    $("screen-game").style.display = "flex";
    $("displayRoomId").textContent = myRoom;
    socket.emit("sync");
  }

  // بعد التحديث، استرجع اللاعب تلقائياً من نفس المتصفح.
  function tryResume() {
    var savedRoom = localStorage.getItem("mafiaRoomId");
    if (!savedRoom || !sessionId) return;
    socket.emit("resumeRoom", { roomId: savedRoom, sessionId: sessionId }, function(res) {
      if (res && res.success) {
        myName = res.name || localStorage.getItem("mafiaPlayerName") || "";
        enterGame(res.roomId);
        toast("↩️ رجعت للغرفة تلقائياً");
      } else {
        localStorage.removeItem("mafiaRoomId");
        localStorage.removeItem("mafiaPlayerName");
      }
    });
  }

  $("btnCopy").onclick = function() {
    var invite = window.location.origin + window.location.pathname + "?room=" + encodeURIComponent(myRoom);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(invite).then(function() { toast("🔗 تم نسخ رابط الدعوة"); });
    } else {
      window.prompt("انسخ رابط الدعوة:", invite);
    }
  };

  $("btnStart").onclick = function() { socket.emit("startGame"); };

  $("btnRestart").onclick = function() {
    socket.emit("restart");
    $("endScreen").classList.add("hidden");
  };

  $("btnLeave").onclick = function() {
    if (!confirm("متأكد تريد الخروج من الغرفة؟")) return;
    stopCall();
    socket.emit("leaveRoom", function() {
      localStorage.removeItem("mafiaRoomId");
      localStorage.removeItem("mafiaPlayerName");
      myRoom = null;
      currentRoom = null;
      window.location.href = window.location.pathname;
    });
  };

  function setChatOpen(open) {
    var screen = $("screen-game");
    var panel = $("bottomPanel");
    var compose = $("chatForm");
    if (screen) screen.classList.toggle("chat-open", !!open);
    if (panel) panel.classList.toggle("open", !!open);
    if (compose) compose.classList.toggle("hidden", !open);
    if (open) setTimeout(function() {
      var input = $("chatInput");
      if (input) input.focus({ preventScroll: true });
      var box = $("chatMessages");
      if (box) box.scrollTop = box.scrollHeight;
    }, 40);
  }

  $("btnMessages").onclick = function() {
    var panel = $("bottomPanel");
    setChatOpen(!(panel && panel.classList.contains("open")));
  };


  $("chatForm").onsubmit = function(e) {
    e.preventDefault();
    var text = $("chatInput").value.trim();
    if (!text) return;
    socket.emit("chat", { text: text });
    $("chatInput").value = "";
  };

  // ============ الصوت ============
  var mediaRecorder = null, audioChunks = [], isRecording = false, recStart = 0, recTimer = null;

  $("btnVoice").onclick = function() {
    if (isRecording) stopRec(true);
    else startRec();
  };

  $("btnCancelVoice").onclick = function() { stopRec(false); };
  $("btnSendVoice").onclick = function() { stopRec(true); };

  async function startRec() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var opts = { mimeType: "audio/webm" };
      if (!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: "audio/mp4" };
      mediaRecorder = new MediaRecorder(stream, opts);
      audioChunks = [];
      isRecording = true;
      recStart = Date.now();
      mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.start();
      $("btnVoice").classList.add("recording");
      $("btnVoice").textContent = "⏹";
      $("voiceBar").classList.remove("hidden");
      recTimer = setInterval(function() {
        var e = Math.floor((Date.now() - recStart) / 1000);
        $("recordingTime").textContent = String(Math.floor(e/60)).padStart(2,"0") + ":" + String(e%60).padStart(2,"0");
        if (e >= 60) stopRec(true);
      }, 200);
    } catch (err) {
      alert("❌ لا يمكن الوصول للمايكروفون");
    }
  }

  function stopRec(send) {
    if (!mediaRecorder || !isRecording) return;
    isRecording = false;
    clearInterval(recTimer);
    $("btnVoice").classList.remove("recording");
    $("btnVoice").textContent = "🎤";
    $("voiceBar").classList.add("hidden");
    var duration = Math.floor((Date.now() - recStart) / 1000);
    mediaRecorder.onstop = function() {
      mediaRecorder.stream.getTracks().forEach(function(t) { t.stop(); });
      if (send && audioChunks.length > 0 && duration >= 1) {
        var blob = new Blob(audioChunks, { type: audioChunks[0].type });
        var reader = new FileReader();
        reader.onloadend = function() {
          socket.emit("voiceMessage", { audio: reader.result, duration: duration });
          toast("🎤 تم الإرسال");
        };
        reader.readAsDataURL(blob);
      }
    };
    mediaRecorder.stop();
    audioChunks = [];
  }

  // ============ المكالمة الصوتية المباشرة (WebRTC) ============
  // WebRTC صوت حقيقي منخفض التأخير. السيرفر هنا للإشارة فقط، والصوت ينتقل مباشرة بين اللاعبين.
  var callPeers = {};
  var callStream = null;
  var inCall = false;
  var iceQueue = {};
  var localMutedByHost = false;
  var hostMutedPlayers = {};
  var callConfig = {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      // TURN عام للاختبار. للإنتاج الكبير يفضّل وضع TURN خاص بك في السيرفر.
      { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
    ],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  };

  function callStatus(text) { if ($("callStatus")) $("callStatus").textContent = text; }
  function updateCallCount() {
    var n = Object.keys(callPeers).length + (inCall ? 1 : 0);
    if ($("callCount")) $("callCount").textContent = n + " متصل";
  }
  function addRemoteAudio(id, stream) {
    var old = $("audio-" + id);
    if (old) old.remove();
    var a = document.createElement("audio");
    a.id = "audio-" + id;
    a.autoplay = true;
    a.playsInline = true;
    a.controls = false;
    a.volume = 1;
    a.srcObject = stream;
    document.body.appendChild(a);
    var play = a.play();
    if (play && play.catch) play.catch(function(){
      // يطلب المتصفح أحياناً نقرة مستخدم لتشغيل الصوت؛ زر المكالمة التالي سيعيد المحاولة.
    });
  }
  async function flushIce(peerId) {
    var pc = callPeers[peerId];
    if (!pc || !iceQueue[peerId]) return;
    var q = iceQueue[peerId];
    iceQueue[peerId] = [];
    for (var i=0;i<q.length;i++) {
      try { await pc.addIceCandidate(new RTCIceCandidate(q[i])); } catch(e) { console.warn("ICE", e); }
    }
  }
  function makePeer(peerId, shouldOffer) {
    if (!peerId || peerId === myId) return null;
    if (callPeers[peerId]) return callPeers[peerId];
    var pc = new RTCPeerConnection(callConfig);
    callPeers[peerId] = pc;
    iceQueue[peerId] = [];
    if (callStream) callStream.getTracks().forEach(function(t) { pc.addTrack(t, callStream); });
    pc.ontrack = function(e) { if (e.streams && e.streams[0]) addRemoteAudio(peerId, e.streams[0]); };
    pc.onicecandidate = function(e) {
      if (e.candidate) socket.emit("callIce", { to: peerId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = function() {
      if (pc.connectionState === "connected") callStatus("المكالمة فعالة • الصوت متصل");
      if (["failed","closed"].indexOf(pc.connectionState) >= 0) closePeer(peerId);
    };
    if (shouldOffer) {
      pc.createOffer({ offerToReceiveAudio: true }).then(function(o) {
        return pc.setLocalDescription(o);
      }).then(function() {
        socket.emit("callOffer", { to: peerId, offer: pc.localDescription });
      }).catch(function(e) { console.error("offer", e); });
    }
    updateCallCount();
    return pc;
  }
  function closePeer(peerId) {
    var pc = callPeers[peerId];
    if (pc) { try { pc.close(); } catch(e) {} delete callPeers[peerId]; }
    delete iceQueue[peerId];
    var a = $("audio-" + peerId); if (a) a.remove();
    updateCallCount();
  }
  async function startCall() {
    if (inCall) {
      Object.keys(callPeers).forEach(function(id){ var a=$("audio-"+id); if(a) a.play().catch(function(){}); });
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("❌ المتصفح لا يدعم مكالمات الصوت الآمنة."); return;
    }
    try {
      callStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false
      });
      inCall = true;
      localMutedByHost = false;
      $("callPanel").classList.remove("hidden");
      $("btnCall").textContent = "📞 المكالمة مفتوحة";
      callStatus("جاري توصيل الصوت...");
      socket.emit("callJoin");
      updateCallCount();
      updateMicButtonsForAll();
    } catch (e) {
      console.error(e);
      alert("❌ اسمح للموقع باستخدام الميكروفون ثم حاول مرة ثانية.");
    }
  }
  function stopCall() {
    if (inCall) socket.emit("callLeave");
    Object.keys(callPeers).forEach(closePeer);
    if (callStream) callStream.getTracks().forEach(function(t) { t.stop(); });
    callStream = null; inCall = false; localMutedByHost = false;
    if ($("callPanel")) $("callPanel").classList.add("hidden");
    if ($("callSettings")) $("callSettings").classList.add("hidden");
    if ($("btnCall")) $("btnCall").textContent = "📞 انضم للمكالمة";
    callStatus("غير متصل"); updateCallCount();
  }
  $("btnCall").onclick = startCall;
  $("btnCallLeave").onclick = stopCall;
  $("btnCloseCall").onclick = stopCall;
  $("btnCallSettings").onclick = function() { $("callSettings").classList.toggle("hidden"); };
  function toggleMyMic() {
    if (!callStream) return startCall();
    var t = callStream.getAudioTracks()[0];
    if (!t || localMutedByHost) return;
    t.enabled = !t.enabled;
    localMutedByHost = !t.enabled;
    $("btnMute").textContent = t.enabled ? "🎙️ كتم المايك" : "🔇 تشغيل المايك";
    var me = currentRoom && currentRoom.players ? currentRoom.players.find(function(p){ return p.id === myId; }) : null;
    if (me) me.micMuted = !t.enabled;
    socket.emit("callSelfMute", { muted: !t.enabled });
    updateMicButtonsForAll();
  }
  $("btnMute").onclick = function() { toggleMyMic(); };
  function requestPlayerMute(playerId, muted) {
    if (!currentRoom || currentRoom.hostId !== myId || playerId === myId) return;
    socket.emit("callHostMutePlayer", { playerId: playerId, muted: !!muted });
  }
  function isPlayerMuted(playerId) {
    var p = currentRoom && currentRoom.players ? currentRoom.players.find(function(x){ return x.id === playerId; }) : null;
    if (p && typeof p.micMuted === "boolean") return p.micMuted;
    if (playerId === myId) {
      if (!callStream) return false;
      var t = callStream.getAudioTracks()[0];
      return !!localMutedByHost || !t || !t.enabled;
    }
    return !!hostMutedPlayers[playerId];
  }
  function updateMicButtonsForAll() {
    document.querySelectorAll("[data-mic-player]").forEach(function(btn) {
      var id = btn.getAttribute("data-mic-player");
      var muted = isPlayerMuted(id);
      btn.textContent = muted ? "🔇" : "🎙️";
      btn.title = muted ? "تشغيل المايك" : "كتم المايك";
      btn.classList.toggle("muted", muted);
    });
  }
  $("btnHostMuteAll").onclick = function() {
    if (!currentRoom || currentRoom.hostId !== myId) return;
    socket.emit("callHostMuteAll", { muted: true });
  };
  $("btnHostUnmuteAll").onclick = function() {
    if (!currentRoom || currentRoom.hostId !== myId) return;
    socket.emit("callHostMuteAll", { muted: false });
  };
  socket.on("callPeers", function(list) {
    if (!inCall) return;
    // استلام حالات الكتم الفردية الحالية من السيرفر.
    (list || []).forEach(function(p) {
      if (p && p.id) hostMutedPlayers[p.id] = !!p.muted;
      makePeer(p.id, true);
    });
    updateMicButtonsForAll();
    callStatus("جاري ربط الصوت...");
  });
  socket.on("callPeerJoined", function(p) {
    if (!inCall || !p || !p.id) return;
    // اللاعب القديم ينتظر العرض من اللاعب الجديد.
    makePeer(p.id, false);
  });
  socket.on("callOffer", async function(d) {
    if (!inCall || !d || !d.from || !d.offer) return;
    try {
      var pc = makePeer(d.from, false);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
      await flushIce(d.from);
      var answer = await pc.createAnswer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(answer);
      socket.emit("callAnswer", { to: d.from, answer: pc.localDescription });
    } catch(e) { console.error("answer", e); }
  });
  socket.on("callAnswer", async function(d) {
    var pc = callPeers[d && d.from];
    if (!pc || !d.answer) return;
    try { await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); await flushIce(d.from); } catch(e) { console.warn("answer set", e); }
  });
  socket.on("callIce", async function(d) {
    if (!d || !d.from || !d.candidate) return;
    var pc = callPeers[d.from];
    if (!pc || !pc.remoteDescription) {
      if (!iceQueue[d.from]) iceQueue[d.from] = [];
      iceQueue[d.from].push(d.candidate);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch(e) { console.warn("ICE add", e); }
  });
  socket.on("callPeerLeft", function(d) { if (d && d.id) closePeer(d.id); });
  socket.on("callForceMute", function(d) {
    if (!callStream) return;
    var t = callStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !d.muted;
    localMutedByHost = !!d.muted;
    $("btnMute").textContent = d.muted ? "🔇 تشغيل المايك" : "🎙️ كتم المايك";
    if (currentRoom && currentRoom.players) {
      var me = currentRoom.players.find(function(p){ return p.id === myId; });
      if (me) me.micMuted = !!d.muted;
    }
    updateMicButtonsForAll();
    refreshPlayerMicLayer();
    toast(d.muted ? "🔇 المضيف كتم مايكك" : "🎙️ المضيف فعّل مايكك");
  });
  socket.on("callSelfMuteState", function(d) {
    if (!d) return;
    var muted = !!d.muted;
    localMutedByHost = muted;
    if (currentRoom && currentRoom.players) {
      var me = currentRoom.players.find(function(p){ return p.id === myId; });
      if (me) me.micMuted = muted;
    }
    updateMicButtonsForAll();
    refreshPlayerMicLayer();
  });

  socket.on("callPlayerMuteState", function(d) {
    if (!d || !d.playerId) return;
    hostMutedPlayers[d.playerId] = !!d.muted;
    if (currentRoom && currentRoom.players) {
      var p = currentRoom.players.find(function(x){ return x.id === d.playerId; });
      if (p) p.micMuted = !!d.muted;
    }
    updateMicButtonsForAll();
    refreshPlayerMicLayer();
  });

  function refreshHostCallControls() {
    var isHost = currentRoom && currentRoom.hostId === myId;
    if ($("hostCallControls")) $("hostCallControls").classList.toggle("hidden", !isHost);
  }

  // ============ استقبال ============
  socket.on("connect", function() { myId = socket.id; tryResume(); });
  socket.on("roomUpdate", function(room) { renderRoom(room); refreshPlayerMicLayer(); });
  socket.on("timer", function(t) { if ($("timer")) $("timer").textContent = t; });

  socket.on("yourRole", function(data) {
    myRole = data.role;
    var card = $("roleCard");
    if (card) {
      card.classList.remove("hidden");
      card.className = "role-card " + data.info.team;
      $("roleEmoji").textContent = data.info.emoji;
      $("roleName").textContent = data.info.name;
      $("roleDesc").textContent = data.info.desc;
      setTimeout(function() { card.classList.add("hidden"); }, 6000);
    }
    toast("🎭 دورك: " + data.info.name + " " + data.info.emoji);
  });

  socket.on("mafiaTeam", function(members) {
    var names = members.map(function(m) { return m.name === myName ? "⭐ " + m.name : m.name; }).join(" • ");
    if ($("resultArea")) {
      $("resultArea").innerHTML = '<div class="result-item" style="border-color:#c72c48;background:rgba(139,26,26,0.4);color:#fecaca">🔪 فريق المافيا: ' + esc(names) + '</div>';
      setTimeout(function() { $("resultArea").innerHTML = ""; }, 8000);
    }
  });

  socket.on("nightPrompt", function(data) {
    var alive = currentRoom ? currentRoom.players.filter(function(p) { return p.alive && p.id !== myId; }) : [];
    var labels = { save: "🛡️ اختر من تحمي:", investigate: "🔍 اختر من تحقق:", snipe: "🎯 اختر هدف القناص:" };
    renderActions(labels[data.action], alive, function(tid) { socket.emit("nightAction", { target: tid }); });
  });

  socket.on("actionAck", function(d) { toast(d.message); });

  socket.on("investigationResult", function(d) {
    var text = d.result === "mafia" ? "🔪 " + d.targetName + " مافيا!" : "✅ " + d.targetName + " مواطن.";
    var color = d.result === "mafia" ? "rgba(199,44,72,0.4)" : "rgba(74,222,128,0.3)";
    if ($("resultArea")) {
      $("resultArea").innerHTML = '<div class="result-item" style="background:' + color + '">' + text + '</div>';
      setTimeout(function() { $("resultArea").innerHTML = ""; }, 10000);
    }
  });

  socket.on("chatMessage", function(d) { appendChat(d.name, d.text, d.type); });
  socket.on("newVoiceMessage", function(v) { appendVoice(v); });

  // ============ الرسم ============
  function renderRoom(room) {
    currentRoom = room;
    if ($("dayCount")) $("dayCount").textContent = room.day;
    updatePhase(room.state);
    if ($("timer")) $("timer").textContent = room.timeLeft || 0;

    var alive = room.players.filter(function(p) { return p.alive; }).length;
    if ($("aliveCount")) $("aliveCount").textContent = alive;
    if ($("totalCount")) $("totalCount").textContent = room.players.length;

    renderSeats(room);
    updateMicButtonsForAll();
    updateChatHeader(room);

    var isHost = room.hostId === myId;
    refreshHostCallControls();
    var btn = $("btnStart");
    if (btn) {
      // زر البدء يبقى ظاهرًا للمضيف طوال فترة الانتظار، ويصبح فعالًا عند اكتمال 4 لاعبين.
      if (isHost && room.state === "lobby") {
        btn.classList.remove("hidden");
        btn.textContent = room.players.length >= 4 ? "▶ ابدأ اللعبة" : "▶ ابدأ (" + room.players.length + "/4)";
        btn.disabled = room.players.length < 4;
        btn.title = room.players.length >= 4 ? "ابدأ اللعبة" : "تحتاج 4 لاعبين على الأقل";
      } else {
        btn.classList.add("hidden");
        btn.disabled = false;
      }
    }

    renderMsgs(room.messages);
    renderedVoiceIds = {};
    renderVoiceHistory(room.voiceMessages || []);
    renderActionsForState(room);
    if (room.state === "ended" && room.winner) showEnd(room);
  }

  function renderSeats(room) {
    var el = $("seats");
    if (!el) return;
    el.innerHTML = "";
    var players = room.players;
    var total = players.length;
    if (total === 0) return;

    var step = (Math.PI * 2) / Math.max(total, 4);
    // على الهاتف نقرّب المقاعد قليلاً للداخل حتى لا تُقص الأسماء عند حافة الدردشة.
    var isMobile = window.innerWidth <= 700;
    var radius = isMobile ? (total >= 10 ? 34 : (total >= 8 ? 36 : 38)) : 42;

    players.forEach(function(p, i) {
      var angle = -Math.PI / 2 + step * i;
      var x = 50 + radius * Math.cos(angle);
      var y = 50 + radius * Math.sin(angle);

      var seat = document.createElement("div");
      seat.className = "seat";
      seat.style.left = x + "%";
      seat.style.top = y + "%";

      if (!p.alive) seat.classList.add("dead");
      if (p.isMafiaMate && p.id !== myId) seat.classList.add("mafia");
      if (p.id === myId) seat.classList.add("is-you");
      if (room.state === "voting" || room.state === "revote") {
        var vc = room.players.filter(function(x) { return x.votedFor === p.id; }).length;
        if (vc > 0) seat.classList.add("voted-against");
      }

      var info = p.role ? getRoleInfo(p.role) : null;
      var show = p.id === myId || (p.isMafiaMate && p.id !== myId) || room.state === "ended" || !p.alive;

      var card = "";
      if (show && info) card = '<span class="card-role">' + info.emoji + '</span>';
      else if (!p.alive) card = '<span class="card-role">💀</span>';

      var badge = "";
      if (room.state === "voting" || room.state === "revote") {
        var vc2 = room.players.filter(function(x) { return x.votedFor === p.id; }).length;
        if (vc2 > 0) badge = '<div class="vote-badge">' + vc2 + '</div>';
      }

      seat.innerHTML =
        '<div class="seat-inner">' + badge +
          '<div class="chair"></div>' +
          '<div class="card' + (show && info ? ' revealed' : '') + '">' + card +
            '<div class="card-name">' + esc(p.name) + '</div>' +
          '</div>' +
          '<div class="seat-name' + (p.id === myId ? ' you' : '') + (p.id === room.hostId ? ' host' : '') + '>' +
            '<span class="seat-name-text">' + (p.id === myId ? '⭐ ' : '') + esc(p.name) + '</span>' +
            '<button type="button" class="player-mic-btn' + (isPlayerMuted(p.id) ? ' muted' : '') + '" data-mic-player="' + p.id + '" title="' + (isPlayerMuted(p.id) ? 'تشغيل المايك' : 'كتم المايك') + '">' + (isPlayerMuted(p.id) ? '🔇' : '🎙️') + '</button>' +
          '</div>' +
        '</div>';
      el.appendChild(seat);
      var micBtn = seat.querySelector('[data-mic-player="' + p.id + '"]');
      if (micBtn) {
        micBtn.onclick = function(ev) {
          ev.preventDefault(); ev.stopPropagation();
          if (p.id === myId) return toggleMyMic();
          if (currentRoom && currentRoom.hostId === myId) requestPlayerMute(p.id, !isPlayerMuted(p.id));
        };
        if (p.id !== myId && currentRoom && currentRoom.hostId !== myId) {
          micBtn.disabled = true;
          micBtn.setAttribute("aria-label", "حالة مايك " + p.name);
        } else {
          micBtn.setAttribute("aria-label", (isPlayerMuted(p.id) ? "تشغيل مايك " : "كتم مايك ") + p.name);
        }
      }
    });
  }


  // طبقة مايكات مستقلة: تحافظ على ظهور مايك كل لاعب حتى فوق لوحة المكالمة أو الصورة.
  var micLayerFrame = 0;
  function renderPlayerMicLayer(room) {
    var layer = $("playerMicLayer");
    if (!layer || !room || !room.players) return;
    cancelAnimationFrame(micLayerFrame);
    micLayerFrame = requestAnimationFrame(function() {
      var seats = document.querySelectorAll("#seats .seat");
      layer.innerHTML = "";
      room.players.forEach(function(p, i) {
        var seat = seats[i];
        if (!seat) return;
        var name = seat.querySelector(".seat-name");
        if (!name) return;
        var r = name.getBoundingClientRect();
        var btn = document.createElement("button");
        var muted = isPlayerMuted(p.id);
        btn.type = "button";
        btn.className = "player-mic-float" + (muted ? " muted" : "");
        btn.textContent = muted ? "🔇" : "🎙️";
        btn.title = muted ? "تشغيل مايك " + p.name : "كتم مايك " + p.name;
        btn.setAttribute("aria-label", (muted ? "تشغيل مايك " : "كتم مايك ") + p.name);
        btn.style.left = Math.max(3, Math.min(window.innerWidth - 36, r.left - 36)) + "px";
        btn.style.top = Math.max(3, Math.min(window.innerHeight - 34, r.top + (r.height - 30) / 2)) + "px";
        if (p.id !== myId && (!currentRoom || currentRoom.hostId !== myId)) {
          btn.disabled = true;
        }
        btn.onclick = function(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (p.id === myId) {
            toggleMyMic();
            return;
          }
          if (currentRoom && currentRoom.hostId === myId) {
            requestPlayerMute(p.id, !isPlayerMuted(p.id));
          }
        };
        layer.appendChild(btn);
      });
    });
  }

  function refreshPlayerMicLayer() {
    if (currentRoom) renderPlayerMicLayer(currentRoom);
  }
  window.addEventListener("resize", refreshPlayerMicLayer);
  window.addEventListener("orientationchange", function(){ setTimeout(refreshPlayerMicLayer, 80); });

  function updatePhase(state) {
    var b = $("phaseBadge");
    if (b) b.className = "phase-pill " + state;
    var icons = { lobby: "🚪", night: "🌙", day: "☀️", voting: "🗳️", revote: "🔁", ended: "🏆" };
    var texts = { lobby: "الانتظار", night: "الليل", day: "النهار", voting: "التصويت", revote: "إعادة التصويت", ended: "انتهت" };
    if ($("stateIcon")) $("stateIcon").textContent = icons[state] || "❓";
    if ($("stateText")) $("stateText").textContent = texts[state] || state;
  }

  function updateChatHeader(room) {
    var me = room.players.find(function(p) { return p.id === myId; });
    var isMafia = room.state === "night" && me && me.alive && me.role && ["mafia","godfather"].indexOf(me.role) >= 0;
    if ($("chatHeader")) $("chatHeader").classList.toggle("mafia", isMafia);
    if ($("chatTitle")) $("chatTitle").textContent = isMafia ? "🔪 قناة المافيا السرية" : "💬 الدردشة العامة";
  }

  function renderActionsForState(room) {
    var me = room.players.find(function(p) { return p.id === myId; });
    if (!me) return;
    if ((room.state === "voting" || room.state === "revote") && me.alive) {
      var allowedIds = room.state === "revote" ? (room.revoteCandidates || []) : null;
      var alive = room.players.filter(function(p) {
        return p.alive && p.id !== myId && (!allowedIds || allowedIds.indexOf(p.id) >= 0);
      });
      var title = room.state === "revote" ? "🔁 إعادة التصويت: اختر أحد المتعادلين" : "🗳️ اختر من تعتقد أنه مافيا:";
      renderActions(title, alive, function(tid) { socket.emit("vote", { target: tid }); });
    } else if (room.state === "night" && me.alive && me.role && ["mafia","godfather"].indexOf(me.role) >= 0) {
      var alive2 = room.players.filter(function(p) { return p.alive && p.id !== myId && ["mafia","godfather"].indexOf(p.role) < 0; });
      var myNightTarget = me.nightTarget ? me.nightTarget.target : null;
      renderActions("🔪 اختر ضحية الليلة:", alive2, function(tid) {
        socket.emit("nightAction", { target: tid });
        // تحديث بصري فوري قبل وصول تحديث السيرفر.
        renderActions("🔪 اختر ضحية الليلة:", alive2, arguments.callee, tid);
      }, myNightTarget);
    } else if ($("actionArea")) {
      $("actionArea").innerHTML = "";
      $("actionArea").classList.remove("active");
    }
  }

  function renderActions(title, players, cb, selectedTarget) {
    var area = $("actionArea");
    if (!area) return;
    area.classList.add("active");

    var currentVote = null;
    var currentVoteName = "لم تختر أحداً بعد";
    var isVoting = currentRoom && (currentRoom.state === "voting" || currentRoom.state === "revote");
    if (isVoting) {
      var me = currentRoom.players.find(function(p) { return p.id === myId; });
      currentVote = me ? me.votedFor : null;
      if (currentVote) {
        var vp = currentRoom.players.find(function(p) { return p.id === currentVote; });
        if (vp) currentVoteName = vp.name;
      }
    }

    var chosen = isVoting ? currentVote : (selectedTarget || null);
    var chosenPlayer = chosen ? players.find(function(p) { return p.id === chosen; }) : null;
    var statusText = isVoting ? currentVoteName : (chosenPlayer ? chosenPlayer.name : "لم تختر ضحية بعد");
    var statusLabel = isVoting ? "🎯 صوتك" : "🔪 هدفك الليلة";

    var html = "<div class='action-title'>" + title + "</div>";
    html += "<div class='vote-current'>" + statusLabel + ": <b>" + esc(statusText) + "</b></div>";
    html += "<div class='action-grid'>";
    players.forEach(function(p) {
      var selected = chosen === p.id ? " selected" : "";
      html += '<button type="button" class="action-btn' + selected + '" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>';
    });
    html += "</div>";
    if (isVoting) html += '<button class="withdraw-vote" type="button">↩️ تراجع عن التصويت</button>';
    area.innerHTML = html;

    area.querySelectorAll(".action-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var tid = btn.dataset.id;
        if (isVoting) {
          socket.emit("vote", { target: currentVote === tid ? null : tid });
        } else {
          socket.emit("nightAction", { target: tid });
          // لا ننتظر الجولة التالية: اعرض الهدف فوراً.
          renderActions(title, players, cb, tid);
        }
      });
    });

    var withdraw = area.querySelector(".withdraw-vote");
    if (withdraw) withdraw.addEventListener("click", function() { socket.emit("vote", { target: null }); });
  }

  function renderMsgs(messages) {
    var box = $("chatMessages");
    if (!box) return;
    box.innerHTML = "";
    if (!messages) return;
    messages.forEach(function(m) {
      var div = document.createElement("div");
      div.className = "msg " + m.type;
      if (m.type === "chat") {
        var parts = m.text.split(": ");
        div.innerHTML = '<span class="name">' + esc(parts[0]) + ':</span> ' + esc(parts.slice(1).join(": "));
      } else div.textContent = m.text;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }

  function appendChat(name, text, type) {
    var box = $("chatMessages");
    if (!box) return;
    var div = document.createElement("div");
    div.className = "msg " + (type || "chat");
    div.innerHTML = '<span class="name">' + esc(name) + ':</span> ' + esc(text);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  var activeAudio = {};
  var renderedVoiceIds = {};

  function renderVoiceHistory(list) {
    var box = $("chatMessages");
    if (!box) return;
    (list || []).forEach(function(v) {
      if (!renderedVoiceIds[v.id]) appendVoice(v);
    });
  }

  function appendVoice(v) {
    if (renderedVoiceIds[v.id]) return;
    renderedVoiceIds[v.id] = true;
    var box = $("chatMessages");
    if (!box) return;
    var div = document.createElement("div");
    div.className = "voice-msg" + (v.channel === "mafia" ? " mafia" : "");
    var m = String(Math.floor(v.duration/60)).padStart(2,"0");
    var s = String(v.duration%60).padStart(2,"0");
    var waves = "";
    for (var i = 0; i < 20; i++) waves += '<span style="height:' + (4 + Math.random()*14) + 'px"></span>';
    div.innerHTML =
      '<button class="vm-play">▶</button>' +
      '<div class="vm-info">' +
        '<div class="vm-author">' + esc(v.name) + (v.channel === "mafia" ? " 🔪" : "") + '</div>' +
        '<div class="vm-wave">' + waves + '</div>' +
        '<div class="vm-time">🎤 ' + m + ":" + s + '</div>' +
      '</div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    var playBtn = div.querySelector(".vm-play");
    var waveEl = div.querySelector(".vm-wave");
    playBtn.onclick = function() {
      Object.keys(activeAudio).forEach(function(k) {
        if (k !== v.id) { activeAudio[k].pause(); activeAudio[k].currentTime = 0; }
      });
      if (activeAudio[v.id]) {
        var a = activeAudio[v.id];
        if (a.paused) { a.play(); playBtn.textContent = "⏸"; playBtn.classList.add("playing"); waveEl.classList.add("playing"); }
        else { a.pause(); playBtn.textContent = "▶"; playBtn.classList.remove("playing"); waveEl.classList.remove("playing"); }
        return;
      }
      var audio = new Audio(v.audio);
      activeAudio[v.id] = audio;
      playBtn.textContent = "⏸"; playBtn.classList.add("playing"); waveEl.classList.add("playing");
      audio.play();
      audio.onended = function() {
        playBtn.textContent = "▶"; playBtn.classList.remove("playing"); waveEl.classList.remove("playing");
        delete activeAudio[v.id];
      };
    };
  }

  function showEnd(room) {
    var es = $("endScreen");
    if (!es) return;
    es.classList.remove("hidden");
    var mafiaWin = room.winner === "mafia";
    $("endCrown").textContent = mafiaWin ? "🔪" : "🏛️";
    $("endTitle").textContent = mafiaWin ? "فازت المافيا!" : "فازت المدينة!";
    $("endMessage").textContent = mafiaWin ? "المافيا سيطرت على المدينة" : "المدينة انتصرت";
    var box = $("endRoles");
    box.innerHTML = "";
    room.players.forEach(function(p) {
      var info = getRoleInfo(p.role);
      var div = document.createElement("div");
      div.className = "end-card " + (info ? info.team : "") + (p.alive ? "" : " dead");
      div.innerHTML =
        '<span class="ec-emoji">' + (p.alive ? "🟢" : "💀") + '</span>' +
        '<span class="ec-name">' + esc(p.name) + '</span>' +
        '<span class="ec-role">' + (info ? info.emoji + " " + info.name : "") + '</span>';
      box.appendChild(div);
    });
  }

  console.log("✅ جاهز");
};