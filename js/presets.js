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
 * Blue and cyan are not special — they may land next to each other by chance.
 * @param {{ color: string, text: string }[]} colors
 * @param {number} n
 * @returns {boolean}
 */
function solidColorsOk(colors, n) {
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
    if (solidColorsOk(colors, n)) return true;
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
  return solidColorsOk(colors, n);
}

/**
 * Guaranteed-valid fallback: period-3 over the full palette (no ABA).
 * @param {number} n
 * @returns {{ color: string, text: string }[]}
 */
function solidFallbackColors(n) {
  // 6-color period never puts the same color on both neighbors of a face
  const period = [
    D20_RED,
    D20_BLUE,
    D20_GREEN,
    D20_CYAN,
    D20_ORANGE,
    D20_PURPLE,
  ];
  // Period-3 of non-adjacent-same colors is safer for ABA than period-2
  const period3 = [D20_RED, D20_GREEN, D20_PURPLE];
  const base = [];
  for (let i = 0; i < n; i++) {
    base.push({ ...period3[i % 3] });
  }
  if (n === 2) {
    // Any two different solids
    return Math.random() < 0.5
      ? [{ ...D20_RED }, { ...D20_GREEN }]
      : [{ ...D20_BLUE }, { ...D20_ORANGE }];
  }
  // Prefer a shuffled full-palette try; else period-3
  const tryFull = greedyRingColoring(n, period);
  if (tryFull && solidColorsOk(tryFull, n)) return tryFull;
  return base;
}

/**
 * Random solid coloring for `n` sections (same rules as d20).
 * - Palette: red, blue, green, cyan, orange (255,255,0), purple (166,0,255)
 * - Same color never next to itself
 * - Each section’s two neighbors are different colors (no same color on both sides)
 * - Blue/cyan are not glued; they may land next to each other by chance
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
      D20_CYAN,
    ][Math.floor(Math.random() * 6)];
    return [{ ...solo }];
  }

  const fullPalette = [
    D20_RED,
    D20_BLUE,
    D20_GREEN,
    D20_CYAN,
    D20_ORANGE,
    D20_PURPLE,
  ];

  for (let attempt = 0; attempt < 400; attempt++) {
    let ring = greedyRingColoring(count, fullPalette);
    if (!ring) continue;
    if (solidColorsOk(ring, count)) return ring;
    if (repairSolidColors(ring, fullPalette) && solidColorsOk(ring, count)) {
      return ring;
    }
  }

  // Random multiset from palette + shuffle + repair
  for (let attempt = 0; attempt < 200; attempt++) {
    const bag = [];
    for (let i = 0; i < count; i++) {
      bag.push({ ...fullPalette[i % fullPalette.length] });
    }
    shuffleInPlace(bag);
    if (solidColorsOk(bag, count)) return bag;
    if (repairSolidColors(bag, fullPalette) && solidColorsOk(bag, count)) {
      return bag;
    }
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
 * Empty wheel — one group, no sections (start from scratch).
 * @returns {ReturnType<typeof defaultState>}
 */
export function blankWheelState() {
  const base = defaultState();
  const g = normalizeGroup({ id: uid("grp"), name: "Main", active: true });
  return {
    ...base,
    presetId: "blank",
    groups: [g],
    sections: [],
    yourOrderIds: [],
  };
}

/**
 * Classic coin flip: Heads or Tails, equal weight.
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
      winEffect: "none",
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
  const colors = shuffledD20Colors(); // new shuffle each d20
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
      winEffect: "none",
      // Drag-release = full timed spin (not mouse-velocity fling)
      fairDragSpin: true,
      // d20 rolls: only Continue — no Hide / Remove on the result bar
      allowWinnerHide: false,
      allowWinnerRemove: false,
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
    id: "blank",
    name: "Blank",
    description: "Empty wheel — add your own sections",
    defaultName: "New wheel",
    build: () => blankWheelState(),
  },
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
