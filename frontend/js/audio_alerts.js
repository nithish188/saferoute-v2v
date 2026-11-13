/**
 * Spoken Voice Alerts & Sound Effects Engine
 * Implements Section IV-F of IEEE paper:
 * "The warning is shown on the map with the other vehicle's marker and is also spoken,
 * so the driver does not have to look at the screen."
 */

class AudioAlertEngine {
  constructor() {
    this.audioCtx = null;
    this.speechSynth = window.speechSynthesis || null;
    this.lastSpokenTime = 0;
    this.spokenCooldownMs = 3500; // avoid overlapping speech
    this.isMuted = false;
    this.currentUtterance = null;
    this.sirenOscillator = null;
    this.isSirenPlaying = false;
  }

  initAudio() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  speak(text, priority = false) {
    if (this.isMuted || !this.speechSynth) return;

    const now = Date.now();
    if (!priority && now - this.lastSpokenTime < this.spokenCooldownMs) {
      return;
    }

    try {
      this.speechSynth.cancel(); // Cancel any ongoing speech
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.lang = 'en-US';

      // Pick clear female or male English voice if available
      const voices = this.speechSynth.getVoices();
      const englishVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Samantha') || v.name.includes('Zira')));
      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      this.speechSynth.speak(utterance);
      this.lastSpokenTime = now;
    } catch (e) {
      console.warn("Speech synthesis error:", e);
    }
  }

  playBeep(level) {
    if (this.isMuted) return;
    this.initAudio();
    if (!this.audioCtx) return;

    try {
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;

      if (level === 'critical') {
        // High frequency dual alarm pulse
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1174, now + 0.1);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (level === 'warning') {
        // Medium cautionary chime
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(783.99, now + 0.12); // G5
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (level === 'advisory') {
        // Soft advisory chime
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // C5
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch (e) {
      console.warn("Audio chime error:", e);
    }
  }

  triggerCollisionAlert(alert) {
    const level = (alert.level || '').toLowerCase();
    this.playBeep(level);
    if (alert.spoken_text) {
      this.speak(alert.spoken_text, level === 'critical');
    }
  }

  triggerAmbulanceAlert(alert) {
    this.playBeep('warning');
    if (alert.spoken_text) {
      this.speak(alert.spoken_text, true);
    }
  }

  startDistressSiren() {
    this.initAudio();
    if (!this.audioCtx || this.isSirenPlaying) return;

    try {
      this.isSirenPlaying = true;
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      gain.gain.setValueAtTime(0.35, ctx.currentTime);

      // Wobble frequency between 600 Hz and 1300 Hz
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.5; // 2.5 Hz wobble
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 400; // +/- 400 Hz
      osc.frequency.value = 900;

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      osc.connect(gain);
      gain.connect(ctx.destination);

      lfo.start();
      osc.start();

      this.sirenOscillator = { osc, lfo, gain };
    } catch (e) {
      console.warn("Siren start error:", e);
    }
  }

  stopDistressSiren() {
    if (this.sirenOscillator) {
      try {
        this.sirenOscillator.osc.stop();
        this.sirenOscillator.lfo.stop();
      } catch (e) {}
      this.sirenOscillator = null;
    }
    this.isSirenPlaying = false;
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      if (this.speechSynth) this.speechSynth.cancel();
      this.stopDistressSiren();
    }
    return this.isMuted;
  }
}

window.audioEngine = new AudioAlertEngine();

