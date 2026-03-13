// ─────────────────────────────────────────────────────────────────────────────
// AGS v3 — Sentinel Monitor
// Detects: screen capture API, devtools, overlay extensions, focus patterns
// ─────────────────────────────────────────────────────────────────────────────

export class SentinelMonitor {
  constructor(onViolation) {
    this.onViolation     = onViolation || (() => {});
    this.running         = false;
    this.cd              = {};
    this.focusLossHistory = [];
    this.resizeHistory   = [];
    this._handlers       = {};
    this._devtoolsTimer  = null;
    this._screenTimer    = null;
  }

  start() {
    this.running = true;
    this._watchScreenCapture();
    this._watchDevtools();
    this._watchWindowResize();
    this._watchFocusPatterns();
    this._watchOverlayExtensions();
    console.log('[AGS Sentinel] Started');
  }

  stop() {
    this.running = false;
    clearInterval(this._devtoolsTimer);
    clearInterval(this._screenTimer);
    window.removeEventListener('resize',       this._handlers.resize);
    window.removeEventListener('blur',         this._handlers.blur);
    window.removeEventListener('focus',        this._handlers.focus);
    document.removeEventListener('mouseenter', this._handlers.mouseenter);
  }

  // ── Screen capture detection ─────────────────────────────────────────────
  _watchScreenCapture() {
    // Method 1: Hook getDisplayMedia
    const origGetDisplay = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
    if (origGetDisplay && navigator.mediaDevices) {
      navigator.mediaDevices.getDisplayMedia = async (...args) => {
        this._fire('SCREEN_CAPTURE_ATTEMPT', { method: 'getDisplayMedia' });
        // Let it proceed but log it
        return origGetDisplay(...args);
      };
    }

    // Method 2: Detect screen capture via visibility pattern
    // When user alt-tabs to a screen recording tool, there's a distinctive focus pattern
    this._screenTimer = setInterval(() => {
      if (!this.running) return;
      this._checkScreenRecordingHeuristics();
    }, 5000);
  }

  _checkScreenRecordingHeuristics() {
    // Heuristic: page hidden but not minimized, then immediately restored
    // This pattern is common with screen recording software
    const now = Date.now();
    const recent = this.focusLossHistory.filter(t => now - t < 10000);

    if (recent.length >= 3) {
      this._fire('SCREEN_CAPTURE_ATTEMPT', {
        method:    'focus_pattern_heuristic',
        frequency: recent.length
      });
      this.focusLossHistory = [];
    }
  }

  // ── DevTools detection ───────────────────────────────────────────────────
  _watchDevtools() {
    // Method 1: Window size delta (devtools docks shrink window)
    const threshold = 160;
    let lastW = window.outerWidth;
    let lastH = window.outerHeight;

    this._devtoolsTimer = setInterval(() => {
      if (!this.running) return;

      const widthDiff  = window.outerWidth  - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;

      if (widthDiff > threshold || heightDiff > threshold) {
        if (!this._cooldown('DEVTOOLS_OPEN', 30000)) {
          this._fire('DEVTOOLS_OPEN', {
            method: 'size_heuristic',
            widthDiff, heightDiff
          });
        }
      }
    }, 1000);

    // Method 2: toString override detection
    const devToolsCheck = /./;
    devToolsCheck.toString = () => {
      if (!this._cooldown('DEVTOOLS_OPEN_TOSTRING', 60000)) {
        this._fire('DEVTOOLS_OPEN', { method: 'toString_override' });
      }
      return '';
    };
    // Intentionally log to trigger if devtools console is open
    // (Don't spam—this runs once on start)
    console.log('%c', devToolsCheck);

    // Method 3: F12 / Ctrl+Shift+I key detection (also in clipboardMonitor)
    document.addEventListener('keydown', (e) => {
      if (!this.running) return;
      const isDevtools = (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && ['i','j','k','c'].includes(e.key.toLowerCase())) ||
        (e.metaKey && e.altKey && e.key.toLowerCase() === 'i')
      );
      if (isDevtools && !this._cooldown('DEVTOOLS_KEY', 10000)) {
        e.preventDefault();
        this._fire('DEVTOOLS_OPEN', { method: 'keyboard_shortcut', key: e.key });
      }
    });
  }

  // ── Window resize detection ──────────────────────────────────────────────
  _watchWindowResize() {
    this._handlers.resize = () => {
      if (!this.running) return;
      const entry = { w: window.innerWidth, h: window.innerHeight, t: Date.now() };
      this.resizeHistory.push(entry);
      if (this.resizeHistory.length > 20) this.resizeHistory.shift();

      if (!this._cooldown('WINDOW_RESIZE', 3000)) {
        this._fire('WINDOW_RESIZE', {
          width:  window.innerWidth,
          height: window.innerHeight
        });
      }
    };
    window.addEventListener('resize', this._handlers.resize);
  }

  // ── Suspicious focus loss patterns ──────────────────────────────────────
  _watchFocusPatterns() {
    this._handlers.blur = () => {
      if (!this.running) return;
      this.focusLossHistory.push(Date.now());
      if (this.focusLossHistory.length > 50) this.focusLossHistory.shift();
    };
    this._handlers.focus = () => {
      // Focus restored — check for rapid cycling
    };

    window.addEventListener('blur',  this._handlers.blur);
    window.addEventListener('focus', this._handlers.focus);
  }

  // ── Overlay extension detection ──────────────────────────────────────────
  _watchOverlayExtensions() {
    // Detect suspicious DOM injections from other extensions
    const observer = new MutationObserver((mutations) => {
      if (!this.running) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const id    = node.id || '';
          const cls   = node.className || '';
          const style = node.getAttribute?.('style') || '';

          // Heuristic: fixed/absolute positioned overlays injected by extensions
          const isOverlay = (
            style.includes('position: fixed') ||
            style.includes('position:fixed') ||
            style.includes('z-index: 2147483647')
          ) && !id.startsWith('__aegis') && !id.startsWith('__ags');

          // Ignore our own elements
          if (isOverlay && !this._cooldown('OVERLAY_EXTENSION', 30000)) {
            this._fire('OVERLAY_EXTENSION_DETECTED', {
              elementId:  id.substr(0, 50),
              elementTag: node.tagName
            });
          }
        }
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: false
    });
  }

  _fire(eventType, metadata = {}) {
    if (!this.running) return;
    this.onViolation(eventType, metadata);
    chrome.runtime.sendMessage({
      type:    'LOG_VIOLATION',
      payload: { eventType, metadata }
    }).catch(() => {});
  }

  _cooldown(key, ms) {
    if (this.cd[key] && Date.now() - this.cd[key] < ms) return true;
    this.cd[key] = Date.now();
    return false;
  }
}
