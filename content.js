// ─────────────────────────────────────────────────────────────────────────────
// Aegis v2 — Content Script
// Bootstraps: overlayUI, clipboard/keyboard monitors, fullscreen, camera/voice
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__AEGIS_LOADED__) return;
  window.__AEGIS_LOADED__ = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let examActive        = false;
  let overlayPanel      = null;
  let cameraPreview     = null;
  let warningBanner     = null;
  let warnTimeout       = null;
  let elapsedInterval   = null;
  let examStart         = null;
  let currentScore      = 100;
  let currentViolations = 0;
  let recentEvents      = [];

  // Camera / voice state
  let mediaStream       = null;
  let audioCtx          = null;
  let analyser          = null;
  let speechTimer       = null;
  let faceCheckTimer    = null;
  let faceCanvas        = null;
  let faceAbsenceStart  = null;
  let lastFacePresent   = true;

  // Cooldown registry
  const cooldowns = {};

  // ── Boot ───────────────────────────────────────────────────────────────────
  chrome.storage.local.get('examSession', ({ examSession }) => {
    if (examSession && examSession.active) {
      examActive = true;
      injectStyles();
      attachBehaviourMonitors();
      showOverlayPanel();
    }
  });

  // ── Background message listener ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'EXAM_STARTED':
        examActive = true;
        currentScore      = 100;
        currentViolations = 0;
        recentEvents      = [];
        examStart         = Date.now();
        injectStyles();
        attachBehaviourMonitors();
        showDisclaimerModal();
        break;

      case 'EXAM_ENDED':
        examActive = false;
        teardown();
        break;

      case 'SCORE_UPDATED':
        currentScore      = msg.payload.score;
        currentViolations = msg.payload.violations ?? currentViolations;
        updateOverlayScore();
        break;

      case 'SHOW_WARNING':
        showWarningBanner(msg.payload.message);
        break;

      case 'PUSH_EVENT':
        pushEventToOverlay(msg.payload);
        break;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCLAIMER MODAL
  // ═══════════════════════════════════════════════════════════════════════════
  function showDisclaimerModal() {
    const existing = document.getElementById('__aegis_disclaimer__');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = '__aegis_disclaimer__';
    modal.innerHTML = `
      <div class="aeg-modal-backdrop">
        <div class="aeg-modal">
          <div class="aeg-modal-header">
            <div class="aeg-modal-logo">⬡ AEGIS</div>
            <div class="aeg-modal-version">v2.0 Enterprise</div>
          </div>
          <h2 class="aeg-modal-title">Exam Monitoring Notice</h2>
          <p class="aeg-modal-intro">
            This exam session is protected by Aegis. The following systems are active:
          </p>
          <div class="aeg-rules">
            <div class="aeg-rule"><span class="aeg-dot blue"></span><div><strong>Browser Activity</strong><p>Tab switches, copy/paste, keyboard shortcuts and page refreshes are logged.</p></div></div>
            <div class="aeg-rule"><span class="aeg-dot green"></span><div><strong>Fullscreen Required</strong><p>You must remain in fullscreen. Exiting will be logged as a violation.</p></div></div>
            <div class="aeg-rule"><span class="aeg-dot amber"></span><div><strong>Camera Required</strong><p>Your webcam must remain active. Face absence is monitored continuously.</p></div></div>
            <div class="aeg-rule"><span class="aeg-dot red"></span><div><strong>Microphone Required</strong><p>Sustained voice activity during the exam will reduce your integrity score.</p></div></div>
          </div>
          <button id="__aegis_start_btn__" class="aeg-start-btn">▶ &nbsp; Start Exam</button>
          <p class="aeg-consent">By starting, you agree to the monitoring terms above.</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('__aegis_start_btn__').addEventListener('click', () => {
      modal.remove();
      examStart = Date.now();
      startExamInPage();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // START EXAM IN PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  async function startExamInPage() {
    showOverlayPanel();
    startElapsedTimer();
    requestFullscreen();
    await startMediaMonitors();
    pushEventToOverlay({ eventType: 'EXAM_STARTED', ts: now() });
    showWarningBanner('Aegis Secure Mode Active — Monitoring Started', 'success');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY PANEL (top-right)
  // ═══════════════════════════════════════════════════════════════════════════
  function showOverlayPanel() {
    if (document.getElementById('__aegis_panel__')) return;

    overlayPanel = document.createElement('div');
    overlayPanel.id = '__aegis_panel__';
    overlayPanel.innerHTML = `
      <div class="aeg-panel-header">
        <span class="aeg-panel-logo">⬡</span>
        <span class="aeg-panel-title">AEGIS SECURE MODE</span>
        <span class="aeg-panel-pulse"></span>
      </div>
      <div class="aeg-score-row">
        <span class="aeg-score-label">Integrity Score</span>
        <span class="aeg-score-val" id="__aeg_score__">100</span>
      </div>
      <div class="aeg-status-list">
        <div class="aeg-status-row"><span class="aeg-s-dot" id="__aeg_dot_cam__"></span><span class="aeg-s-label">Camera</span><span class="aeg-s-state" id="__aeg_cam__">Initialising</span></div>
        <div class="aeg-status-row"><span class="aeg-s-dot" id="__aeg_dot_mic__"></span><span class="aeg-s-label">Microphone</span><span class="aeg-s-state" id="__aeg_mic__">Initialising</span></div>
        <div class="aeg-status-row"><span class="aeg-s-dot" id="__aeg_dot_fs__"></span><span class="aeg-s-label">Fullscreen</span><span class="aeg-s-state" id="__aeg_fs__">Checking</span></div>
      </div>
      <div class="aeg-violations-row">
        <span>Violations</span>
        <span class="aeg-viol-count" id="__aeg_viols__">0</span>
      </div>
      <div class="aeg-timeline-header">Recent Activity</div>
      <div class="aeg-timeline" id="__aeg_timeline__">
        <div class="aeg-tl-empty">Monitoring active...</div>
      </div>
      <div class="aeg-footer" id="__aeg_elapsed__">00:00</div>
    `;
    document.body.appendChild(overlayPanel);
  }

  function updateOverlayScore() {
    const el = document.getElementById('__aeg_score__');
    if (!el) return;
    el.textContent = currentScore;
    el.style.color = currentScore >= 75 ? '#22C55E' : currentScore >= 50 ? '#F59E0B' : '#EF4444';

    const viols = document.getElementById('__aeg_viols__');
    if (viols) viols.textContent = currentViolations;
  }

  function setOverlayStatus(type, text, state) {
    // state: 'ok' | 'warn' | 'error'
    const textEl = document.getElementById(`__aeg_${type}__`);
    const dotEl  = document.getElementById(`__aeg_dot_${type}__`);
    if (textEl) textEl.textContent = text;
    if (dotEl) {
      dotEl.className = 'aeg-s-dot';
      dotEl.classList.add(`aeg-dot-${state}`);
    }
  }

  function pushEventToOverlay({ eventType, ts }) {
    const tl = document.getElementById('__aeg_timeline__');
    if (!tl) return;

    const empty = tl.querySelector('.aeg-tl-empty');
    if (empty) empty.remove();

    recentEvents.unshift({ eventType, ts });
    if (recentEvents.length > 8) recentEvents.pop();

    tl.innerHTML = recentEvents.map(e => `
      <div class="aeg-tl-row">
        <span class="aeg-tl-time">${e.ts}</span>
        <span class="aeg-tl-event">${e.eventType.replace(/_/g,' ')}</span>
      </div>
    `).join('');
  }

  function startElapsedTimer() {
    if (elapsedInterval) clearInterval(elapsedInterval);
    elapsedInterval = setInterval(() => {
      if (!examStart) return;
      const s = Math.floor((Date.now() - examStart) / 1000);
      const el = document.getElementById('__aeg_elapsed__');
      if (el) el.textContent = `${pad(Math.floor(s/60))}:${pad(s%60)}`;
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FLOATING CAMERA PREVIEW (top-left)
  // ═══════════════════════════════════════════════════════════════════════════
  function showCameraPreview(stream) {
    if (document.getElementById('__aegis_cam_preview__')) return;

    cameraPreview = document.createElement('div');
    cameraPreview.id = '__aegis_cam_preview__';
    cameraPreview.innerHTML = `
      <div class="aeg-cam-badge">◉ LIVE</div>
      <video id="__aeg_video__" autoplay muted playsinline></video>
      <canvas id="__aeg_canvas__" style="display:none;width:160px;height:120px;"></canvas>
      <div class="aeg-cam-label" id="__aeg_face_label__">Detecting...</div>
    `;
    document.body.appendChild(cameraPreview);

    const video = document.getElementById('__aeg_video__');
    video.srcObject = stream;
    video.play().catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BEHAVIOUR MONITORS (keyboard / clipboard / visibility)
  // ═══════════════════════════════════════════════════════════════════════════
  const handlers = {};

  function attachBehaviourMonitors() {
    handlers.copy        = () => violation('COPY_ATTEMPT');
    handlers.paste       = () => violation('PASTE_ATTEMPT');
    handlers.cut         = () => violation('COPY_ATTEMPT');
    handlers.contextmenu = (e) => { e.preventDefault(); violation('RIGHT_CLICK'); };
    handlers.keydown     = handleKeydown;
    handlers.blur        = () => { if (!cooldown('WINDOW_BLUR', 5000)) violation('WINDOW_BLUR'); };
    handlers.visibility  = () => { if (document.hidden) violation('TAB_SWITCH'); };
    handlers.beforeunload= (e) => { violation('PAGE_REFRESH'); e.preventDefault(); e.returnValue=''; return e.returnValue; };
    handlers.fullscreen  = handleFullscreenChange;
    handlers.beforeprint = () => violation('KEYBOARD_SHORTCUT');

    document.addEventListener('copy',             handlers.copy);
    document.addEventListener('paste',            handlers.paste);
    document.addEventListener('cut',              handlers.cut);
    document.addEventListener('contextmenu',      handlers.contextmenu);
    document.addEventListener('keydown',          handlers.keydown);
    document.addEventListener('visibilitychange', handlers.visibility);
    document.addEventListener('fullscreenchange', handlers.fullscreen);
    window.addEventListener('blur',               handlers.blur);
    window.addEventListener('beforeunload',       handlers.beforeunload);
    window.addEventListener('beforeprint',        handlers.beforeprint);
  }

  function detachBehaviourMonitors() {
    document.removeEventListener('copy',             handlers.copy);
    document.removeEventListener('paste',            handlers.paste);
    document.removeEventListener('cut',              handlers.cut);
    document.removeEventListener('contextmenu',      handlers.contextmenu);
    document.removeEventListener('keydown',          handlers.keydown);
    document.removeEventListener('visibilitychange', handlers.visibility);
    document.removeEventListener('fullscreenchange', handlers.fullscreen);
    window.removeEventListener('blur',               handlers.blur);
    window.removeEventListener('beforeunload',       handlers.beforeunload);
    window.removeEventListener('beforeprint',        handlers.beforeprint);
  }

  function handleKeydown(e) {
    if (!examActive) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const bad  = ctrl && ['c','v','x','a','p','f','u','s'].includes(e.key.toLowerCase());
    const devt = e.key === 'F12' || (ctrl && e.shiftKey && e.key === 'I') || (ctrl && e.shiftKey && e.key === 'J');
    if (bad || devt) { e.preventDefault(); violation('KEYBOARD_SHORTCUT', { key: e.key }); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FULLSCREEN MONITOR
  // ═══════════════════════════════════════════════════════════════════════════
  function requestFullscreen() {
    document.documentElement.requestFullscreen().then(() => {
      setOverlayStatus('fs', 'Active', 'ok');
    }).catch(() => {
      setOverlayStatus('fs', 'Denied', 'warn');
      showWarningBanner('Fullscreen mode could not be activated. Please allow it.');
    });
  }

  function handleFullscreenChange() {
    if (!examActive) return;
    if (!document.fullscreenElement) {
      violation('EXIT_FULLSCREEN');
      setOverlayStatus('fs', 'Exited', 'error');
      showWarningBanner('⚠ Fullscreen exited. Attempting to restore...');
      // Attempt to restore after short delay
      setTimeout(() => {
        document.documentElement.requestFullscreen().then(() => {
          setOverlayStatus('fs', 'Restored', 'ok');
        }).catch(() => {});
      }, 800);
    } else {
      setOverlayStatus('fs', 'Active', 'ok');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA + VOICE MONITORS
  // ═══════════════════════════════════════════════════════════════════════════
  async function startMediaMonitors() {
    await startCamera();
    await startVoice();
  }

  async function startCamera() {
    // getUserMedia requires HTTPS or localhost
    if (!window.isSecureContext) {
      setOverlayStatus('cam', 'HTTPS needed', 'warn');
      // Notify popup to handle camera instead
      chrome.runtime.sendMessage({ type: 'LOG_EVENT', payload: { eventType: 'CAMERA_INSECURE_CONTEXT', metadata: {} } });
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setOverlayStatus('cam', 'API unavailable', 'error');
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });

      showCameraPreview(mediaStream);
      setOverlayStatus('cam', 'Active', 'ok');

      // Wait for canplay — video has actual renderable frames
      const video = document.getElementById('__aeg_video__');
      await new Promise(resolve => {
        if (video.readyState >= 2) { resolve(); return; }
        video.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 3000);
      });

      // Set canvas BUFFER dimensions (not CSS — they are different)
      faceCanvas = document.getElementById('__aeg_canvas__');
      faceCanvas.width  = 160;
      faceCanvas.height = 120;

      await new Promise(r => setTimeout(r, 400)); // let first frame render

      faceCheckTimer = setInterval(runFaceCheck, 2000);

    } catch (err) {
      setOverlayStatus('cam', 'Denied', 'error');
      violation('CAMERA_DISABLED', { reason: err.message });
      showWarningBanner('Camera access denied — please grant camera permission in the browser bar.');
    }
  }

  async function startVoice() {
    try {
      const voiceStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false }, video:false });
      audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
      analyser  = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      audioCtx.createMediaStreamSource(voiceStream).connect(analyser);

      setOverlayStatus('mic', 'Listening', 'ok');
      runVoiceMonitor(voiceStream);
    } catch (err) {
      setOverlayStatus('mic', 'Denied', 'error');
      violation('MIC_DISABLED', { reason: err.message });
      showWarningBanner('Microphone access denied — please grant permission.');
    }
  }

  function runFaceCheck() {
    if (!examActive || !mediaStream || !faceCanvas) return;

    const video = document.getElementById('__aeg_video__');
    // FIX: videoWidth > 0 is the reliable "video is rendering" check
    if (!video || video.videoWidth === 0 || video.paused || video.ended) return;

    try {
      const ctx = faceCanvas.getContext('2d');
      ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
      ctx.drawImage(video, 0, 0, faceCanvas.width, faceCanvas.height);
      const imageData = ctx.getImageData(0, 0, faceCanvas.width, faceCanvas.height);

      const { personPresent, faceCount, avgBrightness } = analyseSkinPixels(imageData);

      // Skip dark/blank frames (camera still warming up or covered)
      if (avgBrightness < 8) return;

      const label = document.getElementById('__aeg_face_label__');

      if (personPresent) {
        faceAbsenceStart = null;
        lastFacePresent  = true;
        if (label) label.textContent = faceCount > 1 ? '⚠ Multiple faces' : '✓ Face detected';

        if (faceCount > 1 && !cooldown('MULTIPLE_FACES', 30000)) {
          violation('MULTIPLE_FACES', { count: faceCount });
          showWarningBanner('Multiple faces detected. Ensure you are alone.');
        }
      } else {
        if (lastFacePresent) { faceAbsenceStart = Date.now(); lastFacePresent = false; }
        if (label) label.textContent = '⚠ Face not detected';

        const absent = Date.now() - (faceAbsenceStart || Date.now());
        if (absent >= 5000 && !cooldown('FACE_NOT_DETECTED', 15000)) {
          violation('FACE_NOT_DETECTED', { durationMs: absent });
          showWarningBanner('Face not detected. Please look at the camera.');
        }
      }
    } catch (err) {
      console.warn('[Aegis FaceCheck]', err.message);
    }
  }

  function analyseSkinPixels(imageData) {
    const data = imageData.data;
    let skin = 0, brightness = 0;
    const total = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      brightness += (r + g + b) / 3;

      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);

      // Multi-rule: covers more ethnicities + lighting conditions
      const isSkin =
        // Kovac rule (light to medium skin)
        (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r-g) > 15 && r > g && r > b) ||
        // Darker skin tones
        (r > 220 && g > 210 && b > 170 && Math.abs(r-g) <= 15 && r > b && g > b) ||
        // Warm hue shortcut
        (r > 80 && g > 30 && b > 15 && r > g && (r - b) > 20);

      if (isSkin) skin++;
    }

    const skinRatio     = skin / total;
    const avgBrightness = brightness / total;

    return {
      personPresent: skinRatio > 0.025, // Was 0.04 — too strict
      faceCount:     skinRatio > 0.28 ? 2 : 1,
      avgBrightness,
      skinRatio
    };
  }

  // ── Voice detection ────────────────────────────────────────────────────────
  let speechStart      = null;
  let isSpeaking       = false;
  let silenceFrames    = 0;
  let voiceRafId       = null;
  const SPEECH_RMS_THRESH = 28;
  const SUSTAINED_MS      = 5000;

  function runVoiceMonitor(stream) {
    const buf = new Uint8Array(analyser.frequencyBinCount);

    function loop() {
      if (!examActive) return;
      analyser.getByteTimeDomainData(buf);
      const rms = calcRMS(buf);

      if (rms > SPEECH_RMS_THRESH) {
        silenceFrames = 0;
        if (!isSpeaking) { isSpeaking = true; speechStart = Date.now(); }
        const dur = Date.now() - speechStart;
        if (dur >= SUSTAINED_MS && !cooldown('VOICE_DETECTED', 20000)) {
          violation('VOICE_DETECTED', { durationMs: dur, rms: Math.round(rms) });
          showWarningBanner('Voice activity detected. Please remain silent.');
          speechStart = Date.now(); // reset
        }
      } else {
        silenceFrames++;
        if (silenceFrames > 20) { isSpeaking = false; speechStart = null; }
      }

      voiceRafId = requestAnimationFrame(() => setTimeout(loop, 150));
    }

    loop();
  }

  function calcRMS(data) {
    let s = 0;
    for (let i=0; i<data.length; i++) { const n=(data[i]/128)-1; s+=n*n; }
    return Math.sqrt(s/data.length)*100;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WARNING BANNER
  // ═══════════════════════════════════════════════════════════════════════════
  function showWarningBanner(msg, type = 'danger') {
    if (warningBanner) warningBanner.remove();

    warningBanner = document.createElement('div');
    warningBanner.className = `__aegis_warn__ __aegis_warn_${type}__`;
    warningBanner.textContent = msg;
    document.body.appendChild(warningBanner);

    if (warnTimeout) clearTimeout(warnTimeout);
    warnTimeout = setTimeout(() => { warningBanner && warningBanner.remove(); }, 4500);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VIOLATION HELPER
  // ═══════════════════════════════════════════════════════════════════════════
  function violation(type, metadata = {}) {
    if (!examActive) return;
    pushEventToOverlay({ eventType: type, ts: now() });
    chrome.runtime.sendMessage({ type: 'LOG_VIOLATION', payload: { eventType: type, metadata } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEARDOWN
  // ═══════════════════════════════════════════════════════════════════════════
  function teardown() {
    detachBehaviourMonitors();
    if (elapsedInterval) clearInterval(elapsedInterval);
    if (faceCheckTimer)  clearInterval(faceCheckTimer);
    if (voiceRafId)      cancelAnimationFrame(voiceRafId);
    if (audioCtx)        audioCtx.close().catch(()=>{});
    if (mediaStream)     mediaStream.getTracks().forEach(t=>t.stop());
    if (overlayPanel)  { overlayPanel.remove(); overlayPanel = null; }
    if (cameraPreview) { cameraPreview.remove(); cameraPreview = null; }
    document.exitFullscreen?.().catch(()=>{});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════════════════
  function injectStyles() {
    if (document.getElementById('__aegis_styles__')) return;
    const s = document.createElement('style');
    s.id = '__aegis_styles__';
    s.textContent = `
      /* ── Fonts ── */
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

      /* ── Modal ── */
      #__aegis_disclaimer__ { position:fixed;inset:0;z-index:2147483647;font-family:'Space Grotesk',system-ui,sans-serif; }
      .aeg-modal-backdrop { position:absolute;inset:0;background:rgba(9,14,28,0.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center; }
      .aeg-modal { background:#1E293B;border:1px solid rgba(37,99,235,0.3);border-radius:16px;padding:30px 28px 24px;width:420px;max-width:94vw;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 40px rgba(37,99,235,0.1); }
      .aeg-modal-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:18px; }
      .aeg-modal-logo { font-family:'JetBrains Mono',monospace;font-size:13px;color:#3B82F6;letter-spacing:.12em; }
      .aeg-modal-version { font-family:'JetBrains Mono',monospace;font-size:9px;color:#475569;background:#0F172A;padding:3px 8px;border-radius:4px; }
      .aeg-modal-title { font-size:22px;font-weight:700;color:#F1F5F9;margin-bottom:10px; }
      .aeg-modal-intro { font-size:12.5px;color:#94A3B8;line-height:1.6;margin-bottom:18px; }
      .aeg-rules { display:flex;flex-direction:column;gap:10px;margin-bottom:22px; }
      .aeg-rule { display:flex;gap:12px;align-items:flex-start;background:#263348;border:1px solid rgba(148,163,184,.07);border-radius:10px;padding:11px 13px; }
      .aeg-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px; }
      .aeg-dot.blue  { background:#2563EB;box-shadow:0 0 8px #2563EB; }
      .aeg-dot.green { background:#22C55E;box-shadow:0 0 8px #22C55E; }
      .aeg-dot.amber { background:#F59E0B;box-shadow:0 0 8px #F59E0B; }
      .aeg-dot.red   { background:#EF4444;box-shadow:0 0 8px #EF4444; }
      .aeg-rule strong { display:block;font-size:12px;font-weight:600;color:#F1F5F9;margin-bottom:3px; }
      .aeg-rule p { font-size:11.5px;color:#94A3B8;line-height:1.5;margin:0; }
      .aeg-start-btn { width:100%;padding:14px;background:linear-gradient(135deg,#1D4ED8,#2563EB);border:none;border-radius:10px;color:#fff;font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:.03em;box-shadow:0 4px 24px rgba(37,99,235,.35);transition:all .2s;margin-bottom:10px; }
      .aeg-start-btn:hover { background:linear-gradient(135deg,#2563EB,#3B82F6);transform:translateY(-1px);box-shadow:0 8px 32px rgba(37,99,235,.5); }
      .aeg-consent { font-size:10px;color:#475569;text-align:center;line-height:1.5; }

      /* ── Overlay Panel ── */
      #__aegis_panel__ { position:fixed;top:16px;right:16px;z-index:2147483646;width:220px;background:#1E293B;border:1px solid rgba(37,99,235,.25);border-radius:14px;padding:0;font-family:'Space Grotesk',system-ui,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.5),0 0 20px rgba(37,99,235,.08);overflow:hidden; }
      .aeg-panel-header { display:flex;align-items:center;gap:8px;padding:10px 13px 9px;background:rgba(37,99,235,.08);border-bottom:1px solid rgba(37,99,235,.15); }
      .aeg-panel-logo { color:#3B82F6;font-size:14px; }
      .aeg-panel-title { font-family:'JetBrains Mono',monospace;font-size:10px;color:#3B82F6;letter-spacing:.1em;flex:1; }
      .aeg-panel-pulse { width:6px;height:6px;border-radius:50%;background:#22C55E;box-shadow:0 0 6px #22C55E;animation:aeg-pulse 2s infinite; }
      @keyframes aeg-pulse { 0%,100%{opacity:1}50%{opacity:.3} }
      .aeg-score-row { display:flex;align-items:center;justify-content:space-between;padding:10px 13px 8px; }
      .aeg-score-label { font-size:11px;color:#64748B; }
      .aeg-score-val { font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:500;color:#22C55E;transition:color .4s; }
      .aeg-status-list { padding:0 10px 8px;display:flex;flex-direction:column;gap:5px; }
      .aeg-status-row { display:flex;align-items:center;gap:7px;padding:5px 6px;background:rgba(15,23,42,.4);border-radius:6px; }
      .aeg-s-dot { width:7px;height:7px;border-radius:50%;background:#475569;transition:all .3s;flex-shrink:0; }
      .aeg-dot-ok    { background:#22C55E!important;box-shadow:0 0 6px #22C55E!important; }
      .aeg-dot-warn  { background:#F59E0B!important;box-shadow:0 0 6px #F59E0B!important; }
      .aeg-dot-error { background:#EF4444!important;box-shadow:0 0 6px #EF4444!important; }
      .aeg-s-label { font-size:11px;color:#94A3B8;flex:1; }
      .aeg-s-state { font-family:'JetBrains Mono',monospace;font-size:9px;color:#64748B; }
      .aeg-violations-row { display:flex;align-items:center;justify-content:space-between;padding:6px 13px;border-top:1px solid rgba(148,163,184,.06);border-bottom:1px solid rgba(148,163,184,.06); }
      .aeg-violations-row span:first-child { font-size:11px;color:#64748B; }
      .aeg-viol-count { font-family:'JetBrains Mono',monospace;font-size:14px;color:#EF4444; }
      .aeg-timeline-header { font-family:'JetBrains Mono',monospace;font-size:9px;color:#475569;letter-spacing:.08em;padding:7px 13px 4px;text-transform:uppercase; }
      .aeg-timeline { max-height:100px;overflow-y:auto;padding:0 10px 6px; }
      .aeg-timeline::-webkit-scrollbar { width:2px; }
      .aeg-timeline::-webkit-scrollbar-thumb { background:#2D3D55;border-radius:2px; }
      .aeg-tl-empty { font-size:10px;color:#334155;padding:8px 3px;text-align:center; }
      .aeg-tl-row { display:flex;gap:8px;padding:3px 0;border-bottom:1px solid rgba(148,163,184,.04); }
      .aeg-tl-time { font-family:'JetBrains Mono',monospace;font-size:9px;color:#475569;flex-shrink:0; }
      .aeg-tl-event { font-size:9.5px;color:#94A3B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .aeg-footer { font-family:'JetBrains Mono',monospace;font-size:9px;color:#334155;text-align:center;padding:6px;border-top:1px solid rgba(148,163,184,.05); }

      /* ── Camera preview ── */
      #__aegis_cam_preview__ { position:fixed;top:16px;left:16px;z-index:2147483645;width:160px;border:1px solid rgba(37,99,235,.3);border-radius:10px;overflow:hidden;background:#0F172A;box-shadow:0 4px 20px rgba(0,0,0,.5); }
      #__aegis_cam_preview__ video { width:160px;height:120px;object-fit:cover;display:block;transform:scaleX(-1); }
      .aeg-cam-badge { position:absolute;top:6px;left:6px;z-index:2;background:rgba(239,68,68,.9);color:#fff;font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border-radius:4px;letter-spacing:.06em; }
      .aeg-cam-label { font-family:'JetBrains Mono',monospace;font-size:9px;color:#94A3B8;text-align:center;padding:5px 8px;background:#1E293B; }

      /* ── Warning Banner ── */
      .__aegis_warn__ { position:fixed;top:58px;left:50%;transform:translateX(-50%);z-index:2147483644;padding:11px 22px;border-radius:10px;font-family:'Space Grotesk',system-ui,sans-serif;font-size:13px;font-weight:500;max-width:500px;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,.4);animation:aeg-slide-in .3s ease; }
      .__aegis_warn_danger__  { background:linear-gradient(135deg,#7C2D12,#DC2626);color:#FEF2F2;border:1px solid rgba(239,68,68,.4); }
      .__aegis_warn_success__ { background:linear-gradient(135deg,#14532D,#16A34A);color:#F0FDF4;border:1px solid rgba(34,197,94,.4); }
      @keyframes aeg-slide-in { from{opacity:0;transform:translateX(-50%) translateY(-8px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════════════════════
  function cooldown(key, ms) {
    if (cooldowns[key] && Date.now() - cooldowns[key] < ms) return true;
    cooldowns[key] = Date.now();
    return false;
  }

  function now() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function pad(n) { return String(n).padStart(2,'0'); }

})();
