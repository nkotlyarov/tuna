// ============================================================
//  Chromatic Guitar Tuner — pitch detection with the Web Audio API
// ============================================================
//
//  Four steps, all running in the browser (no server needed):
//    1. Ask the browser for microphone access (getUserMedia).
//    2. Read the raw sound wave from an AnalyserNode ~60x per second.
//    3. Estimate the pitch (fundamental frequency). Two detectors are
//       built in — classic autocorrelation and the McLeod Pitch Method —
//       selectable live in the Settings panel.
//    4. Convert it to a note + how many "cents" sharp/flat it is, and
//       plot that on a SCROLLING chart: the vertical axis is time, so you
//       watch your pitch drift toward (or away from) the center line.
//
//  IMPORTANT: microphones only work on a "secure context" — https:// or
//  http://localhost. Double-clicking the .html file (file://) will NOT
//  grant mic access in Chrome. Serve it instead, e.g.:
//      python3 -m http.server 8000   then open localhost:8000

// ---- Fixed constants ---------------------------------------------------

const A4 = 440; // tuning reference: the A above middle C, in Hz
const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const MIN_FREQ = 70; // lowest pitch we try to detect (guitar low E is ~82 Hz)
const MAX_FREQ = 1500; // highest pitch we bother detecting (well above a guitar)

const HISTORY_LEN = 260; // readings kept on the chart (~4.3s at 60fps); higher = slower scroll
const VIEW = 100; // the SVG viewBox is 100 x 100 user units

// Frequencies (Hz) where smoothing switches fully to the high / low values;
// between them it blends. (Left fixed; the strengths are adjustable below.)
const HI_FREQ = 300;
const LO_FREQ = 90;

// A real string change moves the (median-filtered) pitch by at least a few
// semitones, so we snap to it instead of gliding. Smaller moves — vibrato, or
// a one-frame octave glitch the median didn't fully remove — get smoothed.
const NOTE_SNAP_SEMITONES = 2;

// ---- Live settings (driven by the Settings panel in the UI) ------------

const settings = {
  algorithm: "classic", // "classic" or "mpm"
  smoothing: 0.2, // moving-average strength, high notes (lower = smoother)
  lowSmoothing: 0.06, // moving-average strength, low notes
  medianWindow: 5, // spike-rejection window, high notes (samples)
  lowMedianWindow: 13, // spike-rejection window, low notes
  clarityThreshold: 0.4, // MPM: min peak height (0..1) to accept a pitch
  peakRatio: 0.9, // MPM: accept the first peak ≥ this fraction of the tallest
  inTuneCents: 5, // within ±this many cents counts as "in tune"
  noteHold: 3.0, // seconds to keep the last note on screen after the sound stops
};

// Description of each slider: which setting it edits and its range. The UI
// is generated from this list (see buildSettingsUI), so adding a knob here
// adds a slider automatically. `int: true` means whole numbers only;
// `mpmOnly: true` means it's greyed out unless the MPM algorithm is active.
const CONTROLS = [
  { key: "smoothing", label: "Smoothing · high notes", min: 0.02, max: 0.5, step: 0.01 },
  { key: "lowSmoothing", label: "Smoothing · low notes", min: 0.02, max: 0.5, step: 0.01 },
  { key: "medianWindow", label: "Median window · high", min: 1, max: 15, step: 2, int: true },
  { key: "lowMedianWindow", label: "Median window · low", min: 1, max: 21, step: 2, int: true },
  { key: "clarityThreshold", label: "Clarity threshold", min: 0.1, max: 0.95, step: 0.05, mpmOnly: true },
  { key: "peakRatio", label: "Peak ratio", min: 0.7, max: 0.99, step: 0.01, mpmOnly: true },
  { key: "inTuneCents", label: "In-tune range (±cents)", min: 1, max: 20, step: 1, int: true },
  { key: "noteHold", label: "Note hold (s)", min: 0.2, max: 4, step: 0.1 },
];

// ---- Grab the page elements we will update -----------------------------

