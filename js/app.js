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
  clampImageRotation,
  normalizeLandAction,
  normalizeLandShowResultUnit,
  landShowResultMs,
  normalizeWinBgm,
  normalizeReturnAfterMs,
  normalizeReturnsAt,
  normalizeTextStyle,
  normalizeTextFont,
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
  clearAllWheels,
  duplicateWheel,
} from "./wheels.js";
import { AudioManager } from "./audio.js";
import { Wheel } from "./wheel.js";
import {
  computeFillImageBox,
  computeFillImageLayout,
  normalizeImageLayoutMode,
} from "./slice-image-layout.js";
import { drawSliceLabel } from "./slice-labels.js";
import { parseImportFile } from "./import-converters.js";
import {
  WHEEL_PRESETS,
  getWheelPreset,
  resolvePresetId,
  buildPresetState,
  blankWheelState,
  shuffledSolidWheelColors,
} from "./presets.js";
import { APP_UPDATE } from "./version.js";
import { createMultiSpinController } from "./multi-spin.js";

const audio = new AudioManager();
/** @type {import("./wheels.js").WheelLibrary | ReturnType<typeof loadLibrary>} */
let library;
let state;
/** @type {ReturnType<typeof createMultiSpinController> | null} */
let multiSpin = null;
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

// --- In-app dialogs (Electron does not support window.prompt) ---
const isElectronShell = /Electron/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent || "" : ""
);

/**
 * Show a modal dialog. Modes: "alert" | "confirm" | "prompt".
 * @param {{
 *   mode?: "alert"|"confirm"|"prompt",
 *   title?: string,
 *   message?: string,
 *   defaultValue?: string,
 *   okLabel?: string,
 *   cancelLabel?: string,
 * }} opts
 * @returns {Promise<string|boolean|null>}
 *   alert → true; confirm → boolean; prompt → string | null (cancel)
 */
function showAppDialog(opts = {}) {
  const mode = opts.mode === "confirm" || opts.mode === "prompt" ? opts.mode : "alert";
  const dlg = $("#app-dialog");
  const form = $("#app-dialog-form");
  const titleEl = $("#app-dialog-title");
  const msgEl = $("#app-dialog-message");
  const inputWrap = $("#app-dialog-input-wrap");
  const inputEl = $("#app-dialog-input");
  const okBtn = $("#app-dialog-ok");
  const cancelBtn = $("#app-dialog-cancel");

  // Fallback if dialog markup is missing
  if (!dlg || !form) {
    if (mode === "prompt") {
      try {
        return Promise.resolve(window.prompt(opts.message || "", opts.defaultValue ?? ""));
      } catch {
        return Promise.resolve(opts.defaultValue ?? "");
      }
    }
    if (mode === "confirm") {
      try {
        return Promise.resolve(window.confirm(opts.message || ""));
      } catch {
        return Promise.resolve(false);
      }
    }
    try {
      window.alert(opts.message || "");
    } catch {
      /* ignore */
    }
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const title =
      opts.title ||
      (mode === "prompt" ? "Enter a value" : mode === "confirm" ? "Confirm" : "Notice");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = opts.message || "";
    if (okBtn) okBtn.textContent = opts.okLabel || "OK";
    if (cancelBtn) {
      cancelBtn.textContent = opts.cancelLabel || "Cancel";
      cancelBtn.hidden = mode === "alert";
    }
    if (inputWrap && inputEl) {
      const showInput = mode === "prompt";
      inputWrap.hidden = !showInput;
      if (showInput) {
        inputEl.value = opts.defaultValue != null ? String(opts.defaultValue) : "";
      }
    }

    const finish = (value) => {
      form.removeEventListener("submit", onSubmit);
      cancelBtn?.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onEscape);
      try {
        if (dlg.open) dlg.close();
      } catch {
        dlg.removeAttribute("open");
      }
      resolve(value);
    };

    const onSubmit = (e) => {
      e.preventDefault();
      if (mode === "prompt") finish(inputEl?.value ?? "");
      else if (mode === "confirm") finish(true);
      else finish(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      if (mode === "prompt") finish(null);
      else if (mode === "confirm") finish(false);
      else finish(true);
    };
    const onEscape = (e) => {
      e.preventDefault();
      onCancel(e);
    };

    form.addEventListener("submit", onSubmit);
    cancelBtn?.addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onEscape);

    try {
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    } catch {
      dlg.setAttribute("open", "");
    }
    requestAnimationFrame(() => {
      if (mode === "prompt" && inputEl) {
        inputEl.focus();
        inputEl.select?.();
      } else {
        okBtn?.focus?.();
      }
    });
  });
}

/** @param {string} message @param {string} [title] */
function appAlert(message, title = "Notice") {
  return showAppDialog({ mode: "alert", message: String(message ?? ""), title }).then(
    () => undefined
  );
}

/** @param {string} message @param {string} [title] @returns {Promise<boolean>} */
function appConfirm(message, title = "Confirm") {
  return showAppDialog({
    mode: "confirm",
    message: String(message ?? ""),
    title,
  }).then((v) => v === true);
}

/**
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {string} [title]
 * @returns {Promise<string|null>} null if cancelled
 */
function appPrompt(message, defaultValue = "", title = "Enter a value") {
  return showAppDialog({
    mode: "prompt",
    message: String(message ?? ""),
    defaultValue: defaultValue != null ? String(defaultValue) : "",
    title,
  }).then((v) => (v === null ? null : String(v)));
}

/**
 * Prefer in-app prompt in Electron (and any environment where native prompt fails).
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {string} [title]
 */
async function safePrompt(message, defaultValue = "", title = "Enter a value") {
  if (isElectronShell) return appPrompt(message, defaultValue, title);
  try {
    const v = window.prompt(message, defaultValue);
    return v;
  } catch {
    return appPrompt(message, defaultValue, title);
  }
}

/**
 * Prefer in-app confirm in Electron for reliability.
 * @param {string} message
 * @param {string} [title]
 */
async function safeConfirm(message, title = "Confirm") {
  if (isElectronShell) return appConfirm(message, title);
  try {
    return window.confirm(message);
  } catch {
    return appConfirm(message, title);
  }
}

/**
 * Prefer in-app alert in Electron when native alert is awkward / blocked.
 * @param {string} message
 * @param {string} [title]
 */
async function safeAlert(message, title = "Notice") {
  if (isElectronShell) return appAlert(message, title);
  try {
    window.alert(message);
  } catch {
    await appAlert(message, title);
  }
}

/** @type {string|null} */
let lastWinnerId = null;
/** Current sections search query */
let sectionSearchQuery = "";
/**
 * Section list sort / view mode.
 * "manual" = Your order (state.yourOrderIds — permanent custom order).
 * Other modes = temporary views on list + wheel; do not overwrite Your order
 * unless the user clicks “Apply to your order”.
 */
const SECTION_SORT_KEY = "spin-wheel-section-sort";
/** @type {Record<string, string>} */
const SECTION_SORT_LABELS = {
  manual: "Your order",
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
  "weight-desc": "Weight high → low",
  "weight-asc": "Weight low → high",
  group: "Group",
  "on-wheel": "On wheel first",
  enabled: "Enabled first",
  "has-image": "Has image first",
};
let sectionSortMode = "manual";
/** True when current view order was hand-tweaked away from the pure sort. */
let sectionSortDirty = false;
try {
  const saved = localStorage.getItem(SECTION_SORT_KEY);
  if (saved && SECTION_SORT_LABELS[saved]) sectionSortMode = saved;
} catch {
  /* ignore */
}

/** True when section cards show a grip and can be dragged to reorder the wheel. */
function canReorderSections() {
  return (
    !String(sectionSearchQuery || "").trim() &&
    Array.isArray(state.sections) &&
    state.sections.length >= 2
  );
}

const wheel = new Wheel(wheelCanvas, bgCanvas, {
  overlayCanvas: $("#wheel-overlay"),
  bgMediaEl: $("#bg-media"),
  sliceRotatorEl: $("#slice-media-rotator"),
  centerMediaEl: $("#center-media"),
  pointerEl: $("#pointer"),
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
/** Read live UI toggles into state before save/share (e.g. Hide panels). */
function syncUiPrefsIntoState() {
  if (!state?.look) return;
  const layout = $("#main-layout");
  if (layout) {
    state.look.hidePanels = layout.classList.contains("sidebar-collapsed");
  }
}

/** Show storage-full alert at most once per page load (not every Save click). */
let storageFullAlertShown = false;

/**
 * Alert once when browser storage cannot hold a save.
 * Subsequent failed saves stay quiet (meter still updates).
 */
function warnStorageFullOnce() {
  if (storageFullAlertShown) return;
  storageFullAlertShown = true;
  alert(
    "You're running out of browser storage (or it's full). " +
      "This change may not have been saved.\n\n" +
      "Try removing large images, deleting unused wheels, or use Backup / Export JSON."
  );
}

function persist() {
  syncUiPrefsIntoState();
  library = writeActiveState(library, state);
  const ok = saveLibrary(library);
  if (!ok) {
    console.warn("Save failed — browser storage may be full");
    warnStorageFullOnce();
  }
  updateUndoButton();
  fillWheelSelect();
  updateStorageMeter();
  updateShareButtonHint();
  return ok;
}

/** Expand collapsible block(s) that contain this element so the user can see it. */
function expandCollapsibleContaining(el) {
  if (!el) return;
  let node = el.parentElement;
  while (node) {
    if (node.classList?.contains("collapsible-block") && node.classList.contains("is-collapsed")) {
      node.classList.remove("is-collapsed");
      const btn = node.querySelector(":scope > .collapsible-toggle");
      if (btn) btn.setAttribute("aria-expanded", "true");
    }
    node = node.parentElement;
  }
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
  // Delete stays enabled always: click removes the current wheel (if >1),
  // hold 5s wipes the whole library even when only one remains.
  const del = $("#btn-wheel-delete");
  if (del) del.disabled = false;
  try {
    multiSpin?.onLibraryChanged?.();
  } catch {
    /* ignore */
  }
}

// --- Storage size meter (estimate localStorage pressure) ---
/** Practical localStorage budget most browsers allow per origin. */
const STORAGE_SOFT_LIMIT_BYTES = 5 * 1024 * 1024;

function formatStorageBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) {
    const kb = v / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  }
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 byte length of JSON (approx. localStorage cost). */
function estimateJsonBytes(obj) {
  try {
    return new Blob([JSON.stringify(obj ?? null)]).size;
  } catch {
    try {
      return new TextEncoder().encode(JSON.stringify(obj ?? null)).length;
    } catch {
      return String(JSON.stringify(obj ?? null) || "").length;
    }
  }
}

/**
 * Update “This wheel: X · Storage: Y / ~5 MB” meter.
 * Uses library + history size (what we actually write to localStorage).
 */
function updateStorageMeter() {
  const el = $("#storage-meter");
  if (!el) return;
  try {
    const wheelBytes = estimateJsonBytes(state);
    let libSnapshot = library;
    try {
      libSnapshot = writeActiveState(library, state);
    } catch {
      /* use existing library */
    }
    const libBytes = estimateJsonBytes({
      activeId: libSnapshot?.activeId,
      wheels: (libSnapshot?.wheels || []).map((w) => ({
        id: w.id,
        name: w.name,
        updatedAt: w.updatedAt,
        data: w.data,
      })),
    });
    let histBytes = 0;
    try {
      histBytes = estimateJsonBytes(loadSpinHistory());
    } catch {
      /* ignore */
    }
    const used = libBytes + histBytes;
    const pct = Math.min(
      100,
      Math.round((used / STORAGE_SOFT_LIMIT_BYTES) * 100)
    );
    el.textContent = `This wheel: ${formatStorageBytes(wheelBytes)} · Storage: ${formatStorageBytes(used)} / ~5 MB`;
    el.title =
      `Estimated browser storage for saved wheels + history.\n` +
      `This wheel ≈ ${formatStorageBytes(wheelBytes)} · Library ≈ ${formatStorageBytes(libBytes)} · History ≈ ${formatStorageBytes(histBytes)}.\n` +
      `Browsers often allow ~5 MB total. Large images fill this fast — Export JSON or remove images if save fails.`;
    el.classList.toggle("storage-warn", pct >= 70 && pct < 90);
    el.classList.toggle("storage-danger", pct >= 90);
  } catch (err) {
    console.warn("storage meter:", err);
    el.textContent = "";
  }
}

/** Share button tooltip when wheel has media (hosted links expire). */
function updateShareButtonHint() {
  const btn = $("#btn-share-wheel");
  if (!btn) return;
  const hasMedia = payloadHasImages({ data: state });
  btn.title = hasMedia
    ? "Copy a share link (includes images; hosted link may expire ~24h — use Export JSON to keep forever)"
    : "Copy a share link for this wheel (prompt also shows the link)";
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
  winBgmOverrideActive = false;
  hideResults();
  saveLibrary(library);
  fillWheelSelect();
  bindAll();
  updateSectionsCount();
  updateUndoButton();
  try {
    processSectionReturns({ refresh: false, persist: true });
  } catch (err) {
    console.warn("section returns on wheel load:", err);
  }
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

/**
 * Create a new saved wheel from a preset (keeps the current one).
 * @param {string} [presetId="default"]
 */
async function createNewWheelFromPreset(presetId = "default") {
  library = writeActiveState(library, state);
  const preset = getWheelPreset(presetId) || getWheelPreset("default");
  if (!preset) return;
  const suggested =
    preset.defaultName || `Wheel ${library.wheels.length + 1}`;
  const name = await safePrompt(
    "Name for the new wheel:",
    suggested,
    "New wheel"
  );
  if (name === null) return; // cancelled
  let fromState;
  try {
    fromState = buildPresetState(preset.id);
  } catch (err) {
    console.error("Preset build failed:", err);
    await safeAlert("Could not build that preset. Using default instead.");
    fromState = buildPresetState("default");
  }
  const result = addWheel(library, name || suggested, fromState);
  await applyLoadedWheel(result.lib, result.state);
}

/** @deprecated use createNewWheelFromPreset — kept for any old callers */
async function createNewWheel() {
  return createNewWheelFromPreset("default");
}

function closeWheelNewMenu() {
  const menu = $("#wheel-new-menu");
  const btn = $("#btn-wheel-new");
  const wrap = $("#wheel-new-dropdown");
  if (menu) {
    menu.classList.add("hidden");
    menu.hidden = true;
  }
  if (btn) btn.setAttribute("aria-expanded", "false");
  wrap?.classList?.remove("is-open");
}

function openWheelNewMenu() {
  const menu = $("#wheel-new-menu");
  const btn = $("#btn-wheel-new");
  const wrap = $("#wheel-new-dropdown");
  if (!menu || !btn) return;
  // Rebuild so future presets appear without reload
  menu.innerHTML = WHEEL_PRESETS.map(
    (p) => `
    <button type="button" class="wheel-new-menu-item" role="menuitem" data-preset="${escapeHtml(p.id)}">
      <span class="wheel-new-menu-item-name">${escapeHtml(p.name)}</span>
      <span class="wheel-new-menu-item-desc">${escapeHtml(p.description || "")}</span>
    </button>`
  ).join("");
  menu.classList.remove("hidden");
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  wrap?.classList?.add("is-open");
}

function toggleWheelNewMenu() {
  const menu = $("#wheel-new-menu");
  if (!menu || menu.hidden || menu.classList.contains("hidden")) {
    openWheelNewMenu();
  } else {
    closeWheelNewMenu();
  }
}

function bindWheelNewMenu() {
  const btn = $("#btn-wheel-new");
  const menu = $("#wheel-new-menu");
  if (!btn || !menu || btn.dataset.presetMenuBound === "1") return;
  btn.dataset.presetMenuBound = "1";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWheelNewMenu();
  });

  menu.addEventListener("click", (e) => {
    const item = e.target.closest?.("[data-preset]");
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const id = item.getAttribute("data-preset") || "default";
    closeWheelNewMenu();
    createNewWheelFromPreset(id).catch((err) =>
      safeAlert(err.message || String(err))
    );
  });

  document.addEventListener(
    "click",
    (e) => {
      const wrap = $("#wheel-new-dropdown");
      if (!wrap || wrap.contains(e.target)) return;
      closeWheelNewMenu();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeWheelNewMenu();
  });
}

async function duplicateCurrentWheel() {
  library = writeActiveState(library, state);
  const result = duplicateWheel(library, library.activeId);
  if (!result) return;
  await applyLoadedWheel(result.lib, result.state);
}

async function renameCurrentWheel() {
  const slot = getActiveSlot(library);
  const name = await safePrompt(
    "Rename wheel:",
    slot.name || "My wheel",
    "Rename wheel"
  );
  if (name === null) return;
  library = writeActiveState(library, state);
  library = renameWheel(library, library.activeId, name);
  saveLibrary(library);
  fillWheelSelect();
}

/**
 * Replace the active wheel with a fresh Blank preset (no sections, preset name).
 */
async function clearActiveWheelToBlank() {
  try {
    wheel.cancelAnimatedSpin?.();
  } catch {
    /* ignore */
  }
  const preset = getWheelPreset("blank");
  const blank = blankWheelState();
  const name = preset?.defaultName || "New wheel";
  library = writeActiveState(library, blank);
  library = renameWheel(library, library.activeId, name);
  await applyLoadedWheel(library, blank);
}

async function deleteCurrentWheel() {
  const slot = getActiveSlot(library);
  // Only one saved wheel: replace with Blank preset (empty, renamed).
  if (library.wheels.length <= 1) {
    if (
      !(await safeConfirm(
        `Delete wheel “${slot.name}”?\n\nYou will be switched to a new Blank wheel (no sections).\n\nTip: hold Delete for 5 seconds to erase all saved wheels.`,
        "Delete wheel"
      ))
    ) {
      return;
    }
    await clearActiveWheelToBlank();
    return;
  }
  if (
    !(await safeConfirm(
      `Delete wheel “${slot.name}”? This cannot be undone.\nYour other wheels stay saved.\n\nTip: hold Delete for 5 seconds to erase all saved wheels.`,
      "Delete wheel"
    ))
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

/** Hold Delete 5s — wipe entire library and load one empty blank wheel. */
async function deleteAllSavedWheels() {
  const n = library.wheels?.length || 0;
  const names = (library.wheels || [])
    .map((w) => w.name || "Untitled")
    .slice(0, 8);
  const list =
    names.length > 0
      ? `\n\n${names.map((x) => `• ${x}`).join("\n")}${n > 8 ? `\n• …and ${n - 8} more` : ""}`
      : "";
  if (
    !(await safeConfirm(
      `Delete ALL ${n} saved wheel${n === 1 ? "" : "s"}? This cannot be undone.${list}\n\nYou will be left with a new Blank wheel (no sections).`,
      "Delete all wheels"
    ))
  ) {
    return;
  }
  try {
    wheel.cancelAnimatedSpin?.();
  } catch {
    /* ignore */
  }
  const blankName = getWheelPreset("blank")?.defaultName || "New wheel";
  const fresh = clearAllWheels(blankName, blankWheelState());
  const slot = getActiveSlot(fresh);
  await applyLoadedWheel(fresh, hydrateState(slot.data));
  await safeAlert(
    "All saved wheels were deleted. You have a new Blank wheel (no sections)."
  );
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
    if (normalizeWinBgm(s.winBgm) === "custom" && s.winBgmData) {
      try {
        await audio.loadDataUrl(`bgm_sec_${s.id}`, s.winBgmData);
      } catch (err) {
        console.warn("section win BGM preload:", err);
      }
    }
  }
  for (const g of state.groups) {
    if (g.landSfxData) {
      await audio.loadDataUrl(`land_grp_${g.id}`, g.landSfxData);
    }
  }
}

/** True while a section win has replaced the wheel BGM. */
let winBgmOverrideActive = false;

/**
 * Keep continuous BGM in sync with settings (always mode).
 * Does not start spin-only BGM — that starts with a spin.
 */
function syncBgm() {
  if (!state.sound.enabled || state.sound.bgmMode === "off") {
    audio.stopBgm();
    winBgmOverrideActive = false;
    return;
  }
  // Don't clobber a section win track while the result is up
  if (winBgmOverrideActive) {
    if (audio.isBgmPlaying) {
      audio.setBgmVolume(state.sound.bgmVolume ?? 0.4);
    }
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

/**
 * @param {{ untilBgmEnds?: boolean }} [opts]
 */
function startBgmForSpin(opts = {}) {
  if (!state.sound.enabled) return;
  if (state.sound.bgmMode !== "spin" && state.sound.bgmMode !== "always") return;
  // Next spin always returns to the wheel's own BGM
  const wasOverride = winBgmOverrideActive;
  winBgmOverrideActive = false;
  const untilEnd =
    opts.untilBgmEnds === true || state.spin?.untilBgmEnds === true;
  if (!audio.buffers.has("bgm")) {
    ensureBgmBuffer()
      .then((ok) => {
        if (ok) startBgmForSpin(opts);
      })
      .catch(() => {});
    return;
  }
  // Match-song mode: always restart from the start, play once (no loop)
  if (untilEnd || !audio.isBgmPlaying || wasOverride) {
    audio.startBgm("bgm", state.sound.bgmVolume ?? 0.4, {
      loop: !untilEnd,
    });
  } else {
    audio.setBgmVolume(state.sound.bgmVolume ?? 0.4);
  }
}

function stopBgmAfterSpin() {
  // Keep win-section music through the result screen; only stop idle spin-BGM
  if (winBgmOverrideActive) return;
  // Song-matched spins: track was one-shot; stop any leftover
  if (state.spin?.untilBgmEnds === true) {
    if (state.sound.bgmMode === "spin") {
      audio.stopBgm();
    } else if (state.sound.bgmMode === "always") {
      // Resume looping ambient music after a song-length spin
      void ensureBgmBuffer().then((ok) => {
        if (ok && !winBgmOverrideActive) {
          audio.startBgm("bgm", state.sound.bgmVolume ?? 0.4, { loop: true });
        }
      });
    }
    return;
  }
  // Keep music if set to play always; stop if spin-only
  if (state.sound.bgmMode === "spin") {
    audio.stopBgm();
  }
}

/**
 * Clear per-section win BGM override and optionally restart wheel music.
 * @param {{ restartMain?: boolean }} [opts]
 */
async function clearWinBgmOverride(opts = {}) {
  const restartMain = opts.restartMain !== false;
  const was = winBgmOverrideActive;
  winBgmOverrideActive = false;
  if (!restartMain) return;
  if (!was && state.sound?.bgmMode !== "always") return;
  try {
    if (!state.sound?.enabled || state.sound.bgmMode === "off") {
      audio.stopBgm();
      return;
    }
    if (state.sound.bgmMode === "always") {
      const ok = await ensureBgmBuffer();
      if (ok) {
        audio.startBgm("bgm", state.sound.bgmVolume ?? 0.4);
      }
    } else if (state.sound.bgmMode === "spin") {
      // Idle between spins — no BGM unless always mode
      if (!wheel?.spinning && !spinBusy) audio.stopBgm();
    }
  } catch (err) {
    console.warn("restore main BGM:", err);
  }
}

/**
 * Switch (or mute) background music when a section wins.
 * @param {{ id?: string, winBgm?: string, winBgmData?: string|null }} section
 */
async function applySectionWinBgm(section) {
  if (!section) return;
  const raw =
    state.sections.find((s) => s.id === section.id) || section;
  const mode = normalizeWinBgm(raw.winBgm);
  if (mode === "inherit") return;
  if (!state.sound?.enabled || state.sound.bgmMode === "off") return;

  const vol = state.sound.bgmVolume ?? 0.4;
  try {
    if (mode === "mute") {
      audio.stopBgm();
      winBgmOverrideActive = true;
      return;
    }
    if (mode === "custom" && raw.winBgmData) {
      const key = `bgm_sec_${raw.id || "win"}`;
      await audio.loadDataUrl(key, raw.winBgmData);
      audio.startBgm(key, vol);
      winBgmOverrideActive = true;
      return;
    }
  } catch (err) {
    console.warn("section win BGM:", err);
  }
}

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.hidden || tab.classList.contains("hidden")) return;
    // Persist Secret form before leaving so reverse-group settings aren't lost
    if (
      isSecretTabActive() &&
      tab.dataset.tab !== "secret"
    ) {
      try {
        saveSecretPanel();
      } catch {
        /* ignore */
      }
    }
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = $(`#tab-${tab.dataset.tab}`);
    if (panel) {
      panel.hidden = false;
      panel.classList.add("active");
    }
    if (tab.dataset.tab === "history") {
      renderHistory();
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
      if ($("#secret-reverse-target-kind")) {
        $("#secret-reverse-target-kind").value =
          sec.reverseTargetKind === "group" ? "group" : "section";
      }
      updateSecretReverseTargetFields();
      bindSecretDivertSfxUI();
      bindSecretReverseUI();
    }
  });
});

// --- Render sections list ---
/** Raw group name by id (no disambiguation). */
function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name || "—";
}

/**
 * Display label for a group. If several groups share the same name, append
 * priority (#1, #2, …) so they stay distinct from each other and from
 * sections that happen to use the same label.
 */
function groupDisplayName(id) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return "—";
  const name = String(g.name || "Group").trim() || "Group";
  const sameName = state.groups.filter(
    (x) => (String(x.name || "Group").trim() || "Group") === name
  );
  if (sameName.length <= 1) return name;
  const idx = state.groups.findIndex((x) => x.id === id);
  return `${name} (#${idx + 1})`;
}

