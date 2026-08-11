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
 * @param {{ color: string, text: string }[]} colors
 * @param {number} n
 * @returns {boolean}
 */
function solidColorsOk(colors, n) {
  if (!colors || colors.length !== n) return false;
  if (n === 1) return true;
  for (let i = 0; i < n; i++) {
    // No identical colors as neighbors (including last↔first on the wheel)
    if (colors[i].color === colors[(i + 1) % n].color) return false;
  }
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
 * Random solid coloring for `n` sections (same rules as d20).
 * - Palette: red, blue, green, cyan, orange (255,255,0), purple (166,0,255)
 * - Blue+cyan always adjacent (glued pairs when n ≥ 2)
 * - Same color never next to itself (including wheel wrap)
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

  const makePair = () =>
    Math.random() < 0.5
      ? [{ ...D20_BLUE }, { ...D20_CYAN }]
      : [{ ...D20_CYAN }, { ...D20_BLUE }];

  const singlePalette = [D20_RED, D20_GREEN, D20_ORANGE, D20_PURPLE];

  for (let attempt = 0; attempt < 500; attempt++) {
    /** @type {{ color: string, text: string }[][]} */
    const units = [];
    // As many blue↔cyan pairs as fit; leave room for variety
    let pairCount = Math.max(1, Math.floor(count / 6));
    while (pairCount * 2 > count) pairCount -= 1;
    if (pairCount < 1 && count >= 2) pairCount = 1;
    while (pairCount * 2 > count) pairCount -= 1;

    for (let i = 0; i < pairCount; i++) units.push(makePair());
    const singleCount = count - pairCount * 2;
    for (let i = 0; i < singleCount; i++) {
      units.push([{ ...singlePalette[i % singlePalette.length] }]);
    }

    shuffleInPlace(units);
    for (let fix = 0; fix < 50; fix++) {
      const flat = units.flat();
      if (solidColorsOk(flat, count)) return flat;
      const pairs = units.filter((u) => u.length === 2);
      if (pairs.length) {
        pairs[Math.floor(Math.random() * pairs.length)].reverse();
      }
      if (fix % 6 === 5) shuffleInPlace(units);
    }
  }

  // Deterministic fallback: alternate palette (no same neighbors)
  const fallback = [];
  const seq = [
    D20_RED,
    D20_BLUE,
    D20_GREEN,
    D20_CYAN,
    D20_ORANGE,
    D20_PURPLE,
  ];
  for (let i = 0; i < count; i++) {
    fallback.push({ ...seq[i % seq.length] });
  }
  return fallback;
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
      textColor: "#f5f0d8",
      winnerTextColor: "#ffffff",
      winnerLabel: "Rolled",
      resultStyle: "banner",
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
