import {
  defaultState,
  hydrateState,
  getActiveSections,
  getDisplaySections,
  nextPaletteColor,
  fileToDataUrl,
  uid,
  getSectionGroupIds,
  sectionInGroup,
  controllingGroup,
  isSectionActiveOnWheel,
  resolveSectionForDisplay,
  extractProfile,
  applyProfileToSection,
  normalizeGroup,
  normalizeProfileFields,
  groupHasAnyOverride,
  normalizeWeight,
  formatWeight,
} from "./state.js";
import {
  loadLibrary,
  saveLibrary,
  getActiveSlot,
  writeActiveState,
  switchActive,
  addWheel,
  renameWheel,
  deleteWheel,
  duplicateWheel,
} from "./wheels.js";
import { AudioManager } from "./audio.js";
import { Wheel } from "./wheel.js";
import { computeFillImageLayout } from "./slice-image-layout.js";
import { parseImportFile } from "./import-converters.js";
import { APP_UPDATE } from "./version.js";

const audio = new AudioManager();
/** @type {import("./wheels.js").WheelLibrary | ReturnType<typeof loadLibrary>} */
let library;
let state;
try {
  library = loadLibrary();
  const slot = getActiveSlot(library);
  state = hydrateState(
    JSON.parse(JSON.stringify(slot?.data || defaultState()))
  );
} catch (err) {
  console.error("Failed to load saved wheels — starting fresh:", err);
  library = loadLibrary();
  try {
    // If library itself is corrupt, force a blank one via default state write
    state = defaultState();
    library = writeActiveState(library, state);
    saveLibrary(library);
  } catch {
    state = defaultState();
  }
}
/** True while a timed spin / fling session owns the wheel */
let spinBusy = false;

// --- Session undo (in-memory only; cleared when the app closes) ---
const MAX_UNDO = 80;
/** @type {object[]} */
const undoStack = [];
let historySuspended = false;
/** Coalesce slider/color drags into one undo step */
let continuousCheckpointTaken = false;

function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

/** Save current state so the next edit can be undone. Call *before* mutating. */
function checkpoint() {
  if (historySuspended) return;
  try {
    undoStack.push(cloneState(state));
    while (undoStack.length > MAX_UNDO) undoStack.shift();
  } catch (err) {
    console.warn("Undo snapshot failed (state too large?):", err);
  }
  updateUndoButton();
}

/** One checkpoint for a drag/scrub gesture until endContinuous() */
function checkpointContinuous() {
  if (continuousCheckpointTaken || historySuspended) return;
  continuousCheckpointTaken = true;
  checkpoint();
}

function endContinuous() {
  continuousCheckpointTaken = false;
}

function updateUndoButton() {
  const btn = $("#btn-undo");
  if (!btn) return;
  const n = undoStack.length;
  btn.disabled = n === 0;
  btn.title =
    n === 0
      ? "Nothing to undo"
      : `Undo last change (${n} step${n === 1 ? "" : "s"}) — Ctrl+Z`;
  btn.textContent = n === 0 ? "Undo" : `Undo (${n})`;
}

async function performUndo() {
  if (!undoStack.length || historySuspended) return;
  historySuspended = true;
  try {
    state = undoStack.pop();
    persist();
    lastWinnerId = null;
    hideResults();
    bindAll();
    await preloadAudio();
    await refreshWheel();
  } finally {
    historySuspended = false;
    continuousCheckpointTaken = false;
    updateUndoButton();
  }
}

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const wheelCanvas = $("#wheel-canvas");
const bgCanvas = $("#bg-canvas");
const resultBanner = $("#result-banner");
const resultCenter = $("#result-center");
const resultActionsBar = $("#result-actions-bar");
const resultTextBanner = $("#result-text-banner");
const resultTextCenter = $("#result-text-center");
const sectionsList = $("#sections-list");
const groupsList = $("#groups-list");
const sectionModal = $("#section-modal");
const bulkModal = $("#bulk-modal");
const groupModal = $("#group-modal");
const sectionSearchInput = $("#section-search");
const sectionSearchClear = $("#section-search-clear");
const sectionSearchMeta = $("#section-search-meta");

/** @type {string|null} */
let lastWinnerId = null;
/** Current sections search query */
let sectionSearchQuery = "";
/** List sort mode (display only — does not change saved order) */
const SECTION_SORT_KEY = "spin-wheel-section-sort";
let sectionSortMode = "manual";
try {
  const saved = localStorage.getItem(SECTION_SORT_KEY);
  if (saved) sectionSortMode = saved;
} catch {
  /* ignore */
}

const wheel = new Wheel(wheelCanvas, bgCanvas, {
  overlayCanvas: $("#wheel-overlay"),
  bgMediaEl: $("#bg-media"),
  sliceRotatorEl: $("#slice-media-rotator"),
  centerMediaEl: $("#center-media"),
  onTick: (speed) => {
    if (!state.sound.enabled) return;
    // Secret: silence ticks only during the last-moment divert
    if (ensureSecretState().muteSpinTicksOnRig && rigDivertActive) return;
    const mode = state.sound.spinMode;
    if (mode === "off" || mode === "loop") return;
    const vol = state.sound.spinVolume * (0.4 + 0.6 * speed);
    const pitch = 0.85 + speed * 0.4;
    const preset = getSpinTickPreset();
    if (preset === "synth") {
      audio.playTick(vol, pitch);
      return;
    }
    if (audio.buffers.has("spin")) {
      audio.playOneShot("spin", vol, "tick");
    } else {
      ensureSpinSfxBuffer()
        .then((ok) => {
          if (ok && audio.buffers.has("spin")) {
            audio.playOneShot("spin", vol, "tick");
          } else {
            audio.playTick(vol, pitch);
          }
        })
        .catch(() => audio.playTick(vol, pitch));
    }
  },
  onLand: (section) => {
    stopSpinLoop();
    // Divert SFX only while the rig move is in progress
    audio.stopDivert();
    endRigDivertAudio();
    if (!state.sound.enabled || !section) return;
    // section may already be a display-resolved copy from the wheel
    const raw =
      state.sections.find((s) => s.id === section.id) || section;
    const eff =
      section.profileSource != null
        ? section
        : resolveSectionForDisplay(state, section);
    // Per-section volume (falls back to global land volume)
    const vol =
      raw.landSfxVolume != null && Number.isFinite(Number(raw.landSfxVolume))
        ? Math.min(1, Math.max(0, Number(raw.landSfxVolume)))
        : state.sound.landVolume ?? 0.4;
    if (eff.landSfxData) {
      // Group buffer when land SFX is inherited/forced from a group profile
      const sfxFromGroup =
        eff.profileFrom?.sfx?.source === "group" && eff.profileFrom.sfx.groupId;
      const key = sfxFromGroup
        ? `land_grp_${eff.profileFrom.sfx.groupId}`
        : `land_${eff.id}`;
      if (audio.buffers.has(key)) {
        audio.playOneShot(key, vol, "land");
      } else {
        audio.loadDataUrl(key, eff.landSfxData).then(() => {
          audio.playOneShot(key, vol, "land");
        });
      }
    } else {
      playGlobalLandSfx(vol);
    }
  },
});

// --- Persistence (multi-wheel library) ---
function persist() {
  library = writeActiveState(library, state);
  const ok = saveLibrary(library);
  if (!ok) {
    console.warn("Save failed — browser storage may be full");
  }
  updateUndoButton();
  fillWheelSelect();
}

function fillWheelSelect() {
  const sel = $("#wheel-select");
  if (!sel) return;
  const cur = library.activeId;
  sel.innerHTML = library.wheels
    .map((w) => {
      const label = escapeHtml(w.name || "Untitled");
      return `<option value="${w.id}"${w.id === cur ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const del = $("#btn-wheel-delete");
  if (del) del.disabled = library.wheels.length <= 1;
}

/** Stop spin/audio and load a different wheel slot into the UI. */
async function applyLoadedWheel(nextLib, nextState) {
  try {
    wheel.cancelAnimatedSpin?.();
  } catch {
    /* ignore */
  }
  audio.stopAll?.();
  audio.stopBgm?.();
  audio.stopDivert?.();
  stopSpinLoop?.();
  spinBusy = false;
  library = nextLib;
  state = nextState;
  undoStack.length = 0;
  lastWinnerId = null;
  hideResults();
  saveLibrary(library);
  fillWheelSelect();
  bindAll();
  updateSectionsCount();
  updateUndoButton();
  await preloadAudio();
  await refreshWheel();
  syncBgm();
}

async function switchToWheelId(id) {
  if (!id || id === library.activeId) return;
  // Save current wheel first
  library = writeActiveState(library, state);
  const result = switchActive(library, id);
  if (!result) return;
  await applyLoadedWheel(result.lib, result.state);
}

async function createNewWheel() {
  library = writeActiveState(library, state);
  const name = prompt("Name for the new wheel:", `Wheel ${library.wheels.length + 1}`);
  if (name === null) return; // cancelled
  const result = addWheel(library, name || undefined, null);
  await applyLoadedWheel(result.lib, result.state);
}

async function duplicateCurrentWheel() {
  library = writeActiveState(library, state);
  const result = duplicateWheel(library, library.activeId);
  if (!result) return;
  await applyLoadedWheel(result.lib, result.state);
}

function renameCurrentWheel() {
  const slot = getActiveSlot(library);
  const name = prompt("Rename wheel:", slot.name || "My wheel");
  if (name === null) return;
  library = writeActiveState(library, state);
  library = renameWheel(library, library.activeId, name);
  saveLibrary(library);
  fillWheelSelect();
}

async function deleteCurrentWheel() {
  if (library.wheels.length <= 1) {
    alert("You need at least one wheel.");
    return;
  }
  const slot = getActiveSlot(library);
  if (
    !confirm(
      `Delete wheel “${slot.name}”? This cannot be undone.\nYour other wheels stay saved.`
    )
  ) {
    return;
  }
  library = writeActiveState(library, state);
  const next = deleteWheel(library, library.activeId);
  if (!next) return;
  const result = switchActive(next, next.activeId);
  if (!result) return;
  await applyLoadedWheel(result.lib, result.state);
}

async function refreshWheel() {
  await wheel.setLook(state.look);
  // Resolved copies apply group profile override when enabled
  await wheel.setSections(getDisplaySections(state));
  wheel.draw();
}

/** Bundled default BGM when no custom music is uploaded. */
const DEFAULT_BGM = {
  url: "assets/music/bgm-default.mp3",
  name: "ANIMAL WELL — 01 ANIMAL WELL",
};

/** Bundled Mixkit default spin tick. */
const DEFAULT_SPIN_TICK = {
  url: "assets/sounds/tick-default.wav",
  name: "mixkit-short-bass-hit-2299.wav",
};

/** Bundled Victory land SFX (optional alternative to built-in chime). */
const LAND_VICTORY = {
  url: "assets/sounds/land-victory.mp3",
  name: "Victory",
};

/** @returns {"mixkit"|"synth"|"custom"} */
function getSpinTickPreset() {
  const p = state.sound?.spinTickPreset;
  if (p === "mixkit" || p === "synth" || p === "custom") return p;
  return state.sound?.spinSfxData ? "custom" : "synth";
}

function spinSfxDisplayName() {
  const preset = getSpinTickPreset();
  if (preset === "synth") return "Built-in beep (default)";
  if (preset === "custom") {
    if (state.sound?.spinSfxName) return state.sound.spinSfxName;
    if (state.sound?.spinSfxData) return "Custom tick";
    return "Custom file (none chosen)";
  }
  return DEFAULT_SPIN_TICK.name;
}

/**
 * Load spin buffer for mixkit/custom. Synth has no buffer (uses playTick).
 * @returns {Promise<boolean>} true if a sample buffer is ready
 */
async function ensureSpinSfxBuffer() {
  const preset = getSpinTickPreset();
  try {
    if (preset === "synth") {
      audio.buffers.delete("spin");
      return false;
    }
    if (preset === "custom" && state.sound?.spinSfxData) {
      await audio.loadDataUrl("spin", state.sound.spinSfxData);
      return true;
    }
    // mixkit (or custom without file → fall back to mixkit)
    await audio.loadUrl("spin", DEFAULT_SPIN_TICK.url);
    return true;
  } catch (err) {
    console.warn("Spin SFX load failed:", err);
    return false;
  }
}

function updateSpinTickPresetUI() {
  const preset = getSpinTickPreset();
  const sel = $("#spin-tick-preset");
  if (sel) sel.value = preset;
  const nameEl = $("#spin-sfx-name");
  if (nameEl) {
    nameEl.textContent =
      preset === "custom"
        ? state.sound?.spinSfxName ||
          (state.sound?.spinSfxData ? "Custom tick" : "No custom file chosen")
        : spinSfxDisplayName();
  }
  // File name + choose/clear only when Custom file is selected
  const row = $("#spin-sfx-custom-row");
  if (row) {
    if (preset === "custom") {
      row.hidden = false;
      row.style.display = "";
    } else {
      row.hidden = true;
      row.style.display = "none";
    }
  }
}

function bgmDisplayName() {
  if (state.sound?.bgmData && state.sound.bgmName) return state.sound.bgmName;
  if (state.sound?.bgmData) return "Custom music";
  return `${DEFAULT_BGM.name} (default)`;
}

/** Load custom BGM data URL or the bundled Animal Well track. */
async function ensureBgmBuffer() {
  try {
    if (state.sound?.bgmData) {
      await audio.loadDataUrl("bgm", state.sound.bgmData);
      return true;
    }
    await audio.loadUrl("bgm", DEFAULT_BGM.url);
    return true;
  } catch (err) {
    console.warn("BGM load failed:", err);
    return false;
  }
}

/**
 * Play the global land SFX (section/group did not supply one).
 * @param {number} vol
 * @param {boolean} [asPreview]
 */
function playGlobalLandSfx(vol, asPreview = false) {
  const preset = getLandSfxPreset();
  if (preset === "default") {
    audio.playLandDefault(vol, asPreview);
    return;
  }
  if (audio.buffers.has("land")) {
    audio.playOneShot("land", vol, "land", asPreview);
    return;
  }
  ensureLandSfxBuffer().then((ok) => {
    if (ok && audio.buffers.has("land")) {
      audio.playOneShot("land", vol, "land", asPreview);
    } else {
      audio.playLandDefault(vol, asPreview);
    }
  });
}

/** @returns {"default"|"victory"|"custom"} */
function getLandSfxPreset() {
  const p = state.sound?.landSfxPreset;
  if (p === "default" || p === "victory" || p === "custom") return p;
  return state.sound?.landSfxData ? "custom" : "default";
}

function landSfxDisplayName() {
  const preset = getLandSfxPreset();
  if (preset === "victory") return `${LAND_VICTORY.name}`;
  if (preset === "custom") {
    if (state.sound?.landSfxName) return state.sound.landSfxName;
    if (state.sound?.landSfxData) return "Custom land SFX";
    return "Custom file (none chosen)";
  }
  return "Built-in chime (default)";
}

/**
 * Load global land buffer for victory/custom. Default chime has no buffer.
 * @returns {Promise<boolean>} true if a sample buffer is ready
 */
async function ensureLandSfxBuffer() {
  const preset = getLandSfxPreset();
  try {
    if (preset === "default") {
      audio.buffers.delete("land");
      return false;
    }
    if (preset === "custom" && state.sound?.landSfxData) {
      await audio.loadDataUrl("land", state.sound.landSfxData);
      return true;
    }
    if (preset === "victory") {
      await audio.loadUrl("land", LAND_VICTORY.url);
      return true;
    }
    // custom without file → no buffer
    audio.buffers.delete("land");
    return false;
  } catch (err) {
    console.warn("Land SFX load failed:", err);
    return false;
  }
}

function updateLandSfxPresetUI() {
  const preset = getLandSfxPreset();
  const sel = $("#land-sfx-preset");
  if (sel) sel.value = preset;
  const nameEl = $("#land-sfx-name");
  if (nameEl) {
    nameEl.textContent =
      preset === "custom"
        ? state.sound?.landSfxName ||
          (state.sound?.landSfxData ? "Custom land SFX" : "No custom file chosen")
        : landSfxDisplayName();
  }
  const row = $("#land-sfx-custom-row");
  if (row) {
    if (preset === "custom") {
      row.hidden = false;
      row.style.display = "";
    } else {
      row.hidden = true;
      row.style.display = "none";
    }
  }
}

async function preloadAudio() {
  await ensureSpinSfxBuffer();
  await ensureLandSfxBuffer();
  await ensureBgmBuffer();
  for (const s of state.sections) {
    if (s.landSfxData) {
      await audio.loadDataUrl(`land_${s.id}`, s.landSfxData);
    }
  }
  for (const g of state.groups) {
    if (g.landSfxData) {
      await audio.loadDataUrl(`land_grp_${g.id}`, g.landSfxData);
    }
  }
}

/**
 * Keep continuous BGM in sync with settings (always mode).
 * Does not start spin-only BGM — that starts with a spin.
 */
function syncBgm() {
  if (!state.sound.enabled || state.sound.bgmMode === "off") {
    audio.stopBgm();
    return;
  }
  if (!audio.buffers.has("bgm")) {
    ensureBgmBuffer()
      .then((ok) => {
        if (ok) syncBgm();
      })
      .catch(() => {});
    return;
  }
  if (state.sound.bgmMode === "always") {
    if (!audio.isBgmPlaying) {
      audio.startBgm("bgm", state.sound.bgmVolume ?? 0.4);
    } else {
      audio.setBgmVolume(state.sound.bgmVolume ?? 0.4);
    }
  } else if (state.sound.bgmMode === "spin") {
    // Leave playing if mid-spin; stop if idle (caller stops after spin)
    if (!wheel.spinning && audio.isBgmPlaying) {
      audio.stopBgm();
    } else if (audio.isBgmPlaying) {
      audio.setBgmVolume(state.sound.bgmVolume ?? 0.4);
    }
  }
}

function startBgmForSpin() {
  if (!state.sound.enabled) return;
  if (state.sound.bgmMode !== "spin" && state.sound.bgmMode !== "always") return;
  if (!audio.buffers.has("bgm")) {
    ensureBgmBuffer()
      .then((ok) => {
        if (ok) startBgmForSpin();
      })
      .catch(() => {});
    return;
  }
  if (!audio.isBgmPlaying) {
    audio.startBgm("bgm", state.sound.bgmVolume ?? 0.4);
  } else {
    audio.setBgmVolume(state.sound.bgmVolume ?? 0.4);
  }
}

function stopBgmAfterSpin() {
  // Keep music if set to play always; stop if spin-only
  if (state.sound.bgmMode === "spin") {
    audio.stopBgm();
  }
}

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.hidden || tab.classList.contains("hidden")) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = $(`#tab-${tab.dataset.tab}`);
    if (panel) {
      panel.hidden = false;
      panel.classList.add("active");
    }
    if (tab.dataset.tab === "secret") {
      const sec = ensureSecretState();
      if ($("#secret-rig-it")) $("#secret-rig-it").checked = !!sec.rigIt;
      bindSecretRigKindFromState();
      fillSecretSectionSelect();
      fillSecretReverseSelects();
      if ($("#secret-reverse-rig-it")) {
        $("#secret-reverse-rig-it").checked = !!sec.reverseRigIt;
      }
      bindSecretDivertSfxUI();
      bindSecretReverseUI();
    }
  });
});

// --- Render sections list ---
function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name || "—";
}

function sectionGroupNames(section) {
  return getSectionGroupIds(section)
    .map((id) => groupName(id))
    .filter((n) => n && n !== "—");
}

/** Write multi-group membership; drop legacy singular groupId. Empty = ungrouped. */
function setSectionGroupIds(section, ids) {
  const valid = (ids || []).filter((id) => state.groups.some((g) => g.id === id));
  section.groupIds = valid;
  delete section.groupId;
}

/** Collect checked group ids from the section editor. */
function getCheckedSectionGroupIds() {
  return [...document.querySelectorAll(".section-group-check:checked")].map(
    (el) => el.value
  );
}

function setCheckedSectionGroupIds(ids) {
  const set = new Set(ids || []);
  document.querySelectorAll(".section-group-check").forEach((el) => {
    el.checked = set.has(el.value);
  });
}

function activeWeightTotal() {
  return (
    getActiveSections(state).reduce(
      (a, s) => a + normalizeWeight(s.weight),
      0
    ) || 1
  );
}

function sectionChancePct(section) {
  if (!isSectionActiveOnWheel(state, section)) return null;
  const w = normalizeWeight(section.weight);
  return ((w / activeWeightTotal()) * 100).toFixed(0);
}

/** Look-tab settings for the section-card weight range slider. */
function getWeightSliderOpts() {
  let min = Number(state.look?.weightSliderMin);
  let max = Number(state.look?.weightSliderMax);
  let step = Number(state.look?.weightSliderStep);
  if (!Number.isFinite(min) || min < 0.1) min = 1;
  if (!Number.isFinite(max) || max < 0.1) max = 20;
  if (!Number.isFinite(step) || step <= 0) step = 1;
  if (max < min) {
    const t = min;
    min = max;
    max = t;
  }
  // Keep step from exceeding range
  if (step > max - min && max > min) step = max - min;
  if (step <= 0) step = 1;
  return { min, max, step };
}

/** Snap a value to slider step between min/max (for the range control only). */
function snapWeightSliderValue(raw, opts = getWeightSliderOpts()) {
  const { min, max, step } = opts;
  let v = Number(raw);
  if (!Number.isFinite(v)) v = min;
  // Snap to nearest step from min
  const steps = Math.round((v - min) / step);
  v = min + steps * step;
  // Avoid float noise
  const decimals = String(step).includes(".")
    ? Math.min(6, (String(step).split(".")[1] || "").length)
    : 0;
  if (decimals > 0) v = Number(v.toFixed(decimals));
  else v = Math.round(v);
  return Math.min(max, Math.max(min, v));
}

function getFilteredSections() {
  const q = sectionSearchQuery.trim().toLowerCase();
  if (!q) return state.sections.slice();
  return state.sections.filter((s) => {
    const labels = sectionGroupNames(s).join(" ").toLowerCase();
    const label = String(s.label || "").toLowerCase();
    return label.includes(q) || labels.includes(q);
  });
}

