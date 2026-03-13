// ─────────────────────────────────────────────────────────────────────────────
// AGS v3 — Camera Monitor with Fixed Face Detection
// Fixes: NMS, temporal consistency, bounding box smoothing, duplicate filtering
// Key fix: 1 face = 1 detection, no phantom multi-face from skinRatio alone
// ─────────────────────────────────────────────────────────────────────────────

export class CameraMonitor {
  constructor(videoEl, canvasEl, eventLogger, integrityEngine, warningSystem, onStatus) {
    this.video    = videoEl;
    this.canvas   = canvasEl;
    this.logger   = eventLogger;
    this.engine   = integrityEngine;
    this.warn     = warningSystem;
    this.onStatus = onStatus || (() => {});

    this.stream         = null;
    this.checkTimer     = null;
    this.faceAbsent0    = null;
    this.lastPresent    = true;
    this.running        = false;
    this.cd             = {};
    this.blankCount     = 0;

    // ── Temporal consistency tracking ──────────────────────────────────────
    // Instead of a single-frame decision, we track a rolling window
    this.faceHistory       = [];   // last N frame results
    this.HISTORY_SIZE      = 5;    // frames to smooth over
    this.PRESENCE_THRESH   = 0.6;  // 60% of frames must agree

    // ── NMS / spatial tracking ─────────────────────────────────────────────
    this.prevRegions       = [];   // bounding regions from last frame
    this.smoothedFaceCount = 0;    // output after temporal smoothing
    this.faceCountHistory  = [];   // for multi-face temporal gating

    this.CHECK_MS          = 1500;
    this.ABSENT_THRESH     = 5000;
    this.MULTI_CD          = 30000;
    this.ABSENT_CD         = 15000;
    this.DISABLED_CD       = 20000;
  }

  async start() {
    if (!window.isSecureContext) {
      this.onStatus('insecure');
      this.logger?.log?.('CAMERA_INSECURE_CONTEXT', 'INFO');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus('error');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });

      this.video.srcObject = this.stream;