const noteNameEl = document.getElementById("noteName");
const noteOctaveEl = document.getElementById("noteOctave");
const frequencyEl = document.getElementById("frequency");
const readoutEl = document.querySelector(".readout");
const traceLineEl = document.getElementById("traceLine");
const traceEl = document.querySelector(".trace");
const bubbleEl = document.getElementById("bubble");
const centsBubbleEl = document.getElementById("centsBubble");
const directionPillEl = document.getElementById("directionPill");
const statusEl = document.getElementById("status");
const chartEl = document.getElementById("chart");
const algoSelectEl = document.getElementById("algoSelect");
const slidersEl = document.getElementById("sliders");

// ---- Audio + chart state (set up when the page loads) ------------------

let audioContext = null; // the Web Audio "engine"
let analyser = null; // lets us read the live waveform
let micStream = null; // the microphone track
let rafId = null; // id of our animation loop
let sampleBuffer = null; // reused array that holds one chunk of samples

let running = false;
let smoothedMidi = null; // smoothed continuous note number (null = nothing yet)
let lastCents = null; // last detected cents offset (kept drawing while it fades)
let lastSoundTime = 0; // when we last heard a real pitch
let rawWindow = []; // recent raw note numbers, for the median filter

// The rolling history of cents readings. Index 0 = newest (drawn at the
// top), last index = oldest (drawn at the bottom). `null` means "no pitch
// then", which shows up as a gap in the line.
const history = new Array(HISTORY_LEN).fill(null);

// Build the controls, then start listening. (No Start button — the browser
// still asks for microphone permission, which is the one prompt we can't skip.)
buildSettingsUI();
start();

// ---- Start -------------------------------------------------------------

async function start() {
  try {
    // 1) Request the mic. The browser pops up a permission prompt.
    //    We turn off "phone call" processing so we get the raw signal.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    statusEl.textContent =
      "Microphone blocked. Allow mic access, then reload the page.";
    return;
  }

  // 2) Build the audio graph:  microphone  ->  analyser
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(micStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 8192; // samples per read; a wide window steadies low notes (~186ms at 44.1kHz)
  source.connect(analyser);
  // NOTE: we deliberately do NOT connect to the speakers, otherwise you'd
  // hear your guitar echoed back with a delay.

  sampleBuffer = new Float32Array(analyser.fftSize);

  history.fill(null); // start with an empty chart
  drawTrace();
  resetReadout();

  running = true;
  update(); // start the loop
  resumeAudio(); // wake the audio engine (with a tap fallback if blocked)
}

// Browsers may start the audio engine "suspended" until the page sees a user
// gesture. Try to resume right away; if it's still blocked, resume on the
// first tap or key press anywhere on the page.
async function resumeAudio() {
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (e) {}
  }
  if (audioContext && audioContext.state === "suspended") {
    statusEl.textContent = "Tap anywhere to start listening…";
    const onGesture = async () => {
      try {
        await audioContext.resume();
      } catch (e) {}
      statusEl.textContent = "Listening… play a string.";
    };
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });
  } else {
    statusEl.textContent = "Listening… play a string.";
  }
}

// ---- The main loop: runs roughly 60 times per second ------------------

