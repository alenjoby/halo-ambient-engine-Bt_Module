/* ════════════════════════════════════════════════════════════════
   HALO — JavaScript Engine
   ════════════════════════════════════════════════════════════════

   Architecture:
   ┌──────────────┐
   │  State Layer  │  Single source of truth
   ├──────────────┤
   │  BLE Layer   │  Connect, disconnect, write packets
   ├──────────────┤
   │  Animation   │  rAF loop, lerp, easing, preset drivers
   ├──────────────┤
   │  UI Layer    │  Canvas orb, interactions, DOM updates
   └──────────────┘
*/

// ─────────────────────────────────────────────────────────────────
// 1. STATE MANAGEMENT
// ─────────────────────────────────────────────────────────────────

const MODE = Object.freeze({
  MANUAL: 'MANUAL',
  CINEMA: 'CINEMA',
  WARM_NIGHT: 'WARM_NIGHT',
  REFLECTION: 'REFLECTION',
  HEARTBEAT: 'HEARTBEAT',
  FIRE: 'FIRE',
  STORM: 'STORM',
  OCEAN: 'OCEAN',
  AURORA: 'AURORA',
  BREATHING: 'BREATHING',
  SPECTRUM: 'SPECTRUM',
  AUDIO: 'AUDIO',
  SCREEN: 'SCREEN',
  WEBCAM: 'WEBCAM',
  FLOW: 'FLOW',
  CHASE: 'CHASE',
  PULSE: 'PULSE',
  STROBE: 'STROBE'
});

const state = {
  // Connection
  connected: false,
  characteristic: null,
  device: null,

  // Colour (HSB model for interaction, converted to RGB→BRG for BLE)
  hue: 220,
  saturation: 30,

  // Smoothed values (what actually gets sent / rendered)
  currentColor: { r: 40, g: 40, b: 60 },
  targetColor: { r: 40, g: 40, b: 60 },
  currentBrightness: 200,
  targetBrightness: 200,
  manualBrightness: 200, // Remembers user's preferred brightness for MANUAL mode

  // Mode
  activeMode: MODE.MANUAL,
  powerOn: true,
  animationSpeed: 1.0,

  // Interaction state
  isDragging: false,
  longPressTimer: null,
  presetsOpen: false,
  animationsOpen: false,
  helpOpen: false,
  lastBleWrite: 0,
  hintShown: false,

  // Audio & Media
  audioContext: null,
  analyser: null,
  audioStream: null,
  mediaStream: null,

  // Animation
  animationTime: 0
};

// ─────────────────────────────────────────────────────────────────
// 2. BLE COMMUNICATION LAYER
// ─────────────────────────────────────────────────────────────────

const BLE = {
  // Full 128-bit UUIDs for maximum cross-platform compatibility
  SERVICE_UUID: '0000eea0-0000-1000-8000-00805f9b34fb',
  CHAR_UUID: '0000ee02-0000-1000-8000-00805f9b34fb',
  DEVICE_NAME: 'BJ_LED_M',
  HEADER: new Uint8Array([0x69, 0x96, 0x05, 0x02]),
  MIN_WRITE_INTERVAL: 33, // ~30 Hz max

  /**
   * Initiate BLE connection to BJ_LED_M device
   * Uses name-based filtering because many BLE LED controllers
   * don't advertise service UUIDs in their advertisement packets.
   * The service is declared in optionalServices so we can access
   * it after connecting to GATT.
   */
  async connect() {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: BLE.DEVICE_NAME },
          { namePrefix: 'BJ_LED' }
        ],
        optionalServices: [BLE.SERVICE_UUID]
      });

      device.addEventListener('gattserverdisconnected', BLE.onDisconnect);
      state.device = device;

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE.SERVICE_UUID);
      const characteristic = await service.getCharacteristic(BLE.CHAR_UUID);

      state.characteristic = characteristic;
      state.connected = true;

      UI.updateConnectionState(true);
      console.log('[HALO] Connected to', device.name);

    } catch (err) {
      console.warn('[HALO] Connection failed:', err.message);
      state.connected = false;
      UI.updateConnectionState(false);
    }
  },

  /**
   * Handle unexpected disconnection
   */
  onDisconnect() {
    console.log('[HALO] Device disconnected');
    state.connected = false;
    state.characteristic = null;
    UI.updateConnectionState(false);
  },

  /**
   * Graceful disconnect
   */
  disconnect() {
    if (state.device && state.device.gatt.connected) {
      state.device.gatt.disconnect();
    }
    state.connected = false;
    state.characteristic = null;
    UI.updateConnectionState(false);
  },

  /**
   * Build and send 8-byte BLE packet
   * Colour order: B R G (NOT RGB)
   * @param {number} r - Red 0–255
   * @param {number} g - Green 0–255
   * @param {number} b - Blue 0–255
   * @param {number} brightness - Brightness 0–255
   */
  async sendColor(r, g, b, brightness) {
    if (!state.characteristic || !state.connected) return;

    // Throttle: max 30 writes/sec
    const now = performance.now();
    if (now - state.lastBleWrite < BLE.MIN_WRITE_INTERVAL) return;
    state.lastBleWrite = now;

    const packet = new Uint8Array(8);
    packet[0] = 0x69;
    packet[1] = 0x96;
    packet[2] = 0x05;
    packet[3] = 0x02;
    packet[4] = Math.round(b) & 0xFF; // Blue
    packet[5] = Math.round(r) & 0xFF; // Red
    packet[6] = Math.round(g) & 0xFF; // Green
    packet[7] = Math.round(brightness) & 0xFF;

    try {
      await state.characteristic.writeValueWithoutResponse(packet);
    } catch (err) {
      console.warn('[HALO] Write failed:', err.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────
// 3. COLOUR UTILITIES
// ─────────────────────────────────────────────────────────────────

const Color = {
  /**
   * Convert HSB to RGB
   * @param {number} h - Hue 0–360
   * @param {number} s - Saturation 0–100
   * @param {number} b - Brightness 0–100 (for rendering; BLE brightness is separate)
   * @returns {{r: number, g: number, b: number}} RGB 0–255
   */
  hsbToRgb(h, s, b) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    b = Math.max(0, Math.min(100, b)) / 100;

    const c = b * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = b - c;

    let r1, g1, b1;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }

    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  },

  /**
   * Lerp between two values
   */
  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  /**
   * Lerp between two colours
   */
  lerpColor(from, to, t) {
    return {
      r: Color.lerp(from.r, to.r, t),
      g: Color.lerp(from.g, to.g, t),
      b: Color.lerp(from.b, to.b, t)
    };
  },

  /**
   * Cubic ease in-out
   */
  easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },

  /**
   * Convert RGB to CSS string
   */
  toCSS(c, alpha = 1) {
    return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
  },

  /**
   * Convert RGB back to HSB for reverse-syncing UI
   */
  rgbToHsb(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;

    if (max !== min) {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, b: v * 100 };
  },

  /**
   * Convert Color Temperature (Kelvin) to RGB
   */
  tempToRgb(kelvin) {
    let temp = kelvin / 100;
    let r, g, b;

    if (temp <= 66) {
      r = 255;
      g = temp;
      g = 99.4708025861 * Math.log(g) - 161.1195681661;
      if (temp <= 19) {
        b = 0;
      } else {
        b = temp - 10;
        b = 138.5177312231 * Math.log(b) - 305.0447927307;
      }
    } else {
      r = temp - 60;
      r = 329.698727446 * Math.pow(r, -0.1332047592);
      g = temp - 60;
      g = 288.1221695283 * Math.pow(g, -0.0755148492);
      b = 255;
    }

    return {
      r: Math.max(0, Math.min(255, r)),
      g: Math.max(0, Math.min(255, g)),
      b: Math.max(0, Math.min(255, b))
    };
  },

  /**
   * Convert RGB to HEX string
   */
  rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
  }
};