/** Group display names for a section (by membership ids, not name strings). */
function sectionGroupNames(section) {
  return getSectionGroupIds(section)
    .map((id) => groupDisplayName(id))
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
 * Sort a section list by mode. Does not mutate the input array.
 * "manual" keeps current order (caller should pass your-order sequence).
 * @param {object[]} list
 * @param {string} [mode]
 */
function sortSectionsList(list, mode = sectionSortMode) {
  const arr = list.slice();
  const m = mode || "manual";
  if (m === "manual") return arr;

  arr.sort((a, b) => {
    switch (m) {
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

/** Keep yourOrderIds in sync with live sections (preserve known order). */
function ensureYourOrderIds() {
  if (!state) return;
  if (!Array.isArray(state.yourOrderIds)) state.yourOrderIds = [];
  const have = new Map(
    (state.sections || []).map((s) => [s.id, s])
  );
  const next = [];
  for (const id of state.yourOrderIds) {
    if (have.has(id) && !next.includes(id)) next.push(id);
  }
  for (const s of state.sections || []) {
    if (!next.includes(s.id)) next.push(s.id);
  }
  state.yourOrderIds = next;
}

/**
 * @param {string[]} ids
 * @returns {object[]}
 */
function orderSectionsByIds(ids) {
  const byId = new Map((state.sections || []).map((s) => [s.id, s]));
  const next = [];
  for (const id of ids || []) {
    const s = byId.get(id);
    if (s) {
      next.push(s);
      byId.delete(id);
    }
  }
  for (const s of state.sections || []) {
    if (byId.has(s.id)) next.push(s);
  }
  return next;
}

/**
 * Set list + wheel to a view mode without overwriting Your order
 * (unless mode is manual — then restore Your order).
 * @param {string} mode
 * @param {{ skipRefresh?: boolean }} [opts]
 */
async function setSectionSortMode(mode, opts = {}) {
  const m =
    mode && SECTION_SORT_LABELS[mode] ? mode : "manual";
  ensureYourOrderIds();
  sectionSortMode = m;
  sectionSortDirty = false;
  if (m === "manual") {
    state.sections = orderSectionsByIds(state.yourOrderIds);
  } else {
    // Temporary view order — yourOrderIds untouched
    state.sections = sortSectionsList(state.sections, m);
  }
  try {
    localStorage.setItem(SECTION_SORT_KEY, m);
  } catch {
    /* ignore */
  }
  updateSectionSortUI();
  renderSections();
  if (!opts.skipRefresh) {
    try {
      await refreshWheel();
    } catch (err) {
      console.warn("refreshWheel after sort view:", err);
    }
  }
}

/** Save current list/wheel order into Your order. */
async function applyCurrentViewToYourOrder() {
  ensureYourOrderIds();
  checkpoint();
  state.yourOrderIds = (state.sections || []).map((s) => s.id);
  sectionSortDirty = false;
  sectionSortMode = "manual";
  try {
    localStorage.setItem(SECTION_SORT_KEY, "manual");
  } catch {
    /* ignore */
  }
  persist();
  updateSectionSortUI();
  renderSections();
  try {
    await refreshWheel();
  } catch (err) {
    console.warn("refreshWheel after apply your order:", err);
  }
}

/** After add/remove/dup: keep yourOrderIds valid; refresh pure sort view if needed. */
function onSectionsStructureChanged() {
  ensureYourOrderIds();
  if (sectionSortMode !== "manual" && !sectionSortDirty) {
    state.sections = sortSectionsList(state.sections, sectionSortMode);
  } else if (sectionSortMode === "manual") {
    state.sections = orderSectionsByIds(state.yourOrderIds);
  }
}

function updateSectionSortUI() {
  const sel = $("#section-sort");
  const btn = $("#btn-apply-your-order");
  if (sel) {
    for (const opt of sel.options) {
      const base = SECTION_SORT_LABELS[opt.value] || opt.value;
      const dirtyHere =
        sectionSortDirty &&
        opt.value === sectionSortMode &&
        opt.value !== "manual";
      opt.textContent = dirtyHere ? `${base}*` : base;
    }
    sel.value = sectionSortMode;
    sel.classList.toggle(
      "is-dirty",
      sectionSortDirty && sectionSortMode !== "manual"
    );
    sel.title =
      sectionSortDirty && sectionSortMode !== "manual"
        ? "Order was customized — Apply to your order to save it as Your order"
        : "View order on the list and wheel (Your order is saved separately)";
  }
  if (btn) {
    const show = sectionSortDirty && sectionSortMode !== "manual";
    btn.hidden = !show;
    btn.setAttribute("aria-hidden", show ? "false" : "true");
  }
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
  // Don't clobber the list mid active drag (ghost + live shifts).
  // Pending-only must NOT block forever — a stuck pending freezes the whole list.
  if (sectionDrag.active) return;
  if (sectionDrag.pending) {
    // DOM is about to rebuild; abandon incomplete grip press
    resetSectionDragState();
  }
  if (!sectionsList) return;
  updateSectionsCount();
  if (!state.sections.length) {
    sectionsList.innerHTML = `<div class="empty-state">No sections yet. Add one to get started.</div>`;
    if (sectionSearchMeta) {
      sectionSearchMeta.classList.remove("hidden");
      sectionSearchMeta.textContent = "0 sections";
    }
    return;
  }

  // List order = current wheel/view order (already applied in setSectionSortMode / drag)
  const filtered = getFilteredSections();
  const q = sectionSearchQuery.trim();
  const total = state.sections.length;
  const reorderable = canReorderSections();
  if (sectionSearchMeta) {
    sectionSearchMeta.classList.remove("hidden");
    if (q) {
      sectionSearchMeta.textContent =
        filtered.length === 0
          ? `No matches for “${q}” (of ${total})`
          : `Showing ${filtered.length} of ${total} sections`;
    } else if (reorderable) {
      const view =
        SECTION_SORT_LABELS[sectionSortMode] || sectionSortMode;
      const dirty = sectionSortDirty && sectionSortMode !== "manual" ? "*" : "";
      sectionSearchMeta.textContent = `${total} section${
        total === 1 ? "" : "s"
      } · ${view}${dirty} · drag grip to reorder`;
    } else {
      sectionSearchMeta.textContent = `${total} section${total === 1 ? "" : "s"}`;
    }
  }

  if (!filtered.length) {
    sectionsList.innerHTML = `<div class="empty-state">No sections match your search.</div>`;
    return;
  }

  const ws = getWeightSliderOpts();
  sectionsList.classList.toggle("can-reorder", reorderable);
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
          ? `group: ${gNames[0]}`
          : `groups: ${gNames.join(", ")} (ctrl: ${
              ctrl ? groupDisplayName(ctrl.id) : "—"
            })`
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
        normalizeWinBgm(s.winBgm) === "custom"
          ? "🎵"
          : normalizeWinBgm(s.winBgm) === "mute"
            ? "🔇"
            : "",
        landActionBadge(s),
        returnTimerBadge(s),
        !s.enabled
          ? "off"
          : inactiveGroup
            ? `group off (${ctrl ? groupDisplayName(ctrl.id) : "?"})`
            : "",
      ]
        .filter(Boolean)
        .join(" · ");
      // GIFs are blocked on upload; legacy GIF data still shown as static (resolved on wheel)
      const bg = disp.imageData
        ? `background-image:url(${JSON.stringify(disp.imageData)});background-color:${disp.color}`
        : `background:${disp.color}`;
      const dragHandle = reorderable
        ? `<div class="section-drag-handle" title="Drag to reorder (Your order)" aria-label="Drag to reorder" role="button">
            <span class="drag-grip" aria-hidden="true"></span>
          </div>`
        : "";
      return `
        <div class="section-card ${off ? "disabled-card" : ""}${reorderable ? " is-reorderable" : ""}" data-id="${s.id}">
          <div class="section-card-top${reorderable ? " has-drag-handle" : ""}">
            ${dragHandle}
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
        g.overrideTextStyle ? "style" : "",
        g.overrideTextFont ? "font" : "",
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
        ? `background-image:url(${JSON.stringify(g.imageData)});background-color:${g.color || "#3ecf8e"}`
        : `background:${g.active ? g.color || "#3ecf8e" : "#555"}`;
      return `
        <div class="group-card ${g.active ? "" : "inactive-card"} ${groupHasAnyOverride(g) ? "group-override-on" : ""}" data-id="${g.id}">
          <div class="group-drag-handle" title="Drag to reorder" aria-label="Drag to reorder" role="button">
            <span class="drag-grip" aria-hidden="true"></span>
          </div>
          <span class="group-priority" title="Priority (1 = highest)">#${index + 1}</span>
          <div class="swatch" style="${swatchBg}"></div>
          <div class="group-meta">
            <strong>${escapeHtml(groupDisplayName(g.id))}</strong>
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
    label: section.label || "Untitled",
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
    imageRotation: section.imageRotation,
    landSfxData: section.landSfxData || null,
    landSfxName: section.landSfxName || null,
    landSfxVolume: section.landSfxVolume,
    customWinEffect: section.customWinEffect === true,
    winEffect: section.winEffect || null,
    winEffectData: section.winEffectData || null,
    winEffectName: section.winEffectName || null,
    landAction: normalizeLandAction(section.landAction),
    landTargetWheelId: section.landTargetWheelId || null,
    landShowResultEvery: (() => {
      let n = Number(section.landShowResultEvery);
      if (!Number.isFinite(n) || n < 0) n = 0;
      return Math.min(99999, Math.round(n));
    })(),
    landShowResultUnit: normalizeLandShowResultUnit(section.landShowResultUnit),
    winBgm: normalizeWinBgm(section.winBgm),
    winBgmData:
      normalizeWinBgm(section.winBgm) === "custom"
        ? section.winBgmData || null
        : null,
    winBgmName:
      normalizeWinBgm(section.winBgm) === "custom"
        ? section.winBgmName || null
        : null,
    returnAfterMs: normalizeReturnAfterMs(section.returnAfterMs),
    returnsAt: null, // new copy is enabled path; no pending return
  };
  return raw;
}

/** Section list badge for land actions. */
function landActionBadge(section) {
  const action = normalizeLandAction(section?.landAction);
  if (action === "respin") return "↻ respin";
  if (action === "otherWheel") {
    const tid = section?.landTargetWheelId;
    const slot = tid && library?.wheels?.find((w) => w.id === tid);
    return slot ? `→ ${slot.name || "wheel"}` : "→ other wheel";
  }
  return "";
}

/** Preset return-after values (ms) shown in the section editor select. */
const RETURN_AFTER_PRESETS_MS = [
  0, 300_000, 900_000, 1_800_000, 3_600_000, 21_600_000, 86_400_000,
  259_200_000, 604_800_000,
];

/**
 * Human duration for return timer (e.g. "1 day", "30 min").
 * @param {number} ms
 */
function formatReturnDuration(ms) {
  const n = normalizeReturnAfterMs(ms);
  if (n <= 0) return "off";
  const min = Math.round(n / 60_000);
  if (min < 60) return `${min} min`;
  const hr = n / 3_600_000;
  if (hr < 24 && Math.abs(hr - Math.round(hr)) < 0.05) {
    const h = Math.round(hr);
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (hr < 24) return `${Math.round(hr * 10) / 10} hours`;
  const days = n / 86_400_000;
  if (Math.abs(days - Math.round(days)) < 0.05) {
    const d = Math.round(days);
    return d === 1 ? "1 day" : `${d} days`;
  }
  return `${Math.round(days * 10) / 10} days`;
}

/**
 * Short date/time for return schedule.
 * @param {number} ts
 */
function formatReturnDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return new Date(ts).toString();
  }
}

/**
 * Relative remaining time until returnsAt (e.g. "in 2h", "soon").
 * @param {number} ts
 * @param {number} [now]
 */
function formatReturnRemaining(ts, now = Date.now()) {
  const left = ts - now;
  if (left <= 0) return "soon";
  const sec = Math.round(left / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  const days = Math.round(hr / 24);
  return `in ${days}d`;
}

/** Badge when section is waiting to rejoin the wheel. */
function returnTimerBadge(section) {
  if (!section || section.enabled !== false) return "";
  const at = normalizeReturnsAt(section.returnsAt);
  if (!at) {
    const ms = normalizeReturnAfterMs(section.returnAfterMs);
    return ms > 0 ? `⏱ ${formatReturnDuration(ms)}` : "";
  }
  if (at <= Date.now()) return "⏱ returning";
  return `⏱ ${formatReturnRemaining(at)}`;
}

/**
 * Disable a section and schedule auto-return from its returnAfterMs setting.
 * @param {object} section
 * @param {{ schedule?: boolean }} [opts] schedule=false skips setting returnsAt
 */
function hideSectionWithReturn(section, opts = {}) {
  if (!section) return;
  section.enabled = false;
  if (opts.schedule === false) {
    section.returnsAt = null;
    return;
  }
  const ms = normalizeReturnAfterMs(section.returnAfterMs);
  section.returnsAt = ms > 0 ? Date.now() + ms : null;
}

/**
 * Re-enable a section and clear any scheduled return.
 * @param {object} section
 */
function showSectionClearReturn(section) {
  if (!section) return;
  section.enabled = true;
  section.returnsAt = null;
}

/**
 * Re-enable sections whose returnsAt date has passed.
 * @param {{ refresh?: boolean, persist?: boolean }} [opts]
 * @returns {number} how many sections came back
 */
function processSectionReturns(opts = {}) {
  const doRefresh = opts.refresh !== false;
  const doPersist = opts.persist !== false;
  const now = Date.now();
  let count = 0;
  for (const s of state.sections || []) {
    if (s.enabled !== false) {
      if (s.returnsAt != null) {
        s.returnsAt = null;
      }
      continue;
    }
    const at = normalizeReturnsAt(s.returnsAt);
    if (at != null && at <= now) {
      s.enabled = true;
      s.returnsAt = null;
      count += 1;
    }
  }
  if (count > 0) {
    if (doPersist) persist();
    renderSections();
    if (doRefresh) {
      void refreshWheel().catch((err) =>
        console.warn("refresh after section return:", err)
      );
    }
  }
  scheduleNextSectionReturnCheck();
  return count;
}

/** @type {ReturnType<typeof setTimeout>|0} */
let sectionReturnTimer = 0;

/** Schedule a wake-up for the soonest returnsAt (plus a slow poll). */
function scheduleNextSectionReturnCheck() {
  if (sectionReturnTimer) {
    clearTimeout(sectionReturnTimer);
    sectionReturnTimer = 0;
  }
  let soonest = Infinity;
  const now = Date.now();
  for (const s of state.sections || []) {
    if (s.enabled !== false) continue;
    const at = normalizeReturnsAt(s.returnsAt);
    if (at != null && at > now && at < soonest) soonest = at;
  }
  // Wake at next due time, but also re-check at least every 30s for UI badges
  let delay = 30_000;
  if (Number.isFinite(soonest) && soonest !== Infinity) {
    delay = Math.min(delay, Math.max(250, soonest - now + 50));
  }
  sectionReturnTimer = setTimeout(() => {
    sectionReturnTimer = 0;
    try {
      const n = processSectionReturns();
      // Refresh countdown badges when nothing returned this tick
      if (n === 0) renderSections();
    } catch (err) {
      console.warn("section return check:", err);
      scheduleNextSectionReturnCheck();
    }
  }, delay);
}

/**
 * Read return-after duration from the section form (ms, 0 = off).
 */
function readSectionReturnAfterMsFromForm() {
  const sel = $("#section-return-after")?.value;
  if (sel === "custom") {
    const raw = Number($("#section-return-custom-value")?.value);
    const unit = $("#section-return-custom-unit")?.value || "hours";
    const n = Number.isFinite(raw) && raw > 0 ? raw : 1;
    if (unit === "minutes") return normalizeReturnAfterMs(n * 60_000);
    if (unit === "days") return normalizeReturnAfterMs(n * 86_400_000);
    return normalizeReturnAfterMs(n * 3_600_000);
  }
  return normalizeReturnAfterMs(sel);
}

/**
 * Sync return-after select/custom row from a ms value.
 * @param {number} ms
 */
function setSectionReturnAfterForm(ms) {
  const n = normalizeReturnAfterMs(ms);
  const sel = $("#section-return-after");
  const customRow = $("#section-return-custom-row");
  if (!sel) return;
  if (n === 0) {
    sel.value = "0";
    if (customRow) customRow.hidden = true;
    return;
  }
  if (RETURN_AFTER_PRESETS_MS.includes(n)) {
    sel.value = String(n);
    if (customRow) customRow.hidden = true;
    return;
  }
  sel.value = "custom";
  if (customRow) customRow.hidden = false;
  const min = n / 60_000;
  const hr = n / 3_600_000;
  const day = n / 86_400_000;
  if (Number.isInteger(day) || Math.abs(day - Math.round(day)) < 1e-9) {
    if ($("#section-return-custom-value")) {
      $("#section-return-custom-value").value = String(Math.max(1, Math.round(day)));
    }
    if ($("#section-return-custom-unit")) {
      $("#section-return-custom-unit").value = "days";
    }
  } else if (Number.isInteger(hr) || Math.abs(hr - Math.round(hr)) < 1e-9) {
    if ($("#section-return-custom-value")) {
      $("#section-return-custom-value").value = String(Math.max(1, Math.round(hr)));
    }
    if ($("#section-return-custom-unit")) {
      $("#section-return-custom-unit").value = "hours";
    }
  } else {
    if ($("#section-return-custom-value")) {
      $("#section-return-custom-value").value = String(Math.max(1, Math.round(min)));
    }
    if ($("#section-return-custom-unit")) {
      $("#section-return-custom-unit").value = "minutes";
    }
  }
}

/**
 * Show/hide custom duration + scheduled datetime fields; update status text.
 * @param {{ enabled?: boolean, returnsAt?: number|null, returnAfterMs?: number }} [sec]
 */
function updateSectionReturnUI(sec = null) {
  const actionSel = $("#section-return-after");
  const customRow = $("#section-return-custom-row");
  if (customRow) {
    customRow.hidden = actionSel?.value !== "custom";
  }

  const enabled =
    sec != null
      ? sec.enabled !== false
      : $("#section-enabled")?.checked !== false;
  const atField = $("#section-returns-at-field");
  const atInput = $("#section-returns-at");
  const status = $("#section-return-status");
  const ms =
    sec != null
      ? normalizeReturnAfterMs(sec.returnAfterMs)
      : readSectionReturnAfterMsFromForm();
  const at =
    sec != null
      ? normalizeReturnsAt(sec.returnsAt)
      : normalizeReturnsAt(
          atInput?.value ? new Date(atInput.value).getTime() : null
        );

  if (atField) atField.hidden = enabled;
  if (!enabled && atInput && sec) {
    const scheduled = normalizeReturnsAt(sec.returnsAt);
    if (scheduled) {
      try {
        // datetime-local wants local "YYYY-MM-DDTHH:mm"
        const d = new Date(scheduled);
        const pad = (x) => String(x).padStart(2, "0");
        atInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
          d.getDate()
        )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } catch {
        atInput.value = "";
      }
    } else {
      atInput.value = "";
    }
  }

  if (status) {
    if (!enabled && at && at > Date.now()) {
      status.hidden = false;
      status.textContent = `Scheduled return: ${formatReturnDate(at)} (${formatReturnRemaining(at)})`;
    } else if (!enabled && at && at <= Date.now()) {
      status.hidden = false;
      status.textContent = "Return time has passed — will re-enable shortly.";
    } else if (ms > 0) {
      status.hidden = false;
      status.textContent = `When hidden, returns after ${formatReturnDuration(ms)}.`;
    } else {
      status.hidden = true;
      status.textContent = "";
    }
  }
}

/** Fill target-wheel dropdown (other saved wheels). */
function fillSectionLandTargetWheels(selectedId) {
  const sel = $("#section-land-target-wheel");
  if (!sel) return;
  const cur = library?.activeId;
  const others = (library?.wheels || []).filter((w) => w.id !== cur);
  if (!others.length) {
    sel.innerHTML = `<option value="">No other wheels yet</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = others
    .map(
      (w) =>
        `<option value="${escapeHtml(w.id)}">${escapeHtml(
          w.name || "Untitled"
        )}</option>`
    )
    .join("");
  if (selectedId && others.some((w) => w.id === selectedId)) {
    sel.value = selectedId;
  } else {
    sel.value = others[0].id;
  }
}

function updateSectionLandActionUI() {
  const action = normalizeLandAction($("#section-land-action")?.value);
  const field = $("#section-land-target-field");
  if (field) field.hidden = action !== "otherWheel";
  if (action === "otherWheel") {
    fillSectionLandTargetWheels($("#section-land-target-wheel")?.value);
  }
  const showField = $("#section-land-show-result-field");
  if (showField) {
    showField.hidden = action !== "respin" && action !== "otherWheel";
  }
}

/**
 * Read “show result for” value + unit from the section form.
 * @returns {{ every: number, unit: string }}
 */
function readSectionLandShowResultFromForm() {
  let n = Number($("#section-land-show-result-value")?.value);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.min(99999, Math.round(n));
  const unit = normalizeLandShowResultUnit(
    $("#section-land-show-result-unit")?.value
  );
  return { every: n, unit };
}

/**
 * Fill show-result duration controls from a section (or defaults).
 * @param {{ landShowResultEvery?: number, landShowResultUnit?: string }|null} section
 */
function setSectionLandShowResultForm(section) {
  let n = Number(section?.landShowResultEvery);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.min(99999, Math.round(n));
  if ($("#section-land-show-result-value")) {
    $("#section-land-show-result-value").value = String(n);
  }
  if ($("#section-land-show-result-unit")) {
    $("#section-land-show-result-unit").value = normalizeLandShowResultUnit(
      section?.landShowResultUnit
    );
  }
}

/** Clone a group profile with a new id/name. */
function cloneGroupForDuplicate(group) {
  const newId = uid("grp");
  return normalizeGroup({
    id: newId,
    name: group.name || "Group",
    active: group.active !== false,
    overrideColor: group.overrideColor === true,
    overrideTextColor: group.overrideTextColor === true,
    overrideTextStyle: group.overrideTextStyle === true,
    overrideTextFont: group.overrideTextFont === true,
    overrideWinnerTextColor: group.overrideWinnerTextColor === true,
    overrideImage: group.overrideImage === true,
    overrideSfx: group.overrideSfx === true,
    overrideWinEffect: group.overrideWinEffect === true,
    color: group.color,
    textColor: group.textColor,
    textStyle: group.textStyle,
    textFont: group.textFont,
    winnerTextColor: group.winnerTextColor,
    imageData: group.imageData || null,
    imageMode: group.imageMode,
    imageFillScale: group.imageFillScale,
    imageFillOffsetX: group.imageFillOffsetX,
    imageFillOffsetY: group.imageFillOffsetY,
    imageTileScale: group.imageTileScale,
    imageTileOffsetX: group.imageTileOffsetX,
    imageTileOffsetY: group.imageTileOffsetY,
    imageRotation: group.imageRotation,
    landSfxData: group.landSfxData || null,
    landSfxName: group.landSfxName || null,
    winEffect: group.winEffect || null,
    winEffectData: group.winEffectData || null,
    winEffectName: group.winEffectName || null,
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

/**
 * Phone-style drag reorder for sections (Your order / manual sort only).
 * Declared early so renderSections can guard mid-drag re-renders.
 */
const sectionDrag = {
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
      if (section.enabled === false) {
        showSectionClearReturn(section);
      } else {
        hideSectionWithReturn(section);
      }
      persist();
      renderSections();
      scheduleNextSectionReturnCheck();
      await refreshWheel();
    } else if (act === "edit") {
      openSectionModal(section);
    } else if (act === "dup") {
      checkpoint();
      const idx = state.sections.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const copy = cloneSectionForDuplicate(section);
      state.sections.splice(idx + 1, 0, copy);
      ensureYourOrderIds();
      {
        const yo = state.yourOrderIds || [];
        const at = yo.indexOf(id);
        if (at >= 0) yo.splice(at + 1, 0, copy.id);
        else yo.push(copy.id);
        state.yourOrderIds = yo;
      }
      onSectionsStructureChanged();
      if (copy.landSfxData) {
        try {
          await audio.loadDataUrl(`land_${copy.id}`, copy.landSfxData);
        } catch (err) {
          console.warn("Dup section SFX load:", err);
        }
      }
      persist();
      updateSectionSortUI();
      renderSections();
      updateSectionsCount();
      await refreshWheel();
    } else if (act === "del") {
      // No confirm — Undo restores the section
      checkpoint();
      state.sections = state.sections.filter((s) => s.id !== id);
      ensureYourOrderIds();
      onSectionsStructureChanged();
      if (lastWinnerId === id) {
        lastWinnerId = null;
        hideResults();
      }
      persist();
      updateSectionSortUI();
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

// --- Section phone-style drag reorder (Your order only) ---
const SECTION_DRAG_THRESHOLD = 6;

function getSectionCards() {
  if (!sectionsList) return [];
  return [...sectionsList.querySelectorAll(".section-card")];
}

function clearSectionDragTransforms() {
  getSectionCards().forEach((c) => {
    c.style.transform = "";
    c.style.transition = "";
    c.classList.remove("is-drag-source", "is-slot-open");
  });
  sectionsList?.classList?.remove("is-reordering");
}

function applySectionLiveShifts() {
  const from = sectionDrag.fromIndex;
  const insert = sectionDrag.insertIndex;
  const stride = sectionDrag.stride;
  getSectionCards().forEach((card, i) => {
    if (i === from) {
      card.style.transform = "none";
      return;
    }
    const without = i > from ? i - 1 : i;
    const final = without >= insert ? without + 1 : without;
    const shift = (final - i) * stride;
    card.style.transform = shift
      ? `translate3d(0, ${shift}px, 0)`
      : "translate3d(0,0,0)";
  });
}

function sectionInsertIndexFromY(clientY) {
  const from = sectionDrag.fromIndex;
  let insert = 0;
  sectionDrag.layout.forEach((l, i) => {
    if (i === from) return;
    if (clientY > l.mid) insert += 1;
  });
  return insert;
}

function moveSectionGhost(clientX, clientY) {
  if (!sectionDrag.ghost) return;
  const x = clientX - sectionDrag.offsetX;
  const y = clientY - sectionDrag.offsetY;
  sectionDrag.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.03) rotate(-0.5deg)`;
}

function startSectionDrag(card, e) {
  const cards = getSectionCards();
  const fromIndex = cards.indexOf(card);
  if (fromIndex < 0 || !card?.dataset?.id) {
    // Never leave pending stuck — that freezes renderSections
    resetSectionDragState();
    return;
  }

  const rect = card.getBoundingClientRect();
  sectionDrag.active = true;
  sectionDrag.pending = false;
  sectionDrag.didDrag = true;
  sectionDrag.fromId = card.dataset.id;
  sectionDrag.fromIndex = fromIndex;
  sectionDrag.card = card;
  sectionDrag.pointerId = e.pointerId;
  sectionDrag.offsetX = e.clientX - rect.left;
  sectionDrag.offsetY = e.clientY - rect.top;

  const gap =
    cards.length > 1
      ? Math.max(
          0,
          cards[1].getBoundingClientRect().top -
            cards[0].getBoundingClientRect().bottom
        )
      : 8;
  sectionDrag.stride = rect.height + gap;

  sectionDrag.layout = cards.map((el, index) => {
    const r = el.getBoundingClientRect();
    return {
      el,
      id: el.dataset.id,
      index,
      mid: r.top + r.height / 2,
    };
  });
  sectionDrag.insertIndex = sectionInsertIndexFromY(e.clientY);

  const ghost = card.cloneNode(true);
  ghost.classList.add("group-drag-ghost", "section-drag-ghost");
  ghost.classList.remove("is-drag-source");
  ghost.removeAttribute("data-id");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = "0";
  ghost.style.top = "0";
  document.body.appendChild(ghost);
  sectionDrag.ghost = ghost;
  moveSectionGhost(e.clientX, e.clientY);

  sectionsList?.classList?.add("is-reordering");
  card.classList.add("is-drag-source");
  cards.forEach((c) => {
    if (c !== card) {
      c.style.transition =
        "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
    }
  });
  applySectionLiveShifts();

  try {
    card.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  document.body.classList.add("group-drag-cursor");
}

function endSectionDrag(commit) {
  if (!sectionDrag.active && !sectionDrag.pending) {
    resetSectionDragState();
    return;
  }
  const fromId = sectionDrag.fromId;
  const insertIndex = sectionDrag.insertIndex;
  const ghost = sectionDrag.ghost;
  // Snapshot order of ids at drag start (layout), not live DOM
  const startIds = sectionDrag.layout.map((l) => l.id).filter(Boolean);

  if (ghost) {
    ghost.classList.add("group-drag-ghost-exit");
    const g = ghost;
    setTimeout(() => {
      try {
        g.remove();
      } catch {
        /* ignore */
      }
    }, 180);
  }

  let changed = false;
  if (commit && fromId && startIds.length) {
    // Reorder by id so we never depend on a stale visual index
    const without = startIds.filter((id) => id !== fromId);
    const clamped = Math.max(0, Math.min(insertIndex, without.length));
    without.splice(clamped, 0, fromId);
    const byId = new Map(state.sections.map((s) => [s.id, s]));
    const next = [];
    for (const id of without) {
      const s = byId.get(id);
      if (s) {
        next.push(s);
        byId.delete(id);
      }
    }
    // Keep any sections not in the dragged list (search edge cases)
    for (const s of state.sections) {
      if (byId.has(s.id)) next.push(s);
    }
    changed = !next.every((s, i) => s.id === state.sections[i]?.id);
    if (changed) {
      checkpoint();
      state.sections = next;
      ensureYourOrderIds();
      if (sectionSortMode === "manual") {
        // Permanent custom order
        state.yourOrderIds = next.map((s) => s.id);
        sectionSortDirty = false;
      } else {
        // Temporary view was hand-edited — Your order stays put until Apply
        sectionSortDirty = true;
      }
      persist();
    }
  }

  clearSectionDragTransforms();
  resetSectionDragState();
  document.body.classList.remove("group-drag-cursor");
  try {
    updateSectionSortUI();
    renderSections();
  } catch (err) {
    console.warn("renderSections after reorder:", err);
  }
  void Promise.resolve(refreshWheel()).catch((err) => {
    console.warn("refreshWheel after reorder:", err);
  });
  void changed;
}

function resetSectionDragState() {
  sectionDrag.pending = false;
  sectionDrag.active = false;
  sectionDrag.pointerId = null;
  sectionDrag.fromId = null;
  sectionDrag.fromIndex = -1;
  sectionDrag.insertIndex = 0;
  sectionDrag.card = null;
  if (sectionDrag.ghost) {
    try {
      sectionDrag.ghost.remove();
    } catch {
      /* ignore */
    }
  }
  sectionDrag.ghost = null;
  sectionDrag.layout = [];
}

function finishSectionDragClickGuard() {
  if (!sectionDrag.didDrag || !sectionsList) return;
  const block = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    sectionsList.removeEventListener("click", block, true);
    sectionDrag.didDrag = false;
  };
  sectionsList.addEventListener("click", block, true);
  setTimeout(() => {
    sectionsList.removeEventListener("click", block, true);
    sectionDrag.didDrag = false;
  }, 40);
}

sectionsList?.addEventListener("pointerdown", (e) => {
  if (!canReorderSections()) return;
  if (e.button != null && e.button !== 0) return;
  // Grip only — leave weight sliders / buttons free
  if (!e.target.closest(".section-drag-handle")) return;
  if (e.target.closest("button, [data-act], a, input, select, textarea, label")) {
    return;
  }
  const card = e.target.closest(".section-card");
  if (!card || !sectionsList.contains(card)) return;
  if (state.sections.length < 2) return;

  sectionDrag.pending = true;
  sectionDrag.didDrag = false;
  sectionDrag.card = card;
  sectionDrag.fromId = card.dataset.id;
  sectionDrag.pointerId = e.pointerId;
  sectionDrag.startX = e.clientX;
  sectionDrag.startY = e.clientY;
  // Don't preventDefault here — it can break clicks/scrolls if the drag
  // never starts. preventDefault once the drag actually begins.
});

function handleSectionDragMove(e) {
  if (!sectionDrag.active && !sectionDrag.pending) return;
  if (sectionDrag.pointerId != null && e.pointerId !== sectionDrag.pointerId) {
    return;
  }

  if (sectionDrag.pending && !sectionDrag.active) {
    const dx = e.clientX - sectionDrag.startX;
    const dy = e.clientY - sectionDrag.startY;
    if (Math.hypot(dx, dy) < SECTION_DRAG_THRESHOLD) return;
    if (!sectionDrag.card || !sectionDrag.card.isConnected) {
      resetSectionDragState();
      return;
    }
    e.preventDefault();
    startSectionDrag(sectionDrag.card, e);
  }

  if (!sectionDrag.active) return;
  e.preventDefault();
  moveSectionGhost(e.clientX, e.clientY);
  const nextInsert = sectionInsertIndexFromY(e.clientY);
  if (nextInsert !== sectionDrag.insertIndex) {
    sectionDrag.insertIndex = nextInsert;
    applySectionLiveShifts();
  }
}

function handleSectionDragEnd(e, commit) {
  if (!sectionDrag.active && !sectionDrag.pending) return;
  if (
    e &&
    sectionDrag.pointerId != null &&
    e.pointerId !== sectionDrag.pointerId
  ) {
    return;
  }
  if (sectionDrag.active) {
    if (e) e.preventDefault();
    endSectionDrag(commit);
    finishSectionDragClickGuard();
  } else {
    // Pending grip press without enough movement — just clear
    resetSectionDragState();
    sectionDrag.didDrag = false;
  }
}

window.addEventListener("pointermove", handleSectionDragMove, {
  passive: false,
});
window.addEventListener("pointerup", (e) => handleSectionDragEnd(e, true));
window.addEventListener("pointercancel", (e) =>
  handleSectionDragEnd(e, false)
);
// If the tab loses focus mid-drag, don't leave the list frozen
window.addEventListener("blur", () => {
  if (sectionDrag.active || sectionDrag.pending) {
    endSectionDrag(false);
  }
});

/**
 * Next free default label: Unnamed 1, Unnamed 2, …
 * Skips numbers already used (case-insensitive).
 */
function nextUnnamedLabel(sections = state.sections) {
  const re = /^unnamed\s+(\d+)$/i;
  let max = 0;
  for (const s of sections || []) {
    const m = String(s.label || "").trim().match(re);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `Unnamed ${max + 1}`;
}

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
    if (next) showSectionClearReturn(s);
    else hideSectionWithReturn(s);
  }
  persist();
  renderSections();
  scheduleNextSectionReturnCheck();
  await refreshWheel();
}

$("#btn-enable-all-sections")?.addEventListener("click", () => {
  setAllSectionsEnabled(true);
});

$("#btn-disable-all-sections")?.addEventListener("click", () => {
  setAllSectionsEnabled(false);
});

$("#btn-equalize-weights")?.addEventListener("click", async () => {
  if (!state.sections.length) return;
  const already = state.sections.every(
    (s) => Math.abs(normalizeWeight(s.weight) - 1) < 1e-9
  );
  if (already) {
    alert("All section weights are already 1.");
    return;
  }
  checkpoint();
  for (const s of state.sections) {
    s.weight = 1;
  }
  persist();
  renderSections();
  await refreshWheel();
});

$("#btn-add-group").addEventListener("click", () => {
  openGroupModal(null);
});

// --- Group modal (add / edit + manage sections + profile) ---
/** @type {Set<string>} section ids that will belong to the group on save */
let pendingGroupMemberIds = new Set();
/** True after openGroupModal finishes wiring membership (avoids save wiping members). */
let groupModalMembersReady = false;
let groupMemberSearchQuery = "";
/** @type {string|null} */
let pendingGroupImage = null;
/** @type {string|null} */
let pendingGroupSfx = null;
/** @type {string|null} */
let pendingGroupSfxName = null;
/** @type {string|null} */
let pendingGroupWinEffectData = null;
/** @type {string|null} */
let pendingGroupWinEffectName = null;

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
  const rotRaw = Number($("#group-image-rotation")?.value);
  const rot = Number.isFinite(rotRaw) ? Math.min(360, Math.max(0, rotRaw)) : 0;
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
  set("#group-image-rotation-label", `${Math.round(rot)}°`);
}

/** Read profile fields currently shown in the group modal. */
function readGroupProfileFromForm() {
  return normalizeProfileFields({
    color: $("#group-color")?.value || "#4a6cf7",
    textColor: $("#group-text-color")?.value || "#ffffff",
    textStyle: normalizeTextStyle($("#group-text-style")?.value, "bold"),
    textFont: normalizeTextFont($("#group-text-font")?.value, "system"),
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
    imageRotation: clampImageRotation($("#group-image-rotation")?.value),
    landSfxData: pendingGroupSfx,
    landSfxName: pendingGroupSfxName,
    winEffect: (() => {
      const v = $("#group-win-effect")?.value;
      if (v === "none" || v === "confetti" || v === "custom") return v;
      return null;
    })(),
    winEffectData: pendingGroupWinEffectData,
    winEffectName: pendingGroupWinEffectName,
  });
}

function readOverridePartsFromForm() {
  return {
    overrideColor: $("#group-override-color")?.checked === true,
    overrideTextColor: $("#group-override-text-color")?.checked === true,
    overrideTextStyle: $("#group-override-text-style")?.checked === true,
    overrideTextFont: $("#group-override-text-font")?.checked === true,
    overrideWinnerTextColor:
      $("#group-override-winner-text-color")?.checked === true,
    overrideImage: $("#group-override-image")?.checked === true,
    overrideSfx: $("#group-override-sfx")?.checked === true,
    overrideWinEffect: $("#group-override-win-effect")?.checked === true,
  };
}

function readApplyPartsFromForm() {
  return {
    color: $("#group-apply-color")?.checked === true,
    textColor: $("#group-apply-text-color")?.checked === true,
    textStyle: $("#group-apply-text-style")?.checked === true,
    textFont: $("#group-apply-text-font")?.checked === true,
    winnerTextColor: $("#group-apply-winner-text-color")?.checked === true,
    image: $("#group-apply-image")?.checked === true,
    sfx: $("#group-apply-sfx")?.checked === true,
    winEffect: $("#group-apply-win-effect")?.checked === true,
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
  if ($("#group-override-text-style")) {
    $("#group-override-text-style").checked = g.overrideTextStyle === true;
  }
  if ($("#group-override-text-font")) {
    $("#group-override-text-font").checked = g.overrideTextFont === true;
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
  if ($("#group-override-win-effect")) {
    $("#group-override-win-effect").checked = g.overrideWinEffect === true;
  }
  // Apply chips: default image+color+text on, SFX off (so you don't wipe audio by accident)
  if ($("#group-apply-color")) $("#group-apply-color").checked = true;
  if ($("#group-apply-text-color")) $("#group-apply-text-color").checked = true;
  if ($("#group-apply-text-style")) $("#group-apply-text-style").checked = true;
  if ($("#group-apply-text-font")) $("#group-apply-text-font").checked = true;
  if ($("#group-apply-winner-text-color")) {
    $("#group-apply-winner-text-color").checked = true;
  }
  if ($("#group-apply-image")) $("#group-apply-image").checked = true;
  if ($("#group-apply-sfx")) $("#group-apply-sfx").checked = false;
  if ($("#group-apply-win-effect")) $("#group-apply-win-effect").checked = false;
  if ($("#group-color")) $("#group-color").value = g.color || "#4a6cf7";
  if ($("#group-text-color")) {
    $("#group-text-color").value = g.textColor || "#ffffff";
  }
  if ($("#group-text-style")) {
    $("#group-text-style").value = normalizeTextStyle(g.textStyle, "bold");
  }
  if ($("#group-text-font")) {
    $("#group-text-font").value = normalizeTextFont(g.textFont, "system");
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
  pendingGroupWinEffectData = g.winEffectData || null;
  pendingGroupWinEffectName = g.winEffectName || null;
  if ($("#group-win-effect")) {
    $("#group-win-effect").value =
      g.winEffect === "none" ||
      g.winEffect === "confetti" ||
      g.winEffect === "custom"
        ? g.winEffect
        : "look";
  }
  updateGroupWinEffectCustomUI();
  if ($("#group-image-mode")) {
    $("#group-image-mode").value = g.imageMode === "tile" ? "tile" : "fill";
  }
  if ($("#group-fill-scale")) $("#group-fill-scale").value = g.imageFillScale ?? 1;
  if ($("#group-fill-offset-x")) {
    $("#group-fill-offset-x").value = g.imageFillOffsetX ?? 0;
  }
  if ($("#group-fill-offset-y")) {
    $("#group-fill-offset-y").value = g.imageFillOffsetY ?? 0;
  }
  if ($("#group-tile-scale")) $("#group-tile-scale").value = g.imageTileScale ?? 1;
  if ($("#group-tile-offset-x")) {
    $("#group-tile-offset-x").value = g.imageTileOffsetX ?? 0;
  }
  if ($("#group-tile-offset-y")) {
    $("#group-tile-offset-y").value = g.imageTileOffsetY ?? 0;
  }
  if ($("#group-image-rotation")) {
    $("#group-image-rotation").value = clampImageRotation(g.imageRotation);
  }
  setImgPreview($("#group-img-preview"), pendingGroupImage);
  updateGroupSfxPresetUI();
  setGroupProfileSliderLabels();
  updateGroupImageModeUI();
  if ($("#group-preview-weight-mode")) {
    $("#group-preview-weight-mode").value = "custom";
  }
  if ($("#group-preview-custom-weight")) {
    $("#group-preview-custom-weight").value = "20";
  }
  syncPreviewWeightValueControls("group-preview", 1);
  updateGroupPreviewWeightUI();
}

function openGroupModal(group) {
  groupModalMembersReady = false;
  $("#group-modal-title").textContent = group ? "Edit group" : "Add group";
  $("#group-edit-id").value = group?.id || "";
  const nameEl = $("#group-name");
  if (nameEl) {
    nameEl.value = group?.name || `Group ${state.groups.length + 1}`;
  }
  if ($("#group-active")) {
    $("#group-active").checked = group ? group.active !== false : true;
  }
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
  try {
    fillGroupProfileForm(group);
  } catch (err) {
    console.error("fillGroupProfileForm:", err);
  }
  try {
    renderGroupMembers();
  } catch (err) {
    console.error("renderGroupMembers:", err);
  }
  groupModalMembersReady = true;
  groupModal.showModal();
  requestAnimationFrame(() => {
    const input = $("#group-name");
    if (input) {
      input.focus();
      input.select();
    }
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
          // Filter other groups by id (never by name — names can match sections or each other)
          const otherNames = getSectionGroupIds(s)
            .filter((gid) => gid && gid !== editingId)
            .map((gid) => groupDisplayName(gid))
            .filter((n) => n && n !== "—")
            .join(", ");
          const extra = otherNames
            ? ` <small class="member-extra">also in: ${escapeHtml(otherNames)}</small>`
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
          const names = getSectionGroupIds(s)
            .map((gid) => groupDisplayName(gid))
            .filter((n) => n && n !== "—");
          const extra = names.length
            ? ` · in: ${escapeHtml(names.join(", "))}`
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

$("#group-cancel").addEventListener("click", () => {
  groupModalMembersReady = false;
  groupModal.close();
});

// Group profile media / sliders + live preview
$("#group-name")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-color")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-text-color")?.addEventListener("input", scheduleGroupLivePreview);
$("#group-text-style")?.addEventListener("change", scheduleGroupLivePreview);
$("#group-text-font")?.addEventListener("change", scheduleGroupLivePreview);
$("#group-winner-text-color")?.addEventListener(
  "input",
  scheduleGroupLivePreview
);
$("#group-image-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (isGifFile(file)) {
    alert("GIF images are not supported (they lag the wheel). Use PNG, JPEG, or WebP.");
    return;
  }
  if (!isImageFile(file)) {
    alert("Please choose an image file (PNG, JPEG, or WebP).");
    return;
  }
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
  "group-image-rotation",
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
$("#group-win-effect")?.addEventListener("change", () => {
  const v = $("#group-win-effect")?.value;
  if (v === "look") {
    pendingGroupWinEffectData = null;
    pendingGroupWinEffectName = null;
  } else if (v === "custom" && !pendingGroupWinEffectData) {
    $("#group-win-effect-input")?.click();
  }
  updateGroupWinEffectCustomUI();
});
$("#group-win-effect-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateGroupWinEffectCustomUI();
    return;
  }
  try {
    const { data, name } = await loadWinEffectFile(file);
    pendingGroupWinEffectData = data;
    pendingGroupWinEffectName = name;
    if ($("#group-win-effect")) $("#group-win-effect").value = "custom";
    updateGroupWinEffectCustomUI();
  } catch (err) {
    alert("Could not load file: " + (err.message || err));
    updateGroupWinEffectCustomUI();
  }
});
$("#group-win-effect-clear")?.addEventListener("click", () => {
  pendingGroupWinEffectData = null;
  pendingGroupWinEffectName = null;
  if ($("#group-win-effect")?.value === "custom") {
    $("#group-win-effect").value = "confetti";
  }
  updateGroupWinEffectCustomUI();
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

/**
 * Randomize member section colors with the solid d20 palette system
 * (shuffled; never same color on both neighbors).
 */
$("#btn-group-randomize-colors")?.addEventListener("click", async () => {
  // Wheel order = state.sections array order among group members
  const ordered = state.sections.filter((s) =>
    pendingGroupMemberIds.has(s.id)
  );
  if (!ordered.length) {
    alert(
      "Add at least one section to this group first (Sections in this group list)."
    );
    return;
  }
  if (
    !confirm(
      `Randomize solid colors on ${ordered.length} section(s) in this group?\n\n` +
        `Uses the same palette as d20 (red, blue, green, cyan, yellow, purple).\n` +
        `No two neighbors match, and no section has the same color on both sides.`
    )
  ) {
    return;
  }
  checkpoint();
  const colors = shuffledSolidWheelColors(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const c = colors[i] || colors[0];
    s.customColor = true;
    s.color = c.color;
    s.customTextColor = true;
    s.textColor = c.text;
  }
  // Optional: turn on group color override with a random solid for the profile swatch
  const swatch = colors[0] || { color: "#0000ff" };
  if ($("#group-color")) $("#group-color").value = swatch.color;
  if ($("#group-override-color")) $("#group-override-color").checked = false;
  persist();
  renderSections();
  renderGroups();
  await refreshWheel();
  scheduleGroupLivePreview();
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
  e.stopPropagation();
  try {
    const nameEl = $("#group-name");
    const name = (nameEl?.value || "").trim();
    if (!name) {
      expandCollapsibleContaining(nameEl);
      alert("Please enter a group name.");
      nameEl?.focus();
      return;
    }
    let id = $("#group-edit-id")?.value || "";
    const active = $("#group-active")?.checked !== false;
    const overrideParts = readOverridePartsFromForm();
    const profile = readGroupProfileFromForm();

    checkpoint();
    if (id) {
      const group = state.groups.find((g) => g.id === id);
      if (group) {
        Object.assign(
          group,
          normalizeGroup({
            ...group,
            name,
            active,
            ...overrideParts,
            ...profile,
          })
        );
      } else {
        // Edit id missing from state — treat as create
        id = "";
      }
    }
    if (!id) {
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
      if ($("#group-edit-id")) $("#group-edit-id").value = id;
    }

    // Multi-group membership — only rewrite if the member lists were loaded
    if (groupModalMembersReady) {
      const fallback =
        state.groups.find((g) => g.id !== id) || state.groups[0];
      if (!fallback) {
        alert("You need at least one group.");
        return;
      }

      for (const s of state.sections) {
        const hadGroups = getSectionGroupIds(s).length > 0;
        let ids = getSectionGroupIds(s).filter((gid) =>
          state.groups.some((g) => g.id === gid)
        );
        if (pendingGroupMemberIds.has(s.id)) {
          if (!ids.includes(id)) ids.push(id);
        } else {
          ids = ids.filter((gid) => gid !== id);
        }
        // Keep every section in at least one group if it already had membership
        if (!ids.length && (hadGroups || pendingGroupMemberIds.has(s.id))) {
          ids = [fallback.id];
        }
        setSectionGroupIds(s, ids);
      }
    }

    if (profile.landSfxData) {
      try {
        await audio.loadDataUrl(`land_grp_${id}`, profile.landSfxData);
      } catch (err) {
        console.warn("Group land SFX load failed:", err);
      }
    }

    // persist() warns about full storage once per session if save fails
    persist();
    renderGroups();
    renderSections();
    await refreshWheel();
    groupModalMembersReady = false;
    groupModal.close();
  } catch (err) {
    console.error("Group save failed:", err);
    alert("Could not save group: " + (err?.message || err));
  }
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
  updateSectionSortUI();
  sectionSortSelect.addEventListener("change", async () => {
    const chosen = sectionSortSelect.value || "manual";
    try {
      // Switching views discards unapplied hand-edits in the previous view
      await setSectionSortMode(chosen);
    } catch (err) {
      console.error("Section sort failed:", err);
      updateSectionSortUI();
      renderSections();
    }
  });
}

$("#btn-apply-your-order")?.addEventListener("click", () => {
  applyCurrentViewToYourOrder().catch((err) => {
    console.error("Apply your order failed:", err);
    alert(err.message || String(err));
  });
});

// --- Section modal ---
let pendingSectionImage = null;
let pendingSectionSfx = null;
let pendingSectionSfxName = null;
/** @type {string|null} */
let pendingSectionWinBgm = null;
/** @type {string|null} */
let pendingSectionWinBgmName = null;
/** @type {string|null} */
let pendingSectionWinEffectData = null;
/** @type {string|null} */
let pendingSectionWinEffectName = null;
/** Tracks which profile channels the user touched in the open editor */
let sectionEditDirty = {
  color: false,
  textColor: false,
  winnerTextColor: false,
  image: false,
  sfx: false,
  winEffect: false,
};
/** custom* flags of the section being edited (or defaults for new) */
let sectionEditCustom = {
  color: false,
  textColor: false,
  winnerTextColor: false,
  image: false,
  sfx: false,
  winEffect: false,
};

function markSectionDirty(channel) {
  if (channel === "color") sectionEditDirty.color = true;
  if (channel === "textColor") sectionEditDirty.textColor = true;
  if (channel === "textStyle") sectionEditDirty.textStyle = true;
  if (channel === "textFont") sectionEditDirty.textFont = true;
  if (channel === "winnerTextColor") sectionEditDirty.winnerTextColor = true;
  if (channel === "image") sectionEditDirty.image = true;
  if (channel === "sfx") sectionEditDirty.sfx = true;
  if (channel === "winEffect") sectionEditDirty.winEffect = true;
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
        <span class="group-check-name">${escapeHtml(groupDisplayName(g.id))}</span>
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
        .map(
          (g) =>
            `<option value="${g.id}">${escapeHtml(groupDisplayName(g.id))}</option>`
        )
        .join("");
  }
}

function setImgPreview(el, dataUrl) {
  if (dataUrl) {
    // Image preview in the editor
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
    label:
      ($("#section-label")?.value || "").trim() ||
      nextUnnamedLabel(),
    color: $("#section-color")?.value || "#4a6cf7",
    textColor: $("#section-text-color")?.value || state.look?.textColor || "#ffffff",
    textStyle: normalizeTextStyle(
      $("#section-text-style")?.value || state.look?.textStyle,
      "bold"
    ),
    textFont: normalizeTextFont(
      $("#section-text-font")?.value || state.look?.textFont,
      "system"
    ),
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
    imageRotation: clampImageRotation($("#section-image-rotation")?.value),
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
 * Matches real wheel layering: color under images; labels/border/hub on top.
 */
function drawSliceLivePreview({ stage, canvas, media, labelEl, metaEl, draft, metrics }) {
  if (!stage || !canvas || !media || !draft || !metrics) return;

  const rect = stage.getBoundingClientRect();
  const cssSize = Math.max(120, Math.floor(Math.min(rect.width, rect.height) || 280));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.floor(cssSize * dpr);

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;

  // Overlay above images (labels, dim, border, hub) — same as main wheel
  let overlay = stage.querySelector("canvas.section-live-overlay");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "section-live-overlay";
    overlay.setAttribute("aria-hidden", "true");
    media.insertAdjacentElement("afterend", overlay);
  }
  // Keep overlay after media in DOM and above it in paint order
  if (overlay.previousElementSibling !== media) {
    media.insertAdjacentElement("afterend", overlay);
  }
  overlay.width = px;
  overlay.height = px;
  overlay.style.width = `${cssSize}px`;
  overlay.style.height = `${cssSize}px`;
  overlay.style.zIndex = "5";

  const ctx = canvas.getContext("2d");
  const octx = overlay.getContext("2d");
  const w = px;
  const h = px;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.42;
  const radiusCss = cssSize * 0.42;

  const mid = -Math.PI / 2;
  const fullDisc = metrics.span >= Math.PI * 2 - 1e-4;
  const half = metrics.span / 2;
  const start = fullDisc ? 0 : mid - half;
  const end = fullDisc ? Math.PI * 2 : mid + half;
  const hasImg =
    !!(draft.imageData && state.look.showImages !== false);

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

  // --- Back: color fill only ---
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
  }

  // --- DOM image layer ---
  media.innerHTML = "";
  if (hasImg) {
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
    const rot = clampImageRotation(draft.imageRotation);
    wedge.style.setProperty("--image-rotation", `${rot}deg`);

    if (mode === "tile") {
      // Single CSS background tile layer (matches main wheel)
      const layer = document.createElement("div");
      layer.className = "slice-bg-tile-layer";
      const base = Math.max(18, radiusCss * 0.2);
      const scale = draft.imageTileScale;
      const tilePx = Math.max(10, base * scale);
      const ox = (draft.imageTileOffsetX / 100) * tilePx;
      const oy = (draft.imageTileOffsetY / 100) * tilePx;
      layer.style.width = `${d}px`;
      layer.style.height = `${d}px`;
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.backgroundImage = `url(${JSON.stringify(draft.imageData)})`;
      layer.style.backgroundSize = `${tilePx}px ${tilePx}px`;
      layer.style.backgroundRepeat = "repeat";
      layer.style.backgroundPosition = `${ox}px ${oy}px`;
      layer.style.transformOrigin = "50% 50%";
      layer.style.transform = `rotate(${rot}deg)`;
      wedge.appendChild(layer);
    } else {
      const img = document.createElement("img");
      img.className = "slice-bg-fill";
      img.src = draft.imageData;
      img.alt = "";
      img.draggable = false;
      const layout = computeFillImageLayout({
        radius: radiusCss,
        fillScale: draft.imageFillScale,
        offsetXPct: draft.imageFillOffsetX,
        offsetYPct: draft.imageFillOffsetY,
      });
      wedge.style.setProperty("--fill-scale", String(layout.fillScale));
      // Keep full image aspect ratio (wide sources are not square-cropped)
      const applyBox = () => {
        const box = computeFillImageBox(
          radiusCss,
          img.naturalWidth,
          img.naturalHeight
        );
        img.style.width = `${box.width}px`;
        img.style.height = `${box.height}px`;
        img.style.left = `${layout.left}px`;
        img.style.top = `${layout.top}px`;
      };
      applyBox();
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener("load", applyBox, { once: true });
      }
      wedge.appendChild(img);
    }

    media.appendChild(wedge);
  }

  // --- Front overlay: dim, separators, border, hub, radial label ---
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);

  if (hasImg) {
    octx.beginPath();
    if (fullDisc) {
      octx.arc(cx, cy, radius, 0, Math.PI * 2);
    } else {
      octx.moveTo(cx, cy);
      octx.arc(cx, cy, radius, start, end);
      octx.closePath();
    }
    octx.fillStyle = "rgba(0,0,0,0.22)";
    octx.fill();
  }

  if (!fullDisc) {
    octx.strokeStyle = "rgba(0,0,0,0.35)";
    octx.lineWidth = 1.5 * dpr;
    for (const a of [start, end]) {
      octx.beginPath();
      octx.moveTo(cx, cy);
      octx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      octx.stroke();
    }
  }

  octx.beginPath();
  octx.arc(cx, cy, radius, 0, Math.PI * 2);
  octx.strokeStyle = state.look.borderColor || "#f0d78c";
  octx.lineWidth = 5 * dpr;
  octx.stroke();

  const hubR = radius * (state.look.centerSize ?? 0.16);
  octx.beginPath();
  octx.arc(cx, cy, hubR, 0, Math.PI * 2);
  octx.fillStyle = state.look.centerColor || "#1a1f35";
  octx.fill();
  octx.strokeStyle = state.look.borderColor || "#f0d78c";
  octx.lineWidth = 3 * dpr;
  octx.stroke();

  if (labelEl) {
    labelEl.textContent = "";
    labelEl.style.display = "none";
  }
  if (state.look?.showLabels !== false) {
    octx.save();
    octx.translate(cx, cy);
    // Always hub→rim (top of preview wedge), matching multi-slice wheel text —
    // not the horizontal full-disc LTR layout.
    const labelSpan = fullDisc
      ? Math.max(0.35, Math.min(Math.PI * 0.9, metrics.span || Math.PI / 3))
      : Math.max(0.05, metrics.span || 0.05);
    drawSliceLabel(octx, {
      radius,
      mid,
      span: labelSpan,
      label: draft.label,
      textColor: draft.textColor,
      textStyle: draft.textStyle || state.look?.textStyle || "bold",
      textFont: draft.textFont || state.look?.textFont || "system",
      fallbackTextColor: state.look?.textColor || "#fff",
      centerSize: state.look?.centerSize ?? 0.16,
      dpr,
      showLabels: true,
      asSolidDisc: false,
      forceRadial: true,
      spinFrame: false,
    });
    octx.restore();
  }
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
    textStyle: false,
    textFont: false,
    winnerTextColor: false,
    image: false,
    sfx: false,
    winEffect: false,
  };
  sectionEditCustom = {
    color: section ? section.customColor === true : false,
    textColor: section ? section.customTextColor === true : false,
    textStyle: section ? section.customTextStyle === true : false,
    textFont: section ? section.customTextFont === true : false,
    winnerTextColor: section ? section.customWinnerTextColor === true : false,
    image: section ? section.customImage === true : false,
    sfx: section ? section.customSfx === true : false,
    winEffect: section ? section.customWinEffect === true : false,
  };

  // Show effective look (inherited group profile) when channel is unedited
  const resolved = section
    ? resolveSectionForDisplay(state, section)
    : null;
  const colorSrc = sectionEditCustom.color ? section : resolved;
  const textSrc = sectionEditCustom.textColor ? section : resolved;
  const textStyleSrc = sectionEditCustom.textStyle ? section : resolved;
  const textFontSrc = sectionEditCustom.textFont ? section : resolved;
  const winnerTextSrc = sectionEditCustom.winnerTextColor
    ? section
    : resolved;
  const imageSrc = sectionEditCustom.image ? section : resolved;
  const sfxSrc = sectionEditCustom.sfx ? section : resolved;
  const winFxSrc = sectionEditCustom.winEffect ? section : resolved;

  pendingSectionImage = imageSrc?.imageData ?? null;
  pendingSectionSfx = sfxSrc?.landSfxData ?? null;
  pendingSectionSfxName = sfxSrc?.landSfxName ?? null;
  pendingSectionWinEffectData = winFxSrc?.winEffectData ?? null;
  pendingSectionWinEffectName = winFxSrc?.winEffectName ?? null;

  $("#section-modal-title").textContent = section ? "Edit section" : "Add section";
  $("#section-edit-id").value = section?.id || "";
  $("#section-label").value = section?.label || nextUnnamedLabel();
  $("#section-weight").value = section?.weight ?? 1;
  $("#section-color").value =
    colorSrc?.color || nextPaletteColor(state);
  if ($("#section-text-color")) {
    $("#section-text-color").value =
      textSrc?.textColor ||
      state.look?.textColor ||
      "#ffffff";
  }
  if ($("#section-text-style")) {
    $("#section-text-style").value = normalizeTextStyle(
      textStyleSrc?.textStyle || state.look?.textStyle,
      "bold"
    );
  }
  if ($("#section-text-font")) {
    $("#section-text-font").value = normalizeTextFont(
      textFontSrc?.textFont || state.look?.textFont,
      "system"
    );
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
  const rot = clampImageRotation(imgModeSrc?.imageRotation);
  if ($("#section-image-rotation")) {
    $("#section-image-rotation").value = rot;
    if ($("#section-image-rotation-label")) {
      $("#section-image-rotation-label").textContent = `${Math.round(rot)}°`;
    }
  }
  setImgPreview($("#section-img-preview"), pendingSectionImage);
  // For custom channel, only the section's own file counts as custom
  if (!sectionEditCustom.sfx) {
    pendingSectionSfx = null;
    pendingSectionSfxName = null;
  } else {
    pendingSectionSfx = section?.landSfxData ?? null;
    pendingSectionSfxName = section?.landSfxName ?? null;
  }
  if (!sectionEditCustom.winEffect) {
    pendingSectionWinEffectData = null;
    pendingSectionWinEffectName = null;
    if ($("#section-win-effect")) $("#section-win-effect").value = "inherit";
  } else {
    pendingSectionWinEffectData = section?.winEffectData ?? null;
    pendingSectionWinEffectName = section?.winEffectName ?? null;
    if ($("#section-win-effect")) {
      const we = section?.winEffect;
      $("#section-win-effect").value =
        we === "none" || we === "confetti" || we === "custom"
          ? we
          : pendingSectionWinEffectData
            ? "custom"
            : "confetti";
    }
  }
  updateSectionSfxPresetUI();
  updateSectionWinEffectUI();
  {
    const mode = normalizeWinBgm(section?.winBgm);
    pendingSectionWinBgm =
      mode === "custom" ? section?.winBgmData ?? null : null;
    pendingSectionWinBgmName =
      mode === "custom" ? section?.winBgmName ?? null : null;
    if ($("#section-win-bgm")) $("#section-win-bgm").value = mode;
    updateSectionWinBgmUI();
  }
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
  {
    const action = normalizeLandAction(section?.landAction);
    if ($("#section-land-action")) $("#section-land-action").value = action;
    fillSectionLandTargetWheels(section?.landTargetWheelId || null);
    setSectionLandShowResultForm(section || null);
    updateSectionLandActionUI();
  }
  setSectionReturnAfterForm(section?.returnAfterMs ?? 0);
  updateSectionReturnUI(section || { enabled: true, returnAfterMs: 0, returnsAt: null });
  updateSectionImageModeUI();
  // Default preview: custom % of wheel at 20% (typical multi-slice wedge)
  if ($("#preview-weight-mode")) {
    $("#preview-weight-mode").value = "custom";
  }
  if ($("#preview-custom-weight")) {
    $("#preview-custom-weight").value = "20";
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

$("#section-land-action")?.addEventListener("change", () => {
  updateSectionLandActionUI();
});

$("#section-return-after")?.addEventListener("change", () => {
  updateSectionReturnUI({
    enabled: $("#section-enabled")?.checked !== false,
    returnAfterMs: readSectionReturnAfterMsFromForm(),
    returnsAt: null,
  });
});
$("#section-return-custom-value")?.addEventListener("input", () => {
  updateSectionReturnUI({
    enabled: $("#section-enabled")?.checked !== false,
    returnAfterMs: readSectionReturnAfterMsFromForm(),
    returnsAt: null,
  });
});
$("#section-return-custom-unit")?.addEventListener("change", () => {
  updateSectionReturnUI({
    enabled: $("#section-enabled")?.checked !== false,
    returnAfterMs: readSectionReturnAfterMsFromForm(),
    returnsAt: null,
  });
});
$("#section-enabled")?.addEventListener("change", () => {
  updateSectionReturnUI({
    enabled: $("#section-enabled")?.checked !== false,
    returnAfterMs: readSectionReturnAfterMsFromForm(),
    returnsAt: null,
  });
});

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
$("#section-image-rotation")?.addEventListener("input", () => {
  markSectionDirty("image");
  const raw = Number($("#section-image-rotation").value);
  const v = Number.isFinite(raw) ? Math.min(360, Math.max(0, raw)) : 0;
  if ($("#section-image-rotation-label")) {
    $("#section-image-rotation-label").textContent = `${Math.round(v)}°`;
  }
  scheduleSectionLivePreview();
});

// Live preview for label / color / weight
$("#section-label")?.addEventListener("input", scheduleSectionLivePreview);
$("#section-text-style")?.addEventListener("change", () => {
  markSectionDirty("textStyle");
  sectionEditCustom.textStyle = true;
  scheduleSectionLivePreview();
});
$("#section-text-font")?.addEventListener("change", () => {
  markSectionDirty("textFont");
  sectionEditCustom.textFont = true;
  scheduleSectionLivePreview();
});
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

function isGifFile(file) {
  if (!file) return false;
  if (file.type === "image/gif") return true;
  return /\.gif$/i.test(file.name || "");
}

function isImageFile(file) {
  if (!file) return false;
  // GIFs removed — they caused major lag on the wheel
  if (isGifFile(file)) return false;
  if (file.type === "image/gif") return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|bmp|svg)$/i.test(file.name || "");
}

$("#section-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (isGifFile(file)) {
    alert("GIF images are not supported (they lag the wheel). Use PNG, JPEG, or WebP.");
    return;
  }
  if (!isImageFile(file)) {
    alert("Please choose an image file (PNG, JPEG, or WebP).");
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

function updateSectionWinBgmUI() {
  const mode = normalizeWinBgm($("#section-win-bgm")?.value);
  const row = $("#section-win-bgm-custom-row");
  const nameEl = $("#section-win-bgm-name");
  if (row) {
    row.hidden = mode !== "custom";
    row.style.display = mode === "custom" ? "" : "none";
  }
  if (nameEl) {
    if (mode === "custom") {
      nameEl.textContent =
        pendingSectionWinBgmName ||
        (pendingSectionWinBgm ? "Custom music" : "No custom file chosen");
    } else if (mode === "mute") {
      nameEl.textContent = "Music will mute on win";
    } else {
      nameEl.textContent = "Keep current wheel music";
    }
  }
}

$("#section-win-bgm")?.addEventListener("change", () => {
  const mode = normalizeWinBgm($("#section-win-bgm")?.value);
  if (mode !== "custom") {
    // Keep pending file in memory if they switch back to custom
  } else if (!pendingSectionWinBgm) {
    $("#section-win-bgm-input")?.click();
  }
  updateSectionWinBgmUI();
});

$("#section-win-bgm-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateSectionWinBgmUI();
    return;
  }
  try {
    pendingSectionWinBgm = await fileToDataUrl(file);
    pendingSectionWinBgmName = file.name || "Custom music";
    if ($("#section-win-bgm")) $("#section-win-bgm").value = "custom";
    updateSectionWinBgmUI();
  } catch (err) {
    console.warn("section win BGM load:", err);
    alert("Could not load music file.");
    updateSectionWinBgmUI();
  }
});

$("#section-win-bgm-clear")?.addEventListener("click", () => {
  pendingSectionWinBgm = null;
  pendingSectionWinBgmName = null;
  if ($("#section-win-bgm")) $("#section-win-bgm").value = "inherit";
  updateSectionWinBgmUI();
});

$("#section-win-bgm-preview")?.addEventListener("click", async () => {
  audio.ensure();
  if (audio.isPreviewPlaying) {
    audio.stopPreview();
    return;
  }
  const mode = normalizeWinBgm($("#section-win-bgm")?.value);
  const vol = state.sound?.bgmVolume ?? 0.4;
  try {
    if (mode === "mute") {
      // No preview for mute
      return;
    }
    if (mode === "custom" && pendingSectionWinBgm) {
      await audio.loadDataUrl("preview_section_bgm", pendingSectionWinBgm);
      if (audio.isPreviewPlaying) return;
      // Use one-shot preview of a short portion via playOneShot if available
      // Prefer looping preview stoppable via stopPreview
      if (typeof audio.startBgm === "function") {
        // Stop any main BGM briefly for preview
        const wasOverride = winBgmOverrideActive;
        const wasPlaying = audio.isBgmPlaying;
        audio.stopBgm();
        audio.startBgm("preview_section_bgm", vol);
        // Mark as preview by scheduling stop after a few seconds
        setTimeout(() => {
          try {
            if (audio.buffers.has("preview_section_bgm")) {
              audio.stopBgm();
            }
          } catch {
            /* ignore */
          }
          if (wasPlaying && !wasOverride) {
            void ensureBgmBuffer().then((ok) => {
              if (ok && state.sound?.bgmMode === "always") {
                audio.startBgm("bgm", vol);
              }
            });
          }
        }, 5000);
      }
      return;
    }
    // inherit — preview wheel BGM
    const ok = await ensureBgmBuffer();
    if (ok) {
      audio.stopBgm();
      audio.startBgm("bgm", vol);
      setTimeout(() => {
        try {
          if (state.sound?.bgmMode !== "always") audio.stopBgm();
        } catch {
          /* ignore */
        }
      }, 5000);
    }
  } catch (err) {
    console.warn("section win BGM preview:", err);
  }
});

$("#section-win-effect")?.addEventListener("change", () => {
  const v = $("#section-win-effect")?.value;
  if (v === "inherit") {
    sectionEditCustom.winEffect = false;
    pendingSectionWinEffectData = null;
    pendingSectionWinEffectName = null;
  } else {
    sectionEditCustom.winEffect = true;
    markSectionDirty("winEffect");
    if (v === "custom" && !pendingSectionWinEffectData) {
      $("#section-win-effect-input")?.click();
    }
  }
  updateSectionWinEffectUI();
});

$("#section-win-effect-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    updateSectionWinEffectUI();
    return;
  }
  try {
    const { data, name } = await loadWinEffectFile(file);
    pendingSectionWinEffectData = data;
    pendingSectionWinEffectName = name;
    markSectionDirty("winEffect");
    sectionEditCustom.winEffect = true;
    if ($("#section-win-effect")) $("#section-win-effect").value = "custom";
    updateSectionWinEffectUI();
  } catch (err) {
    alert("Could not load file: " + (err.message || err));
    updateSectionWinEffectUI();
  }
});

$("#section-win-effect-clear")?.addEventListener("click", () => {
  pendingSectionWinEffectData = null;
  pendingSectionWinEffectName = null;
  markSectionDirty("winEffect");
  if ($("#section-win-effect")?.value === "custom") {
    $("#section-win-effect").value = "confetti";
  }
  updateSectionWinEffectUI();
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
  let customTextStyle = existing ? existing.customTextStyle === true : false;
  let customTextFont = existing ? existing.customTextFont === true : false;
  let customWinnerTextColor = existing
    ? existing.customWinnerTextColor === true
    : false;
  let customImage = existing ? existing.customImage === true : false;
  let customSfx = existing ? existing.customSfx === true : false;
  let customWinEffect = existing ? existing.customWinEffect === true : false;
  if (sectionEditDirty.color) customColor = true;
  if (sectionEditDirty.textColor) customTextColor = true;
  if (sectionEditDirty.textStyle) customTextStyle = true;
  if (sectionEditDirty.textFont) customTextFont = true;
  if (sectionEditDirty.winnerTextColor) customWinnerTextColor = true;
  if (sectionEditDirty.image) {
    // Clear with no image → inherit again; pick/adjust image → own
    customImage = !!pendingSectionImage || sectionEditCustom.image === true;
    if (!pendingSectionImage && sectionEditDirty.image) customImage = false;
  }
  if (sectionEditDirty.sfx) {
    customSfx = !!pendingSectionSfx;
  }
  if (sectionEditDirty.winEffect) {
    const sel = $("#section-win-effect")?.value;
    customWinEffect = sel && sel !== "inherit";
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
    imageRotation: clampImageRotation($("#section-image-rotation")?.value),
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
      imageRotation: 0,
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
      imageRotation: existing.imageRotation ?? 0,
    });
  }

  const payload = {
    label: $("#section-label").value.trim() || nextUnnamedLabel(),
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
    textStyle: customTextStyle
      ? normalizeTextStyle($("#section-text-style")?.value, "bold")
      : normalizeTextStyle(
          existing?.textStyle ||
            $("#section-text-style")?.value ||
            state.look?.textStyle,
          "bold"
        ),
    textFont: customTextFont
      ? normalizeTextFont($("#section-text-font")?.value, "system")
      : normalizeTextFont(
          existing?.textFont ||
            $("#section-text-font")?.value ||
            state.look?.textFont,
          "system"
        ),
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
    customTextStyle,
    customTextFont,
    customWinnerTextColor,
    customImage,
    customSfx,
    customWinEffect,
    ...imageFields,
    landSfxData: customSfx
      ? pendingSectionSfx
      : existing?.landSfxData ?? null,
    landSfxName: customSfx
      ? pendingSectionSfxName
      : existing?.landSfxName ?? null,
    landSfxVolume: getSectionSfxVolumeFromForm(),
    winEffect: customWinEffect
      ? ($("#section-win-effect")?.value === "none" ||
        $("#section-win-effect")?.value === "confetti" ||
        $("#section-win-effect")?.value === "custom"
          ? $("#section-win-effect").value
          : "confetti")
      : existing?.winEffect ?? null,
    winEffectData: customWinEffect
      ? pendingSectionWinEffectData
      : existing?.winEffectData ?? null,
    winEffectName: customWinEffect
      ? pendingSectionWinEffectName
      : existing?.winEffectName ?? null,
    landAction: normalizeLandAction($("#section-land-action")?.value),
    landTargetWheelId: null,
    landShowResultEvery: 0,
    landShowResultUnit: "seconds",
    winBgm: normalizeWinBgm($("#section-win-bgm")?.value),
    winBgmData: null,
    winBgmName: null,
    returnAfterMs: readSectionReturnAfterMsFromForm(),
    returnsAt: null,
  };
  if (payload.winBgm === "custom") {
    if (pendingSectionWinBgm) {
      payload.winBgmData = pendingSectionWinBgm;
      payload.winBgmName = pendingSectionWinBgmName || "Custom music";
    } else {
      payload.winBgm = "inherit";
    }
  }
  if (payload.landAction === "otherWheel") {
    const tid = $("#section-land-target-wheel")?.value || "";
    payload.landTargetWheelId =
      tid && library.wheels.some((w) => w.id === tid && w.id !== library.activeId)
        ? tid
        : null;
    if (!payload.landTargetWheelId) {
      // No valid target — fall back to normal result behavior
      payload.landAction = "none";
    }
  }
  if (payload.landAction === "respin" || payload.landAction === "otherWheel") {
    const show = readSectionLandShowResultFromForm();
    payload.landShowResultEvery = show.every;
    payload.landShowResultUnit = show.unit;
  }
  // Schedule / preserve return date when saving a hidden section
  if (payload.enabled === false) {
    const atRaw = $("#section-returns-at")?.value;
    if (atRaw) {
      const parsed = Date.parse(atRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        payload.returnsAt = parsed;
      }
    }
    // If still no date but timer is on, start the clock from now
    if (!payload.returnsAt && payload.returnAfterMs > 0) {
      payload.returnsAt = Date.now() + payload.returnAfterMs;
    }
  }
  if (payload.customWinEffect && payload.winEffect === "custom" && !payload.winEffectData) {
    payload.winEffect = "confetti";
  }

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
      customTextStyle: sectionEditDirty.textStyle,
      customTextFont: sectionEditDirty.textFont,
      customWinnerTextColor: sectionEditDirty.winnerTextColor,
      customImage: sectionEditDirty.image && !!pendingSectionImage,
      customSfx: sectionEditDirty.sfx && !!pendingSectionSfx,
      customWinEffect:
        sectionEditDirty.winEffect &&
        $("#section-win-effect")?.value !== "inherit",
      color: sectionEditDirty.color
        ? $("#section-color").value
        : nextPaletteColor(state),
      textColor: sectionEditDirty.textColor
        ? $("#section-text-color")?.value || "#ffffff"
        : state.look?.textColor || "#ffffff",
      textStyle: sectionEditDirty.textStyle
        ? normalizeTextStyle($("#section-text-style")?.value, "bold")
        : normalizeTextStyle(state.look?.textStyle, "bold"),
      textFont: sectionEditDirty.textFont
        ? normalizeTextFont($("#section-text-font")?.value, "system")
        : normalizeTextFont(state.look?.textFont, "system"),
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
    ensureYourOrderIds();
    if (!state.yourOrderIds.includes(s.id)) state.yourOrderIds.push(s.id);
    onSectionsStructureChanged();
    if (s.customSfx && s.landSfxData) {
      await audio.loadDataUrl(`land_${s.id}`, s.landSfxData);
    }
  }
  persist();
  updateSectionSortUI();
  renderSections();
  renderGroups();
  scheduleNextSectionReturnCheck();
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
      textStyle: normalizeTextStyle(state.look?.textStyle, "bold"),
      textFont: normalizeTextFont(state.look?.textFont, "system"),
      winnerTextColor:
        state.look?.winnerTextColor || state.look?.textColor || "#ffffff",
      weight,
      enabled: true,
      groupIds: bulkGroupId ? [bulkGroupId] : [],
      // Unedited image/SFX inherit group profiles; color only owned if set in bulk line
      customColor: colorGiven,
      customTextColor: false,
      customTextStyle: false,
      customTextFont: false,
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
      imageRotation: 0,
      landSfxData: null,
      landSfxName: null,
      landSfxVolume: state.sound.landVolume ?? 0.4,
    });
  }
  ensureYourOrderIds();
  onSectionsStructureChanged();
  persist();
  updateSectionSortUI();
  renderSections();
  await refreshWheel();
  bulkModal.close();
});

