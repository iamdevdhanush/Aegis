# ◈ AGS v3 — AI Guardrail System

> AI-powered exam integrity platform: Chrome Extension + FastAPI backend + Cyber Admin Dashboard

---

## Platform Architecture

```
AGS PLATFORM v3
│
├── extension/                  Chrome Extension (Manifest V3)
│   ├── manifest.json           Permissions + config
│   ├── background.js           Service worker: AI scoring, events, heartbeat
│   ├── content.js              Page injection: monitors, face detection, UI
│   ├── popup.html/css/js       Extension popup dashboard
│   └── modules/
│       ├── cameraMonitor.js    Fixed face detection (NMS + temporal)
│       └── sentinelMonitor.js  Screen capture, DevTools, overlay detection
│
├── backend/                    Python FastAPI Server
│   ├── main.py                 App entry + WebSocket streaming
│   ├── requirements.txt
│   ├── routers/
│   │   ├── events.py           POST /events, /events/batch, /heartbeat
│   │   ├── students.py         GET /students, /students/{id}/events + report
│   │   ├── analytics.py        GET /analytics/overview, /risk-distribution
│   │   └── exam.py             POST /exam/start, /exam/end
│   ├── models/
│   │   └── database.py         SQLite via aiosqlite (auto-created)
│   └── services/
│       ├── ai_engine.py        Cheating probability + behavior risk scoring
│       ├── connection_manager.py  WebSocket broadcast manager
│       └── nlp_query.py        Natural language admin query parser
│
└── dashboard/
    └── index.html              Cyber-style Admin Command Center (standalone HTML)
```

---

## Features

### Extension (v3)
| Feature | Status |
|---|---|
| Face detection (NMS + temporal) | ✅ Fixed — 1 face = 1 detection |
| MULTIPLE_FACE_DETECTED event | ✅ Replaces old MULTIPLE_FACES |
| Screen capture detection | ✅ getDisplayMedia hook + focus patterns |
| DevTools detection | ✅ Size heuristic + keyboard interception |
| Overlay extension detection | ✅ MutationObserver |
| Mouse velocity tracking | ✅ Sent to background for anomaly detection |
| Behavior anomaly detection | ✅ AI baseline + deviation firing |
| AI score display in popup | ✅ Cheat probability + behavior risk bars |
| Idle detection | ✅ 2-minute idle → IDLE event |

### Backend (FastAPI)
| Endpoint | Method | Description |
|---|---|---|
| `/events` | POST | Receive single monitoring event |
| `/events/batch` | POST | Receive batch of events |
| `/heartbeat` | POST | Session heartbeat |
| `/exam/start` | POST | Start exam session |
| `/exam/end` | POST | End exam session |
| `/students` | GET | List all students |
| `/students/{id}` | GET | Student detail |
| `/students/{id}/events` | GET | Student event log |
| `/students/{id}/report` | GET | Full integrity report |
| `/analytics/overview` | GET | Platform overview stats |
| `/analytics/risk-distribution` | GET | Risk level breakdown |
| `/analytics/violation-heatmap` | GET | Hourly violation counts |
| `/ws/{client_id}` | WS | Live admin dashboard stream |

### Admin Command Center
| Feature | Description |
|---|---|
| Live student grid | Risk level, trust score, violations, cheat probability |
| Live violation feed | Real-time event stream with severity coloring |
| Student session timeline | Full event log + replay mode |
| NLP query bar | `"show high risk students"`, `"who switched tabs more than 3 times"` |
| AI scores panel | Cheat probability, behavior risk, integrity score bars |
| Risk distribution chart | Doughnut chart (Chart.js) |
| Violation heatmap | Hourly bar chart |
| Violation breakdown | Top violation types bar chart |
| Session replay | Animated timeline replay |
| Integrity report | Auto-generates printable report |
| CSV export | Download student data |

---

## Face Detection Fix (Key Technical Change)

**Problem:** The original system used a global `skinRatio > 0.28` threshold to detect "multiple faces", which was unreliable — high skin coverage from lighting or angle could falsely trigger MULTIPLE_FACES.

**Fix — Three-layer approach:**

1. **Spatial Grid Segmentation**: Divides frame into 4×4 grid cells, identifies skin-dominant cells (>25% skin pixels per cell).

2. **Region Clustering**: Adjacent skin cells are merged into candidate face regions (bounding boxes).