// ─────────────────────────────────────────────────────────────────
// 4. ANIMATION ENGINE
// ─────────────────────────────────────────────────────────────────

const Animation = {
  COLOR_LERP_FACTOR: 0.08,
  BRIGHTNESS_LERP_FACTOR: 0.1,
  lastFrameTime: 0,

  /**
   * Main animation loop — runs every frame
   */
  tick(timestamp) {
    const dt = timestamp - Animation.lastFrameTime;
    Animation.lastFrameTime = timestamp;
    state.animationTime = timestamp;

    // ── Run preset mode driver ──
    Animation.runModeDriver(timestamp);

    // ── Smooth colour interpolation ──
    state.currentColor = Color.lerpColor(
      state.currentColor,
      state.targetColor,
      Animation.COLOR_LERP_FACTOR
    );

    // ── Smooth brightness interpolation ──
    if (!state.powerOn) {
      // Force everything to black immediately
      state.targetColor = { r: 0, g: 0, b: 0 };
      state.targetBrightness = 0;
      state.currentColor = Color.lerpColor(state.currentColor, { r: 0, g: 0, b: 0 }, 0.15);
      state.currentBrightness = Color.lerp(state.currentBrightness, 0, 0.15);
    } else {
      state.currentBrightness = Color.lerp(
        state.currentBrightness,
        state.targetBrightness,
        Animation.BRIGHTNESS_LERP_FACTOR
      );
    }

    // ── Update target from HSB ──
    if (state.activeMode === MODE.MANUAL && state.powerOn) {
      state.targetColor = Color.hsbToRgb(state.hue, state.saturation, 100);

      // Sync UI Inputs occasionally (not every frame to prevent text cursor jumping)
      if (!state._syncingInput) {
        const hexNode = document.getElementById('hexInput');
        if (document.activeElement !== hexNode) {
          hexNode.value = Color.rgbToHex(
            Math.round(state.targetColor.r),
            Math.round(state.targetColor.g),
            Math.round(state.targetColor.b)
          );
        }
      }
    }

    // ── Render orb ──
    UI.renderOrb();

    // ── Update ambient background ──
    UI.updateAmbient();

    // ── Send to BLE (using smoothed values) ──
    // Brightness is baked INTO the RGB values because BJ_LED_M
    // doesn't use byte 7 as a brightness multiplier.
    const br = state.currentBrightness / 255;
    BLE.sendColor(
      state.currentColor.r * br,
      state.currentColor.g * br,
      state.currentColor.b * br,
      state.currentBrightness
    );

    requestAnimationFrame(Animation.tick);
  },

  /**
   * Preset mode animation drivers
   */
  runModeDriver(timestamp) {
    const t = timestamp / 1000; // seconds

    switch (state.activeMode) {
      case MODE.CINEMA: {
        // Deep blue base with slow brightness breathing
        const baseColor = Color.hsbToRgb(220, 60, 100);
        state.targetColor = baseColor;
        // 6-second sine breathing, amplitude ±15
        const breathe = Math.sin(t * (2 * Math.PI / 6)) * 15;
        state.targetBrightness = Math.max(30, Math.min(255, 120 + breathe));
        break;
      }

      case MODE.WARM_NIGHT: {
        // Soft amber with slow hue drift
        const hueDrift = Math.sin(t * (2 * Math.PI / 12)) * 5;
        const warmColor = Color.hsbToRgb(30 + hueDrift, 80, 100);
        state.targetColor = warmColor;
        state.targetBrightness = 80;
        break;
      }

      case MODE.REFLECTION: {
        // Candle tone with 8-second sine-wave brightness breathing
        const candleColor = Color.hsbToRgb(35, 70, 100);
        state.targetColor = candleColor;
        const breathe = Math.sin(t * (2 * Math.PI / 8)) * 40;
        state.targetBrightness = Math.max(30, Math.min(255, 100 + breathe));
        break;
      }

      case MODE.HEARTBEAT: {
        // Base red/pink
        state.targetColor = Color.hsbToRgb(345, 80, 100);

        // Heartbeat easing: two quick pulses then a long pause
        // Loop duration: ~1.2s
        const cycle = (t % 1.2) / 1.2;
        let intensity = 0;

        if (cycle < 0.15) {
          // First pulse
          intensity = Math.sin((cycle / 0.15) * Math.PI);
        } else if (cycle > 0.25 && cycle < 0.4) {
          // Second pulse
          intensity = Math.sin(((cycle - 0.25) / 0.15) * Math.PI) * 0.8;
        }
        // intensity is 0-1
        state.targetBrightness = 40 + (intensity * 180);
        break;
      }

      case MODE.FIRE: {
        // Chaotic Perlin-noise simulation using layered sines
        const noise1 = Math.sin(t * 3.1) * Math.sin(t * 1.7 + 2);
        const noise2 = Math.sin(t * 5.5 + 4) * Math.sin(t * 2.3 + 1);
        const combinedNoise = (noise1 + noise2) / 2; // roughly -1 to 1

        // Hue shifts between Deep Red (0) and Orange (35)
        const hue = 15 + (combinedNoise * 15);
        state.targetColor = Color.hsbToRgb(hue, 90, 100);

        // Brightness flickers chaotically
        state.targetBrightness = Math.max(30, Math.min(255, 120 + (combinedNoise * 80)));
        break;
      }

      case MODE.STORM: {
        // Moody deep blue
        state.targetColor = Color.hsbToRgb(230, 80, 100);

        // Random lightning flashes
        // We need a stable random seed based on time so it doesn't jitter per frame without a trigger
        const timeG = Math.floor(t * 10); // Check every 100ms

        // 1% chance per 100ms to trigger a strike
        if (!state._lastStrikeTime) state._lastStrikeTime = 0;

        if (Math.sin(timeG * 1337) > 0.98 && (t - state._lastStrikeTime) > 2) {
          state._lastStrikeTime = t;
          // Add a secondary strike sometimes
          if (Math.random() > 0.5) {
            setTimeout(() => state._strikeNow = true, 150);
          }
        }

        if (t - state._lastStrikeTime < 0.1 || state._strikeNow) {
          // Flash white!
          state.targetColor = { r: 255, g: 255, b: 255 };
          state.targetBrightness = 255;
          state.currentColor = { r: 255, g: 255, b: 255 }; // Force immediate jump
          state.currentBrightness = 255;
          state._strikeNow = false;
        } else {
          // Fade back to dark blue
          state.targetBrightness = 30;
        }
        break;
      }

      case MODE.OCEAN: {
        // Slow, gentle drift between deep blue and teal
        // Drift takes about 16 seconds
        const drift = Math.sin(t * (2 * Math.PI / 16));
        // Hue shifts between 200 (light blue) and 240 (deep blue)
        const hue = 220 + (drift * 20);
        state.targetColor = Color.hsbToRgb(hue, 80, 100);

        // Very subtle brightness wave
        const wave = Math.cos(t * (2 * Math.PI / 8)) * 20;
        state.targetBrightness = 100 + wave;
        break;
      }

      case MODE.AURORA: {
        // Glacial sweep through green, blue, and purple
        // Very slow, 40s cycle
        const cycle = t * (Math.PI * 2 / 40);
        // Hue shifts between 120 (Green) and 280 (Purple)
        const hue = 200 + (Math.sin(cycle) * 80);
        state.targetColor = Color.hsbToRgb(hue, 80, 100);

        // Glacial brightness pulsing
        state.targetBrightness = 120 + (Math.sin(cycle * 2.5) * 40);
        break;
      }

      case MODE.BREATHING: {
        // 4s in, 4s hold, 4s out, 4s hold
        state.targetColor = Color.hsbToRgb(210, 40, 100); // Calming pale blue

        const period = 16;
        const cycle = t % period;

        if (cycle < 4) {
          // Ramping up (0 to 4s)
          const progress = cycle / 4;
          state.targetBrightness = 40 + (Color.easeInOutCubic(progress) * 160);
        } else if (cycle < 8) {
          // Holding full (4s to 8s)
          state.targetBrightness = 200;
        } else if (cycle < 12) {
          // Ramping down (8s to 12s)
          const progress = (cycle - 8) / 4;
          state.targetBrightness = 200 - (Color.easeInOutCubic(progress) * 160);
        } else {
          // Holding dim (12s to 16s)
          state.targetBrightness = 40;
        }
        break;
      }

      case MODE.SPECTRUM: {
        // Ultra slow cycle: 3 minutes (180s)
        const hue = ((t / 180) * 360) % 360;
        state.targetColor = Color.hsbToRgb(hue, 80, 100);
        state.targetBrightness = 160;
        break;
      }

      case MODE.AUDIO: {
        Animation.processAudio();
        break;
      }

      case MODE.SCREEN:
      case MODE.WEBCAM: {
        Animation.processMedia();
        break;
      }

      case MODE.FLOW: {
        const speed = state.animationSpeed;
        const hue = (t * 20 * speed) % 360;
        state.targetColor = Color.hsbToRgb(hue, 100, 100);
        state.targetBrightness = 200;
        break;
      }

      case MODE.CHASE: {
        const speed = state.animationSpeed;
        const cycle = (t * speed) % 1.0;
        state.targetBrightness = cycle < 0.5 ? 255 : 30;
        break;
      }

      case MODE.PULSE: {
        const speed = state.animationSpeed;
        const breathe = Math.sin(t * Math.PI * speed); // -1 to 1
        state.targetBrightness = 50 + (breathe * 0.5 + 0.5) * 205; // 50 to 255
        break;
      }

      case MODE.STROBE: {
        const speed = state.animationSpeed;
        const cycle = (t * speed * 5) % 1.0;
        state.targetBrightness = cycle < 0.1 ? 255 : 0;
        break;
      }

      // MODE.MANUAL — no driver, user controls directly
    }
  },

  /**
   * Audio reactive mode — maps FFT frequencies to BRG
   */
  processAudio() {
    if (!state.analyser) return;

    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    state.analyser.getByteFrequencyData(dataArray);

    // Divide spectrum into three bands
    const third = Math.floor(bufferLength / 3);
    let low = 0, mid = 0, high = 0;

    for (let i = 0; i < third; i++) low += dataArray[i];
    for (let i = third; i < third * 2; i++) mid += dataArray[i];
    for (let i = third * 2; i < bufferLength; i++) high += dataArray[i];

    low = Math.min(255, (low / third) * 1.5);
    mid = Math.min(255, (mid / third) * 1.5);
    high = Math.min(255, (high / third) * 1.5);

    // Low → Blue, Mid → Red, High → Green
    state.targetColor = {
      r: mid,
      g: high,
      b: low
    };
    state.targetBrightness = Math.max(60, (low + mid + high) / 3);
  },

  /**
   * Start audio capture for Audio mode
   */
  async startAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.audioStream = stream;
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = state.audioContext.createMediaStreamSource(stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 256;
      state.analyser.smoothingTimeConstant = 0.8;
      source.connect(state.analyser);
      console.log('[HALO] Audio reactive mode active');
    } catch (err) {
      console.warn('[HALO] Microphone access denied:', err.message);
      // Fall back to manual mode
      state.activeMode = MODE.MANUAL;
      UI.updateModeIndicator();
    }
  },

  /**
   * Stop audio capture
   */
  stopAudio() {
    if (state.audioStream) {
      state.audioStream.getTracks().forEach(t => t.stop());
      state.audioStream = null;
    }
    if (state.audioContext) {
      state.audioContext.close();
      state.audioContext = null;
    }
    state.analyser = null;
  },

  /**
   * Start Media (Screen or Webcam)
   */
  async startMedia(type) {
    try {
      // Stop any existing streams
      Animation.stopMedia();

      let stream;
      if (type === 'SCREEN') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      state.mediaStream = stream;
      const video = document.getElementById('mediaVideo');
      video.srcObject = stream;
      await video.play();

      // Listen for user stopping screen share via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (state.activeMode === MODE.SCREEN || state.activeMode === MODE.WEBCAM) {
          UI.activateMode(MODE.MANUAL);
        }
      });

      console.log(`[HALO] ${type} sync active`);
    } catch (err) {
      console.warn(`[HALO] ${type} access denied:`, err.message);
      state.activeMode = MODE.MANUAL;
      UI.updateModeIndicator();
    }
  },

  /**
   * Stop Media processing
   */
  stopMedia() {
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
      state.mediaStream = null;
    }
    const video = document.getElementById('mediaVideo');
    video.srcObject = null;
    video.pause();
  },

  /**
   * Extract average color from video frame
   */
  processMedia() {
    const video = document.getElementById('mediaVideo');
    if (!video || !state.mediaStream || video.readyState !== video.HAVE_ENOUGH_DATA) return;

    const canvas = document.getElementById('mediaCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Draw entire video frame scaled down to canvas size
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Sample the ENTIRE frame for a true average
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let r = 0, g = 0, b = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }

    r = r / count;
    g = g / count;
    b = b / count;

    // Boost saturation so the LED isn't washed-out
    // Convert to HSB, amplify saturation, convert back
    const hsb = Color.rgbToHsb(r, g, b);
    hsb.s = Math.min(100, hsb.s * 1.4); // 40% saturation boost
    const boosted = Color.hsbToRgb(hsb.h, hsb.s, hsb.b);

    state.targetColor = {
      r: Math.min(255, boosted.r),
      g: Math.min(255, boosted.g),
      b: Math.min(255, boosted.b)
    };

    // Dynamic brightness based on luminance
    const lum = 0.2126 * state.targetColor.r + 0.7152 * state.targetColor.g + 0.0722 * state.targetColor.b;
    state.targetBrightness = Math.max(40, Math.min(255, lum * 1.2));
  }
};