// --- Look tab ---
function bindLook() {
  $("#bg-color").value = state.look.backgroundColor;
  $("#center-color").value = state.look.centerColor;
  $("#center-size").value = state.look.centerSize;
  if ($("#chk-spin-center-hub")) {
    $("#chk-spin-center-hub").checked = state.look.spinCenterHub === true;
  }
  $("#border-color").value = state.look.borderColor;
  $("#text-color").value = state.look.textColor;
  if ($("#winner-text-color")) {
    $("#winner-text-color").value =
      state.look.winnerTextColor || state.look.textColor || "#ffffff";
  }
  if ($("#text-style")) {
    $("#text-style").value = normalizeTextStyle(state.look.textStyle, "bold");
  }
  if ($("#text-font")) {
    $("#text-font").value = normalizeTextFont(state.look.textFont, "system");
  }
  updateTextColorOverrideButton();
  updateTextStyleOverrideButton();
  updateTextFontOverrideButton();
  updateWinnerTextOverrideButton();
  $("#chk-show-labels").checked = state.look.showLabels !== false;
  $("#chk-show-images").checked = state.look.showImages !== false;
  if ($("#image-layout-mode")) {
    $("#image-layout-mode").value = normalizeImageLayoutMode(
      state.look.imageLayoutMode
    );
  }
  if ($("#chk-pointer-locked")) {
    $("#chk-pointer-locked").checked = state.look.pointerLocked !== false;
  }
  $("#result-style").value = state.look.resultStyle === "banner" ? "banner" : "center";
  if ($("#winner-label")) {
    $("#winner-label").value =
      state.look.winnerLabel != null && String(state.look.winnerLabel).trim() !== ""
        ? String(state.look.winnerLabel)
        : "Winner";
  }
  $("#chk-allow-winner-remove").checked = state.look.allowWinnerRemove !== false;
  if ($("#chk-allow-winner-hide")) {
    $("#chk-allow-winner-hide").checked = state.look.allowWinnerHide !== false;
  }
  if ($("#eliminate-after-win")) {
    const e = state.look.eliminateAfterWin;
    $("#eliminate-after-win").value =
      e === "hide" || e === "remove" ? e : "off";
  }
  if ($("#win-effect")) {
    const we = state.look.winEffect;
    $("#win-effect").value =
      we === "none" || we === "custom" ? we : "confetti";
  }
  updateLookWinEffectCustomUI();
  if ($("#chk-keyboard-spin")) {
    $("#chk-keyboard-spin").checked = state.look.keyboardSpin !== false;
  }
  if ($("#chk-double-click-spin")) {
    $("#chk-double-click-spin").checked =
      state.look.allowDoubleClickSpin !== false;
  }
  if ($("#chk-wheel-drag")) {
    $("#chk-wheel-drag").checked = state.look.allowWheelDrag !== false;
  }
  if ($("#chk-grab-stop-spin")) {
    $("#chk-grab-stop-spin").checked =
      state.look.allowGrabStopSpin !== false;
  }
  if ($("#chk-fair-drag-spin")) {
    $("#chk-fair-drag-spin").checked = state.look.fairDragSpin === true;
  }
  if ($("#chk-auto-spin")) {
    $("#chk-auto-spin").checked = state.look.autoSpin === true;
  }
  {
    let n = Number(state.look.autoSpinEvery);
    if (!Number.isFinite(n) || n < 1) n = 5;
    if ($("#auto-spin-value")) $("#auto-spin-value").value = String(Math.round(n));
    const u = state.look.autoSpinUnit;
    if ($("#auto-spin-unit")) {
      $("#auto-spin-unit").value =
        u === "seconds" || u === "hours" || u === "days" ? u : "minutes";
    }
  }
  updateAutoSpinUI();
  if ($("#auto-dismiss-sec")) {
    let ad = Number(state.look.autoDismissSec);
    if (!Number.isFinite(ad)) ad = 0;
    if (ad < 0) ad = -1;
    else ad = Math.min(99999, Math.round(ad));
    $("#auto-dismiss-sec").value = String(ad);
  }
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
  updateHistoryTrackUi();
  scheduleAutoSpin();
}

