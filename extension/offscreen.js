/**
 * Jarvis Browser Bridge — offscreen document: audio player + relay transport.
 *
 * Three jobs, one persistent context:
 *  1. Consent attention tones (reason: AUDIO_PLAYBACK) — MV3 service workers
 *     cannot reliably play audio. The tone is synthesized with WebAudio — no
 *     audio files, nothing to fetch. Distinct melodies per outcome:
 *     waiting (the original two-tone), grant (rising), deny (descending).
 *  2. The relay WebSocket lives here now. Chrome suspends the service worker
 *     aggressively and every suspension used to drop the socket (the #1
 *     outage cause: driver peer.unavailable / consent timeouts). This
 *     document is not suspended the same way, so the socket — and the
 *     driver's session — survives worker restarts.
 *  3. Tab audio capture: when the worker hands over a tabCapture stream
 *     id (obtained only after consent + the user-enabled tabCapture
 *     permission), this document records the tab's audio with
 *     MediaRecorder and forwards ~1s Opus chunks to the worker, which
 *     relays them to the driver. Audio is never stored here.
 *
 * TRANSPORT ONLY: this code pairs, forwards raw protocol strings both ways,
 * reconnects with backoff, queues sends while unpaired, and reports state.
 * It never interprets a proposal and can never approve, deny, or apply an
 * action — consent enforcement lives in the service worker, full stop.
 */
