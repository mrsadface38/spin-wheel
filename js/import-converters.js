/**
 * Convert foreign wheel formats (esp. Wheel of Names) into our project state shape.
 * Native projects already have { sections, groups } and pass through hydrateState.
 */

import {
  defaultState,
  defaultGroupProfile,
  normalizeGroup,
  normalizeProfileFields,
  uid,
} from "./state.js";

const FALLBACK_PALETTE = [
  "#3369E8",
  "#D50F25",
  "#EEB211",
  "#009925",
  "#4a6cf7",
  "#e74c3c",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
];

/** @returns {boolean} */
export function isNativeProject(data) {
  return !!(
    data &&
    typeof data === "object" &&
    Array.isArray(data.sections) &&
    Array.isArray(data.groups)
  );
}

/** @returns {boolean} */
export function looksLikeWheelOfNames(data) {
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data.wheelConfigs)) return true;
  if (Array.isArray(data.wheels)) return true;
  if (data.wheelConfig && typeof data.wheelConfig === "object") return true;
  if (Array.isArray(data.entries)) return true;
  if (Array.isArray(data.names)) return true;
  return false;
}

/**
 * Extract WoN wheel config objects from any of their export shapes.
 * @param {object} data
 * @returns {object[]}
 */
function extractWonConfigs(data) {
  if (Array.isArray(data.wheelConfigs) && data.wheelConfigs.length) {
    return data.wheelConfigs.filter((c) => c && typeof c === "object");
  }
  if (Array.isArray(data.wheels) && data.wheels.length) {
    return data.wheels
      .map((w) => w?.wheelConfig || w)
      .filter((c) => c && typeof c === "object");
  }
  if (data.wheelConfig && typeof data.wheelConfig === "object") {
    return [data.wheelConfig];
  }
  // Single config with entries/names at top level
  if (Array.isArray(data.entries) || Array.isArray(data.names)) {
    return [data];
  }
  return [];
}

/**
 * Normalize a WoN entry list (legacy `names` → entries).
 * @param {object} config
 * @returns {Array<{text?: string, image?: string, color?: string, weight?: number, enabled?: boolean}>}
 */
function wonEntries(config) {
  if (Array.isArray(config.entries) && config.entries.length) {
    return config.entries;
  }
  if (Array.isArray(config.names)) {
    return config.names.map((n) => {
      if (n && typeof n === "object") {
        return {
          text: n.text ?? n.name ?? String(n),
          image: n.image,
          color: n.color,
          weight: n.weight,
          enabled: n.enabled,
        };
      }
      return { text: String(n ?? "") };
    });
  }
  return [];
}

/** Palette from WoN colorSettings (enabled only). */
function wonPalette(config) {
  const settings = Array.isArray(config.colorSettings)
    ? config.colorSettings
    : [];
  const colors = settings
    .filter((c) => c && c.enabled !== false && c.color)
    .map((c) => expandHex(String(c.color)));
  return colors.length ? colors : FALLBACK_PALETTE.slice();
}

function expandHex(hex) {
  const h = hex.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return h;
}

function isDataImage(s) {
  return typeof s === "string" && /^data:image\//i.test(s);
}

function hubSizeToFraction(hubSize) {
  // WoN uses S / M / L style sizes
  const key = String(hubSize || "S").toUpperCase();
  if (key === "L" || key === "LARGE") return 0.28;
  if (key === "M" || key === "MEDIUM") return 0.2;
  if (typeof hubSize === "number" && Number.isFinite(hubSize)) {
    return Math.min(0.4, Math.max(0.08, hubSize));
  }
  return 0.16;
}

/**
 * Convert one or more Wheel of Names configs into our project JSON.
 * @param {object} data
 * @returns {object} project-shaped data (still needs hydrateState)
 */
