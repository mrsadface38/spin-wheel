/**
 * Multi-wheel library: several named projects in localStorage, one active.
 * Migrates the legacy single-project key into "My wheel" on first load.
 */

import {
  defaultState,
  hydrateState,
  uid,
  STORAGE_KEY as LEGACY_STORAGE_KEY,
} from "./state.js";

export const LIBRARY_KEY = "spin-wheel-library-v1";

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * @typedef {{ id: string, name: string, updatedAt: number, data: object }} WheelSlot
 * @typedef {{ activeId: string, wheels: WheelSlot[] }} WheelLibrary
 */

/**
 * @param {Partial<WheelSlot>} slot
 * @returns {WheelSlot}
 */
function normalizeSlot(slot) {
  const id = slot?.id || uid("wheel");
  const name = String(slot?.name || "My wheel").trim() || "My wheel";
  const updatedAt = Number(slot?.updatedAt) || Date.now();
  const data = hydrateState(slot?.data || defaultState());
  return { id, name, updatedAt, data };
}

/**
 * @param {any} raw
 * @returns {WheelLibrary}
 */
function normalizeLibrary(raw) {
  if (!raw || typeof raw !== "object") {
    return createFreshLibrary();
  }
  let wheels = Array.isArray(raw.wheels)
    ? raw.wheels.map((w) => normalizeSlot(w))
    : [];
  if (!wheels.length) {
    return createFreshLibrary();
  }
  let activeId = raw.activeId;
  if (!wheels.some((w) => w.id === activeId)) {
    activeId = wheels[0].id;
  }
  return { activeId, wheels };
}

function createFreshLibrary(name = "My wheel", data = null) {
  const id = uid("wheel");
  return {
    activeId: id,
    wheels: [
      normalizeSlot({
        id,
        name,
        updatedAt: Date.now(),
        data: data || defaultState(),
      }),
    ],
  };
}

/**
 * Load library; migrate legacy single-state save if needed.
 * @returns {WheelLibrary}
 */
export function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (raw) {
      return normalizeLibrary(JSON.parse(raw));
    }
  } catch (err) {
    console.warn("Could not load wheel library:", err);
  }

  // Migrate old single-project localStorage
  let legacyData = null;
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      legacyData = hydrateState(JSON.parse(legacy));
    }
  } catch {
    /* ignore */
  }

  const lib = createFreshLibrary(
    legacyData ? "My wheel" : "My wheel",
    legacyData
  );
  saveLibrary(lib);
  return lib;
}

/**
 * @param {WheelLibrary} lib
 * @returns {boolean} success
 */
export function saveLibrary(lib) {
  try {
    const activeId =
      lib.activeId && lib.wheels?.some((w) => w.id === lib.activeId)
        ? lib.activeId
        : lib.wheels?.[0]?.id;
    const payload = {
      activeId,
      wheels: (lib.wheels || []).map((w) => ({
        id: w.id,
        name: w.name,
        updatedAt: w.updatedAt || Date.now(),
        data: w.data,
      })),
    };
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(payload));
    // Drop legacy single-wheel key once library is the source of truth.
    // Re-writing it every save nearly doubled storage and caused repeated
    // "storage full" failures even when the library alone still fit.
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return true;
  } catch (err) {
    console.warn("Could not save wheel library (storage full?):", err);
    return false;
  }
}

/**
 * @param {WheelLibrary} lib
 * @returns {WheelSlot}
 */
export function getActiveSlot(lib) {
  const n = normalizeLibrary(lib);
  return n.wheels.find((w) => w.id === n.activeId) || n.wheels[0];
}

/**
 * Write current project into the active slot (clone).
 * @param {WheelLibrary} lib
 * @param {object} state
 * @returns {WheelLibrary}
 */
export function writeActiveState(lib, state) {
  const next = {
    activeId: lib.activeId,
    wheels: lib.wheels.map((w) =>
      w.id === lib.activeId
        ? {
            ...w,
            updatedAt: Date.now(),
            data: hydrateState(deepClone(state)),
          }
        : w
    ),
  };
  return next;
}

/**
 * @param {WheelLibrary} lib
 * @param {string} id
 * @returns {{ lib: WheelLibrary, state: object } | null}
 */
export function switchActive(lib, id) {
  if (!lib.wheels.some((w) => w.id === id)) return null;
  if (id === lib.activeId) {
    return {
      lib,
      state: hydrateState(deepClone(getActiveSlot(lib).data)),
    };
  }
  const next = { ...lib, activeId: id };
  const slot = getActiveSlot(next);
  return {
    lib: next,
    state: hydrateState(deepClone(slot.data)),
  };
}

/**
 * @param {WheelLibrary} lib
 * @param {string} [name]
 * @param {object|null} [fromState] copy of another project, or blank default
 * @returns {{ lib: WheelLibrary, state: object, id: string }}
 */
export function addWheel(lib, name, fromState = null) {
  const id = uid("wheel");
  const n = (name && String(name).trim()) || defaultNewName(lib);
  const data = hydrateState(deepClone(fromState || defaultState()));
  const slot = normalizeSlot({ id, name: n, updatedAt: Date.now(), data });
  const next = {
    activeId: id,
    wheels: [...lib.wheels, slot],
  };
  return {
    lib: next,
    state: hydrateState(deepClone(slot.data)),
    id,
  };
}

/**
 * @param {WheelLibrary} lib
 * @returns {string}
 */
function defaultNewName(lib) {
  const n = (lib.wheels?.length || 0) + 1;
  return `Wheel ${n}`;
}

/**
 * @param {WheelLibrary} lib
 * @param {string} id
 * @param {string} name
 * @returns {WheelLibrary}
 */
export function renameWheel(lib, id, name) {
  const cleaned = String(name || "").trim() || "Untitled";
  return {
    ...lib,
    wheels: lib.wheels.map((w) =>
      w.id === id ? { ...w, name: cleaned, updatedAt: Date.now() } : w
    ),
  };
}

/**
 * @param {WheelLibrary} lib
 * @param {string} id
 * @returns {WheelLibrary | null} null if cannot delete (last wheel / missing)
 */
export function deleteWheel(lib, id) {
  if (lib.wheels.length <= 1) return null;
  if (!lib.wheels.some((w) => w.id === id)) return null;
  const wheels = lib.wheels.filter((w) => w.id !== id);
  let activeId = lib.activeId;
  if (activeId === id) {
    activeId = wheels[0].id;
  }
  return { activeId, wheels };
}

/**
 * Wipe every saved wheel and return a single slot.
 * Pass blank project data (e.g. blankWheelState()) so the survivor is empty —
 * not the default prize preset.
 * @param {string} [name]
 * @param {object|null} [data] project state for the new wheel
 * @returns {WheelLibrary}
 */
export function clearAllWheels(name = "My wheel", data = null) {
  return createFreshLibrary(name, data);
}

/**
 * Duplicate a wheel (by id) and switch to the copy.
 * Keeps the same name by default (user can Rename after).
 * @param {WheelLibrary} lib
 * @param {string} id
 * @param {string} [name] optional name for the copy (default: source name)
 * @returns {{ lib: WheelLibrary, state: object, id: string } | null}
 */
export function duplicateWheel(lib, id, name) {
  const src = lib.wheels.find((w) => w.id === id);
  if (!src) return null;
  const copyName =
    (name && String(name).trim()) || src.name || "My wheel";
  return addWheel(lib, copyName, src.data);
}
