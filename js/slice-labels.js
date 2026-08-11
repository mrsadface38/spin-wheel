/**
 * Shared radial slice labels — same drawing for the main wheel and editor previews.
 * Text runs inside → outside along the radius; multi-word names may wrap.
 */

/** Safe text width (never throws / never undefined). */
export function measureLabelWidth(ctx, text) {
  try {
    const m = ctx.measureText(String(text ?? ""));
    const w = m && typeof m.width === "number" ? m.width : 0;
    return Number.isFinite(w) ? w : 0;
  } catch {
    return String(text ?? "").length * 8;
  }
}

/**
 * Normalize wheel label style (weight / italic).
 * @param {unknown} v
 * @param {string} [fallback="bold"]
 * @returns {"normal"|"bold"|"italic"|"bold-italic"}
 */
export function normalizeTextStyle(v, fallback = "bold") {
  if (
    v === "normal" ||
    v === "bold" ||
    v === "italic" ||
    v === "bold-italic"
  ) {
    return v;
  }
  return fallback === "normal" ||
    fallback === "bold" ||
    fallback === "italic" ||
    fallback === "bold-italic"
    ? fallback
    : "bold";
}

/** @type {{ id: string, label: string, css: string }[]} */
export const TEXT_FONT_OPTIONS = [
  {
    id: "system",
    label: "System",
    css: '"Segoe UI", system-ui, -apple-system, sans-serif',
  },
  { id: "arial", label: "Arial", css: "Arial, Helvetica, sans-serif" },
  { id: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  {
    id: "trebuchet",
    label: "Trebuchet MS",
    css: '"Trebuchet MS", Helvetica, sans-serif',
  },
  { id: "georgia", label: "Georgia", css: "Georgia, serif" },
  {
    id: "times",
    label: "Times New Roman",
    css: '"Times New Roman", Times, serif',
  },
  {
    id: "courier",
    label: "Courier New",
    css: '"Courier New", Courier, monospace',
  },
  {
    id: "comic",
    label: "Comic Sans",
    css: '"Comic Sans MS", "Comic Sans", cursive',
  },
  { id: "impact", label: "Impact", css: "Impact, Haettenschweiler, sans-serif" },
];

/**
 * @param {unknown} v
 * @param {string} [fallback="system"]
 */
export function normalizeTextFont(v, fallback = "system") {
  if (typeof v === "string" && TEXT_FONT_OPTIONS.some((o) => o.id === v)) {
    return v;
  }
  if (typeof fallback === "string" && TEXT_FONT_OPTIONS.some((o) => o.id === fallback)) {
    return fallback;
  }
  return "system";
}

/** @param {unknown} fontId */
export function cssFontFamily(fontId) {
  const id = normalizeTextFont(fontId, "system");
  return (
    TEXT_FONT_OPTIONS.find((o) => o.id === id)?.css ||
    TEXT_FONT_OPTIONS[0].css
  );
}

/**
 * CSS font shorthand for canvas labels.
 * @param {unknown} style weight/italic
 * @param {number} sizePx
 * @param {unknown} [fontId] family id
 */
export function fontFromTextStyle(style, sizePx, fontId = "system") {
  const s = normalizeTextStyle(style);
  const italic = s === "italic" || s === "bold-italic" ? "italic " : "";
  // Bold = 700 (historic default); normal = 400
  const weight = s === "bold" || s === "bold-italic" ? 700 : 400;
  const px = Math.max(1, Number(sizePx) || 16);
  const family = cssFontFamily(fontId);
  return `${italic}${weight} ${px}px ${family}`;
}

/**
 * Word-wrap so each line fits maxWidth (full text, no ellipsis).
 * @returns {string[]}
 */
export function wrapLabelLines(ctx, label, maxWidth) {
  const text = String(label || "").trim();
  if (!text) return [];
  const maxW = Math.max(1, Number(maxWidth) || 1);
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (measureLabelWidth(ctx, trial) <= maxW || !line) {
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
    if (measureLabelWidth(ctx, ln) <= maxW) {
      out.push(ln);
      continue;
    }
    let chunk = "";
    for (const ch of ln) {
      const t = chunk + ch;
      if (measureLabelWidth(ctx, t) <= maxW || !chunk) chunk = t;
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
 * Wrap into at most maxLines by widening the line budget if needed.
 * Still hard-breaks tokens; never drops characters.
 * @returns {string[]}
 */
export function wrapLabelLinesMax(ctx, label, maxWidth, maxLines) {
  const cap = Math.max(1, Math.min(12, Math.floor(maxLines) || 1));
  let w = Math.max(1, Number(maxWidth) || 1);
  let lines = wrapLabelLines(ctx, label, w);
  if (lines.length <= cap) return lines;
  const full = measureLabelWidth(ctx, String(label || "").trim()) || w;
  let lo = w;
  let hi = Math.max(w * 2, full + 1);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    lines = wrapLabelLines(ctx, label, mid);
    if (lines.length <= cap) hi = mid;
    else lo = mid;
  }
  lines = wrapLabelLines(ctx, label, hi);
  if (lines.length <= cap) return lines;
  const text = String(label || "").trim();
  if (!text) return [];
  const n = Math.ceil(text.length / cap);
  const packed = [];
  for (let i = 0; i < cap; i++) {
    const chunk = text.slice(i * n, (i + 1) * n);
    if (chunk) packed.push(chunk);
  }
  return packed.length ? packed : [text];
}

/**
 * Draw one slice label in wheel-local coords (origin at hub; +x east, +y south).
 *
 * @param {CanvasRenderingContext2D} ctx  already translated to hub (not rotated for mid)
 * @param {object} opts
 * @param {number} opts.radius canvas px radius
 * @param {number} opts.mid wedge mid angle (radians)
 * @param {number} opts.span wedge span (radians)
 * @param {string} opts.label
 * @param {string} [opts.textColor]
 * @param {string} [opts.textStyle] normal | bold | italic | bold-italic
 * @param {string} [opts.textFont] font family id (system, arial, …)
 * @param {number} [opts.centerSize] hub size fraction 0–1 (Look)
 * @param {number} [opts.dpr]
 * @param {boolean} [opts.showLabels]
 * @param {boolean} [opts.asSolidDisc] single full-wheel section
 * @param {boolean} [opts.forceRadial] always hub→rim (skip horizontal full-disc layout)
 * @param {boolean} [opts.spinFrame] reserved (shadow kept for readable outline while spinning)
 * @param {string} [opts.fallbackTextColor]
 */
export function drawSliceLabel(ctx, opts = {}) {
  if (!ctx) return;
  if (opts.showLabels === false) return;
  try {
    const mid = Number(opts.mid) || 0;
    const span = Math.max(0.001, Number(opts.span) || 0.001);
    const label = String(opts.label || "").trim();
    if (!label) return;

    const radius = Math.max(1, Number(opts.radius) || 1);
    const dpr = Math.max(0.5, Number(opts.dpr) || 1);
    const wordCount = label.split(/\s+/).filter(Boolean).length;
    const allowWrap = wordCount > 1;
    // forceRadial: editor previews always want multi-slice style (hub → rim)
    const solid =
      !opts.forceRadial &&
      (opts.asSolidDisc === true || span >= Math.PI * 2 - 1e-4);
    const baseFont = Math.max(16, 48 * dpr);
    const lineGap = 1.12;
    const textStyle = normalizeTextStyle(opts.textStyle, "bold");
    const textFont = normalizeTextFont(opts.textFont, "system");

    ctx.save();
    ctx.fillStyle =
      opts.textColor || opts.fallbackTextColor || "#fff";
    ctx.textBaseline = "middle";
    // Soft dark halo = the original “border”. Keep it while spinning so labels
    // stay readable (no hard strokeText, which made glyphs look blocky).
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 4 * dpr;
    ctx.font = fontFromTextStyle(textStyle, baseFont, textFont);
    let th = baseFont * 1.05;
    try {
      const m = ctx.measureText(label);
      const asc = m.actualBoundingBoxAscent || 0;
      const desc = m.actualBoundingBoxDescent || 0;
      if (asc + desc > 1) th = Math.max(baseFont * 0.95, (asc + desc) * 1.02);
    } catch {
      /* keep estimate */
    }
    const lineH = th * lineGap;

    // ——— Full-wheel single section: horizontal near top rim ———
    if (solid) {
      const maxBlockH = radius * 0.28;
      const maxW = radius * 1.55;
      const maxLines = allowWrap
        ? Math.max(1, Math.min(6, Math.floor(maxBlockH / (th * 0.35))))
        : 1;
      const layoutSolid = (s) => {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        const maxWm = maxW / s;
        const maxLinesS = allowWrap
          ? Math.max(
              1,
              Math.min(maxLines, Math.floor(maxBlockH / (lineH * s)))
            )
          : 1;
        const lines = allowWrap
          ? wrapLabelLinesMax(ctx, label, maxWm, maxLinesS)
          : [label];
        if (!lines.length) return null;
        const longest = Math.max(
          ...lines.map((ln) => measureLabelWidth(ctx, ln)),
          1
        );
        if (longest * s > maxW + 0.5) return null;
        if (lines.length * lineH * s > maxBlockH + 0.5) return null;
        return { lines, longest, s };
      };
      let lo = 0;
      let hi = Math.min(0.45, (radius * 0.18) / baseFont);
      if (!Number.isFinite(hi) || hi <= 0) hi = 0.12;
      hi *= 1.1;
      for (let i = 0; i < 28; i++) {
        const midS = (lo + hi) / 2;
        if (layoutSolid(midS)) lo = midS;
        else hi = midS;
      }
      const best = layoutSolid(lo) || layoutSolid(0.06);
      if (!best || best.s * baseFont < 5 * dpr) {
        ctx.restore();
        return;
      }
      const { lines, s } = best;
      const blockH = lines.length * lineH * s;
      const rText = radius - 10 * dpr - blockH / 2;
      ctx.textAlign = "center";
      ctx.translate(0, -rText);
      ctx.scale(s, s);
      for (let i = 0; i < lines.length; i++) {
        const y = (i - (lines.length - 1) / 2) * lineH;
        ctx.fillText(lines[i], 0, y);
      }
      ctx.restore();
      return;
    }

    // ——— Multi-slice: radial inside → outside; wrap across the wedge ———
    const rimPad = Math.max(4 * dpr, radius * 0.012);
    const outerR = radius - rimPad;
    const hubR =
      radius * Math.max(0.12, (Number(opts.centerSize) || 0.16) + 0.015);
    const maxRadial = Math.max(8 * dpr, outerR - hubR);

    const chordH = (r) => {
      if (!(r > 0)) return 0;
      const half = r * Math.sin(Math.min(Math.PI / 2, span / 2));
      const pad = Math.max(0.75 * dpr, half * 0.08);
      return Math.max(0, (half - pad) * 2);
    };

    const maxFontPx = radius * 0.3;
    const maxLinesCap = allowWrap ? 8 : 1;

    const layoutAt = (s) => {
      if (!(s > 0) || !Number.isFinite(s)) return null;
      const maxWm = maxRadial / s;
      const chordOuter = chordH(outerR);
      const maxLinesS = allowWrap
        ? Math.max(
            1,
            Math.min(maxLinesCap, Math.floor((chordOuter + 0.5) / (lineH * s)))
          )
        : 1;
      const lines = allowWrap
        ? wrapLabelLinesMax(ctx, label, maxWm, maxLinesS)
        : [label];
      if (!lines.length || lines.length > maxLinesS) return null;
      const longest = Math.max(
        ...lines.map((ln) => measureLabelWidth(ctx, ln)),
        1
      );
      const w = longest * s;
      if (w > maxRadial + 0.5) return null;
      const rInner = outerR - w;
      if (rInner < hubR - 0.5) return null;
      const blockH = lines.length * lineH * s;
      if (blockH > chordOuter + 0.5) return null;
      if (blockH > chordH(Math.max(rInner, hubR)) + 0.5) return null;
      return { lines, longest, s };
    };

    let lo = 0;
    let hi = Math.max(
      maxFontPx / baseFont,
      chordH(outerR) / th,
      maxRadial / Math.max(8, label.length * baseFont * 0.35)
    );
    if (!Number.isFinite(hi) || hi <= 0) hi = 0.1;
    hi *= 1.05;
    for (let i = 0; i < 28; i++) {
      const midS = (lo + hi) / 2;
      if (layoutAt(midS)) lo = midS;
      else hi = midS;
    }
    let best = layoutAt(lo);
    if (!best || best.s * baseFont < 5.5 * dpr) {
      for (const px of [8, 6.5, 5.5, 4.8]) {
        const sTry = (px * dpr) / baseFont;
        const lay = layoutAt(sTry);
        if (lay) {
          best = lay;
          break;
        }
      }
    }
    if (!best || best.s * baseFont < 4.2 * dpr) {
      ctx.restore();
      return;
    }

    const { lines, longest, s } = best;
    const textW = longest * s;

    // +x = radial out. Longest line ends on the rim; extra lines stack on +y.
    ctx.rotate(mid);
    ctx.translate(outerR - textW, 0);
    ctx.textAlign = "left";
    ctx.scale(s, s);
    for (let i = 0; i < lines.length; i++) {
      const y = (i - (lines.length - 1) / 2) * lineH;
      ctx.fillText(lines[i], 0, y);
    }
    ctx.restore();
  } catch (err) {
    try {
      ctx.restore();
    } catch {
      /* ignore */
    }
    console.warn("Label draw skipped:", opts?.label, err);
  }
}
