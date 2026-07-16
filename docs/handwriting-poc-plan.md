# Handwriting Recognizer Proof-Of-Concept Plan

## Status

This proof of concept validates the riskiest mobile-client requirement: whether
finger-written one-to-three-digit numbers can be recognized and committed in a
fast, satisfying browser interaction. It deliberately excludes room networking.

The final product plan is maintained in
[mobile-client-product-plan.md](mobile-client-product-plan.md).

Checklist convention:

- `[x]` means the requirement or decision is settled.
- `[ ]` means implementation or verification remains.

## Outcome

Produce a standalone mobile web page where a user can write a number, see a
deck-valid result commit through an ink-to-number animation, see invalid or
uncertain input disappear appropriately, and clear a committed number to try
again.

The proof succeeds only if the complete path works on physical iOS and Android
devices. Synthetic model accuracy alone is insufficient.

## Requirements

### Input

- [x] Use a fullscreen drawing surface optimized for portrait phones.
- [x] Support finger, stylus, and mouse input.
- [x] Support canonical unsigned integers from `0` through `999`.
- [x] Do not support signs, decimal separators, fractions, or written words.
- [x] Store input as strokes containing ordered `x`, `y`, and timestamp values.
- [x] Store pressure and pointer type when available, but do not require them.
- [x] Derive velocity from position and time when rendering needs it.
- [x] Use coalesced Pointer Events when available and fall back to the dispatched
  event when they are not.
- [x] Prevent page scrolling, selection, callouts, and browser gestures from
  interrupting normal drawing inside the pad.

### Recognition And Finish Detection

- [x] Recognition runs automatically after the user pauses.
- [x] A confident recognized number commits automatically when it occurs in the
  current mock deck.
- [x] The UI never presents a low-confidence candidate for confirmation.
- [x] Low-confidence input dissipates after the inactivity grace period.
- [x] Confident input outside the deck shakes and then disappears.
- [x] Rejection is never immediate after a stroke; the user can add strokes that
  change an incomplete digit or number.
- [x] Exact values that prefix longer deck cards receive a longer wait.
- [x] Proper prefixes receive a longer wait without being rejected.
- [x] Any new `pointerdown` cancels pending inference effects and timers.
- [x] Stale inference responses cannot change the current input.

Initial timing targets:

| Situation | Quiet period before action |
| --- | ---: |
| Valid card, not a longer-card prefix | 650-700 ms |
| Valid card and longer-card prefix | about 1,000 ms |
| Proper prefix only | about 1,100 ms |
| Invalid or low confidence | about 1,100 ms |

These values are tuning defaults, not protocol guarantees.

### Committed And Rejected States

- [x] A committed result is displayed as a large typeset number.
- [x] The original trace settles, contracts, or dissolves into that number.
- [x] A clear button removes the committed number and restores the empty pad.
- [x] Scratch-out-to-clear is not included in the proof of concept.
- [x] Invalid input shakes before fading.
- [x] Low-confidence input fades without a shake or claimed result.
- [x] Visual feedback is complete without haptics.
- [x] Android vibration may be added as progressive enhancement.
- [x] Programmable iOS haptics are not expected in the web proof.

### Mock Deck

- [x] Use the server's default deck for commit validation:
  `1`, `2`, `3`, `5`, `8`, `13`, and `☕`.
- [x] Only numeric cards are recognized by handwriting.
- [x] Keep recognition output visible in diagnostics even when deck validation
  rejects it.
- [x] Do not implement the deck picker in this proof.

## Technology Decisions

- [x] Use React, TypeScript, and Vite in `web-client/`.
- [x] Keep high-frequency point capture and drawing outside React state.
- [x] Use Canvas 2D for visible ink and offscreen recognition rasterization.
- [x] Use a Web Worker for model initialization and inference.
- [x] Use ONNX Runtime Web's WASM-only import.
- [x] Use one WASM thread to avoid cross-origin-isolation requirements.
- [x] Do not require WebGPU or WebGL.
- [x] Self-host the model and matching ONNX Runtime assets.
- [x] Use Vitest for deterministic TypeScript unit tests.
- [x] Use `uv` for reproducible Python model tooling.
- [x] Do not add Rust/WASM or restructure the existing Rust package in this proof.

## Model Decision

