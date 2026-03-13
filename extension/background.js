// ─────────────────────────────────────────────────────────────────────────────
// AGS v3 — Background Service Worker
// Handles: API streaming, WebSocket, tab lifecycle, heartbeat, AI scoring
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_ENDPOINT  = 'http://localhost:8000';
const HEARTBEAT_SECS    = 30;
const BATCH_FLUSH_SECS  = 10;
const MAX_QUEUE         = 500;

// ── Session state ─────────────────────────────────────────────────────────────
let session = {
  active:              false,
  studentId:           null,
  examId:              null,
  startTime:           null,
  integrityScore:      100,
  violations:          0,
  riskLevel:           'SAFE',
  cheatingProbability: 0,
  behaviorRiskScore:   0,
  queue:               []
};

// ── Violation counters for AI engine ──────────────────────────────────────────
let counters = {
  tab_switches:        0,
  keyboard_attempts:   0,
  fullscreen_exits:    0,
  face_events:         0,
  idle_periods:        0,
  window_resizes:      0,
  copy_attempts:       0,
  screen_capture:      0,
  devtools_opens:      0,
  multiple_faces:      0
};

let behaviorBaseline = null;
let mouseVelocities  = [];
let lastActivityTime = Date.now();
let idleCheckTimer   = null;

// ─────────────────────────────────────────────────────────────────────────────
// Install / startup
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    examSession:         { active: false },
    integrityScore:      100,
    violations:          0,
    riskLevel:           'SAFE',
    cheatingProbability: 0,
    events:              [],
    counters:            counters
  });
  console.log('[AGS BG] v3 Installed & storage initialised.');
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
        await persistEvent(buildEvent(msg.payload.eventType, 'INFO', msg.payload.metadata || {}));
        respond({ ok: true });
        break;

      case 'MOUSE_ACTIVITY':
        trackMouseActivity(msg.payload);
        respond({ ok: true });
        break;

      case 'TYPING_ACTIVITY':
        trackTypingActivity(msg.payload);
        respond({ ok: true });
        break;

      case 'GET_STATE':
        respond({ state: await fullState() });
        break;

      case 'GET_AI_SCORES':
        respond({ scores: computeAIScores() });
        break;

      case 'PING':
        respond({ alive: true, session });
        break;

      default:
        respond({ ok: false, error: 'unknown_type' });
    }
  })();
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// Exam lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function startExam(payload = {}) {
  counters = {
    tab_switches: 0, keyboard_attempts: 0, fullscreen_exits: 0,
    face_events: 0, idle_periods: 0, window_resizes: 0,
    copy_attempts: 0, screen_capture: 0, devtools_opens: 0, multiple_faces: 0
  };
  behaviorBaseline = null;
  mouseVelocities  = [];

  session = {
    active:              true,
    studentId:           payload.studentId  || autoId('STU'),
    examId:              payload.examId     || autoId('EXM'),
    startTime:           Date.now(),
    integrityScore:      100,
    violations:          0,
    riskLevel:           'SAFE',
    cheatingProbability: 0,
    behaviorRiskScore:   0,
    queue:               []
  };

  await chrome.storage.local.set({
    examSession:         session,
    integrityScore:      100,
    violations:          0,
    riskLevel:           'SAFE',
    cheatingProbability: 0,
    events:              [],
    counters
  });

  chrome.alarms.create('heartbeat',  { periodInMinutes: HEARTBEAT_SECS  / 60 });
  chrome.alarms.create('batchFlush', { periodInMinutes: BATCH_FLUSH_SECS / 60 });
  chrome.alarms.create('idleCheck',  { periodInMinutes: 0.5 });
  chrome.alarms.create('aiScore',    { periodInMinutes: 1 });

  // Notify backend
  await postToBackend('/exam/start', {
    student_id: session.studentId,
    exam_id:    session.examId,
    timestamp:  new Date().toISOString()
  });

  await streamEvent(buildEvent('EXAM_STARTED', 'INFO', {
    studentId: session.studentId,
    examId:    session.examId
  }));

  broadcastTabs({ type: 'EXAM_STARTED', payload: session });
  console.log(`[AGS BG] Exam started — ${session.examId}`);
}

async function endExam() {
  if (!session.active) return;

  const scores = computeAIScores();
  await streamEvent(buildEvent('EXAM_ENDED', 'INFO', {
    finalScore:          session.integrityScore,
    totalViolations:     session.violations,
    duration:            Date.now() - session.startTime,
    cheatingProbability: scores.cheatingProbability,
    behaviorRiskScore:   scores.behaviorRiskScore
  }));

  await postToBackend('/exam/end', {
    student_id:          session.studentId,
    exam_id:             session.examId,
    final_score:         session.integrityScore,
    total_violations:    session.violations,
    cheating_probability: scores.cheatingProbability,
    duration_ms:         Date.now() - session.startTime
  });

  session.active = false;
  await chrome.storage.local.set({ examSession: { active: false } });
  chrome.alarms.clear('heartbeat');
  chrome.alarms.clear('batchFlush');
  chrome.alarms.clear('idleCheck');
  chrome.alarms.clear('aiScore');

  broadcastTabs({ type: 'EXAM_ENDED', payload: {} });
}

