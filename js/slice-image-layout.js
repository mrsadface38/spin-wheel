/**
 * Shared fill-image layout for the main wheel and editor previews.
 *
 * Wedge box is 2r×2r with the wheel center at (r, r).
 *
 * Fill images use a FIXED wheel-space frame (same for every slice), matching the
 * full-circle group/section preview. Each wedge only clips that shared framing —
 * so offset X/Y and scale look the same on the wheel as in the editor.
 */

/**
 * @param {object} opts
 * @param {number} opts.radius CSS px radius of the wheel
 * @param {number} [opts.fillScale] 0.1–3
 * @param {number} [opts.offsetXPct] -100..100 (right positive)
 * @param {number} [opts.offsetYPct] -100..100 (down positive, same as CSS top)
 * @returns {{ left: number, top: number, fillScale: number }}
 */
export function computeFillImageLayout({
  radius,
  fillScale = 1,
  offsetXPct = 0,
  offsetYPct = 0,
}) {
  const r = Math.max(1, Number(radius) || 1);
  const scale = Math.min(3, Math.max(0.1, Number(fillScale) || 1));
  const oxPct = Math.min(100, Math.max(-100, Number(offsetXPct) || 0));
  const oyPct = Math.min(100, Math.max(-100, Number(offsetYPct) || 0));
  const ox = (oxPct / 100) * r;
  const oy = (oyPct / 100) * r;

  // Same anchor as the editor full-disc preview: slightly “up” from hub (-π/2),
  // then absolute X/Y offsets in the 2r box (CSS: +X right, +Y down).
  const mid = -Math.PI / 2;
  const anchorDist = r * 0.55;
  const ax = r + Math.cos(mid) * anchorDist; // = r
  const ay = r + Math.sin(mid) * anchorDist; // = r - 0.55r

  return {
    left: ax + ox,
    top: ay + oy,
    fillScale: scale,
  };
}
