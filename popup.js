// ─────────────────────────────────────────────────────────────────────────────
// Aegis v2 — Popup Controller
// ─────────────────────────────────────────────────────────────────────────────
import { AnalyticsEngine } from './services/analyticsEngine.js';

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────
let analytics     = null;
let timerInterval = null;
let examStart     = null;

// Camera in popup (separate stream from content script's)
let popupStream   = null;

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  const { examSession } = await store('examSession');
  if (examSession?.active) {
    showDashboard(false);
  } else {
    showDisclaimer();
  }
  bindUI();
  listenBG();
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen control
// ─────────────────────────────────────────────────────────────────────────────
function showDisclaimer() {
  $('disclaimer-screen').classList.add('active');
  $('dashboard-screen').classList.remove('active');
}

function showDashboard(fresh) {
  $('disclaimer-screen').classList.remove('active');
  $('dashboard-screen').classList.add('active');
  if (fresh) launchMonitoring();
  else       resumeMonitoring();
}

// ─────────────────────────────────────────────────────────────────────────────
// UI bindings
// ─────────────────────────────────────────────────────────────────────────────
function bindUI() {
  $('start-exam-btn').addEventListener('click', onStart);
  $('end-exam-btn').addEventListener('click', onEnd);
  $('clear-log-btn').addEventListener('click', () => {
    $('event-timeline').innerHTML = '<div class="timeline-empty">Log cleared.</div>';
  });
}

async function onStart() {
  const btn = $('start-exam-btn');
  btn.disabled = true;
  btn.innerHTML = '<span>Initialising...</span>';

  const studentId = $('student-id-input').value.trim() || autoId('STU');
  const examId    = $('exam-id-input').value.trim()    || autoId('EXM');

  await bg('START_EXAM', { studentId, examId });
  showDashboard(true);
}

async function onEnd() {
  if (!confirm('End the exam session? All monitoring will stop.')) return;
  await bg('END_EXAM', {});
  stopMonitoring();
  showDisclaimer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function launchMonitoring() {
  examStart = Date.now();
  analytics = new AnalyticsEngine();

  startTimer();
  await startPopupCamera();
  await restoreState();

  setCard('tab',   'ACTIVE',       'active', 'green');
  setCard('fs',    'ENFORCING',    'active', 'green');
  setCard('camera','ACTIVE',       'active', 'green');
  setCard('voice', 'LISTENING',    'active', 'green');
}

async function resumeMonitoring() {
  examStart = Date.now();
  analytics = new AnalyticsEngine();
  startTimer();
  await startPopupCamera();
  await restoreState();
}

function stopMonitoring() {
  if (timerInterval) clearInterval(timerInterval);
  if (popupStream)   popupStream.getTracks().forEach(t => t.stop());
  analytics = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup camera feed — FIXED: proper load sequencing, canvas sizing, detection
// ─────────────────────────────────────────────────────────────────────────────
async function startPopupCamera() {
  const video  = $('camera-feed');
  const canvas = $('camera-canvas');

  // FIX 1: Set actual canvas buffer dimensions (not just CSS)
  canvas.width  = 160;
  canvas.height = 120;

  $('cam-feed-status').textContent = '● Requesting...';

  try {
    // FIX 2: Use ideal constraints so Chrome picks best available resolution
    popupStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:     { ideal: 640 },
        height:    { ideal: 480 },
        facingMode: 'user'
      },
      audio: false
    });

    video.srcObject = popupStream;

    // FIX 3: Wait for loadedmetadata before play() — ensures video dimensions exist
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = (e) => reject(new Error('Video load error: ' + e.message));
      setTimeout(() => reject(new Error('Camera load timeout')), 8000);
    });

    await video.play();

    $('cam-feed-status').textContent = '● Live';
    $('cam-feed-status').className   = 'cam-status online';
    $('camera-msg').textContent      = 'Analysing...';
    setCard('camera', 'ACTIVE', 'active', 'green');

    // FIX 4: Give browser one frame-render cycle before sampling pixels
    await new Promise(r => setTimeout(r, 500));

    startPopupFaceDetect(video, canvas);

  } catch (err) {
    console.error('[Aegis Camera]', err);
    $('cam-feed-status').textContent = '● Unavailable';
    $('camera-msg').textContent      = '⚠ ' + (err.message || 'Camera denied');
    setCard('camera', 'DENIED', 'error', 'red');
    bg('LOG_VIOLATION', { eventType: 'CAMERA_DISABLED', metadata: { reason: err.message } });
  }
}

