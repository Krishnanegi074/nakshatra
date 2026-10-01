// Fully-offline computer-vision engine for automatic palm-line measurement.
// No network dependency, no ML model — pure pixel math (grayscale, contrast
// stretch, Sobel edge detection) run on a user-aligned crop of their photo.
// Honesty note: this measures line length/curvature/continuity from real
// pixels within a region the USER frames (drag-to-align), which is a real
// automation upgrade over Phase 1's blind self-report questions — but it is
// NOT the same as a trained ML model finding a hand anywhere in an arbitrary
// photo. Knowing which finger is which (needed for heartStart and mount)
// isn't something pixel-edge analysis can do directly either — but
// detectFingerColumns below gets a usable approximation of it classically,
// by reading the brightness dips between fingers near the top of the crop,
// rather than requiring a trained landmark model. heartStart uses that to
// auto-answer itself (see ANALYZABLE_QUESTIONS below); mount stays manual
// (see the comment just below the list) because "which pad looks physically
// fullest" is dominated by lighting/shadow in a way a brightness heuristic
// can't safely resolve — instead the same finger columns are drawn as labels
// directly on the user's photo, so answering it needs no palmistry knowledge.
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

const ANALYZABLE_QUESTIONS = ["lifeLength", "lifeDepth", "heartShape", "headShape", "fate", "heartStart"];
// "mount" stays out of this list on purpose: it asks which finger-base pad
// looks *physically fullest/most raised* to the eye, which in a real photo
// is dominated by lighting angle and shadow — a brightness heuristic there
// would be wrong often enough to undermine trust in the other suggestions.
// Instead of guessing it, the app labels each detected finger column right
// on the user's own photo (see detectFingerColumns below), so answering it
// needs zero palmistry knowledge, just a glance at the labeled picture.

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
    return { coverage: points.length / width, slope: 0, curviness: 0, segments: 0, points };
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
  return { coverage: longestRun / width, slope, curviness, segments: runs, points };
}

