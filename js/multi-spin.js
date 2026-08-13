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
const SOFT_WARN_AT = 12;
const MAX_LAND_CHAIN = 20;
const TILE_W = 280;
const TILE_GAP = 16;

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
  /** @type {Record<string, { x: number, y: number }>} */
  let layoutMap = loadLayout();
  let dragLocked = loadDragLock();
  let pickerCollapsed = loadPickerCollapsed();
  /** @type {string|null} */
  let focusedSlotId = null;
  /** @type {Map<string, object>} */
  const tiles = new Map();
  let spinAllBusy = false;
  /** Bumped on each Spin all so in-flight chains from a prior run abort. */
  let spinGen = 0;
  let lastTickAudioAt = 0;

  /** @type {null | { tile: object, pointerId: number, grabX: number, grabY: number, startX: number, startY: number, moved: boolean }} */
  let drag = null;

  const root = () => document.getElementById("multi-root");
  const grid = () => document.getElementById("multi-grid");
  const pickerList = () => document.getElementById("multi-picker-list");
  const summaryEl = () => document.getElementById("multi-summary");
  const warnEl = () => document.getElementById("multi-warn");
  const stageEl = () => document.getElementById("stage");
  const btnToggle = () => document.getElementById("btn-multi-spin");
  const lockChk = () => document.getElementById("chk-multi-drag-lock");

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

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return {};
      /** @type {Record<string, { x: number, y: number }>} */
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const x = Number(v?.x);
        const y = Number(v?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out[k] = { x: Math.max(0, x), y: Math.max(0, y) };
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

  function defaultPosForIndex(i) {
    const g = grid();
    const wrapW = Math.max(TILE_W + 40, g?.clientWidth || 600);
    const cols = Math.max(1, Math.floor((wrapW + TILE_GAP) / (TILE_W + TILE_GAP)));
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: col * (TILE_W + TILE_GAP),
      y: row * (TILE_W + 88 + TILE_GAP),
    };
  }

  function ensureLayoutFor(slotId, indexHint = 0) {
    if (layoutMap[slotId] && Number.isFinite(layoutMap[slotId].x)) {
      return layoutMap[slotId];
    }
    const pos = defaultPosForIndex(indexHint);
    layoutMap[slotId] = pos;
    return pos;
  }

  function applyTilePosition(tile) {
    if (!tile?.rootEl) return;
    const idx = selectedIds.indexOf(tile.slotId);
    const pos = ensureLayoutFor(tile.slotId, Math.max(0, idx));
    tile.rootEl.style.left = `${pos.x}px`;
    tile.rootEl.style.top = `${pos.y}px`;
    tile.rootEl.style.width = `${TILE_W}px`;
  }

  function updateBoardSize() {
    const g = grid();
    if (!g) return;
    let maxR = 200;
    let maxB = 200;
    for (const id of selectedIds) {
      const pos = layoutMap[id] || { x: 0, y: 0 };
      maxR = Math.max(maxR, pos.x + TILE_W + 24);
      maxB = Math.max(maxB, pos.y + TILE_W + 100);
    }
    g.style.minHeight = `${maxB}px`;
    g.style.minWidth = `${maxR}px`;
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
          : "Drag to move this wheel";
      }
    }
  }

  function updateFocusUi() {
    const focus =
      focusedSlotId || activeLibraryId() || selectedIds[0] || null;
    for (const t of tiles.values()) {
      const on = t.slotId === focus;
      t.rootEl?.classList.toggle("is-selected", on);
      t.rootEl?.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  async function selectTile(slotId, { edit = false } = {}) {
    if (!slotId) return;
    focusedSlotId = slotId;
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
    const focus = focusedSlotId || activeLibraryId();
    list.innerHTML = "";
    if (!slots.length) {
      list.innerHTML = `<p class="multi-picker-empty">No saved wheels.</p>`;
      return;
    }
    for (const w of slots) {
      const row = document.createElement("div");
      row.className =
        "multi-picker-row" + (w.id === focus ? " is-focused" : "");
      row.dataset.slotId = w.id;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = idSet.has(w.id);
      cb.title = "Show on multi-spin board";
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

      const span = document.createElement("span");
      span.className = "multi-picker-name";
      span.textContent = w.name || "Untitled";
      span.title = "Click to select / edit this wheel";

      row.appendChild(cb);
      row.appendChild(span);
      row.addEventListener("click", (e) => {
        if (e.target === cb) return;
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
        <button type="button" class="btn small ghost multi-tile-dup" title="Duplicate this wheel">Dup</button>
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

    rootEl.querySelector(".multi-tile-dup")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void duplicateSlot(tile.slotId);
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
      drag = {
        tile,
        pointerId: e.pointerId,
        grabX: e.clientX,
        grabY: e.clientY,
        startX: pos.x,
        startY: pos.y,
        moved: false,
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      rootEl.classList.add("is-dragging");
      rootEl.style.zIndex = "20";
    });
  }

  function onDragPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.grabX;
    const dy = e.clientY - drag.grabY;
    if (!drag.moved && dx * dx + dy * dy < 9) return;
    drag.moved = true;
    const x = Math.max(0, drag.startX + dx);
    const y = Math.max(0, drag.startY + dy);
    layoutMap[drag.tile.slotId] = { x, y };
    applyTilePosition(drag.tile);
    updateBoardSize();
  }

  function onDragPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const t = drag.tile;
    const didMove = drag.moved;
    drag = null;
    t.rootEl?.classList.remove("is-dragging");
    t.rootEl.style.zIndex = "";
    if (didMove) {
      saveLayout();
      updateBoardSize();
    } else {
      // Treat as select if barely moved
      void selectTile(t.slotId, { edit: false });
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
    if (g) g.innerHTML = "";
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
      g.innerHTML = `<p class="multi-grid-empty">Select wheels on the left to show them here. Drag the grip to place them; lock positions in the toolbar.</p>`;
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

    for (const t of tiles.values()) applyTilePosition(t);
    updateBoardSize();
    applyDragLockUi();
    updateFocusUi();
    setSummary(
      `${selectedIds.length} wheel${selectedIds.length === 1 ? "" : "s"} ready`
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

  /**
   * Request a spin: run now if idle, else add to this wheel's queue.
   * @returns {Promise<object|null>|"queued"}
   */
  async function requestSpin(tile, opts = {}) {
    if (!tile) return null;
    if (isTileBusy(tile)) {
      enqueueSpin(tile, opts);
      return "queued";
    }
    return spinTile(tile, opts);
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

  async function handleMultiLandAction(tile, win, chainDepth) {
    if (!tile || !win || chainDepth >= MAX_LAND_CHAIN) return false;

    const raw =
      (tile.state?.sections || []).find((s) => s.id === win.id) || win;
    const eff = getEffectiveLandAction(tile.state, raw);
    const action = normalizeLandAction(eff.landAction);
    if (action === "none") return false;

    const showMs = landShowResultMs(
      eff.landShowResultEvery,
      eff.landShowResultUnit
    );
    const waitMs = showMs > 0 ? showMs : 400;
    const nextOpts = {
      silentLand: true,
      chainDepth: chainDepth + 1,
    };

    if (action === "respin") {
      setTileResult(tile, win, "→ respin…");
      await sleepMs(waitMs);
      // Queue if still finishing this spin / already busy — runs after
      const r = await requestSpin(tile, nextOpts);
      if (r === "queued") {
        setTileResult(tile, win, `→ respin (queued · ${tile.queue.length})`);
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
        setTileResult(tile, win, "→ respin…");
        await sleepMs(waitMs);
        const r = await requestSpin(tile, nextOpts);
        if (r === "queued") {
          setTileResult(tile, win, `→ respin (queued · ${tile.queue.length})`);
        }
        return true;
      }
      const target = await ensureTileForSlot(tid);
      if (!target) {
        setTileResult(tile, win, "→ (wheel not found)");
        return false;
      }
      setTileResult(tile, win, `→ ${target.name}`);
      await sleepMs(waitMs);
      const r = await requestSpin(target, nextOpts);
      if (r === "queued") {
        const n = target.queue?.length || 0;
        setTileResult(tile, win, `→ ${target.name} (queued · ${n})`);
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
    renderPicker();
    void syncTilesWithLibrary().then(() => {
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
      .getElementById("btn-multi-duplicate")
      ?.addEventListener("click", () => {
        void duplicateSlot();
      });

    lockChk()?.addEventListener("change", () => {
      dragLocked = lockChk().checked === true;
      saveDragLock();
      applyDragLockUi();
    });
    if (lockChk()) lockChk().checked = dragLocked;

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
    bindUi,
    onLibraryChanged,
    rebuildTiles,
    getFocusedSlotId: () => focusedSlotId,
    selectTile,
  };
}