/** Global title above the winning section name (center style). */
function getWinnerLabel() {
  const raw = state.look?.winnerLabel;
  if (raw == null || String(raw).trim() === "") return "Winner";
  return String(raw).trim().slice(0, 300);
}

function updateWinnerLabelDisplay() {
  const el = $("#result-center-label");
  if (el) el.textContent = getWinnerLabel();
}

/**
 * Show/hide Hide & Remove on the win screen.
 * When "after a win" auto-eliminates, those buttons are redundant — only Continue stays.
 */
function updateWinnerRemoveButton() {
  const removeBtn = $("#btn-result-remove");
  const hideBtn = resultActionsBar?.querySelector?.(
    '[data-result-act="hide"]'
  );
  const elim = state.look?.eliminateAfterWin;
  const autoElim = elim === "hide" || elim === "remove";

  if (hideBtn) {
    // Auto-eliminate: hide Hide. Else respect Look → Show Hide button.
    const showHide =
      !autoElim && state.look?.allowWinnerHide !== false;
    hideBtn.hidden = !showHide;
    hideBtn.setAttribute("aria-hidden", showHide ? "false" : "true");
  }
  if (removeBtn) {
    // Auto-eliminate mode: never show Remove. Otherwise respect Look toggle.
    const showRemove =
      !autoElim && state.look.allowWinnerRemove !== false;
    removeBtn.hidden = !showRemove;
    removeBtn.setAttribute("aria-hidden", showRemove ? "false" : "true");
  }
}

