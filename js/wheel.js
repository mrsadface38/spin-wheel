/**
 * Canvas wheel renderer + spin animation.
 * Section / center / background media use DOM <img> so GIFs animate.
 */

import { computeFillImageLayout } from "./slice-image-layout.js";

function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}

/** Load image from data URL; returns Promise<HTMLImageElement|null> */
function loadImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * CSS clip-path polygon for a pie wedge. Box is 2r×2r with center at (r,r).
 * Angles match canvas: 0 = east, increasing clockwise (y-down).
 */
function wedgeClipPath(start, end, r) {
  const span = end - start;
  if (span >= Math.PI * 2 - 1e-4) {
    return `circle(${r}px at ${r}px ${r}px)`;
  }
  const cx = r;
  const cy = r;
  const pts = [`${cx}px ${cy}px`];
  const steps = Math.max(12, Math.ceil((span / (Math.PI * 2)) * 64));
  for (let i = 0; i <= steps; i++) {
    const a = start + (span * i) / steps;
    pts.push(`${cx + Math.cos(a) * r}px ${cy + Math.sin(a) * r}px`);
  }
  return `polygon(${pts.join(", ")})`;
}

export class Wheel {
  /**
   * @param {HTMLCanvasElement} wheelCanvas fills only
   * @param {HTMLCanvasElement} bgCanvas
   * @param {object} options callbacks + media layer + overlay canvas
   */
  constructor(wheelCanvas, bgCanvas, options = {}) {
    this.wheelCanvas = wheelCanvas;
    this.bgCanvas = bgCanvas;
    this.overlayCanvas = options.overlayCanvas || null;
    this.wctx = wheelCanvas.getContext("2d");
    this.bctx = bgCanvas.getContext("2d");
    this.octx = this.overlayCanvas ? this.overlayCanvas.getContext("2d") : null;

    this.bgMediaEl = options.bgMediaEl || null;
    this.sliceRotatorEl = options.sliceRotatorEl || null;
    this.centerMediaEl = options.centerMediaEl || null;

    this.rotation = 0; // radians
    this.spinning = false;
    this.sections = [];
    this.look = {};
    /** @type {Map<string, HTMLImageElement>} natural size cache for layout */
    this._images = new Map();
    this._sectionMediaKey = "";

    this.onTick = options.onTick || (() => {});
    this.onLand = options.onLand || (() => {});
    this.onFrame = options.onFrame || (() => {});

    this._raf = 0;
    this._lastSeg = -1;
    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;

    /** Cached slices while spinning / between invalidations */
    this._slicesCache = null;
    /** Geometry fixed for the current spin (angles don't change mid-spin) */
    this._spinSlices = null;
    this._spinSingle = false;
    this._spinRadius = 0;
    this._spinCx = 0;
    this._spinCy = 0;
    /** Throttle tick SFX when many boundaries cross per frame */
    this._lastTickAudioAt = 0;

    /** Resolve fn for in-flight spin/fling promise (for grab-to-stop) */
    this._spinResolve = null;

    /** Manual drag / fling */
    this._dragging = false;
    this._dragPointerId = null;
    this._dragLastAngle = 0;
    /** @type {{ t: number, rot: number }[]} */
    this._dragSamples = [];
    this._dragEl = null;
    this._dragBound = false;

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(wheelCanvas.parentElement);
  }

  /** Drop geometry caches (call when sections/weights change). */
  invalidateGeometry() {
    this._slicesCache = null;
    this._spinSlices = null;
  }

  /**
   * Apply parent size to canvases + cached metrics.
   * Safe mid-spin so canvas stays locked to DOM slice images when panels toggle.
   */
  _applySizeFromParent() {
    const parent = this.wheelCanvas.parentElement;
    if (!parent) return false;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this._cssW = rect.width;
    this._cssH = rect.height;
    const canvases = [this.wheelCanvas, this.bgCanvas];
    if (this.overlayCanvas) canvases.push(this.overlayCanvas);
    for (const c of canvases) {
      c.width = Math.floor(rect.width * dpr);
      c.height = Math.floor(rect.height * dpr);
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    }
    // Keep spin-frame geometry in sync with new canvas pixels
    this._spinCx = this.wheelCanvas.width / 2;
    this._spinCy = this.wheelCanvas.height / 2;
    this._spinRadius = Math.min(this.wheelCanvas.width, this.wheelCanvas.height) * 0.42;
    return true;
  }

  resize() {
    if (!this._applySizeFromParent()) return;

    if (this.spinning) {
      // Re-layout DOM wedges for new radius; keep frozen slice angles
      const slices = this._spinSlices || this.getSlices();
      const radiusCss = this._radiusCss();
      if (this.look.showImages !== false && slices?.length) {
        this._layoutSliceMedia(slices, radiusCss);
      }
      this._layoutCenterMedia();
      this._syncSliceRotation();
      // Redraw bg once at new size; next spin frames use spinFrame path
      this.drawBackground();
      this.draw({ spinFrame: true });
      return;
    }

    this.draw();
  }

  async setLook(look) {
    this.look = look;
    this.invalidateGeometry();
    this._syncBgMedia();
    this._syncCenterMedia();
    this.draw();
  }

  /**
   * @param {Array} sections active sections with imageData
   */
  async setSections(sections) {
    this.sections = sections;
    this.invalidateGeometry();
    const urls = sections.map((s) => s.imageData).filter(Boolean);
    await Promise.all(
      urls.map(async (url) => {
        if (!this._images.has(url)) {
          const img = await loadImage(url);
          if (img) this._images.set(url, img);
        }
      })
    );
    this._rebuildSliceMedia();
    this.draw();
  }

  totalWeight() {
    return this.sections.reduce((a, s) => a + Math.max(0.1, s.weight || 1), 0);
  }

