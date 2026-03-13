// Aegis v2 — Camera Monitor (fixed)
// Fixes: canvas sizing, loadedmetadata wait, videoWidth guard, improved skin detection

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

    this.CHECK_MS      = 1500;
    this.ABSENT_THRESH = 5000;
    this.MULTI_CD      = 30000;
    this.ABSENT_CD     = 15000;
    this.DISABLED_CD   = 20000;
  }

  async start() {
    if (!window.isSecureContext) {
      this.onStatus('insecure');
      this.logger.log('CAMERA_INSECURE_CONTEXT', 'INFO');
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

      // FIX 1: Wait for canplay before calling play()
      await new Promise(resolve => {
        if (this.video.readyState >= 2) { resolve(); return; }
        this.video.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 4000);
      });

      await this.video.play();

      // FIX 2: Set canvas BUFFER dimensions — CSS dimensions are NOT the buffer
      this.canvas.width  = 160;
      this.canvas.height = 120;

      this.running = true;
      this.onStatus('active');
      this.logger.log('CAMERA_STARTED', 'INFO');

      // FIX 3: Give browser 400ms to render first real frame
      await new Promise(r => setTimeout(r, 400));

      this.checkTimer = setInterval(() => this._check(), this.CHECK_MS);

    } catch (err) {
      this.onStatus('error');
      this.logger.logViolation('CAMERA_DISABLED', { reason: err.message });
      this.engine.apply('CAMERA_DISABLED');
      this.warn.warn('Camera access denied. Click the camera icon in the address bar and allow access.');
      console.error('[Aegis CameraMonitor]', err);
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.checkTimer);
    this.stream?.getTracks().forEach(t => t.stop());
    this.logger.log('CAMERA_STOPPED', 'INFO');
  }

  _check() {
    if (!this.running || !this.stream) return;

    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') {
      if (!this._cooldown('CAMERA_DISABLED', this.DISABLED_CD)) {
        this.engine.apply('CAMERA_DISABLED');
        this.logger.logViolation('CAMERA_DISABLED');
        this.onStatus('error');
        this.warn.warn('Camera has been disabled. Please re-enable it.');
      }
      return;
    }

    // FIX 4: videoWidth === 0 means no frames yet — safer than readyState
    if (this.video.videoWidth === 0 || this.video.paused || this.video.ended) return;

    try {
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

      const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      const { present, multi, avgBrightness } = this._analyse(imageData);

      // FIX 5: Skip dark frames — camera is warming up or physically covered
      if (avgBrightness < 8) {
        this.blankCount++;
        if (this.blankCount > 4) this.onStatus('dark_frame');
        return;
      }
      this.blankCount = 0;

      if (present) {
        this.faceAbsent0 = null;
        this.lastPresent = true;
        this.onStatus(multi ? 'multiple_faces' : 'face_detected');

        if (multi && !this._cooldown('MULTIPLE_FACES', this.MULTI_CD)) {
          this.engine.apply('MULTIPLE_FACES');
          this.logger.logViolation('MULTIPLE_FACES');
          this.warn.warn('Multiple faces detected. Ensure you are alone.');
        }
      } else {
        if (this.lastPresent) { this.faceAbsent0 = Date.now(); this.lastPresent = false; }
        this.onStatus('face_absent');

        const absent = Date.now() - (this.faceAbsent0 || Date.now());
        if (absent >= this.ABSENT_THRESH && !this._cooldown('FACE_NOT_DETECTED', this.ABSENT_CD)) {
          this.engine.apply('FACE_NOT_DETECTED');
          this.logger.logViolation('FACE_NOT_DETECTED', { durationMs: absent });
          this.warn.warn('Face not detected. Please look at the camera.');
        }
      }
    } catch (err) {
      console.warn('[Aegis Camera _check]', err.message);
    }
  }

  // FIX 6: Multi-rule skin detection — reliable across ethnicities + lighting
  _analyse(imageData) {
    const d = imageData.data;
    let skin = 0, brightness = 0;
    const total = d.length / 4;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      brightness += (r + g + b) / 3;
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);

      const isSkin =
        (r > 95 && g > 40 && b > 20 && mx-mn > 15 && Math.abs(r-g) > 15 && r > g && r > b) ||
        (r > 220 && g > 210 && b > 170 && Math.abs(r-g) <= 15 && r > b && g > b)            ||
        (r > 80  && g > 30  && b > 15  && r > g && (r - b) > 20);

      if (isSkin) skin++;
    }

    const skinRatio     = skin / total;
    const avgBrightness = brightness / total;

    return {
      present:        skinRatio > 0.025,   // Lowered from 0.04
      multi:          skinRatio > 0.28,
      avgBrightness,
      skinRatio
    };
  }

  _cooldown(key, ms) {
    if (this.cd[key] && Date.now() - this.cd[key] < ms) return true;
    this.cd[key] = Date.now();
    return false;
  }

  isActive() { return this.running && !!this.stream?.active; }
}