/** Sync Look → Default text color Override button active state */
function updateTextColorOverrideButton() {
  const btn = $("#btn-text-color-override");
  if (!btn) return;
  const on = state.look?.forceTextColor === true;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on
    ? "Override on — every section label uses Look default text color (click to turn off)"
    : "Override off — use section/group text colors when set (click to force Look color)";
}

/** Sync Look → Text style Override button active state */
function updateTextStyleOverrideButton() {
  const btn = $("#btn-text-style-override");
  if (!btn) return;
  const on = state.look?.forceTextStyle === true;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on
    ? "Override on — every section label uses Look text style (click to turn off)"
    : "Override off — use section/group text styles when set (click to force Look style)";
}

/** Sync Look → Text font Override button active state */
function updateTextFontOverrideButton() {
  const btn = $("#btn-text-font-override");
  if (!btn) return;
  const on = state.look?.forceTextFont === true;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on
    ? "Override on — every section label uses Look text font (click to turn off)"
    : "Override off — use section/group fonts when set (click to force Look font)";
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

$("#btn-text-color-override")?.addEventListener("click", async () => {
  checkpoint();
  state.look.forceTextColor = !(state.look.forceTextColor === true);
  updateTextColorOverrideButton();
  persist();
  await refreshWheel();
});

$("#btn-text-style-override")?.addEventListener("click", async () => {
  checkpoint();
  state.look.forceTextStyle = !(state.look.forceTextStyle === true);
  updateTextStyleOverrideButton();
  persist();
  await refreshWheel();
});

$("#btn-text-font-override")?.addEventListener("click", async () => {
  checkpoint();
  state.look.forceTextFont = !(state.look.forceTextFont === true);
  updateTextFontOverrideButton();
  persist();
  await refreshWheel();
});

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
  // <img> for section image behind winner text
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
      reverseSlideSfxPreset: "glass-squeak-2",
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

/** True when the Secret tab is the active side panel (safe to trust live form fields). */
function isSecretTabActive() {
  return !!$("#tab-secret")?.classList.contains("active");
}

function getRigTargetKind() {
  const s = ensureSecretState();
  if (isSecretTabActive()) {
    const live = $("#secret-rig-target-kind")?.value;
    if (live === "group" || live === "section") return live;
  }
  return s.rigTargetKind === "group" ? "group" : "section";
}

function getReverseTargetKind() {
  const s = ensureSecretState();
  if (isSecretTabActive()) {
    const live = $("#secret-reverse-target-kind")?.value;
    if (live === "group" || live === "section") return live;
  }
  return s.reverseTargetKind === "group" ? "group" : "section";
}

/** @returns {"reverse-first"|"rig-first"} */
function getSecretComboOrder() {
  const s = ensureSecretState();
  if (isSecretTabActive()) {
    const live = $("#secret-combo-order")?.value;
    if (live === "rig-first" || live === "reverse-first") {
      s.comboOrder = live;
      return live;
    }
  }
  return s.comboOrder === "rig-first" ? "rig-first" : "reverse-first";
}

function isRigItActive() {
  const s = ensureSecretState();
  const rigOn = isSecretTabActive()
    ? $("#secret-rig-it")?.checked === true
    : !!s.rigIt;
  if (!rigOn) return false;
  if (getRigTargetKind() === "group") {
    const gid = isSecretTabActive()
      ? $("#secret-rig-group")?.value || s.targetGroupId || null
      : s.targetGroupId || null;
    return !!(gid && state.groups.some((g) => g.id === gid));
  }
  const id = isSecretTabActive()
    ? $("#secret-rig-section")?.value || s.targetSectionId || null
    : s.targetSectionId || null;
  return !!(id && state.sections.some((sec) => sec.id === id));
}

function isReverseRigActive() {
  const s = ensureSecretState();
  const revOn = isSecretTabActive()
    ? $("#secret-reverse-rig-it")?.checked === true
    : !!s.reverseRigIt;
  if (!revOn) return false;
  if (getReverseTargetKind() === "group") {
    const gid = isSecretTabActive()
      ? $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null
      : s.reverseTargetGroupId || null;
    return !!(gid && state.groups.some((g) => g.id === gid));
  }
  const id = isSecretTabActive()
    ? $("#secret-reverse-section")?.value || s.reverseTargetSectionId || null
    : s.reverseTargetSectionId || null;
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
    const gid = isSecretTabActive()
      ? $("#secret-rig-group")?.value || s.targetGroupId || null
      : s.targetGroupId || null;
    if (!gid) return null;
    const pool = active.filter((sec) => sectionInGroup(sec, gid));
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
  // Sections currently eligible for the wheel (enabled + controlling group active)
  const active = getActiveSections(state);
  const activeIdSet = new Set(active.map((sec) => sec.id));

  if (kind === "group") {
    const gid = isSecretTabActive()
      ? $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null
      : s.reverseTargetGroupId || null;
    if (!gid) return [];

    // 1) Active-on-wheel members of this group
    const fromActive = active
      .filter((sec) => sectionInGroup(sec, gid))
      .map((sec) => sec.id);

    // 2) Any section in the project that is in this group AND on the wheel
    const fromAll = state.sections
      .filter(
        (sec) =>
          sectionInGroup(sec, gid) &&
          sec.enabled !== false &&
          activeIdSet.has(sec.id)
      )
      .map((sec) => sec.id);

    // 3) Display-resolved copies (same ids; keeps groupIds if present)
    const fromDisplay = getDisplaySections(state)
      .filter((sec) => sectionInGroup(sec, gid))
      .map((sec) => sec.id);

    const ids = [...new Set([...fromActive, ...fromAll, ...fromDisplay])];
    return ids;
  }

  const id = isSecretTabActive()
    ? $("#secret-reverse-section")?.value || s.reverseTargetSectionId || null
    : s.reverseTargetSectionId || null;
  if (!id) return [];
  if (!activeIdSet.has(id)) return [];
  return [id];
}

/** Group id for reverse when avoiding a whole group (for wheel-side expansion). */
function getReverseAvoidGroupId() {
  if (!isReverseRigActive()) return null;
  if (getReverseTargetKind() !== "group") return null;
  const s = ensureSecretState();
  return isSecretTabActive()
    ? $("#secret-reverse-group")?.value || s.reverseTargetGroupId || null
    : s.reverseTargetGroupId || null;
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

/** Pending eliminate-after-win when result is dismissed */
let pendingEliminateId = null;
/** @type {"hide"|"remove"|null} */
let pendingEliminateMode = null;

/**
 * Apply hide/remove scheduled for the last winner (Continue / dismiss).
 */
async function applyPendingEliminate() {
  const id = pendingEliminateId;
  const mode = pendingEliminateMode;
  pendingEliminateId = null;
  pendingEliminateMode = null;
  if (!id || (mode !== "hide" && mode !== "remove")) return;
  const section = state.sections.find((s) => s.id === id);
  if (mode === "hide") {
    if (!section || section.enabled === false) return;
    checkpoint();
    hideSectionWithReturn(section);
    if (lastWinnerId === id) lastWinnerId = null;
    persist();
    renderSections();
    scheduleNextSectionReturnCheck();
    await refreshWheel();
    return;
  }
  // remove
  if (!section) return;
  checkpoint();
  state.sections = state.sections.filter((s) => s.id !== id);
  ensureYourOrderIds();
  onSectionsStructureChanged();
  if (lastWinnerId === id) lastWinnerId = null;
  persist();
  updateSectionSortUI();
  renderSections();
  await refreshWheel();
}

function hideResults() {
  clearAutoDismissTimer();
  resultBanner.classList.add("hidden");
  resultCenter.classList.add("hidden");
  resultActionsBar.classList.add("hidden");
  clearResultCenterBg();
  resultShowsRigged = false;
  // Keep a clickable “rigged” badge if Rig / Reverse is armed (re-open secret menu)
  setResultRiggedVisible(isRigItActive() || isReverseRigActive());
  // Eliminate-after-win runs when the result is dismissed
  void applyPendingEliminate().catch((err) =>
    console.warn("eliminate after win:", err)
  );
  // Redraw after overlay dismiss so canvas/DOM media recover if land left them stale
  try {
    if (wheel && !wheel.spinning && !wheel._dragging) {
      requestAnimationFrame(() => {
        try {
          // Re-check: a new spin may have started since we scheduled this
          if (!wheel || wheel.spinning || wheel._dragging) return;
          if (!wheel.wheelCanvas?.width) wheel.resize();
          else wheel.draw({ spinFrame: false });
        } catch {
          /* ignore */
        }
      });
    }
  } catch {
    /* ignore */
  }
}

/** Whether the open win screen should keep showing “rigged” */
let resultShowsRigged = false;

// --- Spin history (device-wide log) ---
const HISTORY_KEY = "spin-wheel-history-v1";
const HISTORY_MAX = 200;
/** UI filter: only show entries for the active wheel (persisted on device). */
const HISTORY_FILTER_THIS_WHEEL_KEY = "spin-wheel-history-this-wheel-v1";
/** @type {ReturnType<typeof setTimeout>|0} */
let autoDismissTimer = 0;

function isHistoryThisWheelOnly() {
  try {
    return localStorage.getItem(HISTORY_FILTER_THIS_WHEEL_KEY) === "1";
  } catch {
    return false;
  }
}

function setHistoryThisWheelOnly(on) {
  try {
    localStorage.setItem(HISTORY_FILTER_THIS_WHEEL_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Active wheel id used for history filtering. */
function getActiveHistoryWheelId() {
  return (
    library?.activeId ||
    getActiveSlot(library)?.id ||
    ""
  );
}

/**
 * @param {ReturnType<typeof loadSpinHistory>} [entries]
 * @returns {ReturnType<typeof loadSpinHistory>}
 */
function getVisibleHistoryEntries(entries) {
  const list = Array.isArray(entries) ? entries : loadSpinHistory();
  if (!isHistoryThisWheelOnly()) return list;
  const wid = getActiveHistoryWheelId();
  if (!wid) return list;
  return list.filter((e) => e && e.wheelId === wid);
}

/**
 * @returns {Array<{
 *   id: string,
 *   at: string,
 *   wheelId: string,
 *   wheelName: string,
 *   sectionId: string,
 *   sectionLabel: string,
 *   rigged: boolean
 * }>}
 */
function loadSpinHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && e.sectionLabel != null)
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** @param {ReturnType<typeof loadSpinHistory>} entries */
function saveSpinHistory(entries) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify((entries || []).slice(0, HISTORY_MAX))
    );
  } catch (err) {
    console.warn("Could not save spin history:", err);
  }
}

/** Whether this wheel records spins into the History log (default on). */
function isHistoryTrackingEnabled() {
  return state?.look?.trackHistory !== false;
}

/**
 * @param {{ id: string, label: string }} section
 * @param {{ rigged?: boolean }} [opts]
 */
function recordSpinHistory(section, opts = {}) {
  if (!section) return;
  if (!isHistoryTrackingEnabled()) return;
  const slot = getActiveSlot(library);
  const entry = {
    id: uid("hist"),
    at: new Date().toISOString(),
    wheelId: slot?.id || library?.activeId || "",
    wheelName: slot?.name || "Wheel",
    sectionId: section.id,
    sectionLabel: section.label || "Winner",
    rigged: !!opts.rigged,
  };
  const list = loadSpinHistory();
  list.unshift(entry);
  saveSpinHistory(list);
  // Refresh history tab if open
  if ($("#tab-history")?.classList.contains("active")) {
    renderHistory();
  }
}

function updateHistoryTrackUi() {
  const chk = $("#chk-track-history");
  const on = isHistoryTrackingEnabled();
  if (chk) chk.checked = on;
  const filterChk = $("#chk-history-this-wheel");
  if (filterChk) filterChk.checked = isHistoryThisWheelOnly();
  const hint = $("#history-track-hint");
  if (hint) {
    const parts = [];
    if (!on) {
      parts.push(
        "Tracking is off for this wheel — new spins are not saved to history."
      );
    } else {
      parts.push("New winners will be listed below.");
    }
    if (isHistoryThisWheelOnly()) {
      parts.push("Showing this wheel only.");
    }
    hint.textContent = parts.join(" ");
  }
}

function clearAutoDismissTimer() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = 0;
  }
}

function scheduleAutoDismiss() {
  clearAutoDismissTimer();
  let sec = Number(state.look?.autoDismissSec);
  // 0 = keep open; -1 = never show overlay (handled in showResult)
  if (!Number.isFinite(sec) || sec <= 0) return;
  sec = Math.min(99999, Math.max(1, Math.round(sec)));
  autoDismissTimer = setTimeout(() => {
    autoDismissTimer = 0;
    try {
      hideResults();
    } catch (err) {
      console.warn("auto-dismiss:", err);
    }
  }, sec * 1000);
}

/** True when Look → Auto-dismiss is “Don't show results”. */
function isResultDisplaySkipped() {
  return Number(state.look?.autoDismissSec) === -1;
}

function formatHistoryTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso || "";
  }
}

function renderHistory() {
  const listEl = $("#history-list");
  const countEl = $("#history-count");
  if (!listEl) return;
  updateHistoryTrackUi();
  const all = loadSpinHistory();
  const entries = getVisibleHistoryEntries(all);
  const thisOnly = isHistoryThisWheelOnly();
  if (countEl) {
    if (thisOnly && all.length !== entries.length) {
      countEl.textContent =
        entries.length === 1
          ? `1 of ${all.length}`
          : `${entries.length} of ${all.length}`;
      countEl.title = `${entries.length} for this wheel · ${all.length} total`;
    } else {
      countEl.textContent =
        entries.length === 1 ? "1 entry" : `${entries.length} entries`;
      countEl.title = "Entries";
    }
  }
  if (!entries.length) {
    if (!isHistoryTrackingEnabled()) {
      listEl.innerHTML = `<div class="history-empty">No spins yet. Tracking is off for this wheel — turn on “Track history” to record winners.</div>`;
    } else if (thisOnly && all.length) {
      listEl.innerHTML = `<div class="history-empty">No spins for this wheel yet. Turn off “This wheel only” to see all ${all.length} entr${all.length === 1 ? "y" : "ies"}.</div>`;
    } else {
      listEl.innerHTML = `<div class="history-empty">No spins yet. Winners will show up here.</div>`;
    }
    return;
  }
  listEl.innerHTML = entries
    .map(
      (e) => `
    <div class="history-row">
      <span class="h-label">${escapeHtml(e.sectionLabel || "Winner")}</span>
      <span class="h-time">${escapeHtml(formatHistoryTime(e.at))}</span>
      <span class="h-meta">${escapeHtml(e.wheelName || "Wheel")}${
        e.rigged ? ` · <span class="h-rigged">rigged</span>` : ""
      }</span>
    </div>`
    )
    .join("");
}

$("#chk-track-history")?.addEventListener("change", () => {
  checkpoint();
  if (!state.look) state.look = {};
  state.look.trackHistory = !!$("#chk-track-history")?.checked;
  persist();
  updateHistoryTrackUi();
});

$("#chk-history-this-wheel")?.addEventListener("change", () => {
  setHistoryThisWheelOnly(!!$("#chk-history-this-wheel")?.checked);
  renderHistory();
});

$("#btn-history-clear")?.addEventListener("click", () => {
  const all = loadSpinHistory();
  const thisOnly = isHistoryThisWheelOnly();
  const visible = getVisibleHistoryEntries(all);
  if (!visible.length) {
    alert(
      thisOnly
        ? "No history for this wheel."
        : "History is already empty."
    );
    return;
  }
  if (thisOnly) {
    const n = visible.length;
    if (
      !confirm(
        `Clear ${n} history entr${n === 1 ? "y" : "ies"} for this wheel only?\n\nOther wheels’ history is kept.`
      )
    ) {
      return;
    }
    const wid = getActiveHistoryWheelId();
    saveSpinHistory(all.filter((e) => e && e.wheelId !== wid));
  } else {
    const n = all.length;
    if (!confirm(`Clear all ${n} history entr${n === 1 ? "y" : "ies"}?`)) {
      return;
    }
    saveSpinHistory([]);
  }
  renderHistory();
  updateStorageMeter();
});

$("#btn-history-export")?.addEventListener("click", () => {
  const entries = getVisibleHistoryEntries();
  downloadJson(`spin-history-${new Date().toISOString().slice(0, 10)}.json`, {
    format: "sad-wheel-history-v1",
    exportedAt: new Date().toISOString(),
    scope: isHistoryThisWheelOnly() ? "this-wheel" : "all",
    wheelId: isHistoryThisWheelOnly() ? getActiveHistoryWheelId() : null,
    entries,
  });
});

/**
 * Resolve effective after-win effect for a winner section (Look default / group / section).
 * @param {{ id?: string }|null} section
 */
function resolveWinEffectForSection(section) {
  try {
    if (section?.id) {
      const raw =
        state.sections.find((s) => s.id === section.id) || section;
      const disp = resolveSectionForDisplay(state, raw);
      return {
        effect: disp?.winEffect || state.look?.winEffect || "confetti",
        data: disp?.winEffectData || null,
        name: disp?.winEffectName || null,
      };
    }
  } catch {
    /* fall through */
  }
  return {
    effect: state.look?.winEffect || "confetti",
    data: state.look?.winEffectData || null,
    name: state.look?.winEffectName || null,
  };
}

/**
 * After-win visual effect — uses section/group override or Look global default.
 * @param {{ id?: string }|null} [section]
 */
function playWinEffect(section = null) {
  const { effect, data } = resolveWinEffectForSection(section);
  if (effect === "none") return;
  if (effect === "custom" && data) {
    const { name } = resolveWinEffectForSection(section);
    playCustomWinMedia(data, { fileName: name || "" });
    return;
  }
  if (effect === "confetti" || (effect === "custom" && !data)) {
    fireConfetti();
  }
}

/** Entrance styles for custom after-win media (picked at random). */
const WIN_FX_ENTERS = [
  "win-fx-enter-pop",
  "win-fx-enter-drop",
  "win-fx-enter-spin",
  "win-fx-enter-slide",
  "win-fx-enter-flip",
  "win-fx-enter-zoomblur",
];
/** Hold / idle motion while media is on screen. */
const WIN_FX_HOLDS = [
  "win-fx-hold-float",
  "win-fx-hold-pulse",
  "win-fx-hold-sway",
  "win-fx-hold-kenburns",
];
/** Exit styles. */
const WIN_FX_EXITS = [
  "win-fx-exit-fade",
  "win-fx-exit-up",
  "win-fx-exit-spin",
  "win-fx-exit-shrink",
];

/**
 * Formats good for transparent after-win overlays.
 * WebM alpha, WebP, PNG; MP4 also allowed (opaque). GIFs not supported.
 */
const WIN_EFFECT_ACCEPT =
  "video/webm,.webm,image/webp,.webp,image/png,.png,video/mp4,.mp4,image/*,video/*";

/**
 * @param {File} file
 * @returns {boolean}
 */
function isAllowedWinEffectFile(file) {
  if (!file) return false;
  if (isGifFile(file)) return false;
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (type === "image/gif") return false;
  if (type.startsWith("image/") || type.startsWith("video/")) {
    return true;
  }
  return /\.(webm|webp|png|mp4|mov|m4v)$/i.test(name);
}

/**
 * Prefer <video> for real video types (incl. transparent WebM).
 * WebP / PNG use <img>.
 * @param {string} dataUrl
 * @param {string} [fileName]
 */
