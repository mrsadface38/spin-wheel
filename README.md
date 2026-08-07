# Spin Wheel Studio

A cross-platform **spin-the-wheel** app (Windows & Linux) with:

- **Section images** — image on each wheel slice  
- **Center hub image** — logo / photo in the middle of the wheel  
- **Background image** — full stage background  
- **Spin SFX** — tick per segment pass, or loop audio while spinning  
- **Land SFX** — default win sound + **per-section** custom land sounds  
- **Groups** — toggle whole sets of sections on/off  
- **Weights** — larger weight = bigger slice  
- **Export / import** project as JSON  
- Auto-saves to browser `localStorage`

## Quick start (browser — works on Windows & Linux)

No install required beyond a modern browser (Chrome, Firefox, Edge).

### Option A — open via a local server (recommended)

```bash
cd spin-wheel
npm start
```

Then open **http://localhost:5173**

### Option B — any static server

```bash
# Python
python3 -m http.server 5173

# or npx
npx serve .
```

> Opening `index.html` as a `file://` URL can block some audio decode paths in certain browsers. Prefer a local server.

## Desktop app (optional Electron)

```bash
cd spin-wheel
npm install --save-dev electron
npm run electron
```

Package for installers later with `electron-builder` if you want `.exe` / AppImage.

## Features guide

### Sections
1. Open the **Sections** tab → **+ Add section** (or **Bulk add**).
2. Set label, color, weight, group.
3. Attach a **section image** and optional **land SFX** for that slice.
4. Toggle 👁 to enable/disable a single section.

### Groups
1. **Groups** tab → create groups (e.g. “Easy prizes”, “Hard mode”).
2. Assign sections to a group in the section editor.
3. Toggle a group off to remove all its sections from the wheel for the next spin.

### Look
- Background color / image  
- Center hub color / image / size  
- Border & text color  
- Show/hide labels and section images  

### Sound
- **Tick per segment** — clicky ticks as boundaries pass the pointer (built-in or custom).  
- **Loop** — plays your custom spin audio on loop while spinning.  
- **Both** / **Off**.  
- Default land chime, or custom default, overridden by per-section SFX.

## Project layout

```
spin-wheel/
  index.html
  css/style.css
  js/
    app.js      # UI wiring
    state.js    # model + localStorage
    wheel.js    # canvas draw + spin physics
    audio.js    # Web Audio + custom samples
  electron/main.js
  package.json
  README.md
```

## Tips

- **Double-click** the wheel to spin.  
- Large images/audio are stored as data URLs in `localStorage` — keep media modest or use **Export** and clear unused assets if storage fills up.  
- Weights are relative: two sections with weight `2` and `1` make a 2:1 size ratio.

## License

MIT — use and modify freely.
