/**
 * Canvas wheel renderer + spin animation.
 * Section / center / background media use DOM <img> (static images only — no GIF).
 */

import {
  computeFillImageLayout,
  normalizeImageLayoutMode,
} from "./slice-image-layout.js";
import {
  measureLabelWidth,
  wrapLabelLines,
  wrapLabelLinesMax,
  drawSliceLabel,
} from "./slice-labels.js";

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

/** True if src is a GIF (unsupported — converted to a static PNG frame). */
export function isGifImageSrc(src) {
  if (!src || typeof src !== "string") return false;
  const head = src.slice(0, 40).toLowerCase();
  if (head.startsWith("data:image/gif")) return true;
  if (/\.gif(\?|#|$)/i.test(src)) return true;
  return false;
}

/** @deprecated use isGifImageSrc — kept so older imports don't break */
export function isLikelyAnimatedImage(src) {
  return isGifImageSrc(src);
}

/** Snapshot an HTMLImageElement to a (possibly downscaled) PNG data URL. */
function snapshotImageToPng(img, maxEdge = 1024) {
  try {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 1 || h < 1) return null;
    let dw = w;
    let dh = h;
    const edge = Math.max(w, h);
    if (edge > maxEdge) {
      const sc = maxEdge / edge;
      dw = Math.max(1, Math.round(w * sc));
      dh = Math.max(1, Math.round(h * sc));
    }
    const c = document.createElement("canvas");
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, dw, dh);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Cache: original GIF data URL → static PNG (first frame). */
const gifStaticCache = new Map();

/**
 * Resolve a displayable static image URL.
 * GIFs are converted once to a PNG still so they never animate (or lag).
 * @param {string} src
 * @returns {Promise<string>}
 */
export async function resolveStaticImageSrc(src) {
  if (!src || typeof src !== "string") return src;
  if (!isGifImageSrc(src)) return src;
  if (gifStaticCache.has(src)) return gifStaticCache.get(src);
  const img = await loadImage(src);
  if (!img) {
    gifStaticCache.set(src, src);
    return src;
  }
  const png = snapshotImageToPng(img, 1024) || src;
  gifStaticCache.set(src, png);
  return png;
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
    /** DOM triangle that marks the winner ray */
    this.pointerEl = options.pointerEl || null;

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
    /** @type {ReturnType<typeof setTimeout>|0} */
    this._spinWatchdog = 0;
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
      this.layoutPointer();
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
    await this._syncBgMedia();
    await this._syncCenterMedia();
    this.draw();
  }

  /**
   * Degrees: 0 = top, 90 = right (default), 180 = bottom, 270 = left.
   * @returns {number}
   */
  pointerAngleDeg() {
    const d = Number(this.look?.pointerAngleDeg);
    if (!Number.isFinite(d)) return 90;
    return ((d % 360) + 360) % 360;
  }

  /**
   * Canvas/screen angle of the pointer ray (0 = east, clockwise, y-down).
   * Right (default 90°) = 0; top (0°) = −π/2.
   * @returns {number}
   */
  pointerScreenAngle() {
    return (this.pointerAngleDeg() * Math.PI) / 180 - Math.PI / 2;
  }

  /** Whether Look locks the pointer in place (default true). */
  isPointerLocked() {
    return this.look?.pointerLocked !== false;
  }

  /**
   * Place the DOM pointer on the rim, tip toward the hub.
   * Call after resize / look change / pointer drag.
   */
  layoutPointer() {
    const el = this.pointerEl;
    if (!el) return;
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    if (w < 2 || h < 2) return;

    const cx = w / 2;
    const cy = h / 2;
    const wheelR = Math.min(w, h) * 0.42;
    const ang = this.pointerScreenAngle();
    // Sit just outside the rim so the tip kisses the border
    const dist = wheelR + 14;
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist;
    // Triangle defaults pointing down; rotate so tip faces the hub
    const rot = ang + Math.PI / 2;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = `translate(-50%, -50%) rotate(${rot}rad)`;

    const locked = this.isPointerLocked();
    const canDrag = !locked && !this.spinning && !this._dragging;
    el.classList.toggle("is-locked", locked);
    el.classList.toggle("is-unlocked", !locked);
    el.classList.toggle("is-draggable", canDrag);
    el.style.pointerEvents = canDrag ? "auto" : "none";
    el.title = locked
      ? "Pointer locked (Look → unlock to move)"
      : canDrag
        ? "Drag to move winner pointer (snaps to 0° / 90° / 180° / 270°)"
        : "Pointer";
    el.setAttribute("aria-hidden", locked ? "true" : "false");
  }

  /**
   * @param {Array} sections active sections with imageData
   */
  async setSections(sections) {
    this.sections = sections;
    this.invalidateGeometry();
    const urls = sections.map((s) => s.imageData).filter(Boolean);
    // Convert any legacy GIFs → static PNG before caching/display
    const staticUrls = await Promise.all(
      urls.map((url) => resolveStaticImageSrc(url))
    );
    await Promise.all(
      staticUrls.map(async (url) => {
        if (!this._images.has(url)) {
          const img = await loadImage(url);
          if (img) this._images.set(url, img);
        }
      })
    );
    await this._rebuildSliceMedia();
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
    // Wheel-local angle under the movable pointer
    let a = this.pointerScreenAngle() - this.rotation;
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

  async _syncBgMedia() {
    const el = this.bgMediaEl;
    if (!el) return;
    const raw = this.look.backgroundImage;
    if (!raw) {
      el.innerHTML = "";
      el.style.backgroundImage = "";
      el.classList.remove("has-media");
      return;
    }
    const src = await resolveStaticImageSrc(raw);
    const existing = el.querySelector("img");
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

  async _syncCenterMedia() {
    const el = this.centerMediaEl;
    if (!el) return;
    const raw = this.look.centerImage;
    if (!raw) {
      el.innerHTML = "";
      el.classList.remove("has-media");
      return;
    }
    const src = await resolveStaticImageSrc(raw);
    const existing = el.querySelector("img");
    if (existing && existing.dataset.liveSrc === src) {
      el.classList.add("has-media");
      this._layoutCenterMedia();
      return;
    }
    el.innerHTML = "";
    const img = document.createElement("img");
    img.src = src;
    img.dataset.liveSrc = src;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
    el.classList.add("has-media");
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

  async _rebuildSliceMedia() {
    const rotator = this.sliceRotatorEl;
    if (!rotator) return;

    const key =
      this.sections
        .map((s) => this._sectionMediaSig(s))
        .join("|") +
      `|show:${this.look.showImages !== false}` +
      `|layout:${normalizeImageLayoutMode(this.look.imageLayoutMode)}`;
    this._sectionMediaKey = key;
    rotator.innerHTML = "";

    if (this.look.showImages === false) return;

    const slices = this.getSlices();
    const radius = this._radiusCss() || 200;

    // Resolve any legacy GIF data → static PNG (no animation)
    const resolved = await Promise.all(
      slices.map(async (sl) => ({
        sl,
        src: sl.section.imageData
          ? await resolveStaticImageSrc(sl.section.imageData)
          : null,
      }))
    );

    for (const { sl, src } of resolved) {
      if (!src) continue;
      const mode = sl.section.imageMode === "tile" ? "tile" : "fill";
      const wedge = document.createElement("div");
      wedge.className = `slice-bg-wedge mode-${mode}`;
      wedge.dataset.sectionId = sl.section.id;
      wedge.dataset.imageMode = mode;

      if (mode === "tile") {
        const layer = document.createElement("div");
        layer.className = "slice-bg-tile-layer";
        layer.dataset.src = src;
        layer.dataset.liveSrc = src;
        wedge.appendChild(layer);
      } else {
        const img = document.createElement("img");
        img.className = "slice-bg-fill";
        img.src = src;
        img.dataset.liveSrc = src;
        img.alt = sl.section.label || "";
        img.draggable = false;
        img.decoding = "async";
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
      s.imageRotation ?? 0,
    ].join(":");
  }

  /**
   * Tile pattern across the wedge using ONE CSS background layer.
   * Avoids dozens of animated <img> tags (GIFs used to spawn up to ~220 decoders).
   * @param {number} offsetXPct -100..100 (% of one tile)
   * @param {number} offsetYPct -100..100 (% of one tile)
   * @param {number|null} [sliceMid] when set, rotate pattern with wedge mid-angle
   * @param {number} [imageRotationDeg] per-image rotation
   */
  _fillTileGrid(
    wedge,
    src,
    radius,
    tileScale,
    offsetXPct = 0,
    offsetYPct = 0,
    sliceMid = null,
    imageRotationDeg = 0
  ) {
    const layer = wedge.querySelector(".slice-bg-tile-layer");
    if (!layer || !src) return;

    const base = Math.max(22, radius * 0.2);
    const scale = Math.min(3, Math.max(0.1, Number(tileScale) || 1));
    const tilePx = Math.max(10, base * scale);
    const d = radius * 2;
    const ox =
      (Math.min(100, Math.max(-100, Number(offsetXPct) || 0)) / 100) * tilePx;
    const oy =
      (Math.min(100, Math.max(-100, Number(offsetYPct) || 0)) / 100) * tilePx;

    let orientDeg = 0;
    if (sliceMid != null && Number.isFinite(Number(sliceMid))) {
      orientDeg = ((Number(sliceMid) - -Math.PI / 2) * 180) / Math.PI;
    }
    const imgRot = Number(imageRotationDeg) || 0;
    const rot = orientDeg + imgRot;
    wedge.style.setProperty("--slice-orient", `${orientDeg}deg`);

    const paintSrc = layer.dataset.liveSrc || src;
    layer.dataset.src = src;
    if (!layer.dataset.liveSrc) layer.dataset.liveSrc = src;

    const sig = `${paintSrc}|${tilePx.toFixed(2)}|${ox.toFixed(1)}|${oy.toFixed(1)}`;
    if (layer.dataset.sig !== sig) {
      layer.dataset.sig = sig;
      layer.style.backgroundImage = `url(${JSON.stringify(paintSrc)})`;
      layer.style.backgroundSize = `${tilePx}px ${tilePx}px`;
      layer.style.backgroundRepeat = "repeat";
      layer.style.backgroundPosition = `${ox}px ${oy}px`;
    } else {
      layer.style.backgroundSize = `${tilePx}px ${tilePx}px`;
      layer.style.backgroundPosition = `${ox}px ${oy}px`;
    }

    layer.style.width = `${d}px`;
    layer.style.height = `${d}px`;
    layer.style.left = "0";
    layer.style.top = "0";
    layer.style.transformOrigin = "50% 50%";
    layer.style.transform = `rotate(${rot}deg)`;
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

      const rot = Number(sl.section.imageRotation) || 0;
      wedge.style.setProperty("--image-rotation", `${rot}deg`);

      const layoutMode = normalizeImageLayoutMode(this.look.imageLayoutMode);
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
          sl.section.imageTileOffsetY ?? 0,
          layoutMode === "slice" ? sl.mid : null,
          Number(sl.section.imageRotation) || 0
        );
      } else if (mode === "fill") {
        this._layoutFillImage(wedge, sl, radius);
      }
    }
  }

  /**
   * Place full-slice image (static <img> or animated canvas proxy).
   * fixed  → top-oriented frame (matches section editor)
   * slice  → rotated to wedge mid so editor framing maps to the real slice
   */
  _layoutFillImage(wedge, sl, radius) {
    const layoutMode = normalizeImageLayoutMode(this.look.imageLayoutMode);
    const layout = computeFillImageLayout({
      radius,
      fillScale: sl.section.imageFillScale,
      offsetXPct: sl.section.imageFillOffsetX,
      offsetYPct: sl.section.imageFillOffsetY,
      midAngle: sl.mid,
      mode: layoutMode,
    });
    wedge.style.setProperty("--fill-scale", String(layout.fillScale));
    wedge.style.setProperty("--slice-orient", `${layout.orientDeg || 0}deg`);
    const rot = Number(sl.section.imageRotation) || 0;
    wedge.style.setProperty("--image-rotation", `${rot}deg`);

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
          `|show:${this.look.showImages !== false}` +
          `|layout:${normalizeImageLayoutMode(this.look.imageLayoutMode)}`;
        if (mediaKey !== this._sectionMediaKey) {
          void this._rebuildSliceMedia();
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
    if (!spinFrame) {
      this.layoutPointer();
    }

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

    // Center hub BEFORE labels so names are never painted under the hub
    const hubR = radius * (this.look.centerSize ?? 0.16);
    front.beginPath();
    front.arc(0, 0, hubR, 0, Math.PI * 2);
    front.fillStyle = this.look.centerColor || "#1a1f35";
    front.fill();
    front.strokeStyle = this.look.borderColor || "#f0d78c";
    front.lineWidth = 4 * this._dpr;
    front.stroke();

    // Labels last (on top of hub/separators) — clipped to each wedge so no bleed
    for (const sl of slices) {
      try {
        front.save();
        if (!single) {
          // Keep text strictly inside this slice
          front.beginPath();
          front.moveTo(0, 0);
          front.arc(0, 0, radius, sl.start, sl.end);
          front.closePath();
          front.clip();
        }
        this._drawSliceLabel(front, sl, radius, single, spinFrame);
        front.restore();
      } catch (err) {
        try {
          front.restore();
        } catch {
          /* ignore */
        }
        console.warn("Label draw failed:", err);
      }
    }

    try {
      front.restore();
    } catch {
      /* ignore unbalanced save/restore */
    }
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
   * Radial labels (shared with editor preview — see slice-labels.js).
   * @param {boolean} spinFrame kept for API; soft shadow always drawn for readability
   */
  _drawSliceLabel(ctx, sl, radius, asSolidDisc = false, spinFrame = false) {
    drawSliceLabel(ctx, {
      radius,
      mid: sl?.mid,
      span: sl?.span,
      label: sl?.section?.label,
      textColor: sl?.section?.textColor,
      textStyle: sl?.section?.textStyle || this.look.textStyle || "bold",
      fallbackTextColor: this.look.textColor || "#fff",
      centerSize: this.look.centerSize ?? 0.16,
      dpr: this._dpr || 1,
      showLabels: this.look.showLabels !== false,
      asSolidDisc,
      spinFrame,
    });
  }

  _measureWidth(ctx, text) {
    return measureLabelWidth(ctx, text);
  }

  _wrapLabelLines(ctx, label, maxWidth) {
    return wrapLabelLines(ctx, label, maxWidth);
  }

  _wrapLabelLinesMax(ctx, label, maxWidth, maxLines) {
    return wrapLabelLinesMax(ctx, label, maxWidth, maxLines);
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
   * Pick a random land angle inside a slice, using a centered landable zone.
   * @param {{ start: number, span: number }} sl
   * @param {number} [landZonePct] 1–99 = % of slice the pointer may hit (default 99)
   * @returns {number} absolute angle on the wheel
   */
  _randomLandLocal(sl, landZonePct = 99) {
    let pct = Number(landZonePct);
    if (!Number.isFinite(pct)) pct = 99;
    pct = Math.min(99, Math.max(1, pct));
    // Remainder is split as equal margin on both sides (avoids borders)
    const marginFrac = (1 - pct / 100) / 2;
    const pad = sl.span * marginFrac;
    const usable = Math.max(0.001, sl.span - pad * 2);
    return sl.start + pad + Math.random() * usable;
  }

  /**
   * Base land rotation for a section (not adjusted for current angle).
   * pointer angle a = φ - rotation  ⇒  rotation = φ - landLocal
   * (φ = pointerScreenAngle; default right is 0)
   */
  _landRotationBase(sectionId) {
    const slices = this.getSlices();
    const sl = slices.find((s) => s.section.id === sectionId);
    if (!sl) return null;
    const landLocal = this._randomLandLocal(
      sl,
      this._spinLandZonePct ?? 99
    );
    return this.pointerScreenAngle() - landLocal;
  }

  /**
   * Weighted random slice index. When exclude is set and at least one other
   * slice exists, those section id(s) can never be the natural / escape pick.
   * @param {Array<{section: {id: string, weight?: number}}>} slices
   * @param {string|string[]|Set<string>|null} [exclude]
   * @returns {number}
   */
  _pickNaturalWinnerIndex(slices, exclude = null) {
    if (!slices.length) return 0;
    let excludeSet = null;
    if (exclude instanceof Set) {
      excludeSet = exclude;
    } else if (Array.isArray(exclude)) {
      excludeSet = new Set(exclude.filter(Boolean));
    } else if (exclude) {
      excludeSet = new Set([exclude]);
    }
    const pool =
      excludeSet && excludeSet.size && slices.length > 1
        ? slices
            .map((sl, i) => ({ sl, i }))
            .filter(({ sl }) => !excludeSet.has(sl.section.id))
        : slices.map((sl, i) => ({ sl, i }));
    // If everything was excluded, fall back to full pool
    const use = pool.length ? pool : slices.map((sl, i) => ({ sl, i }));
    if (!use.length) return 0;
    let total = 0;
    for (const { sl } of use) {
      total += Math.max(0.1, sl.section.weight || 1);
    }
    let r = Math.random() * total;
    for (const { sl, i } of use) {
      r -= Math.max(0.1, sl.section.weight || 1);
      if (r <= 0) return i;
    }
    return use[use.length - 1].i;
  }

  /**
   * @param {string|string[]|Set<string>|null|undefined} raw
   * @returns {Set<string>}
   */
  _asIdSet(raw) {
    if (!raw) return new Set();
    if (raw instanceof Set) return raw;
    if (Array.isArray(raw)) return new Set(raw.filter(Boolean));
    return new Set([raw]);
  }

  /**
   * Build full avoid id set from explicit ids + any slice that belongs to avoidGroupId.
   * Ensures reverse-group mode covers every on-wheel member of that group.
   * @param {Array<{section: {id: string, groupIds?: string[], groupId?: string}}>} slices
   * @param {string|string[]|Set<string>|null|undefined} avoidSectionIds
   * @param {string|null|undefined} avoidGroupId
   * @returns {Set<string>}
   */
  _buildAvoidIdSet(slices, avoidSectionIds, avoidGroupId) {
    const avoidIds = this._asIdSet(avoidSectionIds);
    if (avoidGroupId) {
      for (const sl of slices) {
        const sec = sl.section;
        if (!sec) continue;
        let gids = [];
        if (Array.isArray(sec.groupIds) && sec.groupIds.length) {
          gids = sec.groupIds.filter(Boolean);
        } else if (sec.groupId) {
          gids = [sec.groupId];
        }
        // Also accept stringified match (defensive)
        if (
          gids.includes(avoidGroupId) ||
          gids.some((id) => String(id) === String(avoidGroupId))
        ) {
          avoidIds.add(sec.id);
        }
      }
    }
    return avoidIds;
  }

  /**
   * Weighted pick among slices whose section id is in includeSet.
   * @param {Array<{section: {id: string, weight?: number}}>} slices
   * @param {Set<string>} includeSet
   * @returns {number} index into slices
   */
  _pickIndexAmongIds(slices, includeSet) {
    if (!slices.length) return 0;
    const pool = slices
      .map((sl, i) => ({ sl, i }))
      .filter(({ sl }) => includeSet.has(sl.section.id));
    if (!pool.length) return this._pickNaturalWinnerIndex(slices, null);
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
   * Pick a non-avoided section to slide onto — nearest neighbor (shortest glide).
   * @param {Array<{section: {id: string}}>} slices
   * @param {Set<string>} avoidIds
   * @param {number} fromRot
   * @param {string|string[]|Set<string>|null} [alsoExclude] e.g. force target so reverse doesn't land on it before rig phase
   * @returns {string|null}
   */
  _pickEscapeSectionId(slices, avoidIds, fromRot, alsoExclude = null) {
    const extra = this._asIdSet(alsoExclude);
    let candidates = slices.filter(
      (sl) => !avoidIds.has(sl.section.id) && !extra.has(sl.section.id)
    );
    // If excluding force left no options, allow force as escape (phase 2 may still move)
    if (!candidates.length) {
      candidates = slices.filter((sl) => !avoidIds.has(sl.section.id));
    }
    if (!candidates.length) return null;
    let bestId = candidates[0].section.id;
    let bestDist = Infinity;
    for (const sl of candidates) {
      const target = this.targetRotationForSection(
        sl.section.id,
        fromRot,
        "shortest"
      );
      const dist = Math.abs(target - fromRot);
      // Prefer the closest land; tiny jitter only breaks exact ties
      const score = dist + Math.random() * 1e-4;
      if (score < bestDist) {
        bestDist = score;
        bestId = sl.section.id;
      }
    }
    return bestId;
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

  /** Keep rotation in [0, 2π) so canvas / CSS transforms stay precise. */
  _normalizeRotation() {
    const TWO_PI = Math.PI * 2;
    if (!Number.isFinite(this.rotation)) {
      this.rotation = 0;
      return;
    }
    this.rotation = ((this.rotation % TWO_PI) + TWO_PI) % TWO_PI;
  }

  /**
   * Shared end-of-spin cleanup. Always resolves the in-flight promise even if
   * draw / onLand throw — otherwise spinBusy stays true and the wheel dies.
   * @param {object|null} win
   * @param {{ fireLand?: boolean }} [opts]
   */
  _endAnimatedSpin(win, opts = {}) {
    const fireLand = opts.fireLand !== false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    if (this._spinWatchdog) {
      clearTimeout(this._spinWatchdog);
      this._spinWatchdog = 0;
    }
    this.spinning = false;
    this._spinSlices = null;
    this._slicesCache = null;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.remove("is-spinning");
    }
    this._normalizeRotation();
    try {
      if (!this.wheelCanvas.width || !this.wheelCanvas.height) {
        this._applySizeFromParent();
      }
      this.draw({ spinFrame: false });
      this.layoutPointer();
    } catch (err) {
      console.warn("draw after spin failed:", err);
      try {
        this._applySizeFromParent();
        this.draw({ spinFrame: false });
        this.layoutPointer();
      } catch {
        /* last resort — still resolve */
      }
    }
    if (fireLand) {
      try {
        this.onLand(win);
      } catch (err) {
        console.warn("onLand failed:", err);
      }
    }
    const resolve = this._spinResolve;
    this._spinResolve = null;
    if (resolve) {
      try {
        resolve(win);
      } catch (err) {
        console.warn("spin resolve failed:", err);
      }
    }
  }

  /**
   * Stop a timed spin or fling immediately (e.g. user grabbed the wheel).
   * Does not fire onLand. Resolves the in-flight promise with null.
   */
  cancelAnimatedSpin() {
    if (!this.spinning && !this._raf && !this._spinResolve) return false;
    // Keep current rotation; leave geometry for possible drag takeover
    this._endAnimatedSpin(null, { fireLand: false });
    return true;
  }

  /**
   * @param {number} durationSec
   * @param {{
   *   forceSectionId?: string|null,
   *   avoidSectionIds?: string[]|Set<string>|null,
   *   avoidGroupId?: string|null,
   *   onSteerStart?: () => void,
   *   onReverseSteerStart?: () => void,
   *   steerMs?: number,
   *   reverseSteerMs?: number,
   *   comboOrder?: "reverse-first"|"rig-first",
   * }} [opts]
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

    const forceId = opts.forceSectionId || null;
    // Group reverse: include EVERY on-wheel member of avoidGroupId, not one random
    const avoidIds = this._buildAvoidIdSet(
      slices,
      opts.avoidSectionIds,
      opts.avoidGroupId
    );
    const comboOrder =
      opts.comboOrder === "rig-first" ? "rig-first" : "reverse-first";
    const canForce =
      !!forceId && slices.some((s) => s.section.id === forceId);
    const canReverse =
      avoidIds.size > 0 &&
      slices.length > 1 &&
      slices.some((s) => avoidIds.has(s.section.id)) &&
      slices.some((s) => !avoidIds.has(s.section.id));

    // Natural aim depends on combo order when both systems are armed:
    // - reverse-first: almost-land on an avoided slice so reverse is visible first
    // - rig-first: never natural-land on the forced section (divert onto it first)
    // - reverse only: almost-land on avoided
    // - force only: exclude force
    let winnerIndex;
    if (canReverse && canForce) {
      if (comboOrder === "rig-first") {
        winnerIndex = this._pickNaturalWinnerIndex(slices, forceId);
      } else {
        winnerIndex = this._pickIndexAmongIds(slices, avoidIds);
      }
    } else if (canReverse) {
      winnerIndex = this._pickIndexAmongIds(slices, avoidIds);
    } else {
      winnerIndex = this._pickNaturalWinnerIndex(slices, forceId);
    }
    const winnerSlice = slices[winnerIndex];
    {
      let z = Number(opts.landZonePct);
      if (!Number.isFinite(z)) z = 99;
      this._spinLandZonePct = Math.min(99, Math.max(1, Math.round(z)));
    }
    const landLocal = this._randomLandLocal(
      winnerSlice,
      this._spinLandZonePct
    );

    const current = this.rotation;
    const phi = this.pointerScreenAngle();
    let target = phi - landLocal;
    const extraSpins = Math.max(6, Math.round(durationSec * 1.1) + Math.floor(Math.random() * 3));
    while (target <= current) target += Math.PI * 2;
    target += extraSpins * Math.PI * 2;

    const isSingle = this._spinSingle;
    const spins = isSingle
      ? Math.max(8, Math.round(durationSec * 1.4) + Math.floor(Math.random() * 4))
      : extraSpins;
    if (isSingle) {
      target = phi - landLocal;
      while (target <= current) target += Math.PI * 2;
      target += spins * Math.PI * 2;
    }

    this.spinning = true;
    this.layoutPointer();
    this._lastSeg = this._tickIndex();
    this._lastTickAudioAt = 0;
    if (this.sliceRotatorEl) {
      this.sliceRotatorEl.classList.add("is-spinning");
    }
    const startRot = current;
    const delta = target - startRot;
    const duration = Math.max(0.5, durationSec) * 1000;
    const startTime = performance.now();
    const divertMs = 100;
    const divertAt = Math.max(0, duration - divertMs);
    const forceSteerMs = Math.max(
      250,
      Math.min(8000, Number(opts.steerMs) || 1100)
    );
    const reverseSteerMs = Math.max(
      400,
      Math.min(12000, Number(opts.reverseSteerMs) || forceSteerMs)
    );
    const needsLateSteer = canReverse || canForce;
    const minTickGapMs = 28;
    // Cap total animation so a dead RAF path can't freeze the wheel forever
    const maxSpinMs =
      duration +
      (needsLateSteer ? reverseSteerMs + forceSteerMs + 2000 : 2000);

    return new Promise((resolve) => {
      this._spinResolve = resolve;
      let steering = false;
      let steerStart = 0;
      let steerFrom = 0;
      let steerTarget = 0;
      let activeSteerMs = forceSteerMs;
      /** @type {"reverse"|"force"|null} */
      let activePhase = null;
      /** After current phase, optionally run the other */
      let pendingSecondPhase = null;
      let finished = false;

      const finish = (win) => {
        if (finished) return;
        finished = true;
        this._endAnimatedSpin(win, { fireLand: true });
      };

      if (this._spinWatchdog) clearTimeout(this._spinWatchdog);
      this._spinWatchdog = setTimeout(() => {
        if (!finished && this.spinning) {
          console.warn("Spin watchdog: forcing land");
          finish(this.sectionAtPointer());
        }
      }, maxSpinMs);

      /**
       * @param {number} now
       * @param {{ excludeForce?: boolean }} [steerOpts]
       */
      const beginReverseSteer = (now, steerOpts = {}) => {
        // When force will follow, don't escape onto the force target (so phase 2 is visible)
        const alsoExclude =
          steerOpts.excludeForce && forceId ? forceId : null;
        const escapeId =
          this._pickEscapeSectionId(
            slices,
            avoidIds,
            this.rotation,
            alsoExclude
          ) ||
          slices[this._pickNaturalWinnerIndex(slices, avoidIds)].section.id;
        steering = true;
        activePhase = "reverse";
        steerStart = now;
        steerFrom = this.rotation;
        activeSteerMs = reverseSteerMs;
        steerTarget = this.targetRotationForSection(
          escapeId,
          steerFrom,
          "shortest"
        );
        // Skip zero-length reverse (already there)
        if (Math.abs(steerTarget - steerFrom) < 1e-4) {
          steering = false;
          activePhase = null;
          return false;
        }
        try {
          opts.onReverseSteerStart?.();
        } catch {
          /* ignore sound errors */
        }
        return true;
      };

      const beginForceSteer = (now) => {
        if (!forceId) return false;
        steering = true;
        activePhase = "force";
        steerStart = now;
        steerFrom = this.rotation;
        activeSteerMs = forceSteerMs;
        steerTarget = this.targetRotationForSection(
          forceId,
          steerFrom,
          "shortest"
        );
        if (Math.abs(steerTarget - steerFrom) < 1e-4) {
          // Already on force target — treat as complete for chaining
          steering = false;
          activePhase = null;
          return false;
        }
        try {
          opts.onSteerStart?.();
        } catch {
          /* ignore sound errors */
        }
        return true;
      };

      /** Start first late-steer phase based on combo order */
      const beginFirstLatePhase = (now) => {
        if (comboOrder === "rig-first") {
          // Rig divert first, then reverse-slide if we end on an avoided slice
          if (canForce) {
            pendingSecondPhase = canReverse ? "reverse" : null;
            if (!beginForceSteer(now)) {
              // Already on force — maybe still need reverse
              if (pendingSecondPhase === "reverse") {
                pendingSecondPhase = null;
                const underId = this.sectionAtPointer()?.id || null;
                if (underId && avoidIds.has(underId)) {
                  if (!beginReverseSteer(now)) finish(this.sectionAtPointer());
                } else {
                  finish(this.sectionAtPointer());
                }
              } else {
                finish(this.sectionAtPointer());
              }
            }
            return;
          }
          if (canReverse) {
            pendingSecondPhase = null;
            if (!beginReverseSteer(now)) finish(this.sectionAtPointer());
          }
          return;
        }
        // reverse-first (default): slide off avoid, then divert to rig
        if (canReverse) {
          pendingSecondPhase = canForce ? "force" : null;
          if (!beginReverseSteer(now, { excludeForce: canForce })) {
            // Reverse was zero-length — go straight to force if needed
            if (pendingSecondPhase === "force") {
              pendingSecondPhase = null;
              if (!beginForceSteer(now)) finish(this.sectionAtPointer());
            } else {
              finish(this.sectionAtPointer());
            }
          }
          return;
        }
        if (canForce) {
          pendingSecondPhase = null;
          if (!beginForceSteer(now)) finish(this.sectionAtPointer());
        }
      };

      const onPhaseComplete = (now) => {
        this.rotation = steerTarget;
        steering = false;
        const finishedPhase = activePhase;
        activePhase = null;
        if (pendingSecondPhase === "force" && canForce) {
          pendingSecondPhase = null;
          if (beginForceSteer(now)) {
            this._raf = requestAnimationFrame(frame);
            return;
          }
          // Force was zero-length — finish
          finish(this.sectionAtPointer());
          return;
        }
        if (pendingSecondPhase === "reverse" && canReverse) {
          pendingSecondPhase = null;
          const underId = this.sectionAtPointer()?.id || null;
          // After rig: reverse only if we landed on an avoided section/group
          if (underId && avoidIds.has(underId)) {
            if (beginReverseSteer(now)) {
              this._raf = requestAnimationFrame(frame);
              return;
            }
          }
        }
        pendingSecondPhase = null;
        void finishedPhase;
        finish(this.sectionAtPointer());
      };

      const frame = (now) => {
        if (!this.spinning) return;

        const elapsed = now - startTime;

        if (needsLateSteer && !steering && elapsed >= divertAt && !activePhase) {
          beginFirstLatePhase(now);
          // beginFirstLatePhase may finish immediately without scheduling
          if (!this.spinning) return;
        }

        if (steering) {
          const t = Math.min(1, (now - steerStart) / activeSteerMs);
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
          else onPhaseComplete(now);
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

        if (elapsed < divertAt || !needsLateSteer) {
          if (t < 1) this._raf = requestAnimationFrame(frame);
          else if (needsLateSteer) {
            // Full spin ended — run the same ordered late phases
            beginFirstLatePhase(now);
            if (!this.spinning || finished) return;
            if (steering || pendingSecondPhase) {
              this._raf = requestAnimationFrame(frame);
            } else {
              this.rotation = target;
              finish(this.sectionAtPointer());
            }
          } else {
            this.rotation = target;
            finish(this.sectionAtPointer());
          }
        } else {
          // Past divertAt, not in a steer phase — must not spin forever
          if (!steering && !activePhase) {
            beginFirstLatePhase(now);
            if (!this.spinning || finished) return;
            if (steering || pendingSecondPhase) {
              this._raf = requestAnimationFrame(frame);
              return;
            }
            this.rotation = target;
            finish(this.sectionAtPointer());
            return;
          }
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
   *   getFairDragSpin?: () => boolean,
   * }} [hooks]
   * getFairDragSpin: when true, any intentional drag-release counts as a spin
   * (not only a fast flick). App then runs a full timed spin instead of fling.
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
        "button, a, input, select, textarea, #pointer, #result-rigged, .result-actions-bar, .result-center-inner, .result-banner, .btn-toggle-sidebar"
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

    // Both modes need a real flick speed; fair mode still uses full timed spin
    // (app ignores velocity magnitude) but won't start on a slow park / aim drag.
    const FLING_MIN = 2.2; // rad/s — below this, leave the wheel where it is
    const shouldSpin =
      this.sections.length > 0 && Math.abs(velocity) >= FLING_MIN;
    if (shouldSpin) {
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
   * @param {{
   *   forceSectionId?: string|null,
   *   avoidSectionIds?: string[]|Set<string>|null,
   *   avoidGroupId?: string|null,
   *   onSteerStart?: () => void,
   *   onReverseSteerStart?: () => void,
   *   steerMs?: number,
   *   reverseSteerMs?: number,
   *   comboOrder?: "reverse-first"|"rig-first",
   * }} [opts]
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
    {
      let z = Number(opts.landZonePct);
      if (!Number.isFinite(z)) z = 99;
      this._spinLandZonePct = Math.min(99, Math.max(1, Math.round(z)));
    }

    // Freeze geometry
    this._spinSlices = this._computeSlices();
    this._slicesCache = this._spinSlices;
    const slices = this._spinSlices;
    const avoidIds = this._buildAvoidIdSet(
      slices,
      opts.avoidSectionIds,
      opts.avoidGroupId
    );
    const w = this.wheelCanvas.width;
    const h = this.wheelCanvas.height;
    this._spinCx = w / 2;
    this._spinCy = h / 2;
    this._spinRadius = Math.min(w, h) * 0.42;
    this._spinSingle = slices.length === 1;

    this.spinning = true;
    this.layoutPointer();
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
    const comboOrder =
      opts.comboOrder === "rig-first" ? "rig-first" : "reverse-first";
    const canForce =
      !!forceId && slices.some((s) => s.section.id === forceId);
    const canReverse =
      avoidIds.size > 0 &&
      slices.length > 1 &&
      slices.some((s) => avoidIds.has(s.section.id)) &&
      slices.some((s) => !avoidIds.has(s.section.id));
    const minTickGapMs = 28;
    const forceSteerMs = Math.max(
      250,
      Math.min(8000, Number(opts.steerMs) || 1100)
    );
    const reverseSteerMs = Math.max(
      400,
      Math.min(12000, Number(opts.reverseSteerMs) || forceSteerMs)
    );
    const maxFlingMs =
      30000 + (canReverse || canForce ? reverseSteerMs + forceSteerMs : 0);

    return new Promise((resolve) => {
      this._spinResolve = resolve;
      let last = performance.now();
      let steering = false;
      let steerStart = 0;
      let steerFrom = 0;
      let steerTarget = 0;
      let activeSteerMs = forceSteerMs;
      let activePhase = null;
      let pendingSecondPhase = null;
      let finished = false;
      let forceKickCount = 0;
      const MAX_FORCE_KICKS = 8;

      const finish = (win) => {
        if (finished) return;
        finished = true;
        this._endAnimatedSpin(win, { fireLand: true });
      };

      if (this._spinWatchdog) clearTimeout(this._spinWatchdog);
      this._spinWatchdog = setTimeout(() => {
        if (!finished && this.spinning) {
          console.warn("Fling watchdog: forcing land");
          finish(this.sectionAtPointer());
        }
      }, maxFlingMs);

      /** @returns {boolean} true if a steer phase started */
      const startReverseSteer = (now, excludeForce = false) => {
        const escapeId =
          this._pickEscapeSectionId(
            slices,
            avoidIds,
            this.rotation,
            excludeForce && forceId ? forceId : null
          ) ||
          slices[this._pickNaturalWinnerIndex(slices, avoidIds)].section.id;
        const from = this.rotation;
        const to = this.targetRotationForSection(escapeId, from, "shortest");
        if (Math.abs(to - from) < 1e-4) return false;
        steering = true;
        activePhase = "reverse";
        steerStart = now;
        steerFrom = from;
        activeSteerMs = reverseSteerMs;
        steerTarget = to;
        try {
          opts.onReverseSteerStart?.();
        } catch {
          /* ignore */
        }
        return true;
      };

      /** @returns {boolean} true if a steer phase started */
      const startForceSteer = (now) => {
        if (!forceId) return false;
        const from = this.rotation;
        const to = this.targetRotationForSection(forceId, from, "shortest");
        if (Math.abs(to - from) < 1e-4) return false;
        steering = true;
        activePhase = "force";
        steerStart = now;
        steerFrom = from;
        activeSteerMs = forceSteerMs;
        steerTarget = to;
        try {
          opts.onSteerStart?.();
        } catch {
          /* ignore */
        }
        return true;
      };

      const onFlingPhaseComplete = (now) => {
        this.rotation = steerTarget;
        steering = false;
        activePhase = null;
        if (pendingSecondPhase === "force" && canForce) {
          pendingSecondPhase = null;
          if (startForceSteer(now)) {
            this._raf = requestAnimationFrame(frame);
            return;
          }
          finish(this.sectionAtPointer());
          return;
        }
        if (pendingSecondPhase === "reverse" && canReverse) {
          pendingSecondPhase = null;
          const underId = this.sectionAtPointer()?.id || null;
          if (underId && avoidIds.has(underId)) {
            if (startReverseSteer(now, false)) {
              this._raf = requestAnimationFrame(frame);
              return;
            }
          }
        }
        pendingSecondPhase = null;
        finish(this.sectionAtPointer());
      };

      const beginFlingFirstPhase = (now, underId) => {
        if (comboOrder === "rig-first") {
          // Force divert first, then reverse if we stop on an avoided slice
          if (canForce) {
            if (
              underId === forceId &&
              slices.length > 1 &&
              forceKickCount < MAX_FORCE_KICKS
            ) {
              forceKickCount += 1;
              const kick = Math.max(1.8, vDivert * 3);
              v = (Math.sign(v) || 1) * kick;
              return false;
            }
            pendingSecondPhase = canReverse ? "reverse" : null;
            if (startForceSteer(now)) return true;
            pendingSecondPhase = null;
            if (canReverse && underId && avoidIds.has(underId)) {
              return startReverseSteer(now, false);
            }
            return false;
          }
          if (canReverse && underId && avoidIds.has(underId)) {
            return startReverseSteer(now, false);
          }
          return false;
        }
        // reverse-first: slide off avoid first, then divert to rig
        if (canReverse && underId && avoidIds.has(underId)) {
          pendingSecondPhase = canForce ? "force" : null;
          if (startReverseSteer(now, canForce)) return true;
          pendingSecondPhase = null;
          if (canForce) {
            if (
              underId === forceId &&
              slices.length > 1 &&
              forceKickCount < MAX_FORCE_KICKS
            ) {
              forceKickCount += 1;
              v = (Math.sign(v) || 1) * Math.max(1.8, vDivert * 3);
              return false;
            }
            return startForceSteer(now);
          }
          return false;
        }
        if (canForce) {
          if (
            underId === forceId &&
            slices.length > 1 &&
            forceKickCount < MAX_FORCE_KICKS
          ) {
            forceKickCount += 1;
            const kick = Math.max(1.8, vDivert * 3);
            v = (Math.sign(v) || 1) * kick;
            return false;
          }
          return startForceSteer(now);
        }
        return false;
      };

      const frame = (now) => {
        if (!this.spinning || finished) return;

        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        if (!steering && Math.abs(v) <= vDivert) {
          const underId = this.sectionAtPointer()?.id || null;
          beginFlingFirstPhase(now, underId);
        }

        if (steering) {
          const t = Math.min(1, (now - steerStart) / activeSteerMs);
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
            onFlingPhaseComplete(now);
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
        } else {
          const underId = this.sectionAtPointer()?.id || null;
          if (beginFlingFirstPhase(now, underId)) {
            this._raf = requestAnimationFrame(frame);
          } else if (
            canForce &&
            slices.length > 1 &&
            underId === forceId &&
            forceKickCount < MAX_FORCE_KICKS
          ) {
            forceKickCount += 1;
            v = (Math.sign(v) || 1) * 1.8;
            this._raf = requestAnimationFrame(frame);
          } else {
            finish(this.sectionAtPointer());
          }
        }
      };
      this._raf = requestAnimationFrame(frame);
    });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this._spinWatchdog) {
      clearTimeout(this._spinWatchdog);
      this._spinWatchdog = 0;
    }
    this._spinResolve = null;
    this.spinning = false;
    this._resizeObserver.disconnect();
    if (this._dragBound && this._dragEl) {
      this._dragEl.removeEventListener("pointerdown", this._onDragPointerDown);
      window.removeEventListener("pointermove", this._onDragPointerMove);
      window.removeEventListener("pointerup", this._onDragPointerUp);
      window.removeEventListener("pointercancel", this._onDragPointerUp);
    }
  }
}