function update() {
  if (!running) return;
  rafId = requestAnimationFrame(update);

  // Copy the current waveform (time-domain samples, each from -1 to 1).
  analyser.getFloatTimeDomainData(sampleBuffer);

  const freq = autoCorrelate(sampleBuffer, audioContext.sampleRate);

  // Work out the note + cents for this frame (or null if there's no pitch).
  // We smooth the pitch in continuous "note-number" space (not cents), so the
  // smoothing — especially the median filter — works the same for BOTH
  // detectors and can reject a one-frame octave glitch instead of resetting.
  let cents = null;
  let midi = null;
  let displayFreq = 0;
  if (freq !== -1) {
    lastSoundTime = performance.now();

    // Continuous note number: 69 = A4 = 440 Hz, +12 per octave.
    const rawMidi = 12 * Math.log2(freq / A4) + 69;

    // Pick smoothing by pitch: low notes (noisier) get smoothed harder.
    // `t` ramps 0 (at/above HI_FREQ) -> 1 (at/below LO_FREQ).
    const t = Math.max(0, Math.min(1, (HI_FREQ - freq) / (HI_FREQ - LO_FREQ)));
    const alpha = settings.smoothing + t * (settings.lowSmoothing - settings.smoothing);
    const win = Math.round(
      settings.medianWindow + t * (settings.lowMedianWindow - settings.medianWindow)
    );

    // 1) Median filter: discard one-off spikes (a stray octave jump is a lone
    //    outlier among the recent readings, so the median ignores it).
    rawWindow.push(rawMidi);
    const cap = Math.max(settings.medianWindow, settings.lowMedianWindow);
    while (rawWindow.length > cap) rawWindow.shift();
    const medMidi = median(rawWindow.slice(-win));

    // 2) Snap to a real, sustained change (the median moved a lot); otherwise
    //    glide with an exponential moving average for a calm trace.
    if (
      smoothedMidi === null ||
      Math.abs(medMidi - smoothedMidi) > NOTE_SNAP_SEMITONES
    ) {
      smoothedMidi = medMidi;
    } else {
      smoothedMidi = smoothedMidi * (1 - alpha) + medMidi * alpha;
    }

    midi = Math.round(smoothedMidi);
    cents = (smoothedMidi - midi) * 100; // distance to the nearest note, in cents
    displayFreq = A4 * Math.pow(2, (smoothedMidi - 69) / 12);
    lastCents = cents;
  }

  const holdMs = settings.noteHold * 1000;
  const silentMs = performance.now() - lastSoundTime;

  if (cents !== null) {
    // playing: scroll the chart down one step, at full opacity
    history.unshift(cents);
    history.pop();
    drawTrace();
    renderReadout(midi, displayFreq, cents);
    setNoteOpacity(1);
  } else if (lastCents !== null && silentMs < holdMs) {
    // just stopped: keep the line moving, holding the last value constant,
    // and fade the whole note + chart out gradually over the hold window
    history.unshift(lastCents);
    history.pop();
    drawTrace();
    setNoteOpacity(1 - silentMs / holdMs);
  } else if (lastCents !== null) {
    // fully faded — clear the chart and note, ready for the next note
    resetReadout();
  }
}

// ---- Drawing -----------------------------------------------------------

// Turn the history buffer into a smooth SVG path. Each reading maps to:
//   x = cents -> 0..100 (50 = in tune, left = flat, right = sharp)
//   y = position in time, 0 at the top (now) down to 100 (oldest)
// A `null` reading breaks the line into a separate "run" so gaps aren't
// joined; each run is then drawn as a smooth curve (see smoothPath).
function drawTrace() {
  const runs = [];
  let run = [];
  for (let i = 0; i < HISTORY_LEN; i++) {
    const v = history[i];
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const x = 50 + Math.max(-50, Math.min(50, v));
    const y = (i / (HISTORY_LEN - 1)) * VIEW;
    run.push({ x, y });
  }
  if (run.length) runs.push(run);

  let d = "";
  for (const pts of runs) d += smoothPath(pts);
  traceLineEl.setAttribute("d", d);
}

// Median of a short array — used to drop one-off spikes before averaging.
function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Draw a run of points as a smooth curve using a Catmull-Rom spline,
// converted to the cubic Bézier ("C") commands that SVG understands.
function smoothPath(pts) {
  if (pts.length === 1) {
    // a lone reading: a zero-length segment renders as a dot (round cap)
    const p = pts[0];
    const xy = p.x.toFixed(2) + " " + p.y.toFixed(2);
    return "M" + xy + " L" + xy + " ";
  }
  let d = "M" + pts[0].x.toFixed(2) + " " + pts[0].y.toFixed(2) + " ";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d +=
      "C" + cp1x.toFixed(2) + " " + cp1y.toFixed(2) + " " +
      cp2x.toFixed(2) + " " + cp2y.toFixed(2) + " " +
      p2.x.toFixed(2) + " " + p2.y.toFixed(2) + " ";
  }
  return d;
}