function cmpLabel(a, b) {
  return String(a.label || "").localeCompare(String(b.label || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

/**
 * Sort a section list for display only (does not mutate state.sections).
 * @param {object[]} list
 */
function sortSectionsList(list) {
  const arr = list.slice();
  const mode = sectionSortMode || "manual";
  if (mode === "manual") return arr;

  arr.sort((a, b) => {
    switch (mode) {
      case "name-asc":
        return cmpLabel(a, b);
      case "name-desc":
        return cmpLabel(b, a);
      case "weight-desc": {
        const d = normalizeWeight(b.weight) - normalizeWeight(a.weight);
        return d !== 0 ? d : cmpLabel(a, b);
      }
      case "weight-asc": {
        const d = normalizeWeight(a.weight) - normalizeWeight(b.weight);
        return d !== 0 ? d : cmpLabel(a, b);
      }
      case "group": {
        const ga = sectionGroupNames(a).join(", ") || "\uffff";
        const gb = sectionGroupNames(b).join(", ") || "\uffff";
        const g = ga.localeCompare(gb, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        return g !== 0 ? g : cmpLabel(a, b);
      }
      case "on-wheel": {
        const aa = isSectionActiveOnWheel(state, a) ? 0 : 1;
        const bb = isSectionActiveOnWheel(state, b) ? 0 : 1;
        if (aa !== bb) return aa - bb;
        return cmpLabel(a, b);
      }
      case "enabled": {
        const aa = a.enabled === false ? 1 : 0;
        const bb = b.enabled === false ? 1 : 0;
        if (aa !== bb) return aa - bb;
        return cmpLabel(a, b);
      }
      case "has-image": {
        const ia = resolveSectionForDisplay(state, a).imageData ? 0 : 1;
        const ib = resolveSectionForDisplay(state, b).imageData ? 0 : 1;
        if (ia !== ib) return ia - ib;
        return cmpLabel(a, b);
      }
      default:
        return 0;
    }
  });
  return arr;
}

function updateSectionsCount() {
  // Always total sections in the project (not filtered / on-wheel only)
  const n = Array.isArray(state.sections) ? state.sections.length : 0;
  const text = n === 1 ? "1 section" : `${n} sections`;
  const el =
    document.getElementById("sections-count") || $("#sections-count");
  if (el) {
    el.textContent = text;
    el.title = text;
    el.setAttribute("data-count", String(n));
  }
}

function renderSections() {
  updateSectionsCount();
  if (!state.sections.length) {
    sectionsList.innerHTML = `<div class="empty-state">No sections yet. Add one to get started.</div>`;
    if (sectionSearchMeta) {
      sectionSearchMeta.classList.remove("hidden");
      sectionSearchMeta.textContent = "0 sections";
    }
    return;
  }

  const filtered = sortSectionsList(getFilteredSections());
  const q = sectionSearchQuery.trim();
  const total = state.sections.length;
  if (sectionSearchMeta) {
    sectionSearchMeta.classList.remove("hidden");
    if (q) {
      sectionSearchMeta.textContent =
        filtered.length === 0
          ? `No matches for “${q}” (of ${total})`
          : `Showing ${filtered.length} of ${total} sections`;
    } else {
      sectionSearchMeta.textContent = `${total} section${total === 1 ? "" : "s"}`;
    }
  }

  if (!filtered.length) {
    sectionsList.innerHTML = `<div class="empty-state">No sections match your search.</div>`;
    return;
  }

  const ws = getWeightSliderOpts();
  sectionsList.innerHTML = filtered
    .map((s) => {
      const ctrl = controllingGroup(state, s);
      const inactiveGroup = ctrl ? !ctrl.active : true;
      const off = !isSectionActiveOnWheel(state, s);
      const w = normalizeWeight(s.weight);
      const pct = sectionChancePct(s);
      const gNames = sectionGroupNames(s);
      const disp = resolveSectionForDisplay(state, s);
      const groupsBadge = gNames.length
        ? gNames.length === 1
          ? gNames[0]
          : `${gNames.join(", ")} (ctrl: ${ctrl?.name || "—"})`
        : "no group";
      const fromBits = [];
      if (disp.profileFrom?.image?.source === "group") fromBits.push("img←grp");
      if (disp.profileFrom?.sfx?.source === "group") fromBits.push("sfx←grp");
      if (disp.profileFrom?.color?.source === "group") fromBits.push("color←grp");
      const badges = [
        groupsBadge,
        fromBits.length ? fromBits.join(" · ") : "",
        disp.imageData
          ? disp.imageMode === "tile"
            ? "🖼 tile"
            : "🖼 fill"
          : "",
        disp.landSfxData ? "🔊" : "",
        !s.enabled ? "off" : inactiveGroup ? `group off (${ctrl?.name || "?"})` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const bg = disp.imageData
        ? `background-image:url(${disp.imageData});background-color:${disp.color}`
        : `background:${disp.color}`;
      return `
        <div class="section-card ${off ? "disabled-card" : ""}" data-id="${s.id}">
          <div class="section-card-top">
            <div class="swatch" style="${bg}"></div>
            <div class="section-meta">
              <strong>${escapeHtml(s.label)}</strong>
              <small>${escapeHtml(badges)}</small>
            </div>
            <div class="card-actions">
              <button type="button" class="icon-btn" data-act="toggle" title="Toggle on/off">${s.enabled ? "👁" : "🚫"}</button>
              <button type="button" class="icon-btn" data-act="edit" title="Edit">✎</button>
              <button type="button" class="icon-btn" data-act="dup" title="Duplicate section">Dup</button>
              <button type="button" class="icon-btn danger" data-act="del" title="Delete">✕</button>
            </div>
          </div>
          <div class="section-weight-row">
            <span class="weight-field-label">Weight</span>
            <input type="range" class="section-weight-range" min="${ws.min}" max="${ws.max}" step="${ws.step}" value="${snapWeightSliderValue(w, ws)}" title="Weight (slider)" />
            <input type="number" class="section-weight-num" min="0.1" max="1000" step="any" value="${formatWeight(w)}" title="Weight (decimals ok, e.g. 1.22)" />
            <span class="section-weight-pct" title="Chance on wheel">${pct == null ? "—" : pct + "%"}</span>
          </div>
        </div>`;
    })
    .join("");
}

/** Update % labels on section cards without full re-render (keeps slider focus). */
function updateSectionChanceLabels() {
  sectionsList.querySelectorAll(".section-card").forEach((card) => {
    const section = state.sections.find((s) => s.id === card.dataset.id);
    if (!section) return;
    const pctEl = card.querySelector(".section-weight-pct");
    if (!pctEl) return;
    const pct = sectionChancePct(section);
    pctEl.textContent = pct == null ? "—" : `${pct}%`;
  });
}

function renderGroups() {
  // Don't clobber the list mid phone-style drag
  if (groupDrag.active || groupDrag.pending) return;
  if (!state.groups.length) {
    groupsList.innerHTML = `<div class="empty-state">No groups. Add one, then assign sections to it.</div>`;
    return;
  }
  groupsList.innerHTML = state.groups
    .map((g, index) => {
      const count = state.sections.filter((s) => sectionInGroup(s, g.id)).length;
      const activeCount = state.sections.filter(
        (s) => sectionInGroup(s, g.id) && s.enabled
      ).length;
      const isTop = index === 0;
      const ovParts = [
        g.overrideColor ? "slice" : "",
        g.overrideTextColor ? "text" : "",
        g.overrideWinnerTextColor ? "win" : "",
        g.overrideImage ? "img" : "",
        g.overrideSfx ? "sfx" : "",
      ].filter(Boolean);
      const profileBits = [
        ovParts.length ? `override: ${ovParts.join("+")}` : "",
        g.imageData ? "🖼" : "",
        g.landSfxData ? "🔊" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const swatchBg = g.imageData
        ? `background-image:url(${g.imageData});background-color:${g.color || "#3ecf8e"}`
        : `background:${g.active ? g.color || "#3ecf8e" : "#555"}`;
      return `
        <div class="group-card ${g.active ? "" : "inactive-card"} ${groupHasAnyOverride(g) ? "group-override-on" : ""}" data-id="${g.id}">
          <div class="group-drag-handle" title="Drag to reorder" aria-label="Drag to reorder" role="button">
            <span class="drag-grip" aria-hidden="true"></span>
          </div>
          <span class="group-priority" title="Priority (1 = highest)">#${index + 1}</span>
          <div class="swatch" style="${swatchBg}"></div>
          <div class="group-meta">
            <strong>${escapeHtml(g.name)}</strong>
            <small>${activeCount}/${count} sections · ${g.active ? "ACTIVE" : "OFF"}${isTop ? " · highest" : ""}${profileBits ? ` · ${profileBits}` : ""}</small>
          </div>
          <div class="card-actions">
            <button type="button" class="icon-btn" data-act="toggle" title="Toggle group">${g.active ? "✓" : "○"}</button>
            <button type="button" class="icon-btn" data-act="rename" title="Edit">✎</button>
            <button type="button" class="icon-btn" data-act="dup" title="Duplicate group">Dup</button>
            <button type="button" class="icon-btn danger" data-act="del" title="Delete">✕</button>
          </div>
        </div>`;
    })
    .join("");
  updateGroupPriorityLabels();
}

/** Deep-clone a plain section for duplicate (avoids JSON failures / odd fields). */
function cloneSectionForDuplicate(section) {
  const gids = getSectionGroupIds(section);
  const raw = {
    id: uid("sec"),
    label: `${section.label || "Untitled"} copy`,
    weight: normalizeWeight(section.weight),
    enabled: section.enabled !== false,
    groupIds: gids.slice(),
    customColor: section.customColor === true,
    customTextColor: section.customTextColor === true,
    customWinnerTextColor: section.customWinnerTextColor === true,
    customImage: section.customImage === true,
    customSfx: section.customSfx === true,
    color: section.color,
    textColor: section.textColor,
    winnerTextColor: section.winnerTextColor,
    imageData: section.imageData || null,
    imageMode: section.imageMode === "tile" ? "tile" : "fill",
    imageFillScale: section.imageFillScale,
    imageFillOffsetX: section.imageFillOffsetX,
    imageFillOffsetY: section.imageFillOffsetY,
    imageTileScale: section.imageTileScale,
    imageTileOffsetX: section.imageTileOffsetX,
    imageTileOffsetY: section.imageTileOffsetY,
    landSfxData: section.landSfxData || null,
    landSfxName: section.landSfxName || null,
    landSfxVolume: section.landSfxVolume,
  };
  return raw;
}

/** Clone a group profile with a new id/name. */
function cloneGroupForDuplicate(group) {
  const newId = uid("grp");
  return normalizeGroup({
    id: newId,
    name: `${group.name || "Group"} copy`,
    active: group.active !== false,
    overrideColor: group.overrideColor === true,
    overrideTextColor: group.overrideTextColor === true,
    overrideWinnerTextColor: group.overrideWinnerTextColor === true,
    overrideImage: group.overrideImage === true,
    overrideSfx: group.overrideSfx === true,
    color: group.color,
    textColor: group.textColor,
    winnerTextColor: group.winnerTextColor,
    imageData: group.imageData || null,
    imageMode: group.imageMode,
    imageFillScale: group.imageFillScale,
    imageFillOffsetX: group.imageFillOffsetX,
    imageFillOffsetY: group.imageFillOffsetY,
    imageTileScale: group.imageTileScale,
    imageTileOffsetX: group.imageTileOffsetX,
    imageTileOffsetY: group.imageTileOffsetY,
    landSfxData: group.landSfxData || null,
    landSfxName: group.landSfxName || null,
  });
}

/** Live priority numbers while dragging / after paint */
function updateGroupPriorityLabels() {
  const cards = [...groupsList.querySelectorAll(".group-card")];
  // Visual order: original index + shift → final order
  if (groupDrag.active && groupDrag.fromIndex >= 0) {
    const n = cards.length;
    const order = [];
    for (let i = 0; i < n; i++) {
      if (i !== groupDrag.fromIndex) order.push(i);
    }
    order.splice(groupDrag.insertIndex, 0, groupDrag.fromIndex);
    const rank = new Array(n);
    order.forEach((orig, final) => {
      rank[orig] = final + 1;
    });
    cards.forEach((card, i) => {
      const el = card.querySelector(".group-priority");
      if (el) el.textContent = `#${rank[i] ?? i + 1}`;
    });
    return;
  }
  cards.forEach((card, i) => {
    const el = card.querySelector(".group-priority");
    if (el) el.textContent = `#${i + 1}`;
  });
}

/**
 * Phone-style drag reorder for groups.
 * Floating ghost + live FLIP shifts so neighbors slide out of the way.
 */
const groupDrag = {
  pending: false,
  active: false,
  pointerId: null,
  fromId: null,
  fromIndex: -1,
  /** Insert index in the list *without* the dragged item (0..n-1) */
  insertIndex: 0,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0,
  stride: 0,
  card: null,
  ghost: null,
  /** @type {{ el: HTMLElement, id: string, index: number, mid: number }[]} */
  layout: [],
  didDrag: false,
};

function getGroupCards() {
  return [...groupsList.querySelectorAll(".group-card")];
}

function clearGroupDragTransforms() {
  getGroupCards().forEach((c) => {
    c.style.transform = "";
    c.style.transition = "";
    c.classList.remove(
      "is-drag-source",
      "is-slot-open",
      "group-drag-settling"
    );
  });
  groupsList.classList.remove("is-reordering");
}

function applyGroupLiveShifts() {
  const from = groupDrag.fromIndex;
  const insert = groupDrag.insertIndex;
  const stride = groupDrag.stride;
  getGroupCards().forEach((card, i) => {
    if (i === from) {
      card.style.transform = "none";
      return;
    }
    // Index among remaining items after removing `from`
    const without = i > from ? i - 1 : i;
    // Final index after inserting dragged at `insert`
    const final = without >= insert ? without + 1 : without;
    const shift = (final - i) * stride;
    card.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "translate3d(0,0,0)";
  });
  updateGroupPriorityLabels();
}

/** insertIndex in remaining-items list from pointer Y */
function groupInsertIndexFromY(clientY) {
  const from = groupDrag.fromIndex;
  let insert = 0;
  groupDrag.layout.forEach((l, i) => {
    if (i === from) return;
    if (clientY > l.mid) insert += 1;
  });
  return insert;
}

function moveGroupGhost(clientX, clientY) {
  if (!groupDrag.ghost) return;
  const x = clientX - groupDrag.offsetX;
  const y = clientY - groupDrag.offsetY;
  groupDrag.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.04) rotate(-0.6deg)`;
}

function startGroupDrag(card, e) {
  const cards = getGroupCards();
  const fromIndex = cards.indexOf(card);
  if (fromIndex < 0) return;

  const rect = card.getBoundingClientRect();
  groupDrag.active = true;
  groupDrag.pending = false;
  groupDrag.didDrag = true;
  groupDrag.fromId = card.dataset.id;
  groupDrag.fromIndex = fromIndex;
  groupDrag.card = card;
  groupDrag.pointerId = e.pointerId;
  groupDrag.offsetX = e.clientX - rect.left;
  groupDrag.offsetY = e.clientY - rect.top;

  const gap =
    cards.length > 1
      ? Math.max(
          0,
          cards[1].getBoundingClientRect().top -
            cards[0].getBoundingClientRect().bottom
        )
      : 8;
  groupDrag.stride = rect.height + gap;

  groupDrag.layout = cards.map((el, index) => {
    const r = el.getBoundingClientRect();
    return {
      el,
      id: el.dataset.id,
      index,
      mid: r.top + r.height / 2,
    };
  });
  groupDrag.insertIndex = groupInsertIndexFromY(e.clientY);

  // Floating ghost (clone)
  const ghost = card.cloneNode(true);
  ghost.classList.add("group-drag-ghost");
  ghost.classList.remove("is-drag-source");
  ghost.removeAttribute("data-id");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = "0";
  ghost.style.top = "0";
  document.body.appendChild(ghost);
  groupDrag.ghost = ghost;
  moveGroupGhost(e.clientX, e.clientY);

  // Source becomes empty slot
  groupsList.classList.add("is-reordering");
  card.classList.add("is-drag-source");
  // Enable transitions on siblings for slide-apart
  cards.forEach((c) => {
    if (c !== card) {
      c.style.transition =
        "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
    }
  });
  applyGroupLiveShifts();

  try {
    card.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.body.classList.add("group-drag-cursor");
}

function endGroupDrag(commit) {
  if (!groupDrag.active && !groupDrag.pending) {
    resetGroupDragState();
    return;
  }
  const fromIndex = groupDrag.fromIndex;
  const insertIndex = groupDrag.insertIndex;
  const ghost = groupDrag.ghost;

  if (ghost) {
    ghost.classList.add("group-drag-ghost-exit");
    const g = ghost;
    setTimeout(() => g.remove(), 180);
  }

  if (commit && fromIndex >= 0) {
    const next = state.groups.slice();
    const [item] = next.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(insertIndex, next.length));
    next.splice(clamped, 0, item);
    const changed = !next.every((g, i) => g.id === state.groups[i]?.id);
    if (changed) {
      checkpoint();
      state.groups = next;
      persist();
    }
  }

  clearGroupDragTransforms();
  resetGroupDragState();
  document.body.classList.remove("group-drag-cursor");
  renderGroups();
  renderSections();
  refreshWheel();
}

function resetGroupDragState() {
  groupDrag.pending = false;
  groupDrag.active = false;
  groupDrag.pointerId = null;
  groupDrag.fromId = null;
  groupDrag.fromIndex = -1;
  groupDrag.insertIndex = 0;
  groupDrag.card = null;
  groupDrag.ghost = null;
  groupDrag.layout = [];
  // keep didDrag until next pointerdown
}

function finishGroupDragClickGuard() {
  if (!groupDrag.didDrag) return;
  const block = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    groupsList.removeEventListener("click", block, true);
    groupDrag.didDrag = false;
  };
  groupsList.addEventListener("click", block, true);
  // safety clear
  setTimeout(() => {
    groupsList.removeEventListener("click", block, true);
    groupDrag.didDrag = false;
  }, 40);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Section list events ---
sectionsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const card = btn.closest(".section-card");
  const id = card?.dataset.id;
  const section = state.sections.find((s) => s.id === id);
  if (!section) return;
  const act = btn.dataset.act;
  try {
    if (act === "toggle") {
      checkpoint();
      section.enabled = !section.enabled;
      persist();
      renderSections();
      await refreshWheel();
    } else if (act === "edit") {
      openSectionModal(section);
    } else if (act === "dup") {
      checkpoint();
      const idx = state.sections.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const copy = cloneSectionForDuplicate(section);
      state.sections.splice(idx + 1, 0, copy);
      if (copy.landSfxData) {
        try {
          await audio.loadDataUrl(`land_${copy.id}`, copy.landSfxData);
        } catch (err) {
          console.warn("Dup section SFX load:", err);
        }
      }
      persist();
      renderSections();
      updateSectionsCount();
      await refreshWheel();
    } else if (act === "del") {
      // No confirm — Undo restores the section
      checkpoint();
      state.sections = state.sections.filter((s) => s.id !== id);
      if (lastWinnerId === id) {
        lastWinnerId = null;
        hideResults();
      }
      persist();
      renderSections();
      await refreshWheel();
    }
  } catch (err) {
    console.error("Section action failed:", act, err);
    alert("Couldn't complete that action: " + (err.message || err));
  }
});

// Weights on Sections tab (live, no need to open edit modal)
sectionsList.addEventListener("input", async (e) => {
  const card = e.target.closest(".section-card");
  if (!card) return;
  const section = state.sections.find((s) => s.id === card.dataset.id);
  if (!section) return;

  if (e.target.classList.contains("section-weight-range")) {
    checkpointContinuous();
    const opts = getWeightSliderOpts();
    const v = snapWeightSliderValue(e.target.value, opts);
    section.weight = v;
    e.target.value = String(v);
    const num = card.querySelector(".section-weight-num");
    if (num) num.value = formatWeight(v);
  } else if (e.target.classList.contains("section-weight-num")) {
    checkpointContinuous();
    // Manual field: decimals allowed (e.g. 1.22)
    const v = normalizeWeight(e.target.value);
    section.weight = v;
    if (e.target.value !== "" && Number.isFinite(Number(e.target.value))) {
      const raw = Number(e.target.value);
      if (raw < 0.1 || raw > 1000) e.target.value = formatWeight(v);
    }
    const range = card.querySelector(".section-weight-range");
    // Slider shows nearest step without forcing the typed decimal until moved
    if (range) range.value = String(snapWeightSliderValue(v));
  } else {
    return;
  }

  updateSectionChanceLabels();
  persist();
  await refreshWheel();
});

sectionsList.addEventListener("change", (e) => {
  if (
    e.target.classList.contains("section-weight-range") ||
    e.target.classList.contains("section-weight-num")
  ) {
    if (e.target.classList.contains("section-weight-num")) {
      const card = e.target.closest(".section-card");
      const section = state.sections.find((s) => s.id === card?.dataset.id);
      if (section) {
        section.weight = normalizeWeight(e.target.value);
        e.target.value = formatWeight(section.weight);
        const range = card.querySelector(".section-weight-range");
        if (range) range.value = String(snapWeightSliderValue(section.weight));
        updateSectionChanceLabels();
        persist();
        refreshWheel();
      }
    }
    endContinuous();
  }
});

sectionsList.addEventListener("pointerup", (e) => {
  if (e.target.classList.contains("section-weight-range")) endContinuous();
});

groupsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  // Cancel any pending group-drag so it doesn't swallow the click
  groupDrag.pending = false;
  groupDrag.didDrag = false;
  const card = btn.closest(".group-card");
  const id = card?.dataset.id;
  const group = state.groups.find((g) => g.id === id);
  if (!group) return;
  const act = btn.dataset.act;

  try {
    if (act === "toggle") {
      checkpoint();
      group.active = !group.active;
      persist();
      renderGroups();
      renderSections();
      await refreshWheel();
    } else if (act === "rename") {
      openGroupModal(group);
    } else if (act === "dup") {
      checkpoint();
      const idx = state.groups.findIndex((g) => g.id === id);
      if (idx < 0) return;
      const copy = cloneGroupForDuplicate(group);
      const newId = copy.id;
      state.groups.splice(idx + 1, 0, copy);
      // Same membership as the original group
      for (const s of state.sections) {
        const ids = getSectionGroupIds(s);
        if (ids.includes(id) && !ids.includes(newId)) {
          setSectionGroupIds(s, [...ids, newId]);
        }
      }
      if (copy.landSfxData) {
        try {
          await audio.loadDataUrl(`land_grp_${copy.id}`, copy.landSfxData);
        } catch (err) {
          console.warn("Dup group SFX load:", err);
        }
      }
      persist();
      renderGroups();
      renderSections();
      await refreshWheel();
    } else if (act === "del") {
      if (state.groups.length <= 1) {
        alert("You need at least one group.");
        return;
      }
      // No confirm — Undo restores the group
      checkpoint();
      // Only strip this group id — do not reassign to another / top group
      state.sections.forEach((s) => {
        s.groupIds = getSectionGroupIds(s).filter((gid) => gid !== id);
        delete s.groupId;
      });
      state.groups = state.groups.filter((g) => g.id !== id);
      persist();
      renderGroups();
      renderSections();
      await refreshWheel();
    }
  } catch (err) {
    console.error("Group action failed:", act, err);
    alert("Couldn't complete that action: " + (err.message || err));
  }
});

// --- Group phone-style drag reorder (live slide + floating ghost) ---
const GROUP_DRAG_THRESHOLD = 6;

groupsList.addEventListener("pointerdown", (e) => {
  if (e.button != null && e.button !== 0) return;
  if (e.target.closest("button, [data-act], a, input, select, textarea, label")) {
    return;
  }
  const card = e.target.closest(".group-card");
  if (!card || !groupsList.contains(card)) return;
  if (state.groups.length < 2) return;

  groupDrag.pending = true;
  groupDrag.didDrag = false;
  groupDrag.card = card;
  groupDrag.fromId = card.dataset.id;
  groupDrag.pointerId = e.pointerId;
  groupDrag.startX = e.clientX;
  groupDrag.startY = e.clientY;
});

function handleGroupDragMove(e) {
  if (!groupDrag.active && !groupDrag.pending) return;
  if (groupDrag.pointerId != null && e.pointerId !== groupDrag.pointerId) return;

  if (groupDrag.pending && !groupDrag.active) {
    const dx = e.clientX - groupDrag.startX;
    const dy = e.clientY - groupDrag.startY;
    if (Math.hypot(dx, dy) < GROUP_DRAG_THRESHOLD) return;
    if (!groupDrag.card) return;
    e.preventDefault();
    startGroupDrag(groupDrag.card, e);
  }

  if (!groupDrag.active) return;
  e.preventDefault();
  moveGroupGhost(e.clientX, e.clientY);
  const nextInsert = groupInsertIndexFromY(e.clientY);
  if (nextInsert !== groupDrag.insertIndex) {
    groupDrag.insertIndex = nextInsert;
    applyGroupLiveShifts();
  }
}

function handleGroupDragEnd(e, commit) {
  if (!groupDrag.active && !groupDrag.pending) return;
  if (
    e &&
    groupDrag.pointerId != null &&
    e.pointerId !== groupDrag.pointerId
  ) {
    return;
  }
  if (groupDrag.active) {
    if (e) e.preventDefault();
    endGroupDrag(commit);
    finishGroupDragClickGuard();
  } else {
    resetGroupDragState();
    groupDrag.didDrag = false;
  }
}

window.addEventListener("pointermove", handleGroupDragMove, { passive: false });
window.addEventListener("pointerup", (e) => handleGroupDragEnd(e, true));
window.addEventListener("pointercancel", (e) => handleGroupDragEnd(e, false));

$("#btn-add-section").addEventListener("click", () => {
  openSectionModal(null);
});

async function setAllSectionsEnabled(enabled) {
  if (!state.sections.length) return;
  const next = !!enabled;
  const anyChange = state.sections.some((s) => s.enabled !== next);
  if (!anyChange) return;
  checkpoint();
  for (const s of state.sections) {
    s.enabled = next;
  }
  persist();
  renderSections();
  await refreshWheel();
}

$("#btn-enable-all-sections")?.addEventListener("click", () => {
  setAllSectionsEnabled(true);
});

$("#btn-disable-all-sections")?.addEventListener("click", () => {
  setAllSectionsEnabled(false);
});

$("#btn-add-group").addEventListener("click", () => {
  openGroupModal(null);
});

// --- Group modal (add / edit + manage sections + profile) ---
/** @type {Set<string>} section ids that will belong to the group on save */
let pendingGroupMemberIds = new Set();
let groupMemberSearchQuery = "";
/** @type {string|null} */
let pendingGroupImage = null;
/** @type {string|null} */
let pendingGroupSfx = null;
/** @type {string|null} */
let pendingGroupSfxName = null;

function updateGroupImageModeUI() {
  const mode = $("#group-image-mode")?.value || "fill";
  const isTile = mode === "tile";
  const fillOpts = $("#group-fill-options");
  const tileScale = $("#group-tile-scale-field");
  const tileOx = $("#group-tile-offset-x-field");
  const tileOy = $("#group-tile-offset-y-field");
  if (fillOpts) fillOpts.style.display = isTile ? "none" : "";
  if (tileScale) tileScale.style.display = isTile ? "" : "none";
  if (tileOx) tileOx.style.display = isTile ? "" : "none";
  if (tileOy) tileOy.style.display = isTile ? "" : "none";
}

function setGroupProfileSliderLabels() {
  const fillScale = Number($("#group-fill-scale")?.value) || 1;
  const fox = Number($("#group-fill-offset-x")?.value) || 0;
  const foy = Number($("#group-fill-offset-y")?.value) || 0;
  const tileScale = Number($("#group-tile-scale")?.value) || 1;
  const ox = Number($("#group-tile-offset-x")?.value) || 0;
  const oy = Number($("#group-tile-offset-y")?.value) || 0;
  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  set("#group-fill-scale-label", `${Math.round(fillScale * 100)}%`);
  set("#group-fill-offset-x-label", `${Math.round(fox)}%`);
  set("#group-fill-offset-y-label", `${Math.round(foy)}%`);
  set("#group-tile-scale-label", `${Math.round(tileScale * 100)}%`);
  set("#group-tile-offset-x-label", `${Math.round(ox)}%`);
  set("#group-tile-offset-y-label", `${Math.round(oy)}%`);
}

/** Read profile fields currently shown in the group modal. */
function readGroupProfileFromForm() {
  return normalizeProfileFields({
    color: $("#group-color")?.value || "#4a6cf7",
    textColor: $("#group-text-color")?.value || "#ffffff",
    winnerTextColor:
      $("#group-winner-text-color")?.value ||
      state.look?.winnerTextColor ||
      "#ffffff",
    imageData: pendingGroupImage,
    imageMode: $("#group-image-mode")?.value === "tile" ? "tile" : "fill",
    imageFillScale: Number($("#group-fill-scale")?.value) || 1,
    imageFillOffsetX: Number($("#group-fill-offset-x")?.value) || 0,
    imageFillOffsetY: Number($("#group-fill-offset-y")?.value) || 0,
    imageTileScale: Number($("#group-tile-scale")?.value) || 1,
    imageTileOffsetX: Number($("#group-tile-offset-x")?.value) || 0,
    imageTileOffsetY: Number($("#group-tile-offset-y")?.value) || 0,
    landSfxData: pendingGroupSfx,
    landSfxName: pendingGroupSfxName,
  });
}

function readOverridePartsFromForm() {
  return {
    overrideColor: $("#group-override-color")?.checked === true,
    overrideTextColor: $("#group-override-text-color")?.checked === true,
    overrideWinnerTextColor:
      $("#group-override-winner-text-color")?.checked === true,
    overrideImage: $("#group-override-image")?.checked === true,
    overrideSfx: $("#group-override-sfx")?.checked === true,
  };
}

function readApplyPartsFromForm() {
  return {
    color: $("#group-apply-color")?.checked === true,
    textColor: $("#group-apply-text-color")?.checked === true,
    winnerTextColor: $("#group-apply-winner-text-color")?.checked === true,
    image: $("#group-apply-image")?.checked === true,
    sfx: $("#group-apply-sfx")?.checked === true,
  };
}

function fillGroupProfileForm(group) {
  const g = group ? normalizeGroup(group) : normalizeGroup({});
  if ($("#group-override-color")) {
    $("#group-override-color").checked = g.overrideColor === true;
  }
  if ($("#group-override-text-color")) {
    $("#group-override-text-color").checked = g.overrideTextColor === true;
  }
  if ($("#group-override-winner-text-color")) {
    $("#group-override-winner-text-color").checked =
      g.overrideWinnerTextColor === true;
  }
  if ($("#group-override-image")) {
    $("#group-override-image").checked = g.overrideImage === true;
  }
  if ($("#group-override-sfx")) {
    $("#group-override-sfx").checked = g.overrideSfx === true;
  }
  // Apply chips: default image+color+text on, SFX off (so you don't wipe audio by accident)
  if ($("#group-apply-color")) $("#group-apply-color").checked = true;
  if ($("#group-apply-text-color")) $("#group-apply-text-color").checked = true;
  if ($("#group-apply-winner-text-color")) {
    $("#group-apply-winner-text-color").checked = true;
  }
  if ($("#group-apply-image")) $("#group-apply-image").checked = true;
  if ($("#group-apply-sfx")) $("#group-apply-sfx").checked = false;
  $("#group-color").value = g.color || "#4a6cf7";
  if ($("#group-text-color")) {
    $("#group-text-color").value = g.textColor || "#ffffff";
  }
  if ($("#group-winner-text-color")) {
    $("#group-winner-text-color").value =
      g.winnerTextColor ||
      state.look?.winnerTextColor ||
      g.textColor ||
      "#ffffff";
  }
  pendingGroupImage = g.imageData || null;
  pendingGroupSfx = g.landSfxData || null;
  pendingGroupSfxName = g.landSfxName || null;
  $("#group-image-mode").value = g.imageMode === "tile" ? "tile" : "fill";
  $("#group-fill-scale").value = g.imageFillScale ?? 1;
  $("#group-fill-offset-x").value = g.imageFillOffsetX ?? 0;
  $("#group-fill-offset-y").value = g.imageFillOffsetY ?? 0;
  $("#group-tile-scale").value = g.imageTileScale ?? 1;
  $("#group-tile-offset-x").value = g.imageTileOffsetX ?? 0;
  $("#group-tile-offset-y").value = g.imageTileOffsetY ?? 0;
  setImgPreview($("#group-img-preview"), pendingGroupImage);
  updateGroupSfxPresetUI();
  setGroupProfileSliderLabels();
  updateGroupImageModeUI();
  if ($("#group-preview-weight-mode")) {
    $("#group-preview-weight-mode").value = "custom";
  }
  if ($("#group-preview-custom-weight")) {
    $("#group-preview-custom-weight").value = "100";
  }
  syncPreviewWeightValueControls("group-preview", 1);
  updateGroupPreviewWeightUI();
}

function openGroupModal(group) {
  $("#group-modal-title").textContent = group ? "Edit group" : "Add group";
  $("#group-edit-id").value = group?.id || "";
  $("#group-name").value = group?.name || `Group ${state.groups.length + 1}`;
  $("#group-active").checked = group ? group.active !== false : true;
  groupMemberSearchQuery = "";
  const searchEl = $("#group-member-search");
  if (searchEl) searchEl.value = "";

  if (group) {
    pendingGroupMemberIds = new Set(
      state.sections.filter((s) => sectionInGroup(s, group.id)).map((s) => s.id)
    );
  } else {
    pendingGroupMemberIds = new Set();
  }
  fillGroupProfileForm(group);
  renderGroupMembers();
  groupModal.showModal();
  requestAnimationFrame(() => {
    const input = $("#group-name");
    input.focus();
    input.select();
    updateGroupLivePreview();
    requestAnimationFrame(updateGroupLivePreview);
  });
}

function renderGroupMembers() {
  const inList = $("#group-members-in");
  const outList = $("#group-members-out");
  if (!inList || !outList) return;

  const editingId = $("#group-edit-id")?.value || "";
  const q = groupMemberSearchQuery.trim().toLowerCase();
  const matches = (s) => {
    if (!q) return true;
    return String(s.label || "")
      .toLowerCase()
      .includes(q);
  };

  const inMembers = state.sections.filter(
    (s) => pendingGroupMemberIds.has(s.id) && matches(s)
  );
  const outMembers = state.sections.filter(
    (s) => !pendingGroupMemberIds.has(s.id) && matches(s)
  );

  $("#group-in-count").textContent = String(
    state.sections.filter((s) => pendingGroupMemberIds.has(s.id)).length
  );
  $("#group-out-count").textContent = String(
    state.sections.filter((s) => !pendingGroupMemberIds.has(s.id)).length
  );

  /** Can drop this group if section keeps another group, or a fallback group exists. */
  const canRemoveSection = (s) => {
    const other = getSectionGroupIds(s).filter((gid) => gid !== editingId);
    if (other.length > 0) return true;
    // Only this group left — need another group to fall back to
    return state.groups.some((g) => g.id !== editingId);
  };

  inList.innerHTML = inMembers.length
    ? inMembers
        .map((s) => {
          const ok = canRemoveSection(s);
          const removeAttrs = ok
            ? `data-member-act="remove"`
            : `disabled title="Create another group first (section needs at least one group)"`;
          const otherNames = sectionGroupNames(s)
            .filter((n) => n !== groupName(editingId))
            .join(", ");
          const extra = otherNames
            ? ` <small class="member-extra">also: ${escapeHtml(otherNames)}</small>`
            : "";
          return `
      <div class="group-member-row" data-id="${s.id}">
        <div class="swatch" style="background:${s.color}"></div>
        <span class="name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}${extra}</span>
        <button type="button" class="btn tiny ghost danger" ${removeAttrs}>Remove</button>
      </div>`;
        })
        .join("")
    : `<div class="group-members-empty">${
        q ? "No matches" : "No sections in this group yet"
      }</div>`;

  outList.innerHTML = outMembers.length
    ? outMembers
        .map((s) => {
          const names = sectionGroupNames(s);
          const extra = names.length
            ? ` · ${escapeHtml(names.join(", "))}`
            : "";
          return `
      <div class="group-member-row" data-id="${s.id}">
        <div class="swatch" style="background:${s.color}"></div>
        <span class="name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}${extra}</span>
        <button type="button" class="btn tiny" data-member-act="add">Add</button>
      </div>`;
        })
        .join("")
    : `<div class="group-members-empty">${
        q ? "No matches" : "All sections are in this group"
      }</div>`;
}

$("#group-member-search")?.addEventListener("input", (e) => {
  groupMemberSearchQuery = e.target.value;
  renderGroupMembers();
});

$("#group-members-in")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-member-act='remove']");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  const row = btn.closest(".group-member-row");
  const id = row?.dataset.id;
  if (!id) return;
  // Multi-group: removing only drops this group's membership on save.
  // Block only when this would leave the section with zero groups and no fallback.
  const section = state.sections.find((s) => s.id === id);
  const editingId = $("#group-edit-id")?.value || "";
  if (section) {
    const other = getSectionGroupIds(section).filter((gid) => gid !== editingId);
    const hasFallback = state.groups.some((g) => g.id !== editingId);
    if (!other.length && !hasFallback) {
      alert("Create another group first — every section needs at least one group.");
      return;
    }
  }
  pendingGroupMemberIds.delete(id);
  renderGroupMembers();
  scheduleGroupLivePreview();
});

$("#group-members-out")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-member-act]");
  if (!btn || btn.dataset.memberAct !== "add") return;
  e.preventDefault();
  const row = btn.closest(".group-member-row");
  const id = row?.dataset.id;
  if (!id) return;
  pendingGroupMemberIds.add(id);
  renderGroupMembers();
  scheduleGroupLivePreview();
});

$("#group-cancel").addEventListener("click", () => groupModal.close());

// Group profile media / sliders + live preview
$("#group-name")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-color")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-text-color")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-winner-text-color")?.addEventListener(
  "input",
  scheduleGroupLivePreview
);
$("#group-image-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  pendingGroupImage = await fileToDataUrl(file);
  setImgPreview($("#group-img-preview"), pendingGroupImage);
  scheduleGroupLivePreview();
});
$("#group-image-clear")?.addEventListener("click", () => {
  pendingGroupImage = null;
  setImgPreview($("#group-img-preview"), null);
  scheduleGroupLivePreview();
});
$("#group-image-mode")?.addEventListener("change", () => {
  updateGroupImageModeUI();
  scheduleGroupLivePreview();
});
for (const id of [
  "group-fill-scale",
  "group-fill-offset-x",
  "group-fill-offset-y",
  "group-tile-scale",
  "group-tile-offset-x",
  "group-tile-offset-y",
]) {
  $(`#${id}`)?.addEventListener("input", () => {
    setGroupProfileSliderLabels();
    scheduleGroupLivePreview();
  });
}
$("#group-preview-weight-mode")?.addEventListener("change", () => {
  if (
    parsePreviewWeightMode($("#group-preview-weight-mode")?.value) === "weight"
  ) {
    const num = $("#group-preview-weight-value-num");
    syncPreviewWeightValueControls(
      "group-preview",
      num?.value || 1
    );
  }
  updateGroupPreviewWeightUI();
  scheduleGroupLivePreview();
});
$("#group-preview-custom-weight")?.addEventListener("input", () => {
  updateGroupPreviewWeightUI();
  scheduleGroupLivePreview();
});
$("#group-preview-weight-value")?.addEventListener("input", () => {
  const opts = getWeightSliderOpts();
  const v = snapWeightSliderValue(
    $("#group-preview-weight-value")?.value,
    opts
  );
  if ($("#group-preview-weight-value-num")) {
    $("#group-preview-weight-value-num").value = String(v);
  }
  scheduleGroupLivePreview();
});
$("#group-preview-weight-value-num")?.addEventListener("input", () => {
  const opts = getWeightSliderOpts();
  const raw = Number($("#group-preview-weight-value-num")?.value);
  if (!Number.isFinite(raw)) return;
  if ($("#group-preview-weight-value")) {
    $("#group-preview-weight-value").value = String(
      snapWeightSliderValue(raw, opts)
    );
  }
  scheduleGroupLivePreview();
});
$("#group-sfx-preset")?.addEventListener("change", () => {
  const v = $("#group-sfx-preset")?.value;
  if (v === "default") {
    pendingGroupSfx = null;
    pendingGroupSfxName = null;
  } else if (v === "custom" && !pendingGroupSfx) {
    $("#group-sfx-input")?.click();
  }
  updateGroupSfxPresetUI();
});
$("#group-sfx-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateGroupSfxPresetUI();
    return;
  }
  pendingGroupSfx = await fileToDataUrl(file);
  pendingGroupSfxName = file.name;
  updateGroupSfxPresetUI();
});
$("#group-sfx-clear")?.addEventListener("click", () => {
  pendingGroupSfx = null;
  pendingGroupSfxName = null;
  updateGroupSfxPresetUI();
});
$("#group-sfx-preview")?.addEventListener("click", async () => {
  audio.ensure();
  if (audio.isPreviewPlaying) {
    audio.stopPreview();
    return;
  }
  if (pendingGroupSfx) {
    await audio.loadDataUrl("preview_group", pendingGroupSfx);
    if (audio.isPreviewPlaying) return;
    audio.playOneShot("preview_group", state.sound.landVolume, "land", true);
  } else {
    playGlobalLandSfx(state.sound.landVolume, true);
  }
});

/** One-time copy of selected profile parts into member sections. */
$("#btn-apply-group-profile")?.addEventListener("click", async () => {
  const members = state.sections.filter((s) => pendingGroupMemberIds.has(s.id));
  if (!members.length) {
    alert("Add at least one section to this group first (In this group list).");
    return;
  }
  const parts = readApplyPartsFromForm();
  if (
    !parts.color &&
    !parts.textColor &&
    !parts.winnerTextColor &&
    !parts.image &&
    !parts.sfx
  ) {
    alert(
      "Check at least one part to apply: Slice color, Text color, Winner text, Image, or Land SFX."
    );
    return;
  }
  const labels = [
    parts.color ? "slice color" : "",
    parts.textColor ? "text color" : "",
    parts.winnerTextColor ? "winner text" : "",
    parts.image ? "image" : "",
    parts.sfx ? "land SFX" : "",
  ].filter(Boolean);
  if (
    !confirm(
      `Copy group ${labels.join(" + ")} onto ${members.length} section(s)?\n\nOnly those parts are overwritten. Other section settings stay as they are.`
    )
  ) {
    return;
  }
  const profile = readGroupProfileFromForm();
  checkpoint();
  for (const s of members) {
    applyProfileToSection(s, profile, parts);
    if (parts.sfx && s.landSfxData) {
      await audio.loadDataUrl(`land_${s.id}`, s.landSfxData);
    }
  }
  // Also persist profile onto the group if it already exists
  const gid = $("#group-edit-id")?.value;
  if (gid) {
    const group = state.groups.find((g) => g.id === gid);
    if (group) {
      Object.assign(group, profile, readOverridePartsFromForm());
      if (group.landSfxData) {
        await audio.loadDataUrl(`land_grp_${group.id}`, group.landSfxData);
      }
    }
  }
  persist();
  renderSections();
  renderGroups();
  await refreshWheel();
  alert(`Applied ${labels.join(" + ")} to ${members.length} section(s).`);
});

$("#group-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#group-name").value.trim();
  if (!name) return;
  let id = $("#group-edit-id").value;
  const active = $("#group-active").checked;
  const overrideParts = readOverridePartsFromForm();
  const profile = readGroupProfileFromForm();

  checkpoint();
  if (id) {
    const group = state.groups.find((g) => g.id === id);
    if (group) {
      Object.assign(group, normalizeGroup({
        ...group,
        name,
        active,
        ...overrideParts,
        ...profile,
      }));
    }
  } else {
    id = uid("grp");
    state.groups.push(
      normalizeGroup({
        id,
        name,
        active,
        ...overrideParts,
        ...profile,
      })
    );
    $("#group-edit-id").value = id;
  }

  // Multi-group: add this id to pending members; remove only this id from others.
  const fallback =
    state.groups.find((g) => g.id !== id) || state.groups[0];
  if (!fallback) {
    alert("You need at least one group.");
    return;
  }

  for (const s of state.sections) {
    let ids = getSectionGroupIds(s).filter((gid) =>
      state.groups.some((g) => g.id === gid)
    );
    if (pendingGroupMemberIds.has(s.id)) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      ids = ids.filter((gid) => gid !== id);
    }
    if (!ids.length) ids = [fallback.id];
    setSectionGroupIds(s, ids);
  }

  if (profile.landSfxData) {
    await audio.loadDataUrl(`land_grp_${id}`, profile.landSfxData);
  }

  persist();
  renderGroups();
  renderSections();
  await refreshWheel();
  groupModal.close();
});

