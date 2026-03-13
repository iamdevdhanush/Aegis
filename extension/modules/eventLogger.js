// Aegis v2 — Event Logger
// Centralised event storage, violation logging, timeline generation

export class EventLogger {
  constructor(onEvent) {
    this.events   = [];
    this.onEvent  = onEvent || (() => {});
    this.MAX      = 500;
    this._load();
  }

  async _load() {
    return new Promise(r => chrome.storage.local.get('events', res => {
      this.events = res.events || [];
      r();
    }));
  }

  log(eventType, severity = 'INFO', metadata = {}) {
    const event = {
      id:        this._id(),
      eventType,
      severity,
      metadata,
      timestamp: new Date().toISOString(),
      hhmm:      this._hhmm()
    };
    this.events.push(event);
    if (this.events.length > this.MAX) this.events.splice(0, this.events.length - this.MAX);
    this._persist();
    this.onEvent(event);
    chrome.runtime.sendMessage({ type:'LOG_EVENT', payload:{ eventType, metadata } }).catch(()=>{});
    return event;
  }

  logViolation(eventType, metadata = {}) {
    const HIGH   = new Set(['MULTIPLE_TABS','MULTIPLE_FACES','COPY_ATTEMPT','PAGE_REFRESH','CAMERA_DISABLED','EXIT_FULLSCREEN','FACE_NOT_DETECTED']);
    const MEDIUM = new Set(['TAB_SWITCH','WINDOW_BLUR','VOICE_DETECTED','KEYBOARD_SHORTCUT']);
    const sev    = HIGH.has(eventType) ? 'HIGH' : MEDIUM.has(eventType) ? 'MEDIUM' : 'LOW';
    chrome.runtime.sendMessage({ type:'LOG_VIOLATION', payload:{ eventType, metadata } }).catch(()=>{});
    return this.log(eventType, sev, metadata);
  }

  timeline()         { return this.events.map(e => ({ time:e.hhmm, type:e.eventType, severity:e.severity })); }
  violations()       { return this.events.filter(e => e.severity !== 'INFO'); }
  recent(n = 20)     { return this.events.slice(-n); }
  clear()            { this.events = []; this._persist(); }

  summary() {
    const counts = {};
    this.violations().forEach(v => { counts[v.eventType] = (counts[v.eventType]||0)+1; });
    return { total: this.events.length, violations: this.violations().length, breakdown: counts };
  }

  _persist() { chrome.storage.local.set({ events: this.events }); }
  _id()      { return Date.now().toString(36)+Math.random().toString(36).substr(2,5); }
  _hhmm()    { const d=new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
}
