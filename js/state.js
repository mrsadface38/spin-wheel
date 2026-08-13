/** @typedef {{
 *   id: string,
 *   name: string,
 *   active: boolean,
 *   overrideColor: boolean,
 *   overrideImage: boolean,
 *   overrideSfx: boolean,
 *   color: string,
 *   imageData: string|null,
 *   imageMode: 'fill'|'tile',
 *   imageFillScale: number,
 *   imageFillOffsetX: number,
 *   imageFillOffsetY: number,
 *   imageTileScale: number,
 *   imageTileOffsetX: number,
 *   imageTileOffsetY: number,
 *   imageRotation: number,
 *   landSfxData: string|null,
 *   landSfxName: string|null
 * }} Group */
/** @typedef {{
 *   id: string,
 *   label: string,
 *   color: string,
 *   weight: number,
 *   enabled: boolean,
 *   groupIds: string[],
 *   imageData: string|null,
 *   imageMode: 'fill'|'tile',
 *   imageFillScale: number,
 *   imageFillOffsetX: number,
 *   imageFillOffsetY: number,
 *   imageTileScale: number,
 *   imageTileOffsetX: number,
 *   imageTileOffsetY: number,
 *   imageRotation: number,
 *   landSfxData: string|null,
 *   landSfxName: string|null,
 *   landSfxVolume: number,
 *   landAction: 'none'|'respin'|'otherWheel',
 *   landTargetWheelId: string|null,
 *   landShowResultEvery: number,
 *   landShowResultUnit: 'seconds'|'minutes'|'hours'|'days',
 *   landActionTimes: number,
 *   winBgm: 'inherit'|'custom'|'mute',
 *   winBgmData: string|null,
 *   winBgmName: string|null,
 *   returnAfterMs: number,
 *   returnsAt: number|null
 * }} Section */

/** Per-section action when this slice wins a spin. */
export function normalizeLandAction(v) {
  if (v === "respin" || v === "otherWheel") return v;
  return "none";
}

/** Unit for “show result for” before respin / other-wheel. */
export function normalizeLandShowResultUnit(v) {
  if (v === "seconds" || v === "sec") return "seconds";
  if (v === "minutes" || v === "min") return "minutes";
  if (v === "hours" || v === "hr") return "hours";
  if (v === "days") return "days";
  return "seconds";
}

/**
 * Background music when this section wins.
 * inherit = keep current/wheel BGM; custom = section file; mute = stop music.
 */
export function normalizeWinBgm(v) {
  if (v === "custom" || v === "mute") return v;
  return "inherit";
}

/**
 * How long to show the win screen before chaining respin / other wheel (0 = skip).
 * @param {unknown} every
 * @param {unknown} unit
 * @returns {number} milliseconds
 */
export function landShowResultMs(every, unit) {
  let n = Number(every);
  if (!Number.isFinite(n) || n <= 0) return 0;
  n = Math.min(99999, Math.round(n));
  const u = normalizeLandShowResultUnit(unit);
  if (u === "seconds") return n * 1_000;
  if (u === "minutes") return n * 60_000;
  if (u === "hours") return n * 3_600_000;
  if (u === "days") return Math.min(2_147_483_647, n * 86_400_000);
  return n * 1_000;
}

/** Max auto-return delay: 1 year. */
const MAX_RETURN_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * How long after hide before this section re-enables (0 = off).
 * @param {unknown} v
 * @returns {number}
 */
export function normalizeReturnAfterMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_RETURN_AFTER_MS, Math.max(0, Math.round(n)));
}

/**
 * Absolute time (ms since epoch) when a hidden section should return.
 * @param {unknown} v
 * @returns {number|null}
 */
export function normalizeReturnsAt(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.round(v);
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const parsed = Date.parse(String(v));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
}

const STORAGE_KEY = "spin-wheel-studio-v1";

const PALETTE = [
  "#4a6cf7", "#e74c3c", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#3498db", "#e91e63", "#00bcd4",
  "#8bc34a", "#ff5722", "#607d8b", "#cddc39", "#795548",
];

/** Visual + land-SFX fields shared by group profiles and sections */
export const PROFILE_KEYS = [
  "color",
  "textColor",
  "textStyle",
  "textFont",
  "winnerTextColor",
  "imageData",
  "imageMode",
  "imageFillScale",
  "imageFillOffsetX",
  "imageFillOffsetY",
  "imageTileScale",
  "imageTileOffsetX",
  "imageTileOffsetY",
  "imageRotation",
  "landSfxData",
  "landSfxName",
  "winEffect",
  "winEffectData",
  "winEffectName",
];

export const COLOR_KEYS = ["color"];
export const TEXT_COLOR_KEYS = ["textColor"];
/** Label weight/italic style (normal | bold | italic | bold-italic) */
export const TEXT_STYLE_KEYS = ["textStyle"];
/** Label font family id (system, arial, georgia, …) */
export const TEXT_FONT_KEYS = ["textFont"];
export const WINNER_TEXT_COLOR_KEYS = ["winnerTextColor"];

/** Allowed font family ids for wheel labels. */
export const TEXT_FONT_IDS = [
  "system",
  "arial",
  "verdana",
  "trebuchet",
  "georgia",
  "times",
  "courier",
  "comic",
  "impact",
];

/** @param {unknown} v @param {string} [fallback="bold"] */
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

/** @param {unknown} v @param {string} [fallback="system"] */
export function normalizeTextFont(v, fallback = "system") {
  if (typeof v === "string" && TEXT_FONT_IDS.includes(v)) return v;
  if (typeof fallback === "string" && TEXT_FONT_IDS.includes(fallback)) {
    return fallback;
  }
  return "system";
}
export const IMAGE_KEYS = [
  "imageData",
  "imageMode",
  "imageFillScale",
  "imageFillOffsetX",
  "imageFillOffsetY",
  "imageTileScale",
  "imageTileOffsetX",
  "imageTileOffsetY",
  "imageRotation",
];
export const SFX_KEYS = ["landSfxData", "landSfxName"];
export const WIN_EFFECT_KEYS = ["winEffect", "winEffectData", "winEffectName"];
/** Per-win chain action (respin / other wheel) — groups + sections */
export const LAND_ACTION_KEYS = [
  "landAction",
  "landTargetWheelId",
  "landShowResultEvery",
  "landShowResultUnit",
  "landActionTimes",
];

/** @typedef {{ color?: boolean, textColor?: boolean, textStyle?: boolean, textFont?: boolean, winnerTextColor?: boolean, image?: boolean, sfx?: boolean, winEffect?: boolean, landAction?: boolean }} ProfileParts */