// --- Section search + sort ---
sectionSearchInput.addEventListener("input", () => {
  sectionSearchQuery = sectionSearchInput.value;
  sectionSearchClear.classList.toggle("hidden", !sectionSearchQuery.trim());
  renderSections();
});

sectionSearchClear.addEventListener("click", () => {
  sectionSearchQuery = "";
  sectionSearchInput.value = "";
  sectionSearchClear.classList.add("hidden");
  renderSections();
  sectionSearchInput.focus();
});

const sectionSortSelect = $("#section-sort");
if (sectionSortSelect) {
  sectionSortSelect.value = sectionSortMode;
  sectionSortSelect.addEventListener("change", () => {
    sectionSortMode = sectionSortSelect.value || "manual";
    try {
      localStorage.setItem(SECTION_SORT_KEY, sectionSortMode);
    } catch {
      /* ignore */
    }
    renderSections();
  });
}

// --- Section modal ---
let pendingSectionImage = null;
let pendingSectionSfx = null;
let pendingSectionSfxName = null;
/** Tracks which profile channels the user touched in the open editor */
let sectionEditDirty = {
  color: false,
  textColor: false,
  winnerTextColor: false,
  image: false,
  sfx: false,
};
/** custom* flags of the section being edited (or defaults for new) */
let sectionEditCustom = {
  color: false,
  textColor: false,
  winnerTextColor: false,
  image: false,
  sfx: false,
};

