// Fully-offline computer-vision engine for automatic palm-line measurement.
// No network dependency, no ML model — pure pixel math (grayscale, contrast
// stretch, Sobel edge detection) run on a user-aligned crop of their photo.
// Honesty note: this measures line length/curvature/continuity from real
// pixels within a region the USER frames (drag-to-align), which is a real
// automation upgrade over Phase 1's blind self-report questions — but it is
// NOT the same as a trained ML model finding a hand anywhere in an arbitrary
// photo. Two questions (heartStart, mount) genuinely require knowing which
// finger is which, which pixel-edge analysis alone cannot determine reliably,
// so those stay manual-only by design (see ANALYZABLE_QUESTIONS below).
//
// Second honesty note (found via synthetic testing, see test-cv-engine.js):
// every real palm has all four lines in the same photo at once, and their
// scan zones can be genuinely adjacent (e.g. the life line's starting point
// near the thumb web sits close to the heart line's zone). A single-line
// horizontal/vertical tracer can be nudged by a real crossing there — it is
// NOT the same failure as the "false branch from a 1px noise gap" bug that
// WAS fixed (see minSegmentRun below); this is inherent to tracing one line
// at a time instead of segmenting the whole hand. The UI surfaces these as
// editable suggestions with a confidence score for exactly this reason —
// they are a starting point for the user to confirm or correct, not a final
// answer.

const ANALYZABLE_QUESTIONS = ["lifeLength", "lifeDepth", "heartShape", "headShape", "fate"];

// ---- Core image ops. `img` = { data: Uint8ClampedArray|Array (RGBA), width, height } ----

function toGrayscaleContrastStretched(img) {
  const { data, width, height } = img;
  const gray = new Float32Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let p = 0; p < gray.length; p++) gray[p] = ((gray[p] - min) / range) * 255;
  return gray;
}

// Sobel edge magnitude map.
function sobelMagnitude(gray, width, height) {
  const mag = new Float32Array(width * height);
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sx = 0, sy = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, k++) {
          const v = gray[(y + dy) * width + (x + dx)];
          sx += v * gx[k];
          sy += v * gy[k];
        }
      }
      mag[y * width + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return mag;
}

function meanStd(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let sq = 0;
  for (let i = 0; i < arr.length; i++) sq += (arr[i] - mean) * (arr[i] - mean);
  return { mean, std: Math.sqrt(sq / arr.length) };
}

// ---- Zone measurement helpers ----