// ─────────────────────────────────────────────────────────────────
// 5. UI LAYER
// ─────────────────────────────────────────────────────────────────

const UI = {
  canvas: null,
  ctx: null,
  orbWrapper: null,
  dpr: 1,

  /**
   * Initialise all UI elements and event listeners
   */
  init() {
    UI.canvas = document.getElementById('orbCanvas');
    UI.ctx = UI.canvas.getContext('2d');
    UI.orbWrapper = document.getElementById('orbWrapper');
    UI.dpr = window.devicePixelRatio || 1;

    // Size canvas to CSS size × device pixel ratio
    UI.resizeCanvas();
    window.addEventListener('resize', UI.resizeCanvas);

    // ── Orb interactions ──
    UI.setupOrbInteractions();

    // ── Connect button ──
    document.getElementById('connectBtn').addEventListener('click', async () => {
      if (state.connected) {
        BLE.disconnect();
      } else {
        await BLE.connect();
      }
    });

    // ── Help button ──
    document.getElementById('helpBtn').addEventListener('click', () => {
      UI.openHelp();
    });
    document.getElementById('helpOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) UI.closeHelp();
    });

    // ── Presets panel ──
    UI.setupPresets();

    // ── Action Buttons & Overlays ──
    document.getElementById('presetsBtn').addEventListener('click', () => {
      UI.openPresets();
    });

    document.getElementById('animationsBtn').addEventListener('click', () => {
      UI.openAnimations();
    });

    document.getElementById('animationsOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) UI.closeAnimations();
    });

    document.getElementById('powerBtn').addEventListener('click', () => {
      state.powerOn = !state.powerOn;
      const btn = document.getElementById('powerBtn');
      if (state.powerOn) {
        btn.textContent = 'Light Off';
        btn.classList.remove('power-on-state');
        btn.classList.add('power-off-btn');
      } else {
        btn.textContent = 'Light On';
        btn.classList.remove('power-off-btn');
        btn.classList.add('power-on-state');
        // Force immediate black
        state.currentColor = { r: 0, g: 0, b: 0 };
        state.currentBrightness = 0;
        state.targetBrightness = 0;
        // Send black over BLE immediately
        BLE.sendColor(0, 0, 0, 0);
      }
    });

    // ── Animations panel setup ──
    UI.setupAnimations();

    // ── Precision Controls ──
    UI.setupPrecisionControls();

    // ── Keyboard Shortcuts ──
    document.addEventListener('keydown', (e) => {
      // ESC closes overlays
      if (e.key === 'Escape') {
        if (state.presetsOpen) UI.closePresets();
        if (state.animationsOpen) UI.closeAnimations();
        if (state.helpOpen) UI.closeHelp();
        // Also dismiss tutorial immediately if open
        if (!state.hintShown) {
          document.getElementById('ghostTutorial').classList.remove('visible');
          localStorage.setItem('halo-onboarded', 'true');
          state.hintShown = true;
        }
      }

      // Don't trigger shortcuts if an overlay is open
      if (state.presetsOpen || state.helpOpen) return;

      switch (e.key.toLowerCase()) {
        case ' ': // Space
          e.preventDefault();
          if (state.activeMode === MODE.AUDIO) {
            UI.activateMode(MODE.MANUAL);
          } else {
            UI.activateMode(MODE.AUDIO);
          }
          break;
        case 'm':
          e.preventDefault();
          const modes = [
            MODE.MANUAL, MODE.CINEMA, MODE.WARM_NIGHT, MODE.REFLECTION,
            MODE.HEARTBEAT, MODE.FIRE, MODE.STORM,
            MODE.OCEAN, MODE.AURORA, MODE.BREATHING, MODE.SPECTRUM, MODE.AUDIO,
            MODE.SCREEN, MODE.WEBCAM, MODE.FLOW, MODE.CHASE, MODE.PULSE, MODE.STROBE
          ];
          const nextMode = modes[(modes.indexOf(state.activeMode) + 1) % modes.length];
          UI.activateMode(nextMode);
          break;
        case 'arrowup':
          e.preventDefault();
          state.targetBrightness = Math.min(255, state.targetBrightness + 20);
          state.manualBrightness = state.targetBrightness;
          UI.activateMode(MODE.MANUAL);
          break;
        case 'arrowdown':
          e.preventDefault();
          state.targetBrightness = Math.max(0, state.targetBrightness - 20);
          state.manualBrightness = state.targetBrightness;
          UI.activateMode(MODE.MANUAL);
          break;
        case 'arrowleft':
          e.preventDefault();
          state.hue = (state.hue - 15 + 360) % 360;
          state.targetColor = Color.hsbToRgb(state.hue, state.saturation, 100);
          UI.activateMode(MODE.MANUAL);
          break;
        case 'arrowright':
          e.preventDefault();
          state.hue = (state.hue + 15) % 360;
          state.targetColor = Color.hsbToRgb(state.hue, state.saturation, 100);
          UI.activateMode(MODE.MANUAL);
          break;
      }
    });

    // ── Ghost Tutorial Overlay ──
    if (localStorage.getItem('halo-onboarded') !== 'true') {
      setTimeout(() => {
        const tut = document.getElementById('ghostTutorial');
        tut.classList.add('visible');

        document.getElementById('ghostDismiss').addEventListener('click', () => {
          tut.classList.remove('visible');
          localStorage.setItem('halo-onboarded', 'true');
          state.hintShown = true; // Prevents the old hint box from showing
        }, { once: true });
      }, 1500);
    } else {
      state.hintShown = true; // Already onboarded
    }
  },

  /**
   * Resize canvas for retina
   */
  resizeCanvas() {
    const rect = UI.canvas.getBoundingClientRect();
    UI.canvas.width = rect.width * UI.dpr;
    UI.canvas.height = rect.height * UI.dpr;
    UI.ctx.scale(UI.dpr, UI.dpr);
  },

  /**
   * Set up orb drag / scroll / double-click / long-press interactions
   */
  setupOrbInteractions() {
    const wrapper = UI.orbWrapper;

    // ── Drag (pointer events for mouse + touch) ──
    wrapper.addEventListener('pointerdown', (e) => {
      state.isDragging = true;
      wrapper.setPointerCapture(e.pointerId);
      UI.handleOrbDrag(e);

      // Start long-press timer
      state.longPressTimer = setTimeout(() => {
        if (state.isDragging) {
          state.isDragging = false;
          UI.openPresets();
        }
      }, 600);
    });

    wrapper.addEventListener('pointermove', (e) => {
      if (!state.isDragging) return;
      // Cancel long press if significant movement
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      UI.handleOrbDrag(e);
    });

    wrapper.addEventListener('pointerup', () => {
      state.isDragging = false;
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
    });

    wrapper.addEventListener('pointercancel', () => {
      state.isDragging = false;
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
    });

    // ── Scroll wheel → brightness ──
    wrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -8 : 8;
      state.targetBrightness = Math.max(0, Math.min(255, state.targetBrightness + delta));
      state.manualBrightness = state.targetBrightness; // Save user preference

      // Only in manual mode
      if (state.activeMode !== MODE.MANUAL) {
        state.activeMode = MODE.MANUAL;
        Animation.stopAudio();
        UI.updateModeIndicator();
      }

      // Show brightness display briefly
      const bd = document.getElementById('brightnessDisplay');
      bd.textContent = `${Math.round((state.targetBrightness / 255) * 100)}%`;
      bd.classList.add('visible');
      clearTimeout(UI._brightnessTimeout);
      UI._brightnessTimeout = setTimeout(() => bd.classList.remove('visible'), 1500);
    }, { passive: false });

    // ── Double-click → cycle modes ──
    wrapper.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const modes = [
        MODE.MANUAL,
        MODE.CINEMA, MODE.WARM_NIGHT, MODE.REFLECTION,
        MODE.HEARTBEAT, MODE.FIRE, MODE.STORM,
        MODE.OCEAN, MODE.AURORA, MODE.BREATHING, MODE.SPECTRUM,
        MODE.AUDIO, MODE.SCREEN, MODE.WEBCAM, MODE.FLOW, MODE.CHASE, MODE.PULSE, MODE.STROBE
      ];
      const currentIndex = modes.indexOf(state.activeMode);
      const nextMode = modes[(currentIndex + 1) % modes.length];
      UI.activateMode(nextMode);
    });

    // Prevent context menu on long press
    wrapper.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  /**
   * Map pointer position in orb to hue + saturation
   */
  handleOrbDrag(e) {
    if (state.activeMode !== MODE.MANUAL) {
      state.activeMode = MODE.MANUAL;
      Animation.stopAudio();
      Animation.stopMedia();
      UI.updateModeIndicator();
      // Restore user's saved brightness when returning to manual via drag
      state.targetBrightness = state.manualBrightness;
    }

    const rect = UI.orbWrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const radius = rect.width / 2;

    // Polar coordinates
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    angle = ((angle % 360) + 360) % 360;
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy) / radius, 1);

    state.hue = angle;
    state.saturation = dist * 100;
    state.targetColor = Color.hsbToRgb(state.hue, state.saturation, 100);
  },

  /**
   * Render the orb on canvas
   */
  renderOrb() {
    const ctx = UI.ctx;
    const rect = UI.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2;

    ctx.clearRect(0, 0, w, h);

    const brightnessRatio = state.currentBrightness / 255;
    const c = state.currentColor;

    if (!state.connected && state.activeMode === MODE.MANUAL) {
      // Disconnected: orb reflects brightness + colour changes
      const t = state.animationTime / 1000;
      const br = brightnessRatio; // 0..1 from scroll wheel
      const pulse = (0.03 + Math.sin(t * 0.8) * 0.01) * (0.5 + br * 0.5);

      // Outer subtle ring
      const ringGrad = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r);
      ringGrad.addColorStop(0, 'transparent');
      ringGrad.addColorStop(0.5, `rgba(255, 255, 255, ${pulse})`);
      ringGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = ringGrad;
      ctx.fillRect(0, 0, w, h);

      // Core orb — alpha scales with brightness
      const coreAlpha = 0.05 + br * 0.45;
      const midAlpha = 0.02 + br * 0.12;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9);
      grad.addColorStop(0, `rgba(${c.r}, ${c.g}, ${c.b}, ${coreAlpha + pulse})`);
      grad.addColorStop(0.5, `rgba(${Math.round(c.r * 0.5)}, ${Math.round(c.g * 0.5)}, ${Math.round(c.b * 0.5)}, ${midAlpha})`);
      grad.addColorStop(0.85, `rgba(30, 30, 40, ${0.01 + br * 0.04})`);
      grad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

    } else {
      // Connected / active mode: vibrant glowing orb
      const intensity = 0.15 + brightnessRatio * 0.55;
      const coreIntensity = 0.3 + brightnessRatio * 0.5;

      // Outer aura
      const auraGrad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
      auraGrad.addColorStop(0, Color.toCSS(c, coreIntensity));
      auraGrad.addColorStop(0.4, Color.toCSS(c, intensity * 0.6));
      auraGrad.addColorStop(0.7, Color.toCSS(c, intensity * 0.2));
      auraGrad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = auraGrad;
      ctx.fill();

      // Inner bright core
      const coreGrad = ctx.createRadialGradient(
        cx - r * 0.1, cy - r * 0.1, 0,
        cx, cy, r * 0.55
      );
      coreGrad.addColorStop(0, Color.toCSS({
        r: Math.min(255, c.r + 80),
        g: Math.min(255, c.g + 80),
        b: Math.min(255, c.b + 80)
      }, coreIntensity));
      coreGrad.addColorStop(0.4, Color.toCSS(c, intensity));
      coreGrad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Specular highlight
      const specGrad = ctx.createRadialGradient(
        cx - r * 0.15, cy - r * 0.2, 0,
        cx - r * 0.1, cy - r * 0.15, r * 0.25
      );
      specGrad.addColorStop(0, `rgba(255, 255, 255, ${brightnessRatio * 0.12})`);
      specGrad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.arc(cx - r * 0.1, cy - r * 0.15, r * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = specGrad;
      ctx.fill();
    }
  },

  /**
   * Update the ambient background glow to match current colour
   */
  updateAmbient() {
    const c = state.currentColor;
    const b = state.currentBrightness / 255;
    const alpha = state.connected ? b * 0.06 : 0.015;
    document.getElementById('ambientBg').style.setProperty(
      '--ambient-color',
      `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`
    );

    // Also update orb glow layer
    const glowAlpha = state.connected ? b * 0.12 : 0.02;
    document.getElementById('orbGlow').style.setProperty(
      '--orb-glow-color',
      `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${glowAlpha})`
    );
  },

  /**
   * Update connection state across all UI elements
   */
  updateConnectionState(connected) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn = document.getElementById('connectBtn');

    if (connected) {
      dot.classList.add('connected');
      text.classList.add('connected');
      text.textContent = 'Connected';
      btn.classList.add('connected');
      btn.textContent = 'Disconnect';
    } else {
      dot.classList.remove('connected');
      text.classList.remove('connected');
      text.textContent = 'Disconnected';
      btn.classList.remove('connected');
      btn.textContent = 'Connect';

      // Reset to dim state
      if (state.activeMode !== MODE.MANUAL) {
        state.activeMode = MODE.MANUAL;
        Animation.stopAudio();
        UI.updateModeIndicator();
      }
    }
  },

  /**
   * Activate a cinematic mode
   */
  activateMode(mode) {
    // Stop audio if leaving audio mode
    if (state.activeMode === MODE.AUDIO && mode !== MODE.AUDIO) {
      Animation.stopAudio();
    }
    // Stop media if leaving media modes
    if ((state.activeMode === MODE.SCREEN || state.activeMode === MODE.WEBCAM) &&
      (mode !== MODE.SCREEN && mode !== MODE.WEBCAM)) {
      Animation.stopMedia();
    }

    state.activeMode = mode;
    UI.updateModeIndicator();

    // Restore user's manual brightness when returning to MANUAL mode
    if (mode === MODE.MANUAL) {
      state.targetBrightness = state.manualBrightness;
    }

    // Start audio if entering audio mode
    if (mode === MODE.AUDIO) {
      Animation.startAudio();
    }
    // Start media if entering media mode
    if (mode === MODE.SCREEN || mode === MODE.WEBCAM) {
      Animation.startMedia(mode);
    }

    // Close presets if open
    if (state.presetsOpen) {
      UI.closePresets();
    }

    // Close animations if open
    if (state.animationsOpen) {
      UI.closeAnimations();
    }

    // Update preset card active states
    document.querySelectorAll('.preset-card').forEach(card => {
      card.classList.toggle('active', card.dataset.mode === mode);
    });
  },

  /**
   * Update mode label beneath orb
   */
  updateModeIndicator() {
    const el = document.getElementById('modeIndicator');
    const labels = {
      [MODE.MANUAL]: 'Manual',
      [MODE.CINEMA]: '🎬 Cinema',
      [MODE.WARM_NIGHT]: '🌅 Warm Night',
      [MODE.REFLECTION]: '🕯 Reflection',
      [MODE.HEARTBEAT]: '🤍 Heartbeat',
      [MODE.FIRE]: '🔥 Firelight',
      [MODE.STORM]: '🌩 Storm',
      [MODE.OCEAN]: '🌊 Ocean',
      [MODE.AURORA]: '🌌 Aurora',
      [MODE.BREATHING]: '🧘 Box Breathing',
      [MODE.SPECTRUM]: '🌈 Spectrum Sweep',
      [MODE.AUDIO]: '🎧 Audio Reactive',
      [MODE.SCREEN]: '🖥 Screen Sync',
      [MODE.WEBCAM]: '📷 Camera Match',
      [MODE.FLOW]: '🌊 Flow',
      [MODE.CHASE]: '💫 Chase',
      [MODE.PULSE]: '💗 Pulse',
      [MODE.STROBE]: '⚡ Strobe'
    };
    el.textContent = labels[state.activeMode] || 'Manual';
    el.classList.add('visible');

    // In manual mode, hide after a moment
    if (state.activeMode === MODE.MANUAL) {
      clearTimeout(UI._modeTimeout);
      UI._modeTimeout = setTimeout(() => el.classList.remove('visible'), 2000);
    }
  },

  /**
   * Setup preset card click handlers
   */
  setupPresets() {
    document.querySelectorAll('#presetsOverlay .preset-card').forEach(card => {
      card.addEventListener('click', () => {
        // Ensure power is on when picking an ambient mode
        state.powerOn = true;
        const btn = document.getElementById('powerBtn');
        btn.textContent = 'Light Off';
        btn.classList.remove('power-on-state');
        btn.classList.add('power-off-btn');

        UI.activateMode(card.dataset.mode);
      });
    });

    // Close on overlay click (outside cards)
    document.getElementById('presetsOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        UI.closePresets();
      }
    });
  },

  /**
   * Open/Close Animations Panel
   */
  openAnimations() {
    state.animationsOpen = true;
    document.getElementById('animationsOverlay').classList.add('open');
  },

  closeAnimations() {
    state.animationsOpen = false;
    document.getElementById('animationsOverlay').classList.remove('open');
  },

  /**
   * Setup animation card click handlers (separate from ambient presets)
   */
  setupAnimations() {
    document.querySelectorAll('.anim-card').forEach(card => {
      card.addEventListener('click', () => {
        // Ensure power is on when activating an animation
        state.powerOn = true;
        const btn = document.getElementById('powerBtn');
        btn.textContent = 'Light Off';
        btn.classList.remove('power-on-state');
        btn.classList.add('power-off-btn');

        UI.activateMode(card.dataset.mode);
        UI.closeAnimations();
      });
    });

    // Speed slider with label
    const speedSlider = document.getElementById('speedSlider');
    const speedLabel = document.getElementById('speedLabel');
    speedSlider.addEventListener('input', (e) => {
      state.animationSpeed = parseFloat(e.target.value);
      if (speedLabel) speedLabel.textContent = state.animationSpeed.toFixed(1) + '\u00d7';
    });
  },

  /**
   * Setup Precision Controls (Hex, Temp, Favourites)
   */
  setupPrecisionControls() {
    const hexInput = document.getElementById('hexInput');
    const tempSlider = document.getElementById('tempSlider');
    const dots = document.querySelectorAll('.fav-dot');

    // Hex Input Logic
    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.trim();
      if (val && !val.startsWith('#')) val = '#' + val;
      e.target.value = val;

      if (/^#([A-Fa-f0-9]{6})$/.test(val)) {
        state._syncingInput = true;
        const r = parseInt(val.substring(1, 3), 16);
        const g = parseInt(val.substring(3, 5), 16);
        const b = parseInt(val.substring(5, 7), 16);

        const hsb = Color.rgbToHsb(r, g, b);
        state.hue = hsb.h;
        state.saturation = hsb.s;
        UI.activateMode(MODE.MANUAL);
        setTimeout(() => state._syncingInput = false, 100);
      }
    });

    // Color Temp Slider Logic
    tempSlider.addEventListener('input', (e) => {
      state._syncingInput = true; // prevent Hex input from overwriting while sliding
      const kelvin = parseInt(e.target.value, 10);
      const rgb = Color.tempToRgb(kelvin);
      const hsb = Color.rgbToHsb(rgb.r, rgb.g, rgb.b);

      state.hue = hsb.h;
      state.saturation = hsb.s;
      UI.activateMode(MODE.MANUAL);
    });
    tempSlider.addEventListener('change', () => state._syncingInput = false);

    // Favourites Array
    let savedFavs = [];
    try { savedFavs = JSON.parse(localStorage.getItem('halo-favs') || '[]'); } catch (e) { }

    const updateDots = () => {
      dots.forEach((dot, i) => {
        const fav = savedFavs[i];
        if (fav) {
          dot.classList.remove('empty');
          const rgb = Color.hsbToRgb(fav.h, fav.s, 100);
          dot.style.background = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
        } else {
          dot.classList.add('empty');
          dot.style.background = '';
        }
      });
    };

    // Long press to save, short click to load
    dots.forEach((dot, i) => {
      let timer = null;

      dot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        timer = setTimeout(() => {
          // Save current color
          savedFavs[i] = { h: state.hue, s: state.saturation, b: state.targetBrightness };
          localStorage.setItem('halo-favs', JSON.stringify(savedFavs));
          updateDots();
          // Visual feedback
          dot.style.transform = 'scale(1.5)';
          setTimeout(() => dot.style.transform = '', 200);
          timer = null;
        }, 600); // 600ms long press to save
      });

      dot.addEventListener('pointerup', () => {
        if (timer) {
          clearTimeout(timer);
          // Load color if it exists
          if (savedFavs[i]) {
            const fav = savedFavs[i];
            state.hue = fav.h;
            state.saturation = fav.s;
            state.targetBrightness = fav.b;
            UI.activateMode(MODE.MANUAL);
          }
        }
      });

      dot.addEventListener('pointerleave', () => {
        if (timer) clearTimeout(timer);
      });
    });

    updateDots();
  },

  /**
   * Open the presets overlay
   */
  openPresets() {
    state.presetsOpen = true;
    document.getElementById('presetsOverlay').classList.add('open');
  },

  /**
   * Close the presets overlay
   */
  closePresets() {
    state.presetsOpen = false;
    document.getElementById('presetsOverlay').classList.remove('open');
  },

  /**
   * Open Help Manual
   */
  openHelp() {
    state.helpOpen = true;
    document.getElementById('helpOverlay').classList.add('open');
  },

  /**
   * Close Help Manual
   */
  closeHelp() {
    state.helpOpen = false;
    document.getElementById('helpOverlay').classList.remove('open');
  },

  // Timeout handles
  _brightnessTimeout: null,
  _modeTimeout: null
};

// ─────────────────────────────────────────────────────────────────
// 6. BOOT SEQUENCE
// ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  UI.init();

  // Check Web Bluetooth availability
  if (!navigator.bluetooth) {
    console.warn('[HALO] Web Bluetooth not available in this browser.');
    document.getElementById('connectBtn').textContent = 'BLE Not Supported';
    document.getElementById('connectBtn').style.opacity = '0.3';
    document.getElementById('connectBtn').style.pointerEvents = 'none';
  }

  // Start animation loop
  requestAnimationFrame(Animation.tick);

  console.log(
    '%c HALO %c Ambient Engine ',
    'background: #0b0b0f; color: #fff; padding: 6px 12px; font-family: serif; font-size: 14px; letter-spacing: 4px;',
    'background: #1a1a2e; color: rgba(255,255,255,0.5); padding: 6px 12px; font-family: sans-serif; font-size: 10px; letter-spacing: 2px;'
  );
});
