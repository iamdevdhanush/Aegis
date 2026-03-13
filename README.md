# 🛡 Aegis v2 — Enterprise Exam Guardrail System

A complete Chrome Extension (Manifest V3) providing enterprise-grade, real-time exam integrity monitoring.

---

## What's New in v2

| Feature | v1 | v2 |
|---|---|---|
| Fullscreen enforcement | ✗ | ✅ Auto-request + auto-restore |
| In-page overlay panel | ✗ | ✅ Top-right live dashboard |
| Floating camera preview | ✗ | ✅ 160×120 top-left feed |
| Fullscreen Monitor module | ✗ | ✅ fullscreenMonitor.js |
| Clipboard Monitor module | ✗ | ✅ clipboardMonitor.js |
| Overlay UI module | ✗ | ✅ overlayUI.js |
| Event Streamer service | ✗ | ✅ eventStreamer.js |
| Analytics Engine service | ✗ | ✅ analyticsEngine.js |
| Pattern detection | ✗ | ✅ Copy+paste pairs, face clusters |
| B2B dashboard export | ✗ | ✅ exportForDashboard() |
| Violation analytics grid | ✗ | ✅ Tab/Copy/FS/Face counters |

---

## Project Structure

```
aegis-extension/
├── manifest.json
├── background.js           Service worker — session, API, tab events
├── content.js              Injected script — overlay, monitors, warnings
├── popup.html / .css / .js Extension popup dashboard
├── modules/
│   ├── integrityEngine.js  Score + risk classification
│   ├── eventLogger.js      Event storage + timeline
│   ├── cameraMonitor.js    Webcam face detection
│   ├── voiceMonitor.js     Mic speech detection
│   ├── fullscreenMonitor.js Fullscreen enforcement
│   ├── clipboardMonitor.js Copy/paste/keyboard interception
│   ├── overlayUI.js        In-page panel + camera preview DOM
│   ├── tabMonitor.js       Tab/window focus monitoring
│   └── warningSystem.js    In-page warning banners
└── services/
    ├── eventStreamer.js     Batched API delivery + retry
    └── analyticsEngine.js  Pattern detection + B2B reports
```

---

## Integrity Scoring

| Violation | Penalty |
|---|---|
| Exit Fullscreen | −15 |
| Copy Attempt | −15 |
| Multiple Tabs | −20 |
| Page Refresh | −15 |
| Face Not Detected | −20 |
| Multiple Faces | −18 |
| Tab Switch | −10 |
| Keyboard Shortcut | −10 |
| Voice Detected | −10 |
| Camera Disabled | −15 |
| Window Blur | −8 |
| Looking Away | −8 |
| Mic Disabled | −10 |
| Right Click | −5 |

---

## Risk Profiles (Analytics Engine)

| Composite Score | Profile |
|---|---|
| < 10 | CLEAN |
| 10–25 | LOW_RISK |
| 25–50 | SUSPICIOUS |
| 50–80 | HIGH_RISK |
| 80+ | CRITICAL |

---

## Installation

1. Go to `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select `aegis-extension/`
4. Pin from the 🧩 toolbar menu

---

## Backend Integration

Edit `background.js` line 4:
```js
const BACKEND_ENDPOINT = 'https://your-backend.com/api';
```

### Endpoints expected
- `POST /api/event` — single event
- `POST /api/events/batch` — array of events
- `POST /api/heartbeat` — session heartbeat
- `POST /api/session/close` — session end

### Event payload
```json
{
  "id": "EVT-ABC123",
  "studentId": "STU-XYZ",
  "examId": "EXM-001",
  "eventType": "EXIT_FULLSCREEN",
  "severity": "HIGH",
  "metadata": { "exitCount": 1 },
  "timestamp": "2024-01-15T10:14:22.000Z"
}
```

---

## ZIP

```bash
zip -r aegis-extension.zip aegis-extension/
```