/** Normalize after-win effect id. */
export function normalizeWinEffect(v, fallback = "confetti") {
  if (v === "none" || v === "confetti" || v === "custom") return v;
  return fallback;
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * How many times to fire respin / spin-other-wheel (1–99).
 * @param {unknown} v
 * @param {number} [fallback=1]
 */
export function normalizeLandActionTimes(v, fallback = 1) {
  let n = Number(v);
  if (!Number.isFinite(n) || n < 1) n = fallback;
  return Math.min(99, Math.max(1, Math.round(n)));
}

/**
 * Normalize land-action fields (shared by groups + sections).
 * @param {object} [src]
 * @returns {{ landAction: string, landTargetWheelId: string|null, landShowResultEvery: number, landShowResultUnit: string, landActionTimes: number }}
 */
export function normalizeLandActionFields(src = {}) {
  const landAction = normalizeLandAction(src.landAction);
  let landTargetWheelId = null;
  if (src.landTargetWheelId != null && String(src.landTargetWheelId).trim()) {
    landTargetWheelId = String(src.landTargetWheelId).trim();
  }
  if (landAction !== "otherWheel") landTargetWheelId = null;
  let landShowResultEvery = Number(src.landShowResultEvery);
  if (!Number.isFinite(landShowResultEvery) || landShowResultEvery < 0) {
    landShowResultEvery = 0;
  }
  landShowResultEvery = Math.min(99999, Math.round(landShowResultEvery));
  let landActionTimes = normalizeLandActionTimes(src.landActionTimes, 1);
  if (landAction === "none") {
    landShowResultEvery = 0;
    landActionTimes = 1;
  }
  const landShowResultUnit = normalizeLandShowResultUnit(src.landShowResultUnit);
  return {
    landAction,
    landTargetWheelId,
    landShowResultEvery,
    landShowResultUnit,
    landActionTimes,
  };
}

export function defaultGroupProfile() {
  return {
    overrideColor: false,
    overrideTextColor: false,
    overrideTextStyle: false,
    overrideTextFont: false,
    overrideWinnerTextColor: false,
    overrideImage: false,
    overrideSfx: false,
    overrideWinEffect: false,
    overrideLandAction: false,
    color: "#4a6cf7",
    textColor: "#ffffff",
    textStyle: "bold",
    textFont: "system",
    winnerTextColor: "#ffffff",
    imageData: null,
    imageMode: "fill",
    imageFillScale: 1,
    imageFillOffsetX: 0,
    imageFillOffsetY: 0,
    imageTileScale: 1,
    imageTileOffsetX: 0,
    imageTileOffsetY: 0,
    imageRotation: 0,
    landSfxData: null,
    landSfxName: null,
    /** null = do not set a group win effect (sections use Look / own) */
    winEffect: null,
    winEffectData: null,
    winEffectName: null,
    ...normalizeLandActionFields({}),
  };
}

export function groupHasAnyOverride(g) {
  return !!(
    g &&
    (g.overrideColor ||
      g.overrideTextColor ||
      g.overrideTextStyle ||
      g.overrideTextFont ||
      g.overrideWinnerTextColor ||
      g.overrideImage ||
      g.overrideSfx ||
      g.overrideWinEffect ||
      g.overrideLandAction)
  );
}

/** Normalize a CSS hex color; fallback if invalid. */
export function normalizeHexColor(c, fallback = "#ffffff") {
  if (typeof c !== "string") return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return fallback;
}

/** Per-section land SFX volume 0–1 */
export function normalizeLandSfxVolume(n, fallback = 0.4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function clampScale(n) {
  return Math.min(3, Math.max(0.1, Number(n) || 1));
}

function clampOffset(n) {
  return Math.min(100, Math.max(-100, Number(n) || 0));
}

/** Image rotation in degrees, 0–360 (360 wraps to 0). */
export function clampImageRotation(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const wrapped = ((v % 360) + 360) % 360;
  return wrapped === 0 ? 0 : Math.round(wrapped * 10) / 10;
}

/** Normalize profile image/sfx/color fields onto a plain object */
export function normalizeProfileFields(src = {}) {
  return {
    color: normalizeHexColor(src.color, "#4a6cf7"),
    textColor: normalizeHexColor(src.textColor, "#ffffff"),
    textStyle: normalizeTextStyle(src.textStyle, "bold"),
    textFont: normalizeTextFont(src.textFont, "system"),
    winnerTextColor: normalizeHexColor(
      src.winnerTextColor ?? src.textColor,
      "#ffffff"
    ),
    imageData: src.imageData || null,
    imageMode: src.imageMode === "tile" ? "tile" : "fill",
    imageFillScale: clampScale(src.imageFillScale),
    imageFillOffsetX: clampOffset(src.imageFillOffsetX),
    imageFillOffsetY: clampOffset(src.imageFillOffsetY),
    imageTileScale: clampScale(src.imageTileScale),
    imageTileOffsetX: clampOffset(src.imageTileOffsetX),
    imageTileOffsetY: clampOffset(src.imageTileOffsetY),
    imageRotation: clampImageRotation(src.imageRotation),
    landSfxData: src.landSfxData || null,
    landSfxName: src.landSfxName || null,
    winEffect:
      src.winEffect === "none" ||
      src.winEffect === "confetti" ||
      src.winEffect === "custom"
        ? src.winEffect
        : src.winEffectData
          ? "custom"
          : null,
    winEffectData: src.winEffectData || null,
    winEffectName: src.winEffectName || null,
  };
}

export function normalizeGroup(g = {}) {
  const profile = normalizeProfileFields(g);
  // Legacy: single overrideSections flag → all three channels
  const legacyAll = g.overrideSections === true;
  // Group win effect: null = inherit Look for members (no group contribution)
  let winEffect = null;
  if (
    g.winEffect === "none" ||
    g.winEffect === "confetti" ||
    g.winEffect === "custom"
  ) {
    winEffect = g.winEffect;
  } else if (g.winEffectData) {
    winEffect = "custom";
  }
  return {
    id: g.id || uid("grp"),
    name: String(g.name ?? "Group"),
    active: g.active !== false,
    // Default OFF — sections use their own profile per channel
    overrideColor:
      g.overrideColor === true || (g.overrideColor == null && legacyAll),
    overrideTextColor:
      g.overrideTextColor === true ||
      (g.overrideTextColor == null && legacyAll),
    overrideTextStyle: g.overrideTextStyle === true,
    overrideTextFont: g.overrideTextFont === true,
    overrideWinnerTextColor: g.overrideWinnerTextColor === true,
    overrideImage:
      g.overrideImage === true || (g.overrideImage == null && legacyAll),
    overrideSfx:
      g.overrideSfx === true || (g.overrideSfx == null && legacyAll),
    overrideWinEffect: g.overrideWinEffect === true,
    overrideLandAction: g.overrideLandAction === true,
    ...profile,
    winEffect,
    winEffectData: profile.winEffectData,
    winEffectName: profile.winEffectName,
    ...normalizeLandActionFields(g),
  };
}

/** Snapshot of profile fields only (for apply / resolve) */
export function extractProfile(source) {
  const p = normalizeProfileFields(source || {});
  const out = {};
  for (const k of PROFILE_KEYS) out[k] = p[k];
  return out;
}

/**
 * Copy selected profile parts onto a section (mutates).
 * Applied channels become section-owned (custom*).
 * @param {ProfileParts} parts which channels to write — pass explicit true/false.
 *   If omitted entirely, all channels are applied (legacy).
 */
export function applyProfileToSection(section, profile, parts) {
  if (!section || !profile) return section;
  const p = extractProfile(profile);
  const want =
    parts && typeof parts === "object"
      ? {
          color: parts.color === true,
          textColor: parts.textColor === true,
          textStyle: parts.textStyle === true,
          textFont: parts.textFont === true,
          winnerTextColor: parts.winnerTextColor === true,
          image: parts.image === true,
          sfx: parts.sfx === true,
          winEffect: parts.winEffect === true,
          landAction: parts.landAction === true,
        }
      : {
          color: true,
          textColor: true,
          textStyle: true,
          textFont: true,
          winnerTextColor: true,
          image: true,
          sfx: true,
          winEffect: true,
          landAction: true,
        };
  if (want.color) {
    for (const k of COLOR_KEYS) section[k] = p[k];
    section.customColor = true;
  }
  if (want.textColor) {
    for (const k of TEXT_COLOR_KEYS) section[k] = p[k];
    section.customTextColor = true;
  }
  if (want.textStyle) {
    for (const k of TEXT_STYLE_KEYS) section[k] = p[k];
    section.customTextStyle = true;
  }
  if (want.textFont) {
    for (const k of TEXT_FONT_KEYS) section[k] = p[k];
    section.customTextFont = true;
  }
  if (want.winnerTextColor) {
    for (const k of WINNER_TEXT_COLOR_KEYS) section[k] = p[k];
    section.customWinnerTextColor = true;
  }
  if (want.image) {
    for (const k of IMAGE_KEYS) section[k] = p[k];
    section.customImage = true;
  }
  if (want.sfx) {
    for (const k of SFX_KEYS) section[k] = p[k];
    section.customSfx = true;
  }
  if (want.winEffect) {
    for (const k of WIN_EFFECT_KEYS) section[k] = p[k];
    if (!section.winEffect && section.winEffectData) section.winEffect = "custom";
    if (!section.winEffect) section.winEffect = "confetti";
    section.customWinEffect = true;
  }
  if (want.landAction) {
    const land = normalizeLandActionFields(profile);
    section.landAction = land.landAction;
    section.landTargetWheelId = land.landTargetWheelId;
    section.landShowResultEvery = land.landShowResultEvery;
    section.landShowResultUnit = land.landShowResultUnit;
    section.landActionTimes = land.landActionTimes;
  }
  return section;
}

/**
 * Effective land-action fields when a section wins.
 * 1) Group with overrideLandAction (highest priority)
 * 2) Section’s own non-"none" land action
 * 3) Inherit from highest-priority member group with a non-"none" action
 * 4) Show result (none)
 *
 * @param {object} state
 * @param {object} section
 * @returns {{ landAction: string, landTargetWheelId: string|null, landShowResultEvery: number, landShowResultUnit: string, source: string, groupId: string|null }}
 */
export function getEffectiveLandAction(state, section) {
  const empty = {
    ...normalizeLandActionFields({}),
    source: "none",
    groupId: null,
  };
  if (!section) return empty;

  const force = forceOverrideGroup(state, section, "overrideLandAction");
  if (force) {
    return {
      ...normalizeLandActionFields(force),
      source: "group-force",
      groupId: force.id || null,
    };
  }

  const own = normalizeLandActionFields(section);
  if (own.landAction !== "none") {
    return { ...own, source: "section", groupId: null };
  }

  const members = memberGroupsByPriority(state, section);
  for (const g of members) {
    const fromG = normalizeLandActionFields(g);
    if (fromG.landAction !== "none") {
      return {
        ...fromG,
        source: "group-inherit",
        groupId: g.id || null,
      };
    }
  }

  return empty;
}

export function defaultState() {
  const g1 = normalizeGroup({ id: uid("grp"), name: "Main", active: true });
  const g2 = normalizeGroup({ id: uid("grp"), name: "Bonus", active: true });

  const labels = ["Prize A", "Prize B", "Try Again", "Jackpot", "Prize C", "Mystery"];
  const sections = labels.map((label, i) => ({
    id: uid("sec"),
    label,
    color: PALETTE[i % PALETTE.length],
    weight: 1,
    enabled: true,
    // Jackpot in both groups by default as an example of multi-group
    groupIds: i === 3 ? [g1.id, g2.id] : [g1.id],
    // Own colors by default; image/SFX inherit from groups until edited
    customColor: true,
    customTextColor: false,
    customTextStyle: false,
    customTextFont: false,
    customWinnerTextColor: false,
    customImage: false,
    customSfx: false,
    ...normalizeProfileFields({
      color: PALETTE[i % PALETTE.length],
      textColor: "#ffffff",
      textStyle: "bold",
      textFont: "system",
      winnerTextColor: "#ffffff",
    }),
  }));

  return {
    /** Which + New preset this wheel was created from ("default" | "d20" | …) */
    presetId: "default",
    /**
     * Saved custom section order (ids). Independent of temporary list/wheel sorts.
     * state.sections array order is the current wheel/view order.
     */
    yourOrderIds: sections.map((s) => s.id),
    // Array order = priority: index 0 is highest
    groups: [g1, g2],
    sections,
    look: {
      backgroundColor: "#0f1220",
      backgroundImage: null,
      centerColor: "#1a1f35",
      centerImage: null,
      centerSize: 0.16,
      /**
       * When true, the center hub disc and center image rotate with the wheel.
       * Off by default so the hub stays fixed in screen space.
       */
      spinCenterHub: false,
      borderColor: "#f0d78c",
      textColor: "#ffffff",
      /**
       * When true, wheel labels always use look.textColor
       * (ignores section / group text colors).
       */
      forceTextColor: false,
      /**
       * Default label format: normal | bold | italic | bold-italic
       * (matches historical bold weight-700 look).
       */
      textStyle: "bold",
      /**
       * When true, wheel labels always use look.textStyle
       * (ignores section / group text styles).
       */
      forceTextStyle: false,
      /** Default label font family id (system, arial, georgia, …). */
      textFont: "system",
      /**
       * When true, wheel labels always use look.textFont
       * (ignores section / group fonts).
       */
      forceTextFont: false,
      /** Color of the winning name on the result overlay (separate from wheel labels) */
      winnerTextColor: "#ffffff",
      /**
       * When true, result screen always uses look.winnerTextColor
       * (ignores section / group winner colors).
       */
      forceWinnerTextColor: false,
      showLabels: true,
      showImages: true,
      /**
       * How section/group fill images sit on the wheel:
       * - "slice" — rotate each image with its wedge (default)
       * - "fixed" — upright, editor-style top frame
       */
      imageLayoutMode: "slice",
      resultStyle: "center",
      winnerLabel: "Winner",
      allowWinnerRemove: true,
      /** Show Hide button on win screen (default on). */
      allowWinnerHide: true,
      /**
       * After a spin is dismissed: "off" | "hide" (disable section) | "remove" (delete).
       */
      eliminateAfterWin: "off",
      /**
       * Global default after-win effect: "none" | "confetti" | "custom".
       * Sections/groups can override. Custom uses winEffectData (image/GIF/video).
       */
      winEffect: "confetti",
      winEffectData: null,
      winEffectName: null,
      /** Space / Enter to spin when not typing (default on). */
      keyboardSpin: true,
      /** Double-click the stage to spin (default on). */
      allowDoubleClickSpin: true,
      /**
       * When false, mouse/touch drag on the wheel is disabled
       * (no aim-drag, flick). Double-click / keyboard still spin.
       */
      allowWheelDrag: true,
      /**
       * When false, clicking/dragging during a spin cannot interrupt it
       * (grab-to-stop is disabled). Idle flick still works if allowWheelDrag.
       */
      allowGrabStopSpin: true,
      /**
       * When true, a fast enough drag-release starts a normal full-force timed
       * spin (Spin duration) instead of a velocity-matched fling. Still requires
       * flick speed so slow aiming does not spin. Off by default; d20 & coin on.
       */
      fairDragSpin: false,
      /**
       * Multi-spin: when this wheel spins a different wheel, wait for that
       * wheel (and its queue) to finish before continuing this wheel's queue.
       * Default on.
       */
      waitForTargetWheel: true,
      /**
       * Multi-spin: when spinning a different wheel that is not on the board,
       * put the target in this wheel's slot/position and remove this wheel.
       * Default on. Off = add the target as an extra tile (legacy).
       */
      replaceSourceOnOtherWheel: true,
      /**
       * Auto-dismiss win screen after N seconds (free-form number).
       * 0 = off (show until Continue), -1 = never show result overlay,
       * positive = auto-close after that many seconds.
       */
      autoDismissSec: 0,
      /**
       * Automatically spin on an interval while the page is open.
       * Interval = autoSpinEvery × unit (seconds | minutes | hours | days).
       */
      autoSpin: false,
      autoSpinEvery: 5,
      autoSpinUnit: "minutes",
      // Section list weight range slider (manual number field can still use decimals)
      weightSliderMin: 1,
      weightSliderMax: 20,
      weightSliderStep: 1,
      /**
       * Winner-pointer position around the wheel, degrees.
       * 0 = top, 90 = right (default), 180 = bottom, 270 = left.
       */
      pointerAngleDeg: 90,
      /** When true, pointer cannot be dragged (default). */
      pointerLocked: true,
      /**
       * Hide editor panels (fullscreen wheel). Saved/shared with the wheel.
       */
      hidePanels: false,
      /**
       * When false, spins are not written to the History tab log.
       * Default on. Per-wheel; saved/shared with the project.
       */
      trackHistory: true,
    },
    sound: {
      enabled: true,
      spinMode: "tick",
      /** "mixkit" | "synth" | "custom" — which tick sound to use */
      spinTickPreset: "synth",
      spinSfxData: null,
      spinSfxName: null,
      spinVolume: 0.4,
      /** "default" | "victory" | "custom" — global land SFX when section has none */
      landSfxPreset: "default",
      landSfxData: null,
      landSfxName: null,
      landVolume: 0.4,
      bgmData: null,
      bgmName: null,
      bgmVolume: 0.4,
      bgmMode: "spin",
    },
    spin: {
      duration: 9,
      /**
       * When true, timed spins last as long as the current BGM track
       * (music plays once from the start; fixed Duration is ignored).
       */
      untilBgmEnds: false,
      /**
       * How much of each section’s arc the pointer may land in (1–99%).
       * Centered; edges are margin so borders are avoided. Cannot be 100%.
       */
      landZonePct: 99,
      /**
       * Peak spin intensity vs default (25–200%). 100 = normal.
       * Scales timed-spin revolutions and drag-fling velocity cap.
       */
      maxSpeedPct: 100,
    },
    /** Hidden “rig it” controls (unlock via UI gesture) */
    secret: {
      unlocked: false,
      rigIt: false,
      /** "section" | "group" — group picks a random on-wheel member each spin */
      rigTargetKind: "section",
      targetSectionId: null,
      targetGroupId: null,
      /** SFX when the wheel does the last-moment divert to the rigged section */
      divertSfxData: null,
      divertSfxName: null,
      divertSfxVolume: 0.4,
      /** 1 = slowest divert, 10 = fastest (maps to glide duration) */
      divertSpeed: 5,
      /** Mute BGM during the rig divert move */
      muteMusicOnDivert: true,
      /** Mute spin tick / loop SFX only during the last-moment divert */
      muteSpinTicksOnRig: true,
      /**
       * When both Rig and Reverse are armed:
       * "reverse-first" | "rig-first"
       */
      comboOrder: "reverse-first",
      /**
       * Reverse rig: if the wheel would land on the chosen section/group,
       * slowly slide off it to another slice.
       */
      reverseRigIt: false,
      /** "section" | "group" */
      reverseTargetKind: "section",
      reverseTargetSectionId: null,
      reverseTargetGroupId: null,
      /** 1 = slowest slide-off, 10 = fastest */
      reverseSlideSpeed: 2,
      /**
       * Bundled reverse slide presets + custom:
       * "goofy-slip" | "cartoon-slip" | "slide-slip" | "glass-squeak-3" |
       * "glass-squeak-2" | "scp-173" | "custom"  ("synth" legacy → scp-173)
       */
      reverseSlideSfxPreset: "glass-squeak-2",
      reverseSlideSfxData: null,
      reverseSlideSfxName: null,
      reverseSlideSfxVolume: 0.4,
      /** Mute BGM during reverse slide-off */
      reverseMuteMusic: true,
      /** Mute spin ticks during reverse slide-off */
      reverseMuteSpinTicks: true,
    },
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch {
    return defaultState();
  }
}

/** Normalize imported/raw project data (legacy groupId → groupIds, defaults, etc.) */
export function hydrateState(data) {
  return migrate(data);
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save state (storage full?):", err);
  }
}

function migrate(data) {
  const base = defaultState();
  if (!data || typeof data !== "object") return base;
  const wasOldSave = !data.look || data.look.resultStyle == null;
  const look = { ...base.look, ...(data.look || {}) };
  // Older saves: winner text color falls back to wheel text color
  if (look.winnerTextColor == null || look.winnerTextColor === "") {
    look.winnerTextColor = look.textColor || base.look.winnerTextColor;
  }
  look.forceTextColor = look.forceTextColor === true;
  look.forceWinnerTextColor = look.forceWinnerTextColor === true;
  look.textStyle = normalizeTextStyle(look.textStyle, "bold");
  look.forceTextStyle = look.forceTextStyle === true;
  look.textFont = normalizeTextFont(look.textFont, "system");
  look.forceTextFont = look.forceTextFont === true;
  // Wheel drag defaults on; only false when explicitly saved off
  look.allowWheelDrag = look.allowWheelDrag !== false;
  // Grab mid-spin defaults on; only false when explicitly saved off
  look.allowGrabStopSpin = look.allowGrabStopSpin !== false;
  // Fair drag spin: only on when explicitly saved (default off)
  look.fairDragSpin = look.fairDragSpin === true;
  // Wait for other wheel in multi-spin: default on (only false when saved off)
  look.waitForTargetWheel = look.waitForTargetWheel !== false;
  // Replace this tile with off-board target: default on (only false when saved off)
  look.replaceSourceOnOtherWheel = look.replaceSourceOnOtherWheel !== false;
  // Center hub spins with wheel only when explicitly enabled (default off)
  look.spinCenterHub = look.spinCenterHub === true;
  // Pointer angle 0–360 (0 = top, 90 = right default). Missing → right.
  {
    let pad = Number(look.pointerAngleDeg);
    if (!Number.isFinite(pad)) pad = 90;
    look.pointerAngleDeg = ((pad % 360) + 360) % 360;
  }
  // Lock defaults ON (older saves never had the field → locked top pointer)
  if (data.look && Object.prototype.hasOwnProperty.call(data.look, "pointerLocked")) {
    look.pointerLocked = data.look.pointerLocked !== false;
  } else {
    look.pointerLocked = true;
  }
  // Hide panels (sidebar collapsed) — only true when explicitly saved
  look.hidePanels = look.hidePanels === true;
  // Track spins in History tab (default on; only false when explicitly off)
  look.trackHistory = look.trackHistory !== false;
  {
    const el = look.eliminateAfterWin;
    look.eliminateAfterWin =
      el === "hide" || el === "remove" || el === "off" ? el : "off";
  }
  // After-win effect dropdown (legacy confettiOnWin boolean → winEffect)
  {
    const allowed = new Set(["none", "confetti", "custom"]);
    const hadWinEffect =
      data.look &&
      Object.prototype.hasOwnProperty.call(data.look, "winEffect");
    let we = look.winEffect;
    if (!hadWinEffect) {
      // Prefer legacy checkbox if present; else default confetti
      if (data.look && data.look.confettiOnWin === false) we = "none";
      else if (data.look && data.look.confettiOnWin === true) we = "confetti";
      else we = "confetti";
    } else if (!allowed.has(we)) {
      we = "confetti";
    }
    if (we === "custom" && !look.winEffectData) we = "confetti";
    look.winEffect = we;
  }
  look.keyboardSpin = look.keyboardSpin !== false;
  look.allowDoubleClickSpin = look.allowDoubleClickSpin !== false;
  look.allowWinnerHide = look.allowWinnerHide !== false;
  // Default follow-slice; only stay fixed if explicitly saved as fixed
  look.imageLayoutMode =
    look.imageLayoutMode === "fixed" ? "fixed" : "slice";
  look.winEffectData = look.winEffectData || null;
  look.winEffectName = look.winEffectName || null;
  if (look.winEffect === "custom" && !look.winEffectData) {
    look.winEffect = "confetti";
  }
  {
    let ad = Number(look.autoDismissSec);
    if (!Number.isFinite(ad)) ad = 0;
    // -1 = don't show results; 0 = manual dismiss; positive = auto-dismiss seconds
    if (ad < 0) ad = -1;
    else ad = Math.min(99999, Math.round(ad));
    look.autoDismissSec = ad;
  }
  look.autoSpin = look.autoSpin === true;
  {
    let n = Number(look.autoSpinEvery);
    if (!Number.isFinite(n) || n < 1) n = 5;
    look.autoSpinEvery = Math.min(9999, Math.round(n));
  }
  {
    const u = look.autoSpinUnit;
    if (u === "seconds" || u === "sec") look.autoSpinUnit = "seconds";
    else if (u === "hours" || u === "hr") look.autoSpinUnit = "hours";
    else if (u === "days") look.autoSpinUnit = "days";
    else look.autoSpinUnit = "minutes";
  }
  const spin = { ...base.spin, ...(data.spin || {}) };
  if (wasOldSave) {
    if (data.spin?.duration == null || data.spin.duration <= 5) {
      spin.duration = base.spin.duration;
    }
    look.resultStyle = "center";
  }
  {
    let d = Number(spin.duration);
    if (!Number.isFinite(d)) d = base.spin.duration;
    spin.duration = Math.min(600, Math.max(0.1, d));
  }
  spin.untilBgmEnds = spin.untilBgmEnds === true;
  {
    let z = Number(spin.landZonePct);
    if (!Number.isFinite(z)) z = 99;
    spin.landZonePct = Math.min(99, Math.max(1, Math.round(z)));
  }
  {
    let m = Number(spin.maxSpeedPct);
    if (!Number.isFinite(m)) m = 100;
    spin.maxSpeedPct = Math.min(200, Math.max(25, Math.round(m)));
  }
  const groups =
    Array.isArray(data.groups) && data.groups.length
      ? data.groups.map((g) => normalizeGroup(g))
      : base.groups;
  const groupIdsSet = new Set(groups.map((g) => g.id));
  const sections = Array.isArray(data.sections)
    ? data.sections.map((s) => normalizeSection(s, groups, groupIdsSet))
    : base.sections;
  const soundIn = data.sound && typeof data.sound === "object" ? data.sound : {};
  let spinTickPreset = soundIn.spinTickPreset;
  if (spinTickPreset !== "mixkit" && spinTickPreset !== "synth" && spinTickPreset !== "custom") {
    // Legacy: custom file present → custom; else built-in beep
    spinTickPreset = soundIn.spinSfxData ? "custom" : "synth";
  }
  if (spinTickPreset === "custom" && !soundIn.spinSfxData) {
    spinTickPreset = "synth";
  }

  let landSfxPreset = soundIn.landSfxPreset;
  if (
    landSfxPreset !== "default" &&
    landSfxPreset !== "victory" &&
    landSfxPreset !== "custom"
  ) {
    // Legacy: custom land file → custom; else built-in chime
    landSfxPreset = soundIn.landSfxData ? "custom" : "default";
  }
  if (landSfxPreset === "custom" && !soundIn.landSfxData) {
    landSfxPreset = "default";
  }

  // Custom section order (Your order) — separate from temporary sorts
  let yourOrderIds = Array.isArray(data.yourOrderIds)
    ? data.yourOrderIds.map(String).filter(Boolean)
    : [];
  {
    const have = new Set(sections.map((s) => s.id));
    const cleaned = [];
    for (const id of yourOrderIds) {
      if (have.has(id) && !cleaned.includes(id)) cleaned.push(id);
    }
    for (const s of sections) {
      if (!cleaned.includes(s.id)) cleaned.push(s.id);
    }
    yourOrderIds = cleaned;
  }

  return {
    /** Starter preset this wheel came from — used by Reset */
    presetId:
      typeof data.presetId === "string" && data.presetId.trim()
        ? data.presetId.trim()
        : base.presetId || "default",
    yourOrderIds,
    groups,
    sections,
    look,
    sound: {
      ...base.sound,
      ...soundIn,
      spinTickPreset,
      landSfxPreset,
    },
    spin,
    secret: {
      ...base.secret,
      ...(data.secret && typeof data.secret === "object" ? data.secret : {}),
      unlocked: !!(data.secret && data.secret.unlocked),
      rigIt: !!(data.secret && data.secret.rigIt),
      rigTargetKind:
        data.secret?.rigTargetKind === "group" ? "group" : "section",
      targetSectionId: data.secret?.targetSectionId || null,
      targetGroupId: data.secret?.targetGroupId || null,
      divertSfxData: data.secret?.divertSfxData || null,
      divertSfxName: data.secret?.divertSfxName || null,
      divertSfxVolume:
        data.secret?.divertSfxVolume != null &&
        Number.isFinite(Number(data.secret.divertSfxVolume))
          ? Math.min(1, Math.max(0, Number(data.secret.divertSfxVolume)))
          : 0.4,
      divertSpeed:
        data.secret?.divertSpeed != null &&
        Number.isFinite(Number(data.secret.divertSpeed))
          ? Math.min(10, Math.max(1, Math.round(Number(data.secret.divertSpeed))))
          : 5,
      // Default ON when key missing (older saves never set these)
      muteMusicOnDivert:
        data.secret && "muteMusicOnDivert" in data.secret
          ? !!data.secret.muteMusicOnDivert
          : true,
      muteSpinTicksOnRig:
        data.secret && "muteSpinTicksOnRig" in data.secret
          ? !!data.secret.muteSpinTicksOnRig
          : true,
      comboOrder:
        data.secret?.comboOrder === "rig-first" ? "rig-first" : "reverse-first",
      reverseRigIt: !!(data.secret && data.secret.reverseRigIt),
      reverseTargetKind:
        data.secret?.reverseTargetKind === "group" ? "group" : "section",
      reverseTargetSectionId: data.secret?.reverseTargetSectionId || null,
      reverseTargetGroupId: data.secret?.reverseTargetGroupId || null,
      reverseSlideSpeed:
        data.secret?.reverseSlideSpeed != null &&
        Number.isFinite(Number(data.secret.reverseSlideSpeed))
          ? Math.min(
              10,
              Math.max(1, Math.round(Number(data.secret.reverseSlideSpeed)))
            )
          : 2,
      reverseSlideSfxPreset: (() => {
        const p = data.secret?.reverseSlideSfxPreset;
        const allowed = [
          "goofy-slip",
          "cartoon-slip",
          "slide-slip",
          "glass-squeak-3",
          "glass-squeak-2",
          "scp-173",
          "synth", // legacy → scp-173
          "custom",
          "default", // legacy label → goofy-slip
        ];
        if (p && allowed.includes(p)) {
          if (p === "default") return "glass-squeak-2";
          if (p === "synth") return "scp-173";
          return p;
        }
        // Legacy: custom file stored without preset
        if (data.secret?.reverseSlideSfxData) return "custom";
        return "glass-squeak-2";
      })(),
      reverseSlideSfxData: data.secret?.reverseSlideSfxData || null,
      reverseSlideSfxName: data.secret?.reverseSlideSfxName || null,
      reverseSlideSfxVolume:
        data.secret?.reverseSlideSfxVolume != null &&
        Number.isFinite(Number(data.secret.reverseSlideSfxVolume))
          ? Math.min(
              1,
              Math.max(0, Number(data.secret.reverseSlideSfxVolume))
            )
          : 0.4,
      reverseMuteMusic:
        data.secret && "reverseMuteMusic" in data.secret
          ? !!data.secret.reverseMuteMusic
          : true,
      reverseMuteSpinTicks:
        data.secret && "reverseMuteSpinTicks" in data.secret
          ? !!data.secret.reverseMuteSpinTicks
          : true,
    },
  };
}

/** Normalize legacy groupId → groupIds[] */
export function getSectionGroupIds(section) {
  if (!section) return [];
  if (Array.isArray(section.groupIds) && section.groupIds.length) {
    return section.groupIds.filter(Boolean);
  }
  if (section.groupId) return [section.groupId];
  return [];
}

export function sectionInGroup(section, groupId) {
  return getSectionGroupIds(section).includes(groupId);
}

/**
 * Highest-priority group this section belongs to (lowest index in groups[]).
 * @returns {Group|null}
 */
export function controllingGroup(state, section) {
  const ids = new Set(getSectionGroupIds(section));
  if (!ids.size) return null;
  for (const g of state.groups) {
    if (ids.has(g.id)) return g;
  }
  return null;
}

/**
 * Section is on the wheel if enabled.
 * - No groups → always eligible (ungrouped).
 * - Has groups → highest-priority group must be active.
 */
export function isSectionActiveOnWheel(state, section) {
  if (!section || section.enabled === false) return false;
  const ids = getSectionGroupIds(section);
  if (!ids.length) return true;
  const ctrl = controllingGroup(state, section);
  if (!ctrl) return true;
  return ctrl.active !== false;
}

/**
 * Groups this section belongs to, in global priority order (index 0 = highest).
 */
export function memberGroupsByPriority(state, section) {
  const ids = new Set(getSectionGroupIds(section));
  if (!ids.size) return [];
  return (state.groups || []).filter((g) => ids.has(g.id));
}

/**
 * Highest-priority member group that "provides" a channel for inheritance.
 * - color: first member group (always)
 * - image: first member group that has imageData
 * - sfx: first member group that has landSfxData
 */
export function inheritGroupForChannel(state, section, channel) {
  const members = memberGroupsByPriority(state, section);
  for (const g of members) {
    if (channel === "color") return g;
    if (channel === "textColor") return g;
    if (channel === "textStyle") return g;
    if (channel === "textFont") return g;
    if (channel === "winnerTextColor") return g;
    if (channel === "image" && g.imageData) return g;
    if (channel === "sfx" && g.landSfxData) return g;
    if (channel === "winEffect" && g.winEffect) return g;
  }
  return null;
}

/** Highest-priority member group with a given override flag on. */
export function forceOverrideGroup(state, section, flag) {
  const members = memberGroupsByPriority(state, section);
  for (const g of members) {
    if (g && g[flag]) return g;
  }
  return null;
}

/**
 * Effective visuals/SFX for the wheel.
 *
 * Per channel (color / image / land SFX):
 * 1. Group force-override (if any member group has that override on) — highest priority wins
 * 2. Else section's own profile if that channel was edited (custom*)
 * 3. Else inherit from member groups by priority — image from highest group that has an
 *    image, SFX from highest that has SFX (can be different groups), color from highest group
 *
 * Label / weight always come from the section.
 */
export function resolveSectionForDisplay(state, section) {
  if (!section) return section;

  const out = {
    ...section,
    profileSource: "section",
    profileGroupId: null,
    profileOverrides: {
      color: false,
      textColor: false,
      textStyle: false,
      textFont: false,
      winnerTextColor: false,
      image: false,
      sfx: false,
      winEffect: false,
    },
    profileFrom: {
      color: { source: "section", groupId: null },
      textColor: { source: "section", groupId: null },
      textStyle: { source: "section", groupId: null },
      textFont: { source: "section", groupId: null },
      winnerTextColor: { source: "section", groupId: null },
      image: { source: "section", groupId: null },
      sfx: { source: "section", groupId: null },
      winEffect: { source: "section", groupId: null },
    },
  };

  const applyFromGroup = (group, keys, channel) => {
    if (!group) return;
    const profile = extractProfile(group);
    for (const k of keys) out[k] = profile[k];
    out.profileFrom[channel] = { source: "group", groupId: group.id };
    out.profileSource = "group";
  };

  // --- Color ---
  const forceColor = forceOverrideGroup(state, section, "overrideColor");
  if (forceColor) {
    applyFromGroup(forceColor, COLOR_KEYS, "color");
    out.profileOverrides.color = true;
  } else if (!section.customColor) {
    applyFromGroup(inheritGroupForChannel(state, section, "color"), COLOR_KEYS, "color");
  }

  // --- Text color (label on wheel) ---
  if (state.look?.forceTextColor === true) {
    // Look Override: always use Look default text color
    out.textColor = normalizeHexColor(state.look?.textColor, "#ffffff");
    out.profileFrom.textColor = { source: "look", groupId: null };
    out.profileOverrides.textColor = true;
  } else {
    const forceText = forceOverrideGroup(state, section, "overrideTextColor");
    if (forceText) {
      applyFromGroup(forceText, TEXT_COLOR_KEYS, "textColor");
      out.profileOverrides.textColor = true;
    } else if (!section.customTextColor) {
      const fromG = inheritGroupForChannel(state, section, "textColor");
      if (fromG) {
        applyFromGroup(fromG, TEXT_COLOR_KEYS, "textColor");
      } else {
        // No group → Look default
        out.textColor = normalizeHexColor(
          state.look?.textColor,
          "#ffffff"
        );
        out.profileFrom.textColor = { source: "look", groupId: null };
      }
    }
  }

  // --- Text style (bold / italic / etc.) ---
  // Look dropdown is the default. Group only when force override is on;
  // section owns after user edits style.
  if (state.look?.forceTextStyle === true) {
    out.textStyle = normalizeTextStyle(state.look?.textStyle, "bold");
    out.profileFrom.textStyle = { source: "look", groupId: null };
    out.profileOverrides.textStyle = true;
  } else {
    const forceStyle = forceOverrideGroup(state, section, "overrideTextStyle");
    if (forceStyle) {
      applyFromGroup(forceStyle, TEXT_STYLE_KEYS, "textStyle");
      out.profileOverrides.textStyle = true;
    } else if (section.customTextStyle === true) {
      out.textStyle = normalizeTextStyle(section.textStyle, "bold");
      out.profileFrom.textStyle = { source: "section", groupId: null };
    } else {
      out.textStyle = normalizeTextStyle(state.look?.textStyle, "bold");
      out.profileFrom.textStyle = { source: "look", groupId: null };
    }
  }

  // --- Text font (family) ---
  if (state.look?.forceTextFont === true) {
    out.textFont = normalizeTextFont(state.look?.textFont, "system");
    out.profileFrom.textFont = { source: "look", groupId: null };
    out.profileOverrides.textFont = true;
  } else {
    const forceFont = forceOverrideGroup(state, section, "overrideTextFont");
    if (forceFont) {
      applyFromGroup(forceFont, TEXT_FONT_KEYS, "textFont");
      out.profileOverrides.textFont = true;
    } else if (section.customTextFont === true) {
      out.textFont = normalizeTextFont(section.textFont, "system");
      out.profileFrom.textFont = { source: "section", groupId: null };
    } else {
      out.textFont = normalizeTextFont(state.look?.textFont, "system");
      out.profileFrom.textFont = { source: "look", groupId: null };
    }
  }

  // --- Winner text color (result overlay name) ---
  const forceWinnerText = forceOverrideGroup(
    state,
    section,
    "overrideWinnerTextColor"
  );
  if (forceWinnerText) {
    applyFromGroup(forceWinnerText, WINNER_TEXT_COLOR_KEYS, "winnerTextColor");
    out.profileOverrides.winnerTextColor = true;
  } else if (!section.customWinnerTextColor) {
    const fromG = inheritGroupForChannel(state, section, "winnerTextColor");
    if (fromG) {
      applyFromGroup(fromG, WINNER_TEXT_COLOR_KEYS, "winnerTextColor");
    } else {
      out.winnerTextColor = normalizeHexColor(
        state.look?.winnerTextColor || state.look?.textColor,
        "#ffffff"
      );
      out.profileFrom.winnerTextColor = { source: "look", groupId: null };
    }
  }

  // --- Image (may come from a different group than SFX) ---
  const forceImage = forceOverrideGroup(state, section, "overrideImage");
  if (forceImage) {
    applyFromGroup(forceImage, IMAGE_KEYS, "image");
    out.profileOverrides.image = true;
  } else if (!section.customImage) {
    applyFromGroup(inheritGroupForChannel(state, section, "image"), IMAGE_KEYS, "image");
  }

  // --- Land SFX ---
  const forceSfx = forceOverrideGroup(state, section, "overrideSfx");
  if (forceSfx) {
    applyFromGroup(forceSfx, SFX_KEYS, "sfx");
    out.profileOverrides.sfx = true;
  } else if (!section.customSfx) {
    applyFromGroup(inheritGroupForChannel(state, section, "sfx"), SFX_KEYS, "sfx");
  }

  // --- After-win effect (Look global default → group → section) ---
  const forceWinFx = forceOverrideGroup(state, section, "overrideWinEffect");
  if (forceWinFx) {
    applyFromGroup(forceWinFx, WIN_EFFECT_KEYS, "winEffect");
    out.profileOverrides.winEffect = true;
    if (!out.winEffect) {
      out.winEffect = normalizeWinEffect(state.look?.winEffect, "confetti");
      out.winEffectData = state.look?.winEffectData || null;
      out.winEffectName = state.look?.winEffectName || null;
      out.profileFrom.winEffect = { source: "look", groupId: null };
    }
  } else if (section.customWinEffect === true) {
    out.winEffect = normalizeWinEffect(section.winEffect, "confetti");
    out.winEffectData = section.winEffectData || null;
    out.winEffectName = section.winEffectName || null;
    if (out.winEffect === "custom" && !out.winEffectData) {
      out.winEffect = "confetti";
    }
    out.profileFrom.winEffect = { source: "section", groupId: null };
  } else {
    const fromG = inheritGroupForChannel(state, section, "winEffect");
    if (fromG && fromG.winEffect) {
      applyFromGroup(fromG, WIN_EFFECT_KEYS, "winEffect");
    } else {
      out.winEffect = normalizeWinEffect(state.look?.winEffect, "confetti");
      out.winEffectData = state.look?.winEffectData || null;
      out.winEffectName = state.look?.winEffectName || null;
      out.profileFrom.winEffect = { source: "look", groupId: null };
    }
    if (out.winEffect === "custom" && !out.winEffectData) {
      out.winEffect = normalizeWinEffect(state.look?.winEffect, "confetti");
      if (out.winEffect === "custom") {
        out.winEffectData = state.look?.winEffectData || null;
        out.winEffectName = state.look?.winEffectName || null;
      } else {
        out.winEffectData = null;
        out.winEffectName = null;
      }
    }
  }

  // Final fallback for text
  out.textColor = normalizeHexColor(
    out.textColor || state.look?.textColor,
    "#ffffff"
  );
  out.textStyle = normalizeTextStyle(
    out.textStyle || state.look?.textStyle,
    "bold"
  );
  out.textFont = normalizeTextFont(
    out.textFont || state.look?.textFont,
    "system"
  );
  out.winnerTextColor = normalizeHexColor(
    out.winnerTextColor ||
      state.look?.winnerTextColor ||
      state.look?.textColor,
    "#ffffff"
  );

  // Prefer SFX group id for audio buffer key; else any group source
  if (out.profileFrom.sfx.source === "group") {
    out.profileGroupId = out.profileFrom.sfx.groupId;
  } else if (out.profileFrom.image.source === "group") {
    out.profileGroupId = out.profileFrom.image.groupId;
  } else if (out.profileFrom.color.source === "group") {
    out.profileGroupId = out.profileFrom.color.groupId;
  } else if (out.profileFrom.textColor.source === "group") {
    out.profileGroupId = out.profileFrom.textColor.groupId;
  } else if (out.profileFrom.winnerTextColor.source === "group") {
    out.profileGroupId = out.profileFrom.winnerTextColor.groupId;
  }

  return out;
}

/** Active sections with inheritance / override applied (for drawing / land SFX). */
export function getDisplaySections(state) {
  return getActiveSections(state).map((s) => resolveSectionForDisplay(state, s));
}

function normalizeSection(s, groups, groupIdsSet) {
  let gids = [];
  if (Array.isArray(s.groupIds) && s.groupIds.length) {
    gids = s.groupIds.filter((id) => groupIdsSet.has(id));
  } else if (s.groupId && groupIdsSet.has(s.groupId)) {
    gids = [s.groupId];
  }
  // Empty groupIds is allowed (ungrouped / "None")

  const profile = normalizeProfileFields(s);
  const hasCustomFlags =
    s.customColor != null ||
    s.customTextColor != null ||
    s.customTextStyle != null ||
    s.customTextFont != null ||
    s.customWinnerTextColor != null ||
    s.customImage != null ||
    s.customSfx != null ||
    s.customWinEffect != null;

  // Legacy saves: keep existing media/color as section-owned so looks don't jump
  let customColor;
  let customTextColor;
  let customTextStyle;
  let customTextFont;
  let customWinnerTextColor;
  let customImage;
  let customSfx;
  let customWinEffect;
  if (hasCustomFlags) {
    customColor = s.customColor === true;
    customTextColor = s.customTextColor === true;
    // New channel: only owned when explicitly flagged (old saves inherit Look/group)
    customTextStyle = s.customTextStyle === true;
    customTextFont = s.customTextFont === true;
    customWinnerTextColor = s.customWinnerTextColor === true;
    customImage = s.customImage === true;
    customSfx = s.customSfx === true;
    customWinEffect = s.customWinEffect === true;
  } else {
    customColor = true;
    // Old projects: inherit text color (Look / group) unless they set one
    customTextColor = s.textColor != null && s.textColor !== "";
    customTextStyle = false;
    customTextFont = false;
    customWinnerTextColor = false;
    customImage = !!profile.imageData;
    customSfx = !!profile.landSfxData;
    customWinEffect = false;
  }

  let winEffect = null;
  if (
    s.winEffect === "none" ||
    s.winEffect === "confetti" ||
    s.winEffect === "custom"
  ) {
    winEffect = s.winEffect;
  } else if (s.winEffectData) {
    winEffect = "custom";
  }

  const landFields = normalizeLandActionFields(s);

  let winBgm = normalizeWinBgm(s.winBgm);
  let winBgmData = s.winBgmData || null;
  let winBgmName = s.winBgmName || null;
  if (winBgm === "custom" && !winBgmData) {
    winBgm = "inherit";
  }
  if (winBgm !== "custom") {
    winBgmData = null;
    winBgmName = null;
  }

  const returnAfterMs = normalizeReturnAfterMs(s.returnAfterMs);
  // Only keep a scheduled return while the section is actually off the wheel
  let returnsAt = normalizeReturnsAt(s.returnsAt);
  if (s.enabled !== false) returnsAt = null;

  return {
    id: s.id || uid("sec"),
    label: String(s.label ?? "Untitled"),
    weight: normalizeWeight(s.weight),
    enabled: s.enabled !== false,
    groupIds: gids,
    customColor,
    customTextColor,
    customTextStyle,
    customTextFont,
    customWinnerTextColor,
    customImage,
    customSfx,
    customWinEffect,
    ...profile,
    winEffect,
    winEffectData: s.winEffectData || profile.winEffectData || null,
    winEffectName: s.winEffectName || profile.winEffectName || null,
    landSfxVolume: normalizeLandSfxVolume(
      s.landSfxVolume,
      0.4
    ),
    ...landFields,
    winBgm,
    winBgmData,
    winBgmName,
    returnAfterMs,
    returnsAt,
  };
}

/** Sections that currently appear on the wheel (raw data, no override) */
export function getActiveSections(state) {
  return state.sections.filter((s) => isSectionActiveOnWheel(state, s));
}

export function nextPaletteColor(state) {
  return PALETTE[state.sections.length % PALETTE.length];
}

/** Section weight — allows decimals (e.g. 1.1). Min 0.1. */
export function normalizeWeight(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(1000, Math.max(0.1, v));
}

/** Display weight without ugly float noise */
export function formatWeight(n) {
  const v = normalizeWeight(n);
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export { STORAGE_KEY, PALETTE };