// Horizontal band scan (used for heart/head lines): find the row with peak
// edge density, then characterize its length/slope/continuity.
function analyzeHorizontalBand(mag, width, height, rowStart, rowEnd, threshold) {
  let bestRow = rowStart, bestCount = -1;
  for (let y = rowStart; y < rowEnd; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (mag[y * width + x] > threshold) count++;
    if (count > bestCount) { bestCount = count; bestRow = y; }
  }
  // Trace the line by following LOCAL continuity from wherever it was last seen,
  // rather than independently picking the strongest edge within a fixed window of
  // the single global bestRow at every column. Two reasons:
  //  1. A wide fixed window is needed to capture real curvature (a tight window
  //     clips points off a curved line, biasing curviness toward "straight" no
  //     matter how curved the real line is) — but a wide *independent* search at
  //     every column also happily latches onto a nearby, unrelated, stronger edge
  //     (e.g. another palm line crossing through this same row band), corrupting
  //     the trace. Every real palm has all four lines in the photo at once, so
  //     this isn't a rare edge case.
  //  2. Local continuity tracking gets the best of both: a generous re-acquire
  //     window when the line has just been lost (so curvature is still captured),
  //     but a tight follow window while actively tracking (so a nearby crossing
  //     line has to be very close to hijack the trace, and even then only for as
  //     long as the crossing itself lasts).
  const points = [];
  const wideTol = Math.max(3, Math.round(height * 0.1));
  const followTol = Math.max(2, Math.round(height * 0.035));
  const maxGapToKeepTracking = Math.max(4, Math.round(width * 0.04));
  let lastY = null, lastX = null;
  for (let x = 0; x < width; x++) {
    const anchor = lastY !== null && x - lastX <= maxGapToKeepTracking ? lastY : bestRow;
    const tol = lastY !== null && x - lastX <= maxGapToKeepTracking ? followTol : wideTol;
    let best = -1, bestY = -1;
    for (let dy = -tol; dy <= tol; dy++) {
      const y = anchor + dy;
      if (y < 0 || y >= height) continue;
      const v = mag[y * width + x];
      if (v > threshold && v > best) { best = v; bestY = y; }
    }
    if (bestY >= 0) { points.push([x, bestY]); lastY = bestY; lastX = x; }
  }
  if (points.length < width * 0.05) {
    return { coverage: points.length / width, slope: 0, curviness: 0, segments: 0 };
  }
  // Longest contiguous run (coverage / continuity) + segment count (branch proxy).
  // A "segment break" must be a real loss of the line — a gap bigger than what the
  // tracker above already bridges (maxGapToKeepTracking) — not just a stray missed
  // pixel or a couple of columns of anti-aliasing/noise. Using the same threshold
  // here as the tracker uses to re-acquire keeps the two consistent: if the tracker
  // followed through a gap, it isn't a "break" for branch-counting purposes either.
  // Each candidate segment also has to be a meaningful run (not a 1-2px blip) to
  // count, so a single noisy pixel near a crossing can't manufacture a fake branch.
  const minSegmentRun = Math.max(3, Math.round(width * 0.03));
  let runs = 0, longestRun = 0, curRun = 0, prevX = null, countedRuns = 0;
  for (const [x] of points) {
    if (prevX !== null && x - prevX > maxGapToKeepTracking) {
      if (curRun >= minSegmentRun) countedRuns++;
      curRun = 0;
    }
    curRun++;
    longestRun = Math.max(longestRun, curRun);
    prevX = x;
  }
  if (curRun >= minSegmentRun) countedRuns++;
  runs = Math.max(1, countedRuns);
  // Linear regression slope (y as function of x) for straight-vs-steep.
  const n = points.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = (n * sxx - sx * sx) || 1;
  const slope = (n * sxy - sx * sy) / denom; // px of y-drop per px of x
  // Curviness: residual deviation from the regression line (captures curve vs straight).
  const meanX = sx / n, meanY = sy / n;
  let residSq = 0;
  for (const [x, y] of points) {
    const pred = meanY + slope * (x - meanX);
    residSq += (y - pred) * (y - pred);
  }
  const curviness = Math.sqrt(residSq / n) / height; // normalized 0-ish..0.3
  // `slope` (Δy/Δx from the regression) is already a dimensionless ratio — do NOT
  // divide by height again here. (An earlier version did, which shrank it ~500x
  // and made the "steep" classification unreachable for any real line.)
  return { coverage: longestRun / width, slope, curviness, segments: runs };
}

// Vertical strip scan (used for fate line): continuity down the center.
function analyzeVerticalStrip(mag, width, height, colStart, colEnd, threshold) {
  let bestCol = colStart, bestCount = -1;
  for (let x = colStart; x < colEnd; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) if (mag[y * width + x] > threshold) count++;
    if (count > bestCount) { bestCount = count; bestCol = x; }
  }
  const tol = Math.max(2, Math.round(width * 0.03));
  let present = 0;
  for (let y = 0; y < height; y++) {
    let found = false;
    for (let dx = -tol; dx <= tol; dx++) {
      const x = bestCol + dx;
      if (x < 0 || x >= width) continue;
      if (mag[y * width + x] > threshold) { found = true; break; }
    }
    if (found) present++;
  }
  return { continuity: present / height };
}