// ---- Finger-column detection ----
// Approximates the x-boundaries between the four fingers (index..pinky) by
// scanning a thin band near the very top of the crop for brightness valleys —
// the gap/webbing between two fingers reads darker there than the finger
// surface itself. This relies on the app's stated photo convention: fingers
// toward the top of the frame, THUMB TOWARD THE LEFT (see palm.crop.hint) —
// that fixed orientation is what lets "leftmost column = index finger" be a
// safe assumption without ever having to ask the user which hand this is.
// Like the rest of this file this is classical pixel math, not a trained
// landmark model — treat the columns as a starting approximation, not a
// guaranteed fit, which is why a confidence score comes back alongside them.
function detectFingerColumns(gray, width, height) {
  const bandStart = Math.max(0, Math.round(height * 0.04));
  const bandEnd = Math.min(height, Math.max(bandStart + 1, Math.round(height * 0.16)));
  if (width < 10 || height < 10) {
    return { columns: [], valleys: [], confidence: 0.1 };
  }

  const profile = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0, n = 0;
    for (let y = bandStart; y < bandEnd; y++) { sum += gray[y * width + x]; n++; }
    profile[x] = n ? sum / n : 0;
  }

  // Smooth with a small moving average so single-pixel noise can't fake a valley.
  const win = Math.max(1, Math.round(width * 0.015));
  const smooth = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0, n = 0;
    for (let dx = -win; dx <= win; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      sum += profile[xx]; n++;
    }
    smooth[x] = n ? sum / n : profile[x];
  }

  // Candidate valleys: local minima, away from the frame edges (an edge is the
  // outermost finger's OUTER side, not a gap between two fingers).
  const margin = Math.max(1, Math.round(width * 0.06));
  function localMaxAround(x, dir) {
    let v = smooth[x], xx = x;
    for (let i = 0; i < width; i++) {
      const nx = xx + dir;
      if (nx < 0 || nx >= width) break;
      if (smooth[nx] < v) break;
      v = smooth[nx]; xx = nx;
    }
    return v;
  }
  const candidates = [];
  for (let x = margin + 1; x < width - margin - 1; x++) {
    if (smooth[x] <= smooth[x - 1] && smooth[x] <= smooth[x + 1]) {
      const depth = Math.min(localMaxAround(x, -1), localMaxAround(x, 1)) - smooth[x];
      if (depth > 2) candidates.push({ x, depth });
    }
  }
  // A single real gap between two fingers often has a flat (or near-flat)
  // bottom, which yields a RUN of tied/near-tied local-minima candidates, not
  // just one. Cluster adjacent candidates into one representative valley per
  // run BEFORE ranking by depth — ranking first would let one wide gap's run
  // of ties crowd out every other real gap entirely (all top slots going to
  // the same valley), which is what an earlier version of this got wrong.
  const minGap = Math.max(4, Math.round(width * 0.05));
  const clusters = [];
  for (const c of candidates) {
    const last = clusters[clusters.length - 1];
    if (last && c.x - last.xs[last.xs.length - 1] <= minGap) {
      last.xs.push(c.x);
      if (c.depth > last.depth) last.depth = c.depth;
    } else {
      clusters.push({ xs: [c.x], depth: c.depth });
    }
  }
  const valleyPoints = clusters.map(cl => ({
    x: Math.round(cl.xs.reduce((a, b) => a + b, 0) / cl.xs.length),
    depth: cl.depth,
  }));
  valleyPoints.sort((a, b) => b.depth - a.depth);
  let valleys = valleyPoints.slice(0, 3).map(c => c.x).sort((a, b) => a - b);

  const names = ["index", "middle", "ring", "pinky"];
  const bounds = [0, ...valleys, width];
  const columns = [];
  for (let i = 0; i < Math.min(names.length, bounds.length - 1); i++) {
    columns.push({ name: names[i], x0: bounds[i], x1: bounds[i + 1] });
  }
  // Full marks for exactly 3 well-separated valleys (4 clean finger columns);
  // partial credit scales down with fewer/noisier valleys found.
  const confidence = Math.min(0.85, 0.25 + 0.2 * valleys.length);
  return { columns, valleys, confidence };
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

  // Whole-image edge density — a second, independent quality signal (see
  // `quality` below). A real palm photo is mostly smooth skin between the
  // handful of actual lines, so only a small slice of pixels ever clear the
  // edge threshold. Uniform sensor noise or a heavily textured/non-palm photo
  // instead clears threshold almost everywhere, which the coverage-based
  // confidences above can misread as one long "continuous line" (a gap-free
  // trace looks the same whether the line is real or just noise everywhere) —
  // this catches that case directly instead of relying on coverage alone.
  let edgeCount = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > threshold) edgeCount++;
  const edgeDensity = edgeCount / mag.length;

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

  // Heart line start-finger. This app crops with the thumb toward the left
  // (see detectFingerColumns), so the index/middle side that classical
  // palmistry reads the line's "start" from is also the LEFT side of the
  // frame — the traced heart-line's leftmost point is what we map to a
  // finger column. A line that spans nearly the full width with very low
  // curviness doesn't localize to one finger at all, hence "flat".
  const fingerCols = detectFingerColumns(gray, width, height);
  const heartPoints = heart.points || [];
  if (heartPoints.length > 2) {
    const firstPt = heartPoints[0], lastPt = heartPoints[heartPoints.length - 1];
    const span = (lastPt[0] - firstPt[0]) / width;
    if (span > 0.82 && heart.curviness < 0.006) {
      suggestions.heartStart = "flat";
      confidence.heartStart = Math.min(0.75, 0.3 + heart.coverage * 0.4);
    } else {
      const startX = firstPt[0];
      const col = fingerCols.columns.find(c => startX >= c.x0 && startX < c.x1);
      suggestions.heartStart = col && (col.name === "index" || col.name === "middle") ? col.name : "index";
      confidence.heartStart = Math.min(0.85, 0.2 + fingerCols.confidence * 0.5 + heart.coverage * 0.25);
    }
  } else {
    suggestions.heartStart = "flat";
    confidence.heartStart = 0.25;
  }

  // Overall scan quality. A blank, badly-lit, out-of-focus, or "not actually a
  // palm" photo doesn't crash (every branch above has a safe floor value) but
  // it also doesn't find any real line signal, so every confidence sits near
  // its floor (~0.25-0.35, see the floors used throughout this function). A
  // genuine reading — even a faint one — tends to push at least most values
  // well above that floor. Two signals, either one enough to flag it: most
  // questions individually near the floor, or the overall average low.
  const analyzableConfidences = ANALYZABLE_QUESTIONS.map((q) => confidence[q]);
  const avgConfidence = analyzableConfidences.reduce((a, b) => a + b, 0) / analyzableConfidences.length;
  const lowCount = analyzableConfidences.filter((c) => c < 0.35).length;
  // edgeDensity threshold (0.12) is calibrated with real margin either side:
  // pure random sensor noise measured ~0.27 in testing, a clean synthetic
  // line photo ~0.007 — real photos with natural skin texture/grain should
  // still land well under 0.12, but this is a heuristic cutoff, not a proof,
  // so it may need adjusting once tested against real-world photos.
  const lowQuality = lowCount >= 5 || avgConfidence < 0.38 || edgeDensity > 0.12;
  const quality = { average: avgConfidence, lowCount, edgeDensity, lowQuality };

  return { suggestions, confidence, fingerColumns: fingerCols, quality, raw: { heart, head, fate, life, threshold } };
}

if (typeof module !== "undefined") {
  module.exports = { ANALYZABLE_QUESTIONS, analyzePalmRegion, detectFingerColumns, toGrayscaleContrastStretched, sobelMagnitude, analyzeHorizontalBand, analyzeVerticalStrip, analyzeArc };
}
