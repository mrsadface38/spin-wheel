/**
 * Capture a spinning wheel stage and encode a downloadable GIF.
 */
import { GIFEncoder, quantize, applyPalette } from "./gifenc.esm.js";

/** Default max longest side — sharp enough for share; GIF still capped for file size. */
export const GIF_DEFAULT_MAX_SIDE = 720;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.stageEl
 * @param {HTMLCanvasElement|null} [opts.bgCanvas]
 * @param {HTMLCanvasElement|null} [opts.wheelCanvas]
 * @param {HTMLCanvasElement|null} [opts.overlayCanvas]
 * @param {string} [opts.bgColor]
 * @param {HTMLElement|null} [opts.pointerEl]
 * @param {number} [opts.maxSide] longest output side in px
 * @returns {{ canvas: HTMLCanvasElement, width: number, height: number, imageData: ImageData }}
 */
export function captureStageFrame(opts = {}) {
  const stageEl = opts.stageEl;
  if (!stageEl) throw new Error("No stage to capture");
  const rect = stageEl.getBoundingClientRect();
  const cssW = Math.max(32, rect.width);
  const cssH = Math.max(32, rect.height);
  const maxSide = Math.max(128, Number(opts.maxSide) || GIF_DEFAULT_MAX_SIDE);

  // Prefer high-DPI canvas buffers (devicePixelRatio) over CSS box size
  const srcW = Math.max(
    opts.wheelCanvas?.width || 0,
    opts.bgCanvas?.width || 0,
    opts.overlayCanvas?.width || 0,
    Math.round(cssW * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1))
  );
  const srcH = Math.max(
    opts.wheelCanvas?.height || 0,
    opts.bgCanvas?.height || 0,
    opts.overlayCanvas?.height || 0,
    Math.round(cssH * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1))
  );

  // Output at source resolution, only shrink if above maxSide (never upscale mush)
  let width = Math.max(64, srcW);
  let height = Math.max(64, srcH);
  const long = Math.max(width, height);
  if (long > maxSide) {
    const s = maxSide / long;
    width = Math.max(64, Math.round(width * s));
    height = Math.max(64, Math.round(height * s));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");

  ctx.imageSmoothingEnabled = true;
  try {
    ctx.imageSmoothingQuality = "high";
  } catch {
    /* older engines */
  }

  // Solid stage fill (matches Look background when canvases are transparent)
  ctx.fillStyle = opts.bgColor || "#0f1220";
  ctx.fillRect(0, 0, width, height);

  const layers = [opts.bgCanvas, opts.wheelCanvas, opts.overlayCanvas];
  for (const c of layers) {
    if (!c || !c.width || !c.height) continue;
    try {
      ctx.drawImage(c, 0, 0, width, height);
    } catch {
      /* tainted / missing */
    }
  }

  // DOM slice images (fill/tile media) — best-effort
  try {
    drawDomMediaLayer(ctx, stageEl, width, height, rect);
  } catch {
    /* ignore */
  }

  // Winner pointer triangle
  try {
    drawPointerEl(ctx, opts.pointerEl, width, height, rect);
  } catch {
    /* ignore */
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return { canvas, width, height, imageData };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLElement} stageEl
 * @param {number} outW
 * @param {number} outH
 * @param {DOMRect} stageRect
 */
function drawDomMediaLayer(ctx, stageEl, outW, outH, stageRect) {
  const sx = outW / Math.max(1, stageRect.width);
  const sy = outH / Math.max(1, stageRect.height);
  const nodes = stageEl.querySelectorAll(
    ".slice-media-rotator img, .slice-media-rotator video, .center-media img, .center-media video, .bg-media img, .bg-media video"
  );
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const x = (r.left - stageRect.left) * sx;
    const y = (r.top - stageRect.top) * sy;
    const w = r.width * sx;
    const h = r.height * sy;
    try {
      if (node instanceof HTMLVideoElement) {
        if (node.readyState >= 2) ctx.drawImage(node, x, y, w, h);
      } else if (node instanceof HTMLImageElement && node.complete && node.naturalWidth) {
        ctx.drawImage(node, x, y, w, h);
      }
    } catch {
      /* cross-origin */
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLElement|null|undefined} pointerEl
 * @param {number} outW
 * @param {number} outH
 * @param {DOMRect} stageRect
 */
function drawPointerEl(ctx, pointerEl, outW, outH, stageRect) {
  if (!pointerEl || pointerEl.style.visibility === "hidden") return;
  const r = pointerEl.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return;
  const sx = outW / Math.max(1, stageRect.width);
  const sy = outH / Math.max(1, stageRect.height);
  const cx = (r.left + r.width / 2 - stageRect.left) * sx;
  const cy = (r.top + r.height / 2 - stageRect.top) * sy;
  // Read CSS transform rotate if present
  let rot = 0;
  const t = pointerEl.style.transform || "";
  const m = t.match(/rotate\(([-0-9.]+)rad\)/);
  if (m) rot = Number(m[1]) || 0;
  else {
    const md = t.match(/rotate\(([-0-9.]+)deg\)/);
    if (md) rot = ((Number(md[1]) || 0) * Math.PI) / 180;
  }
  const scale = Math.min(sx, sy);
  const halfW = 16 * scale;
  const tipH = 28 * scale;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  // Triangle pointing down in default coords (matches border-top CSS triangle)
  ctx.beginPath();
  ctx.moveTo(0, tipH * 0.35);
  ctx.lineTo(-halfW, -tipH * 0.65);
  ctx.lineTo(halfW, -tipH * 0.65);
  ctx.closePath();
  ctx.fillStyle = getComputedStyle(pointerEl).borderTopColor || "#f0d78c";
  ctx.fill();
  ctx.restore();
}

/**
 * @param {ImageData[]} frames
 * @param {number} width
 * @param {number} height
 * @param {number} delayMs frame delay in ms
 * @returns {Uint8Array}
 */
export function encodeGifFromFrames(frames, width, height, delayMs = 80) {
  if (!frames?.length) throw new Error("No frames to encode");
  const gif = GIFEncoder();
  // GIF delay is in 1/100s; keep frames smooth
  const delay = Math.max(2, Math.round(Number(delayMs) || 80));
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const data = frame?.data || frame;
    // Copy so quantize can round pixels without mutating other frames
    const rgba = new Uint8Array(
      data instanceof Uint8Array || data instanceof Uint8ClampedArray
        ? data
        : data.buffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : data
    );
    // Full 256-color palette per frame for less banding on gradients/images
    const palette = quantize(rgba, 256, { format: "rgb565", oneBitAlpha: false });
    const index = applyPalette(rgba, palette, "rgb565");
    gif.writeFrame(index, width, height, {
      palette,
      delay,
      // dispose restore to background for cleaner motion
      dispose: 2,
    });
  }
  gif.finish();
  return gif.bytes();
}

/**
 * @param {string} filename
 * @param {Blob|Uint8Array} data
 */
export function downloadBinary(filename, data) {
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data], { type: "image/gif" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Record frames while `isBusy()` is true, after optional `start()` begins motion.
 * @param {object} opts
 * @param {() => void|Promise<void>} [opts.start] kick off spin
 * @param {() => boolean} opts.isBusy true while animation should be captured
 * @param {() => ImageData} opts.captureFrame
 * @param {number} [opts.fps]
 * @param {number} [opts.maxMs]
 * @param {number} [opts.holdMs] extra frames after busy ends
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<ImageData[]>}
 */
export async function recordWhileBusy(opts) {
  const fps = Math.min(30, Math.max(8, Number(opts.fps) || 16));
  const delayMs = Math.round(1000 / fps);
  const maxMs = Math.max(2000, Number(opts.maxMs) || 20000);
  const holdMs = Math.max(0, Number(opts.holdMs) || 500);
  const frames = [];
  const isBusy = opts.isBusy;
  const captureFrame = opts.captureFrame;
  const onStatus = opts.onStatus;

  if (typeof opts.start === "function") {
    onStatus?.("Spinning…");
    await opts.start();
  }

  // Wait briefly for spin flag to assert
  const waitStart = Date.now();
  while (!isBusy() && Date.now() - waitStart < 800) {
    await sleep(16);
  }

  onStatus?.("Recording…");
  const recStart = Date.now();
  while (isBusy() && Date.now() - recStart < maxMs) {
    try {
      frames.push(captureFrame());
    } catch (err) {
      console.warn("gif frame:", err);
    }
    await sleep(delayMs);
  }

  // Hold last pose / result a moment
  const holdUntil = Date.now() + holdMs;
  while (Date.now() < holdUntil) {
    try {
      frames.push(captureFrame());
    } catch {
      /* ignore */
    }
    await sleep(delayMs);
  }

  if (!frames.length) throw new Error("No frames captured");
  return frames;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