function markSectionDirty(channel) {
  if (channel === "color") sectionEditDirty.color = true;
  if (channel === "textColor") sectionEditDirty.textColor = true;
  if (channel === "winnerTextColor") sectionEditDirty.winnerTextColor = true;
  if (channel === "image") sectionEditDirty.image = true;
  if (channel === "sfx") sectionEditDirty.sfx = true;
}

function fillGroupSelects() {
  const box = $("#section-groups");
  if (box) {
    box.innerHTML = state.groups.length
      ? state.groups
          .map(
            (g, i) => `
      <label class="group-check-row">
        <input type="checkbox" class="section-group-check" value="${g.id}" />
        <span class="group-check-name">${escapeHtml(g.name)}</span>
        <span class="prio" title="Priority (1 = highest)">#${i + 1}</span>
      </label>`
          )
          .join("")
      : `<p class="hint">Create a group first</p>`;
  }
  const bulk = $("#bulk-group");
  if (bulk) {
    bulk.innerHTML =
      `<option value="">None (no group)</option>` +
      state.groups
        .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
        .join("");
  }
}

function setImgPreview(el, dataUrl) {
  if (dataUrl) {
    // Use <img> so GIF previews animate in the editor
    el.classList.add("has-image");
    el.classList.remove("empty");
    el.textContent = "";
    el.style.backgroundImage = "";
    let img = el.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
    }
    img.src = dataUrl;
  } else {
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
    el.classList.add("empty");
    el.innerHTML = "";
    el.textContent = "No image";
  }
}

function updateSectionImageModeUI() {
  const mode = $("#section-image-mode")?.value || "fill";
  const isTile = mode === "tile";
  const fillOpts = $("#section-fill-options");
  const tileScale = $("#section-tile-scale-field");
  const tileOx = $("#section-tile-offset-x-field");
  const tileOy = $("#section-tile-offset-y-field");
  if (fillOpts) fillOpts.style.display = isTile ? "none" : "";
  if (tileScale) tileScale.style.display = isTile ? "" : "none";
  if (tileOx) tileOx.style.display = isTile ? "" : "none";
  if (tileOy) tileOy.style.display = isTile ? "" : "none";
}

/** Draft values from the open section form (for live preview). */
function getSectionDraft() {
  return {
    label: ($("#section-label")?.value || "").trim() || "Untitled",
    color: $("#section-color")?.value || "#4a6cf7",
    textColor: $("#section-text-color")?.value || state.look?.textColor || "#ffffff",
    imageData: pendingSectionImage,
    imageMode: $("#section-image-mode")?.value === "tile" ? "tile" : "fill",
    imageFillScale: Math.min(
      3,
      Math.max(0.1, Number($("#section-fill-scale")?.value) || 1)
    ),
    imageFillOffsetX: Math.min(
      100,
      Math.max(-100, Number($("#section-fill-offset-x")?.value) || 0)
    ),
    imageFillOffsetY: Math.min(
      100,
      Math.max(-100, Number($("#section-fill-offset-y")?.value) || 0)
    ),
    imageTileScale: Math.min(
      3,
      Math.max(0.1, Number($("#section-tile-scale")?.value) || 1)
    ),
    imageTileOffsetX: Math.min(
      100,
      Math.max(-100, Number($("#section-tile-offset-x")?.value) || 0)
    ),
    imageTileOffsetY: Math.min(
      100,
      Math.max(-100, Number($("#section-tile-offset-y")?.value) || 0)
    ),
  };
}

/** Wedge clip-path for the live preview (box is 2r×2r, center at r,r). */
function previewWedgeClip(start, end, r) {
  const span = end - start;
  if (span >= Math.PI * 2 - 1e-4) {
    return `circle(${r}px at ${r}px ${r}px)`;
  }
  const cx = r;
  const cy = r;
  const pts = [`${cx}px ${cy}px`];
  const steps = Math.max(12, Math.ceil((span / (Math.PI * 2)) * 48));
  for (let i = 0; i <= steps; i++) {
    const a = start + (span * i) / steps;
    pts.push(`${cx + Math.cos(a) * r}px ${cy + Math.sin(a) * r}px`);
  }
  return `polygon(${pts.join(", ")})`;
}

/**
 * Preview wedge metrics.
 * - custom: slider = % of full wheel
 * - current: weight vs rest of active wheel
 */
/** @returns {"custom"|"weight"|"current"} */
function parsePreviewWeightMode(raw) {
  if (raw === "custom" || raw === "weight" || raw === "current") return raw;
  return "custom";
}

function computePreviewWedgeMetrics({ mode, customPct, weight, excludeSectionId }) {
  const m = parsePreviewWeightMode(mode);
  if (m === "custom") {
    const pct = Math.min(100, Math.max(1, Math.round(Number(customPct) || 1)));
    const span = (pct / 100) * Math.PI * 2;
    return {
      span,
      weight: pct,
      total: 100,
      pct,
      mode: "custom",
      otherCount: pct >= 100 ? 0 : 1,
    };
  }

  // "current" | "weight" — relative to other enabled sections on the wheel
  const w = normalizeWeight(weight);
  let otherTotal = 0;
  let otherCount = 0;
  for (const s of getActiveSections(state)) {
    if (excludeSectionId && s.id === excludeSectionId) continue;
    otherTotal += normalizeWeight(s.weight);
    otherCount += 1;
  }
  const total = otherTotal + w;
  const fraction = w / Math.max(1, total);
  const span =
    otherCount === 0
      ? Math.PI * 2
      : Math.max((Math.PI * 2) * 0.04, Math.min(Math.PI * 2, fraction * Math.PI * 2));
  return {
    span,
    weight: w,
    total,
    pct: Math.round(fraction * 100),
    mode: m,
    otherCount,
  };
}

function getPreviewWedgeMetrics() {
  const mode = parsePreviewWeightMode($("#preview-weight-mode")?.value);
  const weight =
    mode === "weight"
      ? $("#preview-weight-value-num")?.value ??
        $("#preview-weight-value")?.value
      : $("#section-weight")?.value;
  return computePreviewWedgeMetrics({
    mode,
    customPct: $("#preview-custom-weight")?.value,
    weight,
    excludeSectionId: $("#section-edit-id")?.value || "",
  });
}

/** Group preview: "current" uses average weight of members in this group (or 1). */
function getGroupPreviewWedgeMetrics() {
  const mode = parsePreviewWeightMode($("#group-preview-weight-mode")?.value);
  let weight = 1;
  if (mode === "weight") {
    weight =
      $("#group-preview-weight-value-num")?.value ??
      $("#group-preview-weight-value")?.value ??
      1;
  } else if (mode === "current") {
    const members = state.sections.filter((s) =>
      pendingGroupMemberIds.has(s.id)
    );
    if (members.length) {
      const sum = members.reduce(
        (a, s) => a + normalizeWeight(s.weight),
        0
      );
      weight = normalizeWeight(sum / members.length);
    }
  }
  return computePreviewWedgeMetrics({
    mode,
    customPct: $("#group-preview-custom-weight")?.value,
    weight,
    excludeSectionId: null,
  });
}

/** Sync preview weight range + number fields from Look slider opts / a seed value. */
function syncPreviewWeightValueControls(prefix, seedWeight) {
  const opts = getWeightSliderOpts();
  const range = $(`#${prefix}-weight-value`);
  const num = $(`#${prefix}-weight-value-num`);
  if (range) {
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
  }
  const w = normalizeWeight(
    seedWeight != null && seedWeight !== ""
      ? seedWeight
      : num?.value ?? range?.value ?? opts.min
  );
  const scrub = snapWeightSliderValue(w, opts);
  if (range) range.value = String(scrub);
  if (num) num.value = String(w);
  return w;
}

function updatePreviewWeightUI() {
  const mode = parsePreviewWeightMode($("#preview-weight-mode")?.value);
  const customField = $("#preview-custom-weight-field");
  const weightField = $("#preview-weight-value-field");
  if (customField) {
    if (mode === "custom") customField.removeAttribute("hidden");
    else customField.setAttribute("hidden", "");
  }
  if (weightField) {
    if (mode === "weight") weightField.removeAttribute("hidden");
    else weightField.setAttribute("hidden", "");
  }
  if (mode === "custom") {
    const custom = Math.min(
      100,
      Math.max(1, Math.round(Number($("#preview-custom-weight")?.value) || 1))
    );
    const customLabel = $("#preview-custom-weight-label");
    if (customLabel) customLabel.textContent = `${custom}%`;
  }
  if (mode === "weight") {
    syncPreviewWeightValueControls(
      "preview",
      $("#preview-weight-value-num")?.value ?? $("#section-weight")?.value
    );
  }
}

function updateGroupPreviewWeightUI() {
  const mode = parsePreviewWeightMode($("#group-preview-weight-mode")?.value);
  const customField = $("#group-preview-custom-weight-field");
  const weightField = $("#group-preview-weight-value-field");
  if (customField) {
    if (mode === "custom") customField.removeAttribute("hidden");
    else customField.setAttribute("hidden", "");
  }
  if (weightField) {
    if (mode === "weight") weightField.removeAttribute("hidden");
    else weightField.setAttribute("hidden", "");
  }
  if (mode === "custom") {
    const custom = Math.min(
      100,
      Math.max(1, Math.round(Number($("#group-preview-custom-weight")?.value) || 1))
    );
    const customLabel = $("#group-preview-custom-weight-label");
    if (customLabel) customLabel.textContent = `${custom}%`;
  }
  if (mode === "weight") {
    syncPreviewWeightValueControls(
      "group-preview",
      $("#group-preview-weight-value-num")?.value
    );
  }
}

/**
 * Shared live slice drawer (section editor + group profile editor).
 */
function drawSliceLivePreview({ stage, canvas, media, labelEl, metaEl, draft, metrics }) {
  if (!stage || !canvas || !media || !labelEl || !draft || !metrics) return;

  const rect = stage.getBoundingClientRect();
  const cssSize = Math.max(120, Math.floor(Math.min(rect.width, rect.height) || 280));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(cssSize * dpr);
  canvas.height = Math.floor(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.42;
  const radiusCss = cssSize * 0.42;

  const mid = -Math.PI / 2;
  const fullDisc = metrics.span >= Math.PI * 2 - 1e-4;
  const half = metrics.span / 2;
  const start = fullDisc ? 0 : mid - half;
  const end = fullDisc ? Math.PI * 2 : mid + half;

  if (metaEl) {
    if (metrics.mode === "custom") {
      metaEl.textContent =
        metrics.pct >= 100
          ? `Full wheel (custom 100%)`
          : `${metrics.pct}% of wheel (custom)`;
    } else if (metrics.otherCount === 0) {
      metaEl.textContent = `Full wheel (weight ${formatWeight(metrics.weight)})`;
    } else {
      const label =
        metrics.mode === "weight" ? "custom weight" : "current weight";
      metaEl.textContent = `~${metrics.pct}% of wheel · ${label} ${formatWeight(metrics.weight)} / ${formatWeight(metrics.total)}`;
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (fullDisc) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = draft.color;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(40, 48, 72, 0.85)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = draft.color;
    ctx.fill();

    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1.5 * dpr;
    for (const a of [start, end]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = state.look.borderColor || "#f0d78c";
  ctx.lineWidth = 5 * dpr;
  ctx.stroke();

  const hubR = radius * (state.look.centerSize ?? 0.16);
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fillStyle = state.look.centerColor || "#1a1f35";
  ctx.fill();
  ctx.strokeStyle = state.look.borderColor || "#f0d78c";
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  media.innerHTML = "";
  if (draft.imageData && state.look.showImages !== false) {
    const mode = draft.imageMode === "tile" ? "tile" : "fill";
    const wedge = document.createElement("div");
    wedge.className = `slice-bg-wedge mode-${mode}`;
    const d = radiusCss * 2;
    wedge.style.width = `${d}px`;
    wedge.style.height = `${d}px`;
    wedge.style.left = `${cssSize / 2 - radiusCss}px`;
    wedge.style.top = `${cssSize / 2 - radiusCss}px`;
    const clip = fullDisc
      ? `circle(${radiusCss}px at ${radiusCss}px ${radiusCss}px)`
      : previewWedgeClip(start, end, radiusCss);
    wedge.style.clipPath = clip;
    wedge.style.webkitClipPath = clip;

    if (mode === "tile") {
      const grid = document.createElement("div");
      grid.className = "slice-bg-tile-grid";
      const base = Math.max(18, radiusCss * 0.2);
      const scale = draft.imageTileScale;
      const tilePx = Math.max(10, base * scale);
      let cols = Math.max(1, Math.ceil(d / tilePx)) + 2;
      let rows = Math.max(1, Math.ceil(d / tilePx)) + 2;
      const maxCells = 100;
      if (cols * rows > maxCells) {
        const shrink = Math.sqrt(maxCells / (cols * rows));
        cols = Math.max(3, Math.ceil(cols * shrink));
        rows = Math.max(3, Math.ceil(rows * shrink));
      }
      const ox = (draft.imageTileOffsetX / 100) * tilePx;
      const oy = (draft.imageTileOffsetY / 100) * tilePx;
      grid.style.gridTemplateColumns = `repeat(${cols}, ${tilePx}px)`;
      grid.style.gridTemplateRows = `repeat(${rows}, ${tilePx}px)`;
      grid.style.width = `${cols * tilePx}px`;
      grid.style.height = `${rows * tilePx}px`;
      grid.style.left = `${-tilePx + ox}px`;
      grid.style.top = `${-tilePx + oy}px`;
      for (let i = 0; i < cols * rows; i++) {
        const img = document.createElement("img");
        img.src = draft.imageData;
        img.alt = "";
        img.draggable = false;
        grid.appendChild(img);
      }
      wedge.appendChild(grid);
    } else {
      const img = document.createElement("img");
      img.className = "slice-bg-fill";
      img.src = draft.imageData;
      img.alt = "";
      img.draggable = false;
      // Fixed wheel-space framing — identical to main wheel fill layout
      const layout = computeFillImageLayout({
        radius: radiusCss,
        fillScale: draft.imageFillScale,
        offsetXPct: draft.imageFillOffsetX,
        offsetYPct: draft.imageFillOffsetY,
      });
      wedge.style.setProperty("--fill-scale", String(layout.fillScale));
      const box = radiusCss * 2;
      img.style.width = `${box}px`;
      img.style.height = `${box}px`;
      img.style.left = `${layout.left}px`;
      img.style.top = `${layout.top}px`;
      wedge.appendChild(img);
    }

    media.appendChild(wedge);

    ctx.beginPath();
    if (fullDisc) {
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    } else {
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, end);
      ctx.closePath();
    }
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fill();
  }

  labelEl.textContent = draft.label;
  labelEl.style.color =
    draft.textColor || state.look?.textColor || "#fff";
  const labelMid = fullDisc ? -Math.PI / 2 : mid;
  const labelDist = fullDisc ? 0.45 : 0.58;
  const lx = 50 + Math.cos(labelMid) * labelDist * 42;
  const ly = 50 + Math.sin(labelMid) * labelDist * 42;
  labelEl.style.left = `${lx}%`;
  labelEl.style.top = `${ly}%`;
}

function updateSectionLivePreview() {
  if (!sectionModal.open) return;
  drawSliceLivePreview({
    stage: $("#section-live-stage"),
    canvas: $("#section-live-canvas"),
    media: $("#section-live-media"),
    labelEl: $("#section-live-label"),
    metaEl: $("#preview-weight-meta"),
    draft: getSectionDraft(),
    metrics: getPreviewWedgeMetrics(),
  });
}

function getGroupDraft() {
  const profile = readGroupProfileFromForm();
  return {
    label: ($("#group-name")?.value || "").trim() || "Group",
    ...profile,
  };
}

function updateGroupLivePreview() {
  if (!groupModal.open) return;
  drawSliceLivePreview({
    stage: $("#group-live-stage"),
    canvas: $("#group-live-canvas"),
    media: $("#group-live-media"),
    labelEl: $("#group-live-label"),
    metaEl: $("#group-preview-weight-meta"),
    draft: getGroupDraft(),
    metrics: getGroupPreviewWedgeMetrics(),
  });
}

function scheduleSectionLivePreview() {
  if (scheduleSectionLivePreview._raf) return;
  scheduleSectionLivePreview._raf = requestAnimationFrame(() => {
    scheduleSectionLivePreview._raf = 0;
    updateSectionLivePreview();
  });
}

function scheduleGroupLivePreview() {
  if (scheduleGroupLivePreview._raf) return;
  scheduleGroupLivePreview._raf = requestAnimationFrame(() => {
    scheduleGroupLivePreview._raf = 0;
    updateGroupLivePreview();
  });
}

function openSectionModal(section) {
  fillGroupSelects();
  sectionEditDirty = {
    color: false,
    textColor: false,
    winnerTextColor: false,
    image: false,
    sfx: false,
  };
  sectionEditCustom = {
    color: section ? section.customColor === true : false,
    textColor: section ? section.customTextColor === true : false,
    winnerTextColor: section ? section.customWinnerTextColor === true : false,
    image: section ? section.customImage === true : false,
    sfx: section ? section.customSfx === true : false,
  };

  // Show effective look (inherited group profile) when channel is unedited
  const resolved = section
    ? resolveSectionForDisplay(state, section)
    : null;
  const colorSrc = sectionEditCustom.color ? section : resolved;
  const textSrc = sectionEditCustom.textColor ? section : resolved;
  const winnerTextSrc = sectionEditCustom.winnerTextColor
    ? section
    : resolved;
  const imageSrc = sectionEditCustom.image ? section : resolved;
  const sfxSrc = sectionEditCustom.sfx ? section : resolved;

  pendingSectionImage = imageSrc?.imageData ?? null;
  pendingSectionSfx = sfxSrc?.landSfxData ?? null;
  pendingSectionSfxName = sfxSrc?.landSfxName ?? null;

  $("#section-modal-title").textContent = section ? "Edit section" : "Add section";
  $("#section-edit-id").value = section?.id || "";
  $("#section-label").value = section?.label || "";
  $("#section-weight").value = section?.weight ?? 1;
  $("#section-color").value =
    colorSrc?.color || nextPaletteColor(state);
  if ($("#section-text-color")) {
    $("#section-text-color").value =
      textSrc?.textColor ||
      state.look?.textColor ||
      "#ffffff";
  }
  if ($("#section-winner-text-color")) {
    $("#section-winner-text-color").value =
      winnerTextSrc?.winnerTextColor ||
      state.look?.winnerTextColor ||
      state.look?.textColor ||
      "#ffffff";
  }
  {
    const existing = getSectionGroupIds(section);
    const initial =
      existing.length > 0
        ? existing
        : state.groups[0]
          ? [state.groups[0].id]
          : [];
    setCheckedSectionGroupIds(initial);
  }
  $("#section-enabled").checked = section?.enabled !== false;
  const imgModeSrc = imageSrc || section;
  $("#section-image-mode").value =
    imgModeSrc?.imageMode === "tile" ? "tile" : "fill";
  const fillScale = imgModeSrc?.imageFillScale ?? 1;
  $("#section-fill-scale").value = fillScale;
  $("#section-fill-scale-label").textContent = `${Math.round(fillScale * 100)}%`;
  const fox = imgModeSrc?.imageFillOffsetX ?? 0;
  const foy = imgModeSrc?.imageFillOffsetY ?? 0;
  $("#section-fill-offset-x").value = fox;
  $("#section-fill-offset-x-label").textContent = `${Math.round(fox)}%`;
  $("#section-fill-offset-y").value = foy;
  $("#section-fill-offset-y-label").textContent = `${Math.round(foy)}%`;
  const tileScale = imgModeSrc?.imageTileScale ?? 1;
  $("#section-tile-scale").value = tileScale;
  $("#section-tile-scale-label").textContent = `${Math.round(tileScale * 100)}%`;
  const ox = imgModeSrc?.imageTileOffsetX ?? 0;
  const oy = imgModeSrc?.imageTileOffsetY ?? 0;
  $("#section-tile-offset-x").value = ox;
  $("#section-tile-offset-x-label").textContent = `${Math.round(ox)}%`;
  $("#section-tile-offset-y").value = oy;
  $("#section-tile-offset-y-label").textContent = `${Math.round(oy)}%`;
  setImgPreview($("#section-img-preview"), pendingSectionImage);
  // For custom channel, only the section's own file counts as custom
  if (!sectionEditCustom.sfx) {
    pendingSectionSfx = null;
    pendingSectionSfxName = null;
  } else {
    pendingSectionSfx = section?.landSfxData ?? null;
    pendingSectionSfxName = section?.landSfxName ?? null;
  }
  updateSectionSfxPresetUI();
  {
    const vol =
      section?.landSfxVolume != null && Number.isFinite(Number(section.landSfxVolume))
        ? Number(section.landSfxVolume)
        : state.sound.landVolume ?? 0.4;
    const clamped = Math.min(1, Math.max(0, vol));
    if ($("#section-sfx-volume")) $("#section-sfx-volume").value = String(clamped);
    if ($("#section-sfx-volume-label")) {
      $("#section-sfx-volume-label").textContent = `${Math.round(clamped * 100)}%`;
    }
  }
  updateSectionImageModeUI();
  // Default preview: custom % of wheel at 100% (full circle)
  if ($("#preview-weight-mode")) {
    $("#preview-weight-mode").value = "custom";
  }
  if ($("#preview-custom-weight")) {
    $("#preview-custom-weight").value = "100";
  }
  // Seed custom-weight preview from this section's weight
  syncPreviewWeightValueControls(
    "preview",
    $("#section-weight")?.value ?? 1
  );
  updatePreviewWeightUI();
  sectionModal.showModal();
  // Preview after layout so stage has size
  requestAnimationFrame(() => {
    updateSectionLivePreview();
    requestAnimationFrame(updateSectionLivePreview);
  });
}

$("#preview-weight-mode")?.addEventListener("change", () => {
  if (parsePreviewWeightMode($("#preview-weight-mode")?.value) === "weight") {
    // When switching to custom weight, seed from the real section weight if empty-ish
    const num = $("#preview-weight-value-num");
    if (num && (num.value === "" || Number(num.value) <= 0)) {
      syncPreviewWeightValueControls("preview", $("#section-weight")?.value);
    } else {
      syncPreviewWeightValueControls("preview", num?.value);
    }
  }
  updatePreviewWeightUI();
  scheduleSectionLivePreview();
});
$("#preview-custom-weight")?.addEventListener("input", () => {
  updatePreviewWeightUI();
  scheduleSectionLivePreview();
});
$("#preview-weight-value")?.addEventListener("input", () => {
  const opts = getWeightSliderOpts();
  const v = snapWeightSliderValue($("#preview-weight-value")?.value, opts);
  if ($("#preview-weight-value-num")) {
    $("#preview-weight-value-num").value = String(v);
  }
  scheduleSectionLivePreview();
});
$("#preview-weight-value-num")?.addEventListener("input", () => {
  const opts = getWeightSliderOpts();
  const raw = Number($("#preview-weight-value-num")?.value);
  if (!Number.isFinite(raw)) return;
  if ($("#preview-weight-value")) {
    $("#preview-weight-value").value = String(snapWeightSliderValue(raw, opts));
  }
  scheduleSectionLivePreview();
});
$("#section-weight")?.addEventListener("input", scheduleSectionLivePreview);

$("#section-image-mode")?.addEventListener("change", () => {
  markSectionDirty("image");
  updateSectionImageModeUI();
  scheduleSectionLivePreview();
});
$("#section-fill-scale")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-fill-scale").value) || 1;
  $("#section-fill-scale-label").textContent = `${Math.round(v * 100)}%`;
  scheduleSectionLivePreview();
});
$("#section-fill-offset-x")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-fill-offset-x").value) || 0;
  $("#section-fill-offset-x-label").textContent = `${Math.round(v)}%`;
  scheduleSectionLivePreview();
});
$("#section-fill-offset-y")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-fill-offset-y").value) || 0;
  $("#section-fill-offset-y-label").textContent = `${Math.round(v)}%`;
  scheduleSectionLivePreview();
});
$("#section-tile-scale")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-tile-scale").value) || 1;
  $("#section-tile-scale-label").textContent = `${Math.round(v * 100)}%`;
  scheduleSectionLivePreview();
});
$("#section-tile-offset-x")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-tile-offset-x").value) || 0;
  $("#section-tile-offset-x-label").textContent = `${Math.round(v)}%`;
  scheduleSectionLivePreview();
});
$("#section-tile-offset-y")?.addEventListener("input", () => {
  markSectionDirty("image");
  const v = Number($("#section-tile-offset-y").value) || 0;
  $("#section-tile-offset-y-label").textContent = `${Math.round(v)}%`;
  scheduleSectionLivePreview();
});