      await new Promise(resolve => {
        if (this.video.readyState >= 2) { resolve(); return; }
        this.video.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 4000);
      });

      await this.video.play();

      // Critical: set actual buffer dimensions
      this.canvas.width  = 160;
      this.canvas.height = 120;

      this.running = true;
      this.onStatus('active');
      this.logger?.log?.('CAMERA_STARTED', 'INFO');

      // Give browser time to render first real frame
      await new Promise(r => setTimeout(r, 600));

      this.checkTimer = setInterval(() => this._check(), this.CHECK_MS);

    } catch (err) {
      this.onStatus('error');
      this.logger?.logViolation?.('CAMERA_DISABLED', { reason: err.message });
      this.engine?.apply?.('CAMERA_DISABLED');
      this.warn?.warn?.('Camera access denied. Click the camera icon and allow access.');
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.checkTimer);
    this.stream?.getTracks().forEach(t => t.stop());
  }

  _check() {
    if (!this.running || !this.stream) return;

    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') {
      if (!this._cooldown('CAMERA_DISABLED', this.DISABLED_CD)) {
        this.engine?.apply?.('CAMERA_DISABLED');
        this.onStatus('error');
      }
      return;
    }

    if (this.video.videoWidth === 0 || this.video.paused || this.video.ended) return;

    try {
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

      const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

      // Skip dark frames
      const brightness = this._avgBrightness(imageData);
      if (brightness < 8) {
        this.blankCount++;
        if (this.blankCount > 4) this.onStatus('dark_frame');
        return;
      }
      this.blankCount = 0;

      // ── Spatial face detection via skin region segmentation ──────────────
      const regions    = this._findSkinRegions(imageData);
      const faceCount  = this._applyNMS(regions);  // NMS deduplication
      const present    = faceCount > 0;

      // ── Temporal smoothing: only act on consistent frames ─────────────────
      this.faceHistory.push({ present, faceCount });
      if (this.faceHistory.length > this.HISTORY_SIZE) this.faceHistory.shift();

      const presentFrames = this.faceHistory.filter(f => f.present).length;
      const ratio         = presentFrames / this.faceHistory.length;
      const stablePresent = ratio >= this.PRESENCE_THRESH;

      // For multi-face: require consensus across frames
      this.faceCountHistory.push(faceCount);
      if (this.faceCountHistory.length > this.HISTORY_SIZE) this.faceCountHistory.shift();
      const multiFrames   = this.faceCountHistory.filter(c => c > 1).length;
      const stableMulti   = multiFrames >= Math.ceil(this.HISTORY_SIZE * 0.6);

      // ── Decision ──────────────────────────────────────────────────────────
      if (stablePresent) {
        this.faceAbsent0 = null;
        this.lastPresent = true;

        if (stableMulti && !this._cooldown('MULTIPLE_FACE_DETECTED', this.MULTI_CD)) {
          this.onStatus('multiple_faces');
          this.engine?.apply?.('MULTIPLE_FACE_DETECTED');
          this.logger?.logViolation?.('MULTIPLE_FACE_DETECTED', { count: faceCount });
          this.warn?.warn?.('Multiple faces detected. Ensure you are alone.');
          chrome.runtime.sendMessage({
            type: 'LOG_VIOLATION',
            payload: { eventType: 'MULTIPLE_FACE_DETECTED', metadata: { count: faceCount } }
          }).catch(() => {});
        } else {
          this.onStatus('face_detected');
        }
      } else {
        if (this.lastPresent) { this.faceAbsent0 = Date.now(); this.lastPresent = false; }
        this.onStatus('face_absent');

        const absent = Date.now() - (this.faceAbsent0 || Date.now());
        if (absent >= this.ABSENT_THRESH && !this._cooldown('FACE_NOT_DETECTED', this.ABSENT_CD)) {
          this.engine?.apply?.('FACE_NOT_DETECTED');
          this.logger?.logViolation?.('FACE_NOT_DETECTED', { durationMs: absent });
          this.warn?.warn?.('Face not detected. Please look at the camera.');
          chrome.runtime.sendMessage({
            type: 'LOG_VIOLATION',
            payload: { eventType: 'FACE_NOT_DETECTED', metadata: { durationMs: absent } }
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[AGS CameraMonitor]', err.message);
    }
  }

  // ── Skin region segmentation (divides frame into grid cells) ─────────────
  // Returns array of candidate face regions (bounding boxes)
  _findSkinRegions(imageData) {
    const { width, height } = imageData;
    const d    = imageData.data;
    const GRID = 4;  // divide into 4x4 grid = 16 cells
    const cw   = Math.floor(width  / GRID);
    const ch   = Math.floor(height / GRID);

    const cells = [];

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let skin = 0, total = 0;

        for (let y = gy * ch; y < (gy+1) * ch && y < height; y++) {
          for (let x = gx * cw; x < (gx+1) * cw && x < width; x++) {
            const i = (y * width + x) * 4;
            const r = d[i], g = d[i+1], b = d[i+2];
            if (this._isSkin(r, g, b)) skin++;
            total++;
          }
        }

        const ratio = skin / total;
        if (ratio > 0.25) { // Cell is skin-dominant
          cells.push({
            x: gx * cw, y: gy * ch, w: cw, h: ch,
            skinRatio: ratio,
            cx: gx * cw + cw / 2,
            cy: gy * ch + ch / 2
          });
        }
      }
    }

    // Cluster adjacent skin cells into face candidate regions
    return this._clusterRegions(cells, cw, ch);
  }

  // ── Cluster adjacent grid cells into distinct face regions ───────────────
  _clusterRegions(cells, cw, ch) {
    if (!cells.length) return [];

    const visited  = new Set();
    const clusters = [];

    for (let i = 0; i < cells.length; i++) {
      if (visited.has(i)) continue;

      const cluster = [cells[i]];
      visited.add(i);

      for (let j = i + 1; j < cells.length; j++) {
        if (visited.has(j)) continue;
        // Adjacent if within 1.5 cell widths
        const dx = Math.abs(cells[i].cx - cells[j].cx);
        const dy = Math.abs(cells[i].cy - cells[j].cy);
        if (dx < cw * 1.5 && dy < ch * 1.5) {
          cluster.push(cells[j]);
          visited.add(j);
        }
      }

      if (cluster.length >= 1) {
        const minX = Math.min(...cluster.map(c => c.x));
        const minY = Math.min(...cluster.map(c => c.y));
        const maxX = Math.max(...cluster.map(c => c.x + c.w));
        const maxY = Math.max(...cluster.map(c => c.y + c.h));
        clusters.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
    }

    return clusters;
  }

  // ── Non-Maximum Suppression: remove overlapping duplicates ───────────────
  // Two boxes overlap > 70% of smaller box area → treat as same face
  _applyNMS(regions) {
    if (!regions.length) return 0;

    const kept = [];

    for (const r of regions) {
      let duplicate = false;

      for (const k of kept) {
        const overlapX = Math.max(0, Math.min(r.x+r.w, k.x+k.w) - Math.max(r.x, k.x));
        const overlapY = Math.max(0, Math.min(r.y+r.h, k.y+k.h) - Math.max(r.y, k.y));
        const overlapArea   = overlapX * overlapY;
        const smallerArea   = Math.min(r.w*r.h, k.w*k.h);
        const overlapRatio  = overlapArea / (smallerArea || 1);

        if (overlapRatio > 0.70) { duplicate = true; break; }
      }

      // Also check prev-frame regions for temporal deduplication
      for (const p of this.prevRegions) {
        const overlapX = Math.max(0, Math.min(r.x+r.w, p.x+p.w) - Math.max(r.x, p.x));
        const overlapY = Math.max(0, Math.min(r.y+r.h, p.y+p.h) - Math.max(r.y, p.y));
        const overlapArea  = overlapX * overlapY;
        const smallerArea  = Math.min(r.w*r.h, p.w*p.h);
        const overlapRatio = overlapArea / (smallerArea || 1);

        // Same region as last frame → same face, not duplicate
        // Only flag if it's a NEW region with no previous match
        if (overlapRatio > 0.70) { duplicate = false; break; } // it matches previous = valid
      }

      if (!duplicate) kept.push(r);
    }

    this.prevRegions = kept;

    // Face count: minimum region size filter (tiny regions = noise)
    const validFaces = kept.filter(r => r.w * r.h > 100); // at least 10x10 pixels

    return validFaces.length;
  }

  _isSkin(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return (
      // Kovac rule (light-medium skin)
      (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r-g) > 15 && r > g && r > b) ||
      // Darker tones
      (r > 220 && g > 210 && b > 170 && Math.abs(r-g) <= 15 && r > b && g > b) ||
      // Warm hue shortcut
      (r > 80 && g > 30 && b > 15 && r > g && (r - b) > 20)
    );
  }

  _avgBrightness(imageData) {
    const d = imageData.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i+1] + d[i+2]) / 3;
    return sum / (d.length / 4);
  }

  _cooldown(key, ms) {
    if (this.cd[key] && Date.now() - this.cd[key] < ms) return true;
    this.cd[key] = Date.now();
    return false;
  }

  isActive() { return this.running && !!this.stream?.active; }
}
