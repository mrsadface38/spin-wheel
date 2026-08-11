/**
 * Starter wheel presets for “+ New”.
 * Each preset builds a full project state (groups, sections, look, sound, …).
 */

import {
  defaultState,
  normalizeGroup,
  normalizeProfileFields,
  uid,
} from "./state.js";

/** Solid d20 palette — pure RGB (hex only for normalizeHexColor). */
const D20_BLUE = { color: "#0000ff", text: "#ffffff" }; // 0, 0, 255
const D20_RED = { color: "#ff0000", text: "#ffffff" }; // 255, 0, 0
const D20_GREEN = { color: "#00ff00", text: "#1a1408" }; // 0, 255, 0
const D20_CYAN = { color: "#00ffff", text: "#1a1408" }; // 0, 255, 255
const D20_ORANGE = { color: "#ffff00", text: "#1a1408" }; // 255, 255, 0 (as specified)
const D20_PURPLE = { color: "#a600ff", text: "#ffffff" }; // 166, 0, 255

/** @template T @param {T[]} arr */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Solid palette used by d20 + group randomize (export for UI). */
export const SOLID_WHEEL_COLORS = [
  D20_RED,
  D20_BLUE,
  D20_GREEN,
  D20_CYAN,
  D20_ORANGE,
  D20_PURPLE,
];

/**
 * Wheel-ring color rules:
 * 1) No two adjacent sections share a color
 * 2) No section has the *same* color on both neighboring sections (no ABA)
 *    e.g. red–purple–red is forbidden because purple’s both sides are red
 * 3) Every blue is next to a cyan (and vice versa), when both exist
 * @param {{ color: string, text: string }[]} colors
 * @param {number} n
 * @param {{ requireBlueCyan?: boolean }} [opts]
 * @returns {boolean}
 */
function solidColorsOk(colors, n, opts = {}) {
  if (!colors || colors.length !== n) return false;
  if (n === 1) return true;
  if (n === 2) {
    // Only one other face — both “neighbors” are the same slot; just require different colors
    return colors[0].color !== colors[1].color;
  }
  for (let i = 0; i < n; i++) {
    const left = colors[(i - 1 + n) % n].color;
    const right = colors[(i + 1) % n].color;
    const here = colors[i].color;
    // No identical colors as immediate neighbors
    if (here === left || here === right) return false;
    // Both neighboring sections must not match each other (no same color on both sides)
    if (left === right) return false;
  }
  if (opts.requireBlueCyan === false) return true;
  // Every blue next to a cyan, every cyan next to a blue
  for (let i = 0; i < n; i++) {
    const c = colors[i].color;
    if (c !== D20_BLUE.color && c !== D20_CYAN.color) continue;
    const other = c === D20_BLUE.color ? D20_CYAN.color : D20_BLUE.color;
    const left = colors[(i - 1 + n) % n].color;
    const right = colors[(i + 1) % n].color;
    if (left !== other && right !== other) return false;
  }
  return true;
}

/**
 * Colors allowed at index `i` given partial ring `colors` (nulls = unfilled).
 * Enforces adjacent-different + no ABA with already-placed neighbors.
 * @param {({ color: string, text: string }|null)[]} colors
 * @param {number} i
 * @param {{ color: string, text: string }[]} palette
 * @returns {{ color: string, text: string }[]}
 */
function candidatesAt(colors, i, palette) {
  const n = colors.length;
  const left = colors[(i - 1 + n) % n];
  const right = colors[(i + 1) % n];
  const left2 = colors[(i - 2 + n) % n];
  const right2 = colors[(i + 2) % n];
  return palette.filter((p) => {
    const c = p.color;
    // Different from adjacent if placed
    if (left && left.color === c) return false;
    if (right && right.color === c) return false;
    // If both neighbors placed, they must not match each other (ABA at i)
    if (left && right && left.color === right.color) return false;
    // If we place c here, check ABA at left neighbor: its sides are left2 and here
    if (left && left2 && left2.color === c) return false;
    // ABA at right neighbor: sides here and right2
    if (right && right2 && right2.color === c) return false;
    return true;
  });
}

/**
 * Greedy fill of a ring, trying random order of indices.
 * @param {number} n
 * @param {{ color: string, text: string }[]} palette
 * @returns {{ color: string, text: string }[]|null}
 */
