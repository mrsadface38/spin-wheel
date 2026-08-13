/**
 * Multi-spin mode: show several saved library wheels on one screen and spin them together.
 * Free-drag layout (optional lock), select a tile to edit that wheel in the sidebar.
 */

import { Wheel } from "./wheel.js";
import {
  hydrateState,
  getDisplaySections,
  getActiveSections,
  getEffectiveLandAction,
  landShowResultMs,
  normalizeLandAction,
} from "./state.js";

const SEL_KEY = "spin-wheel-multi-ids-v1";
const LAYOUT_KEY = "spin-wheel-multi-layout-v1";
const LOCK_KEY = "spin-wheel-multi-drag-lock-v1";
const PICKER_COLLAPSE_KEY = "spin-wheel-multi-picker-collapsed-v1";
/** When "1", free absolute placement; default is grid (no overlap). */
const FREE_LAYOUT_KEY = "spin-wheel-multi-free-layout-v1";
/** Shared custom size for grid mode (null = auto max fit). */
const GRID_SIZE_KEY = "spin-wheel-multi-grid-size-v1";
const SOFT_WARN_AT = 12;
const MAX_LAND_CHAIN = 20;
/** Min / max tile width (stage is square at this size). */
const TILE_MIN = 140;
const TILE_MAX = 960;
const TILE_GAP = 16;
/** Approx chrome under/above the square stage (head + result + queue). */
const TILE_CHROME_H = 92;

/**
 * @param {object} deps
 * @param {() => { activeId?: string, wheels: { id: string, name: string, data: object }[] }} deps.getLibrary
 * @param {{ ensure: Function, playTick: Function, playOneShot: Function, buffers: Map }} deps.audio
 * @param {() => object} deps.getSound
 * @param {(n: number) => number} deps.clampSpinDuration
 * @param {(vol: number) => void} [deps.playGlobalLandSfx]
 * @param {() => string} [deps.getSpinTickPreset]
 * @param {(slotId: string) => void|Promise<void>} [deps.onSelectWheel]
 * @param {(slotId: string) => void|Promise<void>} [deps.onEditWheel]
 * @param {(slotId: string) => void|Promise<string|null|void>} [deps.onDuplicateWheel]
 * @param {() => void} [deps.onEnter]
 * @param {() => void} [deps.onExit]
 */