3. **NMS (Non-Maximum Suppression)**: Overlapping regions with >70% IoU are deduplicated. If two detections share >70% area, they are the same face.

4. **Temporal Consistency**: Decision requires consensus across 5 frames (≥60% agreement). A single noisy frame cannot trigger MULTIPLE_FACE_DETECTED.

**Result:** 1 face reliably = 1 detection. False positives eliminated.

---

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
python main.py
# Server starts at http://localhost:8000
# API docs at http://localhost:8000/docs
```

### 2. Extension

1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select `extension/`
4. Pin from the 🧩 toolbar menu

> Backend endpoint is configured in `extension/background.js` line 4:
> ```js
> const BACKEND_ENDPOINT = 'http://localhost:8000';
> ```

### 3. Admin Dashboard

Open `dashboard/index.html` directly in Chrome, or serve:

```bash
cd dashboard
python -m http.server 3000
# Open http://localhost:3000
```

The dashboard connects to the backend WebSocket at `ws://localhost:8000/ws/{client_id}` automatically.

---

## Event Types

| Event | Severity | Description |
|---|---|---|
| `TAB_SWITCH` | MEDIUM | Student switched tabs |
| `MULTIPLE_TABS` | HIGH | New tab opened |
| `EXIT_FULLSCREEN` | HIGH | Fullscreen exited |
| `COPY_ATTEMPT` | HIGH | Ctrl+C or clipboard copy |
| `PASTE_ATTEMPT` | MEDIUM | Ctrl+V |
| `KEYBOARD_SHORTCUT` | MEDIUM | Dangerous key combo |
| `FACE_NOT_DETECTED` | HIGH | Face absent >5 seconds |
| `MULTIPLE_FACE_DETECTED` | HIGH | Multiple faces confirmed |
| `VOICE_DETECTED` | MEDIUM | Sustained speech >5s |
| `CAMERA_DISABLED` | HIGH | Camera denied or stopped |
| `MIC_DISABLED` | HIGH | Microphone denied |
| `SCREEN_CAPTURE_ATTEMPT` | HIGH | getDisplayMedia called |
| `DEVTOOLS_OPEN` | HIGH | DevTools opened |
| `OVERLAY_EXTENSION_DETECTED` | HIGH | Suspicious DOM injection |
| `BEHAVIOR_ANOMALY` | MEDIUM | Mouse velocity deviation from baseline |
| `IDLE` | LOW | No interaction for 2 minutes |
| `WINDOW_RESIZE` | MEDIUM | Browser window resized |
| `PAGE_REFRESH` | HIGH | Page reload attempted |
| `RIGHT_CLICK` | LOW | Context menu attempt |

---

## NLP Query Examples

```
show high risk students
who switched tabs more than 5 times
students with multiple face detection
show suspicious students
cheat probability above 60
show all students
worst students
```

---

## AI Scoring

**Cheating Probability** is computed from weighted signals:

| Signal | Max Contribution |
|---|---|
| Tab switch rate (per min) | 25 |
| Keyboard shortcuts | 15 |
| Fullscreen exits | 20 |
| Face absence rate | 20 |
| Multiple faces confirmed | 16 |
| Screen capture attempts | 30 |
| DevTools openings | 20 |
| Score loss | ~40 |

Outputs: `cheatingProbability (0-100)`, `behaviorRiskScore (0-100)`, `integrityConfidence (0-100)`

---

## Changelog: v2 → v3

- **Face detection**: Replaced global skinRatio with spatial NMS + temporal smoothing
- **Event name**: `MULTIPLE_FACES` → `MULTIPLE_FACE_DETECTED`  
- **New events**: `SCREEN_CAPTURE_ATTEMPT`, `DEVTOOLS_OPEN`, `OVERLAY_EXTENSION_DETECTED`, `BEHAVIOR_ANOMALY`, `IDLE`, `WINDOW_RESIZE`
- **Backend**: FastAPI + SQLite — complete backend implementation
- **Admin dashboard**: Cyber-style command center with live WebSocket streaming
- **AI engine**: Cheating probability + behavior risk scoring
- **NLP queries**: Natural language admin query parser
- **Mouse tracking**: Velocity telemetry + anomaly detection
- **Session replay**: Animated timeline replay for any student
- **Reports**: Auto-generated integrity reports + CSV export