function greedyRingColoring(n, palette) {
  const colors = /** @type {({ color: string, text: string }|null)[]} */ (
    Array(n).fill(null)
  );
  const order = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(order);
  for (const i of order) {
    const opts = candidatesAt(colors, i, palette);
    if (!opts.length) return null;
    colors[i] = { ...opts[Math.floor(Math.random() * opts.length)] };
  }
  return /** @type {{ color: string, text: string }[]} */ (colors);
}

/**
 * Try to repair a ring by recoloring random bad slots.
 * @param {{ color: string, text: string }[]} colors
 * @param {{ color: string, text: string }[]} palette
 * @returns {boolean}
 */
function repairSolidColors(colors, palette) {
  const n = colors.length;
  for (let step = 0; step < n * 40; step++) {
    if (solidColorsOk(colors, n, { requireBlueCyan: false })) return true;
    // Pick a vertex that breaks a rule
    let bad = -1;
    for (let i = 0; i < n; i++) {
      const left = colors[(i - 1 + n) % n].color;
      const right = colors[(i + 1) % n].color;
      const here = colors[i].color;
      if (here === left || here === right || left === right) {
        bad = i;
        break;
      }
    }
    if (bad < 0) bad = Math.floor(Math.random() * n);
    const opts = candidatesAt(
      colors.map((c, j) => (j === bad ? null : c)),
      bad,
      palette
    );
    if (opts.length) {
      colors[bad] = { ...opts[Math.floor(Math.random() * opts.length)] };
    } else {
      colors[bad] = { ...palette[Math.floor(Math.random() * palette.length)] };
    }
  }
  return solidColorsOk(colors, n, { requireBlueCyan: false });
}

/**
 * Embed blue↔cyan as glued pairs into a valid base coloring (no ABA / no adj match).
 * @param {{ color: string, text: string }[]} base
 * @returns {{ color: string, text: string }[]}
 */
function embedBlueCyanPairs(base) {
  const n = base.length;
  if (n < 2) return base.map((c) => ({ ...c }));
  const out = base.map((c) => ({ ...c }));
  // How many pairs: ~1 per 7 faces, at least 1 when n≥2
  let pairCount = Math.max(1, Math.floor(n / 7));
  while (pairCount * 2 > n) pairCount -= 1;

  /** @type {number[]} */
  const starts = [];
  const used = new Set();
  let guard = 0;
  while (starts.length < pairCount && guard < 200) {
    guard += 1;
    const i = Math.floor(Math.random() * n);
    const j = (i + 1) % n;
    if (used.has(i) || used.has(j)) continue;
    // After placing blue-cyan at i,j, still need no ABA at neighbors
    starts.push(i);
    used.add(i);
    used.add(j);
  }
  if (!starts.length && n >= 2) {
    starts.push(0);
    used.add(0);
    used.add(1);
  }

  for (const i of starts) {
    const j = (i + 1) % n;
    if (Math.random() < 0.5) {
      out[i] = { ...D20_BLUE };
      out[j] = { ...D20_CYAN };
    } else {
      out[i] = { ...D20_CYAN };
      out[j] = { ...D20_BLUE };
    }
  }

  // Colors that may recolor non-pair slots (exclude creating lone blue/cyan)
  const recolorPalette = [D20_RED, D20_GREEN, D20_ORANGE, D20_PURPLE];
  // Repair any damage from embedding pairs
  for (let step = 0; step < n * 50; step++) {
    if (solidColorsOk(out, n)) return out;
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue; // keep blue-cyan pairs glued
      const left = out[(i - 1 + n) % n].color;
      const right = out[(i + 1) % n].color;
      const here = out[i].color;
      if (here === left || here === right || left === right) {
        const opts = candidatesAt(
          out.map((c, j) => (j === i ? null : c)),
          i,
          recolorPalette
        );
        if (opts.length) {
          out[i] = { ...opts[Math.floor(Math.random() * opts.length)] };
        }
      }
    }
    // If still broken, try flipping a pair orientation
    if (step % 10 === 9 && starts.length) {
      const i = starts[Math.floor(Math.random() * starts.length)];
      const j = (i + 1) % n;
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
  }
  return out;
}

/**
 * Guaranteed-valid fallback: period-3 of non blue/cyan solids, then embed pairs.
 * Period-3 never creates ABA (neighbors of each cell are the other two colors).
 * @param {number} n
 * @returns {{ color: string, text: string }[]}
 */