// Live preview for label / color / weight
$("#section-label")?.addEventListener("input", scheduleSectionLivePreview);
$("#section-text-color")?.addEventListener("input", () => {
  markSectionDirty("textColor");
  scheduleSectionLivePreview();
});
$("#section-winner-text-color")?.addEventListener("input", () => {
  markSectionDirty("winnerTextColor");
});

$("#section-color")?.addEventListener("input", () => {
  markSectionDirty("color");
  scheduleSectionLivePreview();
});

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  // Some systems leave GIF type empty — allow by extension
  return /\.(gif|png|jpe?g|webp|apng|bmp|svg)$/i.test(file.name || "");
}

$("#section-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!isImageFile(file)) {
    alert("Please choose an image or GIF file.");
    return;
  }
  pendingSectionImage = await fileToDataUrl(file);
  markSectionDirty("image");
  setImgPreview($("#section-img-preview"), pendingSectionImage);
  scheduleSectionLivePreview();
});

$("#section-image-clear").addEventListener("click", () => {
  // Clear = stop using a section-owned image (inherit groups again on save)
  pendingSectionImage = null;
  markSectionDirty("image");
  sectionEditCustom.image = false;
  setImgPreview($("#section-img-preview"), null);
  scheduleSectionLivePreview();
});

// Keep previews sized if the dialog resizes
window.addEventListener("resize", () => {
  if (sectionModal?.open) scheduleSectionLivePreview();
  if (groupModal?.open) scheduleGroupLivePreview();
});

$("#section-sfx-preset")?.addEventListener("change", () => {
  const v = $("#section-sfx-preset")?.value;
  if (v === "default") {
    pendingSectionSfx = null;
    pendingSectionSfxName = null;
    markSectionDirty("sfx");
    sectionEditCustom.sfx = false;
  } else if (v === "custom") {
    // Don't keep an inherited buffer as "custom" unless already section-owned
    if (sectionEditCustom.sfx !== true) {
      pendingSectionSfx = null;
      pendingSectionSfxName = null;
    }
    sectionEditCustom.sfx = true;
    markSectionDirty("sfx");
    if (!pendingSectionSfx) {
      $("#section-sfx-input")?.click();
    }
  }
  updateSectionSfxPresetUI();
});

$("#section-sfx-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateSectionSfxPresetUI();
    return;
  }
  pendingSectionSfx = await fileToDataUrl(file);
  pendingSectionSfxName = file.name;
  markSectionDirty("sfx");
  sectionEditCustom.sfx = true;
  updateSectionSfxPresetUI();
});

$("#section-sfx-clear").addEventListener("click", () => {
  // Clear = inherit group SFX again (not a forced empty section sound)
  pendingSectionSfx = null;
  pendingSectionSfxName = null;
  markSectionDirty("sfx");
  sectionEditCustom.sfx = false;
  updateSectionSfxPresetUI();
});

function getSectionSfxVolumeFromForm() {
  const v = Number($("#section-sfx-volume")?.value);
  if (!Number.isFinite(v)) return state.sound.landVolume ?? 0.4;
  return Math.min(1, Math.max(0, v));
}

$("#section-sfx-volume")?.addEventListener("input", () => {
  const v = getSectionSfxVolumeFromForm();
  if ($("#section-sfx-volume-label")) {
    $("#section-sfx-volume-label").textContent = `${Math.round(v * 100)}%`;
  }
});

$("#section-sfx-preview").addEventListener("click", async () => {
  audio.ensure();
  if (audio.isPreviewPlaying) {
    audio.stopPreview();
    return;
  }
  const vol = getSectionSfxVolumeFromForm();
  if (pendingSectionSfx) {
    await audio.loadDataUrl("preview_section", pendingSectionSfx);
    // User may have clicked stop while loading
    if (audio.isPreviewPlaying) return;
    audio.playOneShot("preview_section", vol, "land", true);
  } else {
    playGlobalLandSfx(vol, true);
  }
});

$("#section-cancel").addEventListener("click", () => sectionModal.close());

$("#section-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#section-edit-id").value;
  checkpoint();
  // Empty is allowed — ungrouped section
  const groupIds = getCheckedSectionGroupIds().filter((gid) =>
    state.groups.some((g) => g.id === gid)
  );

  const existing = id ? state.sections.find((x) => x.id === id) : null;

  // custom* : stay unedited (inherit groups) until the user touches that channel
  let customColor = existing ? existing.customColor === true : false;
  let customTextColor = existing ? existing.customTextColor === true : false;
  let customWinnerTextColor = existing
    ? existing.customWinnerTextColor === true
    : false;
  let customImage = existing ? existing.customImage === true : false;
  let customSfx = existing ? existing.customSfx === true : false;
  if (sectionEditDirty.color) customColor = true;
  if (sectionEditDirty.textColor) customTextColor = true;
  if (sectionEditDirty.winnerTextColor) customWinnerTextColor = true;
  if (sectionEditDirty.image) {
    // Clear with no image → inherit again; pick/adjust image → own
    customImage = !!pendingSectionImage || sectionEditCustom.image === true;
    if (!pendingSectionImage && sectionEditDirty.image) customImage = false;
  }
  if (sectionEditDirty.sfx) {
    customSfx = !!pendingSectionSfx;
  }

  const imageFields = {
    imageData: customImage ? pendingSectionImage : existing?.imageData ?? null,
    imageMode:
      $("#section-image-mode").value === "tile" ? "tile" : "fill",
    imageFillScale: Math.min(
      3,
      Math.max(0.1, Number($("#section-fill-scale").value) || 1)
    ),
    imageFillOffsetX: Math.min(
      100,
      Math.max(-100, Number($("#section-fill-offset-x").value) || 0)
    ),
    imageFillOffsetY: Math.min(
      100,
      Math.max(-100, Number($("#section-fill-offset-y").value) || 0)
    ),
    imageTileScale: Math.min(
      3,
      Math.max(0.1, Number($("#section-tile-scale").value) || 1)
    ),
    imageTileOffsetX: Math.min(
      100,
      Math.max(-100, Number($("#section-tile-offset-x").value) || 0)
    ),
    imageTileOffsetY: Math.min(
      100,
      Math.max(-100, Number($("#section-tile-offset-y").value) || 0)
    ),
  };
  // Only persist image slider values when section owns the image
  if (!customImage && sectionEditDirty.image) {
    Object.assign(imageFields, {
      imageData: null,
      imageMode: "fill",
      imageFillScale: 1,
      imageFillOffsetX: 0,
      imageFillOffsetY: 0,
      imageTileScale: 1,
      imageTileOffsetX: 0,
      imageTileOffsetY: 0,
    });
  } else if (!customImage && existing && !sectionEditDirty.image) {
    // Keep stored raw fields; display still inherits
    Object.assign(imageFields, {
      imageData: existing.imageData,
      imageMode: existing.imageMode === "tile" ? "tile" : "fill",
      imageFillScale: existing.imageFillScale ?? 1,
      imageFillOffsetX: existing.imageFillOffsetX ?? 0,
      imageFillOffsetY: existing.imageFillOffsetY ?? 0,
      imageTileScale: existing.imageTileScale ?? 1,
      imageTileOffsetX: existing.imageTileOffsetX ?? 0,
      imageTileOffsetY: existing.imageTileOffsetY ?? 0,
    });
  }

  const payload = {
    label: $("#section-label").value.trim() || "Untitled",
    weight: normalizeWeight($("#section-weight").value),
    color: customColor
      ? $("#section-color").value
      : existing?.color || $("#section-color").value,
    textColor: customTextColor
      ? $("#section-text-color")?.value || "#ffffff"
      : existing?.textColor ||
        $("#section-text-color")?.value ||
        state.look?.textColor ||
        "#ffffff",
    winnerTextColor: customWinnerTextColor
      ? $("#section-winner-text-color")?.value || "#ffffff"
      : existing?.winnerTextColor ||
        $("#section-winner-text-color")?.value ||
        state.look?.winnerTextColor ||
        "#ffffff",
    groupIds,
    enabled: $("#section-enabled").checked,
    customColor,
    customTextColor,
    customWinnerTextColor,
    customImage,
    customSfx,
    ...imageFields,
    landSfxData: customSfx
      ? pendingSectionSfx
      : existing?.landSfxData ?? null,
    landSfxName: customSfx
      ? pendingSectionSfxName
      : existing?.landSfxName ?? null,
    landSfxVolume: getSectionSfxVolumeFromForm(),
  };

  if (id) {
    const s = state.sections.find((x) => x.id === id);
    if (s) {
      Object.assign(s, payload);
      delete s.groupId;
    }
    if (payload.customSfx && payload.landSfxData) {
      await audio.loadDataUrl(`land_${id}`, payload.landSfxData);
    }
  } else {
    const s = {
      id: uid("sec"),
      ...payload,
      // Brand-new section: untouched channels stay inherited
      customColor: sectionEditDirty.color,
      customTextColor: sectionEditDirty.textColor,
      customWinnerTextColor: sectionEditDirty.winnerTextColor,
      customImage: sectionEditDirty.image && !!pendingSectionImage,
      customSfx: sectionEditDirty.sfx && !!pendingSectionSfx,
      color: sectionEditDirty.color
        ? $("#section-color").value
        : nextPaletteColor(state),
      textColor: sectionEditDirty.textColor
        ? $("#section-text-color")?.value || "#ffffff"
        : state.look?.textColor || "#ffffff",
      winnerTextColor: sectionEditDirty.winnerTextColor
        ? $("#section-winner-text-color")?.value || "#ffffff"
        : state.look?.winnerTextColor ||
          state.look?.textColor ||
          "#ffffff",
      imageData: sectionEditDirty.image ? pendingSectionImage : null,
      landSfxData: sectionEditDirty.sfx ? pendingSectionSfx : null,
      landSfxName: sectionEditDirty.sfx ? pendingSectionSfxName : null,
      landSfxVolume: getSectionSfxVolumeFromForm(),
    };
    state.sections.push(s);
    if (s.customSfx && s.landSfxData) {
      await audio.loadDataUrl(`land_${s.id}`, s.landSfxData);
    }
  }
  persist();
  renderSections();
  renderGroups();
  await refreshWheel();
  sectionModal.close();
});

// --- Bulk add ---
$("#btn-add-many").addEventListener("click", () => {
  fillGroupSelects();
  $("#bulk-text").value = "";
  bulkModal.showModal();
});

$("#bulk-cancel").addEventListener("click", () => bulkModal.close());

$("#bulk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const lines = $("#bulk-text").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  // "" = None (no group). Do not fall back to first group.
  const bulkGroupRaw = $("#bulk-group")?.value ?? "";
  const bulkGroupId =
    bulkGroupRaw && state.groups.some((g) => g.id === bulkGroupRaw)
      ? bulkGroupRaw
      : null;
  checkpoint();
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    const label = parts[0] || "Untitled";
    const color = parts[1] && /^#?[0-9a-fA-F]{3,8}$/.test(parts[1])
      ? parts[1].startsWith("#")
        ? parts[1]
        : `#${parts[1]}`
      : nextPaletteColor(state);
    const weight = parts[2] ? normalizeWeight(parts[2]) : 1;
    const colorGiven = !!(parts[1] && /^#?[0-9a-fA-F]{3,8}$/.test(parts[1]));
    state.sections.push({
      id: uid("sec"),
      label,
      color,
      textColor: state.look?.textColor || "#ffffff",
      winnerTextColor:
        state.look?.winnerTextColor || state.look?.textColor || "#ffffff",
      weight,
      enabled: true,
      groupIds: bulkGroupId ? [bulkGroupId] : [],
      // Unedited image/SFX inherit group profiles; color only owned if set in bulk line
      customColor: colorGiven,
      customTextColor: false,
      customWinnerTextColor: false,
      customImage: false,
      customSfx: false,
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
      landSfxVolume: state.sound.landVolume ?? 0.4,
    });
  }
  persist();
  renderSections();
  await refreshWheel();
  bulkModal.close();
});

// --- Look tab ---
function bindLook() {
  $("#bg-color").value = state.look.backgroundColor;
  $("#center-color").value = state.look.centerColor;
  $("#center-size").value = state.look.centerSize;
  $("#border-color").value = state.look.borderColor;
  $("#text-color").value = state.look.textColor;
  if ($("#winner-text-color")) {
    $("#winner-text-color").value =
      state.look.winnerTextColor || state.look.textColor || "#ffffff";
  }
  updateWinnerTextOverrideButton();
  $("#chk-show-labels").checked = state.look.showLabels !== false;
  $("#chk-show-images").checked = state.look.showImages !== false;
  $("#result-style").value = state.look.resultStyle === "banner" ? "banner" : "center";
  if ($("#winner-label")) {
    $("#winner-label").value =
      state.look.winnerLabel != null && String(state.look.winnerLabel).trim() !== ""
        ? String(state.look.winnerLabel)
        : "Winner";
  }
  $("#chk-allow-winner-remove").checked = state.look.allowWinnerRemove !== false;
  {
    const opts = getWeightSliderOpts();
    if ($("#weight-slider-min")) $("#weight-slider-min").value = String(opts.min);
    if ($("#weight-slider-max")) $("#weight-slider-max").value = String(opts.max);
    if ($("#weight-slider-step")) $("#weight-slider-step").value = String(opts.step);
  }
  updateWinnerRemoveButton();
  updateWinnerLabelDisplay();
  setImgPreview($("#bg-preview"), state.look.backgroundImage);
  setImgPreview($("#center-preview"), state.look.centerImage);
  bindSpinDuration();
}

/** Global title above the winning section name (center style). */
function getWinnerLabel() {
  const raw = state.look?.winnerLabel;
  if (raw == null || String(raw).trim() === "") return "Winner";
  return String(raw).trim().slice(0, 40);
}

function updateWinnerLabelDisplay() {
  const el = $("#result-center-label");
  if (el) el.textContent = getWinnerLabel();
}

function updateWinnerRemoveButton() {
  const btn = $("#btn-result-remove");
  if (!btn) return;
  const allowed = state.look.allowWinnerRemove !== false;
  btn.hidden = !allowed;
  btn.setAttribute("aria-hidden", allowed ? "false" : "true");
}

/** Sync Look → Winner text color Override button active state */
function updateWinnerTextOverrideButton() {
  const btn = $("#btn-winner-text-override");
  if (!btn) return;
  const on = state.look?.forceWinnerTextColor === true;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on
    ? "Override on — result screen always uses Look winner text color (click to turn off)"
    : "Override off — use section/group winner text colors when set (click to force Look color)";
}

$("#btn-winner-text-override")?.addEventListener("click", () => {
  checkpoint();
  state.look.forceWinnerTextColor = !(state.look.forceWinnerTextColor === true);
  updateWinnerTextOverrideButton();
  persist();
});

function clearResultCenterBg() {
  const bg = $("#result-center-bg");
  if (!bg) return;
  bg.classList.remove("has-image");
  bg.style.backgroundImage = "";
  bg.innerHTML = "";
}

function setResultCenterBg(imageData) {
  const bg = $("#result-center-bg");
  if (!bg) return;
  bg.innerHTML = "";
  bg.style.backgroundImage = "";
  if (!imageData) {
    bg.classList.remove("has-image");
    return;
  }
  // <img> so GIFs keep animating behind the text
  const img = document.createElement("img");
  img.src = imageData;
  img.alt = "";
  img.draggable = false;
  bg.appendChild(img);
  bg.classList.add("has-image");
  // restart zoom-in animation
  bg.style.animation = "none";
  void bg.offsetWidth;
  bg.style.animation = "";
}

function ensureSecretState() {
  if (!state.secret || typeof state.secret !== "object") {
    state.secret = {
      unlocked: false,
      rigIt: false,
      rigTargetKind: "section",
      targetSectionId: null,
      targetGroupId: null,
      muteMusicOnDivert: true,
      muteSpinTicksOnRig: true,
      comboOrder: "reverse-first",
      reverseRigIt: false,
      reverseTargetKind: "section",
      reverseTargetSectionId: null,
      reverseTargetGroupId: null,
      reverseSlideSpeed: 2,
      reverseSlideSfxPreset: "goofy-slip",
      reverseSlideSfxData: null,
      reverseSlideSfxName: null,
      reverseSlideSfxVolume: 0.4,
      reverseMuteMusic: true,
      reverseMuteSpinTicks: true,
    };
  } else {
    // Backfill fields added in later versions
    if (state.secret.rigTargetKind == null) state.secret.rigTargetKind = "section";
    if (state.secret.comboOrder == null) state.secret.comboOrder = "reverse-first";
    if (state.secret.reverseMuteMusic == null) state.secret.reverseMuteMusic = true;
    if (state.secret.reverseMuteSpinTicks == null) {
      state.secret.reverseMuteSpinTicks = true;
    }
  }
  return state.secret;
}

function getRigTargetKind() {
  const s = ensureSecretState();
  const live = $("#secret-rig-target-kind")?.value;
  if (live === "group" || live === "section") return live;
  return s.rigTargetKind === "group" ? "group" : "section";
}

function getReverseTargetKind() {
  const s = ensureSecretState();
  const live = $("#secret-reverse-target-kind")?.value;
  if (live === "group" || live === "section") return live;
  return s.reverseTargetKind === "group" ? "group" : "section";
}

/** @returns {"reverse-first"|"rig-first"} */
function getSecretComboOrder() {
  const s = ensureSecretState();
  const live = $("#secret-combo-order")?.value;
  if (live === "rig-first" || live === "reverse-first") return live;
  return s.comboOrder === "rig-first" ? "rig-first" : "reverse-first";
}

function isRigItActive() {
  const s = ensureSecretState();
  const rigOn =
    $("#secret-rig-it") != null
      ? $("#secret-rig-it").checked === true
      : !!s.rigIt;
  if (!rigOn) return false;
  if (getRigTargetKind() === "group") {
    const gid =
      $("#secret-rig-group")?.value || s.targetGroupId || null;
    return !!(gid && state.groups.some((g) => g.id === gid));
  }
  const id =
    $("#secret-rig-section")?.value || s.targetSectionId || null;
  return !!(id && state.sections.some((sec) => sec.id === id));
}