export function createMultiSpinController(deps) {
  let active = false;
  /** @type {string[]} */
  let selectedIds = loadSelection();
  /** @type {Record<string, { x: number, y: number, size?: number, customSize?: boolean }>} */
  let layoutMap = loadLayout();
  let dragLocked = loadDragLock();
  let pickerCollapsed = loadPickerCollapsed();
  /** When false (default), tiles snap to a non-overlapping grid. */
  let freeLayout = loadFreeLayout();
  /** Shared size in grid mode; null = auto largest that fits. */
  let sharedGridSize = loadSharedGridSize();
  /** @type {string|null} */
  let focusedSlotId = null;
  /** @type {ResizeObserver | null} */
  let boardResizeObs = null;
  let boardResizeTimer = 0;
  /**
   * When false (Hide panels), no tile/picker shows as selected — flush look.
   * rememberedFocusId is restored when panels show again.
   */
  let selectionUiVisible = true;
  /** @type {string|null} */
  let rememberedFocusId = null;
  /** @type {Map<string, object>} */
  const tiles = new Map();
  let spinAllBusy = false;
  /** Bumped on each Spin all so in-flight chains from a prior run abort. */
  let spinGen = 0;
  let lastTickAudioAt = 0;

  /** @type {null | { tile: object, pointerId: number, grabX: number, grabY: number, startX: number, startY: number, moved: boolean }} */
  let drag = null;
  /** @type {null | { mode: "tile"|"grid", tile?: object, pointerId: number, grabX: number, grabY: number, startSize: number }} */
  let resize = null;

  const root = () => document.getElementById("multi-root");
  const grid = () => document.getElementById("multi-grid");
  const pickerList = () => document.getElementById("multi-picker-list");
  const summaryEl = () => document.getElementById("multi-summary");
  const warnEl = () => document.getElementById("multi-warn");
  const stageEl = () => document.getElementById("stage");
  const btnToggle = () => document.getElementById("btn-multi-spin");
  const lockChk = () => document.getElementById("chk-multi-drag-lock");
  const freeLayoutChk = () => document.getElementById("chk-multi-free-layout");

  function loadSelection() {
    try {
      const raw = localStorage.getItem(SEL_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveSelection() {
    try {
      localStorage.setItem(SEL_KEY, JSON.stringify(selectedIds));
    } catch {
      /* ignore */
    }
  }

  function clampSize(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return TILE_MIN;
    return Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(n)));
  }

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return {};
      /** @type {Record<string, { x: number, y: number, size?: number, customSize?: boolean }>} */
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const x = Number(v?.x);
        const y = Number(v?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          /** @type {{ x: number, y: number, size?: number, customSize?: boolean }} */
          const entry = { x: Math.max(0, x), y: Math.max(0, y) };
          const size = Number(v?.size);
          if (Number.isFinite(size) && size > 0) {
            entry.size = clampSize(size);
            entry.customSize = v?.customSize === true || true;
          }
          out[k] = entry;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  function saveLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutMap));
    } catch {
      /* ignore */
    }
  }

  function loadDragLock() {
    try {
      return localStorage.getItem(LOCK_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveDragLock() {
    try {
      localStorage.setItem(LOCK_KEY, dragLocked ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function loadPickerCollapsed() {
    try {
      return localStorage.getItem(PICKER_COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function loadFreeLayout() {
    try {
      return localStorage.getItem(FREE_LAYOUT_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveFreeLayout() {
    try {
      localStorage.setItem(FREE_LAYOUT_KEY, freeLayout ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function loadSharedGridSize() {
    try {
      const n = Number(localStorage.getItem(GRID_SIZE_KEY));
      if (!Number.isFinite(n) || n < TILE_MIN) return null;
      return clampSize(n);
    } catch {
      return null;
    }
  }

  function saveSharedGridSize() {
    try {
      if (sharedGridSize == null) localStorage.removeItem(GRID_SIZE_KEY);
      else localStorage.setItem(GRID_SIZE_KEY, String(sharedGridSize));
    } catch {
      /* ignore */
    }
  }

  function savePickerCollapsed() {
    try {
      localStorage.setItem(PICKER_COLLAPSE_KEY, pickerCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function applyPickerCollapsedUi() {
    const body = document.getElementById("multi-body");
    const expandBtn = document.getElementById("btn-multi-picker-expand");
    const collapseBtn = document.getElementById("btn-multi-picker-collapse");
    body?.classList.toggle("picker-collapsed", pickerCollapsed);
    if (expandBtn) {
      expandBtn.hidden = !pickerCollapsed;
      expandBtn.setAttribute("aria-expanded", pickerCollapsed ? "false" : "true");
    }
    if (collapseBtn) {
      collapseBtn.setAttribute(
        "aria-expanded",
        pickerCollapsed ? "false" : "true"
      );
      collapseBtn.title = pickerCollapsed
        ? "Show wheel list"
        : "Collapse wheel list to the left";
    }
  }

  function setPickerCollapsed(on) {
    pickerCollapsed = !!on;
    savePickerCollapsed();
    applyPickerCollapsedUi();
    // Board width changed — remeasure tile canvases after layout
    requestAnimationFrame(() => {
      for (const t of tiles.values()) {
        try {
          t.wheel?.resize?.();
          t.wheel?.draw?.();
        } catch {
          /* ignore */
        }
      }
      updateBoardSize();
    });
  }

  function isActive() {
    return active;
  }

  function anySpinning() {
    if (spinAllBusy) return true;
    for (const t of tiles.values()) {
      if (t.spinning || t.wheel?.spinning) return true;
    }
    return false;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function librarySlots() {
    const lib = deps.getLibrary?.() || { wheels: [] };
    return Array.isArray(lib.wheels) ? lib.wheels : [];
  }

  function activeLibraryId() {
    return deps.getLibrary?.()?.activeId || null;
  }

  function onMultiTick(speed) {
    const sound = deps.getSound?.() || {};
    if (sound.enabled === false) return;
    const mode = sound.spinMode;
    if (mode === "off" || mode === "loop") return;
    const now = performance.now();
    if (now - lastTickAudioAt < 45) return;
    lastTickAudioAt = now;
    const vol = (sound.spinVolume ?? 0.5) * (0.35 + 0.5 * speed);
    const pitch = 0.85 + speed * 0.35;
    const preset = deps.getSpinTickPreset?.() || "synth";
    const audio = deps.audio;
    if (!audio) return;
    if (preset === "synth") {
      audio.playTick?.(vol, pitch);
      return;
    }
    if (audio.buffers?.has("spin")) {
      audio.playOneShot?.("spin", vol, "tick");
    } else {
      audio.playTick?.(vol, pitch);
    }
  }

  function playLandOnce() {
    const sound = deps.getSound?.() || {};
    if (sound.enabled === false) return;
    const vol = sound.landVolume ?? 0.4;
    if (typeof deps.playGlobalLandSfx === "function") {
      deps.playGlobalLandSfx(vol);
    } else {
      deps.audio?.playTick?.(vol, 1);
    }
  }

  function setWarn() {
    const el = warnEl();
    if (!el) return;
    const n = selectedIds.length;
    if (n >= SOFT_WARN_AT) {
      el.hidden = false;
      el.classList.remove("hidden");
      el.textContent = `${n} wheels on screen — this may slow weaker devices.`;
    } else {
      el.hidden = true;
      el.classList.add("hidden");
      el.textContent = "";
    }
  }

  function setSummary(text) {
    const el = summaryEl();
    if (el) el.textContent = text || "";
  }

  function boardViewport() {
    const g = grid();
    // Prefer the multi-body content area so a huge minWidth on the board
    // cannot make "available" space look bigger than the real panel.
    const body = document.getElementById("multi-body");
    const picker = document.getElementById("multi-picker");
    let w = 0;
    let h = 0;
    if (body) {
      const pickerW =
        picker &&
        !body.classList.contains("picker-collapsed") &&
        picker.offsetParent !== null
          ? picker.getBoundingClientRect().width
          : 0;
      w = Math.max(0, body.clientWidth - pickerW - 12);
      h = Math.max(0, body.clientHeight - 8);
    }
    if (g) {
      // Visible scrollport (not scrollWidth of oversized content)
      w = Math.max(w, g.clientWidth || 0);
      h = Math.max(h, g.clientHeight || 0);
    }
    if (w < 160) w = 600;
    if (h < 160) h = 400;
    return { w: Math.max(160, w - 8), h: Math.max(160, h - 8) };
  }

  /**
   * Largest square stage size so `n` tiles pack into the board viewport.
   * Tries every column count; prefers one-screen fit (w+h), allows vertical
   * scroll only when necessary.
   */
  function maxTileSizeForCount(n) {
    const count = Math.max(1, Number(n) || 1);
    const { w, h } = boardViewport();
    let bestFit = TILE_MIN; // fits both width and height
    let bestWidth = TILE_MIN; // fits width only (scroll vertically)
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const cellW = (w - (cols - 1) * TILE_GAP) / cols;
      const cellH = (h - (rows - 1) * TILE_GAP) / rows;
      const sW = Math.floor(cellW);
      const sBoth = Math.floor(Math.min(cellW, cellH - TILE_CHROME_H));
      if (sBoth > bestFit) bestFit = sBoth;
      if (sW > bestWidth) bestWidth = sW;
    }
    // Prefer full on-screen pack; if nothing fits height, pack by width + scroll
    const pick = bestFit >= TILE_MIN + 20 ? bestFit : bestWidth;
    return clampSize(Math.min(pick, w - 4));
  }

  function effectiveGridSize() {
    const n = Math.max(1, selectedIds.length);
    const auto = maxTileSizeForCount(n);
    if (sharedGridSize != null) {
      // Custom size, but never wider than the board so a tile stays reachable
      const maxW = Math.max(TILE_MIN, boardViewport().w - 4);
      return clampSize(Math.min(sharedGridSize, maxW));
    }
    return auto;
  }

  /** Size used for a tile (grid = shared; free = per-tile custom or auto). */
  function tileSize(slotId) {
    if (!freeLayout) return effectiveGridSize();
    const L = layoutMap[slotId];
    if (L?.customSize && Number.isFinite(L.size) && L.size > 0) {
      return clampSize(L.size);
    }
    // After Fit largest, size is stored without customSize — honor it
    if (Number.isFinite(L?.size) && L.size > 0) {
      return clampSize(L.size);
    }
    return maxTileSizeForCount(Math.max(1, selectedIds.length));
  }

  function gridMetrics(size) {
    const s = size || effectiveGridSize();
    const { w } = boardViewport();
    const cols = Math.max(1, Math.floor((w + TILE_GAP) / (s + TILE_GAP)));
    const cellW = s + TILE_GAP;
    const cellH = s + TILE_CHROME_H + TILE_GAP;
    return { size: s, cols, cellW, cellH };
  }

  function defaultPosForIndex(i, size) {
    const { size: s, cols, cellW, cellH } = gridMetrics(size);
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: col * cellW,
      y: row * cellH,
      size: s,
      customSize: false,
    };
  }

  /**
   * Non-overlapping grid: positions follow selectedIds order + current size.
   * Always keeps tiles within a scrollable pack that reflows on resize.
   */
  function applyGridLayout({ redraw = true } = {}) {
    const n = selectedIds.length;
    if (!n) {
      updateBoardSize();
      return;
    }
    let size = effectiveGridSize();
    // If a custom shared size no longer fits the window width, shrink it
    const { w } = boardViewport();
    const maxOneCol = clampSize(w - 4);
    if (size > maxOneCol) {
      size = maxOneCol;
      if (sharedGridSize != null) {
        sharedGridSize = size;
        saveSharedGridSize();
      }
    }
    const { cols, cellW, cellH } = gridMetrics(size);
    selectedIds.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const prev = layoutMap[id] || {};
      layoutMap[id] = {
        x: col * cellW,
        y: row * cellH,
        size,
        customSize: sharedGridSize != null,
        // preserve free-mode extras if any
        freeX: prev.freeX,
        freeY: prev.freeY,
      };
    });
    for (const t of tiles.values()) {
      if (!t.rootEl) continue;
      const pos = layoutMap[t.slotId];
      if (!pos) continue;
      t.rootEl.style.left = `${pos.x}px`;
      t.rootEl.style.top = `${pos.y}px`;
      t.rootEl.style.width = `${size}px`;
      t.rootEl.style.minWidth = `${size}px`;
      const sizeLabel = t.rootEl.querySelector(".multi-tile-size-label");
      if (sizeLabel) sizeLabel.textContent = `${size}px`;
      if (redraw) {
        try {
          t.wheel?.resize?.();
          t.wheel?.draw?.();
        } catch {
          /* ignore */
        }
      }
    }
    updateBoardSize();
    positionGridResizeHandle();
  }

  function ensureLayoutFor(slotId, indexHint = 0) {
    if (!freeLayout) {
      // Grid positions are always derived from order
      return defaultPosForIndex(
        Math.max(0, selectedIds.indexOf(slotId) >= 0 ? selectedIds.indexOf(slotId) : indexHint)
      );
    }
    if (layoutMap[slotId] && Number.isFinite(layoutMap[slotId].x)) {
      const L = layoutMap[slotId];
      if (!L.customSize) {
        L.size = maxTileSizeForCount(Math.max(1, selectedIds.length));
      }
      return L;
    }
    const pos = defaultPosForIndex(indexHint);
    layoutMap[slotId] = pos;
    return pos;
  }

  function applyTilePosition(tile) {
    if (!tile?.rootEl) return;
    if (!freeLayout) {
      applyGridLayout({ redraw: false });
      return;
    }
    const idx = selectedIds.indexOf(tile.slotId);
    const pos = ensureLayoutFor(tile.slotId, Math.max(0, idx));
    const size = tileSize(tile.slotId);
    pos.size = size;
    tile.rootEl.style.left = `${pos.x}px`;
    tile.rootEl.style.top = `${pos.y}px`;
    tile.rootEl.style.width = `${size}px`;
    tile.rootEl.style.minWidth = `${size}px`;
    const sizeLabel = tile.rootEl.querySelector(".multi-tile-size-label");
    if (sizeLabel) sizeLabel.textContent = `${size}px`;
  }

  function relayoutWheelsAfterSize(tile) {
    if (!freeLayout) {
      // In grid mode, resizing one tile sets the shared size for all
      const s = tileSize(tile.slotId);
      sharedGridSize = s;
      saveSharedGridSize();
      applyGridLayout({ redraw: true });
      return;
    }
    applyTilePosition(tile);
    updateBoardSize();
    requestAnimationFrame(() => {
      try {
        tile.wheel?.resize?.();
        tile.wheel?.draw?.();
      } catch {
        /* ignore */
      }
    });
  }

  function updateBoardSize() {
    const g = grid();
    if (!g) return;
    const vp = boardViewport();
    if (!freeLayout) {
      // Grid: board is full width of the viewport; height grows with rows (scroll if needed)
      g.style.minWidth = "";
      g.style.width = "100%";
      const n = Math.max(1, selectedIds.length);
      const size = effectiveGridSize();
      const { cols, cellH } = gridMetrics(size);
      const rows = Math.ceil(n / cols);
      const contentH = rows * cellH + 8;
      g.style.minHeight = `${Math.max(contentH, vp.h)}px`;
      return;
    }
    let maxR = 200;
    let maxB = 200;
    for (const id of selectedIds) {
      const pos = layoutMap[id] || { x: 0, y: 0 };
      const size = tileSize(id);
      maxR = Math.max(maxR, pos.x + size + 24);
      maxB = Math.max(maxB, pos.y + size + TILE_CHROME_H + 24);
    }
    g.style.width = "";
    g.style.minHeight = `${Math.max(maxB, vp.h)}px`;
    g.style.minWidth = `${Math.max(maxR, vp.w)}px`;
  }

  /**
   * Which grid slot is under the pointer — nearest tile center (not floor toward top-left).
   */
  function gridIndexFromPoint(clientX, clientY) {
    const g = grid();
    if (!g || !selectedIds.length) return 0;
    const rect = g.getBoundingClientRect();
    const style = getComputedStyle(g);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const x = clientX - rect.left + g.scrollLeft - padL;
    const y = clientY - rect.top + g.scrollTop - padT;
    const size = effectiveGridSize();
    const n = selectedIds.length;

    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const id = selectedIds[i];
      const pos = layoutMap[id] || defaultPosForIndex(i, size);
      const s = Number(pos.size) || size;
      // Center of the full tile (stage + chrome)
      const cx = (pos.x || 0) + s / 2;
      const cy = (pos.y || 0) + (s + TILE_CHROME_H) / 2;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  /** Swap two grid slots so a wheel can land on any other wheel's cell. */
  function swapSelectedIds(slotId, toIndex) {
    const from = selectedIds.indexOf(slotId);
    if (from < 0) return;
    const ti = Math.max(0, Math.min(selectedIds.length - 1, toIndex));
    if (from === ti) return;
    const next = selectedIds.slice();
    const tmp = next[ti];
    next[ti] = next[from];
    next[from] = tmp;
    selectedIds = next;
    saveSelection();
  }

  function clearGridDropHighlight() {
    for (const t of tiles.values()) {
      t.rootEl?.classList.remove("is-drop-target");
    }
  }

  function setGridDropHighlight(slotId) {
    for (const t of tiles.values()) {
      t.rootEl?.classList.toggle("is-drop-target", t.slotId === slotId);
    }
  }

  /**
   * Hard reset: clear custom sizes, scroll to origin, remeasure board, pack
   * every wheel into a non-overlapping grid at the largest size that fits.
   * Works even when tiles were oversized / off-screen.
   */
  function fitAllLargest() {
    if (!selectedIds.length) {
      setSummary("Select wheels first, then Fit largest");
      return;
    }

    // Drop shared + per-tile custom sizes
    sharedGridSize = null;
    saveSharedGridSize();
    for (const id of Object.keys(layoutMap)) {
      const L = layoutMap[id];
      if (!L) continue;
      L.customSize = false;
      delete L.size;
    }

    const g = grid();
    if (g) {
      // Clear oversized board constraints so viewport measure is real
      g.style.minWidth = "0";
      g.style.width = "100%";
      g.style.minHeight = "0";
      try {
        g.scrollLeft = 0;
        g.scrollTop = 0;
      } catch {
        /* ignore */
      }
    }

    const packNow = () => {
      const n = Math.max(1, selectedIds.length);
      // Fresh measure after style clear
      const size = maxTileSizeForCount(n);
      const { cols, cellW, cellH } = gridMetrics(size);

      selectedIds.forEach((id, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        layoutMap[id] = {
          x: col * cellW,
          y: row * cellH,
          size,
          customSize: false,
        };
      });
      saveLayout();

      // Apply pixel geometry directly (don't re-derive a different size)
      for (const t of tiles.values()) {
        if (!t.rootEl) continue;
        const pos = layoutMap[t.slotId];
        if (!pos) continue;
        t.rootEl.style.left = `${pos.x}px`;
        t.rootEl.style.top = `${pos.y}px`;
        t.rootEl.style.width = `${size}px`;
        t.rootEl.style.minWidth = `${size}px`;
        const sizeLabel = t.rootEl.querySelector(".multi-tile-size-label");
        if (sizeLabel) sizeLabel.textContent = `${size}px`;
        try {
          t.wheel?.resize?.();
          t.wheel?.draw?.();
        } catch {
          /* ignore */
        }
      }

      // Board scroll size from packed grid
      if (g) {
        const rows = Math.ceil(n / cols);
        const contentH = rows * cellH + 8;
        const contentW = Math.min(cols, n) * cellW + 8;
        g.style.minHeight = `${contentH}px`;
        if (freeLayout) {
          g.style.minWidth = `${contentW}px`;
          g.style.width = "";
        } else {
          g.style.minWidth = "";
          g.style.width = "100%";
        }
        try {
          g.scrollLeft = 0;
          g.scrollTop = 0;
        } catch {
          /* ignore */
        }
      }

      setSummary(
        `Reset layout: ${n} wheel${n === 1 ? "" : "s"} at ${size}px` +
          (freeLayout ? " (packed)" : " (grid)")
      );
      positionGridResizeHandle();
    };

    // Two frames so clientWidth/Height update after clearing huge minWidth
    requestAnimationFrame(() => {
      requestAnimationFrame(packNow);
    });
  }

  function applyLayoutModeUi() {
    const g = grid();
    g?.classList.toggle("is-free-layout", freeLayout);
    g?.classList.toggle("is-grid-layout", !freeLayout);
    root()?.classList.toggle("is-free-layout", freeLayout);
    root()?.classList.toggle("is-grid-layout", !freeLayout);
    const chk = freeLayoutChk();
    if (chk) chk.checked = freeLayout;
    // Per-tile handles only in free mode; grid uses the board corner handle
    for (const t of tiles.values()) {
      const rh = t.rootEl?.querySelector(".multi-tile-resize");
      if (rh) rh.hidden = !freeLayout;
      const sl = t.rootEl?.querySelector(".multi-tile-size-label");
      if (sl) sl.hidden = !freeLayout;
    }
    positionGridResizeHandle();
  }

  /**
   * Grid size control lives in the Wheels on screen panel (not on the board).
   */
  function syncPickerGridSizeUi() {
    const wrap = document.getElementById("multi-picker-grid-size");
    const slider = document.getElementById("multi-grid-size-slider");
    const valueEl = document.getElementById("multi-grid-size-value");
    if (wrap) {
      // Only relevant in grid mode with wheels on the board
      wrap.hidden = freeLayout || !selectedIds.length || dragLocked;
      wrap.classList.toggle("is-disabled", freeLayout || dragLocked);
    }
    const size = effectiveGridSize();
    if (slider) {
      // Max = largest that still fits the board width
      const maxW = Math.max(TILE_MIN, boardViewport().w - 4);
      slider.min = String(TILE_MIN);
      slider.max = String(Math.min(TILE_MAX, maxW));
      slider.value = String(clampSize(Math.min(size, maxW)));
      slider.disabled = freeLayout || dragLocked || !selectedIds.length;
    }
    if (valueEl) valueEl.textContent = `${size}px`;
  }

  /** @deprecated name kept — updates picker slider, not a board handle */
  function positionGridResizeHandle() {
    // Remove any leftover board-corner grip from older builds
    document.getElementById("multi-grid-resize")?.remove();
    syncPickerGridSizeUi();
  }

  function applyGridSizeFromSlider(raw) {
    if (freeLayout || dragLocked) return;
    const maxW = Math.max(TILE_MIN, boardViewport().w - 4);
    const next = clampSize(Math.min(Number(raw) || TILE_MIN, maxW));
    sharedGridSize = next;
    saveSharedGridSize();
    applyGridLayout({ redraw: true });
    syncPickerGridSizeUi();
  }

  function setFreeLayout(on) {
    freeLayout = !!on;
    saveFreeLayout();
    applyLayoutModeUi();
    if (!freeLayout) {
      // Snap everything into a clean non-overlapping grid
      applyGridLayout({ redraw: true });
      setSummary("Grid layout — drag to reorder; tiles won’t overlap");
    } else {
      // Seed free positions from current grid cells
      for (const id of selectedIds) {
        const L = layoutMap[id];
        if (L) {
          L.customSize = Number.isFinite(L.size);
        }
      }
      saveLayout();
      for (const t of tiles.values()) applyTilePosition(t);
      updateBoardSize();
      setSummary("Free placement — drag anywhere (can overlap)");
    }
  }

  function scheduleBoardReflow() {
    if (boardResizeTimer) clearTimeout(boardResizeTimer);
    boardResizeTimer = setTimeout(() => {
      boardResizeTimer = 0;
      if (!active) return;
      if (!freeLayout) applyGridLayout({ redraw: true });
      else {
        // Free mode: keep positions but ensure board scroll size is ok
        updateBoardSize();
      }
    }, 80);
  }

  function ensureBoardResizeObserver() {
    if (boardResizeObs || typeof ResizeObserver === "undefined") return;
    const g = grid();
    if (!g) return;
    boardResizeObs = new ResizeObserver(() => scheduleBoardReflow());
    boardResizeObs.observe(g);
  }

  function applyDragLockUi() {
    const g = grid();
    g?.classList.toggle("is-drag-locked", dragLocked);
    root()?.classList.toggle("is-drag-locked", dragLocked);
    const chk = lockChk();
    if (chk) chk.checked = dragLocked;
    for (const t of tiles.values()) {
      t.rootEl?.classList.toggle("drag-locked", dragLocked);
      const handle = t.rootEl?.querySelector(".multi-tile-drag");
      if (handle) {
        handle.title = dragLocked
          ? "Positions locked — unlock in the toolbar to drag"
          : freeLayout
            ? "Drag to move this wheel"
            : "Drag to reorder on the grid";
      }
      const rh = t.rootEl?.querySelector(".multi-tile-resize");
      if (rh) {
        rh.hidden = !freeLayout;
        rh.title = dragLocked
          ? "Positions locked — unlock to resize"
          : "Drag to resize this wheel";
        rh.style.pointerEvents = dragLocked ? "none" : "";
      }
    }
    positionGridResizeHandle();
  }

  function updateFocusUi() {
    // Flush look while editor panels are hidden — no selection chrome
    if (!selectionUiVisible) {
      for (const t of tiles.values()) {
        t.rootEl?.classList.remove("is-selected");
        t.rootEl?.setAttribute("aria-selected", "false");
      }
      const list = pickerList();
      if (list) {
        list.querySelectorAll(".multi-picker-row.is-focused").forEach((row) => {
          row.classList.remove("is-focused");
        });
      }
      return;
    }
    const focus =
      focusedSlotId || activeLibraryId() || selectedIds[0] || null;
    for (const t of tiles.values()) {
      const on = t.slotId === focus;
      t.rootEl?.classList.toggle("is-selected", on);
      t.rootEl?.setAttribute("aria-selected", on ? "true" : "false");
    }
    const list = pickerList();
    if (list) {
      list.querySelectorAll(".multi-picker-row").forEach((row) => {
        row.classList.toggle(
          "is-focused",
          !!focus && row.dataset.slotId === focus
        );
      });
    }
  }

  /**
   * Hide or restore multi-spin selection highlight with the editor panels.
   * @param {boolean} visible
   */
  function setSelectionUiVisible(visible) {
    if (visible) {
      selectionUiVisible = true;
      if (rememberedFocusId) {
        focusedSlotId = rememberedFocusId;
        rememberedFocusId = null;
      } else if (!focusedSlotId) {
        focusedSlotId = activeLibraryId() || selectedIds[0] || null;
      }
    } else {
      if (selectionUiVisible) {
        rememberedFocusId =
          focusedSlotId || activeLibraryId() || selectedIds[0] || null;
      }
      selectionUiVisible = false;
    }
    updateFocusUi();
  }

  async function selectTile(slotId, { edit = false } = {}) {
    if (!slotId) return;
    focusedSlotId = slotId;
    // Selecting for edit should bring selection chrome back with the panels
    if (edit) selectionUiVisible = true;
    updateFocusUi();
    try {
      if (edit && typeof deps.onEditWheel === "function") {
        await deps.onEditWheel(slotId);
      } else if (typeof deps.onSelectWheel === "function") {
        await deps.onSelectWheel(slotId);
      }
    } catch (err) {
      console.warn("multi-spin select wheel:", err);
    }
    updateFocusUi();
  }

  /**
   * Duplicate a library wheel; optional multi-board add for the new copy.
   * @param {string} [slotId]
   */
  async function duplicateSlot(slotId) {
    const id =
      slotId ||
      focusedSlotId ||
      activeLibraryId() ||
      selectedIds[0] ||
      null;
    if (!id || typeof deps.onDuplicateWheel !== "function") return;
    try {
      const newId = await deps.onDuplicateWheel(id);
      if (newId && typeof newId === "string") {
        if (!selectedIds.includes(newId)) {
          selectedIds.push(newId);
          saveSelection();
        }
        focusedSlotId = newId;
        await syncTilesWithLibrary();
        updateFocusUi();
        setSummary(`Duplicated → selected the new wheel`);
      } else {
        // Library changed even if no id returned
        await syncTilesWithLibrary();
      }
    } catch (err) {
      console.warn("multi-spin duplicate:", err);
    }
  }

  function renderPicker() {
    const list = pickerList();
    if (!list) return;
    const slots = librarySlots();
    const idSet = new Set(selectedIds);
    selectedIds = selectedIds.filter((id) => slots.some((w) => w.id === id));
    const focus =
      selectionUiVisible
        ? focusedSlotId || activeLibraryId()
        : null;
    list.innerHTML = "";
    if (!slots.length) {
      list.innerHTML = `<p class="multi-picker-empty">No saved wheels.</p>`;
      return;
    }
    for (const w of slots) {
      // <label> so clicking the name toggles the checkbox (not only the tiny box)
      const row = document.createElement("label");
      row.className =
        "multi-picker-row" + (focus && w.id === focus ? " is-focused" : "");
      row.dataset.slotId = w.id;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = idSet.has(w.id);
      cb.title = "Show on multi-spin board";
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!selectedIds.includes(w.id)) selectedIds.push(w.id);
        } else {
          selectedIds = selectedIds.filter((id) => id !== w.id);
          if (focusedSlotId === w.id) focusedSlotId = null;
        }
        saveSelection();
        setWarn();
        void syncTilesWithLibrary();
      });

      const span = document.createElement("span");
      span.className = "multi-picker-name";
      span.textContent = w.name || "Untitled";
      span.title = "Click to show or hide on the multi-spin board (double-click to edit)";

      row.appendChild(cb);
      row.appendChild(span);
      // Double-click opens edit (two label clicks often cancel; resync checkbox)
      row.addEventListener("dblclick", (e) => {
        e.preventDefault();
        cb.checked = selectedIds.includes(w.id);
        void selectTile(w.id, { edit: true });
      });
      list.appendChild(row);
    }
    setWarn();
  }

  function createTileDom(slot) {
    const el = document.createElement("article");
    el.className = "multi-tile";
    el.dataset.slotId = slot.id;
    el.setAttribute("role", "listitem");
    el.setAttribute("aria-selected", "false");
    el.innerHTML = `
      <div class="multi-tile-head">
        <button type="button" class="multi-tile-drag" title="Drag to move this wheel" aria-label="Drag to move">
          <span class="drag-grip" aria-hidden="true"></span>
        </button>
        <span class="multi-tile-name"></span>
        <button type="button" class="btn small ghost multi-tile-edit" title="Edit this wheel in the sidebar">Edit</button>
        <button type="button" class="btn small multi-tile-spin" title="Spin this wheel">Spin</button>
      </div>
      <div class="stage stage--mini multi-tile-stage">
        <div class="bg-media" aria-hidden="true"></div>
        <canvas class="bg-canvas"></canvas>
        <canvas class="wheel-canvas"></canvas>
        <div class="slice-media-layer" aria-hidden="true">
          <div class="slice-media-rotator"></div>
        </div>
        <canvas class="wheel-overlay"></canvas>
        <div class="center-media" aria-hidden="true"></div>
        <div class="pointer" aria-hidden="true"></div>
      </div>
      <div class="multi-tile-result" aria-live="polite"></div>
      <div class="multi-tile-queue" hidden title="Spins waiting to run after this wheel finishes"></div>
      <div class="multi-tile-resize" title="Drag to resize this wheel" aria-label="Resize wheel" hidden></div>
      <span class="multi-tile-size-label" aria-hidden="true" hidden></span>
    `;
    el.querySelector(".multi-tile-name").textContent = slot.name || "Untitled";
    return el;
  }

  function bindTileChrome(tile) {
    const rootEl = tile.rootEl;
    const stage = rootEl.querySelector(".multi-tile-stage");

    rootEl.querySelector(".multi-tile-spin")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // If busy, queue another spin (count shown on tile)
      void requestSpin(tile, { silentLand: false, chainDepth: 0 });
    });

    rootEl.querySelector(".multi-tile-edit")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void selectTile(tile.slotId, { edit: true });
    });

    // Click tile (not drag handle) to select for editing
    rootEl.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      void selectTile(tile.slotId, { edit: false });
    });

    stage?.addEventListener("dblclick", (e) => {
      e.preventDefault();
      void requestSpin(tile, { silentLand: false, chainDepth: 0 });
    });

    const handle = rootEl.querySelector(".multi-tile-drag");
    handle?.addEventListener("pointerdown", (e) => {
      if (dragLocked) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = layoutMap[tile.slotId] || { x: 0, y: 0 };
      // Prefer live left/top if already laid out
      const left = parseFloat(rootEl.style.left) || pos.x || 0;
      const top = parseFloat(rootEl.style.top) || pos.y || 0;
      drag = {
        tile,
        pointerId: e.pointerId,
        grabX: e.clientX,
        grabY: e.clientY,
        startX: left,
        startY: top,
        moved: false,
        mode: freeLayout ? "free" : "grid",
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      rootEl.classList.add("is-dragging");
      rootEl.style.zIndex = "20";
    });

    // Per-tile resize only in free placement mode
    const resizeHandle = rootEl.querySelector(".multi-tile-resize");
    if (resizeHandle) {
      resizeHandle.hidden = !freeLayout;
      resizeHandle.addEventListener("pointerdown", (e) => {
        if (!freeLayout || dragLocked) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        resize = {
          mode: "tile",
          tile,
          pointerId: e.pointerId,
          grabX: e.clientX,
          grabY: e.clientY,
          startSize: tileSize(tile.slotId),
        };
        try {
          resizeHandle.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        rootEl.classList.add("is-resizing");
        rootEl.style.zIndex = "25";
      });
    }
    const sizeLabel = rootEl.querySelector(".multi-tile-size-label");
    if (sizeLabel) sizeLabel.hidden = !freeLayout;
  }

  function onDragPointerMove(e) {
    if (resize && e.pointerId === resize.pointerId) {
      // Tile resize only (free placement) — grid size uses the picker slider
      if (resize.mode !== "tile" || !resize.tile) return;
      const dx = e.clientX - resize.grabX;
      const dy = e.clientY - resize.grabY;
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      const next = clampSize(resize.startSize + delta);
      const prev = layoutMap[resize.tile.slotId] || { x: 0, y: 0 };
      layoutMap[resize.tile.slotId] = {
        x: prev.x || 0,
        y: prev.y || 0,
        size: next,
        customSize: true,
      };
      relayoutWheelsAfterSize(resize.tile);
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.grabX;
    const dy = e.clientY - drag.grabY;
    if (!drag.moved && dx * dx + dy * dy < 9) return;
    drag.moved = true;
    const x = Math.max(0, drag.startX + dx);
    const y = Math.max(0, drag.startY + dy);
    // Visual follow under the pointer (both modes)
    drag.tile.rootEl.style.left = `${x}px`;
    drag.tile.rootEl.style.top = `${y}px`;
    if (drag.mode === "free") {
      const prev = layoutMap[drag.tile.slotId] || {};
      layoutMap[drag.tile.slotId] = {
        x,
        y,
        size: prev.size,
        customSize: prev.customSize === true,
      };
      updateBoardSize();
    } else {
      // Highlight the slot under the cursor (swap target)
      const toIndex = gridIndexFromPoint(e.clientX, e.clientY);
      const targetId = selectedIds[toIndex];
      if (targetId && targetId !== drag.tile.slotId) {
        setGridDropHighlight(targetId);
      } else {
        clearGridDropHighlight();
      }
    }
  }

  function onDragPointerUp(e) {
    if (resize && e.pointerId === resize.pointerId) {
      const t = resize.tile;
      resize = null;
      if (t?.rootEl) {
        t.rootEl.classList.remove("is-resizing");
        t.rootEl.style.zIndex = "";
      }
      saveLayout();
      updateBoardSize();
      try {
        t?.wheel?.resize?.();
        t?.wheel?.draw?.();
      } catch {
        /* ignore */
      }
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const t = drag.tile;
    const didMove = drag.moved;
    const mode = drag.mode;
    const clientX = e.clientX;
    const clientY = e.clientY;
    drag = null;
    t.rootEl?.classList.remove("is-dragging");
    t.rootEl.style.zIndex = "";
    clearGridDropHighlight();
    if (!didMove) {
      void selectTile(t.slotId, { edit: false });
      return;
    }
    if (mode === "grid" || !freeLayout) {
      // Swap with the wheel under the pointer (any slot, not insert toward top-left)
      const toIndex = gridIndexFromPoint(clientX, clientY);
      swapSelectedIds(t.slotId, toIndex);
      applyGridLayout({ redraw: true });
      setSummary("Swapped grid slots");
    } else {
      saveLayout();
      updateBoardSize();
    }
  }

  async function buildTile(slot) {
    const g = grid();
    if (!g) return null;
    const rootEl = createTileDom(slot);
    g.appendChild(rootEl);

    const wheelCanvas = rootEl.querySelector("canvas.wheel-canvas");
    const bgCanvas = rootEl.querySelector("canvas.bg-canvas");
    const overlayCanvas = rootEl.querySelector("canvas.wheel-overlay");

    const wheel = new Wheel(wheelCanvas, bgCanvas, {
      overlayCanvas,
      bgMediaEl: rootEl.querySelector(".bg-media"),
      sliceRotatorEl: rootEl.querySelector(".slice-media-rotator"),
      centerMediaEl: rootEl.querySelector(".center-media"),
      pointerEl: rootEl.querySelector(".pointer"),
      onTick: onMultiTick,
      onLand: () => {},
    });

    let state;
    try {
      state = hydrateState(deepClone(slot.data || {}));
    } catch {
      state = hydrateState({});
    }

    try {
      await wheel.setLook(state.look || {});
      await wheel.setSections(getDisplaySections(state));
      wheel.resize?.();
      wheel.draw();
    } catch (err) {
      console.warn("multi-spin tile load:", slot.name, err);
    }

    const tile = {
      slotId: slot.id,
      name: slot.name || "Untitled",
      state,
      rootEl,
      wheel,
      spinning: false,
      lastWin: null,
      /** @type {object[]} pending spins after current finishes */
      queue: [],
    };

    bindTileChrome(tile);
    tiles.set(slot.id, tile);
    applyTilePosition(tile);
    applyDragLockUi();
    updateFocusUi();

    requestAnimationFrame(() => {
      try {
        wheel.resize?.();
        wheel.draw();
      } catch {
        /* ignore */
      }
    });

    return tile;
  }

  function destroyOneTile(tile) {
    if (!tile) return;
    try {
      tile.wheel?.cancelAnimatedSpin?.();
    } catch {
      /* ignore */
    }
    try {
      tile.wheel?.destroy?.();
    } catch {
      /* ignore */
    }
    tile.rootEl?.remove();
    tiles.delete(tile.slotId);
  }

  function destroyTiles() {
    for (const t of [...tiles.values()]) destroyOneTile(t);
    tiles.clear();
    const g = grid();
    if (g) {
      // Keep #multi-grid-resize; only remove tiles / empty state
      g.querySelectorAll(".multi-tile, .multi-grid-empty").forEach((el) => {
        el.remove();
      });
    }
  }

  async function refreshTileFromSlot(tile, slot) {
    if (!tile || !slot || tile.spinning || tile.wheel?.spinning) return;
    tile.name = slot.name || "Untitled";
    const nameEl = tile.rootEl?.querySelector(".multi-tile-name");
    if (nameEl) nameEl.textContent = tile.name;
    try {
      tile.state = hydrateState(deepClone(slot.data || {}));
      await tile.wheel.setLook(tile.state.look || {});
      await tile.wheel.setSections(getDisplaySections(tile.state));
      tile.wheel.resize?.();
      tile.wheel.draw();
    } catch (err) {
      console.warn("multi-spin tile refresh:", tile.name, err);
    }
  }

  /**
   * Add/remove/refresh tiles without wiping free-drag positions.
   */
  async function syncTilesWithLibrary() {
    const g = grid();
    if (!g) return;
    const slots = librarySlots();
    selectedIds = selectedIds.filter((id) => slots.some((w) => w.id === id));
    saveSelection();

    for (const [id, tile] of [...tiles.entries()]) {
      if (!selectedIds.includes(id)) destroyOneTile(tile);
    }

    if (!selectedIds.length) {
      destroyTiles();
      g.innerHTML = `<p class="multi-grid-empty">Select wheels on the left to show them here. Grid mode packs them without overlap; enable Free placement to drag anywhere.</p>`;
      setSummary("");
      updateFocusUi();
      return;
    }

    g.querySelector(".multi-grid-empty")?.remove();

    let i = 0;
    for (const id of selectedIds) {
      const slot = slots.find((w) => w.id === id);
      if (!slot) continue;
      ensureLayoutFor(id, i);
      if (tiles.has(id)) {
        await refreshTileFromSlot(tiles.get(id), slot);
      } else {
        await buildTile(slot);
      }
      i += 1;
    }

    if (!freeLayout) {
      applyGridLayout({ redraw: true });
    } else {
      for (const t of tiles.values()) applyTilePosition(t);
      updateBoardSize();
    }
    applyDragLockUi();
    applyLayoutModeUi();
    updateFocusUi();
    setSummary(
      `${selectedIds.length} wheel${selectedIds.length === 1 ? "" : "s"} ready` +
        (freeLayout ? " · free placement" : " · grid")
    );
    renderPicker();
  }

  async function rebuildTiles() {
    destroyTiles();
    await syncTilesWithLibrary();
  }

  function setTileResult(tile, win, note = "") {
    const el = tile.rootEl?.querySelector(".multi-tile-result");
    if (!el) return;
    if (!win) {
      el.textContent = note || "";
      el.classList.remove("has-win");
      return;
    }
    const label = win.label || win.name || "—";
    el.textContent = note ? `Winner: ${label} ${note}` : `Winner: ${label}`;
    el.classList.add("has-win");
    tile.lastWin = win;
  }

  function durationFor(tile) {
    const d = tile.state?.spin?.duration ?? 9;
    return deps.clampSpinDuration
      ? deps.clampSpinDuration(d)
      : Math.max(1, Number(d) || 9);
  }

  function sleepMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, n));
  }

  async function waitUntilIdle(tile, timeoutMs = 120000) {
    if (!tile) return;
    const start = Date.now();
    while (tile.spinning || tile.wheel?.spinning) {
      if (Date.now() - start > timeoutMs) break;
      await sleepMs(40);
    }
  }

  async function ensureTileForSlot(slotId) {
    if (!slotId) return null;
    if (tiles.has(slotId)) return tiles.get(slotId);
    const slot = librarySlots().find((w) => w.id === slotId);
    if (!slot) return null;
    if (!selectedIds.includes(slotId)) {
      selectedIds.push(slotId);
      saveSelection();
    }
    const g = grid();
    g?.querySelector(".multi-grid-empty")?.remove();
    ensureLayoutFor(slotId, selectedIds.length - 1);
    await buildTile(slot);
    updateBoardSize();
    setWarn();
    renderPicker();
    const tile = tiles.get(slotId) || null;
    try {
      tile?.rootEl?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    } catch {
      /* ignore */
    }
    return tile;
  }

  function isTileBusy(tile) {
    return !!(tile && (tile.spinning || tile.wheel?.spinning));
  }

  /** Busy or still has spins waiting. */
  function isTileFullyIdle(tile) {
    if (!tile) return true;
    if (isTileBusy(tile)) return false;
    if (Array.isArray(tile.queue) && tile.queue.length > 0) return false;
    return true;
  }

  async function waitUntilTileFullyIdle(tile, timeoutMs = 600000) {
    if (!tile) return;
    const start = Date.now();
    while (!isTileFullyIdle(tile)) {
      if (Date.now() - start > timeoutMs) break;
      await sleepMs(40);
    }
  }

  function updateQueueUi(tile) {
    if (!tile?.rootEl) return;
    const n = Array.isArray(tile.queue) ? tile.queue.length : 0;
    const el = tile.rootEl.querySelector(".multi-tile-queue");
    if (el) {
      if (n > 0) {
        el.hidden = false;
        el.textContent = n === 1 ? "1 queued" : `${n} queued`;
        el.title = `${n} spin${n === 1 ? "" : "s"} waiting until this wheel finishes`;
      } else {
        el.hidden = true;
        el.textContent = "";
        el.removeAttribute("title");
      }
    }
    tile.rootEl.classList.toggle("has-queue", n > 0);
  }

  /**
   * Queue a spin if the tile is busy; otherwise start immediately.
   * Used by respin / spin-other-wheel and manual Spin.
   */
  function enqueueSpin(tile, opts = {}) {
    if (!tile) return;
    if (!Array.isArray(tile.queue)) tile.queue = [];
    tile.queue.push({
      silentLand: opts.silentLand === true,
      chainDepth: Number(opts.chainDepth) || 0,
    });
    updateQueueUi(tile);
  }

  /** Drop every waiting spin on every on-board wheel (does not stop current spins). */
  function clearAllQueues() {
    let cleared = 0;
    for (const t of tiles.values()) {
      const n = Array.isArray(t.queue) ? t.queue.length : 0;
      if (n > 0) {
        cleared += n;
        t.queue = [];
        updateQueueUi(t);
      }
    }
    if (cleared > 0) {
      setSummary(
        cleared === 1
          ? "Cleared 1 queued spin"
          : `Cleared ${cleared} queued spins`
      );
    } else {
      setSummary("No queued spins to clear");
    }
  }

  /**
   * Request a spin: run now if idle, else add to this wheel's queue.
   * When awaitRun is false (default for portals), start without awaiting so
   * the source wheel can continue / wait separately.
   * @returns {Promise<object|null>|"queued"|"started"}
   */
  async function requestSpin(tile, opts = {}) {
    if (!tile) return null;
    const awaitRun = opts.awaitRun === true;
    if (isTileBusy(tile)) {
      enqueueSpin(tile, opts);
      return "queued";
    }
    if (awaitRun) {
      return spinTile(tile, opts);
    }
    void spinTile(tile, opts);
    return "started";
  }

  /** After a spin ends, run the next queued spin (if any). */
  async function drainQueue(tile) {
    if (!tile || isTileBusy(tile)) return;
    if (!Array.isArray(tile.queue) || !tile.queue.length) {
      updateQueueUi(tile);
      return;
    }
    const next = tile.queue.shift();
    updateQueueUi(tile);
    await spinTile(tile, {
      silentLand: next?.silentLand === true,
      chainDepth: Number(next?.chainDepth) || 0,
    });
  }

  /**
   * Live Misc → waitForTargetWheel for this board tile (library first).
   * Default on when unset.
   */
  function tileWaitsForOtherWheel(tile) {
    if (!tile) return true;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      const look = slot?.data?.look ?? tile.state?.look;
      if (look && Object.prototype.hasOwnProperty.call(look, "waitForTargetWheel")) {
        return look.waitForTargetWheel !== false;
      }
    } catch {
      /* ignore */
    }
    // Tile clone / hydrate default
    return tile.state?.look?.waitForTargetWheel !== false;
  }

  async function handleMultiLandAction(tile, win, chainDepth) {
    if (!tile || !win || chainDepth >= MAX_LAND_CHAIN) return false;

    // Prefer live library data for land-action fields + look
    let stateForLand = tile.state;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      if (slot?.data) {
        stateForLand = hydrateState(deepClone(slot.data));
        // Keep sections list ids in sync for resolve; don't replace mid-spin geometry
        if (tile.state?.sections) {
          // only pull look + group land overrides freshness via hydrate on slot
        }
        // Merge look from live save so Misc toggles apply immediately
        if (tile.state) {
          tile.state.look = {
            ...(tile.state.look || {}),
            ...(stateForLand.look || {}),
          };
        }
      }
    } catch {
      stateForLand = tile.state;
    }

    const raw =
      (stateForLand?.sections || tile.state?.sections || []).find(
        (s) => s.id === win.id
      ) || win;
    const eff = getEffectiveLandAction(stateForLand || tile.state, raw);
    const action = normalizeLandAction(eff.landAction);
    if (action === "none") return false;

    const showMs = landShowResultMs(
      eff.landShowResultEvery,
      eff.landShowResultUnit
    );
    const waitMs = showMs > 0 ? showMs : 400;
    const times = Math.min(
      99,
      Math.max(1, Number(eff.landActionTimes) || 1)
    );
    const nextOpts = {
      silentLand: true,
      chainDepth: chainDepth + 1,
      awaitRun: false,
    };

    /**
     * Start/queue spins without awaiting (so Wait off can continue).
     * First spin starts if idle; the rest always enqueue (avoids racing busy).
     * @returns {{ queued: number, started: number }}
     */
    function fireTimes(targetTile) {
      let queued = 0;
      let started = 0;
      for (let i = 0; i < times; i++) {
        if (i === 0 && !isTileBusy(targetTile)) {
          void spinTile(targetTile, nextOpts);
          started = 1;
        } else {
          enqueueSpin(targetTile, nextOpts);
          queued += 1;
        }
      }
      return { queued, started };
    }

    if (action === "respin") {
      setTileResult(tile, win, times > 1 ? `→ respin ×${times}…` : "→ respin…");
      await sleepMs(waitMs);
      // Queue on self — runs after this spin's finally/drainQueue
      const { queued } = fireTimes(tile);
      if (queued > 0) {
        setTileResult(
          tile,
          win,
          times > 1
            ? `→ respin ×${times} (queued · ${tile.queue.length})`
            : `→ respin (queued · ${tile.queue.length})`
        );
      }
      return true;
    }

    if (action === "otherWheel") {
      const tid = eff.landTargetWheelId;
      if (!tid) {
        setTileResult(tile, win, "→ (no target wheel)");
        return false;
      }
      if (tid === tile.slotId) {
        setTileResult(
          tile,
          win,
          times > 1 ? `→ respin ×${times}…` : "→ respin…"
        );
        await sleepMs(waitMs);
        fireTimes(tile);
        return true;
      }
      const target = await ensureTileForSlot(tid);
      if (!target) {
        setTileResult(tile, win, "→ (wheel not found)");
        return false;
      }
      setTileResult(
        tile,
        win,
        times > 1 ? `→ ${target.name} ×${times}` : `→ ${target.name}`
      );
      await sleepMs(waitMs);
      const { queued, started } = fireTimes(target);
      const waitOther = tileWaitsForOtherWheel(tile);
      if (waitOther) {
        // Misc on: hold this wheel's queue until the other finishes completely
        setTileResult(
          tile,
          win,
          `→ ${target.name}${times > 1 ? ` ×${times}` : ""} (waiting…)`
        );
        // Yield so target can mark spinning=true
        await sleepMs(0);
        await waitUntilTileFullyIdle(target);
        setTileResult(
          tile,
          win,
          `→ ${target.name}${times > 1 ? ` ×${times}` : ""} (done)`
        );
      } else {
        // Misc off: do not wait — our finally will drain our own queue now
        const n = target.queue?.length || 0;
        if (queued > 0 || started > 0) {
          setTileResult(
            tile,
            win,
            n > 0
              ? `→ ${target.name}${times > 1 ? ` ×${times}` : ""} (queued · ${n})`
              : `→ ${target.name}${times > 1 ? ` ×${times}` : ""}`
          );
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Run one spin now. Does not wait for busy wheels — use requestSpin to queue.
   * @param {object} tile
   * @param {{ silentLand?: boolean, chainDepth?: number }} [opts]
   */
  async function spinTile(tile, opts = {}) {
    const silentLand = opts.silentLand === true;
    const chainDepth = Number(opts.chainDepth) || 0;
    if (!tile) return null;

    // Never block on another spin here — busy → caller should queue
    if (isTileBusy(tile)) return null;

    const activeSecs = getActiveSections(tile.state);
    if (!activeSecs.length) {
      const el = tile.rootEl?.querySelector(".multi-tile-result");
      if (el) {
        el.textContent = "No active sections";
        el.classList.remove("has-win");
      }
      // Drop a useless queue entry path: clear empty-section queue items later
      return null;
    }

    tile.spinning = true;
    tile.rootEl?.classList.add("is-spinning");
    if (chainDepth === 0) setTileResult(tile, null);
    let win = null;
    try {
      deps.audio?.ensure?.();
      const dur = durationFor(tile);
      win = await tile.wheel.spin(dur, {});
      if (win) {
        setTileResult(tile, win);
        // Land actions enqueue respin/other — do not nest force-restarts
        await handleMultiLandAction(tile, win, chainDepth);
      }
    } catch (err) {
      console.error("multi-spin tile failed:", tile.name, err);
      try {
        tile.wheel?.cancelAnimatedSpin?.();
      } catch {
        /* ignore */
      }
    } finally {
      tile.spinning = false;
      tile.rootEl?.classList.remove("is-spinning");
      // Start next queued spin (if any)
      void drainQueue(tile);
    }
    if (win && !silentLand && chainDepth === 0) {
      playLandOnce();
    }
    return win;
  }

  function buildSummaryLines() {
    const lines = [];
    for (const t of tiles.values()) {
      if (t.lastWin) {
        const q = t.queue?.length || 0;
        lines.push(
          q > 0
            ? `${t.name}: ${t.lastWin.label || "—"} (+${q} queued)`
            : `${t.name}: ${t.lastWin.label || "—"}`
        );
      } else if (!getActiveSections(t.state).length) {
        lines.push(`${t.name}: (no sections)`);
      } else if (t.queue?.length) {
        lines.push(`${t.name}: ${t.queue.length} queued`);
      }
    }
    return lines;
  }

  /**
   * Spin only wheels that are idle right now.
   * Does not cancel running spins and does not add to queues.
   */
  async function spinAll() {
    if (!active) return;
    const list = [...tiles.values()];
    if (!list.length) {
      setSummary("Select at least one wheel first.");
      return;
    }

    const idle = list.filter((t) => !isTileBusy(t));
    const busy = list.length - idle.length;
    if (!idle.length) {
      setSummary(
        busy === 1
          ? "That wheel is still spinning — Spin all only starts idle wheels."
          : `All ${busy} wheels are still spinning — Spin all only starts idle wheels.`
      );
      return;
    }

    spinAllBusy = true;
    setSummary(
      busy > 0
        ? `Spinning ${idle.length} idle wheel${idle.length === 1 ? "" : "s"} (${busy} already spinning, left alone)…`
        : "Spinning…"
    );
    try {
      deps.audio?.ensure?.();
      for (const t of idle) setTileResult(t, null);

      const results = await Promise.all(
        idle.map((t) =>
          spinTile(t, {
            silentLand: true,
            chainDepth: 0,
          })
        )
      );

      const lines = buildSummaryLines();
      setSummary(lines.length ? lines.join(" · ") : "Done");
      if (results.some(Boolean) || lines.length) playLandOnce();
    } finally {
      spinAllBusy = false;
    }
  }

  /**
   * Interval ms from a wheel look (0 = auto-spin off).
   * @param {object|null|undefined} look
   */
  function intervalMsFromLook(look) {
    if (look?.autoSpin !== true) return 0;
    let n = Number(look.autoSpinEvery);
    if (!Number.isFinite(n) || n < 1) n = 1;
    n = Math.min(9999, Math.round(n));
    const unit = look.autoSpinUnit;
    let ms = n * 60_000;
    if (unit === "seconds") ms = n * 1_000;
    else if (unit === "hours") ms = n * 3_600_000;
    else if (unit === "days") ms = n * 86_400_000;
    return Math.min(2_147_000_000, Math.max(1_000, ms));
  }

  /**
   * Shortest auto-spin interval among on-board wheels that have auto spin on.
   * @returns {number} 0 if none
   */
  function getAutoSpinIntervalMs() {
    if (!active) return 0;
    let best = 0;
    for (const t of tiles.values()) {
      const ms = intervalMsFromLook(t.state?.look);
      if (ms > 0 && (best === 0 || ms < best)) best = ms;
    }
    return best;
  }

  /**
   * Auto-spin tick for multi view: spin every idle on-board wheel that has
   * Misc → Auto spin enabled on that wheel.
   */
  async function autoSpinTick() {
    if (!active) return;
    const targets = [...tiles.values()].filter(
      (t) => t.state?.look?.autoSpin === true && !isTileBusy(t)
    );
    if (!targets.length) {
      // All auto-spin wheels busy, or none have auto spin — no-op
      return;
    }
    spinAllBusy = true;
    try {
      deps.audio?.ensure?.();
      for (const t of targets) setTileResult(t, null);
      const results = await Promise.all(
        targets.map((t) =>
          spinTile(t, { silentLand: true, chainDepth: 0 })
        )
      );
      const lines = buildSummaryLines();
      if (lines.length) setSummary(`Auto: ${lines.join(" · ")}`);
      if (results.some(Boolean)) playLandOnce();
    } finally {
      spinAllBusy = false;
    }
  }

  function enter() {
    if (active) return;
    active = true;
    document.body.classList.add("multi-spin-mode");
    const st = stageEl();
    if (st) {
      st.hidden = true;
      st.setAttribute("aria-hidden", "true");
    }
    const r = root();
    if (r) {
      r.hidden = false;
      r.classList.remove("hidden");
    }
    const btn = btnToggle();
    if (btn) {
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
    }
    // Keep editor available — do not force-collapse panels
    focusedSlotId = activeLibraryId();
    applyDragLockUi();
    applyPickerCollapsedUi();
    applyLayoutModeUi();
    ensureBoardResizeObserver();
    renderPicker();
    void syncTilesWithLibrary().then(() => {
      // First paint often has 0 board size — re-fit once layout is real
      requestAnimationFrame(() => {
        if (!freeLayout) applyGridLayout({ redraw: true });
        else {
          for (const t of tiles.values()) {
            applyTilePosition(t);
            try {
              t.wheel?.resize?.();
              t.wheel?.draw?.();
            } catch {
              /* ignore */
            }
          }
          updateBoardSize();
        }
      });
      // Select active library wheel if on board
      const aid = activeLibraryId();
      if (aid && tiles.has(aid)) {
        focusedSlotId = aid;
        updateFocusUi();
      }
    });
    deps.onEnter?.();
  }

  function exit() {
    if (!active) return;
    for (const t of tiles.values()) {
      try {
        t.wheel?.cancelAnimatedSpin?.();
      } catch {
        /* ignore */
      }
    }
    destroyTiles();
    active = false;
    spinAllBusy = false;
    focusedSlotId = null;
    drag = null;
    resize = null;
    if (boardResizeTimer) {
      clearTimeout(boardResizeTimer);
      boardResizeTimer = 0;
    }
    if (boardResizeObs) {
      try {
        boardResizeObs.disconnect();
      } catch {
        /* ignore */
      }
      boardResizeObs = null;
    }
    document.body.classList.remove("multi-spin-mode");
    const st = stageEl();
    if (st) {
      st.hidden = false;
      st.removeAttribute("aria-hidden");
    }
    const r = root();
    if (r) {
      r.hidden = true;
      r.classList.add("hidden");
    }
    const btn = btnToggle();
    if (btn) {
      btn.classList.remove("is-active");
      btn.setAttribute("aria-pressed", "false");
    }
    setSummary("");
    deps.onExit?.();
  }

  function toggle() {
    if (active) exit();
    else enter();
  }

  function selectAll() {
    selectedIds = librarySlots().map((w) => w.id);
    saveSelection();
    void syncTilesWithLibrary();
  }

  function clearSelection() {
    selectedIds = [];
    focusedSlotId = null;
    saveSelection();
    void syncTilesWithLibrary();
  }

  function bindUi() {
    document.getElementById("btn-multi-spin")?.addEventListener("click", () => {
      toggle();
    });
    document.getElementById("btn-multi-exit")?.addEventListener("click", () => {
      exit();
    });
    document
      .getElementById("btn-multi-spin-all")
      ?.addEventListener("click", () => {
        void spinAll();
      });
    document
      .getElementById("btn-multi-select-all")
      ?.addEventListener("click", () => selectAll());
    document
      .getElementById("btn-multi-clear")
      ?.addEventListener("click", () => clearSelection());
    document
      .getElementById("btn-multi-fit-size")
      ?.addEventListener("click", () => fitAllLargest());
    document
      .getElementById("btn-multi-clear-queues")
      ?.addEventListener("click", () => clearAllQueues());

    lockChk()?.addEventListener("change", () => {
      dragLocked = lockChk().checked === true;
      saveDragLock();
      applyDragLockUi();
    });
    if (lockChk()) lockChk().checked = dragLocked;

    freeLayoutChk()?.addEventListener("change", () => {
      setFreeLayout(freeLayoutChk().checked === true);
    });
    if (freeLayoutChk()) freeLayoutChk().checked = freeLayout;
    applyLayoutModeUi();

    const gridSlider = document.getElementById("multi-grid-size-slider");
    gridSlider?.addEventListener("input", () => {
      applyGridSizeFromSlider(gridSlider.value);
    });
    gridSlider?.addEventListener("change", () => {
      applyGridSizeFromSlider(gridSlider.value);
      saveSharedGridSize();
    });
    syncPickerGridSizeUi();

    document
      .getElementById("btn-multi-picker-collapse")
      ?.addEventListener("click", () => setPickerCollapsed(true));
    document
      .getElementById("btn-multi-picker-expand")
      ?.addEventListener("click", () => setPickerCollapsed(false));
    applyPickerCollapsedUi();

    window.addEventListener("pointermove", onDragPointerMove);
    window.addEventListener("pointerup", onDragPointerUp);
    window.addEventListener("pointercancel", onDragPointerUp);
  }

  function onLibraryChanged() {
    if (!active) return;
    // Keep selection highlight in sync with the wheel the sidebar is editing
    const aid = activeLibraryId();
    if (aid) focusedSlotId = aid;
    // Soft sync — keep free-drag positions; refresh wheel data for editing
    void syncTilesWithLibrary();
  }

  return {
    isActive,
    anySpinning,
    enter,
    exit,
    toggle,
    spinAll,
    autoSpinTick,
    getAutoSpinIntervalMs,
    clearAllQueues,
    bindUi,
    onLibraryChanged,
    rebuildTiles,
    getFocusedSlotId: () => focusedSlotId,
    selectTile,
    setSelectionUiVisible,
  };
}