function solidFallbackColors(n) {
  const period = [D20_RED, D20_GREEN, D20_PURPLE];
  // For n=2 period-3 still works if we take first two different
  const base = [];
  for (let i = 0; i < n; i++) {
    base.push({ ...period[i % 3] });
  }
  if (n === 2) {
    return [{ ...D20_BLUE }, { ...D20_CYAN }];
  }
  // Try embed pairs; if validation fails, return pure period-3 (valid for ABA/adj)
  const withPairs = embedBlueCyanPairs(base);
  if (solidColorsOk(withPairs, n) || solidColorsOk(withPairs, n, { requireBlueCyan: false })) {
    // Prefer pair version when adj+ABA ok even if pair rule soft-fails on edge cases
    if (solidColorsOk(withPairs, n, { requireBlueCyan: false })) return withPairs;
  }
  return base;
}

/**
 * Random solid coloring for `n` sections (same rules as d20).
 * - Palette: red, blue, green, cyan, orange (255,255,0), purple (166,0,255)
 * - Blue+cyan always adjacent (glued pairs when n ≥ 2)
 * - Same color never next to itself
 * - Each section’s two neighbors are different colors (no same color on both sides)
 * @param {number} n
 * @returns {{ color: string, text: string }[]}
 */
export function shuffledSolidWheelColors(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return [];
  if (count === 1) {
    const solo = [
      D20_RED,
      D20_GREEN,
      D20_ORANGE,
      D20_PURPLE,
      D20_BLUE,
    ][Math.floor(Math.random() * 5)];
    return [{ ...solo }];
  }
  if (count === 2) {
    return Math.random() < 0.5
      ? [{ ...D20_BLUE }, { ...D20_CYAN }]
      : [{ ...D20_CYAN }, { ...D20_BLUE }];
  }

  const fullPalette = [
    D20_RED,
    D20_BLUE,
    D20_GREEN,
    D20_CYAN,
    D20_ORANGE,
    D20_PURPLE,
  ];
  // Base palette without forcing blue/cyan first (pairs embedded after)
  const basePalette = [D20_RED, D20_GREEN, D20_ORANGE, D20_PURPLE];

  /** @type {{ color: string, text: string }[]|null} */
  let abaSafe = null;

  for (let attempt = 0; attempt < 200; attempt++) {
    // 1) Greedy ring with 4 solids (easy to satisfy ABA), then embed blue↔cyan pairs
    let ring = greedyRingColoring(count, basePalette);
    if (!ring) {
      ring = greedyRingColoring(count, fullPalette);
    }
    if (!ring) continue;
    if (solidColorsOk(ring, count, { requireBlueCyan: false }) && !abaSafe) {
      abaSafe = ring.map((c) => ({ ...c }));
    }
    const withPairs = embedBlueCyanPairs(ring);
    if (solidColorsOk(withPairs, count)) return withPairs;
    if (solidColorsOk(withPairs, count, { requireBlueCyan: false })) {
      if (!abaSafe) abaSafe = withPairs.map((c) => ({ ...c }));
      // Keep trying for a blue-cyan version
    }
    // 2) Repair, then re-embed
    const repaired = withPairs.map((c) => ({ ...c }));
    if (
      repairSolidColors(repaired, basePalette) &&
      solidColorsOk(repaired, count, { requireBlueCyan: false })
    ) {
      if (!abaSafe) abaSafe = repaired.map((c) => ({ ...c }));
      const again = embedBlueCyanPairs(repaired);
      if (solidColorsOk(again, count)) return again;
      if (
        solidColorsOk(again, count, { requireBlueCyan: false }) &&
        !abaSafe
      ) {
        abaSafe = again.map((c) => ({ ...c }));
      }
    }
  }

  // Unit-shuffle path: blue↔cyan glued as units
  const makePair = () =>
    Math.random() < 0.5
      ? [{ ...D20_BLUE }, { ...D20_CYAN }]
      : [{ ...D20_CYAN }, { ...D20_BLUE }];
  const singlePalette = [D20_RED, D20_GREEN, D20_ORANGE, D20_PURPLE];
  for (let attempt = 0; attempt < 300; attempt++) {
    /** @type {{ color: string, text: string }[][]} */
    const units = [];
    let pairCount = Math.max(1, Math.floor(count / 7));
    while (pairCount * 2 > count) pairCount -= 1;
    if (pairCount < 1) pairCount = 1;
    while (pairCount * 2 > count) pairCount -= 1;
    for (let i = 0; i < pairCount; i++) units.push(makePair());
    const singleCount = count - pairCount * 2;
    for (let i = 0; i < singleCount; i++) {
      // Random single (not just sequential) for more variety
      units.push([
        {
          ...singlePalette[Math.floor(Math.random() * singlePalette.length)],
        },
      ]);
    }
    shuffleInPlace(units);
    for (let fix = 0; fix < 60; fix++) {
      const flat = units.flat();
      if (solidColorsOk(flat, count)) return flat;
      if (solidColorsOk(flat, count, { requireBlueCyan: false }) && !abaSafe) {
        abaSafe = flat.map((c) => ({ ...c }));
      }
      // Local repair on singles only (keep pairs intact)
      const pairSlots = new Set();
      {
        let idx = 0;
        for (const u of units) {
          if (u.length === 2) {
            pairSlots.add(idx);
            pairSlots.add(idx + 1);
          }
          idx += u.length;
        }
      }
      for (let i = 0; i < count; i++) {
        if (pairSlots.has(i)) continue;
        const left = flat[(i - 1 + count) % count].color;
        const right = flat[(i + 1) % count].color;
        const here = flat[i].color;
        if (here === left || here === right || left === right) {
          const opts = candidatesAt(
            flat.map((c, j) => (j === i ? null : c)),
            i,
            singlePalette
          );
          if (opts.length) flat[i] = { ...opts[Math.floor(Math.random() * opts.length)] };
        }
      }
      // Write repairs back into single units
      {
        let idx = 0;
        for (const u of units) {
          if (u.length === 1) u[0] = flat[idx];
          idx += u.length;
        }
      }
      if (solidColorsOk(flat, count)) return flat;
      const pairs = units.filter((u) => u.length === 2);
      if (pairs.length) {
        pairs[Math.floor(Math.random() * pairs.length)].reverse();
      }
      if (fix % 5 === 4) shuffleInPlace(units);
    }
  }

  // Prefer any adj+ABA-safe ring we found; else guaranteed period-3 (+ pairs if possible)
  if (abaSafe && solidColorsOk(abaSafe, count, { requireBlueCyan: false })) {
    const lastTry = embedBlueCyanPairs(abaSafe);
    if (solidColorsOk(lastTry, count)) return lastTry;
    if (solidColorsOk(lastTry, count, { requireBlueCyan: false })) return lastTry;
    return abaSafe;
  }
  return solidFallbackColors(count);
}

