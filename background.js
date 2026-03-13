// ─────────────────────────────────────────────────────────────────────────────
// Aegis v2 — Background Service Worker
// Handles: API streaming, tab lifecycle, heartbeat, session state, event bus
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_ENDPOINT   = 'https://your-exam-backend.com/api';
const HEARTBEAT_SECS     = 30;
const BATCH_FLUSH_SECS   = 10;
const MAX_QUEUE          = 200;

// ── Session state ─────────────────────────────────────────────────────────────
let session = {
  active:         false,
  studentId:      null,
  examId:         null,
  startTime:      null,
  integrityScore: 100,
  violations:     0,
  riskLevel:      'SAFE',
  queue:          []          // offline event buffer
};

// ─────────────────────────────────────────────────────────────────────────────
// Install / startup
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    examSession:    { active: false },
    integrityScore: 100,
    violations:     0,
    riskLevel:      'SAFE',
    events:         []
  });
  console.log('[Aegis BG] Installed & storage initialised.');
});

// ─────────────────────────────────────────────────────────────────────────────
// Message router
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    switch (msg.type) {

      case 'START_EXAM':
        await startExam(msg.payload);
        respond({ ok: true, session });
        break;

      case 'END_EXAM':
        await endExam();
        respond({ ok: true });
        break;

      case 'LOG_VIOLATION':
        await handleViolation(msg.payload);
        respond({ ok: true, score: session.integrityScore });
        break;

      case 'LOG_EVENT':
        await persistEvent(buildEvent(msg.payload.eventType, 'INFO', msg.payload.metadata));
        respond({ ok: true });
        break;

      case 'GET_STATE':
        respond({ state: await fullState() });
        break;

      case 'PING':
        respond({ alive: true, session });
        break;

      default:
        respond({ ok: false, error: 'unknown_type' });
    }
  })();
  return true; // async
});

// ─────────────────────────────────────────────────────────────────────────────
// Exam lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function startExam(payload = {}) {
  session = {
    active:         true,
    studentId:      payload.studentId  || autoId('STU'),
    examId:         payload.examId     || autoId('EXM'),
    startTime:      Date.now(),
    integrityScore: 100,
    violations:     0,
    riskLevel:      'SAFE',
    queue:          []
  };

  await chrome.storage.local.set({
    examSession:    session,
    integrityScore: 100,
    violations:     0,
    riskLevel:      'SAFE',
    events:         []
  });

  chrome.alarms.create('heartbeat',  { periodInMinutes: HEARTBEAT_SECS  / 60 });
  chrome.alarms.create('batchFlush', { periodInMinutes: BATCH_FLUSH_SECS / 60 });

  await streamEvent(buildEvent('EXAM_STARTED', 'INFO', { studentId: session.studentId, examId: session.examId }));
  broadcastTabs({ type: 'EXAM_STARTED', payload: session });
  console.log(`[Aegis BG] Exam started — ${session.examId}`);
}

