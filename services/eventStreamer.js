// Aegis v2 — Event Streamer Service
// Handles real-time and batched event delivery to the backend

export class EventStreamer {
  constructor(endpoint, options = {}) {
    this.endpoint  = endpoint;
    this.queue     = [];
    this.maxQueue  = options.maxQueue    || 200;
    this.batchSize = options.batchSize   || 20;
    this.retryMs   = options.retryMs     || 5000;
    this.headers   = {
      'Content-Type': 'application/json',
      'X-Aegis-Version': '2.0.0',
      ...(options.headers || {})
    };

    this._retryTimer = null;
    this._online     = true;

    // Monitor network
    window.addEventListener('online',  () => { this._online = true;  this._flushRetry(); });
    window.addEventListener('offline', () => { this._online = false; });
  }

  // ── Single event (fire-and-forget) ───────────────────────────────────────

  async send(event) {
    if (!this._online) { this._enqueue(event); return; }
    try {
      const res = await fetch(`${this.endpoint}/event`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(event)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      this._enqueue(event);
    }
  }

  // ── Batch flush ──────────────────────────────────────────────────────────

  async flush() {
    if (!this.queue.length || !this._online) return;

    const batch = this.queue.splice(0, this.batchSize);
    try {
      const res = await fetch(`${this.endpoint}/events/batch`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ events: batch })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      this.queue.unshift(...batch); // re-queue
      this._scheduleRetry();
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  async heartbeat(payload) {
    if (!this._online) return;
    try {
      await fetch(`${this.endpoint}/heartbeat`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ ...payload, ts: new Date().toISOString() })
      });
    } catch { /* offline */ }
  }

  // ── Session close ────────────────────────────────────────────────────────

  async closeSession(sessionSummary) {
    try {
      await fetch(`${this.endpoint}/session/close`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(sessionSummary)
      });
    } catch { /* best-effort */ }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _enqueue(event) {
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push(event);
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.flush();
    }, this.retryMs);
  }

  _flushRetry() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.flush();
  }

  queueSize()  { return this.queue.length; }
  isOnline()   { return this._online; }
  pendingQueue() { return [...this.queue]; }
}
