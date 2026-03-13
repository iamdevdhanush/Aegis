// Aegis v2 — Warning System
// Queued, deduplicated, in-page warning banners

export class WarningSystem {
  constructor() {
    this._cd   = {};
    this._hist = [];
  }

  warn(msg, type = 'danger') {
    const key = msg.substr(0,40);
    if (this._cooldown(key, 4000)) return;
    this._hist.push({ msg, type, ts: new Date().toISOString() });
    this._showInTab(msg);
    chrome.runtime.sendMessage({ type:'LOG_EVENT', payload:{ eventType:'WARNING_SHOWN', metadata:{ msg } } }).catch(()=>{});
  }

  async _showInTab(msg) {
    try {
      const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type:'SHOW_WARNING', payload:{ message: msg } }).catch(()=>{});
    } catch {}
  }

  history()   { return this._hist; }
  clearHist() { this._hist = []; }

  _cooldown(key, ms) {
    if (this._cd[key] && Date.now()-this._cd[key] < ms) return true;
    this._cd[key] = Date.now();
    return false;
  }
}