/** @returns {{ color: string, text: string }[]} */
function shuffledD20Colors() {
  return shuffledSolidWheelColors(20);
}

/**
 * Around-the-wheel order: low/high interleaved so neighbors aren’t sequential.
 * 1, 20, 2, 19, 3, 18, … 10, 11 — looks “more fair” than 1–20 in a row.
 * @returns {number[]}
 */
export function d20FaceOrder() {
  const order = [];
  for (let low = 1; low <= 10; low++) {
    order.push(low);
    order.push(21 - low); // 20, 19, … 11
  }
  return order;
}

/**
 * Classic coin flip: Heads / Tails, equal weight.
 * @returns {ReturnType<typeof defaultState>}
 */
export function coinFlipState() {
  const base = defaultState();
  const g = normalizeGroup({ id: uid("grp"), name: "Coin", active: true });
  const faces = [
    { label: "Heads", color: "#0000ff", text: "#ffffff" }, // RGB 0,0,255 blue
    { label: "Tails", color: "#ff0000", text: "#ffffff" }, // RGB 255,0,0 red
  ];
  const sections = faces.map((f) => ({
    id: uid("sec"),
    label: f.label,
    color: f.color,
    weight: 1,
    enabled: true,
    groupIds: [g.id],
    customColor: true,
    customTextColor: true,
    customWinnerTextColor: false,
    customImage: false,
    customSfx: false,
    ...normalizeProfileFields({
      color: f.color,
      textColor: f.text,
      winnerTextColor: "#ffffff",
    }),
  }));
  return {
    ...base,
    presetId: "coin-flip",
    groups: [g],
    sections,
    yourOrderIds: sections.map((s) => s.id),
    look: {
      ...base.look,
      backgroundColor: "#0c1018",
      centerColor: "#1a2030",
      borderColor: "#90caf9",
      textColor: "#f5f0d8",
      winnerLabel: "Flip",
      winEffect: "confetti",
      // Drag-release = full timed spin (not mouse-velocity fling)
      fairDragSpin: true,
    },
    sound: {
      ...base.sound,
      bgmMode: "off",
    },
    spin: { ...base.spin, duration: 4 },
  };
}

