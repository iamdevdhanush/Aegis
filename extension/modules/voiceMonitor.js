// Aegis v2 — Voice Monitor
// Web Audio API: RMS-based speech detection, sustained voice flagging

export class VoiceMonitor {
  constructor(eventLogger, integrityEngine, warningSystem, onStatus) {
    this.logger   = eventLogger;
    this.engine   = integrityEngine;
    this.warn     = warningSystem;
    this.onStatus = onStatus || (() => {});

    this.stream     = null;
    this.ctx        = null;
    this.analyser   = null;
    this.rafId      = null;
    this.running    = false;

    // Detection config
    this.RMS_THRESH   = 28;    // volume level to consider speech
    this.SUSTAIN_MS   = 5000;  // continuous speech before violation
    this.VIOLATION_CD = 20000; // cooldown between violations

    // State
    this.speechStart    = null;
    this.isSpeaking     = false;
    this.silenceFrames  = 0;
    this.lastViolation  = 0;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false },
        video: false
      });
      this.ctx      = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
      this.running  = true;
      this.onStatus('active');
      this.logger.log('MIC_STARTED', 'INFO');
      this._loop();
    } catch (err) {
      this.onStatus('error');
      this.logger.logViolation('MIC_DISABLED', { reason: err.message });
      this.engine.apply('MIC_DISABLED');
      this.warn.warn('Microphone access denied. Please grant mic permission.');
    }
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach(t => t.stop());
    this.logger.log('MIC_STOPPED', 'INFO');
  }

  volume() {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(buf);
    return Math.round(this._rms(buf));
  }

  _loop() {
    if (!this.running) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(buf);
    const rms = this._rms(buf);

    if (rms > this.RMS_THRESH) {
      this.silenceFrames = 0;
      if (!this.isSpeaking) { this.isSpeaking = true; this.speechStart = Date.now(); }
      this.onStatus('speech_detected');

      const dur = Date.now() - this.speechStart;
      if (dur >= this.SUSTAIN_MS && Date.now() - this.lastViolation > this.VIOLATION_CD) {
        this.lastViolation = Date.now();
        this.speechStart   = Date.now(); // reset window
        this.engine.apply('VOICE_DETECTED');
        this.logger.logViolation('VOICE_DETECTED', { durationMs: dur, rms: Math.round(rms) });
        this.warn.warn('Sustained voice activity detected. Please remain silent.');
      }
    } else {
      this.silenceFrames++;
      if (this.silenceFrames > 20) {
        if (this.isSpeaking) { this.isSpeaking = false; this.speechStart = null; }
        this.onStatus('active');
      }
    }

    this.rafId = requestAnimationFrame(() => setTimeout(() => this._loop(), 150));
  }

  _rms(data) {
    let s = 0;
    for (let i=0; i<data.length; i++) { const n=(data[i]/128)-1; s+=n*n; }
    return Math.sqrt(s/data.length)*100;
  }

  micStatus() {
    if (!this.stream) return 'disabled';
    const t = this.stream.getAudioTracks()[0];
    return (!t || t.readyState==='ended') ? 'disabled' : t.enabled ? 'active' : 'muted';
  }
}