let popupFaceTimer = null;
let consecutiveBlankFrames = 0;

function startPopupFaceDetect(video, canvas) {
  if (popupFaceTimer) clearInterval(popupFaceTimer);
  consecutiveBlankFrames = 0;

  popupFaceTimer = setInterval(() => {
    // FIX 5: Check videoWidth > 0, not readyState — videoWidth is 0 until frames arrive
    if (!video || video.videoWidth === 0 || video.paused || video.ended) return;

    try {
      const ctx = canvas.getContext('2d');
      // FIX 6: Clear before each draw to avoid ghost frames
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const { personPresent, faceCount, avgBrightness, skinRatio } = analyseSkin(imageData);

      // FIX 7: Skip blank/dark frames (camera warming up, privacy shutter)
      if (avgBrightness < 8) {
        consecutiveBlankFrames++;
        if (consecutiveBlankFrames > 5) {
          $('camera-msg').textContent = '⚠ Feed is dark — check camera';
        }
        return;
      }
      consecutiveBlankFrames = 0;

      // Update popup face indicator
      $('face-indicator').classList.toggle('visible', personPresent);

      if (personPresent) {
        $('camera-msg').textContent = faceCount > 1 ? '⚠ Multiple faces' : '✓ Face detected';
        // Sync status to background so content script overlay updates too
        bg('LOG_EVENT', { eventType: faceCount > 1 ? 'MULTIPLE_FACES' : 'FACE_DETECTED', metadata: {} });
      } else {
        $('camera-msg').textContent = '⚠ No face detected';
      }

    } catch (err) {
      console.warn('[Aegis FaceDetect]', err.message);
    }
  }, 1500); // Check every 1.5s (faster than before)
}