// ─────────────────────────────────────────────────────────────────────────────
// Violation handling & AI scoring
// ─────────────────────────────────────────────────────────────────────────────
const PENALTIES = {
  TAB_SWITCH:               -10,
  EXIT_FULLSCREEN:          -15,
  COPY_ATTEMPT:             -15,
  PASTE_ATTEMPT:            -10,
  WINDOW_BLUR:              -8,
  MULTIPLE_TABS:            -20,
  PAGE_REFRESH:             -15,
  KEYBOARD_SHORTCUT:        -10,
  RIGHT_CLICK:              -5,
  FACE_NOT_DETECTED:        -20,
  MULTIPLE_FACE_DETECTED:   -18,
  VOICE_DETECTED:           -10,
  CAMERA_DISABLED:          -15,
  MIC_DISABLED:             -10,
  LOOKING_AWAY:             -8,
  SCREEN_CAPTURE_ATTEMPT:   -25,
  DEVTOOLS_OPEN:            -20,
  OVERLAY_EXTENSION:        -15,
  BEHAVIOR_ANOMALY:         -12,
  IDLE:                     -5,
  WINDOW_RESIZE:            -8
};

const SEVERITY_HIGH = new Set([
  'MULTIPLE_TABS','MULTIPLE_FACE_DETECTED','COPY_ATTEMPT','PAGE_REFRESH',
  'CAMERA_DISABLED','EXIT_FULLSCREEN','FACE_NOT_DETECTED',
  'SCREEN_CAPTURE_ATTEMPT','DEVTOOLS_OPEN','OVERLAY_EXTENSION'
]);
const SEVERITY_MEDIUM = new Set([
  'TAB_SWITCH','WINDOW_BLUR','VOICE_DETECTED','KEYBOARD_SHORTCUT',
  'PASTE_ATTEMPT','BEHAVIOR_ANOMALY','IDLE'
]);

async function handleViolation(payload) {
  if (!session.active) return;

  const penalty  = PENALTIES[payload.eventType] ?? -5;
  const severity = SEVERITY_HIGH.has(payload.eventType) ? 'HIGH'
                 : SEVERITY_MEDIUM.has(payload.eventType) ? 'MEDIUM' : 'LOW';

  session.integrityScore = Math.max(0, session.integrityScore + penalty);
  session.violations++;
  session.riskLevel = riskLevel(session.integrityScore);

  // Update counters for AI engine
  updateCounters(payload.eventType);

  const scores = computeAIScores();
  session.cheatingProbability = scores.cheatingProbability;
  session.behaviorRiskScore   = scores.behaviorRiskScore;

  const event = buildEvent(payload.eventType, severity, {
    ...payload.metadata,
    scoreImpact:         penalty,
    newScore:            session.integrityScore,
    cheatingProbability: scores.cheatingProbability
  });

  await persistEvent(event);
  await streamEvent(event);

  await chrome.storage.local.set({
    integrityScore:      session.integrityScore,
    violations:          session.violations,
    riskLevel:           session.riskLevel,
    cheatingProbability: scores.cheatingProbability,
    counters
  });

  chrome.runtime.sendMessage({
    type:    'SCORE_UPDATED',
    payload: {
      score:               session.integrityScore,
      riskLevel:           session.riskLevel,
      violations:          session.violations,
      cheatingProbability: scores.cheatingProbability,
      behaviorRiskScore:   scores.behaviorRiskScore
    }
  }).catch(() => {});

  broadcastTabs({
    type: 'SCORE_UPDATED',
    payload: {
      score:               session.integrityScore,
      riskLevel:           session.riskLevel,
      cheatingProbability: scores.cheatingProbability
    }
  });
}

