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

/**
 * Merry-go-round face colors — neon / carnival bright, mixed (not a spectrum).
 * High saturation; dark text only on the lightest yellows/cyans.
 * Hex only (normalizeHexColor rejects non-hex).
 * @type {{ color: string, text: string }[]}
 */
const D20_MERRY = [
  { color: "#ff1744", text: "#ffffff" }, // neon red
  { color: "#ffea00", text: "#1a1408" }, // electric yellow
  { color: "#2979ff", text: "#ffffff" }, // vivid blue
  { color: "#00e676", text: "#1a1408" }, // neon green
  { color: "#d500f9", text: "#ffffff" }, // electric purple
  { color: "#ff9100", text: "#1a1408" }, // bright orange
  { color: "#00e5ff", text: "#1a1408" }, // cyan
  { color: "#ff4081", text: "#ffffff" }, // hot pink
  { color: "#ffc400", text: "#1a1408" }, // amber flash
  { color: "#3d5afe", text: "#ffffff" }, // indigo
  { color: "#76ff03", text: "#1a1408" }, // lime
  { color: "#ff3d00", text: "#ffffff" }, // deep orange-red
  { color: "#aa00ff", text: "#ffffff" }, // vivid violet
  { color: "#1de9b6", text: "#1a1408" }, // aqua
  { color: "#ff6d00", text: "#ffffff" }, // tangerine
  { color: "#ffff00", text: "#1a1408" }, // pure yellow
  { color: "#00b0ff", text: "#ffffff" }, // bright sky
  { color: "#f50057", text: "#ffffff" }, // magenta pink
  { color: "#64dd17", text: "#1a1408" }, // chartreuse
  { color: "#ff5252", text: "#ffffff" }, // coral red
];

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
    { label: "Heads", color: "#c9a84c", text: "#1a1408" },
    { label: "Tails", color: "#4a5568", text: "#f5f0d8" },
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
      borderColor: "#c9a84c",
      textColor: "#f5f0d8",
      winnerLabel: "Flip",
      winEffect: "confetti",
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
  for (let i = 0; i < faces.length; i++) {
    const n = faces[i];
    // Color by wheel position (mixed merry-go-round), not face number order
    const pair = D20_MERRY[i % D20_MERRY.length];
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