function isWinEffectVideoMime(dataUrl, fileName = "") {
  if (/^data:video\//i.test(dataUrl)) return true;
  // Some browsers store WebM oddly; name fallback
  if (/\.webm$/i.test(fileName) && !/^data:image\//i.test(dataUrl)) return true;
  if (/\.mp4$/i.test(fileName) && !/^data:image\//i.test(dataUrl)) return true;
  return false;
}

/**
 * Formats that typically carry transparency.
 * @param {string} dataUrl
 * @param {string} [fileName]
 */
function winEffectLikelyTransparent(dataUrl, fileName = "") {
  const n = (fileName || "").toLowerCase();
  if (/^data:video\/webm/i.test(dataUrl) || n.endsWith(".webm")) return true;
  if (/^data:image\/(webp|png)/i.test(dataUrl)) return true;
  if (/\.(webp|png)$/i.test(n)) return true;
  return false;
}

/**
 * Load a user file as a custom after-win effect (shared by Look / section / group).
 * @param {File} file
 * @returns {Promise<{ data: string, name: string }>}
 */
async function loadWinEffectFile(file) {
  if (isGifFile(file)) {
    throw new Error(
      "GIF is not supported. Use WebM (best for transparency), WebP, PNG, or MP4."
    );
  }
  if (!isAllowedWinEffectFile(file)) {
    throw new Error(
      "Use WebM (best for transparency), WebP, PNG, or MP4."
    );
  }
  // Soft size hint — large files bloat localStorage
  if (file.size > 12 * 1024 * 1024) {
    console.warn("Win effect file is large:", file.name, file.size);
  }
  const data = await fileToDataUrl(file);
  return { data, name: file.name || "Custom media" };
}

/**
 * Full-screen custom media with random enter/hold/exit.
 * Supports transparent WebM, WebP, PNG, and MP4.
 * @param {string} dataUrl
 * @param {{ fileName?: string }} [opts]
 */
function playCustomWinMedia(dataUrl, opts = {}) {
  if (!dataUrl) return;
  try {
    document.getElementById("win-effect-media-layer")?.remove();
    const layer = document.createElement("div");
    layer.id = "win-effect-media-layer";
    layer.setAttribute("aria-hidden", "true");

    const fileName = opts.fileName || "";
    const transparent = winEffectLikelyTransparent(dataUrl, fileName);
    if (transparent) layer.classList.add("win-fx-transparent");

    const enter =
      WIN_FX_ENTERS[Math.floor(Math.random() * WIN_FX_ENTERS.length)];
    const hold =
      WIN_FX_HOLDS[Math.floor(Math.random() * WIN_FX_HOLDS.length)];
    const exit =
      WIN_FX_EXITS[Math.floor(Math.random() * WIN_FX_EXITS.length)];
    layer.classList.add(enter, hold);

    const useVideo = isWinEffectVideoMime(dataUrl, fileName);
    /** @type {HTMLImageElement|HTMLVideoElement} */
    let el;
    if (useVideo) {
      const v = document.createElement("video");
      v.src = dataUrl;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      // Help WebM alpha composite over the page
      v.style.background = "transparent";
      el = v;
      v.play?.().catch(() => {});
    } else {
      // WebP / PNG — <img> for still images with alpha
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "";
      img.decoding = "async";
      el = img;
    }
    el.classList.add("win-fx-media");
    layer.appendChild(el);
    document.body.appendChild(layer);

    const holdMs = 2800 + Math.floor(Math.random() * 900);
    const exitMs = 520;
    const remove = () => {
      try {
        layer.classList.remove(enter, hold);
        layer.classList.add(exit);
        setTimeout(() => {
          try {
            layer.remove();
          } catch {
            /* ignore */
          }
        }, exitMs);
      } catch {
        /* ignore */
      }
    };
    setTimeout(remove, holdMs);
  } catch (err) {
    console.warn("custom win effect:", err);
  }
}

/** Bumps when a new confetti run starts so old RAF loops stop. */
let confettiGeneration = 0;

/** Remove confetti + custom win-effect layers (and stop confetti RAF). */
function clearWinOverlays() {
  confettiGeneration += 1;
  try {
    document.getElementById("confetti-layer")?.remove();
  } catch {
    /* ignore */
  }
  try {
    document.getElementById("win-effect-media-layer")?.remove();
  } catch {
    /* ignore */
  }
}

/**
 * Confetti falls from the top of the screen (flutter + drift), no dependency.
 * Only one run at a time — a new win cancels the previous loop.
 */
function fireConfetti() {
  try {
    // Kill any prior confetti RAF + layer so rapid spins cannot stack
    confettiGeneration += 1;
    const gen = confettiGeneration;
    document.getElementById("confetti-layer")?.remove();

    const layer = document.createElement("div");
    layer.id = "confetti-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);

    const canvas = document.createElement("canvas");
    layer.appendChild(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const colors = [
      "#f0d78c",
      "#6c8cff",
      "#e85d6c",
      "#3ecf8e",
      "#e8eaf2",
      "#c9a84c",
      "#b388ff",
      "#ff9f43",
    ];
    // Fewer pieces than before — enough sparkle, much less main-thread load
    const n = 120;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const wave = i / n;
      const fallSpeed = 1.6 + Math.random() * 2.8;
      parts.push({
        x: Math.random() * w,
        y: -12 - Math.random() * h * 0.35 - wave * 80,
        vx: (Math.random() - 0.5) * 1.8,
        vy: fallSpeed,
        swayAmp: 0.6 + Math.random() * 1.4,
        swayFreq: 0.04 + Math.random() * 0.08,
        swayPhase: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.18,
        wobble: 0.02 + Math.random() * 0.05,
        size: 5 + Math.random() * 9,
        aspect: 0.35 + Math.random() * 0.45,
        color: colors[i % colors.length],
        delay: wave * 0.28,
        life: 1,
      });
    }
    const start = performance.now();
    const dur = 4200;
    const frame = (now) => {
      // Superseded by a newer confetti / clearWinOverlays
      if (gen !== confettiGeneration) return;
      const elapsed = now - start;
      const t = elapsed / dur;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        const age = elapsed / 1000 - p.delay * (dur / 1000);
        if (age < 0) continue;
        p.vy = Math.min(p.vy + 0.035, 5.5);
        p.x += p.vx + Math.sin(age * 60 * p.swayFreq + p.swayPhase) * p.swayAmp;
        p.y += p.vy;
        p.rot += p.vr + Math.sin(age * 40 + p.swayPhase) * p.wobble;
        p.vx *= 0.995;

        const pastBottom = p.y > h + 30;
        const fadeT = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);
        p.life = pastBottom ? Math.min(fadeT, 0.35) : fadeT;
        if (p.life <= 0.02) continue;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        const sw = p.size;
        const sh = p.size * p.aspect;
        ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
        ctx.restore();
      }
      if (t < 1 && gen === confettiGeneration) {
        requestAnimationFrame(frame);
      } else {
        try {
          if (gen === confettiGeneration) layer.remove();
        } catch {
          /* ignore */
        }
      }
    };
    requestAnimationFrame(frame);
  } catch (err) {
    console.warn("confetti:", err);
  }
}

/**
 * @param {{ id: string, label: string }} section
 * @param {{
 *   rigged?: boolean,
 *   forceShow?: boolean,
 *   skipEliminate?: boolean,
 *   skipAutoDismiss?: boolean,
 *   skipHistory?: boolean,
 * }} [opts] rigged = fling or secret Rig it
 */
function showResult(section, opts = {}) {
  if (!section || section.id == null) {
    console.warn("showResult called without a winner section");
    return;
  }
  try {
    // Clear previous overlay UI only (avoid recursive redraw thrash)
    resultBanner?.classList?.add("hidden");
    resultCenter?.classList?.add("hidden");
    resultActionsBar?.classList?.add("hidden");
    clearResultCenterBg();

    lastWinnerId = section.id;
    // Schedule eliminate-after-win for when result is dismissed
    // (skipped when chaining respin / other-wheel so the portal slice stays)
    if (opts.skipEliminate) {
      pendingEliminateId = null;
      pendingEliminateMode = null;
    } else {
      const elim = state.look?.eliminateAfterWin;
      if (elim === "hide" || elim === "remove") {
        pendingEliminateId = section.id;
        pendingEliminateMode = elim;
      } else {
        pendingEliminateId = null;
        pendingEliminateMode = null;
      }
    }
    if (!opts.skipHistory) {
      try {
        recordSpinHistory(section, opts);
      } catch (err) {
        console.warn("history:", err);
      }
    }
    playWinEffect(section);
    // Per-section background music switch (custom / mute)
    void applySectionWinBgm(section).catch((err) =>
      console.warn("win BGM:", err)
    );

    // Don't show results — skip overlay; still eliminate / history / effects
    // forceShow: land-action “show result for” still displays even if Look is −1
    if (isResultDisplaySkipped() && !opts.forceShow) {
      clearAutoDismissTimer();
      // Keep rigged badge if armed; no win UI
      resultShowsRigged = false;
      setResultRiggedVisible(isRigItActive() || isReverseRigActive());
      void applyPendingEliminate().catch((err) =>
        console.warn("eliminate after win (no display):", err)
      );
      try {
        if (wheel && !wheel.spinning) wheel.draw({ spinFrame: false });
      } catch {
        /* ignore */
      }
      return;
    }

    if (opts.skipAutoDismiss) {
      clearAutoDismissTimer();
    } else {
      scheduleAutoDismiss();
    }
    const label = section.label || "Winner";
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
      if (resultTextBanner) {
        resultTextBanner.textContent = label;
        resultTextBanner.style.color = winTextColor;
      }
      resultBanner.classList.remove("hidden");
    } else {
      updateWinnerLabelDisplay();
      if (resultTextCenter) {
        resultTextCenter.textContent = label;
        resultTextCenter.style.color = winTextColor;
      }
      try {
        setResultCenterBg(imageData);
      } catch (err) {
        console.warn("Winner background failed:", err);
      }
      const inner = resultCenter?.querySelector?.(".result-center-inner");
      if (inner) {
        inner.style.animation = "none";
        void inner.offsetWidth;
        inner.style.animation = "";
      }
      resultCenter?.classList?.remove("hidden");
    }
    // Always dock Hide / Continue at the bottom (Remove optional)
    updateWinnerRemoveButton();
    resultActionsBar?.classList?.remove("hidden");
    resultShowsRigged =
      !!opts.rigged || isRigItActive() || isReverseRigActive();
    setResultRiggedVisible(resultShowsRigged);

    // Ensure wheel under the overlay is in a good idle state
    try {
      if (wheel && !wheel.spinning) {
        wheel.draw({ spinFrame: false });
      }
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.error("showResult failed:", err);
    // Still show something so the session doesn't look dead
    try {
      if (resultTextCenter) resultTextCenter.textContent = section.label || "Winner";
      resultCenter?.classList?.remove("hidden");
      resultActionsBar?.classList?.remove("hidden");
    } catch {
      /* ignore */
    }
  }
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
          `<option value="${g.id}">${escapeHtml(groupDisplayName(g.id))}${
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
          `<option value="${g.id}">${escapeHtml(groupDisplayName(g.id))}${
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
      sec.reverseSlideSfxPreset =
        rp === "default" ? "glass-squeak-2" : rp;
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
  "scp-173": {
    id: "scp-173",
    url: "assets/sounds/divert-default.mp3",
    name: "scp-173 grind",
  },
};

const REVERSE_SLIDE_PRESET_IDS = new Set([
  ...Object.keys(REVERSE_SLIDE_PRESETS),
  "custom",
  "synth", // legacy → scp-173
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
  return REVERSE_SLIDE_PRESETS[preset]?.name || "Glass rub squeak 2";
}

function getReverseSlideSfxPreset() {
  const sec = ensureSecretState();
  // Prefer live dropdown so UI selection is never ignored
  const live = $("#secret-reverse-slide-sfx-preset")?.value;
  let p = live || sec.reverseSlideSfxPreset;
  if (p === "default") p = "glass-squeak-2"; // legacy generic default
  if (p === "synth") p = "scp-173"; // legacy slippery synth → SCP grind
  if (p && REVERSE_SLIDE_PRESET_IDS.has(p)) {
    if (p === "custom" && !sec.reverseSlideSfxData && live !== "custom") {
      return "glass-squeak-2";
    }
    if (p === "synth") return "scp-173";
    return p;
  }
  if (sec.reverseSlideSfxData) return "custom";
  return "glass-squeak-2";
}

/** Unique audio buffer key per reverse-slide preset (avoids playing a stale sample). */
function reverseSlideBufferKey(preset = getReverseSlideSfxPreset()) {
  if (preset === "synth") preset = "scp-173";
  if (preset === "custom") return "rig_reverse_custom";
  if (REVERSE_SLIDE_PRESETS[preset]) return `rig_reverse_${preset}`;
  return "rig_reverse_glass-squeak-2";
}

function updateReverseSlideSfxPresetUI() {
  const sec = ensureSecretState();
  // Prefer saved preset when syncing UI (don't fight a mid-change select)
  let preset = sec.reverseSlideSfxPreset || "glass-squeak-2";
  if (preset === "default") preset = "glass-squeak-2";
  if (preset === "synth") preset = "scp-173";
  if (!REVERSE_SLIDE_PRESET_IDS.has(preset) || preset === "synth") {
    preset =
      preset === "synth"
        ? "scp-173"
        : sec.reverseSlideSfxData
          ? "custom"
          : "glass-squeak-2";
  }
  if (preset === "custom" && !sec.reverseSlideSfxData) {
    preset = "glass-squeak-2";
  }
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

function updateSectionWinEffectUI() {
  const sel = $("#section-win-effect");
  const row = $("#section-win-effect-custom-row");
  const nameEl = $("#section-win-effect-name");
  if (!sel) return;
  if (sectionEditCustom?.winEffect) {
    const v = sel.value;
    if (v !== "none" && v !== "confetti" && v !== "custom") {
      // Prefer pending type from last load
      const we =
        pendingSectionWinEffectData
          ? "custom"
          : sectionEditCustom.winEffect
            ? "confetti"
            : "inherit";
      sel.value =
        we === "custom" || we === "confetti" || we === "none" ? we : "confetti";
    }
  } else {
    sel.value = "inherit";
  }
  // When opening, set from custom flag
  if (sectionEditCustom?.winEffect === true && !sectionEditDirty.winEffect) {
    // leave select as set by openSectionModal below
  }
  const isCustom = sel.value === "custom";
  if (row) {
    row.hidden = !isCustom;
    row.style.display = isCustom ? "" : "none";
  }
  if (nameEl) {
    nameEl.textContent =
      pendingSectionWinEffectName ||
      (pendingSectionWinEffectData ? "Custom media" : "No custom file");
  }
}

function updateGroupWinEffectCustomUI() {
  const sel = $("#group-win-effect");
  const row = $("#group-win-effect-custom-row");
  const nameEl = $("#group-win-effect-name");
  const isCustom = sel?.value === "custom";
  if (row) {
    row.hidden = !isCustom;
    row.style.display = isCustom ? "" : "none";
  }
  if (nameEl) {
    nameEl.textContent =
      pendingGroupWinEffectName ||
      (pendingGroupWinEffectData ? "Custom media" : "No custom file");
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
 * Each preset uses its own buffer key so switching never plays a stale sample.
 * @param {string|null} [bufferKey] force a key; default from current preset
 * @param {boolean} [forceReload] re-fetch even if already buffered
 * @returns {Promise<boolean>} true if a sample buffer is ready
 */
async function ensureReverseSlideSfxBuffer(bufferKey = null, forceReload = false) {
  const sec = ensureSecretState();
  let preset = getReverseSlideSfxPreset();
  if (preset === "synth") preset = "scp-173";
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
    const meta =
      REVERSE_SLIDE_PRESETS[preset] ||
      REVERSE_SLIDE_PRESETS["glass-squeak-2"];
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
  let preset = getReverseSlideSfxPreset();
  if (preset === "synth") preset = "scp-173";
  sec.reverseSlideSfxPreset = preset;
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
      // Last resort: play divert default buffer if already loaded
      if (audio.buffers.has("rig_divert")) {
        audio.playDivert("rig_divert", vol);
      }
    })
    .catch(() => {
      if (audio.buffers.has("rig_divert")) {
        audio.playDivert("rig_divert", vol);
      }
    });
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
  // Only pull live form → state while Secret is open.
  // Otherwise DOM defaults (kind=section, unchecked boxes) clobber saved reverse group.
  try {
    if (isSecretTabActive()) {
      saveSecretPanel();
    }
  } catch {
    /* ignore */
  }
  const forceId = getRigForceSectionId();
  const avoidIds = getReverseAvoidSectionIds();
  const avoidGroupId = getReverseAvoidGroupId();
  const comboOrder = getSecretComboOrder();
  return {
    forceSectionId: forceId,
    avoidSectionIds: avoidIds.length ? avoidIds : null,
    /** Expand avoid set on the wheel from live slice group membership */
    avoidGroupId: avoidGroupId || null,
    landZonePct: getLandZonePct(),
    maxSpeedScale: getMaxSpeedScale(),
    steerMs: getDivertSteerMs(),
    reverseSteerMs: getReverseSteerMs(),
    comboOrder,
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
  const sec = ensureSecretState();
  sec.comboOrder =
    $("#secret-combo-order")?.value === "rig-first"
      ? "rig-first"
      : "reverse-first";
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

  let preset = getReverseSlideSfxPreset();
  if (preset === "synth") preset = "scp-173";
  sec.reverseSlideSfxPreset = preset;
  const key = reverseSlideBufferKey(preset);
  const ok = await ensureReverseSlideSfxBuffer(key, true);
  if (ok && audio.buffers.has(key)) {
    audio.playOneShot(key, vol, "land", true);
    return;
  }
  // Fallback to divert sample
  const okDivert = await ensureDivertSfxBuffer("preview_rig_divert");
  if (okDivert) {
    audio.playOneShot("preview_rig_divert", vol, "land", true);
  }
}

$("#secret-reverse-slide-sfx-preset")?.addEventListener("change", async () => {
  const sec = ensureSecretState();
  let v = $("#secret-reverse-slide-sfx-preset")?.value;
  if (v === "default") v = "glass-squeak-2";
  if (v === "synth") v = "scp-173";
  if (!v || !REVERSE_SLIDE_PRESET_IDS.has(v)) v = "glass-squeak-2";
  if (v === "synth") v = "scp-173";
  sec.reverseSlideSfxPreset = v;
  // Write through immediately so spin / manual preview read the new preset
  persist();
  if (v === "custom" && !sec.reverseSlideSfxData) {
    updateReverseSlideSfxPresetUI();
    $("#secret-reverse-slide-sfx-input")?.click();
    return;
  }
  updateReverseSlideSfxPresetUI();
  // Preload the chosen buffer (no auto-preview — use Preview button)
  try {
    await ensureReverseSlideSfxBuffer(reverseSlideBufferKey(v), true);
  } catch (err) {
    console.warn("Reverse slide load failed:", err);
  }
});
$("#secret-reverse-slide-sfx-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) {
    if (!ensureSecretState().reverseSlideSfxData) {
      ensureSecretState().reverseSlideSfxPreset = "glass-squeak-2";
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
});
$("#secret-reverse-slide-sfx-clear")?.addEventListener("click", async () => {
  const sec = ensureSecretState();
  sec.reverseSlideSfxPreset = "glass-squeak-2";
  sec.reverseSlideSfxData = null;
  sec.reverseSlideSfxName = null;
  audio.buffers.delete(reverseSlideBufferKey("custom"));
  updateReverseSlideSfxPresetUI();
  persist();
  try {
    await ensureReverseSlideSfxBuffer(
      reverseSlideBufferKey("glass-squeak-2"),
      true
    );
  } catch {
    /* ignore */
  }
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
  // Manual hide — don't also run eliminate-after-win
  pendingEliminateId = null;
  pendingEliminateMode = null;
  checkpoint();
  hideSectionWithReturn(section);
  lastWinnerId = null;
  // Clear overlay without re-running eliminate
  resultBanner.classList.add("hidden");
  resultCenter.classList.add("hidden");
  resultActionsBar.classList.add("hidden");
  clearResultCenterBg();
  resultShowsRigged = false;
  setResultRiggedVisible(isRigItActive() || isReverseRigActive());
  persist();
  renderSections();
  scheduleNextSectionReturnCheck();
  await refreshWheel();
}

async function removeWinnerPart() {
  if (!lastWinnerId) return;
  const section = state.sections.find((s) => s.id === lastWinnerId);
  if (!section) return;
  if (!confirm(`Remove "${section.label}" from the wheel permanently?`)) return;
  pendingEliminateId = null;
  pendingEliminateMode = null;
  checkpoint();
  state.sections = state.sections.filter((s) => s.id !== lastWinnerId);
  ensureYourOrderIds();
  onSectionsStructureChanged();
  lastWinnerId = null;
  resultBanner.classList.add("hidden");
  resultCenter.classList.add("hidden");
  resultActionsBar.classList.add("hidden");
  clearResultCenterBg();
  resultShowsRigged = false;
  setResultRiggedVisible(isRigItActive() || isReverseRigActive());
  persist();
  updateSectionSortUI();
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
  if ($("#chk-spin-center-hub")) {
    state.look.spinCenterHub = $("#chk-spin-center-hub").checked === true;
  }
  state.look.borderColor = $("#border-color").value;
  state.look.textColor = $("#text-color").value;
  if ($("#winner-text-color")) {
    state.look.winnerTextColor = $("#winner-text-color").value;
  }
  if ($("#text-style")) {
    state.look.textStyle = normalizeTextStyle($("#text-style").value, "bold");
  }
  if ($("#text-font")) {
    state.look.textFont = normalizeTextFont($("#text-font").value, "system");
  }
  // forceTextColor / forceTextStyle / forceTextFont / forceWinnerTextColor: Override buttons
  state.look.showLabels = $("#chk-show-labels").checked;
  state.look.showImages = $("#chk-show-images").checked;
  if ($("#image-layout-mode")) {
    state.look.imageLayoutMode = normalizeImageLayoutMode(
      $("#image-layout-mode").value
    );
  }
  if ($("#chk-pointer-locked")) {
    state.look.pointerLocked = $("#chk-pointer-locked").checked;
  }
  state.look.resultStyle = $("#result-style").value === "banner" ? "banner" : "center";
  {
    const wl = ($("#winner-label")?.value || "").trim().slice(0, 300);
    state.look.winnerLabel = wl || "Winner";
  }
  state.look.allowWinnerRemove = $("#chk-allow-winner-remove").checked;
  if ($("#chk-allow-winner-hide")) {
    state.look.allowWinnerHide = $("#chk-allow-winner-hide").checked;
  }
  {
    const v = $("#eliminate-after-win")?.value;
    state.look.eliminateAfterWin =
      v === "hide" || v === "remove" ? v : "off";
  }
  if ($("#win-effect")) {
    const v = $("#win-effect").value;
    if (v === "none" || v === "custom") state.look.winEffect = v;
    else state.look.winEffect = "confetti";
    if (state.look.winEffect === "custom" && !state.look.winEffectData) {
      state.look.winEffect = "confetti";
    }
  }
  updateLookWinEffectCustomUI();
  if ($("#chk-keyboard-spin")) {
    state.look.keyboardSpin = $("#chk-keyboard-spin").checked;
  }
  if ($("#chk-double-click-spin")) {
    state.look.allowDoubleClickSpin =
      $("#chk-double-click-spin").checked !== false;
  }
  if ($("#chk-wheel-drag")) {
    state.look.allowWheelDrag = $("#chk-wheel-drag").checked !== false;
  }
  if ($("#chk-grab-stop-spin")) {
    state.look.allowGrabStopSpin =
      $("#chk-grab-stop-spin").checked !== false;
  }
  if ($("#chk-fair-drag-spin")) {
    state.look.fairDragSpin = $("#chk-fair-drag-spin").checked === true;
  }
  if ($("#chk-auto-spin")) {
    state.look.autoSpin = $("#chk-auto-spin").checked === true;
  }
  {
    let n = Number($("#auto-spin-value")?.value);
    if (!Number.isFinite(n) || n < 1) n = 1;
    state.look.autoSpinEvery = Math.min(9999, Math.round(n));
    if ($("#auto-spin-value")) {
      $("#auto-spin-value").value = String(state.look.autoSpinEvery);
    }
    const u = $("#auto-spin-unit")?.value;
    state.look.autoSpinUnit =
      u === "seconds" || u === "hours" || u === "days" ? u : "minutes";
  }
  updateAutoSpinUI();
  // auto-dismiss-sec: committed by commitAutoDismissSec (allow free typing / clear 0)
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
  scheduleAutoSpin();
}

["bg-color", "center-color", "center-size", "chk-spin-center-hub", "border-color", "text-color", "text-style", "text-font", "winner-text-color", "chk-show-labels", "chk-show-images", "image-layout-mode", "chk-pointer-locked", "result-style", "winner-label", "chk-allow-winner-hide", "chk-allow-winner-remove", "eliminate-after-win", "win-effect", "chk-keyboard-spin", "chk-double-click-spin", "chk-wheel-drag", "chk-grab-stop-spin", "chk-fair-drag-spin", "chk-auto-spin", "auto-spin-value", "auto-spin-unit", "weight-slider-min", "weight-slider-max", "weight-slider-step"].forEach(
  (id) => {
    $(`#${id}`)?.addEventListener("input", onLookChange);
    $(`#${id}`)?.addEventListener("change", () => {
      onLookChange();
      endContinuous();
    });
  }
);

/**
 * Parse auto-dismiss seconds from the Look field.
 * Allows mid-edit empty / "-" without forcing "0" back into the box.
 * @param {string} raw
 * @param {{ commitEmpty?: boolean }} [opts]
 * @returns {number|null} null = leave field alone (incomplete edit)
 */
function parseAutoDismissSec(raw, opts = {}) {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "-") {
    return opts.commitEmpty ? 0 : null;
  }
  let ad = Number(s);
  if (!Number.isFinite(ad)) {
    return opts.commitEmpty ? 0 : null;
  }
  if (ad < 0) ad = -1;
  else ad = Math.min(99999, Math.max(0, Math.round(ad)));
  return ad;
}

/** Commit auto-dismiss field → state (clamp + rewrite display). */
function commitAutoDismissSec() {
  const el = $("#auto-dismiss-sec");
  if (!el) return;
  const ad = parseAutoDismissSec(el.value, { commitEmpty: true });
  const n = ad == null ? 0 : ad;
  state.look.autoDismissSec = n;
  el.value = String(n);
}

$("#auto-dismiss-sec")?.addEventListener("input", () => {
  checkpointContinuous();
  const el = $("#auto-dismiss-sec");
  if (!el) return;
  // Free typing: don't rewrite the input (so you can delete 0 / type -1)
  const ad = parseAutoDismissSec(el.value, { commitEmpty: false });
  if (ad != null) {
    state.look.autoDismissSec = ad;
    persist();
  }
});
$("#auto-dismiss-sec")?.addEventListener("change", () => {
  checkpoint();
  commitAutoDismissSec();
  persist();
  endContinuous();
});
$("#auto-dismiss-sec")?.addEventListener("blur", () => {
  // Ensure empty/partial is normalized when leaving the field
  commitAutoDismissSec();
  persist();
  endContinuous();
});
$("#auto-dismiss-sec")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitAutoDismissSec();
    persist();
    endContinuous();
    e.currentTarget?.blur?.();
  }
});

function updateLookWinEffectCustomUI() {
  const row = $("#look-win-effect-custom-row");
  const nameEl = $("#look-win-effect-name");
  const isCustom = $("#win-effect")?.value === "custom";
  if (row) row.hidden = !isCustom;
  if (nameEl) {
    nameEl.textContent =
      state.look?.winEffectName ||
      (state.look?.winEffectData ? "Custom media" : "No custom file");
  }
}

$("#win-effect")?.addEventListener("change", () => {
  updateLookWinEffectCustomUI();
});

$("#look-win-effect-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    checkpoint();
    const { data, name } = await loadWinEffectFile(file);
    state.look.winEffectData = data;
    state.look.winEffectName = name;
    state.look.winEffect = "custom";
    if ($("#win-effect")) $("#win-effect").value = "custom";
    persist();
    updateLookWinEffectCustomUI();
  } catch (err) {
    alert("Could not load file: " + (err.message || err));
  }
});

$("#look-win-effect-clear")?.addEventListener("click", () => {
  checkpoint();
  state.look.winEffectData = null;
  state.look.winEffectName = null;
  if (state.look.winEffect === "custom") state.look.winEffect = "confetti";
  if ($("#win-effect")) $("#win-effect").value = state.look.winEffect;
  persist();
  updateLookWinEffectCustomUI();
});

$("#look-win-effect-preview")?.addEventListener("click", () => {
  const we = state.look?.winEffect || "confetti";
  if (we === "none") return;
  if (we === "confetti") fireConfetti();
  else if (we === "custom" && state.look?.winEffectData) {
    playCustomWinMedia(state.look.winEffectData, {
      fileName: state.look.winEffectName || "",
    });
  } else {
    alert(
      "Choose a custom media file first (WebM, WebP, PNG, or MP4)."
    );
  }
});

// --- Movable winner pointer (Look → unlock to drag) ---
const POINTER_SNAP_DEGS = [0, 90, 180, 270];
const POINTER_SNAP_WINDOW = 5; // degrees — tight magnetic snap only near cardinals

/** @param {number} deg */
function normalizePointerDeg(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  return ((d % 360) + 360) % 360;
}

/** Magnetic snap to top / right / bottom / left while dragging. */
function snapPointerDeg(deg) {
  let d = normalizePointerDeg(deg);
  let best = d;
  let bestDist = Infinity;
  for (const s of POINTER_SNAP_DEGS) {
    let dist = Math.abs(d - s);
    if (dist > 180) dist = 360 - dist;
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (bestDist <= POINTER_SNAP_WINDOW) return best;
  return d;
}

/**
 * Client coords → pointer degrees (0 = top, CW).
 * @param {number} clientX
 * @param {number} clientY
 */
function pointerDegFromClient(clientX, clientY) {
  const stage = $("#stage");
  if (!stage) {
    const d = Number(state.look?.pointerAngleDeg);
    return Number.isFinite(d) ? normalizePointerDeg(d) : 90;
  }
  const rect = stage.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // Canvas-style angle: 0 east, CW
  const ang = Math.atan2(clientY - cy, clientX - cx);
  // 0° = top: canvas −π/2 → deg 0
  return normalizePointerDeg((ang * 180) / Math.PI + 90);
}

function applyPointerAngleDeg(deg, { persistNow = false, snap = true } = {}) {
  let d = normalizePointerDeg(deg);
  if (snap) d = snapPointerDeg(d);
  state.look.pointerAngleDeg = d;
  if (wheel?.look) wheel.look.pointerAngleDeg = d;
  try {
    wheel?.layoutPointer?.();
  } catch {
    /* ignore */
  }
  // Redraw labels/fills so "under pointer" stays consistent if anything peeks
  try {
    if (wheel && !wheel.spinning) wheel.draw({ spinFrame: false });
  } catch {
    /* ignore */
  }
  if (persistNow) {
    persist();
  }
}

const pointerDrag = {
  active: false,
  pointerId: null,
};

function bindPointerDrag() {
  const el = $("#pointer");
  if (!el || el.dataset.pointerDragBound === "1") return;
  el.dataset.pointerDragBound = "1";

  el.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    if (state.look?.pointerLocked !== false) return;
    if (wheel.spinning || wheel._dragging || spinBusy) return;
    e.preventDefault();
    e.stopPropagation();
    pointerDrag.active = true;
    pointerDrag.pointerId = e.pointerId;
    el.classList.add("is-dragging");
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    checkpointContinuous();
    applyPointerAngleDeg(pointerDegFromClient(e.clientX, e.clientY), {
      snap: true,
    });
  });

  el.addEventListener("pointermove", (e) => {
    if (!pointerDrag.active) return;
    if (
      pointerDrag.pointerId != null &&
      e.pointerId !== pointerDrag.pointerId
    ) {
      return;
    }
    e.preventDefault();
    applyPointerAngleDeg(pointerDegFromClient(e.clientX, e.clientY), {
      snap: true,
    });
  });

  const endPtr = (e) => {
    if (!pointerDrag.active) return;
    if (
      e &&
      pointerDrag.pointerId != null &&
      e.pointerId !== pointerDrag.pointerId
    ) {
      return;
    }
    pointerDrag.active = false;
    pointerDrag.pointerId = null;
    el.classList.remove("is-dragging");
    // Final snap + save
    applyPointerAngleDeg(
      Number.isFinite(Number(state.look?.pointerAngleDeg))
        ? state.look.pointerAngleDeg
        : 90,
      {
        snap: true,
        persistNow: true,
      }
    );
    endContinuous();
  };

  el.addEventListener("pointerup", endPtr);
  el.addEventListener("pointercancel", endPtr);
}