export function convertWheelOfNames(data) {
  const configs = extractWonConfigs(data);
  if (!configs.length) {
    throw new Error("No Wheel of Names entries found in file");
  }

  const base = defaultState();
  const multi = configs.length > 1;
  const groups = [];
  const sections = [];

  // Look / spin from first config (primary wheel)
  const primary = configs[0];
  const spinTime = Number(primary.spinTime);
  if (Number.isFinite(spinTime) && spinTime > 0) {
    base.spin.duration = Math.min(30, Math.max(1, Math.round(spinTime)));
  }

  if (primary.pageBackgroundColor) {
    base.look.backgroundColor = expandHex(String(primary.pageBackgroundColor));
  }
  // Center logo (uploaded data URI only — gallery paths won't load off-site)
  if (isDataImage(primary.customPictureDataUri)) {
    base.look.centerImage = primary.customPictureDataUri;
  }
  if (isDataImage(primary.customCoverImageDataUri)) {
    base.look.backgroundImage = primary.customCoverImageDataUri;
  }
  if (primary.hubSize != null) {
    base.look.centerSize = hubSizeToFraction(primary.hubSize);
  }
  if (primary.autoRemoveWinner === true) {
    base.look.allowWinnerRemove = true;
  }
  if (primary.title && String(primary.title).trim()) {
    // No wheel title field — use as default winner banner label hint only if custom
    // Keep default "Winner"; put title nowhere critical
  }

  const duringVol = Number(primary.duringSpinSoundVolume);
  if (Number.isFinite(duringVol)) {
    base.sound.spinVolume = Math.min(1, Math.max(0, duringVol / 100));
  }
  const afterVol = Number(primary.afterSpinSoundVolume);
  if (Number.isFinite(afterVol)) {
    base.sound.landVolume = Math.min(1, Math.max(0, afterVol / 100));
  }
  if (primary.duringSpinSound === "no-sound") {
    base.sound.spinMode = "off";
  }

  configs.forEach((cfg, wheelIndex) => {
    const palette = wonPalette(cfg);
    const groupName =
      (cfg.title && String(cfg.title).trim()) ||
      (multi ? `Wheel ${wheelIndex + 1}` : "Main");
    const group = normalizeGroup({
      id: uid("grp"),
      name: groupName,
      active: true,
      ...defaultGroupProfile(),
    });
    groups.push(group);

    const entries = wonEntries(cfg);
    let colorIdx = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const label = String(entry.text ?? "").trim();
      const img = isDataImage(entry.image) ? entry.image : null;
      // Skip completely empty rows (WoN keeps blanks sometimes)
      if (!label && !img) continue;

      const hasOwnColor = !!(entry.color && String(entry.color).trim());
      const color = hasOwnColor
        ? expandHex(String(entry.color))
        : palette[colorIdx % palette.length];
      colorIdx++;

      let weight = Number(entry.weight);
      if (!Number.isFinite(weight) || weight <= 0) weight = 1;

      const enabled = entry.enabled !== false;

      sections.push({
        id: uid("sec"),
        label: label || "Image",
        color,
        weight,
        enabled,
        groupIds: [group.id],
        customColor: true,
        customTextColor: false,
        customImage: !!img,
        customSfx: false,
        ...normalizeProfileFields({
          color,
          textColor: "#ffffff",
          imageData: img,
        }),
      });
    }
  });

  if (!sections.length) {
    throw new Error("Wheel of Names file had no usable entries");
  }

  return {
    ...base,
    groups,
    sections,
    // Don't carry secret / unlocked from defaults overwrite — fine
  };
}

/**
 * Plain text / CSV list → project.
 * Supports:
 *   Name
 *   Name,2
 *   Name: 3
 *   Name\t2
 */
export function convertTextList(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (!lines.length) {
    throw new Error("Empty list");
  }

  const base = defaultState();
  const group = normalizeGroup({
    id: uid("grp"),
    name: "Main",
    active: true,
    ...defaultGroupProfile(),
  });
  const sections = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let label = line;
    let weight = 1;

    // "Name: 3" or "Name,3" or "Name\t3"
    const m = line.match(/^(.+?)(?:\s*[:|,;\t]\s*)(\d+(?:\.\d+)?)\s*$/);
    if (m) {
      label = m[1].trim();
      weight = Number(m[2]) || 1;
    }

    // Strip surrounding quotes
    label = label.replace(/^["']|["']$/g, "").trim();
    if (!label) continue;

    const color = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
    sections.push({
      id: uid("sec"),
      label,
      color,
      weight,
      enabled: true,
      groupIds: [group.id],
      customColor: true,
      customTextColor: false,
      customImage: false,
      customSfx: false,
      ...normalizeProfileFields({ color, textColor: "#ffffff" }),
    });
  }

  if (!sections.length) {
    throw new Error("No names found in text file");
  }

  return {
    ...base,
    groups: [group],
    sections,
  };
}

/**
 * Parse raw import file text into project-shaped data.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {{ data: object, source: string }}
 */
export function parseImportFile(text, fileName = "") {
  const trimmed = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("File is empty");

  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      throw new Error("Invalid JSON: " + (err.message || err));
    }

    if (isNativeProject(data)) {
      return { data, source: "native" };
    }
    if (looksLikeWheelOfNames(data)) {
      return { data: convertWheelOfNames(data), source: "wheel-of-names" };
    }
    // Array of strings / entry-like objects
    if (Array.isArray(data)) {
      if (data.every((x) => typeof x === "string" || typeof x === "number")) {
        return {
          data: convertTextList(data.map(String).join("\n")),
          source: "json-list",
        };
      }
      if (
        data.every(
          (x) => x && typeof x === "object" && (x.text != null || x.name != null)
        )
      ) {
        return {
          data: convertWheelOfNames({ entries: data }),
          source: "wheel-of-names",
        };
      }
    }
    throw new Error(
      "Unrecognized JSON. Expected our Export file or a Wheel of Names export."
    );
  }

  // Plain text / CSV
  const lower = (fileName || "").toLowerCase();
  if (
    lower.endsWith(".txt") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    !trimmed.startsWith("<")
  ) {
    return { data: convertTextList(trimmed), source: "text" };
  }

  throw new Error("Unsupported file type");
}