// Arc scan (used for life line): quarter-ellipse from top-left to bottom-center,
// approximating the curve around the thumb base.
function analyzeArc(mag, width, height, threshold) {
  const samples = 100;
  let hits = 0, strengthSum = 0, lastHit = -1, maxGap = 0, gapCount = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    // Quarter ellipse: x from ~0.08*w to ~0.5*w, y from ~0.05*h to ~0.95*h.
    const x = Math.round(width * (0.08 + 0.42 * Math.sin((t * Math.PI) / 2)));
    const y = Math.round(height * (0.05 + 0.9 * (1 - Math.cos((t * Math.PI) / 2))));
    let found = false, strength = 0;
    for (let dx = -3; dx <= 3 && !found; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const v = mag[yy * width + xx];
        if (v > threshold) { found = true; strength = v; break; }
      }
    }
    if (found) {
      hits++; strengthSum += strength;
      if (lastHit >= 0 && i - lastHit > 1) { gapCount++; maxGap = Math.max(maxGap, i - lastHit); }
      lastHit = i;
    }
  }
  return { coverage: hits / samples, avgStrength: hits ? strengthSum / hits : 0, gapCount };
}

// ---- Public entry point ----
// region = { data, width, height } — a crop the user has already aligned to their palm,
// oriented with fingers roughly toward the top of the frame.
function analyzePalmRegion(region) {
  const { width, height } = region;
  const gray = toGrayscaleContrastStretched(region);
  const mag = sobelMagnitude(gray, width, height);
  const { mean, std } = meanStd(mag);
  const threshold = mean + 0.6 * std;

  const heart = analyzeHorizontalBand(mag, width, height, Math.round(height * 0.12), Math.round(height * 0.32), threshold);
  const head = analyzeHorizontalBand(mag, width, height, Math.round(height * 0.36), Math.round(height * 0.56), threshold);
  const fate = analyzeVerticalStrip(mag, width, height, Math.round(width * 0.42), Math.round(width * 0.58), threshold);
  const life = analyzeArc(mag, width, height, threshold);

  const suggestions = {};
  const confidence = {};

  // Life line length + depth
  suggestions.lifeLength = life.coverage > 0.72 ? "long" : life.coverage > 0.4 ? "medium" : "short";
  suggestions.lifeDepth = life.gapCount >= 3 ? "broken" : life.avgStrength > threshold * 1.8 ? "deep" : "faint";
  confidence.lifeLength = Math.min(0.95, 0.35 + life.coverage);
  confidence.lifeDepth = Math.min(0.9, 0.3 + life.coverage * 0.5);

  // Heart line shape. Thresholds calibrated empirically against synthetic curves
  // of known amplitude (see test-cv-engine.js) — a curviness of ~0.006-0.009
  // corresponds to a bend of roughly 3-4% of the crop's height, which is a
  // visible arc; anything below that reads as essentially straight given normal
  // photo/hand noise.
  suggestions.heartShape = heart.segments >= 3 ? "branched" : heart.curviness > 0.008 ? "curved" : "straight";
  confidence.heartShape = Math.min(0.9, 0.3 + heart.coverage);

  // Head line shape. `slope` is Δy/Δx (dimensionless); 0.25 ≈ a ~14° downward
  // tilt across the line's run, calibrated the same way as heartShape above.
  if (Math.abs(head.slope) > 0.25) suggestions.headShape = "steep";
  else if (head.curviness > 0.008) suggestions.headShape = "curve";
  else suggestions.headShape = "straight";
  confidence.headShape = Math.min(0.9, 0.3 + head.coverage);

  // Fate line
  suggestions.fate = fate.continuity > 0.55 ? "strong" : fate.continuity > 0.22 ? "faint" : "absent";
  confidence.fate = Math.min(0.9, 0.3 + fate.continuity);

  return { suggestions, confidence, raw: { heart, head, fate, life, threshold } };
}

if (typeof module !== "undefined") {
  module.exports = { ANALYZABLE_QUESTIONS, analyzePalmRegion, toGrayscaleContrastStretched, sobelMagnitude, analyzeHorizontalBand, analyzeVerticalStrip, analyzeArc };
}