$("#bg-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (isGifFile(file)) {
    alert("GIF images are not supported (they lag the wheel). Use PNG, JPEG, or WebP.");
    return;
  }
  if (!isImageFile(file)) {
    alert("Please choose an image file (PNG, JPEG, or WebP).");
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
  if (isGifFile(file)) {
    alert("GIF images are not supported (they lag the wheel). Use PNG, JPEG, or WebP.");
    return;
  }
  if (!isImageFile(file)) {
    alert("Please choose an image file (PNG, JPEG, or WebP).");
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

/** Landable % of each section arc (1–99). Centered; edges stay clear of borders. */
function getLandZonePct() {
  let n = Number(state.spin?.landZonePct);
  if (!Number.isFinite(n)) n = 99;
  return Math.min(99, Math.max(1, Math.round(n)));
}

function syncLandZoneUI() {
  const pct = getLandZonePct();
  state.spin.landZonePct = pct;
  const slider = $("#spin-land-zone");
  const label = $("#spin-land-zone-label");
  if (slider) slider.value = String(pct);
  if (label) label.textContent = `${pct}%`;
}

/** Peak spin intensity vs default (25–200%). 100 = normal. */
function getMaxSpeedPct() {
  let n = Number(state.spin?.maxSpeedPct);
  if (!Number.isFinite(n)) n = 100;
  return Math.min(200, Math.max(25, Math.round(n)));
}

/** Multiplier passed into wheel.spin / wheel.fling (1 = default). */
function getMaxSpeedScale() {
  return getMaxSpeedPct() / 100;
}

function syncMaxSpeedUI() {
  const pct = getMaxSpeedPct();
  state.spin.maxSpeedPct = pct;
  const slider = $("#spin-max-speed");
  const label = $("#spin-max-speed-label");
  if (slider) slider.value = String(pct);
  if (label) label.textContent = `${pct}%`;
}

/**
 * Resolve how long this timed spin should last (seconds).
 * When “spin until BGM ends” is on, uses the loaded track length.
 */
async function resolveSpinDurationSec() {
  const fallback = clampSpinDuration(state.spin?.duration ?? 9);
  if (state.spin?.untilBgmEnds !== true) return fallback;
  if (!state.sound?.enabled || state.sound.bgmMode === "off") {
    return fallback;
  }
  try {
    const ok = await ensureBgmBuffer();
    if (!ok) return fallback;
    const d = audio.getBufferDuration("bgm");
    if (!(d > 0.25)) return fallback;
    return clampSpinDuration(d);
  } catch (err) {
    console.warn("BGM duration for spin:", err);
    return fallback;
  }
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
  updateSpinUntilBgmUI();
}

function updateSpinUntilBgmUI() {
  const on = state.spin?.untilBgmEnds === true;
  const chk = $("#chk-spin-until-bgm-ends");
  if (chk) chk.checked = on;
  const field = $("#spin-duration-field");
  if (field) {
    field.classList.toggle("is-disabled", on);
    field.querySelectorAll("input").forEach((el) => {
      el.disabled = on;
    });
  }
  const hint = $("#spin-until-bgm-hint");
  if (hint) {
    hint.hidden = !on;
    if (on) {
      const d = audio.getBufferDuration?.("bgm") || 0;
      if (d > 0.25) {
        const sec = Math.round(d * 10) / 10;
        hint.textContent = `Spin length matches the current BGM track (~${sec}s). Music plays once from the start. Fixed duration is ignored.`;
      } else {
        hint.textContent =
          "Spin length matches the current Sound → Background music track (plays once from the start). Fixed duration above is ignored. Load/play music once if length shows later.";
      }
    }
  }
}

function bindSpinDuration() {
  syncSpinDurationUI(state.spin.duration ?? 9);
  updateSpinUntilBgmUI();
  syncLandZoneUI();
  syncMaxSpeedUI();
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

$("#chk-spin-until-bgm-ends")?.addEventListener("change", async () => {
  checkpoint();
  state.spin.untilBgmEnds = $("#chk-spin-until-bgm-ends")?.checked === true;
  updateSpinUntilBgmUI();
  persist();
  // Prefetch track length for the hint
  if (state.spin.untilBgmEnds) {
    try {
      await ensureBgmBuffer();
      updateSpinUntilBgmUI();
    } catch {
      /* ignore */
    }
  }
});

$("#spin-land-zone")?.addEventListener("input", () => {
  checkpointContinuous();
  let n = Number($("#spin-land-zone")?.value);
  if (!Number.isFinite(n)) n = 99;
  state.spin.landZonePct = Math.min(99, Math.max(1, Math.round(n)));
  syncLandZoneUI();
  persist();
});
$("#spin-land-zone")?.addEventListener("change", () => endContinuous());

$("#spin-max-speed")?.addEventListener("input", () => {
  checkpointContinuous();
  let n = Number($("#spin-max-speed")?.value);
  if (!Number.isFinite(n)) n = 100;
  state.spin.maxSpeedPct = Math.min(200, Math.max(25, Math.round(n)));
  syncMaxSpeedUI();
  persist();
});
$("#spin-max-speed")?.addEventListener("change", () => endContinuous());

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
/**
 * @param {boolean} collapsed
 * @param {{ persistUi?: boolean }} [opts] persistUi=true writes look.hidePanels
 */
function setSidebarCollapsed(collapsed, { persistUi = false } = {}) {
  const layout = $("#main-layout");
  const btn = $("#btn-toggle-sidebar");
  if (!layout || !btn) return;
  const on = !!collapsed;
  layout.classList.toggle("sidebar-collapsed", on);
  btn.setAttribute("aria-expanded", on ? "false" : "true");
  btn.title = on
    ? "Show panels"
    : "Hide panels (fullscreen wheel)";
  const label = btn.querySelector(".toggle-sidebar-label");
  if (label) label.textContent = on ? "Show panels" : "Hide panels";
  if (state?.look) state.look.hidePanels = on;
  if (persistUi) persist();
  // Let layout settle, then redraw wheel to new size
  requestAnimationFrame(() => {
    wheel.resize();
    requestAnimationFrame(() => wheel.resize());
  });
}

/** Apply saved Hide panels preference (after load / switch / import). */
function applyHidePanelsFromState() {
  setSidebarCollapsed(!!state?.look?.hidePanels, { persistUi: false });
}

function setFocusMode(on) {
  const active = !!on;
  document.body.classList.toggle("focus-mode", active);
  const exit = $("#btn-exit-focus");
  if (exit) {
    exit.hidden = !active;
    exit.setAttribute("aria-hidden", active ? "false" : "true");
  }
  const focusBtn = $("#btn-focus-mode");
  if (focusBtn) {
    focusBtn.setAttribute("aria-pressed", active ? "true" : "false");
    focusBtn.textContent = active ? "Exit focus" : "Focus";
  }
  // Collapse panels when entering focus; restore layout size
  if (active) setSidebarCollapsed(true);
  requestAnimationFrame(() => {
    try {
      wheel.resize();
      requestAnimationFrame(() => {
        wheel.resize();
        wheel.layoutPointer?.();
      });
    } catch {
      /* ignore */
    }
  });
}

function toggleFocusMode() {
  setFocusMode(!document.body.classList.contains("focus-mode"));
}

$("#btn-toggle-sidebar")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const layout = $("#main-layout");
  const collapsed = !layout?.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed, { persistUi: true });
});

$("#btn-focus-mode")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFocusMode();
});
$("#btn-exit-focus")?.addEventListener("click", (e) => {
  e.stopPropagation();
  setFocusMode(false);
});

// --- Share / export this wheel only ---
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * UTF-8 string → standard base64 (chunked; safe for large image payloads).
 * Avoids encodeURIComponent/escape and apply() argument limits.
 */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  const chunk = 0x2000; // stay under apply() arg limits in older engines
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    let part = "";
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    binary += part;
  }
  return btoa(binary);
}

/**
 * Base64 → UTF-8 string. Tolerates URL-safe alphabet, missing padding, whitespace.
 */
function base64ToUtf8(b64) {
  let s = String(b64 || "")
    .trim()
    .replace(/\s+/g, "")
    // URL-safe variants
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  // Drop anything that isn't base64 (truncation/noise from chats)
  s = s.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!s) throw new Error("Share link is empty");
  const pad = s.length % 4;
  if (pad === 1) {
    throw new Error(
      "Share link looks truncated or corrupted (incomplete base64). Try Export → download JSON instead of a link."
    );
  }
  if (pad) s += "=".repeat(4 - pad);
  let binary;
  try {
    binary = atob(s);
  } catch {
    throw new Error(
      "Share link looks truncated or corrupted. Try Export / Import with a JSON file (links with big images often break when pasted)."
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return binary;
  }
}

function getCurrentWheelSharePayload() {
  syncUiPrefsIntoState();
  const slot = getActiveSlot(library);
  return {
    format: "sad-wheel-v1",
    name: slot?.name || "Wheel",
    exportedAt: new Date().toISOString(),
    data: state,
  };
}

/**
 * Large / image wheels are hosted (#b= / #j=) instead of embedding multi‑MB
 * data in the URL. No third-party TinyURL / is.gd — the hosted app link is enough.
 */
const SHARE_INLINE_MAX_B64 = 8000;

function payloadHasImages(payload) {
  const d = payload?.data || payload;
  if (!d || typeof d !== "object") return false;
  if (d.look?.backgroundImage || d.look?.centerImage || d.look?.winEffectData)
    return true;
  for (const s of d.sections || []) {
    if (s?.imageData || s?.winEffectData || s?.landSfxData) return true;
  }
  for (const g of d.groups || []) {
    if (g?.imageData || g?.winEffectData || g?.landSfxData) return true;
  }
  return false;
}

/** Strip bulky media so a compact share stays pasteable if full host fails. */
function stripSharePayloadMedia(payload) {
  const p = JSON.parse(JSON.stringify(payload));
  const d = p.data || p;
  if (d.look) {
    d.look.backgroundImage = null;
    d.look.centerImage = null;
    d.look.winEffectData = null;
    d.look.winEffectName = null;
  }
  for (const s of d.sections || []) {
    s.imageData = null;
    s.winEffectData = null;
    s.winEffectName = null;
    s.landSfxData = null;
    s.landSfxName = null;
    s.customImage = false;
    // Per-section win BGM can be multi‑MB
    s.winBgmData = null;
    s.winBgmName = null;
    if (s.winBgm === "custom") s.winBgm = "inherit";
  }
  for (const g of d.groups || []) {
    g.imageData = null;
    g.winEffectData = null;
    g.winEffectName = null;
    g.landSfxData = null;
    g.landSfxName = null;
  }
  if (d.sound) {
    d.sound.spinSfxData = null;
    d.sound.landSfxData = null;
    d.sound.bgmData = null;
  }
  return p;
}

/**
 * Fetch with a timeout so Share doesn't hang forever.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [ms]
 */