// Update the note name, frequency, and the bubble at the head of the trace.
function renderReadout(midi, freq, cents) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]; // safe modulo
  noteNameEl.innerHTML = name.replace("#", "&sharp;");
  noteOctaveEl.textContent = Math.floor(midi / 12) - 1;
  frequencyEl.textContent = freq.toFixed(1) + " Hz";

  // The bubble rides left/right to match the newest reading.
  const clamped = Math.max(-50, Math.min(50, cents));
  bubbleEl.style.left = 50 + clamped + "%";

  const inTune = Math.abs(cents) <= settings.inTuneCents;
  chartEl.classList.toggle("in-tune", inTune);

  // In tune → green check (GuitarTuna-style); otherwise show the cents offset.
  const rounded = Math.round(cents);
  centsBubbleEl.textContent = inTune ? "✓" : (rounded > 0 ? "+" : "") + rounded;

  // The direction pill is hidden by CSS when in tune, so only the off text shows.
  directionPillEl.textContent = cents < 0 ? "Tune up" : "Tune down";
}

// Fade the note + bubble + chart together (0 = gone, 1 = solid). Driven
// per-frame from the loop so the fade stays in sync with the moving line.
function setNoteOpacity(v) {
  readoutEl.style.opacity = v;
  bubbleEl.style.opacity = v;
  traceEl.style.opacity = v;
}

// Clear everything back to the resting (blank) state — used on start / stop
// and once the fade has fully completed.
function resetReadout() {
  noteNameEl.innerHTML = "&mdash;";
  noteOctaveEl.textContent = "";
  frequencyEl.textContent = "0.0 Hz";
  chartEl.classList.remove("in-tune");
  history.fill(null);
  drawTrace();
  setNoteOpacity(0);
  lastCents = null;
  smoothedMidi = null;
  rawWindow = [];
}

// ---- Settings panel ----------------------------------------------------

// Generate the algorithm selector + one slider per entry in CONTROLS, and
// wire each control so moving it updates the live `settings` object.
function buildSettingsUI() {
  algoSelectEl.value = settings.algorithm;
  algoSelectEl.addEventListener("change", () => {
    settings.algorithm = algoSelectEl.value;
    updateControlStates();
  });

  for (const ctrl of CONTROLS) {
    const row = document.createElement("label");
    row.className = "setting";
    if (ctrl.mpmOnly) row.dataset.mpmOnly = "true";

    const name = document.createElement("span");
    name.className = "setting-label";
    name.textContent = ctrl.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = ctrl.min;
    input.max = ctrl.max;
    input.step = ctrl.step;
    input.value = settings[ctrl.key];

    const value = document.createElement("span");
    value.className = "setting-value";
    value.textContent = formatValue(settings[ctrl.key], ctrl);

    input.addEventListener("input", () => {
      const v = ctrl.int ? parseInt(input.value, 10) : parseFloat(input.value);
      settings[ctrl.key] = v;
      value.textContent = formatValue(v, ctrl);
    });

    row.append(name, input, value);
    slidersEl.appendChild(row);
  }

  updateControlStates();
}

function formatValue(v, ctrl) {
  return ctrl.int ? String(v) : v.toFixed(2);
}

// Grey out (and disable) the MPM-only sliders when the classic algorithm
// is selected, so it's clear they have no effect.
function updateControlStates() {
  const classic = settings.algorithm !== "mpm";
  slidersEl.querySelectorAll('[data-mpm-only="true"]').forEach((row) => {
    row.classList.toggle("disabled", classic);
    const input = row.querySelector("input");
    if (input) input.disabled = classic;
  });
}

// ---- Pitch detection --------------------------------------------------
//
//  Two detectors; settings.algorithm picks which one update() uses.
//    "classic" — the original autocorrelation (takes the tallest peak).
//    "mpm"     — McLeod Pitch Method (normalized, octave-safe, DC-removed).

function autoCorrelate(buf, sampleRate) {
  return settings.algorithm === "mpm"
    ? autoCorrelateMPM(buf, sampleRate)
    : autoCorrelateClassic(buf, sampleRate);
}

