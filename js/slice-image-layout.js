/**
 * Shared fill-image layout for the main wheel and editor previews.
 *
 * Wedge box is 2r×2r with the wheel center at (r, r).
 *
 * Modes (look.imageLayoutMode):
 * - "fixed" (default): frame is always top-oriented (mid = -π/2), matching the
 *   section/group editor preview. Offsets stay in screen X/Y; images stay upright
 *   on the wheel (each wedge only clips the shared frame).
 * - "slice": frame is rotated to the wedge mid-angle so what you edit at the top
 *   maps onto the real slice position (photo + offsets rotate with the wedge).
 */

/** Editor / fixed-frame mid angle (top of the wheel). */
export const FILL_EDITOR_MID = -Math.PI / 2;

/**
 * @param {object} opts
 * @param {number} opts.radius CSS px radius of the wheel
 * @param {number} [opts.fillScale] 0.1–3
 * @param {number} [opts.offsetXPct] -100..100 (right positive in editor frame)
 * @param {number} [opts.offsetYPct] -100..100 (down positive in editor frame)
 * @param {number} [opts.midAngle] wedge mid angle in wheel radians
 * @param {"fixed"|"slice"} [opts.mode]
 * @returns {{ left: number, top: number, fillScale: number, orientDeg: number }}
 */
export function computeFillImageLayout({
  radius,
  fillScale = 1,
  offsetXPct = 0,
  offsetYPct = 0,
  midAngle = FILL_EDITOR_MID,
  mode = "fixed",
}) {
  const r = Math.max(1, Number(radius) || 1);
  const scale = Math.min(3, Math.max(0.1, Number(fillScale) || 1));
  const oxPct = Math.min(100, Math.max(-100, Number(offsetXPct) || 0));
  const oyPct = Math.min(100, Math.max(-100, Number(offsetYPct) || 0));
  let ox = (oxPct / 100) * r;
  let oy = (oyPct / 100) * r;

  const follow = mode === "slice";
  const mid = follow
    ? Number.isFinite(Number(midAngle))
      ? Number(midAngle)
      : FILL_EDITOR_MID
    : FILL_EDITOR_MID;

  // Rotate editor-frame offsets into the real wedge orientation.
  let orientDeg = 0;
  if (follow) {
    const delta = mid - FILL_EDITOR_MID;
    orientDeg = (delta * 180) / Math.PI;
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    const rx = ox * c - oy * s;
    const ry = ox * s + oy * c;
    ox = rx;
    oy = ry;
  }

  const anchorDist = r * 0.55;
  const ax = r + Math.cos(mid) * anchorDist;
  const ay = r + Math.sin(mid) * anchorDist;

  return {
    left: ax + ox,
    top: ay + oy,
    fillScale: scale,
    orientDeg,
  };
}

/** Normalize Look image layout mode. */
export function normalizeImageLayoutMode(v) {
  return v === "slice" ? "slice" : "fixed";
}
