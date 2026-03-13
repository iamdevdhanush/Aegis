// ─────────────────────────────────────────────────────────────────────────────
// AGS v3 — Content Script
// Bootstraps all monitors: camera (fixed NMS), sentinel, clipboard, fullscreen
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';
  if (window.__AGS_LOADED__) return;
  window.__AGS_LOADED__ = true;

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
  let currentCheatProb  = 0;
  let recentEvents      = [];

  let mediaStream       = null;
  let audioCtx          = null;
  let analyser          = null;
  let faceCheckTimer    = null;
  let faceCanvas        = null;
  let faceAbsenceStart  = null;
  let lastFacePresent   = true;

  // Face detection state (temporal tracking)
  let faceHistory       = [];
  let faceCountHistory  = [];
  let prevRegions       = [];
  const HISTORY_SIZE    = 5;

  const cooldowns = {};

  // Sentinel state
  let focusLossHistory  = [];
  let devtoolsTimer     = null;

  // Mouse tracking
  let lastMouseX = 0, lastMouseY = 0, lastMouseTime = Date.now();
  let typingKeys = 0, typingWindow = 0;

  // ── Boot ───────────────────────────────────────────────────────────────────
  chrome.storage.local.get('examSession', ({ examSession }) => {
    if (examSession?.active) {
      examActive = true;
      injectStyles();
      attachBehaviourMonitors();
      attachSentinelMonitors();
      showOverlayPanel();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'EXAM_STARTED':
        examActive = true;
        currentScore = 100; currentViolations = 0; recentEvents = [];
        examStart = Date.now();
        injectStyles();
        attachBehaviourMonitors();
        attachSentinelMonitors();
        showDisclaimerModal();
        break;

      case 'EXAM_ENDED':
        examActive = false;
        teardown();
        break;

      case 'SCORE_UPDATED':
        currentScore      = msg.payload.score;
        currentViolations = msg.payload.violations ?? currentViolations;
        currentCheatProb  = msg.payload.cheatingProbability ?? 0;
        updateOverlayScore();
        break;

      case 'AI_SCORES_UPDATED':
        currentCheatProb = msg.payload.cheatingProbability ?? 0;
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

  // ─────────────────────────────────────────────────────────────────────────
  // DISCLAIMER MODAL
  // ─────────────────────────────────────────────────────────────────────────
  function showDisclaimerModal() {
    const existing = document.getElementById('__ags_disclaimer__');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = '__ags_disclaimer__';
    modal.innerHTML = `
      <div class="ags-modal-backdrop">
        <div class="ags-modal">
          <div class="ags-modal-header">
            <div class="ags-modal-logo">◈ AGS</div>
            <div class="ags-modal-version">v3.0 AI-Powered</div>
          </div>
          <h2 class="ags-modal-title">Exam Monitoring Active</h2>
          <p class="ags-modal-intro">AI-powered integrity monitoring is now active for this session.</p>
          <div class="ags-rules">
            <div class="ags-rule"><span class="ags-dot blue"></span><div><strong>AI Behavior Analysis</strong><p>Your interaction patterns are analyzed in real-time for anomaly detection.</p></div></div>
            <div class="ags-rule"><span class="ags-dot green"></span><div><strong>Fullscreen Required</strong><p>You must remain in fullscreen. Exiting triggers a violation.</p></div></div>
            <div class="ags-rule"><span class="ags-dot amber"></span><div><strong>Camera + Face Detection</strong><p>Face presence verified continuously with spatial NMS detection.</p></div></div>
            <div class="ags-rule"><span class="ags-dot red"></span><div><strong>Screen & DevTools Monitoring</strong><p>Screen capture attempts and DevTools access are detected and logged.</p></div></div>
          </div>
          <button id="__ags_start_btn__" class="ags-start-btn">▶ &nbsp; Begin Exam</button>
          <p class="ags-consent">By starting, you consent to AI-powered monitoring.</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('__ags_start_btn__').addEventListener('click', () => {
      modal.remove();
      examStart = Date.now();
      startExamInPage();
    });
  }

  async function startExamInPage() {
    showOverlayPanel();
    startElapsedTimer();
    requestFullscreen();
    await startMediaMonitors();
    pushEventToOverlay({ eventType: 'EXAM_STARTED', ts: now() });
    showWarningBanner('AGS Secure Mode Active — AI Monitoring Started', 'success');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OVERLAY PANEL
  // ─────────────────────────────────────────────────────────────────────────
  function showOverlayPanel() {
    if (document.getElementById('__ags_panel__')) return;
    overlayPanel = document.createElement('div');
    overlayPanel.id = '__ags_panel__';
    overlayPanel.innerHTML = `
      <div class="ags-panel-header">
        <span class="ags-panel-logo">◈</span>
        <span class="ags-panel-title">AGS SECURE</span>
        <span class="ags-panel-pulse"></span>
      </div>
      <div class="ags-score-row">
        <span class="ags-score-label">Integrity</span>
        <span class="ags-score-val" id="__ags_score__">100</span>
      </div>
      <div class="ags-ai-row">
        <span class="ags-ai-label">Cheat Prob.</span>
        <span class="ags-ai-val" id="__ags_cheat__">0%</span>
      </div>
      <div class="ags-status-list">
        <div class="ags-status-row"><span class="ags-s-dot" id="__ags_dot_cam__"></span><span class="ags-s-label">Camera</span><span class="ags-s-state" id="__ags_cam__">Init</span></div>
        <div class="ags-status-row"><span class="ags-s-dot" id="__ags_dot_mic__"></span><span class="ags-s-label">Mic</span><span class="ags-s-state" id="__ags_mic__">Init</span></div>
        <div class="ags-status-row"><span class="ags-s-dot" id="__ags_dot_fs__"></span><span class="ags-s-label">Fullscreen</span><span class="ags-s-state" id="__ags_fs__">Check</span></div>
      </div>
      <div class="ags-violations-row"><span>Violations</span><span class="ags-viol-count" id="__ags_viols__">0</span></div>
      <div class="ags-timeline-header">RECENT EVENTS</div>
      <div class="ags-timeline" id="__ags_timeline__"><div class="ags-tl-empty">Monitoring...</div></div>
      <div class="ags-footer" id="__ags_elapsed__">00:00</div>
    `;
    document.body.appendChild(overlayPanel);
  }

  function updateOverlayScore() {
    const el = document.getElementById('__ags_score__');
    if (el) {
      el.textContent = currentScore;
      el.style.color = currentScore >= 75 ? '#00FF88' : currentScore >= 50 ? '#FFB800' : '#FF4444';
    }
    const viols = document.getElementById('__ags_viols__');
    if (viols) viols.textContent = currentViolations;
    const cheat = document.getElementById('__ags_cheat__');
    if (cheat) {
      cheat.textContent = currentCheatProb + '%';
      cheat.style.color = currentCheatProb > 60 ? '#FF4444' : currentCheatProb > 30 ? '#FFB800' : '#00FF88';
    }
  }

  function setOverlayStatus(type, text, state) {
    const textEl = document.getElementById(`__ags_${type}__`);
    const dotEl  = document.getElementById(`__ags_dot_${type}__`);
    if (textEl) textEl.textContent = text;
    if (dotEl) {
      dotEl.className = 'ags-s-dot';
      dotEl.classList.add(`ags-dot-${state}`);
    }
  }

  function pushEventToOverlay({ eventType, ts }) {
    const tl = document.getElementById('__ags_timeline__');
    if (!tl) return;
    const empty = tl.querySelector('.ags-tl-empty');
    if (empty) empty.remove();
    recentEvents.unshift({ eventType, ts });
    if (recentEvents.length > 8) recentEvents.pop();
    tl.innerHTML = recentEvents.map(e => `
      <div class="ags-tl-row">
        <span class="ags-tl-time">${e.ts}</span>
        <span class="ags-tl-event">${e.eventType.replace(/_/g,' ')}</span>
      </div>
    `).join('');
  }

  function startElapsedTimer() {
    if (elapsedInterval) clearInterval(elapsedInterval);
    elapsedInterval = setInterval(() => {
      if (!examStart) return;
      const s = Math.floor((Date.now() - examStart) / 1000);
      const el = document.getElementById('__ags_elapsed__');
      if (el) el.textContent = `${pad(Math.floor(s/60))}:${pad(s%60)}`;
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FLOATING CAMERA PREVIEW
  // ─────────────────────────────────────────────────────────────────────────
  function showCameraPreview(stream) {
    if (document.getElementById('__ags_cam_preview__')) return;
    cameraPreview = document.createElement('div');
    cameraPreview.id = '__ags_cam_preview__';
    cameraPreview.innerHTML = `
      <div class="ags-cam-badge">◉ LIVE</div>
      <video id="__ags_video__" autoplay muted playsinline></video>
      <canvas id="__ags_canvas__" style="display:none;width:160px;height:120px;"></canvas>
      <div class="ags-cam-label" id="__ags_face_label__">Detecting...</div>
    `;
    document.body.appendChild(cameraPreview);
    const video = document.getElementById('__ags_video__');
    video.srcObject = stream;
    video.play().catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BEHAVIOUR MONITORS
  // ─────────────────────────────────────────────────────────────────────────
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
    handlers.mousemove   = handleMouseMove;
    handlers.keyup       = handleTyping;

    document.addEventListener('copy',             handlers.copy);
    document.addEventListener('paste',            handlers.paste);
    document.addEventListener('cut',              handlers.cut);
    document.addEventListener('contextmenu',      handlers.contextmenu);
    document.addEventListener('keydown',          handlers.keydown);
    document.addEventListener('keyup',            handlers.keyup);
    document.addEventListener('visibilitychange', handlers.visibility);
    document.addEventListener('fullscreenchange', handlers.fullscreen);
    document.addEventListener('mousemove',        handlers.mousemove);
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
    document.removeEventListener('keyup',            handlers.keyup);
    document.removeEventListener('visibilitychange', handlers.visibility);
    document.removeEventListener('fullscreenchange', handlers.fullscreen);
    document.removeEventListener('mousemove',        handlers.mousemove);
    window.removeEventListener('blur',               handlers.blur);
    window.removeEventListener('beforeunload',       handlers.beforeunload);
    window.removeEventListener('beforeprint',        handlers.beforeprint);
  }

  function handleKeydown(e) {
    if (!examActive) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const bad  = ctrl && ['c','v','x','a','p','f','u','s'].includes(e.key.toLowerCase());
    const devt = e.key === 'F12' || (ctrl && e.shiftKey && ['i','j','k'].includes(e.key.toLowerCase()));
    if (bad || devt) {
      e.preventDefault();
      violation(devt ? 'DEVTOOLS_OPEN' : 'KEYBOARD_SHORTCUT', { key: e.key });
    }
  }

  function handleMouseMove(e) {
    if (!examActive) return;
    const now = Date.now();
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    const dt = now - lastMouseTime;
    if (dt > 0) {
      const velocity = Math.sqrt(dx*dx + dy*dy) / dt * 100;
      chrome.runtime.sendMessage({ type: 'MOUSE_ACTIVITY', payload: { velocity, x: e.clientX, y: e.clientY } }).catch(() => {});
    }
    lastMouseX = e.clientX; lastMouseY = e.clientY; lastMouseTime = now;
  }

  function handleTyping() {
    if (!examActive) return;
    chrome.runtime.sendMessage({ type: 'TYPING_ACTIVITY', payload: { ts: Date.now() } }).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SENTINEL MONITORS
  // ─────────────────────────────────────────────────────────────────────────
  function attachSentinelMonitors() {
    // Screen capture detection via getDisplayMedia hook
    if (navigator.mediaDevices?.getDisplayMedia) {
      const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async (...args) => {
        violation('SCREEN_CAPTURE_ATTEMPT', { method: 'getDisplayMedia' });
        return orig(...args);
      };
    }

    // DevTools size heuristic
    devtoolsTimer = setInterval(() => {
      if (!examActive) return;
      const diff = window.outerWidth - window.innerWidth;
      const diffH = window.outerHeight - window.innerHeight;
      if ((diff > 160 || diffH > 160) && !cooldown('DEVTOOLS_OPEN', 30000)) {
        violation('DEVTOOLS_OPEN', { method: 'size_heuristic', diff });
      }
    }, 2000);

    // Focus loss pattern detection
    window.addEventListener('blur', () => {
      focusLossHistory.push(Date.now());
      if (focusLossHistory.length > 50) focusLossHistory.shift();
      const recent = focusLossHistory.filter(t => Date.now() - t < 10000);
      if (recent.length >= 4 && !cooldown('SCREEN_CAPTURE_PATTERN', 30000)) {
        violation('SCREEN_CAPTURE_ATTEMPT', { method: 'focus_pattern', count: recent.length });
      }
    });

    // Overlay extension detection
    const observer = new MutationObserver(mutations => {
      if (!examActive) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const id = node.id || '';
          if (id.startsWith('__ags') || id.startsWith('__aegis')) continue;
          const style = node.getAttribute?.('style') || '';
          if ((style.includes('position: fixed') || style.includes('z-index: 2147483647'))
              && !cooldown('OVERLAY_EXTENSION', 30000)) {
            violation('OVERLAY_EXTENSION_DETECTED', { elementId: id.substr(0,50) });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: false });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FULLSCREEN MONITOR
  // ─────────────────────────────────────────────────────────────────────────
  function requestFullscreen() {
    document.documentElement.requestFullscreen().then(() => {
      setOverlayStatus('fs', 'Active', 'ok');
    }).catch(() => {
      setOverlayStatus('fs', 'Denied', 'warn');
    });
  }

  function handleFullscreenChange() {
    if (!examActive) return;
    if (!document.fullscreenElement) {
      violation('EXIT_FULLSCREEN');
      setOverlayStatus('fs', 'Exited', 'error');
      showWarningBanner('⚠ Fullscreen exited. Restoring...');
      setTimeout(() => {
        document.documentElement.requestFullscreen()
          .then(() => setOverlayStatus('fs', 'Restored', 'ok'))
          .catch(() => {});
      }, 800);
    } else {
      setOverlayStatus('fs', 'Active', 'ok');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CAMERA + FACE DETECTION (with NMS + temporal smoothing)
  // ─────────────────────────────────────────────────────────────────────────
  async function startMediaMonitors() {
    await startCamera();
    await startVoice();
  }

  async function startCamera() {
    if (!window.isSecureContext) { setOverlayStatus('cam', 'HTTPS needed', 'warn'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setOverlayStatus('cam', 'Unavailable', 'error'); return; }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      showCameraPreview(mediaStream);
      setOverlayStatus('cam', 'Active', 'ok');

      const video = document.getElementById('__ags_video__');
      await new Promise(resolve => {
        if (video.readyState >= 2) { resolve(); return; }
        video.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 3000);
      });

      faceCanvas = document.getElementById('__ags_canvas__');
      faceCanvas.width  = 160;
      faceCanvas.height = 120;

      await new Promise(r => setTimeout(r, 600));
      faceCheckTimer = setInterval(runFaceCheck, 1500);

    } catch (err) {
      setOverlayStatus('cam', 'Denied', 'error');
      violation('CAMERA_DISABLED', { reason: err.message });
    }
  }

  function runFaceCheck() {
    if (!examActive || !mediaStream || !faceCanvas) return;
    const video = document.getElementById('__ags_video__');
    if (!video || video.videoWidth === 0 || video.paused || video.ended) return;

    try {
      const ctx = faceCanvas.getContext('2d');
      ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
      ctx.drawImage(video, 0, 0, faceCanvas.width, faceCanvas.height);
      const imageData = ctx.getImageData(0, 0, faceCanvas.width, faceCanvas.height);

      const brightness = avgBrightness(imageData);
      if (brightness < 8) return;

      // Spatial face detection with NMS
      const regions   = findSkinRegions(imageData);
      const faceCount = applyNMS(regions);
      const present   = faceCount > 0;

      // Temporal smoothing
      faceHistory.push({ present, faceCount });
      if (faceHistory.length > HISTORY_SIZE) faceHistory.shift();
      faceCountHistory.push(faceCount);
      if (faceCountHistory.length > HISTORY_SIZE) faceCountHistory.shift();

      const presentFrames = faceHistory.filter(f => f.present).length;
      const stablePresent = (presentFrames / faceHistory.length) >= 0.6;
      const multiFrames   = faceCountHistory.filter(c => c > 1).length;
      const stableMulti   = multiFrames >= Math.ceil(HISTORY_SIZE * 0.6);

      const label = document.getElementById('__ags_face_label__');

      if (stablePresent) {
        faceAbsenceStart = null;
        lastFacePresent  = true;

        if (stableMulti && !cooldown('MULTIPLE_FACE_DETECTED', 30000)) {
          if (label) label.textContent = '⚠ Multiple faces';
          violation('MULTIPLE_FACE_DETECTED', { count: faceCount });
          showWarningBanner('Multiple faces detected. Ensure you are alone.');
        } else {
          if (label) label.textContent = '✓ Face detected';
        }
      } else {
        if (lastFacePresent) { faceAbsenceStart = Date.now(); lastFacePresent = false; }
        if (label) label.textContent = '⚠ Face absent';
        const absent = Date.now() - (faceAbsenceStart || Date.now());
        if (absent >= 5000 && !cooldown('FACE_NOT_DETECTED', 15000)) {
          violation('FACE_NOT_DETECTED', { durationMs: absent });
          showWarningBanner('Face not detected. Please look at the camera.');
        }
      }
    } catch (err) {
      console.warn('[AGS FaceCheck]', err.message);
    }
  }

  // ── Skin region grid segmentation ────────────────────────────────────────
  function findSkinRegions(imageData) {
    const { width, height } = imageData;
    const d = imageData.data;
    const GRID = 4;
    const cw = Math.floor(width / GRID);
    const ch = Math.floor(height / GRID);
    const cells = [];

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let skin = 0, total = 0;
        for (let y = gy*ch; y < (gy+1)*ch && y < height; y++) {
          for (let x = gx*cw; x < (gx+1)*cw && x < width; x++) {
            const i = (y * width + x) * 4;
            if (isSkin(d[i], d[i+1], d[i+2])) skin++;
            total++;
          }
        }
        if (skin/total > 0.25) cells.push({ x: gx*cw, y: gy*ch, w: cw, h: ch, cx: gx*cw+cw/2, cy: gy*ch+ch/2 });
      }
    }

    // Cluster adjacent cells
    if (!cells.length) return [];
    const visited = new Set(), clusters = [];
    for (let i = 0; i < cells.length; i++) {
      if (visited.has(i)) continue;
      const cluster = [cells[i]]; visited.add(i);
      for (let j = i+1; j < cells.length; j++) {
        if (visited.has(j)) continue;
        if (Math.abs(cells[i].cx-cells[j].cx) < cw*1.5 && Math.abs(cells[i].cy-cells[j].cy) < ch*1.5) {
          cluster.push(cells[j]); visited.add(j);
        }
      }
      clusters.push({
        x: Math.min(...cluster.map(c=>c.x)), y: Math.min(...cluster.map(c=>c.y)),
        w: Math.max(...cluster.map(c=>c.x+c.w))-Math.min(...cluster.map(c=>c.x)),
        h: Math.max(...cluster.map(c=>c.y+c.h))-Math.min(...cluster.map(c=>c.y))
      });
    }
    return clusters;
  }

  function applyNMS(regions) {
    if (!regions.length) return 0;
    const kept = [];
    for (const r of regions) {
      let dup = false;
      for (const k of kept) {
        const ox = Math.max(0, Math.min(r.x+r.w,k.x+k.w)-Math.max(r.x,k.x));
        const oy = Math.max(0, Math.min(r.y+r.h,k.y+k.h)-Math.max(r.y,k.y));
        if ((ox*oy) / (Math.min(r.w*r.h, k.w*k.h)||1) > 0.70) { dup = true; break; }
      }
      if (!dup) kept.push(r);
    }
    prevRegions = kept;
    return kept.filter(r => r.w*r.h > 100).length;
  }

  function isSkin(r, g, b) {
    return (
      (r>95 && g>40 && b>20 && Math.max(r,g,b)-Math.min(r,g,b)>15 && Math.abs(r-g)>15 && r>g && r>b) ||
      (r>220 && g>210 && b>170 && Math.abs(r-g)<=15 && r>b && g>b) ||
      (r>80 && g>30 && b>15 && r>g && (r-b)>20)
    );
  }

  function avgBrightness(imageData) {
    let sum = 0;
    for (let i = 0; i < imageData.data.length; i += 4) sum += (imageData.data[i]+imageData.data[i+1]+imageData.data[i+2])/3;
    return sum / (imageData.data.length / 4);
  }

  // ── Voice monitor ─────────────────────────────────────────────────────────
  let speechStart=null, isSpeaking=false, silenceFrames=0, voiceRafId=null;
  const SPEECH_THRESH=28, SUSTAIN_MS=5000;

  async function startVoice() {
    try {
      const voiceStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:false, noiseSuppression:false }, video:false
      });
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      audioCtx.createMediaStreamSource(voiceStream).connect(analyser);
      setOverlayStatus('mic', 'Listening', 'ok');
      runVoiceMonitor();
    } catch (err) {
      setOverlayStatus('mic', 'Denied', 'error');
      violation('MIC_DISABLED', { reason: err.message });
    }
  }

  function runVoiceMonitor() {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    function loop() {
      if (!examActive) return;
      analyser.getByteTimeDomainData(buf);
      let s=0; for (let i=0;i<buf.length;i++){const n=(buf[i]/128)-1;s+=n*n;}
      const rms = Math.sqrt(s/buf.length)*100;
      if (rms > SPEECH_THRESH) {
        silenceFrames=0;
        if (!isSpeaking){isSpeaking=true;speechStart=Date.now();}
        const dur = Date.now()-speechStart;
        if (dur>=SUSTAIN_MS && !cooldown('VOICE_DETECTED',20000)) {
          violation('VOICE_DETECTED',{durationMs:dur,rms:Math.round(rms)});
          showWarningBanner('Voice activity detected. Please remain silent.');
          speechStart=Date.now();
        }
      } else {
        silenceFrames++;
        if (silenceFrames>20){isSpeaking=false;speechStart=null;}
      }
      voiceRafId = requestAnimationFrame(()=>setTimeout(loop,150));
    }
    loop();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WARNING BANNER
  // ─────────────────────────────────────────────────────────────────────────
  function showWarningBanner(msg, type = 'danger') {
    if (warningBanner) warningBanner.remove();
    warningBanner = document.createElement('div');
    warningBanner.className = `__ags_warn__ __ags_warn_${type}__`;
    warningBanner.textContent = msg;
    document.body.appendChild(warningBanner);
    if (warnTimeout) clearTimeout(warnTimeout);
    warnTimeout = setTimeout(() => { warningBanner?.remove(); }, 4500);
  }

  function violation(type, metadata = {}) {
    if (!examActive) return;
    pushEventToOverlay({ eventType: type, ts: now() });
    chrome.runtime.sendMessage({ type: 'LOG_VIOLATION', payload: { eventType: type, metadata } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEARDOWN
  // ─────────────────────────────────────────────────────────────────────────
  function teardown() {
    detachBehaviourMonitors();
    if (elapsedInterval) clearInterval(elapsedInterval);
    if (faceCheckTimer)  clearInterval(faceCheckTimer);
    if (devtoolsTimer)   clearInterval(devtoolsTimer);
    if (voiceRafId)      cancelAnimationFrame(voiceRafId);
    if (audioCtx)        audioCtx.close().catch(()=>{});
    if (mediaStream)     mediaStream.getTracks().forEach(t=>t.stop());
    if (overlayPanel)  { overlayPanel.remove(); overlayPanel=null; }
    if (cameraPreview) { cameraPreview.remove(); cameraPreview=null; }
    document.exitFullscreen?.().catch(()=>{});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STYLES
  // ─────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('__ags_styles__')) return;
    const s = document.createElement('style');
    s.id = '__ags_styles__';
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');

      #__ags_disclaimer__ { position:fixed;inset:0;z-index:2147483647;font-family:'Rajdhani',system-ui,sans-serif; }
      .ags-modal-backdrop { position:absolute;inset:0;background:rgba(0,5,15,0.95);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center; }
      .ags-modal { background:linear-gradient(135deg,#070D1A,#0D1A2E);border:1px solid rgba(0,200,255,0.2);border-radius:8px;padding:28px 26px 22px;width:420px;max-width:94vw;box-shadow:0 0 60px rgba(0,180,255,0.1),0 24px 80px rgba(0,0,0,.8); }
      .ags-modal-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:16px; }
      .ags-modal-logo { font-family:'Share Tech Mono',monospace;font-size:13px;color:#00C8FF;letter-spacing:.15em; }
      .ags-modal-version { font-family:'Share Tech Mono',monospace;font-size:9px;color:#1A3A5C;background:#020A14;padding:3px 8px;border-radius:3px;border:1px solid rgba(0,200,255,0.15); }
      .ags-modal-title { font-size:22px;font-weight:700;color:#E0F0FF;margin-bottom:8px;letter-spacing:.05em; }
      .ags-modal-intro { font-size:12px;color:#4A7A9B;line-height:1.6;margin-bottom:16px; }
      .ags-rules { display:flex;flex-direction:column;gap:8px;margin-bottom:20px; }
      .ags-rule { display:flex;gap:12px;align-items:flex-start;background:rgba(0,200,255,0.04);border:1px solid rgba(0,200,255,0.08);border-radius:6px;padding:10px 12px; }
      .ags-dot { width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:5px; }
      .ags-dot.blue  { background:#00C8FF;box-shadow:0 0 8px #00C8FF; }
      .ags-dot.green { background:#00FF88;box-shadow:0 0 8px #00FF88; }
      .ags-dot.amber { background:#FFB800;box-shadow:0 0 8px #FFB800; }
      .ags-dot.red   { background:#FF4444;box-shadow:0 0 8px #FF4444; }
      .ags-rule strong { display:block;font-size:11px;font-weight:600;color:#B0D8F0;margin-bottom:2px;letter-spacing:.05em; }
      .ags-rule p { font-size:11px;color:#4A7A9B;line-height:1.5;margin:0; }
      .ags-start-btn { width:100%;padding:13px;background:linear-gradient(135deg,#003A6B,#005A9E);border:1px solid rgba(0,200,255,0.3);border-radius:6px;color:#00C8FF;font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:.1em;text-transform:uppercase;transition:all .2s;margin-bottom:10px; }
      .ags-start-btn:hover { background:linear-gradient(135deg,#005A9E,#0070C4);box-shadow:0 0 20px rgba(0,200,255,0.3); }
      .ags-consent { font-size:9px;color:#1A3A5C;text-align:center; }

      #__ags_panel__ { position:fixed;top:12px;right:12px;z-index:2147483646;width:200px;background:rgba(7,13,26,0.95);border:1px solid rgba(0,200,255,0.2);border-radius:6px;font-family:'Rajdhani',system-ui,sans-serif;box-shadow:0 0 30px rgba(0,180,255,0.08);overflow:hidden;backdrop-filter:blur(10px); }
      .ags-panel-header { display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(0,200,255,0.05);border-bottom:1px solid rgba(0,200,255,0.1); }
      .ags-panel-logo { color:#00C8FF;font-size:12px; }
      .ags-panel-title { font-family:'Share Tech Mono',monospace;font-size:9px;color:#00C8FF;letter-spacing:.12em;flex:1; }
      .ags-panel-pulse { width:5px;height:5px;border-radius:50%;background:#00FF88;box-shadow:0 0 6px #00FF88;animation:ags-pulse 2s infinite; }
      @keyframes ags-pulse{0%,100%{opacity:1}50%{opacity:.2}}
      .ags-score-row { display:flex;align-items:center;justify-content:space-between;padding:8px 12px 4px; }
      .ags-score-label { font-size:9px;color:#2A5A7A;text-transform:uppercase;letter-spacing:.08em; }
      .ags-score-val { font-family:'Share Tech Mono',monospace;font-size:20px;color:#00FF88;transition:color .4s; }
      .ags-ai-row { display:flex;align-items:center;justify-content:space-between;padding:2px 12px 6px; }
      .ags-ai-label { font-size:9px;color:#2A5A7A;text-transform:uppercase;letter-spacing:.08em; }
      .ags-ai-val { font-family:'Share Tech Mono',monospace;font-size:11px;color:#00FF88;transition:color .4s; }
      .ags-status-list { padding:0 8px 6px;display:flex;flex-direction:column;gap:3px; }
      .ags-status-row { display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(0,0,20,0.4);border-radius:4px; }
      .ags-s-dot { width:5px;height:5px;border-radius:50%;background:#1A3A5C;transition:all .3s;flex-shrink:0; }
      .ags-dot-ok    { background:#00FF88!important;box-shadow:0 0 5px #00FF88!important; }
      .ags-dot-warn  { background:#FFB800!important;box-shadow:0 0 5px #FFB800!important; }
      .ags-dot-error { background:#FF4444!important;box-shadow:0 0 5px #FF4444!important; }
      .ags-s-label { font-size:10px;color:#4A7A9B;flex:1; }
      .ags-s-state { font-family:'Share Tech Mono',monospace;font-size:8px;color:#1A3A5C; }
      .ags-violations-row { display:flex;align-items:center;justify-content:space-between;padding:5px 12px;border-top:1px solid rgba(0,200,255,0.06);border-bottom:1px solid rgba(0,200,255,0.06); }
      .ags-violations-row span:first-child { font-size:9px;color:#2A5A7A;text-transform:uppercase;letter-spacing:.08em; }
      .ags-viol-count { font-family:'Share Tech Mono',monospace;font-size:14px;color:#FF4444; }
      .ags-timeline-header { font-family:'Share Tech Mono',monospace;font-size:7px;color:#1A3A5C;letter-spacing:.1em;padding:5px 12px 3px;text-transform:uppercase; }
      .ags-timeline { max-height:90px;overflow-y:auto;padding:0 8px 4px; }
      .ags-timeline::-webkit-scrollbar { width:1px; }
      .ags-timeline::-webkit-scrollbar-thumb { background:#1A3A5C; }
      .ags-tl-empty { font-size:9px;color:#1A3A5C;padding:8px;text-align:center; }
      .ags-tl-row { display:flex;gap:6px;padding:2px 0; }
      .ags-tl-time { font-family:'Share Tech Mono',monospace;font-size:8px;color:#2A5A7A;flex-shrink:0; }
      .ags-tl-event { font-size:8px;color:#4A7A9B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .ags-footer { font-family:'Share Tech Mono',monospace;font-size:8px;color:#1A3A5C;text-align:center;padding:5px;border-top:1px solid rgba(0,200,255,0.05); }

      #__ags_cam_preview__ { position:fixed;top:12px;left:12px;z-index:2147483645;width:160px;border:1px solid rgba(0,200,255,0.25);border-radius:6px;overflow:hidden;background:#020A14;box-shadow:0 0 20px rgba(0,0,0,.6); }
      #__ags_cam_preview__ video { width:160px;height:120px;object-fit:cover;display:block;transform:scaleX(-1); }
      .ags-cam-badge { position:absolute;top:5px;left:5px;z-index:2;background:rgba(255,50,50,.9);color:#fff;font-family:'Share Tech Mono',monospace;font-size:8px;padding:2px 5px;border-radius:3px; }
      .ags-cam-label { font-family:'Share Tech Mono',monospace;font-size:8px;color:#4A7A9B;text-align:center;padding:4px;background:#070D1A; }

      .__ags_warn__ { position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:2147483644;padding:10px 20px;border-radius:5px;font-family:'Rajdhani',system-ui,sans-serif;font-size:13px;font-weight:600;max-width:500px;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,.6);animation:ags-slide .3s ease;letter-spacing:.05em;text-transform:uppercase; }
      .__ags_warn_danger__  { background:linear-gradient(135deg,#3A0A0A,#800000);color:#FFD0D0;border:1px solid rgba(255,68,68,.3); }
      .__ags_warn_success__ { background:linear-gradient(135deg,#002A1A,#004D2E);color:#C0FFE0;border:1px solid rgba(0,255,136,.3); }
      @keyframes ags-slide{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
    `;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UTILS
  // ─────────────────────────────────────────────────────────────────────────
  function cooldown(key, ms) {
    if (cooldowns[key] && Date.now() - cooldowns[key] < ms) return true;
    cooldowns[key] = Date.now();
    return false;
  }
  function now() { const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function pad(n) { return String(n).padStart(2,'0'); }
})();
