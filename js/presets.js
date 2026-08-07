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

/** Classic polyhedral d20 greens / golds (alternating by position for adjacent contrast). */
const D20_A = { color: "#1a6b3f", text: "#f5f0d8" };
const D20_B = { color: "#c9a84c", text: "#1a1408" };

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
    const pair = i % 2 === 0 ? D20_A : D20_B;
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
    groups: [g],
    sections,
    look: {
      ...base.look,
      backgroundColor: "#0c1210",
      centerColor: "#14261a",
      borderColor: "#c9a84c",
      textColor: "#f5f0d8",
      winnerTextColor: "#ffffff",
      winnerLabel: "Rolled",
    },
  };
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
    build: () => defaultState(),
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
