/* =====================================================================
   VOZ DE MIA — reemplazo de la voz del navegador por audio grabado (2026-11-12)

   El Echo Show no suena con la voz del navegador (speechSynthesis), aunque diga
   que la tiene. Este archivo se carga ANTES del juego y pone en su lugar un
   speechSynthesis propio que reproduce MP3 grabados con voz peruana:
     1. Si la frase exacta está grabada, suena esa grabación.
     2. Si no (frases con números o nombres que cambian), suena palabra por palabra.
   Los juegos no cambian su código de voz: siguen llamando a speak(), cancel(),
   onend, etc., y este archivo responde igual que el navegador.
   La tabla de grabaciones viene de manifiesto.js (generar_audio_juegos.py).
   ===================================================================== */
(function () {
  "use strict";
  var M = window.AUDIO_MIA_COMUN || { frases: {}, palabras: {} };
  var base = (document.currentScript && document.currentScript.src || "").replace(/[^\/]*$/, "");

  function clave(t) {
    return String(t || "").toLowerCase().normalize("NFC")
      .replace(/[^0-9a-záéíóúüñ\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function partes(texto) {
    var k = clave(texto);
    if (M.frases[k]) return [M.frases[k]];
    var sin = clave(String(texto).replace(/^\s*[^:\n]{1,24}:\s*/, ""));   // "Woody: hola" -> "hola"
    if (M.frases[sin]) return [M.frases[sin]];
    return sin.split(" ").map(function (w) { return M.palabras[w]; }).filter(Boolean);
  }

  var audio = new Audio(); audio.preload = "auto";
  ["play", "playing", "pause", "ended", "error", "stalled"].forEach(function (ev) {
    audio.addEventListener(ev, function () { if (window.__vozMiaDiag) registro.push({ texto: "audio:" + ev + " " + audio.currentTime.toFixed(1), audios: -2 }); });
  });
  /* Primer toque de Mia: el reproductor toca un silencio de un instante, así el navegador lo
     da por permitido. Solo se pausa si TODAVÍA está en el silencio (si el juego ya puso su
     audio, no se toca: antes eso cortaba la primera frase). */
  var SILENCIO = (function () {
    var n = 800, b = new Uint8Array(44 + n), d = new DataView(b.buffer);
    function s(o, t) { for (var i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); }
    s(0, "RIFF"); d.setUint32(4, 36 + n, true); s(8, "WAVEfmt "); d.setUint32(16, 16, true);
    d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 8000, true); d.setUint32(28, 8000, true);
    d.setUint16(32, 1, true); d.setUint16(34, 8, true); s(36, "data"); d.setUint32(40, n, true);
    for (var i = 44; i < 44 + n; i++) b[i] = 128;
    var txt = ""; for (var j = 0; j < b.length; j++) txt += String.fromCharCode(b[j]);
    return "data:audio/wav;base64," + btoa(txt);
  })();
  var desbloqueado = false;
  function desbloquear() {
    if (desbloqueado || actual) { desbloqueado = true; return; }
    desbloqueado = true;
    try {
      audio.src = SILENCIO; var p = audio.play();
      if (p && p.then) p.then(function () { if (audio.src === SILENCIO) audio.pause(); }, function () {});
    } catch (e) {}
  }
  ["pointerdown", "touchstart", "mousedown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, desbloquear, { capture: true, passive: true });
  });

  function disparar(u, tipo) {
    var ev; try { ev = new Event(tipo); } catch (e) { ev = { type: tipo }; }
    try { if (u.dispatchEvent) u.dispatchEvent(ev); } catch (e) {}
    try { if (typeof u["on" + tipo] === "function") u["on" + tipo](ev); } catch (e) {}
  }

  function Utterance(texto) {
    var t = (typeof EventTarget === "function") ? new EventTarget() : document.createElement("span");
    t.text = texto || ""; t.lang = "es-PE"; t.voice = null; t.rate = 1; t.pitch = 1; t.volume = 1;
    t.onstart = t.onend = t.onerror = t.onpause = t.onresume = t.onboundary = t.onmark = null;
    return t;
  }

  var cola = [], actual = null, trozos = [], vigia = null, registro = [], turno = 0;
  var sintesis = {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    getVoices: function () { return [VOZ]; },
    speak: function (u) { cola.push(u); this.pending = cola.length > 0; if (!actual) siguiente(); },
    cancel: function () {
      var u = actual; cola = []; trozos = []; actual = null; turno++;
      if (u) registro.push({ texto: "cancelado por el juego", audios: -1 });
      try { audio.pause(); } catch (e) {}
      clearTimeout(vigia); this.speaking = false; this.pending = false;
      if (u) disparar(u, "end");
    },
    pause: function () { try { audio.pause(); } catch (e) {} this.paused = true; },
    resume: function () { try { audio.play(); } catch (e) {} this.paused = false; },
    addEventListener: function () {}, removeEventListener: function () {}
  };
  var VOZ = { name: "Camila (grabada)", lang: "es-PE", voiceURI: "camila-grabada", localService: true, default: true };

  function terminar(u) {
    clearTimeout(vigia);
    if (u !== actual) return;
    actual = null; sintesis.speaking = false;
    disparar(u, "end");
    siguiente();
  }
  function siguiente() {
    if (actual || !cola.length) { sintesis.pending = cola.length > 0; return; }
    var u = cola.shift(); actual = u; sintesis.pending = cola.length > 0; sintesis.speaking = true;
    trozos = partes(u.text);
    registro.push({ texto: String(u.text).slice(0, 80), audios: trozos.length });
    disparar(u, "start");
    tocar(u);
  }
  function tocar(u) {
    if (u !== actual) return;
    if (!trozos.length) { setTimeout(function () { terminar(u); }, 150); return; }
    var archivo = trozos.shift();
    var hecho = false, mio = ++turno;
    /* Solo el audio vigente avanza la cola: un aviso tardío de un audio ya cortado se ignora. */
    function listo() { if (hecho || mio !== turno) return; hecho = true; audio.onended = audio.onerror = null; tocar(u); }
    audio.onended = listo; audio.onerror = listo;
    clearTimeout(vigia); vigia = setTimeout(listo, 15000);   // red de seguridad
    try {
      audio.src = base + archivo;
      var p = audio.play();
      if (p && p.catch) p.catch(function (e) { registro.push({ texto: "no sonó: " + (e && e.name), audios: -1 }); setTimeout(listo, 400); });   // sin toque previo: sigue el juego
    } catch (e) { setTimeout(listo, 400); }
  }

  try { Object.defineProperty(window, "speechSynthesis", { value: sintesis, configurable: true, writable: true }); } catch (e) {}
  try { Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true, writable: true }); } catch (e) {}
  setTimeout(function () { if (typeof sintesis.onvoiceschanged === "function") sintesis.onvoiceschanged({}); }, 0);
  window.__vozMia = { sintesis: sintesis, audio: audio, partes: partes, registro: registro };
})();