  _computeSlices() {
    const total = this.totalWeight() || 1;
    let angle = 0;
    return this.sections.map((s) => {
      const span = (Math.max(0.1, s.weight || 1) / total) * Math.PI * 2;
      const start = angle;
      const end = angle + span;
      angle = end;
      return { section: s, start, end, mid: (start + end) / 2, span };
    });
  }

  getSlices() {
    // Prefer spin cache (frozen geometry) → general cache → recompute
    if (this._spinSlices) return this._spinSlices;
    if (this._slicesCache) return this._slicesCache;
    this._slicesCache = this._computeSlices();
    return this._slicesCache;
  }

  angleAtPointer() {
    let a = -Math.PI / 2 - this.rotation;
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return a;
  }

  sectionAtPointer() {
    const slices = this.getSlices();
    if (!slices.length) return null;
    const a = this.angleAtPointer();
    for (const sl of slices) {
      if (a >= sl.start && a < sl.end) return sl.section;
      if (sl === slices[slices.length - 1] && a >= sl.start) return sl.section;
    }
    return slices[0].section;
  }

  segmentIndexAtPointer() {
    const slices = this.getSlices();
    if (!slices.length) return -1;
    const a = this.angleAtPointer();
    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      if (a >= sl.start && a < sl.end) return i;
      if (i === slices.length - 1 && a >= sl.start) return i;
    }
    return 0;
  }

  _radiusCss() {
    return Math.min(this._cssW || 0, this._cssH || 0) * 0.42;
  }

  _syncBgMedia() {
    const el = this.bgMediaEl;
    if (!el) return;
    const src = this.look.backgroundImage;
    const existing = el.querySelector("img");
    if (!src) {
      el.innerHTML = "";
      el.style.backgroundImage = "";
      el.classList.remove("has-media");
      return;
    }
    // Reuse <img> when possible so GIF animation isn't restarted every redraw
    if (existing && existing.dataset.src === src) {
      el.classList.add("has-media");
      return;
    }
    el.innerHTML = "";
    el.style.backgroundImage = "";
    const img = document.createElement("img");
    img.src = src;
    img.dataset.src = src;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
    el.classList.add("has-media");
  }

  _syncCenterMedia() {
    const el = this.centerMediaEl;
    if (!el) return;
    el.innerHTML = "";
    const src = this.look.centerImage;
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
      el.classList.add("has-media");
    } else {
      el.classList.remove("has-media");
    }
    this._layoutCenterMedia();
  }

  _layoutCenterMedia() {
    const el = this.centerMediaEl;
    if (!el || !el.classList.contains("has-media")) return;
    const radius = this._radiusCss();
    const hubR = radius * (this.look.centerSize ?? 0.16);
    const d = Math.max(8, hubR * 2 - 4);
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
  }

  _rebuildSliceMedia() {
    const rotator = this.sliceRotatorEl;
    if (!rotator) return;

    const key =
      this.sections
        .map((s) => this._sectionMediaSig(s))
        .join("|") + `|show:${this.look.showImages !== false}`;
    this._sectionMediaKey = key;
    rotator.innerHTML = "";

    if (this.look.showImages === false) return;

    const slices = this.getSlices();
    const radius = this._radiusCss() || 200;

    for (const sl of slices) {
      if (!sl.section.imageData) continue;
      const mode = sl.section.imageMode === "tile" ? "tile" : "fill";
      const wedge = document.createElement("div");
      wedge.className = `slice-bg-wedge mode-${mode}`;
      wedge.dataset.sectionId = sl.section.id;
      wedge.dataset.imageMode = mode;

      if (mode === "tile") {
        const grid = document.createElement("div");
        grid.className = "slice-bg-tile-grid";
        wedge.appendChild(grid);
      } else {
        const img = document.createElement("img");
        img.className = "slice-bg-fill";
        img.src = sl.section.imageData;
        img.alt = sl.section.label || "";
        img.draggable = false;
        wedge.appendChild(img);
      }

      rotator.appendChild(wedge);
    }

    this._layoutSliceMedia(slices, radius);
    this._syncSliceRotation();
  }

  _sectionMediaSig(s) {
    return [
      s.id,
      s.imageData || "",
      s.weight,
      s.imageMode || "fill",
      s.imageFillScale ?? 1,
      s.imageFillOffsetX ?? 0,
      s.imageFillOffsetY ?? 0,
      s.imageTileScale ?? 1,
      s.imageTileOffsetX ?? 0,
      s.imageTileOffsetY ?? 0,
    ].join(":");
  }

  /**
   * Build / update a grid of small images that tile across the wedge square.
   * Uses real <img> tags so GIFs keep animating in each cell.
   * @param {number} offsetXPct -100..100 (% of one tile)
   * @param {number} offsetYPct -100..100 (% of one tile)
   */
  _fillTileGrid(wedge, src, radius, tileScale, offsetXPct = 0, offsetYPct = 0) {
    const grid = wedge.querySelector(".slice-bg-tile-grid");
    if (!grid || !src) return;

    const base = Math.max(22, radius * 0.2);
    const scale = Math.min(3, Math.max(0.1, Number(tileScale) || 1));
    const tilePx = Math.max(10, base * scale);
    const d = radius * 2;
    // Extra ring of tiles so X/Y offset never leaves empty edges
    let cols = Math.max(1, Math.ceil(d / tilePx)) + 2;
    let rows = Math.max(1, Math.ceil(d / tilePx)) + 2;
    const maxCells = 220;
    if (cols * rows > maxCells) {
      const shrink = Math.sqrt(maxCells / (cols * rows));
      cols = Math.max(3, Math.ceil(cols * shrink));
      rows = Math.max(3, Math.ceil(rows * shrink));
    }

    const ox = ((Math.min(100, Math.max(-100, Number(offsetXPct) || 0)) / 100) * tilePx);
    const oy = ((Math.min(100, Math.max(-100, Number(offsetYPct) || 0)) / 100) * tilePx);

    const sig = `${src}|${cols}x${rows}|${tilePx.toFixed(2)}`;
    if (grid.dataset.sig !== sig) {
      grid.dataset.sig = sig;
      grid.style.gridTemplateColumns = `repeat(${cols}, ${tilePx}px)`;
      grid.style.gridTemplateRows = `repeat(${rows}, ${tilePx}px)`;
      grid.style.width = `${cols * tilePx}px`;
      grid.style.height = `${rows * tilePx}px`;
      grid.innerHTML = "";
      const total = cols * rows;
      for (let i = 0; i < total; i++) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        img.draggable = false;
        grid.appendChild(img);
      }
    } else {
      grid.style.gridTemplateColumns = `repeat(${cols}, ${tilePx}px)`;
      grid.style.gridTemplateRows = `repeat(${rows}, ${tilePx}px)`;
      grid.style.width = `${cols * tilePx}px`;
      grid.style.height = `${rows * tilePx}px`;
    }

    // Anchor so one full tile sits past the top-left; offset shifts the pattern
    grid.style.left = `${-tilePx + ox}px`;
    grid.style.top = `${-tilePx + oy}px`;
  }

  _layoutSliceMedia(slices, radius) {
    const rotator = this.sliceRotatorEl;
    if (!rotator || !radius) return;
    const wedges = [...rotator.querySelectorAll(".slice-bg-wedge")];
    if (!wedges.length) return;

    const byId = new Map(slices.map((sl) => [sl.section.id, sl]));
    const d = radius * 2;

    for (const wedge of wedges) {
      const sl = byId.get(wedge.dataset.sectionId);
      if (!sl) {
        wedge.style.display = "none";
        continue;
      }
      wedge.style.display = "";
      wedge.style.width = `${d}px`;
      wedge.style.height = `${d}px`;
      wedge.style.left = `${-radius}px`;
      wedge.style.top = `${-radius}px`;
      wedge.style.clipPath = wedgeClipPath(sl.start, sl.end, radius);
      wedge.style.webkitClipPath = wedge.style.clipPath;

      const mode =
        wedge.dataset.imageMode ||
        (sl.section.imageMode === "tile" ? "tile" : "fill");
      if (mode === "tile" && sl.section.imageData) {
        this._fillTileGrid(
          wedge,
          sl.section.imageData,
          radius,
          sl.section.imageTileScale ?? 1,
          sl.section.imageTileOffsetX ?? 0,
          sl.section.imageTileOffsetY ?? 0
        );
      } else if (mode === "fill") {
        this._layoutFillImage(wedge, sl, radius);
      }
    }
  }

  /**
   * Place full-slice image in fixed wheel space (matches editor preview framing).
   * Slice only clips; position does not re-center on each wedge mid-angle.
   */
  _layoutFillImage(wedge, sl, radius) {
    const layout = computeFillImageLayout({
      radius,
      fillScale: sl.section.imageFillScale,
      offsetXPct: sl.section.imageFillOffsetX,
      offsetYPct: sl.section.imageFillOffsetY,
    });
    wedge.style.setProperty("--fill-scale", String(layout.fillScale));

    const img = wedge.querySelector("img.slice-bg-fill");
    if (!img) return;

    const box = radius * 2;
    img.style.width = `${box}px`;
    img.style.height = `${box}px`;
    img.style.left = `${layout.left}px`;
    img.style.top = `${layout.top}px`;
  }

  _syncSliceRotation() {
    if (this.sliceRotatorEl) {
      // translateZ promotes to compositor layer; avoids reflow during spin
      this.sliceRotatorEl.style.transform = `rotate(${this.rotation}rad) translateZ(0)`;
    }
  }

  drawBackground() {
    const ctx = this.bctx;
    const w = this.bgCanvas.width;
    const h = this.bgCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Solid color only when there is NO background image/GIF.
    // With media, leave the canvas transparent so the DOM #bg-media layer shows through.
    if (this.look.backgroundImage) {
      this.bgCanvas.style.background = "transparent";
      // Light dim so the wheel still pops over busy images
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(0, 0, w, h);
    } else {
      const color = this.look.backgroundColor || "#0f1220";
      this.bgCanvas.style.background = color;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /**
   * @param {{ spinFrame?: boolean }} [opts]
   * spinFrame: lightweight path used every animation tick (no media reflow / no bg redraw).
   */
  draw(opts = {}) {
    const spinFrame =
      !!opts.spinFrame && (this.spinning || this._dragging);

    if (!spinFrame) {
      this.drawBackground();
    }

    const ctx = this.wctx;
    const w = this.wheelCanvas.width;
    const h = this.wheelCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.octx && this.overlayCanvas) {
      this.octx.setTransform(1, 0, 0, 1, 0, 0);
      this.octx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    const cx = spinFrame && this._spinCx ? this._spinCx : w / 2;
    const cy = spinFrame && this._spinCy ? this._spinCy : h / 2;
    const radius =
      spinFrame && this._spinRadius ? this._spinRadius : Math.min(w, h) * 0.42;
    const radiusCss = this._radiusCss();

    const slices = this.getSlices();
    if (!slices.length) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = `${14 * this._dpr}px system-ui,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No active sections — enable a group", cx, cy);
      if (this.sliceRotatorEl) this.sliceRotatorEl.innerHTML = "";
      this._layoutCenterMedia();
      return;
    }

    // Slice image backgrounds (DOM) — expensive layout only when idle / content changes
    if (!spinFrame) {
      if (this.look.showImages !== false) {
        const mediaKey =
          this.sections.map((s) => this._sectionMediaSig(s)).join("|") +
          `|show:${this.look.showImages !== false}`;
        if (mediaKey !== this._sectionMediaKey) {
          this._rebuildSliceMedia();
        } else {
          this._layoutSliceMedia(slices, radiusCss || radius / this._dpr);
        }
      } else if (this.sliceRotatorEl) {
        this.sliceRotatorEl.innerHTML = "";
        this._sectionMediaKey = "";
      }
      this._layoutCenterMedia();
    }
    // Always rotate the DOM media layer (cheap GPU transform)
    this._syncSliceRotation();

    const single = spinFrame ? this._spinSingle : slices.length === 1;

    // --- Back canvas: color fills (under images) ---
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation);

    ctx.beginPath();
    ctx.arc(0, 0, radius + 4 * this._dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();

    for (const sl of slices) {
      this._drawSliceFill(ctx, sl, radius, single, spinFrame);
    }
    ctx.restore();

    // --- Overlay canvas: labels, border, pegs, hub (above images) ---
    const octx = this.octx || ctx;
    const useOverlay = !!this.octx;
    if (useOverlay) {
      octx.save();
      octx.translate(cx, cy);
      octx.rotate(this.rotation);
    } else {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.rotation);
    }
    const front = useOverlay ? octx : ctx;

    // Light dim over image slices so labels stay readable
    for (const sl of slices) {
      const hasImg =
        sl.section.imageData && this.look.showImages !== false;
      if (!hasImg) continue;
      const solid = single || sl.span >= Math.PI * 2 - 1e-4;
      front.beginPath();
      if (solid) {
        front.arc(0, 0, radius, 0, Math.PI * 2);
      } else {
        front.moveTo(0, 0);
        front.arc(0, 0, radius, sl.start, sl.end);
        front.closePath();
      }
      front.fillStyle = "rgba(0,0,0,0.22)";
      front.fill();
    }

    for (const sl of slices) {
      this._drawSliceLabel(front, sl, radius, single, spinFrame);
    }

    // Separators between multi slices (on top of images)
    if (!single) {
      front.strokeStyle = "rgba(0,0,0,0.35)";
      front.lineWidth = 1.5 * this._dpr;
      for (const sl of slices) {
        front.beginPath();
        front.moveTo(0, 0);
        front.lineTo(Math.cos(sl.start) * radius, Math.sin(sl.start) * radius);
        front.stroke();
      }
    }

    // Outer border
    front.beginPath();
    front.arc(0, 0, radius, 0, Math.PI * 2);
    front.strokeStyle = this.look.borderColor || "#f0d78c";
    front.lineWidth = 6 * this._dpr;
    front.stroke();

    // Pegs
    if (single) {
      const pegCount = 12;
      for (let i = 0; i < pegCount; i++) {
        const a = (i / pegCount) * Math.PI * 2;
        front.beginPath();
        front.arc(Math.cos(a) * radius, Math.sin(a) * radius, 4.5 * this._dpr, 0, Math.PI * 2);
        front.fillStyle = this.look.borderColor || "#f0d78c";
        front.fill();
      }
    } else {
      for (const sl of slices) {
        front.beginPath();
        front.arc(
          Math.cos(sl.start) * radius,
          Math.sin(sl.start) * radius,
          4 * this._dpr,
          0,
          Math.PI * 2
        );
        front.fillStyle = this.look.borderColor || "#f0d78c";
        front.fill();
      }
    }

    // Center hub
    const hubR = radius * (this.look.centerSize ?? 0.16);
    front.beginPath();
    front.arc(0, 0, hubR, 0, Math.PI * 2);
    front.fillStyle = this.look.centerColor || "#1a1f35";
    front.fill();
    front.strokeStyle = this.look.borderColor || "#f0d78c";
    front.lineWidth = 4 * this._dpr;
    front.stroke();

    front.restore();
  }

  /**
   * Color underlay for a slice (shows if no image, or peeks under dimmed image).
   * @param {boolean} spinFrame skip fancy motion bands while spinning
   */
  _drawSliceFill(ctx, sl, radius, asSolidDisc = false, spinFrame = false) {
    const { start, section } = sl;
    const color = section.color || "#4a6cf7";
    const solid = asSolidDisc || sl.span >= Math.PI * 2 - 1e-4;
    const hasImg = section.imageData && this.look.showImages !== false;

    if (solid) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Motion bands only when idle / no image (expensive multi-path work)
      if (!hasImg && !spinFrame) {
        const bands = 8;
        for (let i = 0; i < bands; i++) {
          if (i % 2 === 0) continue;
          const a0 = (i / bands) * Math.PI * 2;
          const a1 = ((i + 1) / bands) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, radius, a0, a1);
          ctx.closePath();
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius * 0.92, -0.12, 0.12);
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, sl.end);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /**
   * Word-wrap so each line fits maxWidth (full text, no ellipsis).
   * @returns {string[]}
   */
  _wrapLabelLines(ctx, label, maxWidth) {
    const text = String(label || "").trim();
    if (!text) return [];
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (ctx.measureText(trial).width <= maxWidth || !line) {
        line = trial;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    // Hard-break overlong tokens so every character still draws
    const out = [];
    for (const ln of lines) {
      if (ctx.measureText(ln).width <= maxWidth) {
        out.push(ln);
        continue;
      }
      let chunk = "";
      for (const ch of ln) {
        const t = chunk + ch;
        if (ctx.measureText(t).width <= maxWidth || !chunk) chunk = t;
        else {
          out.push(chunk);
          chunk = ch;
        }
      }
      if (chunk) out.push(chunk);
    }
    return out;
  }

  /**
   * Labels run along the radius (center → rim). That gives long names room
   * even on thin slices; we only shrink/wrap — never truncate with "…".
   * @param {boolean} spinFrame lighter text (no shadow) while spinning
   */
  _drawSliceLabel(ctx, sl, radius, asSolidDisc = false, spinFrame = false) {
    if (this.look.showLabels === false) return;
    const { mid, section } = sl;
    const label = String(section.label || "").trim();
    if (!label) return;

    const solid = asSolidDisc || sl.span >= Math.PI * 2 - 1e-4;
    const dpr = this._dpr || 1;

    ctx.save();
    // Local +x = outward along slice mid-angle (radial)
    // Local +y = tangential (across the wedge)
    ctx.rotate(solid ? 0 : mid);

    const hubR = radius * (solid ? 0.2 : 0.26);
    const outerR = radius * 0.94;
    const radialBudget = Math.max(24 * dpr, outerR - hubR);
    const midR = (hubR + outerR) / 2;
    ctx.translate(midR, 0);

    // Font height must fit across the wedge (tangential)
    const tanBudget = solid
      ? radius * 0.35
      : Math.max(8 * dpr, midR * sl.span * 0.92);

    const maxFont = Math.min(
      solid ? 22 * dpr : 16 * dpr,
      tanBudget * 0.95,
      radius * 0.055
    );
    const minFont = Math.max(5 * dpr, 5);

    const weight = solid ? 700 : 600;
    let fontSize = Math.max(minFont, maxFont);
    let lines = [label];
    let lineH = fontSize * 1.12;

    for (let attempt = 0; attempt < 30; attempt++) {
      ctx.font = `${weight} ${fontSize}px system-ui,sans-serif`;
      // Prefer one line along the radius; wrap only if still too long at small size
      const oneW = ctx.measureText(label).width;
      if (oneW <= radialBudget) {
        lines = [label];
      } else if (fontSize <= minFont * 1.15) {
        lines = this._wrapLabelLines(ctx, label, radialBudget);
      } else {
        lines = [label];
      }
      lineH = fontSize * 1.12;
      const blockH = lines.length * lineH;
      const widest = lines.reduce(
        (m, ln) => Math.max(m, ctx.measureText(ln).width),
        0
      );
      const fits =
        widest <= radialBudget + 0.5 && blockH <= tanBudget + 0.5;
      if (fits || fontSize <= minFont + 0.01) break;
      fontSize = Math.max(minFont, fontSize * 0.9);
    }

    // Last resort: wrap at min font so every character is drawn
    ctx.font = `${weight} ${fontSize}px system-ui,sans-serif`;
    if (lines.length === 1 && ctx.measureText(lines[0]).width > radialBudget) {
      lines = this._wrapLabelLines(ctx, label, radialBudget);
      lineH = fontSize * 1.12;
    }

    ctx.fillStyle = this.look.textColor || "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (!spinFrame) {
      ctx.shadowColor = "rgba(0,0,0,0.75)";
      ctx.shadowBlur = 4 * dpr;
    }

    const blockH = lines.length * lineH;
    let y = -blockH / 2 + lineH / 2;
    for (const ln of lines) {
      ctx.fillText(ln, 0, y);
      y += lineH;
    }
    ctx.restore();
  }

  /** Peg index for tick sounds (slice boundaries, or rim pegs when only one section). */
  _tickIndex() {
    if (this.sections.length <= 1) {
      const pegs = 12;
      const turns = this.rotation / (Math.PI * 2);
      return Math.floor(turns * pegs);
    }
    return this.segmentIndexAtPointer();
  }

  /**
   * Base land rotation for a section (not adjusted for current angle).
   * pointer angle a = -π/2 - rotation  ⇒  rotation = -π/2 - landLocal
   */
  _landRotationBase(sectionId) {
    const slices = this.getSlices();
    const sl = slices.find((s) => s.section.id === sectionId);
    if (!sl) return null;
    const pad = sl.span * 0.12;
    const landLocal =
      sl.start +
      pad +
      Math.random() * Math.max(0.001, sl.span - pad * 2);
    return -Math.PI / 2 - landLocal;
  }

  /**
   * Weighted random slice index. When excludeId is set and at least one other
   * slice exists, that section can never be the natural pre-divert land.
   * @param {Array<{section: {id: string, weight?: number}}>} slices
   * @param {string|null} [excludeId]
   * @returns {number}
   */
  _pickNaturalWinnerIndex(slices, excludeId = null) {
    if (!slices.length) return 0;
    const pool =
      excludeId && slices.length > 1
        ? slices
            .map((sl, i) => ({ sl, i }))
            .filter(({ sl }) => sl.section.id !== excludeId)
        : slices.map((sl, i) => ({ sl, i }));
    if (!pool.length) return 0;
    let total = 0;
    for (const { sl } of pool) {
      total += Math.max(0.1, sl.section.weight || 1);
    }
    let r = Math.random() * total;
    for (const { sl, i } of pool) {
      r -= Math.max(0.1, sl.section.weight || 1);
      if (r <= 0) return i;
    }
    return pool[pool.length - 1].i;
  }

  /**
   * Rotation that lands the pointer on a section.
   * @param {string} sectionId
   * @param {number} [fromRot]
   * @param {number|'shortest'} [dir] +1, -1, or 'shortest' (default for rig divert)
   */
  targetRotationForSection(sectionId, fromRot = this.rotation, dir = "shortest") {
    const base = this._landRotationBase(sectionId);
    if (base == null) return fromRot;

    const TWO_PI = Math.PI * 2;

    if (dir === "shortest" || dir === 0 || dir == null) {
      // True shortest path: |Δ| ≤ π (never a full spin).
      // fromRot can be huge after a long spin — wrap the delta, not a fixed k range.
      // ((x % n) + n) % n puts remainder in [0, n) even for negative x in JS.
      let d = (((base - fromRot) % TWO_PI) + TWO_PI) % TWO_PI; // [0, 2π)
      if (d > Math.PI) d -= TWO_PI; // (-π, π]
      return fromRot + d;
    }

    const sign = dir >= 0 ? 1 : -1;
    // Align base into the same multi-turn neighborhood as fromRot, then step past it
    let k = Math.round((fromRot - base) / TWO_PI);
    let target = base + k * TWO_PI;
    if (sign > 0) {
      while (target <= fromRot + 0.05) target += TWO_PI;
    } else {
      while (target >= fromRot - 0.05) target -= TWO_PI;
    }
    return target;
  }

  /**
   * Stop a timed spin or fling immediately (e.g. user grabbed the wheel).
   * Does not fire onLand. Resolves the in-flight promise with null.
   */
  cancelAnimatedSpin() {
    if (!this.spinning && !this._raf) return false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.spinning = false;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.remove("is-spinning");
    }
    // Keep current rotation; leave geometry for possible drag takeover
    const resolve = this._spinResolve;
    this._spinResolve = null;
    if (resolve) resolve(null);
    return true;
  }

  /**
   * @param {number} durationSec
   * @param {{ forceSectionId?: string|null, onSteerStart?: () => void, steerMs?: number }} [opts]
   */
  spin(durationSec = 5, opts = {}) {
    if (this.spinning || this._dragging || !this.sections.length) {
      return Promise.resolve(null);
    }

    // Freeze geometry for the whole spin (no realloc / re-layout of wedges)
    this._spinSlices = this._computeSlices();
    this._slicesCache = this._spinSlices;
    const slices = this._spinSlices;
    const w = this.wheelCanvas.width;
    const h = this.wheelCanvas.height;
    this._spinCx = w / 2;
    this._spinCy = h / 2;
    this._spinRadius = Math.min(w, h) * 0.42;
    this._spinSingle = slices.length === 1;

    // Ensure media is laid out once before we stop reflowing it
    this.draw({ spinFrame: false });

    // Natural winner first (rig steers only in the last 0.1s).
    // When rigging, never aim the natural land at the rigged section so the
    // divert is always a real move onto it.
    const forceId = opts.forceSectionId || null;
    const winnerIndex = this._pickNaturalWinnerIndex(slices, forceId);
    const winnerSlice = slices[winnerIndex];
    const pad = winnerSlice.span * 0.15;
    const landLocal =
      winnerSlice.start +
      pad +
      Math.random() * Math.max(0.001, winnerSlice.span - pad * 2);

    const current = this.rotation;
    let target = -Math.PI / 2 - landLocal;
    const extraSpins = Math.max(6, Math.round(durationSec * 1.1) + Math.floor(Math.random() * 3));
    while (target <= current) target += Math.PI * 2;
    target += extraSpins * Math.PI * 2;

    // Single section: still do a full long spin so it feels like a real roll
    const isSingle = this._spinSingle;
    const spins = isSingle
      ? Math.max(8, Math.round(durationSec * 1.4) + Math.floor(Math.random() * 4))
      : extraSpins;
    if (isSingle) {
      target = -Math.PI / 2 - landLocal;
      while (target <= current) target += Math.PI * 2;
      target += spins * Math.PI * 2;
    }

    this.spinning = true;
    this._lastSeg = this._tickIndex();
    this._lastTickAudioAt = 0;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.add("is-spinning");
    }
    const startRot = current;
    const delta = target - startRot;
    // Honor the UI duration (1–30s); do not force a longer minimum
    const duration = Math.max(0.5, durationSec) * 1000;
    const startTime = performance.now();
    // 0.1s before natural land → start slow divert to rigged section
    const divertMs = 100;
    const divertAt = Math.max(0, duration - divertMs);
    // Glide duration after almost-land (from secret Divert speed slider)
    const steerMs = Math.max(
      250,
      Math.min(8000, Number(opts.steerMs) || 1100)
    );
    const canRig =
      !!forceId && slices.some((s) => s.section.id === forceId);

    // Min gap between tick SFX (ms) — avoids audio thrash when many boundaries cross
    const minTickGapMs = 28;

    return new Promise((resolve) => {
      this._spinResolve = resolve;
      let steering = false;
      let steerStart = 0;
      let steerFrom = 0;
      let steerTarget = 0;

      const finish = (win) => {
        this.spinning = false;
        this._spinSlices = null;
        this._slicesCache = null;
        this._raf = 0;
        if (this.sliceRotatorEl) {
          this.sliceRotatorEl.classList.remove("is-spinning");
        }
        this.draw({ spinFrame: false });
        this.onLand(win);
        const res = this._spinResolve;
        this._spinResolve = null;
        if (res) res(win);
      };

      const frame = (now) => {
        // Aborted by grab / cancelAnimatedSpin
        if (!this.spinning) return;

        const elapsed = now - startTime;

        if (canRig && !steering && elapsed >= divertAt) {
          // Almost landed on the natural winner — slowly pull to rigged pick
          // (shortest way: forward or backward)
          steering = true;
          steerStart = now;
          steerFrom = this.rotation;
          steerTarget = this.targetRotationForSection(
            forceId,
            steerFrom,
            "shortest"
          );
          try {
            opts.onSteerStart?.();
          } catch {
            /* ignore sound errors */
          }
        }

        if (steering) {
          const t = Math.min(1, (now - steerStart) / steerMs);
          const e = easeOutQuart(t);
          this.rotation = steerFrom + (steerTarget - steerFrom) * e;

          const seg = this._tickIndex();
          if (seg !== this._lastSeg) {
            if (now - this._lastTickAudioAt >= minTickGapMs) {
              this._lastTickAudioAt = now;
              this.onTick(Math.max(0.06, 1 - t));
            }
            this._lastSeg = seg;
          }
          this.draw({ spinFrame: true });
          this.onFrame(t);
          if (t < 1) this._raf = requestAnimationFrame(frame);
          else {
            this.rotation = steerTarget;
            finish(this.sectionAtPointer());
          }
          return;
        }

        const t = Math.min(1, elapsed / duration);
        const e = easeOutQuart(t);
        this.rotation = startRot + delta * e;

        const seg = this._tickIndex();
        if (seg !== this._lastSeg) {
          if (now - this._lastTickAudioAt >= minTickGapMs) {
            this._lastTickAudioAt = now;
            this.onTick(1 - t);
          }
        }
        this._lastSeg = seg;

        this.draw({ spinFrame: true });
        this.onFrame(t);

        if (elapsed < divertAt || !canRig) {
          if (t < 1) this._raf = requestAnimationFrame(frame);
          else {
            this.rotation = target;
            finish(this.sectionAtPointer());
          }
        } else {
          // divertAt reached; next frame starts steering
          this._raf = requestAnimationFrame(frame);
        }
      };
      this._raf = requestAnimationFrame(frame);
    });
  }

  // --- Drag to rotate / fling to spin ---

  /**
   * Enable one-finger drag on an element (usually the stage).
   * Drag moves the wheel; a fast release flings it with momentum.
   * @param {HTMLElement} el
   * @param {{
   *   canStart?: () => boolean,
   *   onDragStart?: () => void,
   *   onFling?: (velocityRadPerSec: number) => void | Promise<void>,
   *   onDragEndIdle?: () => void,
   * }} [hooks]
   */
  enablePointerDrag(el, hooks = {}) {
    if (!el || this._dragBound) return;
    this._dragEl = el;
    this._dragHooks = hooks;
    this._dragBound = true;
    el.style.touchAction = "none";
    el.style.cursor = "grab";

    this._onDragPointerDown = (e) => this._dragPointerDown(e);
    this._onDragPointerMove = (e) => this._dragPointerMove(e);
    this._onDragPointerUp = (e) => this._dragPointerUp(e);

    el.addEventListener("pointerdown", this._onDragPointerDown);
    window.addEventListener("pointermove", this._onDragPointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", this._onDragPointerUp);
    window.addEventListener("pointercancel", this._onDragPointerUp);
  }

  _pointerAngle(e) {
    const parent = this.wheelCanvas.parentElement || this.wheelCanvas;
    const rect = parent.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx);
  }

  _dragPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (this._dragging) return;
    // Ignore UI chrome inside stage (result buttons, etc.)
    if (
      e.target.closest &&
      e.target.closest(
        "button, a, input, select, textarea, #result-rigged, .result-actions-bar, .result-center-inner, .result-banner, .btn-toggle-sidebar"
      )
    ) {
      return;
    }
    if (!this.sections.length) return;

    // Grab mid-spin: stop animation and take over with drag
    const interrupted = this.spinning;
    if (interrupted) {
      this.cancelAnimatedSpin();
    } else if (this._dragHooks?.canStart && !this._dragHooks.canStart()) {
      return;
    }

    e.preventDefault();
    this._dragging = true;
    this._dragPointerId = e.pointerId;
    this._dragLastAngle = this._pointerAngle(e);
    this._dragSamples = [{ t: performance.now(), rot: this.rotation }];
    this._lastSeg = this._tickIndex();
    this._lastTickAudioAt = 0;

    // Freeze media layout while dragging (same path as spin)
    this._spinSlices = this._computeSlices();
    this._slicesCache = this._spinSlices;
    const w = this.wheelCanvas.width;
    const h = this.wheelCanvas.height;
    this._spinCx = w / 2;
    this._spinCy = h / 2;
    this._spinRadius = Math.min(w, h) * 0.42;
    this._spinSingle = this._spinSlices.length === 1;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.add("is-spinning");
    }

    if (this._dragEl) this._dragEl.style.cursor = "grabbing";
    try {
      this._dragEl?.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    this._dragHooks?.onDragStart?.({ interrupted });
    this.draw({ spinFrame: true });
  }

  _dragPointerMove(e) {
    if (!this._dragging || e.pointerId !== this._dragPointerId) return;
    e.preventDefault();

    const angle = this._pointerAngle(e);
    let d = angle - this._dragLastAngle;
    // Shortest path unwrap
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this._dragLastAngle = angle;
    this.rotation += d;

    const now = performance.now();
    this._dragSamples.push({ t: now, rot: this.rotation });
    // Keep ~120ms of samples for velocity
    const cutoff = now - 120;
    while (this._dragSamples.length > 2 && this._dragSamples[0].t < cutoff) {
      this._dragSamples.shift();
    }

    // Ticks while dragging
    const seg = this._tickIndex();
    if (seg !== this._lastSeg) {
      if (now - this._lastTickAudioAt >= 28) {
        this._lastTickAudioAt = now;
        const samples = this._dragSamples;
        let speed = 0.5;
        if (samples.length >= 2) {
          const a = samples[0];
          const b = samples[samples.length - 1];
          const dt = (b.t - a.t) / 1000;
          if (dt > 0) {
            speed = Math.min(1, Math.abs(b.rot - a.rot) / dt / 20);
          }
        }
        this.onTick(speed);
      }
      this._lastSeg = seg;
    }

    this.draw({ spinFrame: true });
  }

  _dragPointerUp(e) {
    if (!this._dragging) return;
    if (e && this._dragPointerId != null && e.pointerId !== this._dragPointerId) {
      return;
    }

    const samples = this._dragSamples;
    this._dragging = false;
    this._dragPointerId = null;
    if (this._dragEl) this._dragEl.style.cursor = "grab";

    // Angular velocity rad/s from recent samples
    let velocity = 0;
    if (samples.length >= 2) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.01) velocity = (b.rot - a.rot) / dt;
    }

    this._dragSamples = [];
    // Clear frozen geometry from drag; fling will re-freeze
    this._spinSlices = null;
    this._slicesCache = null;

    const FLING_MIN = 2.2; // rad/s — below this, just leave wheel where it is
    if (Math.abs(velocity) >= FLING_MIN && this.sections.length) {
      this._dragHooks?.onFling?.(velocity);
    } else {
      if (this.sliceRotatorEl) {
        this.sliceRotatorEl.classList.remove("is-spinning");
      }
      this.draw({ spinFrame: false });
      this._dragHooks?.onDragEndIdle?.();
    }
  }

  /**
   * Momentum spin from a fling. Decelerates until stop, then lands under the pointer.
   * @param {number} velocityRadPerSec
   * @param {{ forceSectionId?: string|null, onSteerStart?: () => void, steerMs?: number }} [opts]
   * @returns {Promise<object|null>}
   */
  fling(velocityRadPerSec, opts = {}) {
    if (this.spinning || this._dragging || !this.sections.length) {
      return Promise.resolve(null);
    }

    // Cap so a wild flick doesn't spin forever
    let v = Math.max(-50, Math.min(50, Number(velocityRadPerSec) || 0));
    if (Math.abs(v) < 0.5) {
      this.draw({ spinFrame: false });
      return Promise.resolve(null);
    }

    const forceId = opts.forceSectionId || null;

    // Freeze geometry
    this._spinSlices = this._computeSlices();
    this._slicesCache = this._spinSlices;
    const w = this.wheelCanvas.width;
    const h = this.wheelCanvas.height;
    this._spinCx = w / 2;
    this._spinCy = h / 2;
    this._spinRadius = Math.min(w, h) * 0.42;
    this._spinSingle = this._spinSlices.length === 1;

    this.spinning = true;
    this._lastSeg = this._tickIndex();
    this._lastTickAudioAt = 0;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.add("is-spinning");
    }

    // Stronger friction when faster feels more natural
    const friction = 1.65; // 1/s exponential decay rate
    const stopSpeed = 0.35; // rad/s
    // |v| such that ~0.1s remains until stop under exp decay
    const vDivert = stopSpeed * Math.exp(friction * 0.1);
    const canRig =
      !!forceId && this._spinSlices.some((s) => s.section.id === forceId);
    const minTickGapMs = 28;
    const steerMs = Math.max(
      250,
      Math.min(8000, Number(opts.steerMs) || 1100)
    );

    return new Promise((resolve) => {
      this._spinResolve = resolve;
      let last = performance.now();
      let steering = false;
      let steerStart = 0;
      let steerFrom = 0;
      let steerTarget = 0;

      const finish = (win) => {
        this.spinning = false;
        this._spinSlices = null;
        this._slicesCache = null;
        this._raf = 0;
        if (this.sliceRotatorEl) {
          this.sliceRotatorEl.classList.remove("is-spinning");
        }
        this.draw({ spinFrame: false });
        this.onLand(win);
        const r = this._spinResolve;
        this._spinResolve = null;
        if (r) r(win);
      };

      const frame = (now) => {
        if (!this.spinning) return;

        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        if (canRig && !steering && Math.abs(v) <= vDivert) {
          // Must not "land" on the rigged section before divert — kick past it.
          const under = this.sectionAtPointer();
          if (
            under &&
            under.id === forceId &&
            this._spinSlices.length > 1
          ) {
            const kick = Math.max(1.8, vDivert * 3);
            v = (Math.sign(v) || 1) * kick;
          } else {
            // ~0.1s before natural stop — slowly move to rigged section
            // (shortest path: reverse if closer)
            steering = true;
            steerStart = now;
            steerFrom = this.rotation;
            steerTarget = this.targetRotationForSection(
              forceId,
              steerFrom,
              "shortest"
            );
            try {
              opts.onSteerStart?.();
            } catch {
              /* ignore */
            }
          }
        }

        if (steering) {
          const t = Math.min(1, (now - steerStart) / steerMs);
          const e = easeOutQuart(t);
          this.rotation = steerFrom + (steerTarget - steerFrom) * e;

          const seg = this._tickIndex();
          if (seg !== this._lastSeg) {
            if (now - this._lastTickAudioAt >= minTickGapMs) {
              this._lastTickAudioAt = now;
              this.onTick(Math.max(0.08, 1 - t));
            }
            this._lastSeg = seg;
          }
          this.draw({ spinFrame: true });
          this.onFrame(t);
          if (t < 1) {
            this._raf = requestAnimationFrame(frame);
          } else {
            this.rotation = steerTarget;
            finish(this.sectionAtPointer());
          }
          return;
        }

        this.rotation += v * dt;
        v *= Math.exp(-friction * dt);

        const seg = this._tickIndex();
        if (seg !== this._lastSeg) {
          if (now - this._lastTickAudioAt >= minTickGapMs) {
            this._lastTickAudioAt = now;
            const speed = Math.min(1, Math.abs(v) / 25);
            this.onTick(speed);
          }
          this._lastSeg = seg;
        }

        this.draw({ spinFrame: true });
        this.onFrame(Math.min(1, 1 - Math.abs(v) / 50));

        if (Math.abs(v) > stopSpeed) {
          this._raf = requestAnimationFrame(frame);
        } else if (
          canRig &&
          this._spinSlices.length > 1 &&
          this.sectionAtPointer()?.id === forceId
        ) {
          // Still on rigged at full stop — kick and keep going until decoy land
          v = (Math.sign(v) || 1) * 1.8;
          this._raf = requestAnimationFrame(frame);
        } else {
          finish(this.sectionAtPointer());
        }
      };
      this._raf = requestAnimationFrame(frame);
    });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    if (this._dragBound && this._dragEl) {
      this._dragEl.removeEventListener("pointerdown", this._onDragPointerDown);
      window.removeEventListener("pointermove", this._onDragPointerMove);
      window.removeEventListener("pointerup", this._onDragPointerUp);
      window.removeEventListener("pointercancel", this._onDragPointerUp);
    }
  }
}