function analyseSkin(imageData) {
  const d = imageData.data;
  let skin = 0, brightness = 0;
  const total = d.length / 4;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    brightness += (r + g + b) / 3;

    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);

    // FIX 8: Wider skin-tone range — catches more ethnicities + lighting conditions
    const isSkin =
      // Classic Kovac rule
      (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r-g) > 15 && r > g && r > b) ||
      // Darker skin tones
      (r > 220 && g > 210 && b > 170 && Math.abs(r-g) <= 15 && r > b && g > b) ||
      // YCbCr approximation  
      (r > 80 && g > 30 && b > 15 && r > g && r - b > 20);

    if (isSkin) skin++;
  }

  const skinRatio    = skin / total;
  const avgBrightness = brightness / total;

  return {
    personPresent: skinRatio > 0.025, // FIX 9: Lower threshold (was 0.04)
    faceCount:     skinRatio > 0.28 ? 2 : 1,
    avgBrightness,
    skinRatio
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State restoration
// ─────────────────────────────────────────────────────────────────────────────
async function restoreState() {
  const s = await store(['integrityScore','violations','riskLevel','events']);
  const score      = s.integrityScore ?? 100;
  const violations = s.violations ?? 0;
  const riskLevel  = s.riskLevel ?? 'SAFE';
  const events     = s.events ?? [];

  applyScore(score, riskLevel);
  $('stat-violations').textContent = violations;

  if (analytics) {
    const summary = analytics.summarise(events);
    applyAnalytics(summary);
  }

  // Render recent events
  events.slice(-30).forEach(renderEvent);
  scrollBottom();
}

// ─────────────────────────────────────────────────────────────────────────────
// Score UI
// ─────────────────────────────────────────────────────────────────────────────
function applyScore(score, level) {
  const el = $('score-value');
  animNum(el, parseInt(el.dataset.prev || score), score);
  el.dataset.prev = score;

  const circ   = 326.73;
  const offset = circ - (score / 100) * circ;
  const ring   = $('ring-fill');
  ring.style.strokeDashoffset = offset;

  const col = score>=90 ? 'var(--green)' : score>=75 ? 'var(--blue)' : score>=50 ? 'var(--amber)' : 'var(--red)';
  ring.style.stroke = col;
  ring.style.filter = `drop-shadow(0 0 6px ${col})`;

  const badge = $('risk-badge');
  badge.className = 'risk-badge';
  badge.classList.add({ SAFE:'safe', LOW_RISK:'low', SUSPICIOUS:'suspicious', HIGH_RISK:'high' }[level] || 'safe');
  $('risk-label').textContent = level.replace('_',' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics display
// ─────────────────────────────────────────────────────────────────────────────
function applyAnalytics(summary) {
  $('ac-tab').textContent  = summary.TAB_SWITCH        || 0;
  $('ac-copy').textContent = summary.COPY_ATTEMPT       || 0;
  $('ac-fs').textContent   = summary.EXIT_FULLSCREEN    || 0;
  $('ac-face').textContent = summary.FACE_NOT_DETECTED  || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event timeline rendering
// ─────────────────────────────────────────────────────────────────────────────
function renderEvent(event) {
  const tl    = $('event-timeline');
  const empty = tl.querySelector('.timeline-empty');
  if (empty) empty.remove();

  const el  = document.createElement('div');
  el.className = 'timeline-event';
  const t   = new Date(event.timestamp);
  const ts  = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const sev = (event.severity || 'info').toLowerCase();

  el.innerHTML = `
    <span class="event-time">${ts}</span>
    <span class="event-name">${(event.eventType||'').replace(/_/g,' ')}</span>
    <span class="event-badge ${sev}">${sev.toUpperCase()}</span>
  `;
  tl.appendChild(el);

  const rows = tl.querySelectorAll('.timeline-event');
  if (rows.length > 60) rows[0].remove();
}

function scrollBottom() {
  const tl = $('event-timeline');
  tl.scrollTop = tl.scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Background message listener
// ─────────────────────────────────────────────────────────────────────────────
function listenBG() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCORE_UPDATED') {
      const { score, riskLevel, violations } = msg.payload;
      applyScore(score, riskLevel);
      $('stat-violations').textContent = violations ?? 0;
      // Refresh analytics
      store('events').then(({ events = [] }) => {
        if (analytics) applyAnalytics(analytics.summarise(events));
      });
    }
  });

  // Poll for new events every 3s
  setInterval(async () => {
    const { events = [] } = await store('events');
    const tl = $('event-timeline');
    const rendered = tl.querySelectorAll('.timeline-event').length;
    if (events.length > rendered) {
      events.slice(rendered).forEach(renderEvent);
      scrollBottom();
      const warned = parseInt($('stat-warnings').textContent || '0');
      const newWarns = events.slice(rendered).filter(e => e.severity !== 'INFO').length;
      $('stat-warnings').textContent = warned + newWarns;
    }
  }, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────────────────────
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - examStart) / 1000);
    $('stat-time').textContent = `${pad(Math.floor(s/60))}:${pad(s%60)}`;
  }, 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status card helpers
// ─────────────────────────────────────────────────────────────────────────────
function setCard(name, text, stateClass, ledClass) {
  const s = $(`state-${name}`); if (s) { s.textContent=text; s.className=`card-state ${stateClass}`; }
  const l = $(`led-${name}`);   if (l) l.className = `card-led ${ledClass}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────
function store(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}

function bg(type, payload) {
  return new Promise(r => chrome.runtime.sendMessage({ type, payload }, r));
}

function animNum(el, from, to) {
  const dur = 600, t0 = performance.now();
  (function step(now) {
    const p = Math.min((now-t0)/dur,1), e=1-Math.pow(1-p,3);
    el.textContent = Math.round(from+(to-from)*e);
    if (p<1) requestAnimationFrame(step);
  })(t0);
}

function pad(n) { return String(n).padStart(2,'0'); }
function autoId(p) { return `${p}-${Date.now().toString(36).toUpperCase()}`; }

document.addEventListener('DOMContentLoaded', init);
