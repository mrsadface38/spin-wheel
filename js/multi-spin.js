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
  resolveSectionForDisplay,
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
/** Min / max tile width (stage is square at this size). */
const TILE_MIN = 140;
const TILE_MAX = 960;
/** Gap between tiles in grid mode (tighter — no head/result bars on tiles). */
const TILE_GAP = 8;
/**
 * Extra height beyond the square stage. Top bar + bottom result were removed
 * (queue is an overlay). Keep a few px for border/shadow only.
 */
const TILE_CHROME_H = 4;

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
 * @param {(section: object, opts?: object) => void} [deps.onSpinHistory] record History tab entry for a multi-tile land
 * @param {(section: object, opts?: { container?: HTMLElement, state?: object }) => void} [deps.playWinEffect] after-win confetti/custom in tile stage
 * @param {(slotId: string) => void} [deps.onBeforeTileSpin] flush sidebar edits (section order) before a multi tile spins
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

  /** @type {null | { tile: object, pointerId: number, grabX: number, grabY: number, startX: number, startY: number, moved: boolean, mode?: string }} */
  let drag = null;
  /** @type {null | { mode: "tile"|"grid", tile?: object, pointerId: number, grabX: number, grabY: number, startSize: number }} */
  let resize = null;
  /**
   * Reorder "Wheels on screen" list (selectedIds order = free-placement stack).
   * Top of list = highest z (on top); bottom = lowest z (behind).
   */
  /** @type {null | {
   *   pointerId: number,
   *   slotId: string,
   *   fromIndex: number,
   *   insertIndex: number,
   *   startY: number,
   *   offsetY: number,
   *   stride: number,
   *   row: HTMLElement,
   *   ghost: HTMLElement | null,
   *   layout: { el: HTMLElement, id: string, mid: number }[],
   *   active: boolean,
   *   moved: boolean,
   * }} */
  let pickerDrag = null;

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
      /** @type {Record<string, object>} */
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const x = Number(v?.x);
        const y = Number(v?.y);
        const col = Number(v?.col);
        const row = Number(v?.row);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          /** @type {Record<string, unknown>} */
          const entry = { x: Math.max(0, x), y: Math.max(0, y) };
          if (Number.isFinite(col) && col >= 0) entry.col = Math.round(col);
          if (Number.isFinite(row) && row >= 0) entry.row = Math.round(row);
          const size = Number(v?.size);
          if (Number.isFinite(size) && size > 0) {
            entry.size = clampSize(size);
            entry.customSize = v?.customSize === true || true;
          }
          out[k] = entry;
        } else if (Number.isFinite(col) && Number.isFinite(row)) {
          out[k] = {
            col: Math.round(col),
            row: Math.round(row),
            x: 0,
            y: 0,
          };
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
      collapseBtn.hidden = !!pickerCollapsed;
      collapseBtn.setAttribute(
        "aria-expanded",
        pickerCollapsed ? "false" : "true"
      );
      collapseBtn.title = "Collapse wheel list";
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
    // Measure the visible board area only (not oversized scroll content).
    const body = document.getElementById("multi-body");
    const picker = document.getElementById("multi-picker");
    let w = 0;
    let h = 0;
    // Prefer the grid's client box — that's the actual on-screen scrollport
    if (g && g.clientWidth >= 80 && g.clientHeight >= 80) {
      w = g.clientWidth;
      h = g.clientHeight;
    } else if (body) {
      const pickerW =
        picker &&
        !body.classList.contains("picker-collapsed") &&
        picker.offsetParent !== null
          ? picker.getBoundingClientRect().width
          : 0;
      w = Math.max(0, body.clientWidth - pickerW - 12);
      h = Math.max(0, body.clientHeight - 8);
    }
    // Padding inside the board (~0.5rem each side)
    w = Math.max(0, w - 16);
    h = Math.max(0, h - 16);
    // Modest fallback if layout hasn't settled (avoid huge phantom viewports)
    if (w < 120) w = 480;
    if (h < 120) h = 360;
    return { w: Math.max(120, w), h: Math.max(120, h) };
  }

  /**
   * Largest tile size + column count so all `n` wheels fit on screen
   * (width AND height — no “make them huge and scroll” fallback).
   * @returns {{ size: number, cols: number, rows: number }}
   */
  function bestFitPack(n) {
    const count = Math.max(1, Number(n) || 1);
    const { w, h } = boardViewport();
    let best = { size: 0, cols: 1, rows: count };

    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      // Width budget per column
      const maxByW = Math.floor((w - (cols - 1) * TILE_GAP) / cols);
      // Height budget per row (stage + chrome under/above the square)
      const maxByH = Math.floor(
        (h - (rows - 1) * TILE_GAP) / rows - TILE_CHROME_H
      );
      const s = Math.floor(Math.min(maxByW, maxByH));
      if (s > best.size) {
        best = { size: s, cols, rows };
      } else if (s === best.size && s > 0) {
        // Prefer fewer rows when size ties (more horizontal, less tall)
        if (rows < best.rows) best = { size: s, cols, rows };
      }
    }

    // Soft floor: allow below TILE_MIN when many wheels so they still fit
    let size = best.size;
    if (!Number.isFinite(size) || size < 80) size = 80;
    size = Math.min(TILE_MAX, size);
    // Cap to viewport width so a single tile never overflows
    size = Math.min(size, Math.max(80, w - 4));
    return {
      size: Math.round(size),
      cols: best.cols || 1,
      rows: best.rows || 1,
    };
  }

  /**
   * Largest square stage size so `n` tiles all fit on the board viewport.
   * Always fits width + height (no vertical-scroll-only oversize).
   */
  function maxTileSizeForCount(n) {
    return bestFitPack(n).size;
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

  function cellKey(col, row) {
    return `${col},${row}`;
  }

  /** Map cell key → slotId (optional exclude). */
  function occupiedCellMap(excludeId = null) {
    const m = new Map();
    for (const id of selectedIds) {
      if (id === excludeId) continue;
      const L = layoutMap[id];
      if (!L || !Number.isFinite(L.col) || !Number.isFinite(L.row)) continue;
      m.set(cellKey(L.col, L.row), id);
    }
    return m;
  }

  /** First empty cell in row-major order (viewport column width). */
  function firstFreeCell(excludeId = null) {
    const occ = occupiedCellMap(excludeId);
    const { cols } = gridMetrics();
    const colCount = Math.max(1, cols);
    for (let row = 0; row < 200; row++) {
      for (let col = 0; col < colCount; col++) {
        if (!occ.has(cellKey(col, row))) return { col, row };
      }
    }
    return { col: 0, row: 0 };
  }

  function defaultPosForIndex(i, size) {
    const { size: s, cols, cellW, cellH } = gridMetrics(size);
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: col * cellW,
      y: row * cellH,
      col,
      row,
      size: s,
      customSize: false,
    };
  }

  /**
   * Infer col/row from pixel x/y when sparse coords were stripped (older saves).
   */
  function cellFromXY(x, y, size) {
    const { cellW, cellH } = gridMetrics(size);
    const col = Math.max(0, Math.round(Number(x) / Math.max(1, cellW)) || 0);
    const row = Math.max(0, Math.round(Number(y) / Math.max(1, cellH)) || 0);
    return { col, row };
  }

  /**
   * Ensure every on-board wheel has a unique (col, row). Keeps empty cells free.
   * Does not pack densely — only fills missing coords and resolves collisions.
   */
  function ensureGridCells() {
    const size = effectiveGridSize();
    // Assign missing coords (prefer x/y → cell so gaps survive reloads)
    for (const id of selectedIds) {
      const L = layoutMap[id] || {};
      if (!Number.isFinite(L.col) || !Number.isFinite(L.row)) {
        if (Number.isFinite(L.x) || Number.isFinite(L.y)) {
          const inferred = cellFromXY(L.x || 0, L.y || 0, size);
          layoutMap[id] = { ...L, col: inferred.col, row: inferred.row };
        } else {
          const free = firstFreeCell(id);
          layoutMap[id] = { ...L, col: free.col, row: free.row };
        }
      } else {
        layoutMap[id] = L;
      }
    }
    // Resolve duplicate cells (leave existing gaps alone)
    const seen = new Map();
    for (const id of selectedIds) {
      const L = layoutMap[id];
      const k = cellKey(L.col, L.row);
      if (seen.has(k)) {
        const free = firstFreeCell(id);
        L.col = free.col;
        L.row = free.row;
      } else {
        seen.set(k, id);
      }
    }
  }

  /**
   * How many cols/rows of empty+filled slots to show while dragging / as guides.
   * Always includes empty margin so you can leave blank spots and place anywhere.
   */
  function dropGridExtent() {
    const size = effectiveGridSize();
    const { cols: naturalCols, cellW, cellH } = gridMetrics(size);
    let maxC = 0;
    let maxR = 0;
    for (const id of selectedIds) {
      const L = layoutMap[id];
      if (!L || !Number.isFinite(L.col) || !Number.isFinite(L.row)) continue;
      maxC = Math.max(maxC, L.col);
      maxR = Math.max(maxR, L.row);
    }
    // Full viewport columns + at least one extra empty column/row beyond farthest wheel
    const cols = Math.max(naturalCols + 1, maxC + 2, 2);
    const rows = Math.max(maxR + 2, 2);
    return { cols, rows, size, cellW, cellH };
  }

  /**
   * Sparse grid: each wheel keeps its own (col, row); empty cells allowed.
   */
  function applyGridLayout({ redraw = true } = {}) {
    const n = selectedIds.length;
    if (!n) {
      updateBoardSize();
      positionGridResizeHandle();
      return;
    }
    let size = effectiveGridSize();
    const { w } = boardViewport();
    const maxOneCol = clampSize(w - 4);
    if (size > maxOneCol) {
      size = maxOneCol;
      if (sharedGridSize != null) {
        sharedGridSize = size;
        saveSharedGridSize();
      }
    }
    ensureGridCells();
    const { cellW, cellH } = gridMetrics(size);
    for (const id of selectedIds) {
      const prev = layoutMap[id] || {};
      const col = Number.isFinite(prev.col) ? prev.col : 0;
      const row = Number.isFinite(prev.row) ? prev.row : 0;
      layoutMap[id] = {
        ...prev,
        col,
        row,
        x: col * cellW,
        y: row * cellH,
        size,
        customSize: sharedGridSize != null,
      };
    }
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
    // Persist col/row so blank spots survive reloads
    saveLayout();
  }

  function ensureLayoutFor(slotId, indexHint = 0) {
    if (!freeLayout) {
      if (
        layoutMap[slotId] &&
        Number.isFinite(layoutMap[slotId].col) &&
        Number.isFinite(layoutMap[slotId].row)
      ) {
        return layoutMap[slotId];
      }
      const free = firstFreeCell(slotId);
      const size = effectiveGridSize();
      const { cellW, cellH } = gridMetrics(size);
      layoutMap[slotId] = {
        ...(layoutMap[slotId] || {}),
        col: free.col,
        row: free.row,
        x: free.col * cellW,
        y: free.row * cellH,
        size,
        customSize: sharedGridSize != null,
      };
      return layoutMap[slotId];
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
      // Grid: allow sparse empty slots (blank cells) past the dense pack
      g.style.width = "100%";
      const size = effectiveGridSize();
      const { cellH, cellW } = gridMetrics(size);
      const ext = dropGridExtent();
      let maxC = 0;
      let maxR = 0;
      for (const id of selectedIds) {
        const L = layoutMap[id];
        if (!L) continue;
        if (Number.isFinite(L.col)) maxC = Math.max(maxC, L.col);
        if (Number.isFinite(L.row)) maxR = Math.max(maxR, L.row);
      }
      // Board must fit farthest wheel AND the empty drop margin
      const contentH = Math.max(maxR + 1, ext.rows) * cellH + 8;
      const contentW = Math.max(maxC + 1, ext.cols) * cellW + 8;
      g.style.minHeight = `${Math.max(contentH, vp.h)}px`;
      // Grow past viewport so empty side columns are scrollable (CSS no longer forces 0)
      if (contentW > vp.w) {
        g.style.minWidth = `${contentW}px`;
      } else {
        g.style.minWidth = "";
      }
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

  /** Grid cell under pointer — empty slots included (not only occupied tiles). */
  function gridCellFromPoint(clientX, clientY) {
    const g = grid();
    if (!g) return { col: 0, row: 0 };
    const rect = g.getBoundingClientRect();
    const style = getComputedStyle(g);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const x = clientX - rect.left + g.scrollLeft - padL;
    const y = clientY - rect.top + g.scrollTop - padT;
    const { cols, rows, cellW, cellH } = dropGridExtent();
    // Floor into cell grid first — empty cells are equal citizens
    let col = Math.floor(x / Math.max(1, cellW));
    let row = Math.floor(y / Math.max(1, cellH));
    col = Math.max(0, Math.min(cols - 1, col));
    row = Math.max(0, Math.min(rows - 1, row));
    return { col, row };
  }

  /**
   * Place wheel on any cell. Empty cell = leave a blank gap behind. Occupied = swap.
   */
  function placeWheelAtCell(slotId, col, row) {
    col = Math.max(0, Math.round(Number(col) || 0));
    row = Math.max(0, Math.round(Number(row) || 0));
    if (!layoutMap[slotId]) layoutMap[slotId] = {};
    const L = layoutMap[slotId];
    // Same cell → no-op
    if (L.col === col && L.row === row) {
      saveLayout();
      return;
    }
    const fromCol = Number.isFinite(L.col) ? L.col : null;
    const fromRow = Number.isFinite(L.row) ? L.row : null;
    const occ = occupiedCellMap(slotId);
    const otherId = occ.get(cellKey(col, row));
    if (otherId) {
      // Swap: other takes our old cell (or a free one if we had none)
      const oL = layoutMap[otherId] || {};
      if (fromCol != null && fromRow != null) {
        oL.col = fromCol;
        oL.row = fromRow;
      } else {
        const free = firstFreeCell(otherId);
        oL.col = free.col;
        oL.row = free.row;
      }
      layoutMap[otherId] = oL;
    }
    // Empty target: old cell becomes a blank spot automatically
    L.col = col;
    L.row = row;
    layoutMap[slotId] = L;
    saveLayout();
  }

  function clearGridDropHighlight() {
    for (const t of tiles.values()) {
      t.rootEl?.classList.remove("is-drop-target");
    }
    const layer = document.getElementById("multi-grid-drop-layer");
    layer
      ?.querySelectorAll(".multi-grid-drop-cell.is-active")
      .forEach((c) => c.classList.remove("is-active"));
  }

  function setGridDropHighlight(slotId) {
    for (const t of tiles.values()) {
      t.rootEl?.classList.toggle("is-drop-target", t.slotId === slotId);
    }
  }

  function highlightDropCell(col, row) {
    const layer = document.getElementById("multi-grid-drop-layer");
    if (!layer) return;
    layer.querySelectorAll(".multi-grid-drop-cell").forEach((c) => {
      c.classList.toggle(
        "is-active",
        Number(c.dataset.col) === col && Number(c.dataset.row) === row
      );
    });
  }

  /**
   * Visible placement grid while dragging — every cell (empty + occupied).
   * Empty dashed cells are valid drop targets (leave blank spots).
   */
  function showGridDropOverlay() {
    if (freeLayout) return;
    const g = grid();
    if (!g || !selectedIds.length) return;
    hideGridDropOverlay();
    // Grow board first so empty margin cells exist in the scroll area
    updateBoardSize();

    const { cols, rows, size, cellW, cellH } = dropGridExtent();
    // Include source in occupancy label map but not for "occupied" class
    const occAll = occupiedCellMap(null);
    const srcId = drag?.tile?.slotId || null;
    const src = srcId ? layoutMap[srcId] : null;

    const layer = document.createElement("div");
    layer.id = "multi-grid-drop-layer";
    layer.className = "multi-grid-drop-layer";
    layer.setAttribute("aria-hidden", "true");

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = document.createElement("div");
        cell.className = "multi-grid-drop-cell";
        cell.dataset.col = String(col);
        cell.dataset.row = String(row);
        cell.style.left = `${col * cellW}px`;
        cell.style.top = `${row * cellH}px`;
        cell.style.width = `${size}px`;
        cell.style.height = `${size + TILE_CHROME_H}px`;

        const k = cellKey(col, row);
        const occId = occAll.get(k);
        const isSource =
          src &&
          Number.isFinite(src.col) &&
          Number.isFinite(src.row) &&
          src.col === col &&
          src.row === row;

        if (isSource) {
          cell.classList.add("is-source");
        } else if (occId && occId !== srcId) {
          cell.classList.add("is-occupied");
        } else {
          // Blank spot — valid place target
          cell.classList.add("is-empty");
        }

        const num = document.createElement("span");
        num.className = "multi-grid-drop-cell-num";
        if (isSource) {
          num.textContent = "here";
        } else if (occId && occId !== srcId) {
          num.textContent = tiles.get(occId)?.name?.slice(0, 8) || "•";
        } else {
          num.textContent = "empty";
        }
        cell.appendChild(num);
        layer.appendChild(cell);
      }
    }

    // Ensure scroll area covers the full drop grid (incl. empty side cells)
    g.style.minHeight = `${rows * cellH + 16}px`;
    const needW = cols * cellW + 16;
    if (needW > boardViewport().w) {
      g.style.minWidth = `${needW}px`;
    }

    g.appendChild(layer);
    g.classList.add("is-showing-drop-grid");
  }

  function hideGridDropOverlay() {
    document.getElementById("multi-grid-drop-layer")?.remove();
    grid()?.classList.remove("is-showing-drop-grid");
  }

  /**
   * Hard reset: pack every on-screen wheel into a dense grid at the largest
   * size that still fits ALL of them on screen (no scroll needed).
   */
  function fitAllLargest() {
    if (!selectedIds.length) {
      setSummary("Select wheels first, then Fit largest");
      return;
    }

    // Clear per-tile overrides; size will be pinned to the fit-all size
    for (const id of Object.keys(layoutMap)) {
      const L = layoutMap[id];
      if (!L) continue;
      L.customSize = false;
      delete L.size;
    }

    const g = grid();
    if (g) {
      // Reset board so viewport measure is the real visible panel
      g.style.minWidth = "";
      g.style.width = "100%";
      g.style.minHeight = "";
      try {
        g.scrollLeft = 0;
        g.scrollTop = 0;
      } catch {
        /* ignore */
      }
    }

    const packNow = () => {
      const n = Math.max(1, selectedIds.length);
      // Largest size + best columns so every wheel fits on screen
      const pack = bestFitPack(n);
      const size = pack.size;
      const cols = pack.cols;
      const cellW = size + TILE_GAP;
      const cellH = size + TILE_CHROME_H + TILE_GAP;

      // Pin shared size so layout doesn't re-grow past the fit
      sharedGridSize = size;
      saveSharedGridSize();

      // Dense pack — clears empty gaps; uses the same cols as the fit math
      selectedIds.forEach((id, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        layoutMap[id] = {
          ...(layoutMap[id] || {}),
          col,
          row,
          x: col * cellW,
          y: row * cellH,
          size,
          customSize: true,
        };
      });
      saveLayout();

      // Stay in current free/grid mode but place by the dense pack
      if (!freeLayout) {
        applyGridLayout({ redraw: true });
      } else {
        for (const t of tiles.values()) {
          if (!t.rootEl) continue;
          const pos = layoutMap[t.slotId];
          if (!pos) continue;
          t.rootEl.style.left = `${pos.x}px`;
          t.rootEl.style.top = `${pos.y}px`;
          t.rootEl.style.width = `${size}px`;
          t.rootEl.style.minWidth = `${size}px`;
          try {
            t.wheel?.resize?.();
            t.wheel?.draw?.();
          } catch {
            /* ignore */
          }
        }
        updateBoardSize();
      }

      if (g) {
        // Board only needs to be as big as the pack (fits viewport)
        g.style.minWidth = "";
        g.style.minHeight = "";
        try {
          g.scrollLeft = 0;
          g.scrollTop = 0;
        } catch {
          /* ignore */
        }
      }

      syncPickerGridSizeUi();
      setSummary(
        `Fit largest: ${n} wheel${n === 1 ? "" : "s"} at ${size}px · ${cols}×${pack.rows} (all on screen)`
      );
      positionGridResizeHandle();
    };

    // Two frames so clientWidth/Height update after clearing huge min sizes
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
    applyTileStackOrder();
  }

  /**
   * Free placement stack order from selectedIds:
   * index 0 (top of Wheels list) → highest z (on top / eclipses others);
   * last index (bottom of list) → lowest z (behind).
   * Grid mode clears inline z so CSS defaults apply.
   */
  function applyTileStackOrder() {
    if (!freeLayout) {
      for (const t of tiles.values()) {
        if (!t.rootEl) continue;
        if (
          t.rootEl.classList.contains("is-dragging") ||
          t.rootEl.classList.contains("is-resizing")
        ) {
          continue;
        }
        t.rootEl.style.zIndex = "";
      }
      return;
    }
    const n = selectedIds.length;
    selectedIds.forEach((id, i) => {
      const t = tiles.get(id);
      if (!t?.rootEl) return;
      if (
        t.rootEl.classList.contains("is-dragging") ||
        t.rootEl.classList.contains("is-resizing")
      ) {
        return;
      }
      // Top of list = highest z; bottom of list = lowest z
      t.rootEl.style.zIndex = String(10 + (n - 1 - i));
    });
  }

  /**
   * Reorder selectedIds so `slotId` lands at insertIndex among on-screen wheels.
   * @param {string} slotId
   * @param {number} insertIndex index in the list *without* the dragged id
   */
  function reorderSelectedId(slotId, insertIndex) {
    const from = selectedIds.indexOf(slotId);
    if (from < 0) return false;
    const next = selectedIds.slice();
    const [item] = next.splice(from, 1);
    const clamped = Math.max(0, Math.min(insertIndex, next.length));
    next.splice(clamped, 0, item);
    const changed = next.some((id, i) => id !== selectedIds[i]);
    if (!changed) return false;
    selectedIds = next;
    saveSelection();
    applyTileStackOrder();
    return true;
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
      setSummary("Grid layout — drag tiles on the board; list grip reorders on-screen");
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
      applyTileStackOrder();
      renderPicker();
      setSummary(
        "Free placement — drag tiles to move; list order = stack (top of list is on top)"
      );
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

  function getPickerOnScreenRows() {
    const list = pickerList();
    if (!list) return [];
    return [...list.querySelectorAll(".multi-picker-row.is-on-screen")];
  }

  function clearPickerDragTransforms() {
    getPickerOnScreenRows().forEach((row) => {
      row.style.transform = "";
      row.style.transition = "";
      row.classList.remove("is-drag-source", "is-slot-open");
    });
    pickerList()?.classList.remove("is-reordering");
  }

  function applyPickerLiveShifts() {
    if (!pickerDrag) return;
    const from = pickerDrag.fromIndex;
    const insert = pickerDrag.insertIndex;
    const stride = pickerDrag.stride;
    getPickerOnScreenRows().forEach((row, i) => {
      if (i === from) {
        row.style.transform = "none";
        return;
      }
      const without = i > from ? i - 1 : i;
      const final = without >= insert ? without + 1 : without;
      const shift = (final - i) * stride;
      row.style.transform = shift
        ? `translate3d(0, ${shift}px, 0)`
        : "translate3d(0,0,0)";
    });
    // Live-update stack badges while dragging
    const order = selectedIds.slice();
    const [moved] = order.splice(from, 1);
    const clamped = Math.max(0, Math.min(insert, order.length));
    order.splice(clamped, 0, moved);
    const list = pickerList();
    order.forEach((id, i) => {
      const badge = list?.querySelector(
        `.multi-picker-row[data-slot-id="${CSS.escape(id)}"] .multi-picker-stack`
      );
      if (badge) {
        badge.textContent = freeLayout
          ? i === 0
            ? "top"
            : i === order.length - 1
              ? "back"
              : `#${i + 1}`
          : `#${i + 1}`;
      }
    });
  }

  function pickerInsertIndexFromY(clientY) {
    if (!pickerDrag) return 0;
    const from = pickerDrag.fromIndex;
    let insert = 0;
    pickerDrag.layout.forEach((l, i) => {
      if (i === from) return;
      if (clientY > l.mid) insert += 1;
    });
    return insert;
  }

  function movePickerGhost(clientX, clientY) {
    if (!pickerDrag?.ghost) return;
    const x = clientX - (pickerDrag.offsetX || 0);
    const y = clientY - pickerDrag.offsetY;
    pickerDrag.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.03) rotate(-0.5deg)`;
  }

  function startPickerDrag(row, e) {
    const rows = getPickerOnScreenRows();
    const fromIndex = rows.indexOf(row);
    if (fromIndex < 0) return;
    const slotId = row.dataset.slotId;
    if (!slotId || !selectedIds.includes(slotId)) return;

    const rect = row.getBoundingClientRect();
    pickerDrag = {
      pointerId: e.pointerId,
      slotId,
      fromIndex,
      insertIndex: fromIndex,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      stride: rect.height + 4,
      row,
      ghost: null,
      layout: rows.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          el,
          id: el.dataset.slotId || "",
          mid: r.top + r.height / 2,
        };
      }),
      active: true,
      moved: true,
    };

    if (rows.length > 1) {
      const gap = Math.max(
        0,
        rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom
      );
      pickerDrag.stride = rect.height + gap;
    }

    const ghost = row.cloneNode(true);
    ghost.classList.add("multi-picker-drag-ghost");
    ghost.classList.remove("is-drag-source", "is-focused");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = "0";
    ghost.style.top = "0";
    document.body.appendChild(ghost);
    pickerDrag.ghost = ghost;
    movePickerGhost(e.clientX, e.clientY);

    const list = pickerList();
    list?.classList.add("is-reordering");
    row.classList.add("is-drag-source");
    rows.forEach((r) => {
      if (r !== row) {
        r.style.transition =
          "transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)";
      }
    });
    pickerDrag.insertIndex = pickerInsertIndexFromY(e.clientY);
    applyPickerLiveShifts();

    try {
      row.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.add("multi-picker-drag-cursor");
  }

  function endPickerDrag(commit) {
    if (!pickerDrag) return;
    const { fromIndex, insertIndex, slotId, ghost, active } = pickerDrag;
    if (ghost) {
      ghost.classList.add("multi-picker-drag-ghost-exit");
      const g = ghost;
      setTimeout(() => g.remove(), 160);
    }
    clearPickerDragTransforms();
    document.body.classList.remove("multi-picker-drag-cursor");
    const did = active && commit && fromIndex >= 0;
    pickerDrag = null;
    if (did) {
      const changed = reorderSelectedId(slotId, insertIndex);
      renderPicker();
      if (changed) {
        const n = selectedIds.length;
        const pos = selectedIds.indexOf(slotId) + 1;
        setSummary(
          freeLayout
            ? `Stack order: “${pos === 1 ? "top" : pos === n ? "back" : "#" + pos}” of ${n} (top of list = on top)`
            : `On-screen order updated (#${pos} of ${n})`
        );
      }
    } else {
      renderPicker();
    }
  }

  function onPickerPointerDown(e) {
    const handle = e.target.closest?.(".multi-picker-drag");
    if (!handle) return;
    const row = handle.closest(".multi-picker-row.is-on-screen");
    if (!row) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Pending until move threshold — avoids fighting clicks
    pickerDrag = {
      pointerId: e.pointerId,
      slotId: row.dataset.slotId || "",
      fromIndex: getPickerOnScreenRows().indexOf(row),
      insertIndex: 0,
      startY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      stride: 0,
      row,
      ghost: null,
      layout: [],
      active: false,
      moved: false,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onPickerPointerMove(e) {
    if (!pickerDrag || e.pointerId !== pickerDrag.pointerId) return;
    if (!pickerDrag.active) {
      const dy = e.clientY - pickerDrag.startY;
      if (Math.abs(dy) < 6) return;
      startPickerDrag(pickerDrag.row, e);
      if (!pickerDrag?.active) return;
    }
    pickerDrag.moved = true;
    movePickerGhost(e.clientX, e.clientY);
    const nextInsert = pickerInsertIndexFromY(e.clientY);
    if (nextInsert !== pickerDrag.insertIndex) {
      pickerDrag.insertIndex = nextInsert;
      applyPickerLiveShifts();
    }
  }

  function onPickerPointerUp(e) {
    if (!pickerDrag || e.pointerId !== pickerDrag.pointerId) return;
    if (!pickerDrag.active) {
      // No drag — treat as no-op (name click handles edit)
      pickerDrag = null;
      return;
    }
    endPickerDrag(true);
  }

  function renderPicker() {
    const list = pickerList();
    if (!list) return;
    // Don't rebuild DOM mid-reorder
    if (pickerDrag?.active) return;
    const slots = librarySlots();
    const idSet = new Set(selectedIds);
    selectedIds = selectedIds.filter((id) => slots.some((w) => w.id === id));
    const focus = selectionUiVisible
      ? focusedSlotId || activeLibraryId()
      : null;
    list.innerHTML = "";
    if (!slots.length) {
      list.innerHTML = `<p class="multi-picker-empty">No saved wheels.</p>`;
      return;
    }

    // On-screen first (stack order), then off-screen library wheels
    const ordered = [
      ...selectedIds
        .map((id) => slots.find((w) => w.id === id))
        .filter(Boolean),
      ...slots.filter((w) => !idSet.has(w.id)),
    ];

    const onScreenCount = selectedIds.length;
    ordered.forEach((w) => {
      const onScreen = idSet.has(w.id);
      const stackIdx = onScreen ? selectedIds.indexOf(w.id) : -1;
      const row = document.createElement("div");
      row.className =
        "multi-picker-row" +
        (onScreen ? " is-on-screen" : " is-off-screen") +
        (focus && w.id === focus ? " is-focused" : "");
      row.dataset.slotId = w.id;

      // Drag grip — on-screen only (controls free-placement stack)
      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "multi-picker-drag";
      grip.hidden = !onScreen;
      grip.title = freeLayout
        ? "Drag to set stack order — top of list is on top"
        : "Drag to reorder wheels on screen";
      grip.setAttribute("aria-label", "Drag to reorder");
      grip.innerHTML = `<span class="drag-grip" aria-hidden="true"></span>`;
      grip.addEventListener("pointerdown", onPickerPointerDown);

      // Checkbox alone toggles show-on-board
      const cbWrap = document.createElement("label");
      cbWrap.className = "multi-picker-check";
      cbWrap.title = "Show on multi-spin board";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = onScreen;
      cb.addEventListener("click", (e) => e.stopPropagation());
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
      cbWrap.appendChild(cb);

      const span = document.createElement("span");
      span.className = "multi-picker-name";
      span.textContent = w.name || "Untitled";
      span.title = "Click to select and edit this wheel";
      span.tabIndex = 0;
      const openEdit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void selectTile(w.id, { edit: true });
      };
      span.addEventListener("click", openEdit);
      span.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") openEdit(e);
      });

      // Stack badge for on-screen rows (free placement meaning)
      const badge = document.createElement("span");
      badge.className = "multi-picker-stack";
      if (onScreen && onScreenCount > 0) {
        if (freeLayout) {
          if (stackIdx === 0) badge.textContent = "top";
          else if (stackIdx === onScreenCount - 1) badge.textContent = "back";
          else badge.textContent = `#${stackIdx + 1}`;
          badge.title =
            stackIdx === 0
              ? "Top — overlaps other wheels in free placement"
              : stackIdx === onScreenCount - 1
                ? "Back — under other wheels in free placement"
                : `Stack #${stackIdx + 1} of ${onScreenCount}`;
        } else {
          badge.textContent = `#${stackIdx + 1}`;
          badge.title = `On-screen order #${stackIdx + 1}`;
        }
      } else {
        badge.hidden = true;
      }

      row.appendChild(grip);
      row.appendChild(cbWrap);
      row.appendChild(span);
      row.appendChild(badge);
      list.appendChild(row);
    });
    setWarn();
  }

  function createTileDom(slot) {
    const el = document.createElement("article");
    el.className = "multi-tile";
    el.dataset.slotId = slot.id;
    el.setAttribute("role", "listitem");
    el.setAttribute("aria-selected", "false");
    const name = slot.name || "Untitled";
    el.title = `${name} — click to edit · drag grip to move · fling wheel to spin`;
    el.innerHTML = `
      <div class="stage stage--mini multi-tile-stage">
        <button type="button" class="multi-tile-drag" title="Drag to move this wheel" aria-label="Drag to move ${escapeAttr(name)}">
          <span class="drag-grip" aria-hidden="true"></span>
        </button>
        <div class="bg-media" aria-hidden="true"></div>
        <canvas class="bg-canvas"></canvas>
        <canvas class="wheel-canvas"></canvas>
        <div class="slice-media-layer" aria-hidden="true">
          <div class="slice-media-rotator"></div>
        </div>
        <canvas class="wheel-overlay"></canvas>
        <div class="center-media" aria-hidden="true"></div>
        <div class="pointer" aria-hidden="true"></div>
        <div class="multi-tile-result-center hidden" aria-live="polite">
          <div class="multi-tile-result-center-bg" aria-hidden="true"></div>
          <div class="multi-tile-result-center-scrim" aria-hidden="true"></div>
          <div class="multi-tile-result-center-inner">
            <span class="multi-tile-result-center-label">Winner</span>
            <span class="multi-tile-result-center-text"></span>
            <span class="multi-tile-result-center-note" hidden></span>
          </div>
        </div>
      </div>
      <div class="multi-tile-result" aria-live="polite" hidden></div>
      <div class="multi-tile-queue" hidden title="Spins waiting to run after this wheel finishes"></div>
      <div class="multi-tile-resize" title="Drag to resize this wheel" aria-label="Resize wheel" hidden></div>
      <span class="multi-tile-size-label" aria-hidden="true" hidden></span>
    `;
    return el;
  }

  /** Escape for double-quoted HTML attributes. */
  function escapeAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function maxSpeedScaleForTile(tile) {
    let pct = Number(tile?.state?.spin?.maxSpeedPct);
    if (!Number.isFinite(pct) || pct <= 0) pct = 100;
    pct = Math.min(200, Math.max(25, pct));
    return pct / 100;
  }

  // --- Winner pointer drag on multi tiles (Misc → unlock pointer) ---
  const MULTI_POINTER_SNAP_DEGS = [0, 90, 180, 270];
  const MULTI_POINTER_SNAP_WINDOW = 5;

  function normalizeMultiPointerDeg(deg) {
    const d = Number(deg);
    if (!Number.isFinite(d)) return 90;
    return ((d % 360) + 360) % 360;
  }

  function snapMultiPointerDeg(deg) {
    let d = normalizeMultiPointerDeg(deg);
    let best = d;
    let bestDist = Infinity;
    for (const s of MULTI_POINTER_SNAP_DEGS) {
      let dist = Math.abs(d - s);
      if (dist > 180) dist = 360 - dist;
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    if (bestDist <= MULTI_POINTER_SNAP_WINDOW) return best;
    return d;
  }

  function multiPointerDegFromClient(tile, clientX, clientY) {
    const stage = tile.rootEl?.querySelector(".multi-tile-stage");
    if (!stage) {
      return normalizeMultiPointerDeg(tile.state?.look?.pointerAngleDeg ?? 90);
    }
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ang = Math.atan2(clientY - cy, clientX - cx);
    return normalizeMultiPointerDeg((ang * 180) / Math.PI + 90);
  }

  /** Merge live library look into a tile wheel so unlock/pointer updates apply immediately. */
  function syncTileLookFromLibrary(tile) {
    if (!tile) return;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      const look = slot?.data?.look;
      if (!look) return;
      tile.state = tile.state || {};
      tile.state.look = { ...(tile.state.look || {}), ...look };
      if (tile.wheel) {
        tile.wheel.look = { ...(tile.wheel.look || {}), ...look };
      }
    } catch {
      /* ignore */
    }
  }

  /** Host pushes editor Look changes onto the matching multi tile (e.g. unlock pointer). */
  function pushLookToTile(slotId, look) {
    if (!active || !slotId || !look) return;
    const tile = tiles.get(slotId);
    if (!tile) return;
    tile.state = tile.state || {};
    tile.state.look = { ...(tile.state.look || {}), ...look };
    if (tile.wheel) {
      tile.wheel.look = { ...(tile.wheel.look || {}), ...look };
      try {
        tile.wheel.layoutPointer?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** Write pointer angle into this multi tile + library slot. */
  function applyMultiPointerAngle(tile, deg, { persistNow = false, snap = true } = {}) {
    if (!tile) return;
    let d = normalizeMultiPointerDeg(deg);
    if (snap) d = snapMultiPointerDeg(d);
    if (!tile.state) tile.state = {};
    if (!tile.state.look) tile.state.look = {};
    tile.state.look.pointerAngleDeg = d;
    if (tile.wheel?.look) tile.wheel.look.pointerAngleDeg = d;
    try {
      tile.wheel?.layoutPointer?.();
    } catch {
      /* ignore */
    }
    try {
      if (tile.wheel && !tile.wheel.spinning) {
        tile.wheel.draw({ spinFrame: false });
      }
    } catch {
      /* ignore */
    }
    if (!persistNow) return;
    try {
      const lib = deps.getLibrary?.();
      const slot = lib?.wheels?.find((w) => w.id === tile.slotId);
      if (slot?.data) {
        if (!slot.data.look) slot.data.look = {};
        slot.data.look.pointerAngleDeg = d;
        if (tile.state.look && "pointerLocked" in tile.state.look) {
          slot.data.look.pointerLocked = tile.state.look.pointerLocked !== false;
        }
      }
      if (typeof deps.saveLibrary === "function") {
        deps.saveLibrary(lib);
      } else {
        deps.onTileLookChanged?.(tile.slotId, tile.state);
      }
      // Keep sidebar wheel in sync when this tile is the one being edited
      try {
        deps.onTilePointerAngle?.(tile.slotId, d);
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.warn("multi-spin save pointer angle:", err);
    }
  }

  /**
   * Drag the yellow winner pointer on a multi tile (when unlocked).
   */
  function bindTileWinnerPointerDrag(tile) {
    const el = tile.rootEl?.querySelector(".pointer");
    if (!el || el.dataset.multiPointerDragBound === "1") return;
    el.dataset.multiPointerDragBound = "1";

    const dragState = { active: false, pointerId: null };

    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      // Pull unlock flag from library so sidebar toggle applies without re-enter
      syncTileLookFromLibrary(tile);
      try {
        tile.wheel?.layoutPointer?.();
      } catch {
        /* ignore */
      }
      const locked = tile.wheel?.isPointerLocked
        ? tile.wheel.isPointerLocked()
        : tile.state?.look?.pointerLocked !== false;
      if (locked) return;
      if (tile.spinning || tile.wheel?.spinning || tile.wheel?._dragging) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.active = true;
      dragState.pointerId = e.pointerId;
      el.classList.add("is-dragging");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      applyMultiPointerAngle(
        tile,
        multiPointerDegFromClient(tile, e.clientX, e.clientY),
        { snap: true }
      );
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragState.active) return;
      if (
        dragState.pointerId != null &&
        e.pointerId !== dragState.pointerId
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      applyMultiPointerAngle(
        tile,
        multiPointerDegFromClient(tile, e.clientX, e.clientY),
        { snap: true }
      );
    });

    const endPtr = (e) => {
      if (!dragState.active) return;
      if (
        e &&
        dragState.pointerId != null &&
        e.pointerId !== dragState.pointerId
      ) {
        return;
      }
      dragState.active = false;
      dragState.pointerId = null;
      el.classList.remove("is-dragging");
      applyMultiPointerAngle(
        tile,
        Number.isFinite(Number(tile.state?.look?.pointerAngleDeg))
          ? tile.state.look.pointerAngleDeg
          : 90,
        { snap: true, persistNow: true }
      );
    };

    el.addEventListener("pointerup", endPtr);
    el.addEventListener("pointercancel", endPtr);
  }

  /**
   * Mouse/touch drag on the mini stage: aim, grab-to-stop, fling (same as main wheel).
   */
  function enableTileWheelPointer(tile) {
    const stage = tile.rootEl?.querySelector(".multi-tile-stage");
    if (!stage || !tile.wheel || tile._wheelPointerBound) return;
    tile._wheelPointerBound = true;

    // Winner pointer drag (unlocked) — separate from wheel fling
    bindTileWinnerPointerDrag(tile);

    try {
      tile.wheel.enablePointerDrag(stage, {
        canStart: () => {
          const look = tile.state?.look;
          if (look?.allowWheelDrag === false) return false;
          if (!getActiveSections(tile.state || {}).length) return false;
          // Don't steal moves while repositioning the multi tile
          if (drag?.tile === tile) return false;
          return true;
        },
        getAllowWheelDrag: () => tile.state?.look?.allowWheelDrag !== false,
        getAllowGrabStopSpin: () =>
          tile.state?.look?.allowGrabStopSpin !== false,
        getFairDragSpin: () => tile.state?.look?.fairDragSpin === true,
        onDragStart: ({ interrupted } = {}) => {
          tile._wheelInteracted = true;
          deps.audio?.ensure?.();
          // Clear big-center as soon as the user grabs the wheel
          dismissTileResultForNewSpin(tile);
          if (interrupted) {
            // Invalidate the in-flight spinTile so its land doesn't re-show overlay
            bumpTileSpinGen(tile);
            // spinTile's await will finish — hold queue until fling/idle
            tile._holdQueueForDrag = true;
            tile.spinning = false;
            tile.rootEl?.classList.remove("is-spinning");
          }
        },
        onFling: (vel) => {
          tile._wheelInteracted = true;
          tile._holdQueueForDrag = false;
          dismissTileResultForNewSpin(tile);
          if (tile.state?.look?.fairDragSpin === true) {
            const dir = Number(vel) < 0 ? -1 : 1;
            void requestSpin(tile, {
              silentLand: false,
              chainDepth: 0,
              spinDirection: dir,
            });
            return;
          }
          void flingTile(tile, vel, { silentLand: false, chainDepth: 0 });
        },
        onDragEndIdle: () => {
          tile._wheelInteracted = true;
          tile.spinning = false;
          tile.rootEl?.classList.remove("is-spinning");
          // Resume any queue held while grabbing mid-spin
          if (tile._holdQueueForDrag) {
            tile._holdQueueForDrag = false;
            void drainQueue(tile);
          }
        },
      });
    } catch (err) {
      console.warn("multi-spin enablePointerDrag:", tile.name, err);
    }
  }

  function bindTileChrome(tile) {
    const rootEl = tile.rootEl;
    const stage = rootEl.querySelector(".multi-tile-stage");

    // Click tile / wheel window → edit that wheel in the sidebar (no Edit button)
    rootEl.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (e.target.closest(".multi-tile-resize")) return;
      if (e.target.closest(".multi-tile-drag")) return;
      // After wheel drag/fling, don't open edit
      if (e.target.closest(".multi-tile-stage") && tile._wheelInteracted) {
        tile._wheelInteracted = false;
        return;
      }
      void selectTile(tile.slotId, { edit: true });
    });

    stage?.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (tile.state?.look?.allowDoubleClickSpin === false) return;
      void requestSpin(tile, { silentLand: false, chainDepth: 0 });
    });

    // Tap big-center winner overlay to dismiss (same idea as main wheel)
    const resultCenter = stage?.querySelector(".multi-tile-result-center");
    resultCenter?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTileResultCenter(tile);
    });

    // Drag handle lives inside the wheel window (no top chrome bar)
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
    // Picker list reorder (stack order) — independent of board drag
    if (pickerDrag && e.pointerId === pickerDrag.pointerId) {
      onPickerPointerMove(e);
      return;
    }
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
    const firstMove = !drag.moved;
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
      // Full grid with empty slots once drag starts (blank cells are valid targets)
      if (firstMove) showGridDropOverlay();
      const { col, row } = gridCellFromPoint(e.clientX, e.clientY);
      highlightDropCell(col, row);
      const occ = occupiedCellMap(drag.tile.slotId);
      const otherId = occ.get(cellKey(col, row));
      if (otherId) setGridDropHighlight(otherId);
      else {
        for (const t of tiles.values()) {
          t.rootEl?.classList.remove("is-drop-target");
        }
      }
    }
  }

  function onDragPointerUp(e) {
    if (pickerDrag && e.pointerId === pickerDrag.pointerId) {
      onPickerPointerUp(e);
      return;
    }
    if (resize && e.pointerId === resize.pointerId) {
      const t = resize.tile;
      resize = null;
      if (t?.rootEl) {
        t.rootEl.classList.remove("is-resizing");
      }
      applyTileStackOrder();
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
    clearGridDropHighlight();
    hideGridDropOverlay();
    // Restore free-placement stack z (was temporarily elevated while dragging)
    applyTileStackOrder();
    if (!didMove) {
      void selectTile(t.slotId, { edit: true });
      return;
    }
    if (mode === "grid" || !freeLayout) {
      // Place on any cell — empty leaves a blank spot; occupied swaps
      const { col, row } = gridCellFromPoint(clientX, clientY);
      const occ = occupiedCellMap(t.slotId);
      const otherId = occ.get(cellKey(col, row));
      placeWheelAtCell(t.slotId, col, row);
      applyGridLayout({ redraw: true });
      if (otherId) {
        setSummary(`Swapped to grid (${col + 1}, ${row + 1})`);
      } else {
        setSummary(`Moved to empty slot (${col + 1}, ${row + 1}) — blank spots OK`);
      }
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
    // Mouse drag / fling / grab-stop on the mini wheel (after DOM is live)
    enableTileWheelPointer(tile);
    // Apply live unlock/pointer angle from library
    syncTileLookFromLibrary(tile);
    try {
      wheel.layoutPointer?.();
    } catch {
      /* ignore */
    }

    requestAnimationFrame(() => {
      try {
        wheel.resize?.();
        wheel.draw();
        wheel.layoutPointer?.();
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
      // Keep board chrome; only remove tiles / empty / drop overlay
      g.querySelectorAll(
        ".multi-tile, .multi-grid-empty, #multi-grid-drop-layer"
      ).forEach((el) => {
        el.remove();
      });
      g.classList.remove("is-showing-drop-grid");
    }
  }

  async function refreshTileFromState(tile, rawState, name) {
    if (!tile || !rawState) return;
    if (tile.spinning || tile.wheel?.spinning) {
      // Apply after this spin finishes
      tile._pendingLiveState = deepClone(rawState);
      if (name != null) tile._pendingLiveName = name;
      return;
    }
    if (name != null) {
      tile.name = name || "Untitled";
      if (tile.rootEl) {
        tile.rootEl.title = `${tile.name} — click to edit · drag grip to move · fling wheel to spin`;
        const dragBtn = tile.rootEl.querySelector(".multi-tile-drag");
        if (dragBtn) {
          dragBtn.setAttribute(
            "aria-label",
            `Drag to move ${tile.name}`
          );
        }
      }
    }
    try {
      tile.state = hydrateState(deepClone(rawState));
      await tile.wheel.setLook(tile.state.look || {});
      await tile.wheel.setSections(getDisplaySections(tile.state));
      tile.wheel.resize?.();
      tile.wheel.draw();
    } catch (err) {
      console.warn("multi-spin tile refresh:", tile.name, err);
    }
  }

  async function refreshTileFromSlot(tile, slot) {
    if (!tile || !slot) return;
    await refreshTileFromState(tile, slot.data || {}, slot.name || "Untitled");
  }

  /**
   * Push live editor state into a multi-spin tile (after save / while editing).
   * @param {string} slotId
   * @param {object} liveState
   * @param {string} [name]
   */
  async function applyLiveState(slotId, liveState, name) {
    if (!active || !slotId || !liveState) return;
    const tile = tiles.get(slotId);
    if (!tile) return;
    await refreshTileFromState(tile, liveState, name);
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
      g.innerHTML = `<p class="multi-grid-empty">Select wheels on the left to show them here. In grid mode drag a wheel onto any slot — empty cells leave blank spots; drop on another wheel to swap. Free placement unlocks freeform drag.</p>`;
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
    applyTileStackOrder();
    updateFocusUi();
    setSummary(
      `${selectedIds.length} wheel${selectedIds.length === 1 ? "" : "s"} ready` +
        (freeLayout
          ? " · free placement (list order = stack: top of list is on top)"
          : " · grid")
    );
    renderPicker();
  }

  async function rebuildTiles() {
    destroyTiles();
    await syncTilesWithLibrary();
  }

  function clearTileResultCenter(tile) {
    if (!tile?.rootEl) return;
    if (tile._resultDismissTimer) {
      clearTimeout(tile._resultDismissTimer);
      tile._resultDismissTimer = 0;
    }
    const overlay = tile.rootEl.querySelector(".multi-tile-result-center");
    if (!overlay) return;
    overlay.classList.add("hidden");
    const bg = overlay.querySelector(".multi-tile-result-center-bg");
    if (bg) {
      bg.classList.remove("has-image");
      bg.style.backgroundImage = "";
      bg.innerHTML = "";
    }
    const noteEl = overlay.querySelector(".multi-tile-result-center-note");
    if (noteEl) {
      noteEl.hidden = true;
      noteEl.textContent = "";
    }
  }

  /** Live Look.autoDismissSec for a multi tile (library first). */
  function tileAutoDismissSec(tile) {
    let look = tile?.state?.look || {};
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      if (slot?.data?.look) look = { ...look, ...slot.data.look };
    } catch {
      /* tile look */
    }
    const n = Number(look.autoDismissSec);
    return Number.isFinite(n) ? n : 0;
  }

  /** Bump generation so a superseded spin/fling doesn't paint a late result. */
  function bumpTileSpinGen(tile) {
    if (!tile) return 0;
    tile._spinGen = (Number(tile._spinGen) || 0) + 1;
    return tile._spinGen;
  }

  /**
   * Always clear big-center / banner when a new spin or fling starts so the
   * wheel is visible (auto-dismiss timer is cancelled too).
   */
  function dismissTileResultForNewSpin(tile) {
    if (!tile?.rootEl) return;
    clearTileResultCenter(tile);
    const el = tile.rootEl.querySelector(".multi-tile-result");
    if (el) {
      el.textContent = "";
      el.classList.remove("has-win");
      el.hidden = true;
    }
    tile.lastWin = null;
  }

  /**
   * Big-center winner overlay inside this multi tile (Look → result style).
   */
  function showTileResultCenter(tile, win, note = "") {
    if (!tile?.rootEl || !win) return;
    const overlay = tile.rootEl.querySelector(".multi-tile-result-center");
    if (!overlay) return;

    if (tile._resultDismissTimer) {
      clearTimeout(tile._resultDismissTimer);
      tile._resultDismissTimer = 0;
    }

    let look = tile.state?.look || {};
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      if (slot?.data?.look) look = { ...look, ...slot.data.look };
    } catch {
      /* tile look */
    }

    // autoDismissSec === -1 → don't show overlay (same as main wheel)
    const autoSec = Number(look.autoDismissSec);
    if (Number.isFinite(autoSec) && autoSec === -1) {
      clearTileResultCenter(tile);
      return;
    }

    const st = tile.state || {};
    const raw =
      (st.sections || []).find((s) => s.id === win.id) || win;
    let disp = raw;
    try {
      disp = resolveSectionForDisplay(st, raw) || raw;
    } catch {
      disp = raw;
    }

    const label = win.label || win.name || disp?.label || "Winner";
    const winnerLabel =
      look.winnerLabel != null && String(look.winnerLabel).trim() !== ""
        ? String(look.winnerLabel)
        : "Winner";
    const winTextColor =
      look.forceWinnerTextColor === true
        ? look.winnerTextColor || look.textColor || "#ffffff"
        : disp?.winnerTextColor ||
          look.winnerTextColor ||
          look.textColor ||
          "#ffffff";
    const imageData = disp?.imageData || null;

    const titleEl = overlay.querySelector(".multi-tile-result-center-label");
    const textEl = overlay.querySelector(".multi-tile-result-center-text");
    const noteEl = overlay.querySelector(".multi-tile-result-center-note");
    const bg = overlay.querySelector(".multi-tile-result-center-bg");
    const inner = overlay.querySelector(".multi-tile-result-center-inner");

    if (titleEl) titleEl.textContent = winnerLabel;
    if (textEl) {
      textEl.textContent = label;
      textEl.style.color = winTextColor;
    }
    if (noteEl) {
      if (note) {
        noteEl.hidden = false;
        noteEl.textContent = note;
      } else {
        noteEl.hidden = true;
        noteEl.textContent = "";
      }
    }
    if (bg) {
      bg.innerHTML = "";
      bg.style.backgroundImage = "";
      if (imageData) {
        bg.classList.add("has-image");
        const img = document.createElement("img");
        img.src = imageData;
        img.alt = "";
        img.decoding = "async";
        bg.appendChild(img);
      } else {
        bg.classList.remove("has-image");
      }
    }
    if (inner) {
      inner.style.animation = "none";
      void inner.offsetWidth;
      inner.style.animation = "";
    }
    overlay.classList.remove("hidden");

    // Auto-dismiss (Look → Auto-dismiss seconds); 0 = stay until next spin
    if (Number.isFinite(autoSec) && autoSec > 0) {
      const ms = Math.min(99999, Math.max(1, Math.round(autoSec))) * 1000;
      tile._resultDismissTimer = setTimeout(() => {
        tile._resultDismissTimer = 0;
        clearTileResultCenter(tile);
      }, ms);
    }
  }

  function setTileResult(tile, win, note = "") {
    const el = tile.rootEl?.querySelector(".multi-tile-result");
    if (!el) return;

    if (!win) {
      el.textContent = note || "";
      el.classList.remove("has-win");
      el.hidden = !note;
      clearTileResultCenter(tile);
      return;
    }

    const label = win.label || win.name || "—";
    tile.lastWin = win;

    // Prefer live library look for result style
    let look = tile.state?.look || {};
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      if (slot?.data?.look) look = { ...look, ...slot.data.look };
    } catch {
      /* tile look */
    }
    const style = look.resultStyle === "banner" ? "banner" : "center";

    if (style === "center") {
      // Big center only — no bottom banner under the wheel in multi view
      showTileResultCenter(tile, win, note);
      el.textContent = "";
      el.classList.remove("has-win");
      el.hidden = true;
    } else {
      clearTileResultCenter(tile);
      el.textContent = note ? `Winner: ${label} ${note}` : `Winner: ${label}`;
      el.classList.add("has-win");
      el.hidden = false;
    }
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

  /**
   * Misc → replaceSourceOnOtherWheel for this board tile (library first).
   * Default on when unset: off-board targets take this wheel's place.
   */
  function tileReplacesOnOtherWheel(tile) {
    if (!tile) return true;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      const look = slot?.data?.look ?? tile.state?.look;
      if (
        look &&
        Object.prototype.hasOwnProperty.call(look, "replaceSourceOnOtherWheel")
      ) {
        return look.replaceSourceOnOtherWheel !== false;
      }
    } catch {
      /* ignore */
    }
    return tile.state?.look?.replaceSourceOnOtherWheel !== false;
  }

  /**
   * Bring a transfer target onto the multi board.
   * - Already on board → use existing tile
   * - Replace mode (default) → target inherits source layout/slot; source leaves after spin
   * - Add mode → ensureTileForSlot (extra tile; legacy)
   * @returns {Promise<{ tile: object|null, replaced: boolean }>}
   */
  async function bringTransferTarget(sourceTile, targetId) {
    if (!targetId) return { tile: null, replaced: false };
    if (tiles.has(targetId)) {
      return { tile: tiles.get(targetId), replaced: false };
    }

    const replace = tileReplacesOnOtherWheel(sourceTile);
    if (!replace) {
      const t = await ensureTileForSlot(targetId);
      return { tile: t, replaced: false };
    }

    const sourceId = sourceTile?.slotId;
    if (!sourceId) {
      const t = await ensureTileForSlot(targetId);
      return { tile: t, replaced: false };
    }

    const slot = librarySlots().find((w) => w.id === targetId);
    if (!slot) return { tile: null, replaced: false };

    // Copy layout so the target sits exactly where the source was
    const prev = layoutMap[sourceId] || {};
    const layoutCopy = { ...prev };
    const stackIdx = selectedIds.indexOf(sourceId);

    // Selection: drop source, insert target at same list/stack index
    selectedIds = selectedIds.filter((id) => id !== sourceId);
    if (!selectedIds.includes(targetId)) {
      const at = stackIdx >= 0 ? Math.min(stackIdx, selectedIds.length) : selectedIds.length;
      selectedIds.splice(at, 0, targetId);
    }
    saveSelection();

    layoutMap[targetId] = layoutCopy;
    saveLayout();

    const g = grid();
    g?.querySelector(".multi-grid-empty")?.remove();
    await buildTile(slot);

    const target = tiles.get(targetId) || null;
    if (target?.rootEl) {
      const pos = layoutMap[targetId] || layoutCopy;
      const size =
        Number.isFinite(pos.size) && pos.size > 0
          ? pos.size
          : tileSize(targetId);
      if (Number.isFinite(pos.x)) target.rootEl.style.left = `${pos.x}px`;
      if (Number.isFinite(pos.y)) target.rootEl.style.top = `${pos.y}px`;
      target.rootEl.style.width = `${size}px`;
      target.rootEl.style.minWidth = `${size}px`;
      try {
        target.wheel?.resize?.();
        target.wheel?.draw?.();
      } catch {
        /* ignore */
      }
      try {
        target.rootEl.scrollIntoView?.({
          behavior: "smooth",
          block: "nearest",
        });
      } catch {
        /* ignore */
      }
    }

    // Source leaves after its current spin finishes (still inside spinTile)
    sourceTile._removeAfterSpin = true;
    sourceTile.queue = [];
    updateQueueUi(sourceTile);
    if (sourceTile.rootEl) {
      sourceTile.rootEl.classList.add("is-transfer-out");
      sourceTile.rootEl.style.visibility = "hidden";
      sourceTile.rootEl.style.pointerEvents = "none";
    }

    if (!freeLayout) {
      applyGridLayout({ redraw: true });
    } else {
      updateBoardSize();
      applyTileStackOrder();
    }
    setWarn();
    renderPicker();
    updateFocusUi();

    return { tile: target, replaced: true };
  }

  function isTileBusy(tile) {
    return !!(tile && (tile.spinning || tile.wheel?.spinning));
  }

  /**
   * True when this tile has no spin in progress and no queued spins.
   * Being paused in “wait for other wheel” does NOT count as busy — so A↔B
   * portal loops with Wait on cannot deadlock each other.
   */
  function isTileSpinWorkIdle(tile) {
    if (!tile) return true;
    if (tile.spinning || tile.wheel?.spinning) return false;
    if (Array.isArray(tile.queue) && tile.queue.length > 0) return false;
    return true;
  }

  /** Busy or still has spins waiting (includes wait-for-other pause). */
  function isTileFullyIdle(tile) {
    if (!tile) return true;
    if (!isTileSpinWorkIdle(tile)) return false;
    if (tile._waitingForSlotId) return false;
    return true;
  }

  /**
   * Wait until a tile has finished its current spin work (and queue).
   * If a spin was just fired with void spinTile, give it a moment to set
   * spinning=true so we don't treat "not started yet" as already idle.
   */
  async function waitUntilTileSpinWorkIdle(tile, timeoutMs = 600000) {
    if (!tile) return;
    const start = Date.now();
    // Brief grace: wait until busy, or up to ~200ms, so a just-started spin counts
    let sawBusy = !isTileSpinWorkIdle(tile);
    const graceEnd = start + 200;
    while (!sawBusy && Date.now() < graceEnd) {
      if (tile._forceBreakWait) {
        tile._forceBreakWait = false;
        return;
      }
      await sleepMs(16);
      if (!isTileSpinWorkIdle(tile)) sawBusy = true;
    }
    while (!isTileSpinWorkIdle(tile)) {
      if (tile._forceBreakWait) {
        tile._forceBreakWait = false;
        return;
      }
      if (Date.now() - start > timeoutMs) break;
      await sleepMs(40);
    }
  }

  async function waitUntilTileFullyIdle(tile, timeoutMs = 600000) {
    if (!tile) return;
    const start = Date.now();
    while (!isTileFullyIdle(tile)) {
      if (tile._forceBreakWait) {
        tile._forceBreakWait = false;
        return;
      }
      if (Date.now() - start > timeoutMs) break;
      await sleepMs(40);
    }
  }

  /**
   * True if walking target's wait chain reaches sourceId (wait loop).
   */
  function waitChainReaches(startTile, sourceId) {
    if (!startTile || !sourceId) return false;
    let cur = startTile;
    const seen = new Set();
    while (cur && cur._waitingForSlotId) {
      if (cur._waitingForSlotId === sourceId) return true;
      if (seen.has(cur.slotId)) return true;
      seen.add(cur.slotId);
      cur = tiles.get(cur._waitingForSlotId);
    }
    return false;
  }

  /**
   * Wheel in the wait chain that waits for source (closes the cycle), or target.
   */
  function findWaitLoopCloser(sourceTile, targetTile) {
    if (!sourceTile || !targetTile) return targetTile || null;
    let cur = targetTile;
    const seen = new Set();
    while (cur && !seen.has(cur.slotId)) {
      seen.add(cur.slotId);
      if (cur._waitingForSlotId === sourceTile.slotId) return cur;
      if (!cur._waitingForSlotId) break;
      cur = tiles.get(cur._waitingForSlotId);
    }
    return targetTile;
  }

  /**
   * True if `tile` or anyone it is following-wait on still has spin work or a wait.
   * Used so Following wait doesn't finish until the whole chain settles.
   */
  function waitChainStillBusy(tile, depth = 0) {
    if (!tile || depth > 32) return false;
    if (!isTileSpinWorkIdle(tile)) return true;
    if (!tile._waitingForSlotId) return false;
    const next = tiles.get(tile._waitingForSlotId);
    if (!next) return false;
    return waitChainStillBusy(next, depth + 1);
  }

  /**
   * Wait for another wheel after a land transfer.
   * - Normal Wait: spin/queue idle only (target may still be “waiting” on someone).
   * - Following wait: also wait while target is waiting (and so on). If that would
   *   form a loop, force-spin the wheel that would close the loop and stop waiting.
   */
  async function waitForOtherWheelSmart(sourceTile, targetTile) {
    if (!sourceTile || !targetTile) return;
    // Live flags from library (sidebar toggles apply without re-entering multi)
    const follow = tileFollowsWait(sourceTile);
    sourceTile._waitingForSlotId = targetTile.slotId;
    try {
      await sleepMs(0);
      if (!follow) {
        await waitUntilTileSpinWorkIdle(targetTile);
        return;
      }

      // Following wait: target + its wait chain must be fully settled
      const start = Date.now();
      const timeoutMs = 600000;
      // Grace so a just-started spin is seen as busy
      let sawBusy = waitChainStillBusy(targetTile);
      const graceEnd = start + 280;
      while (!sawBusy && Date.now() < graceEnd) {
        if (sourceTile._forceBreakWait) {
          sourceTile._forceBreakWait = false;
          return;
        }
        await sleepMs(16);
        if (waitChainStillBusy(targetTile)) sawBusy = true;
      }

      while (Date.now() - start < timeoutMs) {
        if (sourceTile._forceBreakWait) {
          sourceTile._forceBreakWait = false;
          return;
        }

        // Loop: target (or its wait chain) is waiting for us
        if (waitChainReaches(targetTile, sourceTile.slotId)) {
          const kick = findWaitLoopCloser(sourceTile, targetTile);
          // Signal everyone in the chain to stop waiting
          let walk = targetTile;
          const seen = new Set();
          while (walk && !seen.has(walk.slotId)) {
            seen.add(walk.slotId);
            walk._forceBreakWait = true;
            if (!walk._waitingForSlotId) break;
            if (walk._waitingForSlotId === sourceTile.slotId) break;
            walk = tiles.get(walk._waitingForSlotId);
          }
          // Force-spin the wheel that would close the loop (waits for us), if idle
          if (
            kick &&
            kick.slotId !== sourceTile.slotId &&
            isTileSpinWorkIdle(kick) &&
            !isTileBusy(kick)
          ) {
            setSummary(
              `Following wait: loop broken — force spinning ${kick.name || "wheel"}`
            );
            setTileResult(
              sourceTile,
              sourceTile.lastWin,
              `wait loop → force ${kick.name || "wheel"}`
            );
            void requestSpin(kick, {
              silentLand: true,
              chainDepth: 0,
            });
            // Wait for that kick spin (and its queue) so the chain can progress
            await waitUntilTileSpinWorkIdle(kick, Math.min(120000, timeoutMs));
          } else {
            setSummary(
              `Following wait: loop broken — continuing ${sourceTile.name || "wheel"}`
            );
          }
          // Stop waiting so this wheel can continue (respin / queue)
          return;
        }

        // Done when target and everyone it was waiting on are spin-idle and not waiting
        if (!waitChainStillBusy(targetTile)) {
          return;
        }
        await sleepMs(40);
      }
    } finally {
      sourceTile._waitingForSlotId = null;
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
    const entry = {
      silentLand: opts.silentLand === true,
      chainDepth: Number(opts.chainDepth) || 0,
    };
    if (opts.spinDirection === 1 || opts.spinDirection === -1) {
      entry.spinDirection = opts.spinDirection;
    }
    tile.queue.push(entry);
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
    const spinOpts = {
      silentLand: next?.silentLand === true,
      chainDepth: Number(next?.chainDepth) || 0,
    };
    if (next?.spinDirection === 1 || next?.spinDirection === -1) {
      spinOpts.spinDirection = next.spinDirection;
    }
    await spinTile(tile, spinOpts);
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

  /**
   * Live Misc → followWait (following wait). Default off.
   */
  function tileFollowsWait(tile) {
    if (!tile) return false;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      const look = slot?.data?.look ?? tile.state?.look;
      if (look && Object.prototype.hasOwnProperty.call(look, "followWait")) {
        return look.followWait === true;
      }
    } catch {
      /* ignore */
    }
    return tile.state?.look?.followWait === true;
  }

  async function handleMultiLandAction(tile, win, chainDepth) {
    // No max chain depth — multi land actions (respin / other wheel) may loop
    // intentionally forever; users stop via Clear queues or leaving multi.
    if (!tile || !win) return false;

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
    const timesOther = Math.min(
      99,
      Math.max(1, Number(eff.landActionTimesOther) || times)
    );
    const nextOpts = {
      silentLand: true,
      chainDepth: chainDepth + 1,
      awaitRun: false,
    };

    /**
     * Start/queue spins without awaiting (so Wait off can continue).
     * First spin starts if idle; the rest always enqueue (avoids racing busy).
     * @param {object} targetTile
     * @param {number} [count]
     * @returns {{ queued: number, started: number }}
     */
    function fireTimes(targetTile, count = times) {
      const n = Math.min(99, Math.max(1, Number(count) || 1));
      let queued = 0;
      let started = 0;
      for (let i = 0; i < n; i++) {
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
      await sleepMs(waitMs);
      // Off-board target: replace this tile in place (default) or add as extra
      const { tile: target, replaced } = await bringTransferTarget(tile, tid);
      if (!target) {
        setTileResult(tile, win, "→ (wheel not found)");
        return false;
      }
      const tName = target.name || "wheel";
      if (replaced) {
        setTileResult(
          tile,
          win,
          times > 1
            ? `→ ${tName} ×${times} (replaced)`
            : `→ ${tName} (replaced)`
        );
      } else {
        setTileResult(
          tile,
          win,
          times > 1 ? `→ ${tName} ×${times}` : `→ ${tName}`
        );
      }
      const { queued, started } = fireTimes(target);
      // Waiting only makes sense if this wheel stays on the board
      const waitOther = !replaced && tileWaitsForOtherWheel(tile);
      if (waitOther) {
        setTileResult(
          tile,
          win,
          `→ ${tName}${times > 1 ? ` ×${times}` : ""} (waiting…)`
        );
        await waitForOtherWheelSmart(tile, target);
        setTileResult(
          tile,
          win,
          `→ ${tName}${times > 1 ? ` ×${times}` : ""} (done)`
        );
      } else if (!replaced) {
        const n = target.queue?.length || 0;
        if (queued > 0 || started > 0) {
          setTileResult(
            tile,
            win,
            n > 0
              ? `→ ${tName}${times > 1 ? ` ×${times}` : ""} (queued · ${n})`
              : `→ ${tName}${times > 1 ? ` ×${times}` : ""}`
          );
        }
      }
      return true;
    }

    // Respin this wheel AND spin a different wheel (this wheel stays on the board)
    if (action === "respinAndOther") {
      const respinN = times;
      const otherN = timesOther;
      const tid = eff.landTargetWheelId;
      if (!tid) {
        // No target → plain respin
        setTileResult(
          tile,
          win,
          respinN > 1 ? `→ respin ×${respinN}…` : "→ respin…"
        );
        await sleepMs(waitMs);
        fireTimes(tile, respinN);
        return true;
      }
      if (tid === tile.slotId) {
        setTileResult(
          tile,
          win,
          respinN > 1 ? `→ respin ×${respinN}…` : "→ respin…"
        );
        await sleepMs(waitMs);
        fireTimes(tile, respinN);
        return true;
      }
      await sleepMs(waitMs);
      // Always keep this wheel: add target if missing (never replace source away)
      let target = tiles.has(tid) ? tiles.get(tid) : null;
      if (!target) {
        target = await ensureTileForSlot(tid);
      }
      if (!target) {
        setTileResult(tile, win, "→ (wheel not found) · respin only");
        fireTimes(tile, respinN);
        return true;
      }
      const tName = target.name || "wheel";
      const waitOther = tileWaitsForOtherWheel(tile);

      if (waitOther) {
        // Wait on: spin the other wheel first, then respin this one after it finishes
        setTileResult(
          tile,
          win,
          `→ ${tName}×${otherN} (waiting…) · then ↻×${respinN}`
        );
        fireTimes(target, otherN);
        await waitForOtherWheelSmart(tile, target);
        setTileResult(
          tile,
          win,
          `→ ${tName} done · ↻×${respinN}`
        );
        fireTimes(tile, respinN);
      } else {
        // Wait off: both can run / queue in parallel
        setTileResult(
          tile,
          win,
          `↻×${respinN} + → ${tName}×${otherN}`
        );
        fireTimes(target, otherN);
        fireTimes(tile, respinN);
      }
      return true;
    }

    return false;
  }

  /**
   * Fisher–Yates shuffle of a section array (new array).
   * @param {object[]} list
   */
  function shuffleSectionsArray(list) {
    const arr = (list || []).slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Misc → shuffle every spin on this multi tile: re-randomize section order
   * and refresh the mini wheel geometry before the spin starts.
   */
  async function maybeShuffleTileSections(tile) {
    if (!tile?.state) return false;
    let on = tile.state.look?.shuffleEverySpin === true;
    try {
      const slot = librarySlots().find((w) => w.id === tile.slotId);
      if (slot?.data?.look) {
        on = slot.data.look.shuffleEverySpin === true;
        // Keep tile look in sync
        tile.state.look = {
          ...(tile.state.look || {}),
          shuffleEverySpin: on,
        };
      }
    } catch {
      /* use tile look */
    }
    if (!on) return false;
    const secs = tile.state.sections;
    if (!Array.isArray(secs) || secs.length < 2) return false;
    tile.state.sections = shuffleSectionsArray(secs);
    try {
      await tile.wheel?.setSections?.(getDisplaySections(tile.state));
      tile.wheel?.resize?.();
      tile.wheel?.draw?.();
    } catch (err) {
      console.warn("multi-spin shuffle sections:", tile.name, err);
    }
    return true;
  }

  /**
   * History + win effect for a multi land (no land-action wait).
   */
  async function recordTileWinAndEffect(tile, win, opts = {}) {
    const rigged = opts.rigged === true;
    if (!win) return;
    setTileResult(tile, win);
    try {
      let trackHistory = tile.state?.look?.trackHistory !== false;
      try {
        const slot = librarySlots().find((w) => w.id === tile.slotId);
        if (slot?.data?.look) {
          trackHistory = slot.data.look.trackHistory !== false;
        }
      } catch {
        /* use tile look */
      }
      deps.onSpinHistory?.(win, {
        wheelId: tile.slotId,
        wheelName: tile.name || "Wheel",
        trackHistory,
        source: "multi-spin",
        rigged,
      });
    } catch (err) {
      console.warn("multi-spin history:", err);
    }
    try {
      const stageEl =
        tile.rootEl?.querySelector?.(".multi-tile-stage") || null;
      let effectState = tile.state;
      try {
        const slot = librarySlots().find((w) => w.id === tile.slotId);
        if (slot?.data) effectState = slot.data;
      } catch {
        /* tile.state */
      }
      deps.playWinEffect?.(win, {
        container: stageEl,
        state: effectState,
      });
    } catch (err) {
      console.warn("multi-spin win effect:", err);
    }
  }

  /**
   * After the physical spin ends: clear busy flag, then land actions / queue.
   * Clearing busy before wait-for-other lets A↔B loops keep running.
   * @param {{ silentLand?: boolean, chainDepth?: number, rigged?: boolean, spinGen?: number }} [opts]
   */
  async function afterTileSpin(tile, win, opts = {}) {
    const silentLand = opts.silentLand === true;
    const chainDepth = Number(opts.chainDepth) || 0;
    const rigged = opts.rigged === true;
    const spinGen = opts.spinGen;

    // Superseded by a newer spin/fling/grab — do not paint big-center over it
    if (
      spinGen != null &&
      Number(spinGen) !== Number(tile._spinGen || 0)
    ) {
      return;
    }

    // Spin animation finished — free the tile so portals can target it
    tile.spinning = false;
    tile.rootEl?.classList.remove("is-spinning");

    if (win) {
      // Re-check: land wait can yield and a new spin may have started
      if (
        spinGen != null &&
        Number(spinGen) !== Number(tile._spinGen || 0)
      ) {
        return;
      }
      await recordTileWinAndEffect(tile, win, { rigged });
      if (
        spinGen != null &&
        Number(spinGen) !== Number(tile._spinGen || 0)
      ) {
        return;
      }
      // Land actions may wait for another wheel (spin-work idle only)
      await handleMultiLandAction(tile, win, chainDepth);
      if (!silentLand && chainDepth === 0) {
        playLandOnce();
      }
    }

    if (tile._removeAfterSpin) {
      tile.queue = [];
      const sid = tile.slotId;
      destroyOneTile(tile);
      if (selectedIds.includes(sid)) {
        selectedIds = selectedIds.filter((id) => id !== sid);
        saveSelection();
      }
      if (focusedSlotId === sid) focusedSlotId = null;
      renderPicker();
      setWarn();
      updateFocusUi();
      if (!freeLayout) applyGridLayout({ redraw: false });
      else {
        updateBoardSize();
        applyTileStackOrder();
      }
      return;
    }

    if (tile._pendingLiveState) {
      const pending = tile._pendingLiveState;
      const pendingName = tile._pendingLiveName;
      tile._pendingLiveState = null;
      tile._pendingLiveName = null;
      void refreshTileFromState(tile, pending, pendingName);
    }
    if (tile._holdQueueForDrag || tile.wheel?._dragging) {
      return;
    }
    void drainQueue(tile);
  }

  /**
   * Run one timed spin now. Does not wait for busy wheels — use requestSpin to queue.
   * @param {object} tile
   * @param {{ silentLand?: boolean, chainDepth?: number, spinDirection?: 1|-1 }} [opts]
   */
  async function spinTile(tile, opts = {}) {
    const silentLand = opts.silentLand === true;
    const chainDepth = Number(opts.chainDepth) || 0;
    if (!tile) return null;

    // Never block on another spin here — busy → caller should queue
    if (isTileBusy(tile)) return null;
    if (tile.wheel?._dragging) return null;

    const activeSecs = getActiveSections(tile.state);
    if (!activeSecs.length) {
      const el = tile.rootEl?.querySelector(".multi-tile-result");
      if (el) {
        el.textContent = "No active sections";
        el.classList.remove("has-win");
        el.hidden = false;
      }
      return null;
    }

    // Push sidebar edits (section order, etc.) if this is the wheel being edited
    try {
      deps.onBeforeTileSpin?.(tile.slotId);
    } catch {
      /* ignore */
    }

    const spinGen = bumpTileSpinGen(tile);
    tile.spinning = true;
    tile.rootEl?.classList.add("is-spinning");
    // Always clear big-center / banner so the spin is visible (incl. respin)
    dismissTileResultForNewSpin(tile);
    let win = null;
    try {
      deps.audio?.ensure?.();
      await maybeShuffleTileSections(tile);
      const dur = durationFor(tile);
      const spinOpts = {
        maxSpeedScale: maxSpeedScaleForTile(tile),
      };
      if (opts.spinDirection === 1 || opts.spinDirection === -1) {
        spinOpts.spinDirection = opts.spinDirection;
      }
      win = await tile.wheel.spin(dur, spinOpts);
    } catch (err) {
      console.error("multi-spin tile failed:", tile.name, err);
      try {
        tile.wheel?.cancelAnimatedSpin?.();
      } catch {
        /* ignore */
      }
      win = null;
    }
    // Land actions / wait / queue after spinning flag is cleared
    await afterTileSpin(tile, win, {
      silentLand,
      chainDepth,
      rigged: false,
      spinGen,
    });
    return win;
  }

  /**
   * Momentum fling from a mouse/touch flick on a multi tile.
   * @param {object} tile
   * @param {number} velocityRadPerSec
   * @param {{ silentLand?: boolean, chainDepth?: number }} [opts]
   */
  async function flingTile(tile, velocityRadPerSec, opts = {}) {
    const silentLand = opts.silentLand === true;
    const chainDepth = Number(opts.chainDepth) || 0;
    if (!tile) return null;
    if (isTileBusy(tile) || tile.wheel?._dragging) return null;

    const activeSecs = getActiveSections(tile.state);
    if (!activeSecs.length) return null;

    try {
      deps.onBeforeTileSpin?.(tile.slotId);
    } catch {
      /* ignore */
    }

    const spinGen = bumpTileSpinGen(tile);
    tile.spinning = true;
    tile.rootEl?.classList.add("is-spinning");
    dismissTileResultForNewSpin(tile);
    let win = null;
    try {
      deps.audio?.ensure?.();
      await maybeShuffleTileSections(tile);
      win = await tile.wheel.fling(velocityRadPerSec, {
        maxSpeedScale: maxSpeedScaleForTile(tile),
      });
    } catch (err) {
      console.error("multi-spin fling failed:", tile.name, err);
      try {
        tile.wheel?.cancelAnimatedSpin?.();
      } catch {
        /* ignore */
      }
      win = null;
    }
    await afterTileSpin(tile, win, {
      silentLand,
      chainDepth,
      rigged: true,
      spinGen,
    });
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
    // Narrow screens: collapse the wheels list so the board + editor tabs fit.
    // Session-only (don't persist) so desktop keep their expanded preference.
    try {
      if (
        typeof window !== "undefined" &&
        window.matchMedia?.("(max-width: 720px)")?.matches &&
        !pickerCollapsed
      ) {
        pickerCollapsed = true;
      }
    } catch {
      /* ignore */
    }
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
        // Second frame: mobile split layout settles after CSS grid rows apply
        requestAnimationFrame(() => scheduleBoardReflow());
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
    // Keep existing on-screen order; append any newly selected at the end (front)
    const slots = librarySlots();
    const have = new Set(selectedIds);
    const next = selectedIds.filter((id) => slots.some((w) => w.id === id));
    for (const w of slots) {
      if (!have.has(w.id)) next.push(w.id);
    }
    selectedIds = next;
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

  /**
   * Multi board session for library Backup/Restore (keeps real wheel ids).
   * When open + has on-screen wheels, restore can re-enter multi view.
   * @returns {null | {
   *   open: boolean,
   *   freeLayout: boolean,
   *   dragLocked: boolean,
   *   sharedGridSize: number|null,
   *   selectedIds: string[],
   *   layout: Record<string, object>,
   * }}
   */
  function getBackupMultiState() {
    if (!active || !selectedIds.length) return null;
    const layout = {};
    for (const id of selectedIds) {
      const L = layoutMap[id];
      if (!L || typeof L !== "object") continue;
      const entry = {};
      if (Number.isFinite(L.x)) entry.x = L.x;
      if (Number.isFinite(L.y)) entry.y = L.y;
      if (Number.isFinite(L.col)) entry.col = L.col;
      if (Number.isFinite(L.row)) entry.row = L.row;
      if (Number.isFinite(L.size)) entry.size = L.size;
      if (L.customSize === true) entry.customSize = true;
      layout[id] = entry;
    }
    return {
      open: true,
      freeLayout: !!freeLayout,
      dragLocked: !!dragLocked,
      sharedGridSize:
        sharedGridSize != null && Number.isFinite(sharedGridSize)
          ? sharedGridSize
          : null,
      selectedIds: selectedIds.slice(),
      layout,
    };
  }

  /**
   * Snapshot of everything currently visible on the multi board (for Share).
   * Wheels are listed in stack/on-screen order with per-wheel layout.
   * @returns {null | {
   *   freeLayout: boolean,
   *   dragLocked: boolean,
   *   sharedGridSize: number|null,
   *   wheels: { name: string, data: object, layout: object }[]
   * }}
   */
  function getShareSnapshot() {
    if (!active) return null;
    const slots = librarySlots();
    const wheels = [];
    for (const id of selectedIds) {
      const slot = slots.find((w) => w.id === id);
      if (!slot) continue;
      const tile = tiles.get(id);
      let data = tile?.state || slot.data;
      try {
        data = JSON.parse(JSON.stringify(data));
      } catch {
        data = slot.data;
      }
      const L = layoutMap[id] || {};
      const layout = {};
      if (Number.isFinite(L.x)) layout.x = L.x;
      if (Number.isFinite(L.y)) layout.y = L.y;
      if (Number.isFinite(L.col)) layout.col = L.col;
      if (Number.isFinite(L.row)) layout.row = L.row;
      if (Number.isFinite(L.size)) layout.size = L.size;
      if (L.customSize === true) layout.customSize = true;
      wheels.push({
        name: (tile?.name || slot.name || "Wheel").trim() || "Wheel",
        data,
        layout,
      });
    }
    if (!wheels.length) return null;
    return {
      freeLayout: !!freeLayout,
      dragLocked: !!dragLocked,
      sharedGridSize:
        sharedGridSize != null && Number.isFinite(sharedGridSize)
          ? sharedGridSize
          : null,
      wheels,
    };
  }

  /**
   * Apply a shared multi board: set selection/layout/mode then open multi view.
   * Caller must have already added the wheels to the library and pass new ids
   * in stack order with layout keyed by those new ids.
   * @param {{
   *   selectedIds: string[],
   *   layout: Record<string, object>,
   *   freeLayout?: boolean,
   *   dragLocked?: boolean,
   *   sharedGridSize?: number|null,
   * }} cfg
   */
  function applyShareImport(cfg) {
    const ids = Array.isArray(cfg?.selectedIds)
      ? cfg.selectedIds.map(String).filter(Boolean)
      : [];
    if (!ids.length) {
      throw new Error("Multi share has no wheels to show");
    }
    selectedIds = ids;
    saveSelection();

    const nextLayout = {};
    const src = cfg?.layout && typeof cfg.layout === "object" ? cfg.layout : {};
    for (const id of ids) {
      const L = src[id];
      if (L && typeof L === "object") {
        nextLayout[id] = { ...L };
      }
    }
    layoutMap = { ...layoutMap, ...nextLayout };
    saveLayout();

    freeLayout = cfg?.freeLayout === true;
    saveFreeLayout();
    dragLocked = cfg?.dragLocked === true;
    saveDragLock();
    if (
      cfg?.sharedGridSize != null &&
      Number.isFinite(Number(cfg.sharedGridSize))
    ) {
      sharedGridSize = clampSize(Number(cfg.sharedGridSize));
    } else {
      sharedGridSize = null;
    }
    saveSharedGridSize();

    if (lockChk()) lockChk().checked = dragLocked;
    if (freeLayoutChk()) freeLayoutChk().checked = freeLayout;

    if (!active) enter();
    else {
      applyDragLockUi();
      applyLayoutModeUi();
      void syncTilesWithLibrary();
    }
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
    applyLiveState,
    pushLookToTile,
    getShareSnapshot,
    getBackupMultiState,
    applyShareImport,
  };
}
