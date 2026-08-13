/**
 * Multi-spin mode: show several saved library wheels on one screen and spin them together.
 * Display-only for results (does not eliminate/hide sections on land).
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
const SOFT_WARN_AT = 12;
/** Cap respin / other-wheel chains in multi view (matches single-wheel safety). */
const MAX_LAND_CHAIN = 20;

/**
 * @param {object} deps
 * @param {() => { wheels: { id: string, name: string, data: object }[] }} deps.getLibrary
 * @param {{ ensure: Function, playTick: Function, playOneShot: Function, buffers: Map }} deps.audio
 * @param {() => object} deps.getSound
 * @param {(n: number) => number} deps.clampSpinDuration
 * @param {(vol: number) => void} [deps.playGlobalLandSfx]
 * @param {() => string} [deps.getSpinTickPreset]
 * @param {() => void} [deps.onEnter]
 * @param {() => void} [deps.onExit]
 */
export function createMultiSpinController(deps) {
  let active = false;
  /** @type {string[]} */
  let selectedIds = loadSelection();
  /** @type {Map<string, object>} */
  const tiles = new Map();
  let spinAllBusy = false;
  let lastTickAudioAt = 0;

  const root = () => document.getElementById("multi-root");
  const grid = () => document.getElementById("multi-grid");
  const pickerList = () => document.getElementById("multi-picker-list");
  const summaryEl = () => document.getElementById("multi-summary");
  const warnEl = () => document.getElementById("multi-warn");
  const stageEl = () => document.getElementById("stage");
  const btnToggle = () => document.getElementById("btn-multi-spin");

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

  function renderPicker() {
    const list = pickerList();
    if (!list) return;
    const slots = librarySlots();
    const idSet = new Set(selectedIds);
    selectedIds = selectedIds.filter((id) => slots.some((w) => w.id === id));
    list.innerHTML = "";
    if (!slots.length) {
      list.innerHTML = `<p class="multi-picker-empty">No saved wheels.</p>`;
      return;
    }
    for (const w of slots) {
      const label = document.createElement("label");
      label.className = "multi-picker-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = idSet.has(w.id);
      cb.dataset.slotId = w.id;
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!selectedIds.includes(w.id)) selectedIds.push(w.id);
        } else {
          selectedIds = selectedIds.filter((id) => id !== w.id);
        }
        saveSelection();
        setWarn();
        void rebuildTiles();
      });
      const span = document.createElement("span");
      span.className = "multi-picker-name";
      span.textContent = w.name || "Untitled";
      label.appendChild(cb);
      label.appendChild(span);
      list.appendChild(label);
    }
    setWarn();
  }

  function createTileDom(slot) {
    const el = document.createElement("article");
    el.className = "multi-tile";
    el.dataset.slotId = slot.id;
    el.innerHTML = `
      <div class="multi-tile-head">
        <span class="multi-tile-name"></span>
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
    `;
    el.querySelector(".multi-tile-name").textContent = slot.name || "Untitled";
    return el;
  }

  async function buildTile(slot) {
    const g = grid();
    if (!g) return null;
    const rootEl = createTileDom(slot);
    g.appendChild(rootEl);

    const stage = rootEl.querySelector(".multi-tile-stage");
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
    };

    rootEl.querySelector(".multi-tile-spin")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void spinTile(tile);
    });

    stage?.addEventListener("dblclick", (e) => {
      e.preventDefault();
      void spinTile(tile);
    });

    tiles.set(slot.id, tile);

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

  function destroyTiles() {
    for (const t of tiles.values()) {
      try {
        t.wheel?.cancelAnimatedSpin?.();
      } catch {
        /* ignore */
      }
      try {
        t.wheel?.destroy?.();
      } catch {
        /* ignore */
      }
      t.rootEl?.remove();
    }
    tiles.clear();
    const g = grid();
    if (g) g.innerHTML = "";
  }

  async function rebuildTiles() {
    destroyTiles();
    const g = grid();
    if (!g) return;
    const slots = librarySlots();
    const ordered = selectedIds
      .map((id) => slots.find((w) => w.id === id))
      .filter(Boolean);

    if (!ordered.length) {
      g.innerHTML = `<p class="multi-grid-empty">Select wheels on the left to show them here.</p>`;
      setSummary("");
      return;
    }

    g.innerHTML = "";
    for (const slot of ordered) {
      await buildTile(slot);
    }
    setSummary(
      `${ordered.length} wheel${ordered.length === 1 ? "" : "s"} ready`
    );
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

  /** Wait until a tile is free (e.g. target still finishing Spin all). */
  async function waitUntilIdle(tile, timeoutMs = 120000) {
    if (!tile) return;
    const start = Date.now();
    while (tile.spinning || tile.wheel?.spinning) {
      if (Date.now() - start > timeoutMs) break;
      await sleepMs(40);
    }
  }

  /**
   * Ensure the library wheel is on the multi grid (add + build if needed).
   * Used when land action portals to another wheel.
   */
  async function ensureTileForSlot(slotId) {
    if (!slotId) return null;
    if (tiles.has(slotId)) return tiles.get(slotId);
    const slot = librarySlots().find((w) => w.id === slotId);
    if (!slot) return null;
    if (!selectedIds.includes(slotId)) {
      selectedIds.push(slotId);
      saveSelection();
      renderPicker();
    }
    const g = grid();
    if (g?.querySelector(".multi-grid-empty")) g.innerHTML = "";
    await buildTile(slot);
    setWarn();
    const tile = tiles.get(slotId) || null;
    try {
      tile?.rootEl?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    } catch {
      /* ignore */
    }
    return tile;
  }

  /**
   * After a multi-spin land: respin same tile or spin target wheel tile.
   * @returns {boolean} true if a chain was started
   */
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

    if (action === "respin") {
      setTileResult(tile, win, "→ respin…");
      await sleepMs(waitMs);
      await spinTile(tile, {
        silentLand: true,
        chainDepth: chainDepth + 1,
      });
      return true;
    }

    if (action === "otherWheel") {
      const tid = eff.landTargetWheelId;
      if (!tid) {
        setTileResult(tile, win, "→ (no target wheel)");
        return false;
      }
      if (tid === tile.slotId) {
        // Target is self — treat as respin
        setTileResult(tile, win, "→ respin…");
        await sleepMs(waitMs);
        await spinTile(tile, {
          silentLand: true,
          chainDepth: chainDepth + 1,
        });
        return true;
      }
      const target = await ensureTileForSlot(tid);
      if (!target) {
        setTileResult(tile, win, "→ (wheel not found)");
        return false;
      }
      setTileResult(tile, win, `→ ${target.name}`);
      await sleepMs(waitMs);
      await spinTile(target, {
        silentLand: true,
        chainDepth: chainDepth + 1,
      });
      return true;
    }

    return false;
  }

  /**
   * @param {object} tile
   * @param {{ silentLand?: boolean, chainDepth?: number }} [opts]
   */
  async function spinTile(tile, opts = {}) {
    const silentLand = opts.silentLand === true;
    const chainDepth = Number(opts.chainDepth) || 0;
    if (!tile) return null;

    // Portal / Spin all may hit a tile that is still spinning
    await waitUntilIdle(tile);
    if (tile.spinning || tile.wheel?.spinning) return null;

    const activeSecs = getActiveSections(tile.state);
    if (!activeSecs.length) {
      const el = tile.rootEl?.querySelector(".multi-tile-result");
      if (el) {
        el.textContent = "No active sections";
        el.classList.remove("has-win");
      }
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
    }
    // Land cue once for a user-started spin (after full respin/portal chain)
    if (win && !silentLand && chainDepth === 0) playLandOnce();
    return win;
  }

  function buildSummaryLines() {
    const lines = [];
    for (const t of tiles.values()) {
      if (t.lastWin) {
        lines.push(`${t.name}: ${t.lastWin.label || "—"}`);
      } else if (!getActiveSections(t.state).length) {
        lines.push(`${t.name}: (no sections)`);
      }
    }
    return lines;
  }

  async function spinAll() {
    if (spinAllBusy || !active) return;
    const list = [...tiles.values()];
    if (!list.length) {
      setSummary("Select at least one wheel first.");
      return;
    }
    spinAllBusy = true;
    setSummary("Spinning…");
    try {
      deps.audio?.ensure?.();
      for (const t of list) setTileResult(t, null);

      // Parallel first spins; land actions may chain to other tiles (wait if busy)
      const results = await Promise.all(
        list.map((t) => spinTile(t, { silentLand: true, chainDepth: 0 }))
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
    const layout = document.getElementById("main-layout");
    if (layout && !layout.classList.contains("sidebar-collapsed")) {
      layout.classList.add("sidebar-collapsed");
      layout.dataset.multiCollapsed = "1";
    }
    renderPicker();
    void rebuildTiles();
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
    const layout = document.getElementById("main-layout");
    if (layout?.dataset.multiCollapsed === "1") {
      layout.classList.remove("sidebar-collapsed");
      delete layout.dataset.multiCollapsed;
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
    renderPicker();
    void rebuildTiles();
  }

  function clearSelection() {
    selectedIds = [];
    saveSelection();
    renderPicker();
    void rebuildTiles();
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
  }

  function onLibraryChanged() {
    if (!active) return;
    renderPicker();
    void rebuildTiles();
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
  };
}
