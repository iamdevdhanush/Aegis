// Aegis v2 — Overlay UI Module
// Manages the in-page monitoring panel and floating camera preview

export class OverlayUI {
  constructor() {
    this.panel    = null;
    this.preview  = null;
    this.events   = [];
    this._timer   = null;
    this._start   = null;
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  mountPanel() {
    if (document.getElementById('__aegis_panel__')) return;

    this.panel = document.createElement('div');
    this.panel.id = '__aegis_panel__';
    this.panel.innerHTML = this._panelHTML();
    document.body.appendChild(this.panel);

    this._start = Date.now();
    this._timer = setInterval(() => {
      const s  = Math.floor((Date.now()-this._start)/1000);
      const el = document.getElementById('__aeg_elapsed__');
      if (el) el.textContent = `${this._pad(Math.floor(s/60))}:${this._pad(s%60)}`;
    }, 1000);
  }

  unmountPanel() {
    this.panel?.remove();
    if (this._timer) clearInterval(this._timer);
  }

  setScore(score) {
    const el = document.getElementById('__aeg_score__');
    if (!el) return;
    el.textContent = score;
    el.style.color = score>=75 ? '#22C55E' : score>=50 ? '#F59E0B' : '#EF4444';
  }

  setViolations(n) {
    const el = document.getElementById('__aeg_viols__');
    if (el) el.textContent = n;
  }

  setStatus(type, text, state) {
    // type: 'cam' | 'mic' | 'fs'   state: 'ok' | 'warn' | 'error'
    const t = document.getElementById(`__aeg_${type}__`);
    const d = document.getElementById(`__aeg_dot_${type}__`);
    if (t) t.textContent = text;
    if (d) { d.className = 'aeg-s-dot'; d.classList.add(`aeg-dot-${state}`); }
  }

  pushEvent(eventType, ts) {
    this.events.unshift({ eventType, ts });
    if (this.events.length > 8) this.events.pop();
    const tl = document.getElementById('__aeg_timeline__');
    if (!tl) return;
    tl.innerHTML = this.events.map(e =>
      `<div class="aeg-tl-row"><span class="aeg-tl-time">${e.ts}</span><span class="aeg-tl-event">${e.eventType.replace(/_/g,' ')}</span></div>`
    ).join('');
  }

  // ── Camera Preview ────────────────────────────────────────────────────────

  mountPreview(stream) {
    if (document.getElementById('__aegis_cam_preview__')) return;

    this.preview = document.createElement('div');
    this.preview.id = '__aegis_cam_preview__';
    this.preview.innerHTML = `
      <div class="aeg-cam-badge">◉ LIVE</div>
      <video id="__aeg_video__" autoplay muted playsinline style="width:160px;height:120px;object-fit:cover;display:block;transform:scaleX(-1);"></video>
      <canvas id="__aeg_canvas__" style="display:none;width:160px;height:120px;"></canvas>
      <div class="aeg-cam-label" id="__aeg_face_label__">Detecting...</div>
    `;
    document.body.appendChild(this.preview);

    const video = document.getElementById('__aeg_video__');
    video.srcObject = stream;
    video.play().catch(() => {});
  }

  setFaceLabel(text) {
    const el = document.getElementById('__aeg_face_label__');
    if (el) el.textContent = text;
  }

  unmountPreview() { this.preview?.remove(); }

  // ── Internal ──────────────────────────────────────────────────────────────

  _panelHTML() {
    return `
      <div class="aeg-panel-header"><span class="aeg-panel-logo">⬡</span><span class="aeg-panel-title">AEGIS SECURE MODE</span><span class="aeg-panel-pulse"></span></div>
      <div class="aeg-score-row"><span class="aeg-score-label">Integrity Score</span><span class="aeg-score-val" id="__aeg_score__">100</span></div>
      <div class="aeg-status-list">
        <div class="aeg-status-row"><span class="aeg-s-dot aeg-dot-ok" id="__aeg_dot_cam__"></span><span class="aeg-s-label">Camera</span><span class="aeg-s-state" id="__aeg_cam__">Active</span></div>
        <div class="aeg-status-row"><span class="aeg-s-dot aeg-dot-ok" id="__aeg_dot_mic__"></span><span class="aeg-s-label">Microphone</span><span class="aeg-s-state" id="__aeg_mic__">Active</span></div>
        <div class="aeg-status-row"><span class="aeg-s-dot aeg-dot-ok" id="__aeg_dot_fs__"></span><span class="aeg-s-label">Fullscreen</span><span class="aeg-s-state" id="__aeg_fs__">Active</span></div>
      </div>
      <div class="aeg-violations-row"><span>Violations</span><span class="aeg-viol-count" id="__aeg_viols__">0</span></div>
      <div class="aeg-timeline-header">Recent Activity</div>
      <div class="aeg-timeline" id="__aeg_timeline__"><div class="aeg-tl-empty">Monitoring active...</div></div>
      <div class="aeg-footer" id="__aeg_elapsed__">00:00</div>
    `;
  }

  _pad(n) { return String(n).padStart(2,'0'); }
}
