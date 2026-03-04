<p align="center">
  <h1 align="center">HALO</h1>
  <p align="center"><strong>Ambient Engine for Media Immersion</strong></p>
  <p align="center">
    A cinematic light instrument that transforms any BLE LED strip into an immersive ambient display.
    <br />Control colour, brightness, and 18 animated modes — all from your browser.
  </p>
</p>

---

## ✨ Features

| Category | Details |
|---|---|
| **Manual Control** | Drag the orb to paint hue & saturation · Scroll to dim · HEX input · Color temperature slider |
| **Ambient Modes** | Cinema · Warm Night · Reflection · Heartbeat · Fire · Storm · Ocean · Aurora · Breathing · Spectrum |
| **Animations** | Flow · Chase · Pulse · Strobe |
| **Reactive Modes** | 🎧 Audio Reactive (mic FFT) · 🖥 Screen Sync · 📷 Webcam Match |
| **Favourites** | 5 quick-save colour slots (long-press to save, click to recall) |
| **Connectivity** | Web Bluetooth (BLE) — pairs directly from Chrome, Edge, or Opera |

## 🎯 How It Works

HALO connects to **BJ_LED_M** (or similar) BLE LED controllers using the Web Bluetooth API. It sends 8-byte colour packets at up to 30 Hz:

```
[0x69, 0x96, 0x05, 0x02, Blue, Red, Green, Brightness]
```

The animation engine runs a 60fps `requestAnimationFrame` loop that smoothly lerps between target and current colours, producing buttery transitions between modes.

## 🖱 Controls

| Input | Action |
|---|---|
| **Drag** on orb | Change hue & saturation |
| **Scroll** on orb | Adjust brightness |
| **Double-click** orb | Cycle through modes |
| **Long-press** orb | Open presets panel |
| `↑` `↓` | Brightness up / down |
| `←` `→` | Shift hue |
| `M` | Next mode |
| `Space` | Toggle audio reactive |
| `Esc` | Close overlays |

## 🚀 Quick Start

1. **Clone the repo**
   ```bash
   git clone https://github.com/alenjoby/halo-ambient-engine.git
   cd halo-ambient-engine
   ```

2. **Serve locally** (any static server works)
   ```bash
   npx serve .
   ```
   Or just open `index.html` directly in Chrome / Edge.

3. **Connect your LED strip**
   - Click **Connect** → select your BLE device (`BJ_LED_M`)
   - Drag the orb to paint light!

> **Note:** Web Bluetooth requires HTTPS or `localhost`. Chrome, Edge, and Opera are supported. Safari and Firefox do not support Web Bluetooth.

## 🏗 Architecture

```
┌──────────────────┐
│   State Layer    │  Single source of truth (state object)
├──────────────────┤
│   BLE Layer      │  Connect, disconnect, write 8-byte packets
├──────────────────┤
│   Animation      │  rAF loop, lerp, easing, 18 preset drivers
├──────────────────┤
│   UI Layer       │  Canvas orb, gesture handlers, DOM updates
└──────────────────┘
```

| File | Purpose |
|---|---|
| `index.html` | Page structure, overlays, presets grid |
| `script.js` | Full engine — state, BLE, colour math, animations, UI |
| `style.css` | Dark cinematic design system, responsive layout |

## 📋 Requirements

- **Browser:** Chrome 56+, Edge 79+, or Opera 43+ (Web Bluetooth support)
- **Hardware:** Any BLE LED controller compatible with the `0xEEA0` / `0xEE02` service/characteristic UUIDs
- **OS:** Windows, macOS, Linux, ChromeOS, or Android (via Chrome)

## 📄 License

MIT — use it, remix it, light up your world.
