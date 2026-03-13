// Aegis v2 — Fullscreen Monitor
// Enforces fullscreen during exam; logs exits and attempts restoration

export class FullscreenMonitor {
  constructor(eventLogger, integrityEngine, warningSystem, onStatus) {
    this.logger    = eventLogger;
    this.engine    = integrityEngine;
    this.warnings  = warningSystem;
    this.onStatus  = onStatus || (() => {});
    this._handler  = null;
    this.running   = false;
    this.exitCount = 0;
  }

  start() {
    this.running   = true;
    this._handler  = () => this._onChange();
    document.addEventListener('fullscreenchange',       this._handler);
    document.addEventListener('webkitfullscreenchange', this._handler);
    this._request();
    this.logger.log('FULLSCREEN_MONITOR_STARTED', 'INFO');
  }

  stop() {
    this.running = false;
    document.removeEventListener('fullscreenchange',       this._handler);
    document.removeEventListener('webkitfullscreenchange', this._handler);
    document.exitFullscreen?.().catch(() => {});
  }

  isActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  _request() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { this.onStatus('unsupported'); return; }

    req.call(el).then(() => {
      this.onStatus('active');
    }).catch(err => {
      this.onStatus('denied');
      this.warnings.warn('Fullscreen could not be activated. Please enable it manually.', 'danger');
      this.logger.log('FULLSCREEN_DENIED', 'MEDIUM', { reason: err.message });
    });
  }

  _onChange() {
    if (!this.running) return;

    if (!this.isActive()) {
      this.exitCount++;
      this.engine.apply('EXIT_FULLSCREEN');
      this.logger.logViolation('EXIT_FULLSCREEN', { exitCount: this.exitCount });
      this.warnings.warn(`⚠ Fullscreen exited (×${this.exitCount}). Restoring...`);
      this.onStatus('exited');

      // Auto-restore after 800ms
      setTimeout(() => {
        if (!this.running) return;
        this._request();
      }, 800);
    } else {
      this.onStatus('active');
    }
  }
}
