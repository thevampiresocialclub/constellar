// Constellar — constellation view (Canvas, pan/zoom, semantic spatial map).
//
// Rewritten with:
//   - DOM-built hover panel (no innerHTML; kills the XSS class entirely)
//   - Quadtree-backed hit-testing (O(log n) hover instead of O(n) per pixel)
//   - requestAnimationFrame draw scheduling (no synchronous repaint storms)
//   - DPI-aware (re-reads devicePixelRatio on resize for multi-display setups)
//   - Touch + pinch-zoom on mobile (alongside mouse on desktop)
//   - Edge-flipping panel (never falls off-screen)
//   - Wheel-mode normalization (mouse wheel vs trackpad feel)
//   - Onboarding overlay (first visit explains how the map works)
//   - Single-pass draw (worldToScreen called once per item, not twice)

const Constellation = (() => {
  // ---------- module state ----------
  let canvas, ctx, panel, status, overlay;
  let items = [];
  let clusters = [];
  let view = { x: 0, y: 0, scale: 1 };
  let hovered = null;

  // sizing context (computed from items at load time)
  let maxVotes = 0;          // highest current Reddit upvote score
  // For items missing a real `published_at`: their position within their
  // source's no-date group, used as an ordinal recency proxy.
  // id → { pos: int, total: int }
  const _ordinalLookup = new Map();
  // cluster_id → string[] (top topical tags, rendered under the cluster name)
  const _clusterTags = new Map();

  // ---------- singularity easter egg ----------
  // Trips when the user zooms out so far that every star is jammed into one
  // tight ball. Plays a short "SINGULARITY!" → shake → explode animation
  // and then auto-fits the view. Interactions are locked while active.
  let singularityActive = false;
  let singularityState = null;
  const _shakeOffset = { x: 0, y: 0 };
  // Triggers when the view is zoomed below this fraction of fitView's natural
  // scale. At 0.011, the whole star field collapses to barely 1% of the
  // canvas — you have to really commit to the zoom-out before it fires.
  // Relative to fitView so it adapts to whatever UMAP layout you happen to have.
  const SINGULARITY_RATIO = 0.011;
  const SING_PHASES = {
    textIn:   220,   // text fades in, scales 0 → 1
    textHold: 2760,  // text big + bold, holds; ball trembles louder as it goes
    textOut:  240,   // text shrinks + fades, shake builds
    shake:    420,   // shake peaks at violent amplitude, no text
    explode: 1500,   // view.scale eases back out with overshoot
  };

  // Particle ejecta — stray stars that shoot out from canvas-center when the
  // ball explodes. Live in screen space (immune to pan/zoom), fly until they
  // exit the canvas, then derender. Each particle picks a random item from
  // the loaded set and inherits its source colour, so the burst echoes the
  // palette of the constellation it just blew up.
  let _particles = [];
  const _PARTICLE_COUNT = 150;
  const _PARTICLE_SPEED_MIN = 400;    // px/sec
  const _PARTICLE_SPEED_MAX = 1400;

  // gestures
  let dragging = false;
  let dragStart = null;
  let touchState = null;       // { mode: "pan" | "pinch", ... }

  // performance
  let pixelRatio = window.devicePixelRatio || 1;
  let drawScheduled = false;
  let resizeTimer = null;
  let quadtree = null;
  let cachedScreen = null;     // [{ id, x, y, item, radius, alpha, color }] per draw

  // spotlight (middle-click feature)
  let spotlights = [];         // [{ item, panelEl, anchorX, anchorY, starScreenX, starScreenY }]
  let spotlightLayer = null;   // DOM container for spotlight panels

  // listeners we attach (so we can remove on destroy if ever needed)
  const listeners = [];
  const on = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    listeners.push([target, type, handler, opts]);
  };

  // ---------- color: explicit map for known sources, hash fallback ----------
  // Mirror the SOURCE_COLORS in app.js / styles.css; keep in sync.
  const EXPLICIT_COLORS = {
    "kotaku":         "#a8ff00",
    "gizmodo":        "#ff6f3c",
    "the-face":       "#f5f5f5",
    "laist":          "#ffb84d",
    "frontpage":      "#ff4500",
    "reddit":         "#ff4500",
  };
  function colorFor(tag) {
    if (!tag) return "#9aa";
    if (tag.startsWith("r/")) {
      // subreddits get a deterministic shade in the warm/orange family
      let h = 0;
      for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
      const hue = 5 + (Math.abs(h) % 40); // 5–45° (red→orange→amber)
      return `hsl(${hue}, 80%, 60%)`;
    }
    if (EXPLICIT_COLORS[tag]) return EXPLICIT_COLORS[tag];
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 70%, 65%)`;
  }
  function primaryTag(item) {
    if (item.source_kind === "reddit") {
      return item.source_name === "frontpage" ? "frontpage" : `r/${item.source_name}`;
    }
    return item.source_name || "unknown";
  }

  // ---------- color → rgb (for building gradient stops with explicit alpha) ----------
  // Canvas radial-gradient stops interpolate in RGBA. Going `color → "transparent"`
  // also drifts the RGB toward black, which renders as a dirty edge instead of a
  // clean fade. Building stops with the *same* RGB at each step (varying only
  // alpha + saturation) avoids that.
  function _parseHexColor(hex) {
    if (hex.length === 4) {
      return [
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        parseInt(hex[3] + hex[3], 16),
      ];
    }
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  function _hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1, g1, b1;
    if (h < 60)       [r1, g1, b1] = [c, x, 0];
    else if (h < 120) [r1, g1, b1] = [x, c, 0];
    else if (h < 180) [r1, g1, b1] = [0, c, x];
    else if (h < 240) [r1, g1, b1] = [0, x, c];
    else if (h < 300) [r1, g1, b1] = [x, 0, c];
    else              [r1, g1, b1] = [c, 0, x];
    return [
      Math.round((r1 + m) * 255),
      Math.round((g1 + m) * 255),
      Math.round((b1 + m) * 255),
    ];
  }
  function _colorToRgb(c) {
    if (c.startsWith("#")) return _parseHexColor(c);
    const m = c.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)/);
    if (m) return _hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
    return [200, 200, 220];
  }

  // Greens read hotter than other hues on the bloom gradient — at the same
  // nominal saturation, kotaku-green or hsl(120, ...) blows out the halo
  // more than a comparable orange or blue. Detect green-dominant RGB and
  // pull it 20% toward its own luminance gray. Applied only to glow
  // rendering (bloom + spike-polygon tip); UI swatches elsewhere — cards,
  // panel chrome, list-view source labels — keep the original colour.
  const _GREEN_DAMPEN = 0.20;
  function _dampenGreenRgb([r, g, b]) {
    if (g > r + 30 && g > b + 30) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return [
        Math.round(r + (lum - r) * _GREEN_DAMPEN),
        Math.round(g + (lum - g) * _GREEN_DAMPEN),
        Math.round(b + (lum - b) * _GREEN_DAMPEN),
      ];
    }
    return [r, g, b];
  }
  function _glowRgb(color) {
    return _dampenGreenRgb(_colorToRgb(color));
  }
  // CSS string version, cached so we don't re-parse + dampen every frame
  // for the spike-polygon tip stop.
  const _glowCss = new Map();
  function glowColorCss(color) {
    let cached = _glowCss.get(color);
    if (cached) return cached;
    const [r, g, b] = _glowRgb(color);
    cached = `rgb(${r}, ${g}, ${b})`;
    _glowCss.set(color, cached);
    return cached;
  }

  // Bloom stops: cached per color. Two superimposed linear interpolations —
  //   saturation: 100% (full color) at center → 0% (gray) at 60% of the radius
  //   alpha:      1.0 at center → 0.2 at 30% → 0 at 60% (linear segments)
  // Three stops are sufficient because the alpha curve is piecewise linear with
  // a single kink at 30%, and saturation interpolates linearly between adjacent
  // stops in RGB space (which IS desaturation, since gray = luminance of color).
  const _bloomStops = new Map();
  function bloomStopsFor(color) {
    let stops = _bloomStops.get(color);
    if (stops) return stops;
    const [r, g, b] = _glowRgb(color);
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const dr = Math.round(r + (gray - r) * 0.5);
    const dg = Math.round(g + (gray - g) * 0.5);
    const db = Math.round(b + (gray - b) * 0.5);
    const gi = Math.round(gray);
    stops = {
      s0:  `rgba(${r}, ${g}, ${b}, 1)`,        // center: full color, full alpha
      s30: `rgba(${dr}, ${dg}, ${db}, 0.2)`,   // 30%:    50% saturated, 20% alpha
      s60: `rgba(${gi}, ${gi}, ${gi}, 0)`,     // 60%:    fully gray, transparent
    };
    _bloomStops.set(color, stops);
    return stops;
  }

  // Dwarf stops: same alpha curve as the bloom but uniformly gray throughout
  // (the source color's luminance). For dismissed items — a faint desaturated
  // ghost that marks "I've handled this" without injecting a saturated halo.
  const _dwarfStops = new Map();
  function dwarfStopsFor(color) {
    let stops = _dwarfStops.get(color);
    if (stops) return stops;
    const [r, g, b] = _colorToRgb(color);
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const base = `rgba(${lum}, ${lum}, ${lum},`;
    stops = {
      s0:  `${base} 1)`,
      s30: `${base} 0.2)`,
      s60: `${base} 0)`,
    };
    _dwarfStops.set(color, stops);
    return stops;
  }

  // ---------- star body: bloom + spike polygon + core pinprick ----------
  // Three stacked layers, back-to-front:
  //   1. BLOOM    — large soft halo (white-hot center → tag color → transparent)
  //   2. POLYGON  — N-point spike rays with a white-hot center gradient
  //   3. CORE     — bright white pinprick that punches through the polygon
  // Point count varies per item: 4 = sparkle, 5 = classic, 6 = Hubble,
  // 7 = rare septafoil.
  const SPIKE_OUTER_MULT = 2.6;   // spike tip distance, as a multiple of core radius
  const SPIKE_INNER_MULT = 0.12;  // notch distance — lower = thinner, hairline tendrils
  const BLOOM_MULT       = 1.8;   // bloom radius as a multiple of spike outer radius
  const CORE_MULT        = 0.4;   // hero-core pinprick as a multiple of core radius

  // Cumulative weights out of 100. Tweak the spread to shift the population.
  const STAR_POINT_BUCKETS = [
    [28, 4],   // ~28% sparkle
    [60, 5],   // ~32% classic
    [88, 6],   // ~28% snowflake / Hubble
    [100, 7],  // ~12% rare septafoils
  ];

  // Single rolling hash; slice different bits for independent randomness so
  // rotation and point-count don't visibly correlate.
  function _hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  // Stable per-item rotation so the field doesn't read as a logo grid.
  function hashAngle(id) {
    return ((_hashId(id) % 10000) / 10000) * Math.PI * 2;
  }
  function pickStarPoints(id) {
    const r = (_hashId(id) >>> 8) % 100;
    for (const [t, pts] of STAR_POINT_BUCKETS) {
      if (r < t) return pts;
    }
    return 5;
  }

  function buildStarPolygonPath(cx, cy, points, outerR, innerR, rot) {
    const path = new Path2D();
    // 2N-vertex polygon alternating outer (tip) and inner (notch).
    const step = Math.PI / points;
    for (let i = 0; i < points * 2; i++) {
      const r = (i & 1) === 0 ? outerR : innerR;
      const a = rot + i * step - Math.PI / 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  }

  // ---------- size: type-aware, capped at 2.5x base ----------
  // Three rules, picked per item:
  //   1. Reddit with PRAW upvote signal     → linear by votes
  //   2. Anything with a real published_at  → wall-clock recency curve
  //   3. Anything else (no timestamp)       → ordinal position within its source
  //
  // The ratio (0..1) returned by every branch is fed into
  //   radius = STAR_BASE * (1 + (STAR_MAX_MULT - 1) * ratio)
  // so ratio=1 → biggest star, ratio=0 → STAR_BASE.
  const STAR_BASE = 2.5;
  const STAR_MAX_MULT = 2.5;

  // Generic piecewise-linear interpolator. Given a sorted list of (x, y)
  // control points and an x, returns the y. Clamps flat outside the range.
  //
  //   ratio(x) = y₀ + (y₁ - y₀) · (x - x₀) / (x₁ - x₀)   for x₀ ≤ x ≤ x₁
  //   ratio(x) = y[first]                                 for x ≤ x[first]
  //   ratio(x) = y[last]                                  for x ≥ x[last]
  function _interpCurve(x, curve) {
    if (x <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i];
      if (x <= x1) {
        const [x0, y0] = curve[i - 1];
        return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
      }
    }
    return curve[curve.length - 1][1];
  }

  // Time curve. x = age in hours. Control points:
  //   ≤2h    : 1.00   (largest, plateau)
  //    8h    : 0.70
  //   25h    : 0.25
  //   ≥48h   : 0.00   (smallest, plateau)
  //
  // These are the original [0.80, 0.50, 0.00] values with each delta-from-max
  // scaled by 1.5× to make the size dropoff visibly more dramatic. The last
  // control point clamps at 0 (1.5 × 1.00 = 1.50, capped).
  const _RECENCY_CURVE = [
    [2,   1.00],
    [8,   0.70],
    [25,  0.25],
    [48,  0.00],
  ];

  // Ordinal curve. x = position fraction (0 = newest in source, 1 = oldest).
  // Used as a fallback when a feed item has no real `published_at`.
  // Same 1.5× dramatic-ness scaling applied to the deltas-from-max.
  //   ≤0.10  : 1.00   (first 10% of items — largest)
  //    0.25  : 0.70
  //    0.50  : 0.25
  //    1.00  : 0.00   (back half — fades to smallest at the end)
  const _ORDINAL_CURVE = [
    [0.10, 1.00],
    [0.25, 0.70],
    [0.50, 0.25],
    [1.00, 0.00],
  ];

  function hasVoteSignal(it) {
    return it.source_kind === "reddit"
        && typeof it.votes === "number"
        && it.votes > 0;
  }

  function radiusFor(it) {
    if (hasVoteSignal(it) && maxVotes) {
      const ratio = Math.min(1, it.votes / maxVotes);
      return STAR_BASE * (1 + (STAR_MAX_MULT - 1) * ratio);
    }
    let ratio;
    if (it.published_at) {
      // Real timestamp: wall-clock recency curve.
      const t = new Date(it.published_at).getTime();
      if (!isFinite(t)) return STAR_BASE;
      const ageHours = (Date.now() - t) / (1000 * 60 * 60);
      ratio = _interpCurve(ageHours, _RECENCY_CURVE);
    } else {
      // No timestamp: ordinal-within-source fallback.
      const ord = _ordinalLookup.get(it.id);
      if (!ord || ord.total <= 1) return STAR_BASE;
      ratio = _interpCurve(ord.pos / (ord.total - 1), _ORDINAL_CURVE);
    }
    return STAR_BASE * (1 + (STAR_MAX_MULT - 1) * ratio);
  }

  // Top 3 tags per cluster, by item-frequency. Used to render a small
  // parenthesised subtitle under each cluster's name. Cheap to recompute
  // on every load since the items array is already in memory.
  const _CLUSTER_TAG_TOP_N = 3;
  function buildClusterTags() {
    _clusterTags.clear();
    const counts = new Map();   // cluster_id → Map<tag, count>
    for (const it of items) {
      if (it.cluster_id == null || it.cluster_id < 0) continue;
      const tags = it.tags;
      if (!tags || !tags.length) continue;
      let bucket = counts.get(it.cluster_id);
      if (!bucket) { bucket = new Map(); counts.set(it.cluster_id, bucket); }
      for (const tag of tags) {
        bucket.set(tag, (bucket.get(tag) || 0) + 1);
      }
    }
    for (const [cid, tagCounts] of counts) {
      const sorted = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, _CLUSTER_TAG_TOP_N)
        .map(([t]) => t);
      if (sorted.length) _clusterTags.set(cid, sorted);
    }
  }

  function recomputeSizingContext() {
    maxVotes = 0;
    _ordinalLookup.clear();
    // Group items lacking published_at by source, preserving array order
    // (which the API returns in fetched_at DESC ≈ feed order). Position 0 in
    // each group is the newest-fetched item from that source.
    const bySource = new Map();
    for (const it of items) {
      if (hasVoteSignal(it) && it.votes > maxVotes) {
        maxVotes = it.votes;
      }
      if (!it.published_at) {
        const key = it.source_name || "?";
        let list = bySource.get(key);
        if (!list) { list = []; bySource.set(key, list); }
        list.push(it.id);
      }
    }
    for (const [, list] of bySource) {
      const total = list.length;
      for (let i = 0; i < total; i++) {
        _ordinalLookup.set(list[i], { pos: i, total });
      }
    }
  }

  // ---------- coords ----------
  function worldToScreen(wx, wy) {
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    return { x: (wx - view.x) * view.scale + w / 2 + _shakeOffset.x,
             y: (wy - view.y) * view.scale + h / 2 + _shakeOffset.y };
  }
  function screenToWorld(sx, sy) {
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    return { x: (sx - w / 2) / view.scale + view.x,
             y: (sy - h / 2) / view.scale + view.y };
  }

  // ---------- quadtree (item index in screen space, rebuilt each draw) ----------
  // Tiny, no deps. Splits when count > 8 and depth < 8.
  class Quadtree {
    constructor(x, y, w, h, depth = 0) {
      this.bx = x; this.by = y; this.bw = w; this.bh = h;
      this.depth = depth; this.points = []; this.kids = null;
    }
    insert(p) {
      if (this.kids) { this._kidFor(p).insert(p); return; }
      this.points.push(p);
      if (this.points.length > 8 && this.depth < 8) this._split();
    }
    _split() {
      const hw = this.bw / 2, hh = this.bh / 2;
      this.kids = [
        new Quadtree(this.bx,      this.by,      hw, hh, this.depth + 1),
        new Quadtree(this.bx + hw, this.by,      hw, hh, this.depth + 1),
        new Quadtree(this.bx,      this.by + hh, hw, hh, this.depth + 1),
        new Quadtree(this.bx + hw, this.by + hh, hw, hh, this.depth + 1),
      ];
      const old = this.points; this.points = [];
      for (const p of old) this._kidFor(p).insert(p);
    }
    _kidFor(p) {
      const i = (p.x >= this.bx + this.bw / 2 ? 1 : 0) +
                (p.y >= this.by + this.bh / 2 ? 2 : 0);
      return this.kids[i];
    }
    queryRadius(cx, cy, r, out) {
      // bounding-box reject
      if (cx + r < this.bx || cx - r > this.bx + this.bw ||
          cy + r < this.by || cy - r > this.by + this.bh) return out;
      if (this.kids) {
        for (const k of this.kids) k.queryRadius(cx, cy, r, out);
      } else {
        const r2 = r * r;
        for (const p of this.points) {
          const dx = p.x - cx, dy = p.y - cy;
          if (dx * dx + dy * dy <= r2) out.push(p);
        }
      }
      return out;
    }
  }

  // ---------- fit ----------
  function fitView() {
    if (!items.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      if (it.umap_x < minX) minX = it.umap_x;
      if (it.umap_y < minY) minY = it.umap_y;
      if (it.umap_x > maxX) maxX = it.umap_x;
      if (it.umap_y > maxY) maxY = it.umap_y;
    }
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    const padding = 80;
    const sx = (w - padding * 2) / Math.max(0.001, maxX - minX);
    const sy = (h - padding * 2) / Math.max(0.001, maxY - minY);
    view.scale = Math.min(sx, sy);
    view.x = (minX + maxX) / 2;
    view.y = (minY + maxY) / 2;
  }

  // ---------- singularity ----------
  // Compute what fitView WOULD set scale + center to, without mutating state.
  // Used by the singularity animation to know its target.
  function fitTarget() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      if (it.umap_x < minX) minX = it.umap_x;
      if (it.umap_y < minY) minY = it.umap_y;
      if (it.umap_x > maxX) maxX = it.umap_x;
      if (it.umap_y > maxY) maxY = it.umap_y;
    }
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    const padding = 80;
    const sx = (w - padding * 2) / Math.max(0.001, maxX - minX);
    const sy = (h - padding * 2) / Math.max(0.001, maxY - minY);
    return {
      scale: Math.min(sx, sy),
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    };
  }

  function maybeTriggerSingularity() {
    if (singularityActive) return;
    if (!items.length) return;
    const target = fitTarget();
    if (view.scale < target.scale * SINGULARITY_RATIO) triggerSingularity();
  }

  function triggerSingularity() {
    singularityActive = true;
    const target = fitTarget();

    // Snap pan to the centroid so the ball is dead-center for the animation.
    view.x = target.x;
    view.y = target.y;

    // DOM text overlay. Sized + animated via CSS; opacity + scale driven by JS
    // so it stays in lockstep with the canvas animation.
    const textEl = document.createElement("div");
    textEl.className = "singularity-text";
    textEl.textContent = "THE SINGULARITY!!!";
    canvas.parentElement.appendChild(textEl);

    // Measure once and shrink the font if the natural width exceeds 92% of
    // the canvas pane. offsetWidth reflects the layout box (transform scale
    // doesn't affect it), so this works even though CSS starts the element
    // at scale(0). Belt-and-braces over the CSS clamp.
    const paneW = canvas.parentElement.clientWidth;
    const naturalW = textEl.offsetWidth;
    if (naturalW > paneW * 0.92) {
      const baseSize = parseFloat(getComputedStyle(textEl).fontSize);
      textEl.style.fontSize = `${baseSize * (paneW * 0.92) / naturalW}px`;
    }

    singularityState = {
      startTime: performance.now(),
      startScale: view.scale,
      targetScale: target.scale,
      textEl,
      particlesSpawned: false,
    };
    _particles = [];
    requestAnimationFrame(animateSingularity);
  }

  function _spawnParticles() {
    const w = canvas.width / pixelRatio;
    const h = canvas.height / pixelRatio;
    const cx = w / 2, cy = h / 2;
    const now = performance.now();
    _particles = [];
    const haveItems = items.length > 0;
    for (let i = 0; i < _PARTICLE_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = _PARTICLE_SPEED_MIN +
                    Math.random() * (_PARTICLE_SPEED_MAX - _PARTICLE_SPEED_MIN);
      // Inherit a random item's source colour so the burst matches the
      // constellation's palette. Fall back to hot white if items is somehow
      // empty (shouldn't happen — singularity can't trigger without items).
      let r = 250, g = 250, b = 255;
      if (haveItems) {
        const it = items[(Math.random() * items.length) | 0];
        [r, g, b] = _colorToRgb(colorFor(primaryTag(it)));
      }
      // Lighten 60% toward white so the halo reads as a pale "stellar" hue
      // rather than the saturated source colour. The white core is added at
      // render time on top of this halo.
      const lr = Math.round(r + (255 - r) * 0.6);
      const lg = Math.round(g + (255 - g) * 0.6);
      const lb = Math.round(b + (255 - b) * 0.6);
      _particles.push({
        cx, cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        bornAt: now,
        haloColor: `rgba(${lr}, ${lg}, ${lb}, 0.80)`,
        size: 1.4 + Math.random() * 2.8,
      });
    }
  }

  function _drawParticles() {
    if (!_particles.length) return;
    const w = canvas.width / pixelRatio;
    const h = canvas.height / pixelRatio;
    const now = performance.now();
    const survivors = [];
    ctx.save();
    for (const p of _particles) {
      const dt = (now - p.bornAt) / 1000;
      const x = p.cx + p.vx * dt;
      const y = p.cy + p.vy * dt;
      // Derender once past the canvas (small slack so an edge particle's
      // glow doesn't pop off mid-render).
      if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
      // 1) Pale coloured halo with a soft glow.
      ctx.shadowColor = p.haloColor;
      ctx.shadowBlur = 8;
      ctx.fillStyle = p.haloColor;
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
      // 2) Hot-white core on top — gives every particle a bright pinprick
      //    so they read as little stars rather than fuzzy blobs.
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.beginPath();
      ctx.arc(x, y, p.size * 0.45, 0, Math.PI * 2);
      ctx.fill();
      survivors.push(p);
    }
    ctx.restore();
    _particles = survivors;
  }

  function _abortSingularity(err) {
    // Safety net: if anything in the animation loop throws, we DON'T want to
    // leave the user with singularityActive stuck true (which silently locks
    // every input on the canvas). Snap to the fit target, clean up, unlock.
    console.error("[constellation] singularity aborted:", err);
    try {
      const target = fitTarget();
      view.scale = target.scale; view.x = target.x; view.y = target.y;
    } catch {}
    _shakeOffset.x = 0; _shakeOffset.y = 0;
    if (singularityState?.textEl?.parentElement) singularityState.textEl.remove();
    singularityState = null;
    singularityActive = false;
    scheduleDraw();
  }

  function animateSingularity() {
    if (!singularityState) return;
    try {
      _animateSingularityBody();
    } catch (err) {
      _abortSingularity(err);
    }
  }

  function _animateSingularityBody() {
    const s = singularityState;
    const t = performance.now() - s.startTime;
    const p = SING_PHASES;
    const T1 = p.textIn;
    const T2 = T1 + p.textHold;
    const T3 = T2 + p.textOut;
    const T4 = T3 + p.shake;
    const T5 = T4 + p.explode;

    // --- text ---
    let textScale = 0, textOpacity = 0;
    if (t < T1) {
      const x = t / T1;
      textScale = _easeOutCubic(x);
      textOpacity = x;
    } else if (t < T2) {
      textScale = 1; textOpacity = 1;
    } else if (t < T3) {
      const x = (t - T2) / p.textOut;
      textScale = 1 - x * 0.92;
      textOpacity = 1 - x;
    } else if (s.textEl) {
      // First frame past T3: yank the element. Subsequent frames take the
      // `s.textEl` null path below and skip the style write.
      s.textEl.remove();
      s.textEl = null;
    }
    if (s.textEl) {
      s.textEl.style.transform = `translate(-50%, -50%) scale(${textScale})`;
      s.textEl.style.opacity = String(textOpacity);
    }

    // --- shake ---
    // Starts the moment the text is fully in (T1), runs all the way through
    // until the explosion (T4). Power-of-1.7 ramp so it stays gentle while
    // the text is being read, then escalates fast — feels like the ball is
    // resisting then losing control. Snaps off at explode.
    if (t > T1 && t < T4) {
      const phase = (t - T1) / (T4 - T1);    // 0 → 1
      const intensity = Math.pow(phase, 1.7);
      const amp = 28 * intensity;             // peak ±28 px (was ±12)
      _shakeOffset.x = (Math.random() - 0.5) * 2 * amp;
      _shakeOffset.y = (Math.random() - 0.5) * 2 * amp;
    } else {
      _shakeOffset.x = 0; _shakeOffset.y = 0;
    }

    // --- explode ---
    if (t > T4 && t < T5) {
      const x = (t - T4) / p.explode;
      view.scale = s.startScale + (s.targetScale - s.startScale) * _easeOutBack(x);
      // Particle burst fires exactly once, on the leading edge of the explode
      // phase, so the ejecta and the ball expansion start in lockstep.
      if (!s.particlesSpawned) {
        _spawnParticles();
        s.particlesSpawned = true;
      }
    }

    // Continue rAF chain until the main animation is over AND any stray
    // particles have flown off the canvas. Once both are done, unlock.
    if (t < T5 || _particles.length > 0) {
      scheduleDraw();
      requestAnimationFrame(animateSingularity);
    } else {
      // Settle exactly on target and unlock.
      view.scale = s.targetScale;
      _shakeOffset.x = 0; _shakeOffset.y = 0;
      if (s.textEl?.parentElement) s.textEl.remove();
      singularityState = null;
      singularityActive = false;
      scheduleDraw();
    }
  }

  function _easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function _easeOutBack(x) {
    // Slight overshoot — the ball pops past target then settles.
    const c1 = 1.50;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  // ---------- rendering ----------
  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  function draw() {
    if (!ctx) return;
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;

    // background
    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, w, h);

    drawAmbient(w, h);
    drawClusterLabels();

    // single-pass: compute screen pos once per item, build cache + quadtree.
    cachedScreen = [];
    const newTree = new Quadtree(-50, -50, w + 100, h + 100);

    for (const it of items) {
      const sp = worldToScreen(it.umap_x, it.umap_y);
      if (sp.x < -20 || sp.x > w + 20 || sp.y < -20 || sp.y > h + 20) continue;

      const dismissed = it.status === "dismissed";
      const radius = radiusFor(it);
      // Glow/alpha still tracks AI relevance when present, so curated items
      // visually pop independent of the size signal.
      const score = (typeof it.ai_score === "number" ? it.ai_score : it.score) ?? 0.5;
      const alpha = dismissed ? 0.35 : (0.55 + score * 0.45);
      const color = colorFor(primaryTag(it));

      if (dismissed) {
        // Dwarf: fully desaturated bloom shrunk to 1/3 the normal radius.
        // Same gradient shape as a live star (alpha 1 → 0.2 at 30% → 0 at 60%)
        // but gray throughout, like a star whose color has bled away. No spike
        // polygon, no core highlight. Ineligible for spotlight selection.
        const dwarfBloomR = (radius * SPIKE_OUTER_MULT * BLOOM_MULT) / 3;
        const stops = dwarfStopsFor(color);
        const bloom = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, dwarfBloomR);
        bloom.addColorStop(0,    stops.s0);
        bloom.addColorStop(0.30, stops.s30);
        bloom.addColorStop(0.60, stops.s60);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, dwarfBloomR, 0, Math.PI * 2);
        ctx.fillStyle = bloom;
        ctx.globalAlpha = alpha;
        ctx.fill();
      } else {
        const outerR = radius * SPIKE_OUTER_MULT;

        // 1. BLOOM: colored halo with two overlaid linear fades —
        //   saturation: full color at center → gray by 60% of the radius
        //   alpha:      1.0 → 0.2 at 30% → 0 at 60% (then dead air to 100%)
        // RGB carries through every stop so the fade reads as the actual tag
        // color desaturating, not as a muddy color-to-black smear.
        const bloomR = outerR * BLOOM_MULT;
        const stops = bloomStopsFor(color);
        const bloom = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, bloomR);
        bloom.addColorStop(0,    stops.s0);
        bloom.addColorStop(0.30, stops.s30);
        bloom.addColorStop(0.60, stops.s60);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, bloomR, 0, Math.PI * 2);
        ctx.fillStyle = bloom;
        ctx.globalAlpha = alpha;
        ctx.fill();

        // 2. SPIKE POLYGON: N-point rays. White-hot gradient at the polygon
        // center fading to the tag color at the spike tips.
        const innerR = radius * SPIKE_INNER_MULT;
        const body = buildStarPolygonPath(
          sp.x, sp.y, pickStarPoints(it.id), outerR, innerR, hashAngle(it.id)
        );
        const bodyFill = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, outerR);
        bodyFill.addColorStop(0,    "rgba(255, 255, 255, 1)");
        bodyFill.addColorStop(0.45, "rgba(255, 255, 255, 0.9)");
        bodyFill.addColorStop(1,    glowColorCss(color));
        ctx.fillStyle = bodyFill;
        ctx.globalAlpha = alpha;
        ctx.fill(body);

        // 3. CORE: bright white pinprick on top — fills the small wedges
        // between spike notches and makes the very center read as a single
        // brilliant point even at the smallest sizes.
        const coreR = Math.max(0.8, radius * CORE_MULT);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, coreR, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 1)";
        ctx.globalAlpha = Math.min(1, alpha + 0.2);
        ctx.fill();
      }

      const point = { x: sp.x, y: sp.y, item: it, radius, dismissed };
      cachedScreen.push(point);
      newTree.insert(point);
    }
    ctx.globalAlpha = 1;
    quadtree = newTree;

    if (hovered) {
      const sp = worldToScreen(hovered.umap_x, hovered.umap_y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    drawSpotlightLines();
    _drawParticles();   // singularity ejecta — rendered last so they overlay
  }

  // Cached deterministic pseudo-random ambient stars (no per-frame trig).
  const ambientStars = (() => {
    const out = [];
    for (let i = 0; i < 80; i++) {
      out.push({
        u: Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1),
        v: Math.abs((Math.sin(i * 78.233)  * 43758.5453) % 1),
      });
    }
    return out;
  })();

  function drawAmbient(w, h) {
    ctx.fillStyle = "#1a1a28";
    for (const s of ambientStars) {
      ctx.fillRect((s.u * w) | 0, (s.v * h) | 0, 1, 1);
    }
  }

  function drawClusterLabels() {
    if (!clusters.length) return;
    // Cluster labels intentionally do NOT scale with --text-scale — they sit
    // in world space, scale with zoom, and act as a stable cartographic layer
    // independent of the user's text-size preference.
    const fontSize = Math.max(10, Math.min(28, 14 * Math.log2(view.scale + 1)));
    if (fontSize < 9) return;
    const tagFontSize = Math.max(8, fontSize * 0.65);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const c of clusters) {
      if (c.member_count < 3) continue;
      const sp = worldToScreen(c.centroid_x, c.centroid_y);
      const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
      if (sp.x < -100 || sp.x > w + 100 || sp.y < -50 || sp.y > h + 50) continue;

      // Use the AI label if present; otherwise a neutral placeholder so the
      // user sees structure even before name_clusters has run.
      const label = c.label || `cluster ${c.id} · ${c.member_count}`;
      ctx.font = `300 ${fontSize}px "Iowan Old Style", Georgia, serif`;
      ctx.fillStyle = c.label
        ? "rgba(140, 130, 200, 0.22)"
        : "rgba(120, 120, 140, 0.12)";
      ctx.fillText(label, sp.x, sp.y);

      // Subtitle: top tags in parens. Italic + dimmer than the headline so it
      // reads as a caption, not a second title. Skipped if the cluster has no
      // taggable items (e.g. all-untagged noise before curation).
      const tags = _clusterTags.get(c.id);
      if (tags && tags.length) {
        ctx.font = `300 italic ${tagFontSize}px "Iowan Old Style", Georgia, serif`;
        ctx.fillStyle = c.label
          ? "rgba(140, 130, 200, 0.16)"
          : "rgba(120, 120, 140, 0.09)";
        ctx.fillText(`(${tags.join(", ")})`, sp.x, sp.y + fontSize * 0.85);
      }
    }
  }

  // ---------- hit-testing ----------
  function findHoverAt(sx, sy) {
    if (!quadtree) return null;
    const HIT = 12;
    const candidates = quadtree.queryRadius(sx, sy, HIT, []);
    if (!candidates.length) return null;
    let nearest = null, nearestD = Infinity;
    for (const p of candidates) {
      const dx = p.x - sx, dy = p.y - sy;
      const d = dx * dx + dy * dy;
      if (d < nearestD) { nearestD = d; nearest = p; }
    }
    return nearest ? nearest.item : null;
  }

  // ---------- panel (pure DOM, no innerHTML) ----------
  function clearPanel() {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
  }
  function makeRow(text, cls) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function showPanel(item, sx, sy) {
    if (!item) { panel.hidden = true; return; }

    clearPanel();
    panel.appendChild(makeRow(primaryTag(item), "panel-source"));
    panel.appendChild(makeRow(item.title || "", "panel-title"));
    if (item.ai_comment) {
      panel.appendChild(makeRow(item.ai_comment.slice(0, 220), "panel-comment"));
    } else if (item.snippet) {
      panel.appendChild(makeRow(item.snippet.slice(0, 220), "panel-snippet"));
    }
    if (item.tags && item.tags.length) {
      panel.appendChild(makeRow(item.tags.slice(0, 4).join(" · "), "panel-tags"));
    }
    panel.appendChild(makeRow("click to open · right-click or shift-click to dismiss", "panel-hint"));

    // Edge-flip: if we'd overflow right/bottom, place to the left/above instead.
    panel.hidden = false;
    const w = window.innerWidth, h = window.innerHeight;
    const rect = panel.getBoundingClientRect();
    const PW = rect.width, PH = rect.height;
    let left = sx + 14;
    let top = sy + 14;
    if (left + PW > w - 8) left = sx - PW - 14;
    if (top + PH > h - 8) top = sy - PH - 14;
    if (left < 8) left = 8;
    if (top < 8)  top = 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  // ---------- spotlight (middle-click feature) ----------
  // Pick 5 visible items, biased toward bigger circles, and arrange floating
  // panels around the screen center with leader lines connecting each panel
  // to its star.

  const SPOTLIGHT_N = 5;
  // Selection disk: items within (multiplier × max-possible-star-radius) pixels
  // of the middle-click point are eligible. 32× ≈ 200px at current sizing.
  const SPOTLIGHT_RADIUS_MULT = 32;
  // Five anchor positions around the viewport center, in (angle, distance) pairs.
  // Angles in degrees, 0 = right, going clockwise. Distance is a fraction of
  // min(viewport-w, viewport-h)/2.
  const SPOTLIGHT_LAYOUT = [
    { angle: -90, dist: 0.65 }, // top
    { angle: -30, dist: 0.70 }, // upper right
    { angle:  45, dist: 0.65 }, // lower right
    { angle: 135, dist: 0.65 }, // lower left
    { angle: 210, dist: 0.70 }, // upper left
  ];

  function triggerSpotlight(originSx, originSy) {
    clearSpotlights();
    const picks = pickSpotlightItems(items, cachedScreen, SPOTLIGHT_N, originSx, originSy);
    if (picks.length === 0) return;

    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) / 2;
    const PANEL_W = 280;
    const PANEL_H_EST = 130;

    for (let i = 0; i < picks.length; i++) {
      const point = picks[i];
      const layout = SPOTLIGHT_LAYOUT[i % SPOTLIGHT_LAYOUT.length];
      const a = layout.angle * Math.PI / 180;
      // Anchor center in canvas-space; clamp to keep panel inside viewport.
      let acx = cx + Math.cos(a) * radius * layout.dist;
      let acy = cy + Math.sin(a) * radius * layout.dist;
      let left = Math.max(8, Math.min(w - PANEL_W - 8, acx - PANEL_W / 2));
      let top  = Math.max(8, Math.min(h - PANEL_H_EST - 8, acy - PANEL_H_EST / 2));

      const panelEl = makeSpotlightPanel(point.item, () => clearSpotlights());
      // Position relative to the constellation container (canvas's parent).
      panelEl.style.left = `${left}px`;
      panelEl.style.top  = `${top}px`;
      spotlightLayer.appendChild(panelEl);

      spotlights.push({
        item: point.item,
        panelEl,
        // anchor for leader-line attachment: nearest panel edge midpoint to the star
        panelLeft: left, panelTop: top,
        panelW: PANEL_W, panelH: PANEL_H_EST,
        starWX: point.item.umap_x, starWY: point.item.umap_y,
      });
    }

    scheduleDraw();
  }

  function clearSpotlights() {
    if (spotlightLayer) {
      while (spotlightLayer.firstChild) spotlightLayer.removeChild(spotlightLayer.firstChild);
    }
    if (spotlights.length > 0) {
      spotlights = [];
      scheduleDraw();
    } else {
      spotlights = [];
    }
  }

  // Tear down just the spotlight panel(s) tied to a specific item — used after
  // dismiss/reject so the others stay up for continued triage.
  function removeSpotlightFor(itemId) {
    if (!spotlights.length) return;
    const keep = [];
    for (const s of spotlights) {
      if (s.item.id === itemId) {
        if (s.panelEl && s.panelEl.parentNode) s.panelEl.parentNode.removeChild(s.panelEl);
      } else {
        keep.push(s);
      }
    }
    spotlights = keep;
    scheduleDraw();
  }

  function isOverSpotlight(clientX, clientY) {
    if (!spotlights.length) return false;
    for (const s of spotlights) {
      const rect = s.panelEl.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top  && clientY <= rect.bottom) return true;
    }
    return false;
  }

  // Weighted-random pick without replacement, biased by star radius
  // (and proximity to the click origin as a soft secondary bias).
  // Restricted to a disk of (SPOTLIGHT_RADIUS_MULT × max-possible-star-radius)
  // around (originSx, originSy). If the origin is omitted, falls back to the
  // viewport center with no disk filtering.
  function pickSpotlightItems(allItems, visiblePoints, n, originSx, originSy) {
    if (!visiblePoints || visiblePoints.length === 0) return [];
    const w = canvas.width / pixelRatio, h = canvas.height / pixelRatio;
    const hasOrigin = Number.isFinite(originSx) && Number.isFinite(originSy);
    const cx = hasOrigin ? originSx : w / 2;
    const cy = hasOrigin ? originSy : h / 2;
    const maxStarR = STAR_BASE * STAR_MAX_MULT;
    const selectR = SPOTLIGHT_RADIUS_MULT * maxStarR;
    const maxDist = hasOrigin ? selectR : Math.hypot(cx, cy);

    // Each candidate gets weight = radius^2 * (1 + proximity_bonus)
    // proximity_bonus in [0..0.5], higher when closer to the origin.
    const candidates = [];
    for (const p of visiblePoints) {
      if (p.dismissed) continue;   // white dwarfs are spent — skip
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (hasOrigin && d > selectR) continue;
      const proximity = 1 - Math.min(1, d / maxDist);
      const weight = (p.radius * p.radius) * (1 + 0.5 * proximity);
      candidates.push({ point: p, weight });
    }

    const picked = [];
    const remaining = candidates.slice();
    for (let k = 0; k < Math.min(n, remaining.length); k++) {
      const total = remaining.reduce((s, c) => s + c.weight, 0);
      if (total <= 0) break;
      let r = Math.random() * total;
      let chosenIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        r -= remaining[i].weight;
        if (r <= 0) { chosenIdx = i; break; }
      }
      picked.push(remaining[chosenIdx].point);
      remaining.splice(chosenIdx, 1);
    }
    return picked;
  }

  function makeSpotlightPanel(item, onClose) {
    const el = document.createElement("div");
    el.className = "cpanel spotlight";
    // pointer-events on so user can interact with it
    el.style.pointerEvents = "auto";

    const actions = document.createElement("div");
    actions.className = "spotlight-actions";

    // Dismiss (soft, no ML signal — turns the star into a white dwarf)
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "spotlight-btn spotlight-dismiss";
    dismissBtn.textContent = "✕";
    dismissBtn.title = "Dismiss — fade this to a white dwarf (no ML signal)";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissItem(item);
    });
    actions.appendChild(dismissBtn);

    // Reject (hard, heavy negative ML signal — removes the star entirely)
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "spotlight-btn spotlight-reject";
    rejectBtn.textContent = "⊘";
    rejectBtn.title = "Reject — strong negative signal, train the model away from this";
    rejectBtn.setAttribute("aria-label", "Reject");
    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      rejectItem(item);
    });
    actions.appendChild(rejectBtn);
    el.appendChild(actions);

    el.appendChild(makeRow(primaryTag(item), "panel-source"));
    el.appendChild(makeRow(item.title || "", "panel-title"));
    if (item.ai_comment) {
      el.appendChild(makeRow(item.ai_comment.slice(0, 220), "panel-comment"));
    } else if (item.snippet) {
      el.appendChild(makeRow(item.snippet.slice(0, 220), "panel-snippet"));
    }
    if (item.tags && item.tags.length) {
      el.appendChild(makeRow(item.tags.slice(0, 4).join(" · "), "panel-tags"));
    }

    el.addEventListener("click", (e) => {
      // Don't open if user clicked one of the action buttons
      if (e.target.closest(".spotlight-btn")) return;
      openItem(item);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      dismissItem(item);
    });
    return el;
  }

  function drawSpotlightLines() {
    if (spotlights.length === 0) return;
    ctx.save();
    ctx.strokeStyle = "rgba(201, 163, 255, 0.55)";  // accent purple, soft
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const s of spotlights) {
      const star = worldToScreen(s.starWX, s.starWY);
      // Anchor line at the panel edge nearest the star
      const px = s.panelLeft + s.panelW / 2;
      const py = s.panelTop  + s.panelH / 2;
      // Decide which side of the panel to anchor on
      const dx = star.x - px;
      const dy = star.y - py;
      const ax = px + Math.sign(dx) * Math.min(s.panelW / 2, Math.abs(dx) * 0.5);
      const ay = py + Math.sign(dy) * Math.min(s.panelH / 2, Math.abs(dy) * 0.5);

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(star.x, star.y);
      ctx.stroke();

      // Highlight the spotlit star
      ctx.save();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(star.x, star.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(201, 163, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- pointer + touch ----------
  function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function onMouseDown(e) {
    if (singularityActive) return;
    // Middle-click: spotlight up to 5 random items near the click point.
    if (e.button === 1) {
      e.preventDefault();   // suppress Windows autoscroll cursor
      const { x: sx, y: sy } = clientToCanvas(e.clientX, e.clientY);
      triggerSpotlight(sx, sy);
      return;
    }
    if (e.button !== 0) return;

    // Left click on an existing spotlight panel area? Let it through (clicks on
    // the panel itself are handled by their own listeners). We only clear when
    // dragging starts on the canvas itself away from a panel.
    if (spotlights.length > 0 && !isOverSpotlight(e.clientX, e.clientY)) {
      clearSpotlights();
    }

    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    canvas.style.cursor = "grabbing";
    hideOverlay();
  }
  function onMouseMove(e) {
    if (singularityActive) return;
    const { x: sx, y: sy } = clientToCanvas(e.clientX, e.clientY);
    if (dragging) {
      view.x = dragStart.vx - (e.clientX - dragStart.x) / view.scale;
      view.y = dragStart.vy - (e.clientY - dragStart.y) / view.scale;
      scheduleDraw();
      return;
    }
    const h = findHoverAt(sx, sy);
    if (h !== hovered) {
      hovered = h;
      scheduleDraw();
    }
    showPanel(h, e.clientX, e.clientY);
  }
  function onMouseUp() {
    dragging = false;
    canvas.style.cursor = "grab";
  }
  function onMouseLeave() {
    dragging = false;
    if (hovered) { hovered = null; scheduleDraw(); }
    panel.hidden = true;
  }
  function onClick(e) {
    if (singularityActive) return;
    if (!hovered) return;
    if (e.shiftKey) { dismissItem(hovered); return; }
    openItem(hovered);
  }
  function onContextMenu(e) {
    e.preventDefault();
    if (singularityActive) return;
    if (!hovered) return;
    if (e.shiftKey) rejectItem(hovered);
    else dismissItem(hovered);
  }

  function openItem(item) {
    window.open(item.url, "_blank", "noopener,noreferrer");
    fetch(`/api/items/${item.id}/click`, { method: "POST" })
      .catch(() => window.toast?.("click logging failed"));
  }

  // Soft hide: star stays in place but turns into a white dwarf. Persists
  // across sessions until the server-side TTL purges it. No ML signal.
  // Feeds the shared single-slot undo state via window.recordDismissal so
  // the header undo button works regardless of which view dismissed it.
  function dismissItem(item) {
    const id = item.id;
    const target = items.find((it) => it.id === id);
    if (target) target.status = "dismissed";
    if (hovered && hovered.id === id) hovered = null;
    panel.hidden = true;
    removeSpotlightFor(id);
    scheduleDraw();
    fetch(`/api/items/${id}/dismiss`, { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        window.recordDismissal?.(id);
      })
      .catch(() => window.toast?.("dismiss failed — server unreachable"));
  }

  // Hard remove: star disappears from the constellation entirely and the
  // classifier learns this as a heavy negative.
  function rejectItem(item) {
    const id = item.id;
    items = items.filter((it) => it.id !== id);
    if (hovered && hovered.id === id) hovered = null;
    panel.hidden = true;
    removeSpotlightFor(id);
    scheduleDraw();
    fetch(`/api/items/${id}/reject`, { method: "POST" })
      .catch(() => window.toast?.("reject failed — server unreachable"));
  }

  function onWheel(e) {
    e.preventDefault();
    if (singularityActive) return;
    const { x: sx, y: sy } = clientToCanvas(e.clientX, e.clientY);
    const before = screenToWorld(sx, sy);

    // Normalize across deltaMode (0=pixel, 1=line, 2=page) and devices.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 100;
    // Clamp so a single mouse-wheel notch (often ~100px) doesn't jolt.
    dy = Math.max(-80, Math.min(80, dy));

    const factor = Math.exp(-dy * 0.0025);
    // Range: from "fits all 5000 stars" to "one star fills the screen"
    view.scale = Math.max(0.02, Math.min(2000, view.scale * factor));
    const after = screenToWorld(sx, sy);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
    scheduleDraw();
    maybeTriggerSingularity();
  }

  // touch: one finger = pan, two fingers = pinch
  function pinchInfo(touches) {
    const a = touches[0], b = touches[1];
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return { cx, cy, dist: Math.hypot(dx, dy) };
  }
  function onTouchStart(e) {
    if (singularityActive) { e.preventDefault(); return; }
    hideOverlay();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchState = { mode: "pan", startX: t.clientX, startY: t.clientY, vx: view.x, vy: view.y };
    } else if (e.touches.length >= 2) {
      const p = pinchInfo(e.touches);
      const { x: sx, y: sy } = clientToCanvas(p.cx, p.cy);
      touchState = { mode: "pinch", startDist: p.dist, startScale: view.scale,
                     focusScreen: { x: sx, y: sy }, focusWorld: screenToWorld(sx, sy) };
    }
    e.preventDefault();
  }
  function onTouchMove(e) {
    if (!touchState) return;
    if (touchState.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      view.x = touchState.vx - (t.clientX - touchState.startX) / view.scale;
      view.y = touchState.vy - (t.clientY - touchState.startY) / view.scale;
      scheduleDraw();
    } else if (touchState.mode === "pinch" && e.touches.length >= 2) {
      const p = pinchInfo(e.touches);
      const ratio = p.dist / Math.max(1, touchState.startDist);
      view.scale = Math.max(0.02, Math.min(2000, touchState.startScale * ratio));
      const after = screenToWorld(touchState.focusScreen.x, touchState.focusScreen.y);
      view.x += touchState.focusWorld.x - after.x;
      view.y += touchState.focusWorld.y - after.y;
      scheduleDraw();
      maybeTriggerSingularity();
    }
    e.preventDefault();
  }
  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      // Tap: single touch with no movement → treat as click on whatever was under it.
      // (This is approximate — full tap detection would track timing/distance.)
      touchState = null;
    } else if (e.touches.length === 1 && touchState?.mode === "pinch") {
      // Drop into pan mode using the remaining finger.
      const t = e.touches[0];
      touchState = { mode: "pan", startX: t.clientX, startY: t.clientY, vx: view.x, vy: view.y };
    }
  }

  // ---------- resize ----------
  function resize() {
    pixelRatio = window.devicePixelRatio || 1;   // re-read for multi-DPI
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * pixelRatio;
    canvas.height = rect.height * pixelRatio;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    scheduleDraw();
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 80);
  }

  // ---------- onboarding overlay (first visit only) ----------
  function showOverlay() {
    if (!overlay) return;
    if (localStorage.getItem("constellar.onboarded") === "1") return;
    overlay.hidden = false;
  }
  function hideOverlay() {
    if (!overlay) return;
    overlay.hidden = true;
    localStorage.setItem("constellar.onboarded", "1");
  }

  // ---------- public ----------
  async function load() {
    const res = await fetch("/api/constellation?limit=5000");
    const data = await res.json();
    items = data.items || [];
    clusters = data.clusters || [];
    recomputeSizingContext();
    buildClusterTags();
    clearSpotlights();   // previous spotlight set is stale after a fresh load
    fitView();
    scheduleDraw();
    if (status) {
      status.textContent = items.length === 0
        ? "no projected items yet — refresh to fetch + embed + map"
        : `${items.length} stars · ${clusters.length} clusters`;
    }
    if (items.length > 0) showOverlay();
    return { items: items.length, clusters: clusters.length };
  }

  function init(canvasEl, panelEl, statusEl, overlayEl, overlayCloseEl) {
    canvas = canvasEl;
    panel = panelEl;
    status = statusEl;
    overlay = overlayEl;
    ctx = canvas.getContext("2d");
    canvas.style.cursor = "grab";

    // Lazily build a layer for spotlight panels next to the canvas.
    spotlightLayer = document.createElement("div");
    spotlightLayer.className = "spotlight-layer";
    canvas.parentElement.appendChild(spotlightLayer);

    on(canvas, "mousedown",   onMouseDown);
    on(canvas, "mousemove",   onMouseMove);
    on(canvas, "mouseup",     onMouseUp);
    on(canvas, "mouseleave",  onMouseLeave);
    on(canvas, "click",       onClick);
    on(canvas, "contextmenu", onContextMenu);
    on(canvas, "wheel",       onWheel, { passive: false });
    on(canvas, "touchstart",  onTouchStart, { passive: false });
    on(canvas, "touchmove",   onTouchMove,  { passive: false });
    on(canvas, "touchend",    onTouchEnd);
    on(canvas, "touchcancel", onTouchEnd);
    // Suppress browser auxclick + middle-click pasting/autoscroll.
    on(canvas, "auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

    // Escape clears spotlights.
    on(window, "keydown", (e) => {
      if (e.key === "Escape" && spotlights.length > 0) clearSpotlights();
    });

    if (overlayCloseEl) on(overlayCloseEl, "click", hideOverlay);
    on(window, "resize", onResize);

    resize();
  }

  return { init, load, redraw: scheduleDraw, get count() { return items.length; } };
})();

window.Constellation = Constellation;