/**
 * Twenty equal faces numbered 1–20.
 * @returns {ReturnType<typeof defaultState>}
 */
export function d20State() {
  const base = defaultState();
  const g = normalizeGroup({ id: uid("grp"), name: "d20", active: true });

  const sections = [];
  const faces = d20FaceOrder();
  const colors = shuffledD20Colors(); // new shuffle each d20; blue always next to cyan
  for (let i = 0; i < faces.length; i++) {
    const n = faces[i];
    const pair = colors[i];
    sections.push({
      id: uid("sec"),
      label: String(n),
      color: pair.color,
      weight: 1,
      enabled: true,
      groupIds: [g.id],
      customColor: true,
      customTextColor: true,
      customWinnerTextColor: false,
      customImage: false,
      customSfx: false,
      ...normalizeProfileFields({
        color: pair.color,
        textColor: pair.text,
        winnerTextColor: "#ffffff",
      }),
    });
  }

  return {
    ...base,
    presetId: "d20",
    groups: [g],
    sections,
    yourOrderIds: sections.map((s) => s.id),
    look: {
      ...base.look,
      backgroundColor: "#120c14",
      centerColor: "#1f1528",
      borderColor: "#f0d78c",
      // All face labels use black via Override (readable on every solid)
      textColor: "#000000",
      forceTextColor: true,
      winnerTextColor: "#ffffff",
      winnerLabel: "Rolled",
      resultStyle: "banner",
      // Drag-release = full timed spin (not mouse-velocity fling)
      fairDragSpin: true,
    },
    sound: {
      ...base.sound,
      bgmMode: "off",
    },
  };
}

/**
 * True when sections are exactly the faces 1–20 (any order).
 * Used to recover preset for older d20 wheels without presetId.
 * @param {object} state
 */
export function looksLikeD20(state) {
  const secs = state?.sections;
  if (!Array.isArray(secs) || secs.length !== 20) return false;
  const labels = new Set(
    secs.map((s) => String(s?.label ?? "").trim())
  );
  for (let i = 1; i <= 20; i++) {
    if (!labels.has(String(i))) return false;
  }
  return true;
}

export function looksLikeCoinFlip(state) {
  const secs = state?.sections;
  if (!Array.isArray(secs) || secs.length !== 2) return false;
  const labels = secs.map((s) =>
    String(s?.label ?? "")
      .trim()
      .toLowerCase()
  );
  const set = new Set(labels);
  return set.has("heads") && set.has("tails");
}

/**
 * Which preset Reset (and similar) should use for this wheel.
 * @param {object|null|undefined} state
 * @returns {string}
 */
export function resolvePresetId(state) {
  const raw = state?.presetId;
  if (typeof raw === "string" && getWheelPreset(raw)) return raw;
  if (looksLikeCoinFlip(state)) return "coin-flip";
  if (looksLikeD20(state)) return "d20";
  return "default";
}

/**
 * Fresh state for a preset, always stamped with presetId.
 * @param {string} [presetId="default"]
 */
export function buildPresetState(presetId = "default") {
  const preset = getWheelPreset(presetId) || getWheelPreset("default");
  const st = preset ? preset.build() : defaultState();
  st.presetId = preset?.id || "default";
  return st;
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   defaultName: string,
 *   build: () => object,
 * }} WheelPreset
 */

/** @type {WheelPreset[]} */
export const WHEEL_PRESETS = [
  {
    id: "default",
    name: "Default",
    description: "Sample prize wheel (current starter)",
    defaultName: "Prize wheel",
    build: () => {
      const st = defaultState();
      st.presetId = "default";
      return st;
    },
  },
  {
    id: "coin-flip",
    name: "Coin flip",
    description: "Heads or Tails — 50/50",
    defaultName: "Coin flip",
    build: () => coinFlipState(),
  },
  {
    id: "d20",
    name: "d20",
    description: "1–20 equal chance (mixed high/low order)",
    defaultName: "d20",
    build: () => d20State(),
  },
];

/**
 * @param {string} id
 * @returns {WheelPreset|null}
 */
export function getWheelPreset(id) {
  return WHEEL_PRESETS.find((p) => p.id === id) || null;
}
