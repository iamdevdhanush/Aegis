// Aegis v2 — Integrity Engine
// Real-time score management, risk classification, and threshold alerts

export class IntegrityEngine {
  constructor(onUpdate) {
    this.score      = 100;
    this.violations = 0;
    this.onUpdate   = onUpdate || (() => {});
    this.thresholdsFired = new Set();

    this.PENALTIES = {
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

    this._load();
  }

  async _load() {
    return new Promise(r => chrome.storage.local.get(['integrityScore','violations'], res => {
      this.score      = res.integrityScore ?? 100;
      this.violations = res.violations     ?? 0;
      r();
    }));
  }

  apply(eventType) {
    const delta     = this.PENALTIES[eventType] ?? -5;
    this.score      = Math.max(0, Math.min(100, this.score + delta));
    this.violations++;
    const level     = this.level();
    this._persist(level);
    this._checkThresholds(level);
    this.onUpdate({ score: this.score, level, violations: this.violations, delta, eventType });
    return { score: this.score, level, delta };
  }

  applyCustom(delta, reason = 'CUSTOM') {
    this.score = Math.max(0, Math.min(100, this.score + delta));
    const level = this.level();
    this._persist(level);
    this.onUpdate({ score: this.score, level, violations: this.violations, delta, reason });
    return { score: this.score, level };
  }

  level() {
    if (this.score >= 90) return 'SAFE';
    if (this.score >= 75) return 'LOW_RISK';
    if (this.score >= 50) return 'SUSPICIOUS';
    return 'HIGH_RISK';
  }

  summary() {
    return { score: this.score, violations: this.violations, level: this.level() };
  }

  _persist(level) {
    chrome.storage.local.set({ integrityScore: this.score, violations: this.violations, riskLevel: level });
  }

  _checkThresholds(level) {
    if (!this.thresholdsFired.has(level) && ['SUSPICIOUS','HIGH_RISK'].includes(level)) {
      this.thresholdsFired.add(level);
      chrome.runtime.sendMessage({
        type: 'LOG_VIOLATION',
        payload: { eventType: `THRESHOLD_${level}`, metadata: { score: this.score } }
      }).catch(() => {});
    }
  }
}