async function fetchWithTimeout(url, init = {}, ms = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** bytebin.lucko.me — CORS OK from GitHub Pages, good for larger JSON. */
async function uploadSharePayloadToBytebin(payload) {
  const res = await fetchWithTimeout("https://bytebin.lucko.me/post", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`bytebin ${res.status}`);
  // Prefer JSON body (reliable); Location is often just the bare key
  let key = "";
  try {
    const data = await res.clone().json();
    key = data?.key || "";
  } catch {
    /* ignore */
  }
  if (!key) {
    key = (res.headers.get("Location") || "").trim();
  }
  key = String(key)
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^\//, "")
    .trim();
  if (!key) throw new Error("bytebin: no key");
  return { kind: "b", id: key };
}

/** jsonblob.com — CORS OK; anonymous blobs ~24h (size-limited). */
async function uploadSharePayloadToJsonBlob(payload) {
  const res = await fetchWithTimeout("https://jsonblob.com/api/jsonBlob", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`jsonblob ${res.status}`);
  let id =
    res.headers.get("X-jsonblob-id") ||
    res.headers.get("x-jsonblob-id") ||
    "";
  if (!id) {
    const loc = res.headers.get("Location") || res.headers.get("location") || "";
    const m = loc.match(/jsonBlob\/([^/?#]+)/i);
    id = m?.[1] || loc.replace(/^\/api\/jsonBlob\//i, "").replace(/^\//, "");
  }
  if (!id) throw new Error("jsonblob: no id");
  return { kind: "j", id: String(id).trim() };
}

/**
 * Host full share payload. Tries bytebin then jsonblob.
 * @param {object} payload
 */
async function uploadSharePayload(payload) {
  const errors = [];
  try {
    return await uploadSharePayloadToBytebin(payload);
  } catch (e1) {
    errors.push(e1);
    console.warn("bytebin host failed:", e1);
  }
  try {
    return await uploadSharePayloadToJsonBlob(payload);
  } catch (e2) {
    errors.push(e2);
    console.warn("jsonblob host failed:", e2);
  }
  throw new Error(
    "Could not host share payload: " +
      errors.map((e) => e?.message || e).join("; ")
  );
}

/**
 * Shorten an already-short app URL (e.g. …#b=key) via free shorteners.
 * Skips mega-links that shorteners reject.
 * @param {string} longUrl
 * @returns {Promise<string|null>}
 */
async function shortenAppUrl(longUrl) {
  const url = String(longUrl || "");
  // Only shorten hosted short hashes — not multi-MB #wheel= payloads
  if (!url || url.length > 1800) return null;
  if (!/#([bj])=/.test(url) && !/#wheel=/.test(url)) {
    // Still try for normal app URLs under limit
  }
  if (/#wheel=/.test(url) && url.length > 500) return null;

  const tryIsGd = async (api) => {
    const u = new URL(api);
    u.searchParams.set("format", "json");
    u.searchParams.set("url", url);
    const res = await fetchWithTimeout(u.toString(), { method: "GET" }, 12000);
    if (!res.ok) throw new Error(`${api} ${res.status}`);
    const data = await res.json();
    if (data?.shorturl) return String(data.shorturl);
    if (data?.errormessage) throw new Error(data.errormessage);
    throw new Error("no shorturl");
  };

  try {
    const s = await tryIsGd("https://is.gd/create.php");
    if (s) return s;
  } catch (e) {
    console.warn("is.gd shorten failed:", e);
  }
  try {
    const s = await tryIsGd("https://v.gd/create.php");
    if (s) return s;
  } catch (e) {
    console.warn("v.gd shorten failed:", e);
  }
  try {
    const res = await fetchWithTimeout(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
      { method: "GET" },
      12000
    );
    if (!res.ok) throw new Error(`tinyurl ${res.status}`);
    const text = (await res.text()).trim();
    if (/^https?:\/\/\S+$/i.test(text)) return text;
    throw new Error(text || "tinyurl failed");
  } catch (e) {
    console.warn("tinyurl shorten failed:", e);
  }
  return null;
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("Clipboard write failed:", err);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

function getShareAppBase() {
  return `${location.origin}${location.pathname}${location.search}`.replace(
    /#$/,
    ""
  );
}

/**
 * Build a paste-friendly share URL.
 * Always try hosting first (#b= / #j=) so the link is short, then optionally
 * shorten that app URL via is.gd / v.gd / tinyurl.
 */
async function buildShareCopyUrl(payload) {
  const base = getShareAppBase();
  let b64 = null;
  try {
    b64 = utf8ToBase64(JSON.stringify(payload));
  } catch (err) {
    console.warn("base64 encode failed:", err);
  }

  let appUrl = null;
  let note = "";
  let hosted = false;
  let inline = false;
  let compact = false;
  let shortened = false;
  let mediaStripped = false;

  // 1) Always try to host the full wheel for a short #b= / #j= link
  try {
    const up = await uploadSharePayload(payload);
    appUrl =
      up.kind === "b"
        ? `${base}#b=${encodeURIComponent(up.id)}`
        : `${base}#j=${encodeURIComponent(up.id)}`;
    hosted = true;
    note =
      "Short share link ready (includes images).\n\n" +
      "⏱ Hosted link may expire after about 24 hours.\n" +
      "For a permanent copy: Export JSON → send the file → Import.\n\n";
  } catch (hostErr) {
    console.warn("Share host (full) failed:", hostErr);
  }

  // 2) Host a media-stripped copy (still a short #b=/#j= link)
  if (!appUrl) {
    try {
      const slim = stripSharePayloadMedia(payload);
      const up = await uploadSharePayload(slim);
      appUrl =
        up.kind === "b"
          ? `${base}#b=${encodeURIComponent(up.id)}`
          : `${base}#j=${encodeURIComponent(up.id)}`;
      hosted = true;
      mediaStripped = true;
      compact = true;
      note =
        "Short share link ready — images/sounds were removed so hosting would work.\n" +
        "⏱ Hosted link may expire ~24h. For full media use Export JSON.\n\n";
    } catch (hostErr2) {
      console.warn("Share host (compact) failed:", hostErr2);
    }
  }

  // 3) Small wheels: inline #wheel= only if hosting failed
  if (!appUrl && b64 && b64.length <= SHARE_INLINE_MAX_B64) {
    appUrl = `${base}#wheel=${b64}`;
    inline = true;
    note =
      "Share link ready (embedded in the URL — hosting was unavailable).\n" +
      "If paste fails, use Export JSON.\n\n";
  }

  // 4) Last resort: always still a link (never a file download)
  if (!appUrl) {
    const slim = stripSharePayloadMedia(payload);
    let slimB64 = "";
    try {
      slimB64 = utf8ToBase64(JSON.stringify(slim));
    } catch {
      slimB64 = "";
    }
    if (slimB64) {
      appUrl = `${base}#wheel=${slimB64}`;
      compact = true;
      mediaStripped = true;
      note =
        "Long compact link (images/sounds removed — hosting was unavailable).\n" +
        "Paste may fail in some apps if it is huge — try Share again later for a short link.\n\n";
    } else if (b64) {
      appUrl = `${base}#wheel=${b64}`;
      inline = true;
      note =
        "Long share link (hosting was unavailable).\n" +
        "If paste fails, try Share again when online.\n\n";
    } else {
      throw new Error(
        "Could not build a share link. Check your connection and try again."
      );
    }
  }

  // 5) Extra shorten only for already-short hosted / small links
  let shareUrl = appUrl;
  if (hosted || (inline && appUrl.length < 500)) {
    try {
      const short = await shortenAppUrl(appUrl);
      if (short && short.length < appUrl.length) {
        shareUrl = short;
        shortened = true;
        note =
          (hosted
            ? mediaStripped
              ? "Short link ready (media stripped for hosting).\n"
              : "Short link ready (includes images).\n"
            : "Short link ready.\n") +
          "⏱ Hosted data may expire ~24h — Export JSON for permanent.\n\n";
      }
    } catch (e) {
      console.warn("URL shorten skipped:", e);
    }
  }

  return {
    shareUrl,
    appUrl,
    note,
    inline,
    hosted,
    compact,
    shortened,
    mediaStripped,
  };
}

async function offerShareCopyPaste(shareUrl, titleLines) {
  const copied = await copyTextToClipboard(shareUrl);
  const body = copied
    ? `${titleLines}Copied to clipboard.\n\nCopy again from here if needed (select all → Ctrl+C, then OK):`
    : `${titleLines}Select the link and press Ctrl+C to copy, then OK:`;
  // Uses prompt-style dialog so the URL is selectable (native prompt fails in Electron)
  await safePrompt(body, shareUrl, "Share link");
}

async function shareCurrentWheel() {
  syncUiPrefsIntoState();
  library = writeActiveState(library, state);
  const payload = getCurrentWheelSharePayload();

  const btn = $("#btn-share-wheel");
  const prevLabel = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sharing…";
  }
  try {
    // Always a pasteable link — never download a file from Share
    const built = await buildShareCopyUrl(payload);
    if (!built?.shareUrl) {
      throw new Error("No share URL was produced");
    }
    const kind = built.shortened
      ? "Short link"
      : built.hosted
        ? "Hosted short link"
        : built.compact
          ? "Compact share link"
          : "Share link";
    await offerShareCopyPaste(
      built.shareUrl,
      `${built.note}${kind} ready.\n\n`
    );
  } catch (err) {
    console.warn("Share link failed:", err);
    alert(
      "Could not create a share link.\n\n" +
        (err?.message || err || "Unknown error") +
        "\n\nCheck your internet connection and try again. " +
        "Use Export only if you want a file on purpose."
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel || "Share";
    }
  }
}

$("#btn-share-wheel")?.addEventListener("click", () => {
  shareCurrentWheel().catch((err) => {
    console.error(err);
    alert("Share failed: " + (err.message || err));
  });
});

/**
 * Parse a #wheel=… payload or a bare base64/JSON string into a wheel object.
 * @param {string} raw
 */
function parseShareWheelPayload(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Nothing to import");
  // Full URL pasted
  const hashIdx = s.indexOf("#wheel=");
  if (hashIdx >= 0) s = s.slice(hashIdx + "#wheel=".length);
  else if (s.startsWith("wheel=")) s = s.slice("wheel=".length);
  // Already JSON
  if (s.startsWith("{")) {
    const payload = JSON.parse(s);
    return payload;
  }
  const json = base64ToUtf8(s);
  return JSON.parse(json);
}

/**
 * Load payload from a hosted short-share (#j=jsonblob-id).
 * @param {string} id
 */
async function fetchSharePayloadFromJsonBlob(id) {
  const clean = String(id || "").trim();
  if (!clean) throw new Error("Missing share id");
  const url = `https://jsonblob.com/api/jsonBlob/${encodeURIComponent(clean)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) {
    throw new Error(
      "This short share link has expired or was deleted (hosted links last about 24 hours)."
    );
  }
  if (!res.ok) throw new Error(`Could not download shared wheel (${res.status})`);
  return res.json();
}

/**
 * Load payload from bytebin.lucko.me (#b=key).
 * @param {string} key
 */
async function fetchSharePayloadFromBytebin(key) {
  const clean = String(key || "")
    .trim()
    .replace(/^https?:\/\/bytebin\.lucko\.me\//i, "")
    .replace(/^\//, "");
  if (!clean) throw new Error("Missing share id");
  const url = `https://bytebin.lucko.me/${encodeURIComponent(clean)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) {
    throw new Error(
      "This short share link has expired or was deleted (hosted links can expire after a while)."
    );
  }
  if (!res.ok) throw new Error(`Could not download shared wheel (${res.status})`);
  return res.json();
}

/** Import wheel from #wheel=… or hosted #b= / #j= share link (once on boot). */
async function tryImportShareHash() {
  const hash = location.hash || "";
  if (!hash || hash === "#") return;

  // Hosted short shares: #b=<bytebin-key> or #j=<jsonblob-id>
  const hostedB =
    hash.match(/^#b=([^&]+)/i) || hash.match(/^#bytebin=([^&]+)/i);
  const hostedJ =
    hash.match(/^#j=([^&]+)/i) || hash.match(/^#jsonblob=([^&]+)/i);
  // Inline base64: #wheel=...
  const isWheel = hash.startsWith("#wheel=");
  if (!hostedB && !hostedJ && !isWheel) return;

  try {
    let payload;
    if (hostedB) {
      payload = await fetchSharePayloadFromBytebin(
        decodeURIComponent(hostedB[1])
      );
    } else if (hostedJ) {
      payload = await fetchSharePayloadFromJsonBlob(
        decodeURIComponent(hostedJ[1])
      );
    } else {
      const b64 = hash.slice("#wheel=".length);
      if (b64.length < 20) {
        throw new Error(
          "Share link looks truncated. Try a short link from Share (with images) or Export JSON."
        );
      }
      try {
        payload = parseShareWheelPayload(b64);
      } catch (e) {
        try {
          payload = parseShareWheelPayload(decodeURIComponent(b64));
        } catch {
          throw e;
        }
      }
    }

    const data = payload?.data || payload;
    if (!data?.sections || !Array.isArray(data.sections)) {
      throw new Error("Link is not a valid wheel (missing sections)");
    }
    if (!data?.groups || !Array.isArray(data.groups)) {
      throw new Error("Link is not a valid wheel (missing groups)");
    }
    const name =
      (payload.name && String(payload.name)) ||
      "Shared wheel";
    if (
      !confirm(
        `Import shared wheel “${name}” as a new wheel?\n\nOK = add it\nCancel = ignore link`
      )
    ) {
      history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    library = writeActiveState(library, state);
    const result = addWheel(library, name, data);
    await applyLoadedWheel(result.lib, result.state);
    history.replaceState(null, "", location.pathname + location.search);
  } catch (err) {
    console.error("Share import failed:", err);
    const msg = String(err?.message || err || "Unknown error");
    alert(
      "Could not open share link:\n\n" +
        msg +
        "\n\nTip: use Share again for a short link, or Export JSON + Import."
    );
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* ignore */
    }
  }
}

// --- Spin (double-click / drag-fling the wheel) ---

/** Cap chained respin / switch-wheel actions so loops can't run forever. */
const MAX_LAND_ACTION_CHAIN = 20;
/** Depth of the current auto-respin / other-wheel chain (0 = user-started). */
let landActionChainDepth = 0;

// --- Auto spin (Look setting) ---
/** @type {ReturnType<typeof setTimeout>|0} */
let autoSpinTimer = 0;
/** Browsers clamp setTimeout delays around 2^31-1 ms (~24.8 days). */
const AUTO_SPIN_MAX_DELAY_MS = 2_147_483_647;

function updateAutoSpinUI() {
  const on = $("#chk-auto-spin")?.checked === true;
  const field = $("#auto-spin-interval-field");
  if (field) {
    field.classList.toggle("is-disabled", !on);
    const inputs = field.querySelectorAll("input, select");
    inputs.forEach((el) => {
      el.disabled = !on;
    });
  }
}

/**
 * Interval in ms from Look auto-spin settings (0 = off).
 * @returns {number}
 */
function getAutoSpinIntervalMs() {
  if (state.look?.autoSpin !== true) return 0;
  let n = Number(state.look.autoSpinEvery);
  if (!Number.isFinite(n) || n < 1) n = 1;
  n = Math.min(9999, Math.round(n));
  const unit = state.look.autoSpinUnit;
  let ms = n * 60_000; // minutes default
  if (unit === "seconds") ms = n * 1_000;
  else if (unit === "hours") ms = n * 3_600_000;
  else if (unit === "days") ms = n * 86_400_000;
  // Min 1s so we never fire in a tight loop; browser max ~24.8d for setTimeout
  return Math.min(AUTO_SPIN_MAX_DELAY_MS, Math.max(1_000, ms));
}

function clearAutoSpinTimer() {
  if (autoSpinTimer) {
    clearTimeout(autoSpinTimer);
    autoSpinTimer = 0;
  }
}

/** True when a win overlay is open and would block a clean auto-spin. */
function isResultOverlayOpen() {
  try {
    if (resultCenter && !resultCenter.classList.contains("hidden")) return true;
    if (resultBanner && !resultBanner.classList.contains("hidden")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Schedule the next auto spin from Look settings.
 * Resets any previous timer. No-op when auto spin is off or tab is hidden.
 */
function scheduleAutoSpin() {
  clearAutoSpinTimer();
  const ms = getAutoSpinIntervalMs();
  if (ms <= 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  autoSpinTimer = setTimeout(() => {
    autoSpinTimer = 0;
    void runAutoSpinTick();
  }, ms);
}

async function runAutoSpinTick() {
  try {
    if (state.look?.autoSpin !== true) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    // Wait out an in-progress spin / drag, then try again soon
    if (spinBusy || wheel?.spinning || wheel?._dragging) {
      autoSpinTimer = setTimeout(() => {
        autoSpinTimer = 0;
        void runAutoSpinTick();
      }, 1500);
      return;
    }
    // Clear open result so the next spin can start
    if (isResultOverlayOpen()) {
      try {
        hideResults();
      } catch {
        /* ignore */
      }
      // Give eliminate-after-win a moment to finish
      await sleepMs(200);
      if (spinBusy || wheel?.spinning) {
        autoSpinTimer = setTimeout(() => {
          autoSpinTimer = 0;
          void runAutoSpinTick();
        }, 1500);
        return;
      }
    }
    await doSpin();
  } catch (err) {
    console.warn("auto spin:", err);
  } finally {
    // Always re-arm for the next interval when still enabled
    scheduleAutoSpin();
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve per-section land action after a spin.
 * @returns {{
 *   type: 'show' | 'respin' | 'otherWheel',
 *   wheelId?: string,
 *   showMs?: number,
 *   section?: object,
 * }}
 */
function resolveLandAction(winSection) {
  const raw =
    state.sections.find((s) => s.id === winSection?.id) || winSection;
  if (!raw) return { type: "show" };

  const action = normalizeLandAction(raw.landAction);
  if (action === "none") return { type: "show" };

  if (landActionChainDepth >= MAX_LAND_ACTION_CHAIN) {
    console.warn(
      "Land action chain limit reached — showing result instead of chaining"
    );
    return { type: "show" };
  }

  const showMs = landShowResultMs(
    raw.landShowResultEvery,
    raw.landShowResultUnit
  );

  if (action === "respin") {
    return { type: "respin", showMs, section: raw };
  }

  if (action === "otherWheel") {
    const tid = raw.landTargetWheelId;
    if (
      tid &&
      tid !== library.activeId &&
      library.wheels.some((w) => w.id === tid)
    ) {
      return {
        type: "otherWheel",
        wheelId: tid,
        showMs,
        section: raw,
      };
    }
    // Missing / deleted target — treat as normal win
    return { type: "show" };
  }

  return { type: "show" };
}

/**
 * Show win UI for land-action chain, wait, then clear (no eliminate).
 * @param {{ id: string, label?: string }} win
 * @param {{ rigged?: boolean }} resultOpts
 * @param {number} showMs
 */
async function showLandActionResultThenWait(win, resultOpts, showMs) {
  if (!(showMs > 0)) {
    try {
      recordSpinHistory(win, resultOpts);
    } catch (err) {
      console.warn("history (land chain):", err);
    }
    // Still switch music even when skipping the win screen
    try {
      await applySectionWinBgm(win);
    } catch (err) {
      console.warn("win BGM (land chain):", err);
    }
    await sleepMs(450);
    return;
  }
  showResult(win, {
    ...resultOpts,
    forceShow: true,
    skipEliminate: true,
    skipAutoDismiss: true,
  });
  await sleepMs(showMs);
  // Dismiss without eliminate-after-win (already skipped when showing)
  pendingEliminateId = null;
  pendingEliminateMode = null;
  clearAutoDismissTimer();
  resultBanner?.classList?.add("hidden");
  resultCenter?.classList?.add("hidden");
  resultActionsBar?.classList?.add("hidden");
  clearResultCenterBg?.();
  resultShowsRigged = false;
  setResultRiggedVisible(isRigItActive() || isReverseRigActive());
  lastWinnerId = null;
}

/**
 * After a winner is known: either show result or chain respin / other wheel.
 * @param {{ id: string, label?: string }} win
 * @param {{ rigged?: boolean }} resultOpts
 * @param {{ fromLandAction?: boolean }} [spinOpts]
 */
async function handleSpinWinner(win, resultOpts = {}, spinOpts = {}) {
  if (!win) return;
  try {
    const next = resolveLandAction(win);
    if (next.type === "respin") {
      landActionChainDepth += 1;
      await showLandActionResultThenWait(win, resultOpts, next.showMs || 0);
      await doSpin({ fromLandAction: true });
      return;
    }
    if (next.type === "otherWheel" && next.wheelId) {
      landActionChainDepth += 1;
      await showLandActionResultThenWait(win, resultOpts, next.showMs || 0);
      await switchToWheelId(next.wheelId);
      await sleepMs(200);
      await doSpin({ fromLandAction: true });
      return;
    }
    // Normal result — reset chain so the next user spin starts fresh
    if (!spinOpts.fromLandAction) landActionChainDepth = 0;
    showResult(win, resultOpts);
  } catch (err) {
    console.error("handleSpinWinner:", err);
    try {
      showResult(win, resultOpts);
    } catch (err2) {
      console.error("showResult fallback:", err2);
    }
  }
}

async function beginSpinSession() {
  // Re-enable any sections whose return timer has elapsed
  try {
    const n = processSectionReturns({ refresh: false, persist: true });
    if (n > 0) await refreshWheel();
  } catch (err) {
    console.warn("section returns before spin:", err);
  }
  audio.ensure();
  const active = getActiveSections(state);
  if (!active.length) {
    alert("No active sections. Enable at least one section in an active group.");
    return false;
  }
  // Unstick a hung previous spin so rapid spins don't leave a blank canvas
  try {
    if (wheel?.spinning || wheel?._spinResolve) {
      wheel.cancelAnimatedSpin?.();
    }
  } catch {
    /* ignore */
  }
  spinBusy = true;
  hideResults();
  // Don't let confetti/win media stack across spins
  clearWinOverlays();
  startSpinLoopIfNeeded();
  // untilBgmEnds: play once from the start; otherwise normal looping BGM
  startBgmForSpin({
    untilBgmEnds: state.spin?.untilBgmEnds === true,
  });
  return true;
}

function endSpinSession() {
  stopSpinLoop();
  try {
    audio.stopDivert();
  } catch {
    /* ignore */
  }
  try {
    endRigDivertAudio();
  } catch {
    /* ignore */
  }
  try {
    stopBgmAfterSpin();
  } catch {
    /* ignore */
  }
  spinBusy = false;
  // If animation died mid-flight, force the wheel idle so the next spin works
  try {
    if (wheel?.spinning) {
      wheel.cancelAnimatedSpin?.();
    }
  } catch {
    /* ignore */
  }
  // Recover blank stage (0-size canvas / missed idle redraw after many spins)
  try {
    recoverWheelView();
  } catch (err) {
    console.warn("recoverWheelView:", err);
  }
}

/**
 * Redraw stage after hung spin / blank canvas. Safe to call often.
 */
function recoverWheelView() {
  try {
    spinBusy = false;
    if (wheel) {
      wheel._dragging = false;
      wheel._dragPointerId = null;
      if (wheel.spinning || wheel._spinResolve) {
        try {
          wheel.cancelAnimatedSpin?.();
        } catch {
          /* ignore */
        }
      }
      try {
        if (!wheel.wheelCanvas?.width || !wheel.wheelCanvas?.height) {
          wheel.resize?.();
        } else {
          wheel.draw?.({ spinFrame: false });
          wheel.layoutPointer?.();
        }
      } catch {
        try {
          wheel.resize?.();
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    console.warn("recoverWheelView failed:", err);
  }
}

/**
 * @param {{ fromLandAction?: boolean, spinDirection?: 1|-1 }} [opts]
 */
async function doSpin(opts = {}) {
  if (spinBusy || wheel.spinning || wheel._dragging) return;
  if (!opts.fromLandAction) landActionChainDepth = 0;
  // Resolve duration before session so BGM-until-end can load the track
  const untilBgm = state.spin?.untilBgmEnds === true;
  let durationSec = clampSpinDuration(state.spin?.duration ?? 9);
  if (untilBgm) {
    try {
      durationSec = await resolveSpinDurationSec();
    } catch {
      /* keep fallback */
    }
  }
  // Prefetch BGM before session so startBgmForSpin can play once for full length
  if (untilBgm) {
    try {
      await ensureBgmBuffer();
    } catch {
      /* ignore */
    }
  }
  if (!(await beginSpinSession())) return;
  /** @type {{ id: string, label?: string } | null} */
  let win = null;
  /** @type {{ rigged?: boolean }} */
  let resultOpts = {};
  try {
    const rig = getSpinRigOptions();
    // Fair drag: full timed spin, but match flick direction
    if (opts.spinDirection === 1 || opts.spinDirection === -1) {
      rig.spinDirection = opts.spinDirection;
    }
    win = await wheel.spin(durationSec, rig);
    // null = grab-interrupted mid-spin (user took over with drag)
    if (win) {
      resultOpts = {
        rigged:
          !!rig.forceSectionId ||
          !!(rig.avoidSectionIds && rig.avoidSectionIds.length) ||
          !!rig.avoidGroupId,
      };
    }
  } catch (err) {
    console.error("doSpin failed:", err);
    try {
      wheel.cancelAnimatedSpin?.();
    } catch {
      /* ignore */
    }
  } finally {
    endSpinSession();
  }
  if (win) {
    await handleSpinWinner(win, resultOpts, opts);
  }
}

/**
 * @param {number} velocityRadPerSec
 * @param {{ fromLandAction?: boolean }} [opts]
 */
async function doFling(velocityRadPerSec, opts = {}) {
  // Allow fling after grab-stop even if a previous session is cleaning up
  if (wheel.spinning || wheel._dragging) return;
  if (spinBusy) {
    // Previous spin was interrupted by grab; session already ending
    spinBusy = false;
  }
  if (!opts.fromLandAction) landActionChainDepth = 0;
  if (!(await beginSpinSession())) return;
  /** @type {{ id: string, label?: string } | null} */
  let win = null;
  try {
    const rig = getSpinRigOptions();
    win = await wheel.fling(velocityRadPerSec, rig);
  } catch (err) {
    console.error("doFling failed:", err);
    try {
      wheel.cancelAnimatedSpin?.();
    } catch {
      /* ignore */
    }
  } finally {
    endSpinSession();
  }
  // Fling is always "rigged" label; also when secret Rig it is on
  if (win) {
    await handleSpinWinner(win, { rigged: true }, opts);
  }
}

// Dismiss center overlay by clicking the dimmed backdrop (not buttons / text card)
resultCenter.addEventListener("click", (e) => {
  if (e.target === resultCenter) hideResults();
});

// --- Import / Export / Reset ---
$("#btn-export").addEventListener("click", () => {
  // Export active wheel project (same as before) — full library is Backup
  syncUiPrefsIntoState();
  persist();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spin-wheel-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/** Full library backup (every wheel + which is active). */
function backupLibrary() {
  syncUiPrefsIntoState();
  library = writeActiveState(library, state);
  const payload = {
    format: "sad-wheel-library-v1",
    exportedAt: new Date().toISOString(),
    library: {
      activeId: library.activeId,
      wheels: (library.wheels || []).map((w) => ({
        id: w.id,
        name: w.name,
        updatedAt: w.updatedAt,
        data: w.data,
      })),
    },
  };
  downloadJson(
    `sad-wheel-backup-${new Date().toISOString().slice(0, 10)}.json`,
    payload
  );
}

async function restoreLibraryFromFile(file) {
  const text = await file.text();
  const raw = JSON.parse(text);
  // Accept { format, library } or raw { activeId, wheels }
  const libRaw = raw?.library?.wheels ? raw.library : raw;
  if (!libRaw || !Array.isArray(libRaw.wheels) || !libRaw.wheels.length) {
    throw new Error("Not a valid library backup (missing wheels)");
  }
  if (
    !confirm(
      `Restore library backup with ${libRaw.wheels.length} wheel(s)?\n\nThis replaces ALL wheels currently saved on this device.`
    )
  ) {
    return;
  }
  // Normalize via save/load path
  const next = {
    activeId: libRaw.activeId,
    wheels: libRaw.wheels.map((w) => ({
      id: w.id,
      name: w.name,
      updatedAt: w.updatedAt || Date.now(),
      data: hydrateState(w.data || {}),
    })),
  };
  if (!next.wheels.some((w) => w.id === next.activeId)) {
    next.activeId = next.wheels[0].id;
  }
  if (!saveLibrary(next)) {
    throw new Error("Could not save restored library (storage may be full)");
  }
  library = next;
  const slot = getActiveSlot(library);
  state = hydrateState(
    JSON.parse(JSON.stringify(slot?.data || defaultState()))
  );
  undoStack.length = 0;
  lastWinnerId = null;
  hideResults();
  fillWheelSelect();
  bindAll();
  await preloadAudio();
  await refreshWheel();
  alert(`Restored ${library.wheels.length} wheel(s).`);
}

$("#btn-backup-library")?.addEventListener("click", () => {
  try {
    backupLibrary();
  } catch (err) {
    alert("Backup failed: " + (err.message || err));
  }
});
$("#btn-restore-library")?.addEventListener("click", () => {
  $("#restore-file")?.click();
});
$("#restore-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    await restoreLibraryFromFile(file);
  } catch (err) {
    console.error(err);
    alert("Restore failed: " + (err.message || err));
  }
});

$("#btn-import").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    let data = null;
    let source = "file";
    let importName = null;
    // Share link pasted into a .txt file, or raw #wheel= base64 / share JSON
    const trimmed = text.trim();
    if (
      trimmed.includes("#wheel=") ||
      trimmed.startsWith("wheel=") ||
      /^[A-Za-z0-9+/_=-]{80,}$/.test(trimmed.replace(/\s+/g, ""))
    ) {
      try {
        const payload = parseShareWheelPayload(trimmed);
        data = payload?.data || payload;
        importName = payload?.name || null;
        source = "share-link";
      } catch {
        /* fall through to normal parsers */
      }
    }
    if (!data) {
      // sad-wheel-v1 export JSON { format, name, data }
      try {
        const raw = JSON.parse(text);
        if (raw?.format === "sad-wheel-v1" && raw?.data) {
          data = raw.data;
          importName = raw.name || null;
          source = "share-json";
        }
      } catch {
        /* ignore */
      }
    }
    if (!data) {
      const parsed = parseImportFile(text, file.name);
      data = parsed.data;
      source = parsed.source;
    }
    if (!data?.sections || !data?.groups) throw new Error("Invalid project file");
    const asNew = confirm(
      "Import as a NEW wheel?\n\nOK = keep current wheel and import into a new one\nCancel = replace the current wheel"
    );
    if (asNew) {
      library = writeActiveState(library, state);
      const baseName =
        importName ||
        (file.name || "Imported").replace(
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
  const presetId = resolvePresetId(state);
  const preset = getWheelPreset(presetId) || getWheelPreset("default");
  const presetName = preset?.name || "Default";
  if (
    !confirm(
      `Reset this wheel to the ${presetName} preset?\n\nYour other saved wheels are not affected. You can Undo while the app stays open.`
    )
  )
    return;
  checkpoint();
  try {
    state = buildPresetState(presetId);
  } catch (err) {
    console.error("Reset preset build failed:", err);
    state = buildPresetState("default");
  }
  sectionSortDirty = false;
  sectionSortMode = "manual";
  try {
    localStorage.setItem(SECTION_SORT_KEY, "manual");
  } catch {
    /* ignore */
  }
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

bindWheelNewMenu();

$("#btn-wheel-dup")?.addEventListener("click", () => {
  duplicateCurrentWheel().catch((err) => alert(err.message || err));
});

$("#btn-wheel-rename")?.addEventListener("click", () => {
  renameCurrentWheel().catch((err) => safeAlert(err.message || err));
});

// Delete: click = current wheel; hold 5s = all saved wheels
{
  const delBtn = $("#btn-wheel-delete");
  const HOLD_ALL_MS = 5000;
  let holdTimer = null;
  let holdCompleted = false;
  let holdPointerId = null;

  function stopHoldVisual() {
    if (!delBtn) return;
    delBtn.classList.remove("is-holding");
    delBtn.removeAttribute("aria-busy");
  }

  function cancelHold() {
    if (holdTimer != null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdPointerId = null;
    stopHoldVisual();
  }

  delBtn?.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    if (delBtn.disabled) return;
    holdCompleted = false;
    cancelHold();
    holdPointerId = e.pointerId;
    try {
      delBtn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    delBtn.classList.add("is-holding");
    delBtn.setAttribute("aria-busy", "true");
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdCompleted = true;
      stopHoldVisual();
      try {
        if (holdPointerId != null) delBtn.releasePointerCapture(holdPointerId);
      } catch {
        /* ignore */
      }
      holdPointerId = null;
      deleteAllSavedWheels().catch((err) =>
        safeAlert(err.message || String(err))
      );
    }, HOLD_ALL_MS);
  });

  const endHold = (e) => {
    if (holdPointerId != null && e.pointerId !== holdPointerId) return;
    // Only cancel if hold has not already fired
    if (!holdCompleted) cancelHold();
    else stopHoldVisual();
  };
  delBtn?.addEventListener("pointerup", endHold);
  delBtn?.addEventListener("pointercancel", endHold);
  delBtn?.addEventListener("lostpointercapture", () => {
    if (!holdCompleted) cancelHold();
  });

  delBtn?.addEventListener("click", (e) => {
    if (holdCompleted) {
      e.preventDefault();
      e.stopImmediatePropagation();
      holdCompleted = false;
      return;
    }
    // Ignore click if this was a long partial hold (>400ms) — avoid surprise delete
    deleteCurrentWheel().catch((err) => alert(err.message || err));
  });
}

$("#btn-undo").addEventListener("click", () => {
  performUndo();
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  const editable =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (e.target && e.target.isContentEditable);

  // Esc — exit multi-spin first, then focus mode
  if (e.key === "Escape") {
    if (multiSpin?.isActive?.()) {
      e.preventDefault();
      multiSpin.exit();
      return;
    }
    if (document.body.classList.contains("focus-mode")) {
      e.preventDefault();
      setFocusMode(false);
      return;
    }
  }

  // Space / Enter — spin (Look option, default on)
  if (
    !editable &&
    state.look?.keyboardSpin !== false &&
    (e.key === " " || e.key === "Enter") &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    // Don't steal Space from focused buttons (except we want spin when nothing focused)
    const ae = document.activeElement;
    if (
      ae &&
      (ae.tagName === "BUTTON" ||
        ae.tagName === "A" ||
        ae.getAttribute?.("role") === "button")
    ) {
      // Allow Enter on buttons; Space on focused button activates it
      if (e.key === " " && ae.tagName === "BUTTON") return;
    }
    // Multi-spin mode: Space/Enter spins every selected wheel
    if (multiSpin?.isActive?.()) {
      e.preventDefault();
      if (!multiSpin.anySpinning()) void multiSpin.spinAll();
      return;
    }
    if (spinBusy || wheel.spinning || wheel._dragging) return;
    // If result overlay is open, Space dismisses then next press can spin
    const resultOpen =
      resultCenter && !resultCenter.classList.contains("hidden");
    const bannerOpen =
      resultBanner && !resultBanner.classList.contains("hidden");
    if (resultOpen || bannerOpen) {
      e.preventDefault();
      hideResults();
      return;
    }
    e.preventDefault();
    doSpin();
    return;
  }

  // Ctrl+Z / Cmd+Z — undo when not typing in a field
  const isMod = e.ctrlKey || e.metaKey;
  if (!isMod || e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey) return;
  if (editable) return;
  e.preventDefault();
  performUndo();
});

function bindAll() {
  bindLook();
  bindSound();
  bindSpinDuration();
  // Restore Your order vs temporary sort view (never clobber yourOrderIds here)
  try {
    ensureYourOrderIds();
    sectionSortDirty = false;
    if (sectionSortMode === "manual") {
      state.sections = orderSectionsByIds(state.yourOrderIds);
    } else {
      state.sections = sortSectionsList(state.sections, sectionSortMode);
    }
    updateSectionSortUI();
  } catch (err) {
    console.warn("section sort view:", err);
  }
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
  // Restore Hide panels from this wheel's saved preference
  applyHidePanelsFromState();
  updateShareButtonHint();
  updateStorageMeter();
  // History filter is wheel-aware
  if ($("#tab-history")?.classList.contains("active")) {
    renderHistory();
  }
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
    clearWinOverlays();
  } catch {
    /* ignore */
  }
  try {
    document.body.classList.remove("group-drag-cursor");
    document.querySelectorAll(".group-drag-ghost").forEach((g) => g.remove());
    groupsList?.classList?.remove("is-reordering");
    sectionsList?.classList?.remove("is-reordering");
    try {
      sectionDrag.pending = false;
      sectionDrag.active = false;
      sectionDrag.pointerId = null;
      sectionDrag.card = null;
      sectionDrag.ghost = null;
      sectionDrag.layout = [];
      sectionDrag.fromId = null;
      sectionDrag.fromIndex = -1;
      getSectionCards().forEach((c) => {
        c.style.transform = "";
        c.style.transition = "";
        c.classList.remove("is-drag-source");
      });
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  try {
    recoverWheelView();
  } catch {
    /* ignore */
  }
  try {
    if (wheel) {
      wheel._dragging = false;
      wheel._dragPointerId = null;
      if (wheel._dragEl) wheel._dragEl.style.cursor = "grab";
      // Unstick a hung spin without wiping rotation
      if (wheel.spinning || wheel._spinResolve) {
        wheel.cancelAnimatedSpin?.();
      }
      try {
        wheel.draw?.({ spinFrame: false });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  spinBusy = false;
}

/**
 * Make form categories collapsible (click heading to fold/expand).
 * Targets .form-block / profile / members blocks that start with h3 or h4.
 * Safe to call more than once.
 */
function initCollapsibleSections(root = document) {
  const blocks = root.querySelectorAll(
    ".form-block, .group-profile-block, .group-members-block"
  );
  for (const block of blocks) {
    if (block.dataset.collapseReady === "1") continue;
    const heading = block.querySelector(
      ":scope > h3, :scope > h4.group-profile-subhead, :scope > h4"
    );
    if (!heading) continue;

    block.dataset.collapseReady = "1";
    block.classList.add("collapsible-block");

    const body = document.createElement("div");
    body.className = "collapsible-body";
    while (heading.nextSibling) {
      body.appendChild(heading.nextSibling);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collapsible-toggle";
    btn.setAttribute("aria-expanded", "true");
    const title =
      heading.textContent?.trim() || heading.getAttribute("aria-label") || "Section";
    btn.setAttribute("aria-label", `Collapse or expand ${title}`);
    btn.appendChild(heading);
    const chevron = document.createElement("span");
    chevron.className = "collapsible-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";
    btn.appendChild(chevron);

    block.appendChild(btn);
    block.appendChild(body);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const collapsed = block.classList.toggle("is-collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }
}

/** Device-only: hide grey help / hint copy under settings (Misc → Hide help text). */
const HIDE_HINTS_KEY = "spin-wheel-hide-hints-v1";

function isHideHints() {
  try {
    return localStorage.getItem(HIDE_HINTS_KEY) === "1";
  } catch {
    return false;
  }
}

function applyHideHintsUi() {
  const on = isHideHints();
  document.body.classList.toggle("hide-hints", on);
  const chk = $("#chk-hide-hints");
  if (chk) chk.checked = on;
}

function setHideHints(on) {
  try {
    localStorage.setItem(HIDE_HINTS_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  applyHideHintsUi();
}

$("#chk-hide-hints")?.addEventListener("change", () => {
  setHideHints($("#chk-hide-hints")?.checked === true);
});

async function init() {
  const verEl = $("#app-version");
  if (verEl) {
    verEl.textContent = `#${APP_UPDATE}`;
    verEl.title = `Update #${APP_UPDATE}`;
  }
  try {
    applyHideHintsUi();
  } catch {
    /* ignore */
  }
  forceUiInteractive();
  try {
    multiSpin = createMultiSpinController({
      getLibrary: () => library,
      audio,
      getSound: () => state?.sound || {},
      clampSpinDuration,
      playGlobalLandSfx,
      getSpinTickPreset,
      onExit: () => {
        try {
          recoverWheelView();
        } catch {
          /* ignore */
        }
        void refreshWheel().catch(() => {});
      },
    });
    multiSpin.bindUi();
  } catch (err) {
    console.warn("multi-spin init:", err);
  }
  try {
    initCollapsibleSections();
  } catch (err) {
    console.warn("initCollapsibleSections:", err);
  }
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
    await tryImportShareHash();
  } catch (err) {
    console.warn("tryImportShareHash:", err);
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
  try {
    // Restore any sections whose return date already passed while the page was closed
    processSectionReturns({ refresh: true, persist: true });
  } catch (err) {
    console.warn("section returns on boot:", err);
  }
  try {
    scheduleAutoSpin();
  } catch (err) {
    console.warn("auto spin on boot:", err);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      try {
        processSectionReturns({ refresh: true });
      } catch (err) {
        console.warn("section returns on focus:", err);
      }
      try {
        scheduleAutoSpin();
      } catch (err) {
        console.warn("auto spin on focus:", err);
      }
    } else {
      clearAutoSpinTimer();
    }
  });
  forceUiInteractive();
  updateSectionsCount();
  fillWheelSelect();
  try {
    bindPointerDrag();
    wheel.layoutPointer?.();
  } catch (err) {
    console.warn("bindPointerDrag:", err);
  }
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
      if (state.look?.allowDoubleClickSpin === false) return;
      if (
        e.target.closest?.(
          "#pointer, #result-rigged, .result-actions-bar, .result-center-inner, .result-banner, .btn-toggle-sidebar, button, a, input, select, textarea"
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
          state.look?.allowWheelDrag !== false &&
          !wheel._dragging &&
          !pointerDrag.active &&
          getActiveSections(state).length > 0,
        getAllowWheelDrag: () => state.look?.allowWheelDrag !== false,
        getAllowGrabStopSpin: () => state.look?.allowGrabStopSpin !== false,
        getFairDragSpin: () => state.look?.fairDragSpin === true,
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
          // Fair mode: full-force timed spin, but same direction as the flick
          if (state.look?.fairDragSpin === true) {
            const dir = Number(vel) < 0 ? -1 : 1;
            void doSpin({ spinDirection: dir });
            return;
          }
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
