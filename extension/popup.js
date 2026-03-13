// ─────────────────────────────────────────────────────────────────────────────
// AGS v3 — Popup Controller
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

let analytics     = null;
let timerInterval = null;
let examStart     = null;
let popupStream   = null;
let popupFaceTimer = null;

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
  const btn = $('start-exam-btn');
  btn.disabled = false;
  btn.innerHTML = '<span class="btn-icon">▶</span> Start Exam';
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function launchMonitoring() {
  examStart = Date.now();
  startTimer();
  await startPopupCamera();
  await restoreState();
  setCard('tab',    'ACTIVE',    'active', 'green');
  setCard('fs',     'ENFORCING', 'active', 'green');
  setCard('camera', 'ACTIVE',    'active', 'green');
  setCard('voice',  'LISTENING', 'active', 'green');
}

async function resumeMonitoring() {
  examStart = Date.now();
  startTimer();
  await startPopupCamera();
  await restoreState();
}

function stopMonitoring() {
  if (timerInterval) clearInterval(timerInterval);
  if (popupFaceTimer) clearInterval(popupFaceTimer);
  if (popupStream)    popupStream.getTracks().forEach(t => t.stop());
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup Camera with fixed face detection (NMS)
// ─────────────────────────────────────────────────────────────────────────────
async function startPopupCamera() {
  const video  = $('camera-feed');
  const canvas = $('camera-canvas');
  canvas.width  = 160;
  canvas.height = 120;

  $('cam-feed-status').textContent = '● Requesting...';

  try {
    popupStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = popupStream;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
      setTimeout(reject, 8000);
    });
    await video.play();

    $('cam-feed-status').textContent = '● Live';
    $('cam-feed-status').className   = 'cam-status online';
    $('camera-msg').textContent      = 'Analysing...';
    setCard('camera', 'ACTIVE', 'active', 'green');

    await new Promise(r => setTimeout(r, 500));
    startPopupFaceDetect(video, canvas);

  } catch (err) {
    $('cam-feed-status').textContent = '● Unavailable';
    $('camera-msg').textContent      = '⚠ ' + (err.message || 'Camera denied');
    setCard('camera', 'DENIED', 'error', 'red');
  }
}

// ── Temporal state for popup face detection ───────────────────────────────
let popupFaceHistory     = [];
let popupFaceCountHist   = [];
let popupPrevRegions     = [];
const POPUP_HIST_SIZE    = 5;

function startPopupFaceDetect(video, canvas) {
  if (popupFaceTimer) clearInterval(popupFaceTimer);
  popupFaceHistory   = [];
  popupFaceCountHist = [];
  popupPrevRegions   = [];

  popupFaceTimer = setInterval(() => {
    if (!video || video.videoWidth === 0 || video.paused || video.ended) return;

    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const brightness = avgBrightness(imageData);
      if (brightness < 8) { $('camera-msg').textContent = '⚠ Check camera'; return; }

      // Spatial NMS face detection
      const regions   = findSkinRegions(imageData, canvas.width, canvas.height);
      const faceCount = applyNMS(regions);
      const present   = faceCount > 0;

      // Temporal smoothing
      popupFaceHistory.push({ present, faceCount });
      if (popupFaceHistory.length > POPUP_HIST_SIZE) popupFaceHistory.shift();
      popupFaceCountHist.push(faceCount);
      if (popupFaceCountHist.length > POPUP_HIST_SIZE) popupFaceCountHist.shift();

      const presentFrames = popupFaceHistory.filter(f => f.present).length;
      const stablePresent = (presentFrames / popupFaceHistory.length) >= 0.6;
      const multiFrames   = popupFaceCountHist.filter(c => c > 1).length;
      const stableMulti   = multiFrames >= Math.ceil(POPUP_HIST_SIZE * 0.6);

      $('face-indicator').classList.toggle('visible', stablePresent);

      if (stablePresent) {
        $('camera-msg').textContent = stableMulti ? '⚠ Multiple faces' : '✓ Face detected';
        if (stableMulti) {
          bg('LOG_VIOLATION', { eventType: 'MULTIPLE_FACE_DETECTED', metadata: { count: faceCount } });
        }
      } else {
        $('camera-msg').textContent = '⚠ No face detected';
      }

    } catch (err) {
      console.warn('[AGS FaceDetect]', err.message);
    }
  }, 1500);
}