function isReverseRigActive() {
  const s = ensureSecretState();
  const revOn =
    $("#secret-reverse-rig-it") != null
      ? $("#secret-reverse-rig-it").checked === true
      : !!s.reverseRigIt;
  if (!revOn) return false;
  if (getReverseTargetKind() === "group") {
    const gid =
      $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null;
    return !!(gid && state.groups.some((g) => g.id === gid));
  }
  const id =
    $("#secret-reverse-section")?.value || s.reverseTargetSectionId || null;
  return !!(id && state.sections.some((sec) => sec.id === id));
}

/**
 * Section id to force-land on this spin.
 * Group mode: weighted random among on-wheel members of the rigged group.
 * @returns {string|null}
 */
function getRigForceSectionId() {
  if (!isRigItActive()) return null;
  const s = ensureSecretState();
  const active = getActiveSections(state);
  if (!active.length) return null;

  if (getRigTargetKind() === "group") {
    const gid =
      $("#secret-rig-group")?.value || s.targetGroupId || null;
    if (!gid) return null;
    const pool = active.filter((sec) =>
      getSectionGroupIds(sec).includes(gid)
    );
    if (!pool.length) return null;
    // Weighted by section weight (same idea as natural pick)
    let total = 0;
    for (const sec of pool) {
      total += Math.max(0.1, normalizeWeight(sec.weight));
    }
    let r = Math.random() * total;
    for (const sec of pool) {
      r -= Math.max(0.1, normalizeWeight(sec.weight));
      if (r <= 0) return sec.id;
    }
    return pool[pool.length - 1].id;
  }

  const id =
    $("#secret-rig-section")?.value || s.targetSectionId || null;
  if (!id) return null;
  if (!active.some((sec) => sec.id === id)) return null;
  return id;
}

/**
 * Section ids reverse-rig should slide off of.
 * Group mode: every on-wheel member of that group (not just one random pick).
 * @returns {string[]}
 */
function getReverseAvoidSectionIds() {
  if (!isReverseRigActive()) return [];
  const s = ensureSecretState();
  const kind = getReverseTargetKind();
  // Use active-on-wheel sections so avoid set matches what the pointer can land on
  const active = getActiveSections(state);
  if (kind === "group") {
    const gid =
      $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null;
    if (!gid) return [];
    // Every section that belongs to this group and is currently on the wheel
    const ids = active
      .filter((sec) => sectionInGroup(sec, gid))
      .map((sec) => sec.id);
    // Fallback: enabled members of the group even if activity edge-cases miss them
    if (!ids.length) {
      return state.sections
        .filter(
          (sec) =>
            sec.enabled !== false &&
            sectionInGroup(sec, gid) &&
            isSectionActiveOnWheel(state, sec)
        )
        .map((sec) => sec.id);
    }
    return ids;
  }
  const id =
    $("#secret-reverse-section")?.value || s.reverseTargetSectionId || null;
  if (!id) return [];
  if (!active.some((sec) => sec.id === id)) return [];
  return [id];
}

/** Group id for reverse when avoiding a whole group (for wheel-side expansion). */
function getReverseAvoidGroupId() {
  if (!isReverseRigActive()) return null;
  if (getReverseTargetKind() !== "group") return null;
  const s = ensureSecretState();
  return (
    $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null
  );
}

function setResultRiggedVisible(visible) {
  const el = $("#result-rigged");
  if (!el) return;
  el.classList.toggle("hidden", !visible);
  el.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) {
    el.style.opacity = "";
    registerRiggedUnlockClicks();
  }
}

function hideResults() {
  resultBanner.classList.add("hidden");
  resultCenter.classList.add("hidden");
  resultActionsBar.classList.add("hidden");
  clearResultCenterBg();
  resultShowsRigged = false;
  // Keep a clickable “rigged” badge if Rig / Reverse is armed (re-open secret menu)
  setResultRiggedVisible(isRigItActive() || isReverseRigActive());
}

/** Whether the open win screen should keep showing “rigged” */
let resultShowsRigged = false;

/**
 * @param {{ id: string, label: string }} section
 * @param {{ rigged?: boolean }} [opts] rigged = fling or secret Rig it
 */
function showResult(section, opts = {}) {
  hideResults();
  lastWinnerId = section.id;
  const label = section.label;
  // Resolve inherited group image if the section itself has no image
  const raw =
    state.sections.find((s) => s.id === section.id) || section;
  const disp = resolveSectionForDisplay(state, raw);
  const imageData = disp?.imageData || null;

  const style = state.look.resultStyle === "banner" ? "banner" : "center";
  // Look Override forces Look color; else section/group/Look inheritance
  const winTextColor =
    state.look?.forceWinnerTextColor === true
      ? state.look?.winnerTextColor || state.look?.textColor || "#ffffff"
      : disp?.winnerTextColor ||
        state.look?.winnerTextColor ||
        state.look?.textColor ||
        "#ffffff";
  if (style === "banner") {
    resultTextBanner.textContent = label;
    resultTextBanner.style.color = winTextColor;
    resultBanner.classList.remove("hidden");
  } else {
    updateWinnerLabelDisplay();
    resultTextCenter.textContent = label;
    resultTextCenter.style.color = winTextColor;
    setResultCenterBg(imageData);
    const inner = resultCenter.querySelector(".result-center-inner");
    if (inner) {
      inner.style.animation = "none";
      void inner.offsetWidth;
      inner.style.animation = "";
    }
    resultCenter.classList.remove("hidden");
  }
  // Always dock Hide / Continue at the bottom (Remove optional)
  updateWinnerRemoveButton();
  resultActionsBar.classList.remove("hidden");
  resultShowsRigged =
    !!opts.rigged || isRigItActive() || isReverseRigActive();
  setResultRiggedVisible(resultShowsRigged);
}

// --- Secret tab (unlocked once by triple-clicking “rigged”) ---
let secretRiggedClicks = [];

function fillSecretSectionSelect() {
  const sec = ensureSecretState();
  const sel = $("#secret-rig-section");
  if (sel) {
    const opts = state.sections
      .map((s) => {
        const on = isSectionActiveOnWheel(state, s);
        const mark = on ? "" : " (off wheel)";
        return `<option value="${s.id}">${escapeHtml(s.label || "Untitled")}${mark}</option>`;
      })
      .join("");
    sel.innerHTML = opts || `<option value="">No sections</option>`;
    if (
      sec.targetSectionId &&
      state.sections.some((s) => s.id === sec.targetSectionId)
    ) {
      sel.value = sec.targetSectionId;
    } else if (state.sections[0]) {
      sel.value = state.sections[0].id;
      sec.targetSectionId = state.sections[0].id;
    }
  }
  const grpSel = $("#secret-rig-group");
  if (grpSel) {
    const opts = state.groups
      .map(
        (g) =>
          `<option value="${g.id}">${escapeHtml(g.name || "Group")}${
            g.active === false ? " (inactive)" : ""
          }</option>`
      )
      .join("");
    grpSel.innerHTML = opts || `<option value="">No groups</option>`;
    if (
      sec.targetGroupId &&
      state.groups.some((g) => g.id === sec.targetGroupId)
    ) {
      grpSel.value = sec.targetGroupId;
    } else if (state.groups[0]) {
      grpSel.value = state.groups[0].id;
      sec.targetGroupId = state.groups[0].id;
    }
  }
  // Do NOT overwrite rig-type select here — that was resetting Group back to Section
  // on every change handler that refilled the dropdowns. Kind is set in bind/tab open.
  updateSecretRigTargetFields();
}

function updateSecretRigTargetFields() {
  const kindEl = $("#secret-rig-target-kind");
  const kind =
    kindEl?.value === "group" || kindEl?.value === "section"
      ? kindEl.value
      : getRigTargetKind();
  const secField = $("#secret-rig-section-field");
  const grpField = $("#secret-rig-group-field");
  if (secField) {
    secField.hidden = kind !== "section";
    secField.style.display = kind === "section" ? "" : "none";
  }
  if (grpField) {
    grpField.hidden = kind !== "group";
    grpField.style.display = kind === "group" ? "" : "none";
  }
}

/** Sync Rig type select from saved state (tab open / unlock only). */
function bindSecretRigKindFromState() {
  const sec = ensureSecretState();
  if ($("#secret-rig-target-kind")) {
    $("#secret-rig-target-kind").value =
      sec.rigTargetKind === "group" ? "group" : "section";
  }
  updateSecretRigTargetFields();
}

function fillSecretReverseSelects() {
  const sec = ensureSecretState();
  const secSel = $("#secret-reverse-section");
  if (secSel) {
    const opts = state.sections
      .map((s) => {
        const on = isSectionActiveOnWheel(state, s);
        const mark = on ? "" : " (off wheel)";
        return `<option value="${s.id}">${escapeHtml(s.label || "Untitled")}${mark}</option>`;
      })
      .join("");
    secSel.innerHTML = opts || `<option value="">No sections</option>`;
    if (
      sec.reverseTargetSectionId &&
      state.sections.some((s) => s.id === sec.reverseTargetSectionId)
    ) {
      secSel.value = sec.reverseTargetSectionId;
    } else if (state.sections[0]) {
      secSel.value = state.sections[0].id;
      sec.reverseTargetSectionId = state.sections[0].id;
    }
  }
  const grpSel = $("#secret-reverse-group");
  if (grpSel) {
    const opts = state.groups
      .map(
        (g) =>
          `<option value="${g.id}">${escapeHtml(g.name || "Group")}${
            g.active === false ? " (inactive)" : ""
          }</option>`
      )
      .join("");
    grpSel.innerHTML = opts || `<option value="">No groups</option>`;
    if (
      sec.reverseTargetGroupId &&
      state.groups.some((g) => g.id === sec.reverseTargetGroupId)
    ) {
      grpSel.value = sec.reverseTargetGroupId;
    } else if (state.groups[0]) {
      grpSel.value = state.groups[0].id;
      sec.reverseTargetGroupId = state.groups[0].id;
    }
  }
  updateSecretReverseTargetFields();
}

function updateSecretReverseTargetFields() {
  const kindEl = $("#secret-reverse-target-kind");
  const kind =
    kindEl?.value === "group" || kindEl?.value === "section"
      ? kindEl.value
      : getReverseTargetKind();
  const secField = $("#secret-reverse-section-field");
  const grpField = $("#secret-reverse-group-field");
  if (secField) {
    secField.hidden = kind !== "section";
    secField.style.display = kind === "section" ? "" : "none";
  }
  if (grpField) {
    grpField.hidden = kind !== "group";
    grpField.style.display = kind === "group" ? "" : "none";
  }
}

function updateSecretTabVisibility() {
  const unlocked = !!ensureSecretState().unlocked;
  const btn = $("#tab-btn-secret");
  const panel = $("#tab-secret");
  if (btn) {
    btn.hidden = !unlocked;
    btn.classList.toggle("hidden", !unlocked);
  }
  if (panel && !unlocked) {
    panel.hidden = true;
    panel.classList.remove("active");
  } else if (panel && unlocked) {
    panel.hidden = false;
  }
}

/** Reveal Secret tab and switch to it (first unlock). */
function unlockSecretTab(switchTo = true) {
  const sec = ensureSecretState();
  sec.unlocked = true;
  persist();
  updateSecretTabVisibility();
  bindSecretRigKindFromState();
  fillSecretSectionSelect();
  fillSecretReverseSelects();
  if ($("#secret-rig-it")) $("#secret-rig-it").checked = !!sec.rigIt;
  bindSecretDivertSfxUI();
  bindSecretReverseUI();
  if (switchTo) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.remove("active");
    });
    $("#tab-btn-secret")?.classList.add("active");
    const panel = $("#tab-secret");
    if (panel) {
      panel.hidden = false;
      panel.classList.add("active");
    }
  }
}

function saveSecretPanel() {
  const sec = ensureSecretState();
  sec.unlocked = true;
  sec.rigIt = $("#secret-rig-it")?.checked === true;
  sec.rigTargetKind =
    $("#secret-rig-target-kind")?.value === "group" ? "group" : "section";
  sec.targetSectionId = $("#secret-rig-section")?.value || null;
  sec.targetGroupId = $("#secret-rig-group")?.value || null;
  sec.muteMusicOnDivert = $("#secret-mute-music-divert")?.checked === true;
  sec.muteSpinTicksOnRig = $("#secret-mute-spin-ticks-rig")?.checked === true;
  sec.comboOrder =
    $("#secret-combo-order")?.value === "rig-first"
      ? "rig-first"
      : "reverse-first";
  const vol = Number($("#secret-divert-sfx-volume")?.value);
  if (Number.isFinite(vol)) {
    sec.divertSfxVolume = Math.min(1, Math.max(0, vol));
  }
  // Reverse rig
  sec.reverseRigIt = $("#secret-reverse-rig-it")?.checked === true;
  sec.reverseTargetKind =
    $("#secret-reverse-target-kind")?.value === "group" ? "group" : "section";
  sec.reverseTargetSectionId = $("#secret-reverse-section")?.value || null;
  sec.reverseTargetGroupId = $("#secret-reverse-group")?.value || null;
  let revSpeed = Math.round(Number($("#secret-reverse-slide-speed")?.value) || 2);
  if (!Number.isFinite(revSpeed)) revSpeed = 2;
  sec.reverseSlideSpeed = Math.min(10, Math.max(1, revSpeed));
  {
    const rp = $("#secret-reverse-slide-sfx-preset")?.value;
    if (rp && REVERSE_SLIDE_PRESET_IDS.has(rp)) {
      sec.reverseSlideSfxPreset = rp === "default" ? "goofy-slip" : rp;
    }
  }
  const revVol = Number($("#secret-reverse-slide-sfx-volume")?.value);
  if (Number.isFinite(revVol)) {
    sec.reverseSlideSfxVolume = Math.min(1, Math.max(0, revVol));
  }
  sec.reverseMuteMusic = $("#secret-reverse-mute-music")?.checked === true;
  sec.reverseMuteSpinTicks =
    $("#secret-reverse-mute-spin-ticks")?.checked === true;
  // divert / reverse SFX data+name set by file input handlers
  persist();
  const resultOpen = !$("#result-actions-bar")?.classList.contains("hidden");
  setResultRiggedVisible(
    isRigItActive() ||
      isReverseRigActive() ||
      (resultOpen && resultShowsRigged)
  );
}

/** Map divert speed 1–10 → glide duration in ms (1=slow, 10=fast). */
function getDivertSteerMs() {
  const sec = ensureSecretState();
  let speed = Number(sec.divertSpeed);
  if (!Number.isFinite(speed)) speed = 5;
  speed = Math.min(10, Math.max(1, Math.round(speed)));
  // 1 → 6.0s (very slow), 5 → ~2.7s, 10 → 0.4s
  const secDur = 6.0 - ((speed - 1) / 9) * 5.6;
  return Math.round(secDur * 1000);
}

/**
 * Reverse slide-off speed 1–10 → ms (defaults slower than forward divert).
 * 1 → 9.0s, 2 → ~8.1s, 10 → 1.2s
 */
function getReverseSteerMs() {
  const sec = ensureSecretState();
  let speed = Number(sec.reverseSlideSpeed);
  if (!Number.isFinite(speed)) speed = 2;
  speed = Math.min(10, Math.max(1, Math.round(speed)));
  const secDur = 9.0 - ((speed - 1) / 9) * 7.8;
  return Math.round(secDur * 1000);
}

function bindSecretDivertSfxUI() {
  const sec = ensureSecretState();
  updateDivertSfxPresetUI();
  const vol = Math.min(
    1,
    Math.max(0, Number(sec.divertSfxVolume) || 0.4)
  );
  if ($("#secret-divert-sfx-volume")) {
    $("#secret-divert-sfx-volume").value = String(vol);
  }
  if ($("#secret-divert-sfx-volume-label")) {
    $("#secret-divert-sfx-volume-label").textContent = `${Math.round(vol * 100)}%`;
  }
  let speed = Number(sec.divertSpeed);
  if (!Number.isFinite(speed)) speed = 5;
  speed = Math.min(10, Math.max(1, Math.round(speed)));
  if ($("#secret-divert-speed")) {
    $("#secret-divert-speed").value = String(speed);
  }
  if ($("#secret-divert-speed-label")) {
    $("#secret-divert-speed-label").textContent = String(speed);
  }
  if ($("#secret-mute-music-divert")) {
    $("#secret-mute-music-divert").checked = !!sec.muteMusicOnDivert;
  }
  if ($("#secret-mute-spin-ticks-rig")) {
    $("#secret-mute-spin-ticks-rig").checked = !!sec.muteSpinTicksOnRig;
  }
  if ($("#secret-combo-order")) {
    $("#secret-combo-order").value =
      sec.comboOrder === "rig-first" ? "rig-first" : "reverse-first";
  }
}

function bindSecretReverseUI() {
  const sec = ensureSecretState();
  if ($("#secret-reverse-rig-it")) {
    $("#secret-reverse-rig-it").checked = !!sec.reverseRigIt;
  }
  if ($("#secret-reverse-target-kind")) {
    $("#secret-reverse-target-kind").value =
      sec.reverseTargetKind === "group" ? "group" : "section";
  }
  fillSecretReverseSelects();
  updateSecretReverseTargetFields();
  let speed = Number(sec.reverseSlideSpeed);
  if (!Number.isFinite(speed)) speed = 2;
  speed = Math.min(10, Math.max(1, Math.round(speed)));
  if ($("#secret-reverse-slide-speed")) {
    $("#secret-reverse-slide-speed").value = String(speed);
  }
  if ($("#secret-reverse-slide-speed-label")) {
    $("#secret-reverse-slide-speed-label").textContent = String(speed);
  }
  updateReverseSlideSfxPresetUI();
  const vol = Math.min(
    1,
    Math.max(0, Number(sec.reverseSlideSfxVolume) || 0.4)
  );
  if ($("#secret-reverse-slide-sfx-volume")) {
    $("#secret-reverse-slide-sfx-volume").value = String(vol);
  }
  if ($("#secret-reverse-slide-sfx-volume-label")) {
    $("#secret-reverse-slide-sfx-volume-label").textContent = `${Math.round(vol * 100)}%`;
  }
  if ($("#secret-reverse-mute-music")) {
    $("#secret-reverse-mute-music").checked = sec.reverseMuteMusic !== false;
  }
  if ($("#secret-reverse-mute-spin-ticks")) {
    $("#secret-reverse-mute-spin-ticks").checked =
      sec.reverseMuteSpinTicks !== false;
  }
}

/** True while BGM was paused for a rig divert (so we can restore it). */
let bgmMutedForDivert = false;
/** True while the last-moment rig divert is in progress. */
let rigDivertActive = false;

/** Bundled default divert sound (used when no custom upload). */
const DEFAULT_DIVERT_SFX = {
  url: "assets/sounds/divert-default.mp3",
  name: "scp-173-concrete-grind-moving.mp3",
};

/**
 * Ensure divert buffer is loaded (custom data URL or bundled default).
 * @returns {Promise<boolean>}
 */
async function ensureDivertSfxBuffer(bufferKey = "rig_divert") {
  const sec = ensureSecretState();
  if (audio.buffers.has(bufferKey) && bufferKey === "rig_divert") {
    // Reload if source type may have changed after clear/upload
  }
  try {
    if (sec.divertSfxData) {
      await audio.loadDataUrl(bufferKey, sec.divertSfxData);
      return true;
    }
    await audio.loadUrl(bufferKey, DEFAULT_DIVERT_SFX.url);
    return true;
  } catch (err) {
    console.warn("Divert SFX load failed:", err);
    return false;
  }
}

function divertSfxDisplayName() {
  const sec = ensureSecretState();
  if (sec.divertSfxData && sec.divertSfxName) return sec.divertSfxName;
  if (sec.divertSfxData) return "Custom audio";
  return `${DEFAULT_DIVERT_SFX.name} (default)`;
}

function getDivertSfxPreset() {
  const sec = ensureSecretState();
  if (sec.divertSfxData) return "custom";
  return "default";
}

function updateDivertSfxPresetUI() {
  const preset = getDivertSfxPreset();
  const sel = $("#secret-divert-sfx-preset");
  if (sel) sel.value = preset;
  const nameEl = $("#secret-divert-sfx-name");
  if (nameEl) {
    nameEl.textContent =
      preset === "custom"
        ? ensureSecretState().divertSfxName ||
          (ensureSecretState().divertSfxData
            ? "Custom divert"
            : "No custom file chosen")
        : divertSfxDisplayName();
  }
  const row = $("#secret-divert-sfx-custom-row");
  if (row) {
    row.hidden = preset !== "custom";
    row.style.display = preset === "custom" ? "" : "none";
  }
}

/** Bundled reverse slide-off samples (Secret → Slide-off SFX). */
const REVERSE_SLIDE_PRESETS = {
  "goofy-slip": {
    id: "goofy-slip",
    url: "assets/sounds/reverse-goofy-slip.mp3",
    name: "Goofy slip",
  },
  "cartoon-slip": {
    id: "cartoon-slip",
    url: "assets/sounds/reverse-cartoon-slip.mp3",
    name: "Cartoon slip",
  },
  "slide-slip": {
    id: "slide-slip",
    url: "assets/sounds/reverse-slide-slip.mp3",
    name: "Slide slip",
  },
  "glass-squeak-3": {
    id: "glass-squeak-3",
    url: "assets/sounds/reverse-glass-squeak-3.mp3",
    name: "Glass rub squeak 3",
  },
  "glass-squeak-2": {
    id: "glass-squeak-2",
    url: "assets/sounds/reverse-glass-squeak-2.mp3",
    name: "Glass rub squeak 2",
  },
  synth: {
    id: "synth",
    url: null,
    name: "Built-in slippery synth",
  },
};

const REVERSE_SLIDE_PRESET_IDS = new Set([
  ...Object.keys(REVERSE_SLIDE_PRESETS),
  "custom",
]);

function reverseSlideSfxDisplayName() {
  const sec = ensureSecretState();
  const preset = getReverseSlideSfxPreset();
  if (preset === "custom") {
    if (sec.reverseSlideSfxData && sec.reverseSlideSfxName) {
      return sec.reverseSlideSfxName;
    }
    if (sec.reverseSlideSfxData) return "Custom slide audio";
    return "Custom file (none chosen)";
  }
  return REVERSE_SLIDE_PRESETS[preset]?.name || "Goofy slip";
}

