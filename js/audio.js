/**
 * Web Audio manager: built-in synth SFX + optional custom samples.
 */

export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer>} */
    this.buffers = new Map();
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {AudioBufferSourceNode|null} */
    this.loopSource = null;
    this.loopGain = null;

    /** Background music loop (separate from spin SFX loop) */
    /** @type {AudioBufferSourceNode|null} */
    this.bgmSource = null;
    /** @type {GainNode|null} */
    this.bgmGain = null;

    /** Active preview nodes (oscillators / buffer sources) */
    this._previewNodes = [];
    this._previewPlaying = false;
    this._previewEndTimer = null;
    /** @type {string|null} which preview slot is active (optional) */
    this._previewId = null;
    /** All currently playing sources (ticks, lands, one-shots) for stopAll */
    this._activeNodes = new Set();
    /** Rig-it divert SFX (stopped when wheel lands) */
    /** @type {AudioBufferSourceNode|null} */
    this._divertSource = null;
    /** @type {GainNode|null} */
    this._divertGain = null;
  }

  /**
   * Track a source so stopAll can kill it.
   * @param {AudioScheduledSourceNode} node
   */
  _trackActive(node) {
    this._activeNodes.add(node);
    const prev = node.onended;
    node.onended = (ev) => {
      this._activeNodes.delete(node);
      if (typeof prev === "function") prev.call(node, ev);
    };
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  async loadDataUrl(key, dataUrl) {
    if (!dataUrl) {
      this.buffers.delete(key);
      return;
    }
    const ctx = this.ensure();
    const res = await fetch(dataUrl);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffers.set(key, buf);
  }

  /**
   * Load audio from a same-origin URL (e.g. bundled assets).
   * @param {string} key
   * @param {string} url
   */
  async loadUrl(key, url) {
    if (!url) {
      this.buffers.delete(key);
      return;
    }
    const ctx = this.ensure();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load audio: ${url}`);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffers.set(key, buf);
  }

  /**
   * Short per-segment tick (built-in).
   * @param {number} volume 0..1
   * @param {number} pitchScale higher when spinning faster
   * @param {boolean} [asPreview]
   */
  playTick(volume = 0.4, pitchScale = 1, asPreview = false) {
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    // Low default pitch (soft click, not piercing)
    osc.frequency.setValueAtTime(280 * pitchScale, t);
    osc.frequency.exponentialRampToValueAtTime(140 * pitchScale, t + 0.045);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.35), t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
    this._trackActive(osc);
    if (asPreview) this._trackPreview(osc, 0.08);
  }

  /**
   * Built-in landing chime
   * @param {number} volume
   * @param {boolean} [asPreview]
   */
  playLandDefault(volume = 0.4, asPreview = false) {
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t + i * 0.08;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume * 0.4, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.5);
      this._trackActive(osc);
      if (asPreview) this._trackPreview(osc, null);
    });
    if (asPreview) this._schedulePreviewEnd(0.7);
  }

  /**
   * Play a one-shot buffer, or fall back.
   * @param {string|null} key buffer key
   * @param {number} volume
   * @param {'tick'|'land'} fallback
   * @param {boolean} [asPreview]
   */
  playOneShot(key, volume, fallback, asPreview = false) {
    const buf = key ? this.buffers.get(key) : null;
    if (buf) {
      const ctx = this.ensure();
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buf;
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.master);
      src.start();
      this._trackActive(src);
      if (asPreview) {
        const dur = buf.duration || 1;
        this._trackPreview(src, dur + 0.05);
      }
      return;
    }
    if (fallback === "tick") this.playTick(volume, 1, asPreview);
    else this.playLandDefault(volume, asPreview);
  }

  startLoop(key, volume) {
    this.stopLoop();
    const buf = key ? this.buffers.get(key) : null;
    if (!buf) return false;
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.loop = true;
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
    this.loopSource = src;
    this.loopGain = gain;
    this._trackActive(src);
    return true;
  }

  stopLoop() {
    if (this.loopSource) {
      try {
        this.loopSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.loopSource.disconnect();
      } catch {
        /* */
      }
      this._activeNodes.delete(this.loopSource);
      this.loopSource = null;
    }
    if (this.loopGain) {
      try {
        this.loopGain.disconnect();
      } catch {
        /* */
      }
      this.loopGain = null;
    }
  }

  get isBgmPlaying() {
    return !!this.bgmSource;
  }

  /**
   * Start background music from a loaded buffer key (e.g. "bgm").
   * Restarts if already playing.
   * @param {string} key
   * @param {number} volume
   * @param {{ loop?: boolean }} [opts] loop defaults true; false = play once
   */
  startBgm(key, volume, opts = {}) {
    this.stopBgm();
    const buf = key ? this.buffers.get(key) : null;
    if (!buf) return false;
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.loop = opts.loop !== false;
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
    this.bgmSource = src;
    this.bgmGain = gain;
    this._trackActive(src);
    return true;
  }

  /**
   * Duration of a loaded buffer in seconds, or 0 if missing.
   * @param {string} key
   * @returns {number}
   */
  getBufferDuration(key) {
    const buf = key ? this.buffers.get(key) : null;
    const d = buf?.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  setBgmVolume(volume) {
    if (this.bgmGain) {
      this.bgmGain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0));
    }
  }

  stopBgm() {
    if (this.bgmSource) {
      try {
        this.bgmSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.bgmSource.disconnect();
      } catch {
        /* */
      }
      this._activeNodes.delete(this.bgmSource);
      this.bgmSource = null;
    }
    if (this.bgmGain) {
      try {
        this.bgmGain.disconnect();
      } catch {
        /* */
      }
      this.bgmGain = null;
    }
  }

  /**
   * Built-in reverse-rig slide: soft wet/slippery whoosh (not the divert grind).
   * Tracked as divert source so stopDivert() cuts it when the wheel lands.
   * @param {number} volume 0..1
   * @param {boolean} [asPreview]
   */
  playSlipperySlide(volume = 0.4, asPreview = false) {
    this.stopDivert();
    const ctx = this.ensure();
    const t = ctx.currentTime;
    // Longer wet whoosh — clearly not the concrete-grind divert sample
    const dur = 1.85;
    const vol = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.75;

    // Soft noise body (pink-ish) with falling low-pass = slick ice/wet slide
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      const env = Math.sin((Math.PI * i) / Math.max(1, len - 1));
      data[i] = (b0 + b1 + b2 + white * 0.08) * 0.11 * env;
    }

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;

    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.Q.value = 0.55;
    low.frequency.setValueAtTime(4200, t);
    low.frequency.exponentialRampToValueAtTime(180, t + dur);

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(1400, t);
    band.frequency.exponentialRampToValueAtTime(140, t + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t + 0.06);
    gain.gain.setValueAtTime(vol * 0.95, t + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // Wet “slick” tones (very different from concrete grind)
    const makeSine = (f0, f1, level) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * level), t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      this._trackActive(osc);
      if (asPreview) this._trackPreview(osc, dur + 0.05);
      return osc;
    };
    makeSine(320, 48, 0.18);
    makeSine(480, 90, 0.1);

    src.connect(low);
    low.connect(band);
    band.connect(gain);
    gain.connect(this.master);

    src.start(t);
    src.stop(t + dur + 0.02);

    this._divertSource = src;
    this._divertGain = gain;
    this._trackActive(src);
    if (asPreview) this._trackPreview(src, dur + 0.05);
    const clear = () => {
      if (this._divertSource === src) {
        this._divertSource = null;
        this._divertGain = null;
      }
    };
    src.onended = () => {
      clear();
      this._activeNodes.delete(src);
    };
    return true;
  }

  /**
   * Play the rig-it divert one-shot (stopped via stopDivert when the wheel lands).
   * @param {string} key loaded buffer key (e.g. "rig_divert")
   * @param {number} volume 0..1
   */
  playDivert(key, volume = 0.4) {
    this.stopDivert();
    const buf = key ? this.buffers.get(key) : null;
    if (!buf) return false;
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0));
    src.connect(gain);
    gain.connect(this.master);
    src.start();
    this._divertSource = src;
    this._divertGain = gain;
    this._trackActive(src);
    const clear = () => {
      if (this._divertSource === src) {
        this._divertSource = null;
        this._divertGain = null;
      }
    };
    const prev = src.onended;
    src.onended = (ev) => {
      clear();
      this._activeNodes.delete(src);
      if (typeof prev === "function") prev.call(src, ev);
    };
    return true;
  }

  /** Cut off divert SFX immediately (e.g. when the wheel lands). */
  stopDivert() {
    if (this._divertSource) {
      try {
        // Quick fade so it doesn't click
        if (this._divertGain && this.ctx) {
          const g = this._divertGain.gain;
          const t = this.ctx.currentTime;
          g.cancelScheduledValues(t);
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(0.0001, t + 0.04);
        }
        this._divertSource.stop(this.ctx ? this.ctx.currentTime + 0.05 : 0);
      } catch {
        /* already stopped */
      }
      try {
        this._divertSource.disconnect();
      } catch {
        /* */
      }
      this._activeNodes.delete(this._divertSource);
      this._divertSource = null;
    }
    if (this._divertGain) {
      try {
        this._divertGain.disconnect();
      } catch {
        /* */
      }
      this._divertGain = null;
    }
  }

  /**
   * Immediately stop every sound: previews, spin loop, BGM, land SFX, ticks, etc.
   */
  stopAll() {
    this.stopLoop();
    this.stopBgm();
    this.stopDivert();
    this.stopPreview();
    for (const node of [...this._activeNodes]) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* */
      }
    }
    this._activeNodes.clear();
  }

  get isPreviewPlaying() {
    return this._previewPlaying;
  }

  /**
   * Track a node as part of the current preview.
   * @param {AudioScheduledSourceNode} node
   * @param {number|null} endAfterSec if set, schedule preview end after this many seconds
   */
  _trackPreview(node, endAfterSec) {
    this._previewNodes.push(node);
    this._previewPlaying = true;
    node.onended = () => {
      // If all nodes finished, clear playing flag
      this._previewNodes = this._previewNodes.filter((n) => n !== node);
      if (!this._previewNodes.length) {
        this._previewPlaying = false;
        this._previewId = null;
      }
    };
    if (endAfterSec != null) this._schedulePreviewEnd(endAfterSec);
  }

  _schedulePreviewEnd(seconds) {
    if (this._previewEndTimer) clearTimeout(this._previewEndTimer);
    this._previewEndTimer = setTimeout(() => {
      if (this._previewNodes.length === 0) {
        this._previewPlaying = false;
        this._previewId = null;
      }
    }, Math.ceil(seconds * 1000) + 30);
  }

  /** Stop any currently playing preview sound immediately. */
  stopPreview() {
    if (this._previewEndTimer) {
      clearTimeout(this._previewEndTimer);
      this._previewEndTimer = null;
    }
    for (const node of this._previewNodes) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* */
      }
    }
    this._previewNodes = [];
    this._previewPlaying = false;
    this._previewId = null;
  }

  /**
   * Toggle preview: if a preview is already playing, stop it.
   * Otherwise run `startFn` which should call play* with asPreview=true.
   * @param {string} [id] optional id for which preview button
   * @param {() => void} startFn
   * @returns {'stopped'|'started'}
   */
  togglePreview(id, startFn) {
    if (this._previewPlaying) {
      this.stopPreview();
      return "stopped";
    }
    this._previewId = id || null;
    startFn();
    return "started";
  }

  /**
   * @param {string|null} key
   * @param {number} volume
   * @param {'tick'|'land'} [fallback]
   */
  preview(key, volume, fallback = "land") {
    this.stopPreview();
    this.playOneShot(key, volume, fallback, true);
  }
}