function updateCounters(eventType) {
  const map = {
    TAB_SWITCH:             'tab_switches',
    KEYBOARD_SHORTCUT:      'keyboard_attempts',
    COPY_ATTEMPT:           'keyboard_attempts',
    EXIT_FULLSCREEN:        'fullscreen_exits',
    FACE_NOT_DETECTED:      'face_events',
    MULTIPLE_FACE_DETECTED: 'multiple_faces',
    IDLE:                   'idle_periods',
    WINDOW_RESIZE:          'window_resizes',
    COPY_ATTEMPT2:          'copy_attempts',
    SCREEN_CAPTURE_ATTEMPT: 'screen_capture',
    DEVTOOLS_OPEN:          'devtools_opens'
  };
  const key = map[eventType];
  if (key) counters[key] = (counters[key] || 0) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Cheating Probability Engine
// ─────────────────────────────────────────────────────────────────────────────
function computeAIScores() {
  const elapsed = session.startTime
    ? (Date.now() - session.startTime) / 60000  // minutes
    : 1;

  // Weighted signal contributions (0-100 scale)
  const signals = {
    tabSwitchRate:      Math.min(counters.tab_switches / Math.max(elapsed, 1) * 10, 25),
    keyboardRate:       Math.min(counters.keyboard_attempts * 3, 15),
    fullscreenExits:    Math.min(counters.fullscreen_exits * 5, 20),
    faceAbsence:        Math.min(counters.face_events * 4, 20),
    multipleFaces:      Math.min(counters.multiple_faces * 8, 16),
    idleTime:           Math.min(counters.idle_periods * 2, 10),
    screenCapture:      Math.min(counters.screen_capture * 15, 30),
    devtoolsOpen:       Math.min(counters.devtools_opens * 10, 20),
    scoreDrop:          Math.max(0, 100 - session.integrityScore) * 0.4
  };

  const rawProb = Object.values(signals).reduce((a, b) => a + b, 0);
  const cheatingProbability = Math.min(100, Math.round(rawProb));

  // Behavior risk: based on pattern deviation
  const behaviorRiskScore = Math.min(100, Math.round(
    (counters.tab_switches + counters.keyboard_attempts + counters.fullscreen_exits) * 2 +
    session.violations * 1.5
  ));

  // Integrity confidence (inverse of cheating prob with noise reduction)
  const integrityConfidence = Math.max(0, 100 - cheatingProbability);

  return { cheatingProbability, behaviorRiskScore, integrityConfidence, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavior tracking (mouse + typing)
// ─────────────────────────────────────────────────────────────────────────────
function trackMouseActivity(payload) {
  lastActivityTime = Date.now();
  if (payload.velocity) {
    mouseVelocities.push(payload.velocity);
    if (mouseVelocities.length > 100) mouseVelocities.shift();

    // Check for anomaly vs baseline
    if (behaviorBaseline && mouseVelocities.length > 20) {
      const avg = mouseVelocities.slice(-10).reduce((a,b) => a+b, 0) / 10;
      if (Math.abs(avg - behaviorBaseline.avgMouseVelocity) > behaviorBaseline.avgMouseVelocity * 2) {
        handleViolation({ eventType: 'BEHAVIOR_ANOMALY', metadata: { type: 'mouse_velocity', avg } });
      }
    } else if (!behaviorBaseline && mouseVelocities.length === 50) {
      // Establish baseline after 50 samples
      behaviorBaseline = {
        avgMouseVelocity: mouseVelocities.reduce((a,b) => a+b, 0) / mouseVelocities.length
      };
    }
  }
}

function trackTypingActivity(payload) {
  lastActivityTime = Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle detection
// ─────────────────────────────────────────────────────────────────────────────
function checkIdle() {
  if (!session.active) return;
  const idleMs = Date.now() - lastActivityTime;
  if (idleMs > 120000) { // 2 minutes idle
    handleViolation({ eventType: 'IDLE', metadata: { idleMs } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab monitoring
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
async function postToBackend(path, data) {
  try {
    const res = await fetch(`${BACKEND_ENDPOINT}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGS': '3.0' },
      body:    JSON.stringify(data)
    });
    return res.ok;
  } catch { return false; }
}

async function streamEvent(event) {
  const sent = await postToBackend('/events', {
    student_id: event.studentId,
    exam_id:    event.examId,
    event_type: event.eventType,
    timestamp:  event.timestamp,
    duration:   event.metadata?.durationMs || 0,
    metadata:   event.metadata || {}
  });
  if (!sent) {
    if (session.queue.length < MAX_QUEUE) session.queue.push(event);
  }
}

async function flushQueue() {
  if (!session.queue.length) return;
  const batch = session.queue.splice(0);
  try {
    await fetch(`${BACKEND_ENDPOINT}/events/batch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ events: batch })
    });
  } catch {
    session.queue.unshift(...batch);
  }
}

async function sendHeartbeat() {
  if (!session.active) return;
  const scores = computeAIScores();
  await postToBackend('/heartbeat', {
    studentId:           session.studentId,
    examId:              session.examId,
    integrityScore:      session.integrityScore,
    violations:          session.violations,
    cheatingProbability: scores.cheatingProbability,
    counters,
    ts:                  new Date().toISOString()
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Alarms
// ─────────────────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'heartbeat')  sendHeartbeat();
  if (name === 'batchFlush') flushQueue();
  if (name === 'idleCheck')  checkIdle();
  if (name === 'aiScore') {
    if (session.active) {
      const scores = computeAIScores();
      chrome.storage.local.set({
        cheatingProbability: scores.cheatingProbability,
        behaviorRiskScore:   scores.behaviorRiskScore,
        integrityConfidence: scores.integrityConfidence
      });
      broadcastTabs({ type: 'AI_SCORES_UPDATED', payload: scores });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function buildEvent(eventType, severity = 'INFO', metadata = {}) {
  return {
    id:        autoId('EVT'),
    studentId: session.studentId,
    examId:    session.examId,
    eventType,
    severity,
    metadata,
    timestamp: new Date().toISOString()
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

function riskLevel(score) {
  if (score >= 90) return 'SAFE';
  if (score >= 75) return 'LOW_RISK';
  if (score >= 50) return 'SUSPICIOUS';
  return 'HIGH_RISK';
}

function broadcastTabs(msg) {
  chrome.tabs.query({}, tabs =>
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {}))
  );
}

function autoId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substr(2,4).toUpperCase()}`;
}

console.log('[AGS BG] Service worker v3 ready.');