function getReverseSlideSfxPreset() {
  const sec = ensureSecretState();
  // Prefer live dropdown so UI selection is never ignored
  const live = $("#secret-reverse-slide-sfx-preset")?.value;
  let p = live || sec.reverseSlideSfxPreset;
  if (p === "default") p = "goofy-slip"; // legacy
  if (p && REVERSE_SLIDE_PRESET_IDS.has(p)) {
    if (p === "custom" && !sec.reverseSlideSfxData && live !== "custom") {
      return "goofy-slip";
    }
    return p;
  }
  if (sec.reverseSlideSfxData) return "custom";
  return "goofy-slip";
}

/** Unique audio buffer key per reverse-slide preset (avoids playing a stale sample). */
function reverseSlideBufferKey(preset = getReverseSlideSfxPreset()) {
  if (preset === "synth") return null;
  if (preset === "custom") return "rig_reverse_custom";
  if (REVERSE_SLIDE_PRESETS[preset]) return `rig_reverse_${preset}`;
  return "rig_reverse_goofy-slip";
}

function updateReverseSlideSfxPresetUI() {
  const sec = ensureSecretState();
  // Prefer saved preset when syncing UI (don't fight a mid-change select)
  let preset = sec.reverseSlideSfxPreset || "goofy-slip";
  if (preset === "default") preset = "goofy-slip";
  if (!REVERSE_SLIDE_PRESET_IDS.has(preset)) {
    preset = sec.reverseSlideSfxData ? "custom" : "goofy-slip";
  }
  if (preset === "custom" && !sec.reverseSlideSfxData) preset = "goofy-slip";
  const sel = $("#secret-reverse-slide-sfx-preset");
  if (sel) sel.value = preset;
  const nameEl = $("#secret-reverse-slide-sfx-name");
  if (nameEl) {
    nameEl.textContent =
      preset === "custom"
        ? sec.reverseSlideSfxName ||
          (sec.reverseSlideSfxData ? "Custom slide" : "No custom file chosen")
        : REVERSE_SLIDE_PRESETS[preset]?.name || reverseSlideSfxDisplayName();
  }
  const row = $("#secret-reverse-slide-sfx-custom-row");
  if (row) {
    row.hidden = preset !== "custom";
    row.style.display = preset === "custom" ? "" : "none";
  }
}

function getBgmPreset() {
  return state.sound?.bgmData ? "custom" : "default";
}

function updateBgmPresetUI() {
  const preset = getBgmPreset();
  const sel = $("#bgm-preset");
  if (sel) sel.value = preset;
  const nameEl = $("#bgm-name");
  if (nameEl) {
    nameEl.textContent =
      preset === "custom"
        ? state.sound?.bgmName ||
          (state.sound?.bgmData ? "Custom music" : "No custom file chosen")
        : bgmDisplayName();
  }
  const row = $("#bgm-custom-row");
  if (row) {
    row.hidden = preset !== "custom";
    row.style.display = preset === "custom" ? "" : "none";
  }
}

function updateSectionSfxPresetUI() {
  // Section-owned custom only — not inherited group/global sound
  const isCustom = sectionEditCustom?.sfx === true;
  const sel = $("#section-sfx-preset");
  if (sel) sel.value = isCustom ? "custom" : "default";
  const nameEl = $("#section-sfx-name");
  if (nameEl) {
    nameEl.textContent = isCustom
      ? pendingSectionSfxName ||
        (pendingSectionSfx ? "Custom land SFX" : "No custom file chosen")
      : "From group / default";
  }
  const row = $("#section-sfx-custom-row");
  if (row) {
    row.hidden = !isCustom;
    row.style.display = isCustom ? "" : "none";
  }
}

function updateGroupSfxPresetUI() {
  const hasCustom = !!pendingGroupSfx;
  const sel = $("#group-sfx-preset");
  if (sel) sel.value = hasCustom ? "custom" : "default";
  const nameEl = $("#group-sfx-name");
  if (nameEl) {
    nameEl.textContent = hasCustom
      ? pendingGroupSfxName || "Custom land SFX"
      : "Use global default";
  }
  const row = $("#group-sfx-custom-row");
  if (row) {
    row.hidden = !hasCustom;
    row.style.display = hasCustom ? "" : "none";
  }
}

/**
 * Load reverse slide-off buffer for the current preset (or custom file).
 * Synth preset has no buffer (uses playSlipperySlide).
 * Each preset uses its own buffer key so switching never plays a stale sample.
 * @param {string|null} [bufferKey] force a key; default from current preset
 * @param {boolean} [forceReload] re-fetch even if already buffered
 * @returns {Promise<boolean>} true if a sample buffer is ready
 */
async function ensureReverseSlideSfxBuffer(bufferKey = null, forceReload = false) {
  const sec = ensureSecretState();
  const preset = getReverseSlideSfxPreset();
  const key = bufferKey || reverseSlideBufferKey(preset);
  if (!key) return false;
  try {
    if (forceReload) audio.buffers.delete(key);

    if (preset === "custom") {
      if (!sec.reverseSlideSfxData) return false;
      if (!forceReload && audio.buffers.has(key)) return true;
      await audio.loadDataUrl(key, sec.reverseSlideSfxData);
      return true;
    }
    if (preset === "synth") {
      return false;
    }
    const meta =
      REVERSE_SLIDE_PRESETS[preset] || REVERSE_SLIDE_PRESETS["goofy-slip"];
    if (!meta?.url) return false;
    if (!forceReload && audio.buffers.has(key)) return true;
    // Cache-bust so GH Pages / browsers don't reuse a wrong asset
    const url = `${meta.url}${meta.url.includes("?") ? "&" : "?"}v=${APP_UPDATE}`;
    await audio.loadUrl(key, url);
    return true;
  } catch (err) {
    console.warn("Reverse slide SFX load failed:", err, { preset, key });
    return false;
  }
}

function playRigDivertSfx() {
  const sec = ensureSecretState();
  if (!state.sound?.enabled) return;
  const vol = Math.min(1, Math.max(0, Number(sec.divertSfxVolume) || 0.4));
  audio.ensure();
  const play = () => audio.playDivert("rig_divert", vol);
  if (audio.buffers.has("rig_divert")) {
    play();
  } else {
    ensureDivertSfxBuffer("rig_divert")
      .then((ok) => {
        if (ok) play();
      })
      .catch(() => {});
  }
}

function playReverseSlideSfx() {
  const sec = ensureSecretState();
  if (!state.sound?.enabled) return;
  const vol = Math.min(
    1,
    Math.max(0, Number(sec.reverseSlideSfxVolume) || 0.4)
  );
  audio.ensure();
  // Always re-read preset from state (and live select) at play time
  const preset = getReverseSlideSfxPreset();
  sec.reverseSlideSfxPreset = preset;
  if (preset === "synth") {
    audio.playSlipperySlide(vol);
    return;
  }
  const key = reverseSlideBufferKey(preset);
  const playBuf = () => {
    if (audio.buffers.has(key)) {
      audio.playDivert(key, vol);
      return true;
    }
    return false;
  };
  if (playBuf()) return;
  ensureReverseSlideSfxBuffer(key, true)
    .then((ok) => {
      if (ok && playBuf()) return;
      audio.playSlipperySlide(vol);
    })
    .catch(() => audio.playSlipperySlide(vol));
}

/** Mute BGM for the divert move if Secret option is on. */
function muteMusicForDivertIfNeeded() {
  const sec = ensureSecretState();
  if (!sec.muteMusicOnDivert) return;
  if (!audio.isBgmPlaying) return;
  audio.stopBgm();
  bgmMutedForDivert = true;
}

/** Restore BGM after divert lands / is cancelled. */
function restoreMusicAfterDivertIfNeeded() {
  if (!bgmMutedForDivert) return;
  bgmMutedForDivert = false;
  if (!state.sound?.enabled) return;
  const mode = state.sound.bgmMode;
  if (mode === "always") {
    syncBgm();
  } else if (mode === "spin" && (wheel.spinning || spinBusy)) {
    startBgmForSpin();
  }
  // spin mode after full land: stopBgmAfterSpin will handle stopping
}

/** Clear divert-only audio flags (ticks mute, BGM mute restore). */
function endRigDivertAudio() {
  rigDivertActive = false;
  restoreMusicAfterDivertIfNeeded();
}

function onRigSteerStart() {
  rigDivertActive = true;
  // Pause spin loop SFX for the divert if mute-ticks option is on
  if (ensureSecretState().muteSpinTicksOnRig) {
    stopSpinLoop();
  }
  muteMusicForDivertIfNeeded();
  playRigDivertSfx();
}

function muteMusicForReverseIfNeeded() {
  const sec = ensureSecretState();
  if (sec.reverseMuteMusic === false) return;
  if (!audio.isBgmPlaying) return;
  audio.stopBgm();
  bgmMutedForDivert = true;
}

function onReverseSteerStart() {
  rigDivertActive = true;
  const sec = ensureSecretState();
  if (sec.reverseMuteSpinTicks !== false) {
    stopSpinLoop();
  }
  muteMusicForReverseIfNeeded();
  playReverseSlideSfx();
}

function getSpinRigOptions() {
  // Persist any live secret form state so spin always sees current toggles
  if ($("#tab-secret") && !$("#tab-secret").hidden) {
    try {
      saveSecretPanel();
    } catch {
      /* ignore */
    }
  }
  const forceId = getRigForceSectionId();
  const avoidIds = getReverseAvoidSectionIds();
  const avoidGroupId = getReverseAvoidGroupId();
  return {
    forceSectionId: forceId,
    avoidSectionIds: avoidIds.length ? avoidIds : null,
    /** Expand avoid set on the wheel from live slice group membership */
    avoidGroupId: avoidGroupId || null,
    steerMs: getDivertSteerMs(),
    reverseSteerMs: getReverseSteerMs(),
    comboOrder: getSecretComboOrder(),
    onSteerStart: forceId ? () => onRigSteerStart() : undefined,
    onReverseSteerStart:
      avoidIds.length || avoidGroupId
        ? () => onReverseSteerStart()
        : undefined,
  };
}

function registerRiggedUnlockClicks() {
  const riggedBtn = $("#result-rigged");
  if (!riggedBtn || riggedBtn.dataset.unlockBound === "1") return;
  riggedBtn.dataset.unlockBound = "1";

  const stopStage = (e) => {
    e.stopPropagation();
  };
  for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup"]) {
    riggedBtn.addEventListener(type, stopStage, true);
  }
  riggedBtn.addEventListener(
    "dblclick",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  riggedBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Already unlocked → open Secret tab
    if (ensureSecretState().unlocked) {
      unlockSecretTab(true);
      return;
    }
    const now = performance.now();
    secretRiggedClicks = secretRiggedClicks.filter((t) => now - t < 2500);
    secretRiggedClicks.push(now);
    const n = secretRiggedClicks.length;
    riggedBtn.style.opacity = String(0.45 + Math.min(n, 3) * 0.18);
    if (n >= 3) {
      secretRiggedClicks = [];
      riggedBtn.style.opacity = "";
      unlockSecretTab(true);
    }
  });
}

registerRiggedUnlockClicks();

$("#secret-rig-it")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-rig-target-kind")?.addEventListener("change", () => {
  // Persist kind immediately so refill helpers don't stomp the live selection
  const sec = ensureSecretState();
  sec.rigTargetKind =
    $("#secret-rig-target-kind")?.value === "group" ? "group" : "section";
  fillSecretSectionSelect();
  updateSecretRigTargetFields();
  saveSecretPanel();
});

$("#secret-rig-section")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-rig-group")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-combo-order")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-mute-music-divert")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-mute-spin-ticks-rig")?.addEventListener("change", () => {
  saveSecretPanel();
});

$("#secret-divert-sfx-preset")?.addEventListener("change", async () => {
  const sec = ensureSecretState();
  const v = $("#secret-divert-sfx-preset")?.value;
  if (v === "default") {
    sec.divertSfxData = null;
    sec.divertSfxName = null;
    audio.buffers?.delete?.("rig_divert");
    await ensureDivertSfxBuffer("rig_divert");
  } else if (v === "custom" && !sec.divertSfxData) {
    $("#secret-divert-sfx-input")?.click();
  }
  updateDivertSfxPresetUI();
  persist();
});

$("#secret-divert-sfx-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateDivertSfxPresetUI();
    return;
  }
  const sec = ensureSecretState();
  sec.divertSfxData = await fileToDataUrl(file);
  sec.divertSfxName = file.name;
  audio.buffers?.delete?.("rig_divert");
  await ensureDivertSfxBuffer("rig_divert");
  updateDivertSfxPresetUI();
  persist();
});

$("#secret-divert-sfx-clear")?.addEventListener("click", async () => {
  const sec = ensureSecretState();
  // Back to bundled default (not silent)
  sec.divertSfxData = null;
  sec.divertSfxName = null;
  audio.buffers?.delete?.("rig_divert");
  await ensureDivertSfxBuffer("rig_divert");
  updateDivertSfxPresetUI();
  persist();
});

$("#secret-divert-sfx-volume")?.addEventListener("input", () => {
  const vol = Math.min(
    1,
    Math.max(0, Number($("#secret-divert-sfx-volume")?.value) || 0)
  );
  if ($("#secret-divert-sfx-volume-label")) {
    $("#secret-divert-sfx-volume-label").textContent = `${Math.round(vol * 100)}%`;
  }
  ensureSecretState().divertSfxVolume = vol;
  persist();
});

$("#secret-divert-speed")?.addEventListener("input", () => {
  let speed = Math.round(Number($("#secret-divert-speed")?.value) || 5);
  speed = Math.min(10, Math.max(1, speed));
  ensureSecretState().divertSpeed = speed;
  if ($("#secret-divert-speed-label")) {
    $("#secret-divert-speed-label").textContent = String(speed);
  }
  persist();
});

$("#secret-divert-sfx-preview")?.addEventListener("click", async () => {
  audio.ensure();
  if (audio.isPreviewPlaying) {
    audio.stopPreview();
    return;
  }
  const sec = ensureSecretState();
  const vol = Math.min(1, Math.max(0, Number(sec.divertSfxVolume) || 0.4));
  const ok = await ensureDivertSfxBuffer("preview_rig_divert");
  if (!ok || audio.isPreviewPlaying) return;
  audio.playOneShot("preview_rig_divert", vol, "land", true);
});

// --- Reverse rig it ---
$("#secret-reverse-rig-it")?.addEventListener("change", () => {
  saveSecretPanel();
});
$("#secret-reverse-target-kind")?.addEventListener("change", () => {
  const sec = ensureSecretState();
  sec.reverseTargetKind =
    $("#secret-reverse-target-kind")?.value === "group" ? "group" : "section";
  fillSecretReverseSelects();
  updateSecretReverseTargetFields();
  saveSecretPanel();
});
$("#secret-reverse-section")?.addEventListener("change", () => {
  saveSecretPanel();
});
$("#secret-reverse-group")?.addEventListener("change", () => {
  saveSecretPanel();
});
$("#secret-reverse-mute-music")?.addEventListener("change", () => {
  saveSecretPanel();
});
$("#secret-reverse-mute-spin-ticks")?.addEventListener("change", () => {
  saveSecretPanel();
});
$("#secret-reverse-slide-speed")?.addEventListener("input", () => {
  let speed = Math.round(Number($("#secret-reverse-slide-speed")?.value) || 2);
  speed = Math.min(10, Math.max(1, speed));
  ensureSecretState().reverseSlideSpeed = speed;
  if ($("#secret-reverse-slide-speed-label")) {
    $("#secret-reverse-slide-speed-label").textContent = String(speed);
  }
  persist();
});
async function previewReverseSlideSfxNow() {
  audio.ensure();
  const sec = ensureSecretState();
  const vol = Math.min(
    1,
    Math.max(0, Number(sec.reverseSlideSfxVolume) || 0.4)
  );
  // Stop anything currently previewing so the new pick is obvious
  if (audio.isPreviewPlaying) audio.stopPreview();
  audio.stopDivert?.();

  const preset = getReverseSlideSfxPreset();
  sec.reverseSlideSfxPreset = preset;
  if (preset === "synth") {
    audio.playSlipperySlide(vol, true);
    return;
  }
  const key = reverseSlideBufferKey(preset);
  const ok = await ensureReverseSlideSfxBuffer(key, true);
  if (ok && audio.buffers.has(key)) {
    audio.playOneShot(key, vol, "land", true);
    return;
  }
  audio.playSlipperySlide(vol, true);
}

$("#secret-reverse-slide-sfx-preset")?.addEventListener("change", async () => {
  const sec = ensureSecretState();
  let v = $("#secret-reverse-slide-sfx-preset")?.value;
  if (v === "default") v = "goofy-slip";
  if (!v || !REVERSE_SLIDE_PRESET_IDS.has(v)) v = "goofy-slip";
  sec.reverseSlideSfxPreset = v;
  // Write through immediately so spin / preview never read a stale preset
  persist();
  if (v === "custom" && !sec.reverseSlideSfxData) {
    updateReverseSlideSfxPresetUI();
    $("#secret-reverse-slide-sfx-input")?.click();
    return;
  }
  updateReverseSlideSfxPresetUI();
  // Force reload + auto-preview so changing the dropdown is audible
  try {
    await previewReverseSlideSfxNow();
  } catch (err) {
    console.warn("Reverse slide preview failed:", err);
  }
});
$("#secret-reverse-slide-sfx-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    if (!ensureSecretState().reverseSlideSfxData) {
      ensureSecretState().reverseSlideSfxPreset = "goofy-slip";
    }
    updateReverseSlideSfxPresetUI();
    persist();
    return;
  }
  const sec = ensureSecretState();
  sec.reverseSlideSfxPreset = "custom";
  sec.reverseSlideSfxData = await fileToDataUrl(file);
  sec.reverseSlideSfxName = file.name;
  audio.buffers.delete(reverseSlideBufferKey("custom"));
  await ensureReverseSlideSfxBuffer(reverseSlideBufferKey("custom"), true);
  updateReverseSlideSfxPresetUI();
  persist();
  await previewReverseSlideSfxNow();
});
$("#secret-reverse-slide-sfx-clear")?.addEventListener("click", async () => {
  const sec = ensureSecretState();
  sec.reverseSlideSfxPreset = "goofy-slip";
  sec.reverseSlideSfxData = null;
  sec.reverseSlideSfxName = null;
  audio.buffers.delete(reverseSlideBufferKey("custom"));
  updateReverseSlideSfxPresetUI();
  persist();
  await previewReverseSlideSfxNow();
});
$("#secret-reverse-slide-sfx-volume")?.addEventListener("input", () => {
  const vol = Math.min(
    1,
    Math.max(0, Number($("#secret-reverse-slide-sfx-volume")?.value) || 0)
  );
  if ($("#secret-reverse-slide-sfx-volume-label")) {
    $("#secret-reverse-slide-sfx-volume-label").textContent = `${Math.round(vol * 100)}%`;
  }
  ensureSecretState().reverseSlideSfxVolume = vol;
  persist();
});
$("#secret-reverse-slide-sfx-preview")?.addEventListener("click", async () => {
  audio.ensure();
  if (audio.isPreviewPlaying) {
    audio.stopPreview();
    return;
  }
  await previewReverseSlideSfxNow();
});

async function hideWinnerPart() {
  if (!lastWinnerId) return;
  const section = state.sections.find((s) => s.id === lastWinnerId);
  if (!section) return;
  checkpoint();
  section.enabled = false;
  lastWinnerId = null;
  hideResults();
  persist();
  renderSections();
  await refreshWheel();
}

async function removeWinnerPart() {
  if (!lastWinnerId) return;
  const section = state.sections.find((s) => s.id === lastWinnerId);
  if (!section) return;
  if (!confirm(`Remove "${section.label}" from the wheel permanently?`)) return;
  checkpoint();
  state.sections = state.sections.filter((s) => s.id !== lastWinnerId);
  lastWinnerId = null;
  hideResults();
  persist();
  renderSections();
  await refreshWheel();
}

// Result action buttons (hide / remove / dismiss)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-result-act]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const act = btn.dataset.resultAct;
  if (act === "hide") await hideWinnerPart();
  else if (act === "remove") {
    if (state.look.allowWinnerRemove === false) return;
    await removeWinnerPart();
  } else if (act === "dismiss") hideResults();
});

async function onLookChange() {
  checkpointContinuous();
  state.look.backgroundColor = $("#bg-color").value;
  state.look.centerColor = $("#center-color").value;
  state.look.centerSize = Number($("#center-size").value);
  state.look.borderColor = $("#border-color").value;
  state.look.textColor = $("#text-color").value;
  if ($("#winner-text-color")) {
    state.look.winnerTextColor = $("#winner-text-color").value;
  }
  // forceWinnerTextColor is toggled by the Override button, not these fields
  state.look.showLabels = $("#chk-show-labels").checked;
  state.look.showImages = $("#chk-show-images").checked;
  state.look.resultStyle = $("#result-style").value === "banner" ? "banner" : "center";
  {
    const wl = ($("#winner-label")?.value || "").trim().slice(0, 40);
    state.look.winnerLabel = wl || "Winner";
  }
  state.look.allowWinnerRemove = $("#chk-allow-winner-remove").checked;
  {
    let min = Number($("#weight-slider-min")?.value);
    let max = Number($("#weight-slider-max")?.value);
    let step = Number($("#weight-slider-step")?.value);
    if (!Number.isFinite(min) || min < 0.1) min = 1;
    if (!Number.isFinite(max) || max < 0.1) max = 20;
    if (!Number.isFinite(step) || step <= 0) step = 1;
    if (max < min) {
      const t = min;
      min = max;
      max = t;
    }
    state.look.weightSliderMin = min;
    state.look.weightSliderMax = max;
    state.look.weightSliderStep = step;
  }
  updateWinnerRemoveButton();
  updateWinnerLabelDisplay();
  persist();
  await refreshWheel();
  // Refresh section cards so slider min/max/step update live
  renderSections();
}

["bg-color", "center-color", "center-size", "border-color", "text-color", "winner-text-color", "chk-show-labels", "chk-show-images", "result-style", "winner-label", "chk-allow-winner-remove", "weight-slider-min", "weight-slider-max", "weight-slider-step"].forEach(
  (id) => {
    $(`#${id}`)?.addEventListener("input", onLookChange);
    $(`#${id}`)?.addEventListener("change", () => {
      onLookChange();
      endContinuous();
    });
  }
);

$("#bg-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!isImageFile(file)) {
    alert("Please choose an image or GIF file.");
    return;
  }
  checkpoint();
  state.look.backgroundImage = await fileToDataUrl(file);
  setImgPreview($("#bg-preview"), state.look.backgroundImage);
  persist();
  await refreshWheel();
});

