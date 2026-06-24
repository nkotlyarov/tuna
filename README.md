# Chromatic Tuner (web)

A minimal, browser-based chromatic guitar tuner — play any string and it
auto-detects the closest note and shows how far off you are on a **vertical
pitch chart**. No backend, no build step, no dependencies.

![mode: chromatic](https://img.shields.io/badge/mode-chromatic-1dd3b0)

## Run it

The microphone only works on a **secure context** (`https://` or
`http://localhost`). Opening the file directly (`file://...`) will *not* get
mic permission in Chrome. So serve it over localhost — the simplest way uses
Python, which you already have:

```bash
cd /Users/nikita.kotlyarov/code/guitartuna-clone
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser, **allow the microphone**
when prompted, and play a single string — it starts listening on its own
(no button). The permission prompt is the one step the browser won't let us
skip.

> Tip: use Chrome or Edge. Safari also works but is pickier about mic
> permissions.

## How to read the display

| Element            | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| Big letter         | The closest musical note it heard (e.g. `E`, `A`, `G♯`).       |
| Small number       | The octave (low E on a guitar is `E2`, high E is `E4`).        |
| `Hz` line          | The exact detected frequency.                                  |
| Center line        | Perfectly in tune (0 cents).                                   |
| Orange trace       | Your pitch over the last ~2 seconds. Newest is at the top and it scrolls down. Left of center = flat, right = sharp. |
| Bubble at the top  | The current reading; slides left/right with your pitch.        |
| Cents bubble       | How far off, in *cents* (100 cents = one semitone).            |
| Color              | Red = off, green = within ±5 cents (in tune).                  |
| Hint               | `Tune up` (string too low) / `Tune down` (too high) / `In tune`.|

Standard 6-string guitar targets, low to high: **E2 · A2 · D3 · G3 · B3 · E4**.

## Settings (tune it live)

Open **Settings** at the bottom of the app to change things without editing
code or reloading:

- **Algorithm** — switch between *Classic autocorrelation* and *McLeod
  (octave-safe)*. The McLeod-only sliders grey out under Classic.
- **Smoothing · high / low notes** — how much the trace is averaged. Lower =
  smoother but laggier. Low notes are noisier, so they get their own value.
- **Median window · high / low** — spike rejection (drops one-off glitches).
- **Clarity threshold** *(McLeod)* — how "periodic" a sound must be to count
  as a pitch. Lower if notes drop out; raise if noise registers.
- **Peak ratio** *(McLeod)* — octave-jump guard. Raise toward `0.95` if a
  note reads an octave high; lower toward `0.85` if it reads an octave low.
- **In-tune range (±cents)** — how close counts as "in tune" (green).

Changes aren't saved — reloading resets everything to defaults.

## How it works (the 30-second tour)

All four steps run in the browser:

1. **Microphone** — `getUserMedia` asks for mic access.
2. **Read the wave** — the Web Audio `AnalyserNode` hands us ~8192 raw
   samples of the sound wave about 60 times per second (a wide window so low
   strings, which have long, slow waves, are detected reliably).
3. **Find the pitch** — `autoCorrelate()` estimates the fundamental frequency
   from the waveform. Two detectors are built in, chosen by `PITCH_ALGORITHM`
   in `tuner.js`: `"classic"` (original autocorrelation) and `"mpm"` (the
   octave-safe McLeod Pitch Method). Then `frequency = sampleRate / period`.
4. **Convert + plot** — frequency becomes a note number, then a name +
   octave + cents offset. Each frame's offset is pushed onto a rolling
   buffer (~2s) and drawn as a trace that scrolls down the chart over time.

## Files

| File         | What it does                                          |
| ------------ | ----------------------------------------------------- |
| `index.html` | Page structure (the readout, chart, button).          |
| `styles.css` | Dark theme + the vertical chart layout.               |
| `tuner.js`   | Mic access, pitch detection, and all the drawing.     |

## Limitations / ideas to extend

- Autocorrelation is built for **one note at a time** (monophonic) — strum a
  full chord and the reading will jump around. That's expected for a tuner.
- Quiet or non-musical input is ignored, via two gates: an `rms` loudness
  check and (for McLeod) a clarity check. If a held note blinks in and out,
  lower **Clarity threshold** in Settings.
- Smoothing is **frequency-aware**: low strings (harder to detect) are
  smoothed more than high ones. The **Smoothing** and **Median window**
  sliders in Settings have separate high/low values — for a calmer low E,
  lower *Smoothing · low notes*.
- Possible next steps: a reference-pitch tone to play along to, selectable A4
  (e.g. 432 Hz), or preset string targets with names.