// --- Classic autocorrelation (the original algorithm) ------------------
//  Slide a copy of the wave over itself; it lines up best when shifted by
//  one period. Take the tallest peak as that period, then
//  frequency = sampleRate / period. Simple, but can jump an octave on
//  mid-range notes. Returns -1 when too quiet to trust.
function autoCorrelateClassic(buf, sampleRate) {
  const SIZE = buf.length;

  // 1) Loudness gate: bail if too quiet.
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

  // 2) Trim near-silent edges so the autocorrelation is cleaner.
  let start = 0;
  let end = SIZE - 1;
  const trimThreshold = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < trimThreshold) {
      start = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < trimThreshold) {
      end = SIZE - i;
      break;
    }
  }
  const trimmed = buf.slice(start, end);
  const n = trimmed.length;

  // We only need lags up to the period of the lowest note we care about.
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / MIN_FREQ));

  // 3) Autocorrelation: for each lag, how well does the signal match a copy
  //    of itself shifted by that lag?
  const c = new Array(maxLag + 1).fill(0);
  for (let lag = 0; lag <= maxLag; lag++) {
    for (let i = 0; i < n - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  // 4) Skip the first downward slope, then take the tallest peak.
  let d = 0;
  while (d < maxLag && c[d] > c[d + 1]) d++;
  let maxVal = -1;
  let peak = -1;
  for (let i = d; i <= maxLag; i++) {
    if (c[i] > maxVal) {
      maxVal = c[i];
      peak = i;
    }
  }
  if (peak <= 0) return -1;

  // 5) Parabolic interpolation for sub-sample accuracy.
  let T0 = peak;
  if (peak < maxLag) {
    const x1 = c[peak - 1];
    const x2 = c[peak];
    const x3 = c[peak + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = peak - b / (2 * a);
  }

  return sampleRate / T0;
}

// --- McLeod Pitch Method (the newer algorithm) -------------------------
//  Normalizes the similarity score to ~[-1, 1] and picks the FIRST strong
//  peak (the fundamental), which avoids octave jumps. Removes the DC offset
//  first so detection doesn't blink in and out. Returns -1 when there's no
//  clear pitch.
function autoCorrelateMPM(buf, sampleRate) {
  const SIZE = buf.length;

  // Remove the DC offset (mic bias / slow drift).
  let mean = 0;
  for (let i = 0; i < SIZE; i++) mean += buf[i];
  mean /= SIZE;
  for (let i = 0; i < SIZE; i++) buf[i] -= mean;

  // Prefix sums of squares -> O(1) "energy" over any range (for normalizing).
  const sq = new Array(SIZE + 1);
  sq[0] = 0;
  for (let i = 0; i < SIZE; i++) sq[i + 1] = sq[i] + buf[i] * buf[i];

  // Loudness gate: ignore near-silence.
  const rms = Math.sqrt(sq[SIZE] / SIZE);
  if (rms < 0.01) return -1;

  // Search only the lag range that maps to real guitar pitches.
  const minLag = Math.max(1, Math.floor(sampleRate / MAX_FREQ));
  const maxLag = Math.min(SIZE - 1, Math.ceil(sampleRate / MIN_FREQ));

  // Normalized Square Difference Function: ~[-1, 1] periodicity score.
  const nsdf = new Array(maxLag + 1).fill(0);
  for (let lag = 0; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < SIZE - lag; i++) corr += buf[i] * buf[i + lag];
    const energy = sq[SIZE - lag] + (sq[SIZE] - sq[lag]);
    nsdf[lag] = energy > 0 ? (2 * corr) / energy : 0;
  }

  // Tallest local maximum in range — sets the acceptance threshold.
  let globalMax = 0;
  for (let i = minLag; i < maxLag; i++) {
    if (nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1] && nsdf[i] > globalMax) {
      globalMax = nsdf[i];
    }
  }
  if (globalMax < settings.clarityThreshold) return -1; // not clearly periodic

  // First local maximum that's at least peakRatio of the tallest = fundamental.
  const threshold = settings.peakRatio * globalMax;
  let peak = -1;
  for (let i = minLag; i < maxLag; i++) {
    if (nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1] && nsdf[i] >= threshold) {
      peak = i;
      break;
    }
  }
  if (peak < 1) return -1;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  let T0 = peak;
  if (peak > minLag && peak < maxLag) {
    const x1 = nsdf[peak - 1];
    const x2 = nsdf[peak];
    const x3 = nsdf[peak + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = peak - b / (2 * a);
  }

  return sampleRate / T0;
}