// ── Spatial face detection functions ─────────────────────────────────────
function findSkinRegions(imageData, width, height) {
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
      if (skin/total > 0.25) cells.push({ x:gx*cw, y:gy*ch, w:cw, h:ch, cx:gx*cw+cw/2, cy:gy*ch+ch/2 });
    }
  }

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
      w: Math.max(...cluster.map(c=>c.x+c.w)) - Math.min(...cluster.map(c=>c.x)),
      h: Math.max(...cluster.map(c=>c.y+c.h)) - Math.min(...cluster.map(c=>c.y))
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
      const ox = Math.max(0, Math.min(r.x+r.w,k.x+k.w) - Math.max(r.x,k.x));
      const oy = Math.max(0, Math.min(r.y+r.h,k.y+k.h) - Math.max(r.y,k.y));
      if ((ox*oy) / (Math.min(r.w*r.h, k.w*k.h)||1) > 0.70) { dup = true; break; }
    }
    if (!dup) kept.push(r);
  }
  popupPrevRegions = kept;
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
  for (let i = 0; i < imageData.data.length; i += 4)
    sum += (imageData.data[i]+imageData.data[i+1]+imageData.data[i+2])/3;
  return sum / (imageData.data.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// State restoration
// ─────────────────────────────────────────────────────────────────────────────
async function restoreState() {
  const s = await store(['integrityScore','violations','riskLevel','events','cheatingProbability','behaviorRiskScore']);
  const score      = s.integrityScore      ?? 100;
  const violations = s.violations          ?? 0;
  const riskLevel  = s.riskLevel           ?? 'SAFE';
  const events     = s.events              ?? [];
  const cheatProb  = s.cheatingProbability ?? 0;
  const behavRisk  = s.behaviorRiskScore   ?? 0;

  applyScore(score, riskLevel);
  applyAIScores(cheatProb, behavRisk, score);
  $('stat-violations').textContent = violations;

  // Count analytics
  const counts = {};
  events.forEach(e => { if (e.severity !== 'INFO') counts[e.eventType] = (counts[e.eventType]||0)+1; });
  applyAnalytics(counts);

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
  $('risk-label').textContent = (level||'SAFE').replace('_',' ');
}

function applyAIScores(cheatProb, behavRisk, integrityScore) {
  // AI scores section
  const cheatEl = $('ai-cheat-val');
  const riskEl  = $('ai-risk-val');
  if (cheatEl) {
    cheatEl.textContent = Math.round(cheatProb) + '%';
    cheatEl.style.color = cheatProb > 60 ? 'var(--red)' : cheatProb > 30 ? 'var(--amber)' : 'var(--green)';
    const bar = $('ai-cheat-bar');
    if (bar) { bar.style.width = cheatProb + '%'; bar.style.background = cheatProb > 60 ? 'var(--red)' : 'var(--amber)'; }
  }
  if (riskEl) {
    riskEl.textContent = Math.round(behavRisk) + '%';
    const bar = $('ai-risk-bar');
    if (bar) { bar.style.width = behavRisk + '%'; }
  }
}

function applyAnalytics(counts) {
  $('ac-tab').textContent  = counts['TAB_SWITCH']              || 0;
  $('ac-copy').textContent = counts['COPY_ATTEMPT']            || 0;
  $('ac-fs').textContent   = counts['EXIT_FULLSCREEN']         || 0;
  $('ac-face').textContent = counts['FACE_NOT_DETECTED']       || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event timeline
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
      const { score, riskLevel, violations, cheatingProbability, behaviorRiskScore } = msg.payload;
      applyScore(score, riskLevel);
      applyAIScores(cheatingProbability || 0, behaviorRiskScore || 0, score);
      $('stat-violations').textContent = violations ?? 0;
      store('events').then(({ events = [] }) => {
        const counts = {};
        events.forEach(e => { if (e.severity !== 'INFO') counts[e.eventType] = (counts[e.eventType]||0)+1; });
        applyAnalytics(counts);
      });
    }
    if (msg.type === 'AI_SCORES_UPDATED') {
      applyAIScores(msg.payload.cheatingProbability || 0, msg.payload.behaviorRiskScore || 0, 100);
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
  const dur=600, t0=performance.now();
  (function step(now) {
    const p=Math.min((now-t0)/dur,1), e=1-Math.pow(1-p,3);
    el.textContent=Math.round(from+(to-from)*e);
    if(p<1) requestAnimationFrame(step);
  })(t0);
}

function pad(n) { return String(n).padStart(2,'0'); }
function autoId(p) { return `${p}-${Date.now().toString(36).toUpperCase()}`; }

document.addEventListener('DOMContentLoaded', init);