$("#bg-image-clear").addEventListener("click", async () => {
  checkpoint();
  state.look.backgroundImage = null;
  setImgPreview($("#bg-preview"), null);
  persist();
  await refreshWheel();
});

$("#center-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!isImageFile(file)) {
    alert("Please choose an image or GIF file.");
    return;
  }
  checkpoint();
  state.look.centerImage = await fileToDataUrl(file);
  setImgPreview($("#center-preview"), state.look.centerImage);
  persist();
  await refreshWheel();
});

$("#center-image-clear").addEventListener("click", async () => {
  checkpoint();
  state.look.centerImage = null;
  setImgPreview($("#center-preview"), null);
  persist();
  await refreshWheel();
});

// --- Sound tab ---
function volumePct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

function bindSound() {
  $("#chk-sound").checked = state.sound.enabled !== false;
  $("#spin-sfx-mode").value = state.sound.spinMode || "tick";
  const spinVol = state.sound.spinVolume ?? 0.4;
  const landVol = state.sound.landVolume ?? 0.4;
  const bgmVol = state.sound.bgmVolume ?? 0.4;
  $("#spin-sfx-volume").value = spinVol;
  $("#land-sfx-volume").value = landVol;
  $("#bgm-volume").value = bgmVol;
  $("#spin-sfx-volume-label").textContent = volumePct(spinVol);
  $("#land-sfx-volume-label").textContent = volumePct(landVol);
  $("#bgm-volume-label").textContent = volumePct(bgmVol);
  updateSpinTickPresetUI();
  updateLandSfxPresetUI();
  updateBgmPresetUI();
  $("#bgm-mode").value = state.sound.bgmMode || "spin";
  syncBgm();
}

/** Spin duration: slider is 1–30 for quick scrub; number input allows any value. */
const SPIN_DURATION_MIN = 0.1;
const SPIN_DURATION_MAX = 600;
const SPIN_SLIDER_MIN = 1;
const SPIN_SLIDER_MAX = 30;

function clampSpinDuration(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 9;
  return Math.min(SPIN_DURATION_MAX, Math.max(SPIN_DURATION_MIN, v));
}

/** Sync slider + number field from state (slider clamps to its 1–30 range only). */
function syncSpinDurationUI(dur = state.spin.duration) {
  const d = clampSpinDuration(dur);
  state.spin.duration = d;
  const slider = $("#spin-duration");
  const num = $("#spin-duration-input");
  if (num) num.value = String(d);
  if (slider) {
    // Show position on the 1–30 scrub bar; values outside sit at the ends
    const scrub = Math.min(SPIN_SLIDER_MAX, Math.max(SPIN_SLIDER_MIN, d));
    slider.value = String(scrub);
  }
}

function bindSpinDuration() {
  syncSpinDurationUI(state.spin.duration ?? 9);
}

$("#chk-sound").addEventListener("change", () => {
  checkpoint();
  state.sound.enabled = $("#chk-sound").checked;
  if (!state.sound.enabled) {
    stopSpinLoop();
    audio.stopAll();
  } else {
    syncBgm();
  }
  persist();
});

$("#btn-stop-all-audio").addEventListener("click", () => {
  stopSpinLoop();
  audio.stopAll();
});

$("#spin-sfx-mode").addEventListener("change", () => {
  checkpoint();
  state.sound.spinMode = $("#spin-sfx-mode").value;
  persist();
});

$("#spin-tick-preset")?.addEventListener("change", async () => {
  checkpoint();
  const v = $("#spin-tick-preset")?.value;
  if (v === "mixkit" || v === "synth" || v === "custom") {
    state.sound.spinTickPreset = v;
  }
  if (v === "mixkit" || v === "synth") {
    // Keep any uploaded file in storage only while "custom" is selected
    // (don't wipe data so switching back to custom can still use it if present)
  }
  if (v === "custom" && !state.sound.spinSfxData) {
    // Prompt for a file
    $("#spin-sfx-input")?.click();
  }
  audio.buffers.delete("spin");
  await ensureSpinSfxBuffer();
  updateSpinTickPresetUI();
  persist();
});

$("#spin-sfx-volume").addEventListener("input", () => {
  checkpointContinuous();
  state.sound.spinVolume = Number($("#spin-sfx-volume").value);
  $("#spin-sfx-volume-label").textContent = volumePct(state.sound.spinVolume);
  persist();
});
$("#spin-sfx-volume").addEventListener("change", () => endContinuous());

$("#land-sfx-volume").addEventListener("input", () => {
  checkpointContinuous();
  state.sound.landVolume = Number($("#land-sfx-volume").value);
  $("#land-sfx-volume-label").textContent = volumePct(state.sound.landVolume);
  persist();
});
$("#land-sfx-volume").addEventListener("change", () => endContinuous());

$("#spin-duration")?.addEventListener("input", () => {
  checkpointContinuous();
  // Slider only covers 1–30; writing it sets duration in that range
  state.spin.duration = clampSpinDuration($("#spin-duration").value);
  syncSpinDurationUI(state.spin.duration);
  persist();
});
$("#spin-duration")?.addEventListener("change", () => endContinuous());

function applyDurationFromNumberInput(commit) {
  const raw = $("#spin-duration-input")?.value;
  const d = clampSpinDuration(raw);
  if (commit) checkpoint();
  else checkpointContinuous();
  state.spin.duration = d;
  syncSpinDurationUI(d);
  persist();
  if (commit) endContinuous();
}

$("#spin-duration-input")?.addEventListener("input", () => {
  // Live type: don't fight empty/partial input mid-edit
  const raw = $("#spin-duration-input")?.value;
  if (raw === "" || raw === "-" || raw === ".") return;
  const v = Number(raw);
  if (!Number.isFinite(v)) return;
  checkpointContinuous();
  state.spin.duration = clampSpinDuration(v);
  // Update slider only; leave the number field as the user typed
  const slider = $("#spin-duration");
  if (slider) {
    const scrub = Math.min(
      SPIN_SLIDER_MAX,
      Math.max(SPIN_SLIDER_MIN, state.spin.duration)
    );
    slider.value = String(scrub);
  }
  persist();
});

$("#spin-duration-input")?.addEventListener("change", () => {
  applyDurationFromNumberInput(true);
});

$("#spin-duration-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyDurationFromNumberInput(true);
    e.target.blur();
  }
});

$("#spin-sfx-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    // Cancelled custom pick — fall back if no file stored
    if (!state.sound.spinSfxData) {
      state.sound.spinTickPreset = "synth";
      updateSpinTickPresetUI();
      persist();
    }
    return;
  }
  checkpoint();
  state.sound.spinTickPreset = "custom";
  state.sound.spinSfxData = await fileToDataUrl(file);
  state.sound.spinSfxName = file.name;
  audio.buffers.delete("spin");
  await ensureSpinSfxBuffer();
  updateSpinTickPresetUI();
  persist();
});

$("#spin-sfx-clear").addEventListener("click", async () => {
  checkpoint();
  // Clear custom file and switch back to built-in beep
  state.sound.spinTickPreset = "synth";
  state.sound.spinSfxData = null;
  state.sound.spinSfxName = null;
  audio.buffers.delete("spin");
  await ensureSpinSfxBuffer();
  updateSpinTickPresetUI();
  persist();
});

$("#spin-sfx-preview").addEventListener("click", async () => {
  audio.ensure();
  const preset = getSpinTickPreset();
  if (preset === "synth") {
    audio.togglePreview("spin", () => {
      audio.playTick(state.sound.spinVolume, 1, true);
    });
    return;
  }
  if (!audio.buffers.has("spin")) {
    await ensureSpinSfxBuffer();
  }
  audio.togglePreview("spin", () => {
    if (audio.buffers.has("spin")) {
      audio.playOneShot("spin", state.sound.spinVolume, "tick", true);
    } else {
      audio.playTick(state.sound.spinVolume, 1, true);
    }
  });
});

$("#land-sfx-preset")?.addEventListener("change", async () => {
  checkpoint();
  const v = $("#land-sfx-preset")?.value;
  if (v === "default" || v === "victory" || v === "custom") {
    state.sound.landSfxPreset = v;
  }
  if (v === "custom" && !state.sound.landSfxData) {
    $("#land-sfx-input")?.click();
  }
  audio.buffers.delete("land");
  await ensureLandSfxBuffer();
  updateLandSfxPresetUI();
  persist();
});

$("#land-sfx-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    if (!state.sound.landSfxData) {
      state.sound.landSfxPreset = "default";
      updateLandSfxPresetUI();
      persist();
    }
    return;
  }
  checkpoint();
  state.sound.landSfxPreset = "custom";
  state.sound.landSfxData = await fileToDataUrl(file);
  state.sound.landSfxName = file.name;
  audio.buffers.delete("land");
  await ensureLandSfxBuffer();
  updateLandSfxPresetUI();
  persist();
});

$("#land-sfx-clear").addEventListener("click", async () => {
  checkpoint();
  state.sound.landSfxPreset = "default";
  state.sound.landSfxData = null;
  state.sound.landSfxName = null;
  audio.buffers.delete("land");
  await ensureLandSfxBuffer();
  updateLandSfxPresetUI();
  persist();
});

$("#land-sfx-preview").addEventListener("click", async () => {
  audio.ensure();
  const preset = getLandSfxPreset();
  if (preset === "default") {
    audio.togglePreview("land", () => {
      audio.playLandDefault(state.sound.landVolume, true);
    });
    return;
  }
  if (!audio.buffers.has("land")) {
    await ensureLandSfxBuffer();
  }
  audio.togglePreview("land", () => {
    playGlobalLandSfx(state.sound.landVolume, true);
  });
});

// --- Background music ---
$("#bgm-preset")?.addEventListener("change", async () => {
  checkpoint();
  const v = $("#bgm-preset")?.value;
  if (v === "default") {
    state.sound.bgmData = null;
    state.sound.bgmName = null;
    audio.stopBgm();
    audio.buffers.delete("bgm");
    await ensureBgmBuffer();
  } else if (v === "custom" && !state.sound.bgmData) {
    $("#bgm-input")?.click();
  }
  updateBgmPresetUI();
  persist();
  syncBgm();
});

$("#bgm-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    if (!state.sound.bgmData) {
      updateBgmPresetUI();
      persist();
    }
    return;
  }
  checkpoint();
  state.sound.bgmData = await fileToDataUrl(file);
  state.sound.bgmName = file.name;
  audio.buffers.delete("bgm");
  await ensureBgmBuffer();
  updateBgmPresetUI();
  persist();
  syncBgm();
});

$("#bgm-clear").addEventListener("click", async () => {
  checkpoint();
  // Restore bundled default (not silent)
  state.sound.bgmData = null;
  state.sound.bgmName = null;
  audio.stopBgm();
  audio.buffers.delete("bgm");
  await ensureBgmBuffer();
  updateBgmPresetUI();
  persist();
  syncBgm();
});

$("#bgm-preview").addEventListener("click", async () => {
  audio.ensure();
  if (!audio.buffers.has("bgm")) {
    const ok = await ensureBgmBuffer();
    if (!ok) {
      alert("Could not load music.");
      return;
    }
  }
  audio.togglePreview("bgm", () => {
    audio.playOneShot("bgm", state.sound.bgmVolume ?? 0.4, "land", true);
  });
});

$("#bgm-mode").addEventListener("change", () => {
  checkpoint();
  state.sound.bgmMode = $("#bgm-mode").value;
  persist();
  // Ensure context is ready before starting continuous music
  if (state.sound.bgmMode === "always") audio.ensure();
  syncBgm();
});

$("#bgm-volume").addEventListener("input", () => {
  checkpointContinuous();
  state.sound.bgmVolume = Number($("#bgm-volume").value);
  $("#bgm-volume-label").textContent = volumePct(state.sound.bgmVolume);
  audio.setBgmVolume(state.sound.bgmVolume);
  persist();
});
$("#bgm-volume").addEventListener("change", () => endContinuous());

function stopSpinLoop() {
  audio.stopLoop();
}

function startSpinLoopIfNeeded() {
  if (!state.sound.enabled) return;
  const mode = state.sound.spinMode;
  if (mode !== "loop" && mode !== "both") return;
  // Synth has no sample loop
  if (getSpinTickPreset() === "synth") return;
  if (audio.buffers.has("spin")) {
    audio.startLoop("spin", state.sound.spinVolume);
  } else {
    ensureSpinSfxBuffer().then((ok) => {
      if (ok && (wheel.spinning || spinBusy)) {
        audio.startLoop("spin", state.sound.spinVolume);
      }
    });
  }
}

// --- Fullscreen wheel: hide editor tabs/sidebar ---
function setSidebarCollapsed(collapsed) {
  const layout = $("#main-layout");
  const btn = $("#btn-toggle-sidebar");
  if (!layout || !btn) return;
  layout.classList.toggle("sidebar-collapsed", collapsed);
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.title = collapsed
    ? "Show panels"
    : "Hide panels (fullscreen wheel)";
  const label = btn.querySelector(".toggle-sidebar-label");
  if (label) label.textContent = collapsed ? "Show panels" : "Hide panels";
  // Let layout settle, then redraw wheel to new size
  requestAnimationFrame(() => {
    wheel.resize();
    requestAnimationFrame(() => wheel.resize());
  });
}

$("#btn-toggle-sidebar")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const layout = $("#main-layout");
  const collapsed = !layout?.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
});

// --- Spin (double-click / drag-fling the wheel) ---

async function beginSpinSession() {
  audio.ensure();
  const active = getActiveSections(state);
  if (!active.length) {
    alert("No active sections. Enable at least one section in an active group.");
    return false;
  }
  spinBusy = true;
  hideResults();
  startSpinLoopIfNeeded();
  startBgmForSpin();
  return true;
}

function endSpinSession() {
  stopSpinLoop();
  audio.stopDivert();
  endRigDivertAudio();
  stopBgmAfterSpin();
  spinBusy = false;
}

async function doSpin() {
  if (spinBusy || wheel.spinning || wheel._dragging) return;
  if (!(await beginSpinSession())) return;
  try {
    const rig = getSpinRigOptions();
    const win = await wheel.spin(clampSpinDuration(state.spin.duration), rig);
    // null = grab-interrupted mid-spin (user took over with drag)
    if (win) {
      showResult(win, {
        rigged:
          !!rig.forceSectionId ||
          !!(rig.avoidSectionIds && rig.avoidSectionIds.length),
      });
    }
  } finally {
    endSpinSession();
  }
}

async function doFling(velocityRadPerSec) {
  // Allow fling after grab-stop even if a previous session is cleaning up
  if (wheel.spinning || wheel._dragging) return;
  if (spinBusy) {
    // Previous spin was interrupted by grab; session already ending
    spinBusy = false;
  }
  if (!(await beginSpinSession())) return;
  try {
    const rig = getSpinRigOptions();
    const win = await wheel.fling(velocityRadPerSec, rig);
    // Fling is always "rigged" label; also when secret Rig it is on
    if (win) showResult(win, { rigged: true });
  } finally {
    endSpinSession();
  }
}

// Dismiss center overlay by clicking the dimmed backdrop (not buttons / text card)
resultCenter.addEventListener("click", (e) => {
  if (e.target === resultCenter) hideResults();
});

// --- Import / Export / Reset ---
$("#btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spin-wheel-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#btn-import").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const { data, source } = parseImportFile(text, file.name);
    if (!data.sections || !data.groups) throw new Error("Invalid project file");
    const asNew = confirm(
      "Import as a NEW wheel?\n\nOK = keep current wheel and import into a new one\nCancel = replace the current wheel"
    );
    if (asNew) {
      library = writeActiveState(library, state);
      const baseName = (file.name || "Imported").replace(
        /\.(json|wheel|txt|csv|tsv)$/i,
        ""
      );
      const result = addWheel(library, baseName, data);
      await applyLoadedWheel(result.lib, result.state);
    } else {
      checkpoint();
      state = hydrateState(data);
      persist();
      bindAll();
      await preloadAudio();
      await refreshWheel();
    }
    if (source === "wheel-of-names") {
      console.info(
        `Imported ${state.sections.length} section(s) from Wheel of Names`
      );
    }
  } catch (err) {
    alert("Import failed: " + (err.message || err));
  }
});

$("#btn-reset").addEventListener("click", async () => {
  if (
    !confirm(
      "Reset this wheel to defaults? Your other saved wheels are not affected. You can Undo while the app stays open."
    )
  )
    return;
  checkpoint();
  state = defaultState();
  persist();
  bindAll();
  await preloadAudio();
  await refreshWheel();
});

// --- Multi-wheel switcher ---
$("#wheel-select")?.addEventListener("change", async (e) => {
  const id = e.target.value;
  if (!id || id === library.activeId) {
    fillWheelSelect();
    return;
  }
  try {
    await switchToWheelId(id);
  } catch (err) {
    console.error(err);
    alert("Could not switch wheel: " + (err.message || err));
    fillWheelSelect();
  }
});

$("#btn-wheel-new")?.addEventListener("click", () => {
  createNewWheel().catch((err) => alert(err.message || err));
});

$("#btn-wheel-dup")?.addEventListener("click", () => {
  duplicateCurrentWheel().catch((err) => alert(err.message || err));
});

$("#btn-wheel-rename")?.addEventListener("click", () => {
  renameCurrentWheel();
});

$("#btn-wheel-delete")?.addEventListener("click", () => {
  deleteCurrentWheel().catch((err) => alert(err.message || err));
});

$("#btn-undo").addEventListener("click", () => {
  performUndo();
});

document.addEventListener("keydown", (e) => {
  // Ctrl+Z / Cmd+Z — skip when typing in fields (except we still allow undo globally for convenience;
  // only skip if user is mid-composition in a text field and wants local undo... use Ctrl+Z always for app undo
  // when not in a native text undo context that would conflict - actually for Electron, Ctrl+Z in input
  // should be native. So only trigger when not in editable fields.)
  const isMod = e.ctrlKey || e.metaKey;
  if (!isMod || e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  const editable =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (e.target && e.target.isContentEditable);
  if (editable) return;
  e.preventDefault();
  performUndo();
});

function bindAll() {
  bindLook();
  bindSound();
  bindSpinDuration();
  renderSections();
  renderGroups();
  updateSecretTabVisibility();
  if (ensureSecretState().unlocked) {
    fillSecretSectionSelect();
    fillSecretReverseSelects();
    if ($("#secret-rig-it")) {
      $("#secret-rig-it").checked = !!state.secret.rigIt;
    }
    bindSecretDivertSfxUI();
    bindSecretReverseUI();
    ensureDivertSfxBuffer("rig_divert").catch(() => {});
    ensureReverseSlideSfxBuffer("rig_reverse_slide").catch(() => {});
  }
  updateUndoButton();
}

// --- Boot ---
/** Clear anything that can swallow clicks (stuck overlays / dialogs / drag). */
function forceUiInteractive() {
  try {
    document
      .querySelectorAll("dialog[open]")
      .forEach((d) => {
        try {
          d.close();
        } catch {
          d.removeAttribute("open");
        }
      });
  } catch {
    /* ignore */
  }
  try {
    resultBanner?.classList?.add("hidden");
    resultCenter?.classList?.add("hidden");
    resultActionsBar?.classList?.add("hidden");
  } catch {
    /* ignore */
  }
  try {
    document.body.classList.remove("group-drag-cursor");
    document.querySelectorAll(".group-drag-ghost").forEach((g) => g.remove());
    groupsList?.classList?.remove("is-reordering");
  } catch {
    /* ignore */
  }
  try {
    if (wheel) {
      wheel._dragging = false;
      wheel._dragPointerId = null;
      if (wheel._dragEl) wheel._dragEl.style.cursor = "grab";
    }
  } catch {
    /* ignore */
  }
  spinBusy = false;
}

async function init() {
  const verEl = $("#app-version");
  if (verEl) {
    verEl.textContent = `#${APP_UPDATE}`;
    verEl.title = `Update #${APP_UPDATE}`;
  }
  forceUiInteractive();
  try {
    fillWheelSelect();
  } catch (err) {
    console.warn("fillWheelSelect:", err);
  }
  try {
    bindAll();
  } catch (err) {
    console.warn("bindAll:", err);
  }
  try {
    updateSectionsCount();
    updateUndoButton();
  } catch {
    /* ignore */
  }
  try {
    wheel.resize();
  } catch (err) {
    console.warn("wheel.resize:", err);
  }
  try {
    await preloadAudio();
  } catch (err) {
    console.warn("preloadAudio:", err);
  }
  try {
    await refreshWheel();
  } catch (err) {
    console.warn("refreshWheel:", err);
  }
  forceUiInteractive();
  updateSectionsCount();
  fillWheelSelect();
  // Continuous BGM waits for a user gesture (browser autoplay rules);
  // first SPIN / Sound interaction will start it via syncBgm / startBgmForSpin.
  try {
    syncBgm();
  } catch {
    /* ignore */
  }
  const stage = $("#stage");
  const spinTarget = stage || wheelCanvas;
  if (spinTarget) {
    // Double-click: timed random spin (ignore UI chrome / rigged badge)
    spinTarget.addEventListener("dblclick", (e) => {
      if (
        e.target.closest?.(
          "#result-rigged, .result-actions-bar, .result-center-inner, .result-banner, .btn-toggle-sidebar, button, a, input, select, textarea"
        )
      ) {
        return;
      }
      doSpin();
    });
    // Drag to aim; grab mid-spin to stop; release quickly to fling
    try {
      wheel.enablePointerDrag(spinTarget, {
        canStart: () =>
          !wheel._dragging && getActiveSections(state).length > 0,
        onDragStart: ({ interrupted } = {}) => {
          audio.ensure();
          hideResults();
          // Grabbed during spin — stop spin SFX / divert immediately
          if (interrupted) {
            stopSpinLoop();
            audio.stopDivert();
            endRigDivertAudio();
          }
        },
        onFling: (vel) => {
          doFling(vel);
        },
        onDragEndIdle: () => {
          // Left the wheel parked without a fling after a grab
          stopSpinLoop();
          stopBgmAfterSpin();
        },
      });
    } catch (err) {
      console.warn("enablePointerDrag:", err);
    }
  }
}

init().catch((err) => {
  console.error("App init failed:", err);
  forceUiInteractive();
});