Fine-tune the Apache-2.0 CRNN Tiny model from
[`zjykzj/crnn-ctc`](https://github.com/zjykzj/crnn-ctc), starting from the
`crnn_tiny-emnist.pth` checkpoint published with release
[`v1.3.0`](https://github.com/zjykzj/crnn-ctc/releases/tag/v1.3.0).

- [x] Architecture: convolutional feature extractor, two-layer bidirectional GRU,
  linear classifier, and CTC decoding.
- [x] Output alphabet: `0` through `9` plus CTC blank.
- [x] Published checkpoint size: approximately 1.7 MB.
- [x] Published input: grayscale `32x160` images containing five digits.
- [x] Proof input: grayscale `32x128` images containing one to three digits.
- [x] Reuse the checkpoint because model weights do not depend on the horizontal
  sequence length.
- [x] Export a static batch-one ONNX model after fine-tuning.
- [x] Do not use `thawro/yolov8-digits-detection` in the proof.

Model contract:

```text
Input name: input
Input type: float32
Input shape: [1, 1, 32, 128]
Input range: 0.0 to 1.0
Polarity: white ink on black
Output name: output
Output shape: [1, time, 11]
Classes: 0-9, blank at index 10
```

## Training Data Plan

Use the NIST-hosted EMNIST Digits dataset, which contains 280,000 balanced
single-digit images. Multi-digit samples are generated dynamically rather than
collected from users.

### Label Generation

- [x] Choose sequence length uniformly from one, two, or three.
- [x] Generate canonical labels without leading zeroes except for `0` itself.
- [x] Sample one-digit labels from `0-9`.
- [x] Sample two-digit labels from `10-99`.
- [x] Sample three-digit labels from `100-999`.
- [x] Include repeated digits naturally, including `11`, `100`, and `888`.
- [x] Balance sequence lengths so three-digit samples do not dominate.

### Glyph And Sequence Augmentation

- [x] Select a separate EMNIST glyph for every digit.
- [x] Apply mild independent rotation, scaling, translation, and shear.
- [x] Vary stroke thickness with restrained morphology operations.
- [x] Vary digit baseline and vertical scale.
- [x] Vary inter-digit spacing and allow slight overlap.
- [x] Vary complete-sequence scale and horizontal placement within `32x128`.
- [x] Keep a clean black background because the target is a drawing canvas, not a
  photographed document.
- [x] Avoid augmentation that changes the digit's semantic identity.

### Data Separation

- [x] Build training compositions only from official EMNIST training glyphs.
- [x] Split official EMNIST test glyphs into disjoint validation and final-test
  pools.
- [x] Use fixed seeds for validation and test composition manifests.
- [x] Never use a validation/test glyph in training.
- [x] Do not collect, upload, or persist application-user handwriting.

### Initial Training Run

- [x] Initialize from the published CRNN Tiny checkpoint.
- [x] Generate 100,000 training compositions per epoch.
- [x] Begin with 10 fine-tuning epochs and a learning rate around `1e-4`.
- [x] Save the checkpoint with the best validation exact-match accuracy.
- [x] Report exact-match accuracy by sequence length and for repeated digits.
- [ ] Measure local CPU training throughput before changing batch or epoch counts.
- [ ] Tune augmentation only in response to documented evaluation failures.

## Browser Recognition Pipeline

### Capture And Visible Rendering

- [ ] Capture Pointer Events and coalesced points into stroke objects.
- [ ] Use pointer capture until `pointerup` or `pointercancel`.
- [ ] Smooth visible traces with quadratic or equivalent interpolated curves.
- [ ] Derive a restrained visible line-width response from filtered velocity.
- [ ] Handle device-pixel ratio without changing logical stroke coordinates.
- [ ] Verify iOS gesture suppression on a physical device.

### Recognition Raster

- [ ] Compute a bounding box over all current stroke points.
- [ ] Reject empty and trivially small accidental input before inference.
- [ ] Add proportional padding around the ink.
- [ ] Preserve the complete drawing's aspect ratio.
- [ ] Fit the drawing inside approximately `120x26` model pixels.
- [ ] Center it on a black `128x32` raster.
- [ ] Render white strokes with fixed model width, round caps, and round joins.
- [ ] Convert pixels to row-major NCHW `Float32Array` in the range `0.0-1.0`.
- [ ] Expose the exact model raster in diagnostic mode.

### Inference And Decoding

- [ ] Load ONNX Runtime and the model once in a worker.
- [ ] Surface loading progress and initialization failures to the page.
- [ ] Transfer tensors rather than copying large canvas state unnecessarily.
- [ ] Run the batch-one ONNX session through the WASM execution provider.
- [ ] Implement CTC greedy decoding as a correctness baseline.
- [ ] Implement a small CTC prefix beam for alternatives and confidence margin.
- [ ] Return text, confidence, alternatives, and inference duration.
- [ ] Discard responses whose request ID is no longer current.

Recognizer interface:

```ts
type Recognition = {
  text: string;
  confidence: number;
  alternatives: Array<{
    text: string;
    score: number;
  }>;
  inferenceMs: number;
};
```

### Confidence

- [x] Confidence is used only for automatic acceptance or dismissal.
- [x] Normal UI does not show alternatives or ask the user to choose one.
- [ ] Select an initial threshold against held-out synthetic test data.
- [ ] Display raw scores, top alternatives, and threshold result in diagnostics.
- [ ] Re-evaluate the threshold using manual canvas tests on target devices.
- [ ] Prefer false rejection over a wrong automatic commit.

## Interaction State Machine

```text
loading -> empty -> drawing -> settling -> committing -> committed
                                |              |
                                -> rejecting   -> empty
committed -> clearing -> empty
```

- [ ] Represent transitions as explicit reducer events.
- [ ] Keep exactly one inactivity deadline for the current drawing revision.
- [ ] Increment the drawing revision on every added stroke and clear.
- [ ] Cancel deadlines when drawing resumes.
- [ ] Prevent model completion from committing an old revision.
- [ ] Apply prefix-aware timing using the mock deck.
- [ ] Prevent drawing while the committed state is visible.

## Animation Plan

- [ ] Keep the original vector trace until its transition completes.
- [ ] On commit, subtly tighten or scale the trace toward the result's center.
- [ ] Crossfade the trace into a clean typeset number.
- [ ] Add a restrained landing scale/easing to the typeset result.
- [ ] On invalid input, shake the trace horizontally and then fade it.
- [ ] On low confidence, fade or disperse without a shake.
- [ ] On clear, remove the committed number and restore the drawing surface.
- [ ] Ensure animations cannot complete against a newer drawing revision.
- [ ] Provide a reduced-motion variant.

## Diagnostics

Diagnostic mode should be available through a development control or query
parameter and must not alter recognition behavior.

- [ ] Display model readiness and initialization errors.
- [ ] Display raw stroke and point counts.
- [ ] Display the normalized `32x128` input raster enlarged with nearest-neighbor
  scaling.
- [ ] Display predicted text, confidence, alternatives, and inference time.
- [ ] Display current interaction state, drawing revision, and timer reason.
- [ ] Allow the mock numeric deck and confidence threshold to be adjusted in
  diagnostics.

## Proposed Project Layout

```text
web-client/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   ├── models/digits-crnn.onnx
│   └── ort/
└── src/
    ├── ink/
    │   ├── capture.ts
    │   ├── render.ts
    │   ├── rasterize.ts
    │   └── types.ts
    ├── recognition/
    │   ├── client.ts
    │   ├── ctc.ts
    │   ├── worker.ts
    │   └── types.ts
    ├── poc/
    │   ├── RecognitionPad.tsx
    │   ├── recognition-state.ts
    │   └── Diagnostics.tsx
    ├── App.tsx
    └── styles.css

ml/digits/
├── pyproject.toml
├── dataset.py
├── model.py
├── train.py
├── evaluate.py
├── export.py
├── tests/
└── README.md
```

## Implementation Checklist

### Scaffold

- [ ] Create the Vite React TypeScript project in `web-client/`.
- [ ] Add formatting, linting, Vitest, and production build scripts.
- [ ] Add web artifacts to `.gitignore`.
- [ ] Add a dedicated web CI job without changing native release behavior.

### Model Tooling

- [ ] Create the `ml/digits/` `uv` project.
- [ ] Add model and checkpoint attribution notices.
- [ ] Implement deterministic sequence generation and unit tests.
- [ ] Load the published CRNN Tiny checkpoint.
- [ ] Fine-tune and evaluate the variable-length model.
- [ ] Export ONNX at a documented opset.
- [ ] Verify PyTorch and ONNX Runtime output parity.
- [ ] Record model checksum, source revision, metrics, and training configuration.

### Web Integration

- [ ] Implement stroke capture and visible rendering.
- [ ] Implement deterministic rasterization with snapshot fixtures.
- [ ] Add ONNX Runtime WASM assets and the inference worker.
- [ ] Implement CTC decoding and confidence diagnostics.
- [ ] Implement finish detection and the interaction reducer.
- [ ] Implement commit, rejection, and clear animations.
- [ ] Add the mock deck and diagnostic controls.

### Verification

- [ ] Unit-test CTC collapse, repeated digits, and blank handling.
- [ ] Unit-test bounding-box, padding, scaling, and pixel polarity.
- [ ] Unit-test state transitions with fake timers and stale inference responses.
- [ ] Verify production Vite asset paths for model, worker, `.mjs`, and `.wasm`.
- [ ] Test desktop mouse input.
- [ ] Test physical iPhone Safari input and lifecycle.
- [ ] Test physical Android Chrome input and lifecycle.
- [ ] Record cold load, warm inference median, and warm inference p95.

## Acceptance Gates

### Model Gates

- [ ] Overall exact-match accuracy is at least 98% on generated held-out data.
- [ ] No one-, two-, or three-digit length bucket is below 97% exact match.
- [ ] Repeated-digit results are reported separately and meet the same 97% floor.
- [ ] ONNX inference matches PyTorch decoding on committed fixtures.

### Browser Gates

- [ ] Warm inference p95 is below 100 ms on representative target phones.
- [ ] The UI does not visibly stall while inference runs.
- [ ] The default numeric deck values can each be entered repeatedly on iOS and
  Android with acceptable first-attempt recognition.
- [ ] Multi-stroke digits are not rejected before the inactivity grace period.
- [ ] Adding a stroke during settling never commits the prior partial number.
- [ ] Invalid values wait, shake, and clear without submitting anything.
- [ ] Low-confidence values disappear without showing a correction workflow.
- [ ] Clear always returns to a fully usable empty pad.
- [ ] No handwriting data leaves the browser.

### Exit Decision

- [ ] Accept CRNN Tiny and its preprocessing for the product build, or document
  concrete failing samples and reject it.
- [ ] If rejected, determine whether the failure is rasterization, synthetic-data
  domain mismatch, model capacity, or confidence calibration before selecting a
  replacement.
- [ ] Do not begin Rust/WASM room integration until the recognizer exit decision
  is recorded.

## Non-Goals

- [x] No WebSocket or server connection.
- [x] No QR code generation or room URL routing.
- [x] No Rust crate restructuring or browser WASM poker client.
- [x] No name generation, persistence, or session resumption.
- [x] No reveal, reset, average, distribution, or exact-vote views.
- [x] No deck picker implementation.
- [x] No special-card handwriting recognition.
- [x] No decimal, fraction, sign, or number-word recognition.
- [x] No scratch-out clear gesture.
- [x] No iOS native wrapper or guaranteed iOS haptics.
- [x] No model personalization or user handwriting collection.
- [x] No custom ONNX Runtime minimal build until normal WASM payload and latency
  have been measured.
- [x] No installable PWA or offline application shell.

## Risks

- [ ] EMNIST glyphs come from scanned handwriting rather than phone finger input;
  normalization and augmentation may not close the domain gap.
- [ ] Synthetic stitching does not preserve correlations between digits written
  by the same person.
- [ ] The published model's confidence may be overconfident on unfamiliar canvas
  input.
- [ ] The general ONNX Runtime WASM payload may dominate cold-load time despite
  the small model.
- [ ] iOS browser gesture handling may still produce `pointercancel` on edge-case
  interactions and must be tested physically.
- [ ] A visually expressive variable-width trace may differ from the fixed-width
  recognition raster; both must remain geometrically faithful to the same input.

## References

- CRNN Tiny source and checkpoint:
  <https://github.com/zjykzj/crnn-ctc/releases/tag/v1.3.0>
- EMNIST dataset:
  <https://www.nist.gov/itl/products-and-services/emnist-dataset>
- ONNX Runtime Web deployment:
  <https://onnxruntime.ai/docs/tutorials/web/deploy.html>
- Pointer Events specification:
  <https://www.w3.org/TR/pointerevents3/>