(function () {
  "use strict";

  var ctx = null;

  function ensureCtx(cb) {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (!ctx) { cb(null); return; }
      if (ctx.state === "suspended") {
        // Must wait for resume: notes scheduled on a suspended context
        // never sound. This was the v0.2.8 no-tone bug.
        ctx.resume().then(function () { cb(ctx); }, function () { cb(null); });
      } else {
        cb(ctx);
      }
    } catch (e) { cb(null); }
  }

  function tone(freq, startAt, dur) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Gentle envelope: quick attack, smooth decay — no clicks.
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.05);
  }

  function playChime(kind) {
    ensureCtx(function (ac) {
      if (!ac) {
        report("no-context");
        return;
      }
      try {
        var t = ac.currentTime;
        if (kind === "grant") {
          // Rising triad — decision made, approved.
          tone(523.25, t, 0.16);       // C5
          tone(659.25, t + 0.12, 0.16); // E5
          tone(783.99, t + 0.24, 0.3);  // G5
        } else if (kind === "deny") {
          // Descending — decision made, refused.
          tone(392, t, 0.2);           // G4
          tone(261.63, t + 0.18, 0.34); // C4
        } else {
          // "waiting" — the original soft attention interval.
          tone(880, t, 0.22);          // A5
          tone(659.25, t + 0.18, 0.3); // E5
        }
        report("played");
      } catch (e) {
        report("play-threw: " + String(e && e.message || e));
      }
    });
  }

  function report(status) {
    try { chrome.runtime.sendMessage({ kind: "jbb.offscreen.report", status: status }); }
    catch (e) { /* background gone */ }
  }

  // ------------------------------------------------------------ relay transport
  var rws = null, rUrl = "", rKey = "", rWanted = false, rPaired = false;
  var rBackoff = 1000, rTimer = null, sendQ = [];

  function reportState() {
    try {
      chrome.runtime.sendMessage({ kind: "jbb.relay.state",
        connected: !!(rws && rws.readyState === 1 && rPaired) });
    } catch (e) { /* worker gone — state is re-sent on its next wake */ }
  }

  function scheduleReconnect() {
    if (!rWanted || rTimer) return;
    var delay = rBackoff;
    rBackoff = Math.min(rBackoff * 2, 30000);
    rTimer = setTimeout(function () { rTimer = null; dial(); }, delay);
  }

  function dial() {
    if (!rWanted || !rUrl || !rKey) return;
    if (rws && (rws.readyState === 0 || rws.readyState === 1)) return;
    var ws;
    try { ws = new WebSocket(rUrl); } catch (e) { scheduleReconnect(); return; }
    rws = ws;
    ws.onopen = function () {
      rBackoff = 1000;
      // Protocol v1 pairing — byte-identical to what the service worker
      // used to send itself: { v: 1, type: 'pair.request', role, key }.
      // (protocol.js is not loaded in this document; keep this literal in
      // sync with JBB.Message.pairRequest.)
      try { ws.send(JSON.stringify({ v: 1, type: "pair.request", role: "extension", key: rKey })); }
      catch (e) { /* the close handler will retry */ }
    };
    ws.onmessage = function (ev) {
      var raw = String(ev.data);
      try { chrome.runtime.sendMessage({ kind: "jbb.relay.message", data: raw }); }
      catch (e) { /* worker gone */ }
      // The ONLY payload inspection in this document: pair.confirm marks
      // the moment queued sends may flush. Meaning is never read.
      if (!rPaired && raw.indexOf('"pair.confirm"') !== -1) {
        rPaired = true;
        var q = sendQ; sendQ = [];
        q.forEach(function (data) { try { ws.send(data); } catch (e) {} });
        reportState();
      }
    };
    ws.onclose = function () {
      if (rws === ws) rws = null;
      rPaired = false;
      reportState();
      scheduleReconnect();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function relayConnect(url, key) {
    if (url !== rUrl || key !== rKey) {
      rUrl = url; rKey = key;
      if (rws) { var old = rws; rws = null; rPaired = false; try { old.close(); } catch (e) {} }
    }
    rWanted = true;
    dial();
    reportState();
  }

  function relayDisconnect() {
    rWanted = false;
    if (rTimer) { clearTimeout(rTimer); rTimer = null; }
    if (rws) { var ws = rws; rws = null; rPaired = false; try { ws.close(); } catch (e) {} }
    sendQ = [];
    reportState();
  }

  function relaySend(data) {
    if (rws && rws.readyState === 1 && rPaired) {
      try { rws.send(data); return; } catch (e) { /* fall through to queue */ }
    }
    // Not paired yet (or socket down): queue for the pair.confirm flush.
    // Stale act proposals are safe to replay — the worker's gate dedupes
    // by act id.
    if (typeof data === "string" && sendQ.length < 50) sendQ.push(data);
  }

  setInterval(reportState, 15000);

  // ------------------------------------------------------------ tab audio capture
  var cap = null; // { recorder, stream, captureId, seq, mime }
  function b64encode(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function captureState(active, captureId, error) {
    try {
      var m = { kind: "jbb.capture.state", active: !!active, captureId: captureId };
      if (error) m.error = error;
      chrome.runtime.sendMessage(m);
    } catch (e) { /* background gone */ }
  }
  function stopTabCapture(notify) {
    if (!cap) return;
    var c = cap; cap = null;
    try { c.recorder.stop(); } catch (e) {}
    try { c.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    if (notify !== false) captureState(false, c.captureId);
  }
  function startTabCapture(streamId, captureId) {
    stopTabCapture(false);
    navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    }).then(function (stream) {
      var mime = "audio/webm;codecs=opus";
      if (typeof MediaRecorder === "function" && !MediaRecorder.isTypeSupported(mime)) mime = "audio/webm";
      var rec = new MediaRecorder(stream, { mimeType: mime });
      cap = { recorder: rec, stream: stream, captureId: captureId, seq: 0, mime: mime };
      rec.ondataavailable = function (e) {
        if (!e.data || !e.data.size || !cap) return;
        e.data.arrayBuffer().then(function (buf) {
          if (!cap) return;
          try {
            chrome.runtime.sendMessage({
              kind: "jbb.capture.chunk", captureId: captureId,
              seq: cap.seq++, mimeType: mime, data: b64encode(buf)
            });
          } catch (err) {}
        });
      };
      rec.onstop = function () { stopTabCapture(true); };
      stream.getAudioTracks().forEach(function (t) {
        t.onended = function () { stopTabCapture(true); };
      });
      rec.start(1000);
      captureState(true, captureId);
    }).catch(function (err) {
      captureState(false, captureId, String((err && err.message) || err));
    });
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.kind !== "string") return;
    if (msg.kind === "jbb.offscreen.playTone") {
      try { playChime(msg.tone); } catch (e) { report("listener-threw"); }
    } else if (msg.kind === "jbb.capture.start") {
      startTabCapture(msg.streamId, msg.captureId);
    } else if (msg.kind === "jbb.capture.stop") {
      stopTabCapture(true);
    } else if (msg.kind === "jbb.relay.connect") {
      relayConnect(msg.url, msg.key);
    } else if (msg.kind === "jbb.relay.disconnect") {
      relayDisconnect();
    } else if (msg.kind === "jbb.relay.send") {
      relaySend(msg.data);
    }
  });

  // Ready handshake: the createDocument callback fires before this script
  // runs — without this, the first playTone message is lost. (v0.2.10 no-tone bug)
  try { chrome.runtime.sendMessage({ kind: "jbb.offscreen.ready" }); }
  catch (e) { /* background gone */ }
  // Relay hello: after an offscreen restart the worker re-posts the desired
  // connection when it hears this, so transport self-heals.
  try { chrome.runtime.sendMessage({ kind: "jbb.relay.hello" }); }
  catch (e) { /* background gone */ }
})();
