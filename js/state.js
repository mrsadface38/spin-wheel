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
 *   landSfxData: string|null,
 *   landSfxName: string|null,
 *   landSfxVolume: number
 * }} Section */

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
  "winnerTextColor",
  "imageData",
  "imageMode",
  "imageFillScale",
  "imageFillOffsetX",
  "imageFillOffsetY",
  "imageTileScale",
  "imageTileOffsetX",
  "imageTileOffsetY",
  "landSfxData",
  "landSfxName",
];

export const COLOR_KEYS = ["color"];
export const TEXT_COLOR_KEYS = ["textColor"];
export const WINNER_TEXT_COLOR_KEYS = ["winnerTextColor"];
export const IMAGE_KEYS = [
  "imageData",
  "imageMode",
  "imageFillScale",
  "imageFillOffsetX",
  "imageFillOffsetY",
  "imageTileScale",
  "imageTileOffsetX",
  "imageTileOffsetY",
];
export const SFX_KEYS = ["landSfxData", "landSfxName"];

/** @typedef {{ color?: boolean, textColor?: boolean, winnerTextColor?: boolean, image?: boolean, sfx?: boolean }} ProfileParts */

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function defaultGroupProfile() {
  return {
    overrideColor: false,
    overrideTextColor: false,
    overrideWinnerTextColor: false,
    overrideImage: false,
    overrideSfx: false,
    color: "#4a6cf7",
    textColor: "#ffffff",
    winnerTextColor: "#ffffff",
    imageData: null,
    imageMode: "fill",
    imageFillScale: 1,
    imageFillOffsetX: 0,
    imageFillOffsetY: 0,
    imageTileScale: 1,
    imageTileOffsetX: 0,
    imageTileOffsetY: 0,
    landSfxData: null,
    landSfxName: null,
  };
}

export function groupHasAnyOverride(g) {
  return !!(
    g &&
    (g.overrideColor ||
      g.overrideTextColor ||
      g.overrideWinnerTextColor ||
      g.overrideImage ||
      g.overrideSfx)
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

/** Normalize profile image/sfx/color fields onto a plain object */
export function normalizeProfileFields(src = {}) {
  return {
    color: normalizeHexColor(src.color, "#4a6cf7"),
    textColor: normalizeHexColor(src.textColor, "#ffffff"),
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
    landSfxData: src.landSfxData || null,
    landSfxName: src.landSfxName || null,
  };
}

export function normalizeGroup(g = {}) {
  const profile = normalizeProfileFields(g);
  // Legacy: single overrideSections flag → all three channels
  const legacyAll = g.overrideSections === true;
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
    overrideWinnerTextColor: g.overrideWinnerTextColor === true,
    overrideImage:
      g.overrideImage === true || (g.overrideImage == null && legacyAll),
    overrideSfx:
      g.overrideSfx === true || (g.overrideSfx == null && legacyAll),
    ...profile,
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
          winnerTextColor: parts.winnerTextColor === true,
          image: parts.image === true,
          sfx: parts.sfx === true,
        }
      : {
          color: true,
          textColor: true,
          winnerTextColor: true,
          image: true,
          sfx: true,
        };
  if (want.color) {
    for (const k of COLOR_KEYS) section[k] = p[k];
    section.customColor = true;
  }
  if (want.textColor) {
    for (const k of TEXT_COLOR_KEYS) section[k] = p[k];
    section.customTextColor = true;
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
  return section;
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
    customWinnerTextColor: false,
    customImage: false,
    customSfx: false,
    ...normalizeProfileFields({
      color: PALETTE[i % PALETTE.length],
      textColor: "#ffffff",
      winnerTextColor: "#ffffff",
    }),
  }));

  return {
    // Array order = priority: index 0 is highest
    groups: [g1, g2],
    sections,
    look: {
      backgroundColor: "#0f1220",
      backgroundImage: null,
      centerColor: "#1a1f35",
      centerImage: null,
      centerSize: 0.16,
      borderColor: "#f0d78c",
      textColor: "#ffffff",
      /** Color of the winning name on the result overlay (separate from wheel labels) */
      winnerTextColor: "#ffffff",
      /**
       * When true, result screen always uses look.winnerTextColor
       * (ignores section / group winner colors).
       */
      forceWinnerTextColor: false,
      showLabels: true,
      showImages: true,
      resultStyle: "center",
      winnerLabel: "Winner",
      allowWinnerRemove: true,
      // Section list weight range slider (manual number field can still use decimals)
      weightSliderMin: 1,
      weightSliderMax: 20,
      weightSliderStep: 1,
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
      reverseSlideSfxPreset: "goofy-slip",
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
  look.forceWinnerTextColor = look.forceWinnerTextColor === true;
  const spin = { ...base.spin, ...(data.spin || {}) };
  if (wasOldSave) {
    if (data.spin?.duration == null || data.spin.duration <= 5) {
      spin.duration = base.spin.duration;
    }
    look.resultStyle = "center";
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

  return {
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
          if (p === "default") return "goofy-slip";
          if (p === "synth") return "scp-173";
          return p;
        }
        // Legacy: custom file stored without preset
        if (data.secret?.reverseSlideSfxData) return "custom";
        return "goofy-slip";
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
    if (channel === "winnerTextColor") return g;
    if (channel === "image" && g.imageData) return g;
    if (channel === "sfx" && g.landSfxData) return g;
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
      winnerTextColor: false,
      image: false,
      sfx: false,
    },
    profileFrom: {
      color: { source: "section", groupId: null },
      textColor: { source: "section", groupId: null },
      winnerTextColor: { source: "section", groupId: null },
      image: { source: "section", groupId: null },
      sfx: { source: "section", groupId: null },
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

  // Final fallback for text
  out.textColor = normalizeHexColor(
    out.textColor || state.look?.textColor,
    "#ffffff"
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
    s.customWinnerTextColor != null ||
    s.customImage != null ||
    s.customSfx != null;

  // Legacy saves: keep existing media/color as section-owned so looks don't jump
  let customColor;
  let customTextColor;
  let customWinnerTextColor;
  let customImage;
  let customSfx;
  if (hasCustomFlags) {
    customColor = s.customColor === true;
    customTextColor = s.customTextColor === true;
    // New channel: only owned when explicitly flagged (old saves inherit Look/group)
    customWinnerTextColor = s.customWinnerTextColor === true;
    customImage = s.customImage === true;
    customSfx = s.customSfx === true;
  } else {
    customColor = true;
    // Old projects: inherit text color (Look / group) unless they set one
    customTextColor = s.textColor != null && s.textColor !== "";
    customWinnerTextColor = false;
    customImage = !!profile.imageData;
    customSfx = !!profile.landSfxData;
  }

  return {
    id: s.id || uid("sec"),
    label: String(s.label ?? "Untitled"),
    weight: normalizeWeight(s.weight),
    enabled: s.enabled !== false,
    groupIds: gids,
    customColor,
    customTextColor,
    customWinnerTextColor,
    customImage,
    customSfx,
    ...profile,
    landSfxVolume: normalizeLandSfxVolume(
      s.landSfxVolume,
      0.4
    ),
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
