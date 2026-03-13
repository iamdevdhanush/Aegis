// Aegis v2 — Tab Monitor

export class TabMonitor {
  constructor(eventLogger, integrityEngine, warningSystem) {
    this.logger   = eventLogger;
    this.engine   = integrityEngine;
    this.warnings = warningSystem;
    this._h       = {};
    this._cd      = {};
    this.running  = false;
    this.switches = 0;
  }

  start() {
    this.running = true;

    this._h.visibility = () => {
      if (!this.running) return;
      if (document.hidden) {
        this.switches++;
        this._fire('TAB_SWITCH', { switchCount: this.switches });
      }
    };

    this._h.blur = () => {
      if (!this.running || this._cooldown('WINDOW_BLUR', 5000)) return;
      this._fire('WINDOW_BLUR', {});
    };

    document.addEventListener('visibilitychange', this._h.visibility);
    window.addEventListener('blur', this._h.blur);
    this.logger.log('TAB_MONITOR_STARTED', 'INFO');
  }

  stop() {
    this.running = false;
    document.removeEventListener('visibilitychange', this._h.visibility);
    window.removeEventListener('blur', this._h.blur);
  }

  _fire(type, meta) {
    this.logger.logViolation(type, meta);
    this.engine.apply(type);
    this.warnings.warn(this._msg(type));
  }

  _msg(type) {
    return { TAB_SWITCH:'Tab switch detected. Stay on the exam.', WINDOW_BLUR:'Window focus lost. Return to your exam.' }[type] || 'Suspicious activity detected.';
  }

  _cooldown(key, ms) {
    if (this._cd[key] && Date.now()-this._cd[key] < ms) return true;
    this._cd[key] = Date.now();
    return false;
  }
}
