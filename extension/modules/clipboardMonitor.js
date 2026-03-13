// Aegis v2 — Clipboard & Keyboard Monitor
// Intercepts copy/paste/cut, context menu, and dangerous keyboard shortcuts

export class ClipboardMonitor {
  constructor(eventLogger, integrityEngine, warningSystem) {
    this.logger    = eventLogger;
    this.engine    = integrityEngine;
    this.warnings  = warningSystem;
    this._h        = {};
    this.running   = false;
  }

  start() {
    this.running = true;

    this._h.copy        = () => this._fire('COPY_ATTEMPT');
    this._h.paste       = () => this._fire('PASTE_ATTEMPT');
    this._h.cut         = () => this._fire('COPY_ATTEMPT');
    this._h.contextmenu = (e) => { e.preventDefault(); this._fire('RIGHT_CLICK'); };
    this._h.keydown     = (e) => this._onKey(e);
    this._h.beforeprint = ()  => this._fire('KEYBOARD_SHORTCUT', { key: 'PRINT' });

    document.addEventListener('copy',        this._h.copy);
    document.addEventListener('paste',       this._h.paste);
    document.addEventListener('cut',         this._h.cut);
    document.addEventListener('contextmenu', this._h.contextmenu);
    document.addEventListener('keydown',     this._h.keydown);
    window.addEventListener('beforeprint',   this._h.beforeprint);

    this.logger.log('CLIPBOARD_MONITOR_STARTED', 'INFO');
  }

  stop() {
    this.running = false;
    document.removeEventListener('copy',        this._h.copy);
    document.removeEventListener('paste',       this._h.paste);
    document.removeEventListener('cut',         this._h.cut);
    document.removeEventListener('contextmenu', this._h.contextmenu);
    document.removeEventListener('keydown',     this._h.keydown);
    window.removeEventListener('beforeprint',   this._h.beforeprint);
  }

  _onKey(e) {
    if (!this.running) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key  = e.key.toLowerCase();

    // Dangerous combos
    const blocked = [
      ctrl && ['c','v','x','a','p','u','s'].includes(key),
      e.key === 'F12',
      ctrl && e.shiftKey && ['i','j','k'].includes(key),
      ctrl && e.shiftKey && key === 'c'
    ];

    if (blocked.some(Boolean)) {
      e.preventDefault();
      this._fire('KEYBOARD_SHORTCUT', { key: e.key, ctrl, shift: e.shiftKey });
    }
  }

  _fire(type, meta = {}) {
    if (!this.running) return;
    this.logger.logViolation(type, meta);
    this.engine.apply(type);
    this.warnings.warn(this._msg(type));
  }

  _msg(type) {
    return {
      COPY_ATTEMPT:      'Copy/cut actions are not permitted during the exam.',
      PASTE_ATTEMPT:     'Paste is not permitted during the exam.',
      RIGHT_CLICK:       'Right-click is disabled during examination.',
      KEYBOARD_SHORTCUT: 'Keyboard shortcut detected and logged.'
    }[type] || 'Suspicious input detected.';
  }
}
