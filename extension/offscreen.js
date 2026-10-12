/**
 * Jarvis Browser Bridge — offscreen audio player.
 *
 * MV3 service workers cannot reliably play audio, so consent attention tones
 * play here (reason: AUDIO_PLAYBACK). The tone is synthesized with WebAudio —
 * no audio files, nothing to fetch. Soft two-tone chime: noticeable across
 * the room, not an alarm.
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

  function playChime() {
    ensureCtx(function (ac) {
      if (!ac) {
        report("no-context");
        return;
      }
      try {
        var t = ac.currentTime;
        tone(880, t, 0.22);          // A5
        tone(659.25, t + 0.18, 0.3); // E5 — soft "attention" interval
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

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.kind === "jbb.offscreen.playTone") {
      try { playChime(); } catch (e) { report("listener-threw"); }
    }
  });

  // Ready handshake: the createDocument callback fires before this script
  // runs — without this, the first playTone message is lost. (v0.2.10 no-tone bug)
  try { chrome.runtime.sendMessage({ kind: "jbb.offscreen.ready" }); }
  catch (e) { /* background gone */ }
})();