async function endExam() {
  if (!session.active) return;

  await streamEvent(buildEvent('EXAM_ENDED', 'INFO', {
    finalScore:      session.integrityScore,
    totalViolations: session.violations,
    duration:        Date.now() - session.startTime
  }));

  session.active = false;
  await chrome.storage.local.set({ examSession: { active: false } });
  chrome.alarms.clear('heartbeat');
  chrome.alarms.clear('batchFlush');

  broadcastTabs({ type: 'EXAM_ENDED', payload: {} });
  console.log('[Aegis BG] Exam ended.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Violation handling & scoring
// ─────────────────────────────────────────────────────────────────────────────
const PENALTIES = {
  TAB_SWITCH:        -10,
  EXIT_FULLSCREEN:   -15,
  COPY_ATTEMPT:      -15,
  PASTE_ATTEMPT:     -10,
  WINDOW_BLUR:       -8,
  MULTIPLE_TABS:     -20,
  PAGE_REFRESH:      -15,
  KEYBOARD_SHORTCUT: -10,
  RIGHT_CLICK:       -5,
  FACE_NOT_DETECTED: -20,
  MULTIPLE_FACES:    -18,
  VOICE_DETECTED:    -10,
  CAMERA_DISABLED:   -15,
  MIC_DISABLED:      -10,
  LOOKING_AWAY:      -8
};

const SEVERITY_HIGH   = new Set(['MULTIPLE_TABS','MULTIPLE_FACES','COPY_ATTEMPT','PAGE_REFRESH','CAMERA_DISABLED','EXIT_FULLSCREEN','FACE_NOT_DETECTED']);
const SEVERITY_MEDIUM = new Set(['TAB_SWITCH','WINDOW_BLUR','VOICE_DETECTED','KEYBOARD_SHORTCUT','PASTE_ATTEMPT']);

async function handleViolation(payload) {
  if (!session.active) return;

  const penalty   = PENALTIES[payload.eventType] ?? -5;
  const severity  = SEVERITY_HIGH.has(payload.eventType) ? 'HIGH'
                  : SEVERITY_MEDIUM.has(payload.eventType) ? 'MEDIUM' : 'LOW';

  session.integrityScore = Math.max(0, session.integrityScore + penalty);
  session.violations++;
  session.riskLevel = riskLevel(session.integrityScore);

  const event = buildEvent(payload.eventType, severity, {
    ...payload.metadata,
    scoreImpact: penalty,
    newScore:    session.integrityScore
  });

  await persistEvent(event);
  await streamEvent(event);

  await chrome.storage.local.set({
    integrityScore: session.integrityScore,
    violations:     session.violations,
    riskLevel:      session.riskLevel
  });

  // Notify popup (if open)
  chrome.runtime.sendMessage({
    type:    'SCORE_UPDATED',
    payload: { score: session.integrityScore, riskLevel: session.riskLevel, violations: session.violations }
  }).catch(() => {});

  // Notify content scripts
  broadcastTabs({ type: 'SCORE_UPDATED', payload: { score: session.integrityScore, riskLevel: session.riskLevel } });
}

function riskLevel(score) {
  if (score >= 90) return 'SAFE';
  if (score >= 75) return 'LOW_RISK';
  if (score >= 50) return 'SUSPICIOUS';
  return 'HIGH_RISK';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab monitoring (background-level)
// ─────────────────────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(() => {
  if (session.active) handleViolation({ eventType: 'TAB_SWITCH', metadata: {} });
});

chrome.tabs.onCreated.addListener(() => {
  if (session.active) handleViolation({ eventType: 'MULTIPLE_TABS', metadata: {} });
});

// ─────────────────────────────────────────────────────────────────────────────
// API streaming
// ─────────────────────────────────────────────────────────────────────────────
async function streamEvent(event) {
  try {
    const res = await fetch(`${BACKEND_ENDPOINT}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Aegis': '2.0' },
      body: JSON.stringify(event)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    if (session.queue.length < MAX_QUEUE) session.queue.push(event);
  }
}

async function flushQueue() {
  if (!session.queue.length) return;
  const batch = session.queue.splice(0);
  try {
    await fetch(`${BACKEND_ENDPOINT}/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch })
    });
  } catch {
    session.queue.unshift(...batch); // re-queue
  }
}

async function sendHeartbeat() {
  if (!session.active) return;
  try {
    await fetch(`${BACKEND_ENDPOINT}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId:      session.studentId,
        examId:         session.examId,
        integrityScore: session.integrityScore,
        violations:     session.violations,
        ts:             new Date().toISOString()
      })
    });
  } catch { /* offline */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alarms
// ─────────────────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'heartbeat')  sendHeartbeat();
  if (name === 'batchFlush') flushQueue();
});

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function buildEvent(eventType, severity = 'INFO', metadata = {}) {
  return {
    id:         autoId('EVT'),
    studentId:  session.studentId,
    examId:     session.examId,
    eventType,
    severity,
    metadata,
    timestamp:  new Date().toISOString()
  };
}

async function persistEvent(event) {
  const { events = [] } = await chrome.storage.local.get('events');
  events.push(event);
  if (events.length > 500) events.splice(0, events.length - 500);
  await chrome.storage.local.set({ events });
}

async function fullState() {
  return new Promise(r => chrome.storage.local.get(null, r));
}

function broadcastTabs(msg) {
  chrome.tabs.query({}, tabs =>
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {}))
  );
}

function autoId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substr(2,4).toUpperCase()}`;
}

console.log('[Aegis BG] Service worker v2 ready.');
