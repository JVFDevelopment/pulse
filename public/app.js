const DEFAULT_PLACES = ["920587237", "2753915549", "4924922222", "6516141723"];
const POLL_MS = 30_000;
const LOCAL_MS = 3 * 60 * 60 * 1000; // samples this browser collected, kept for 3 hours
const MAX_GAMES = 6;
const COLORS = ["#7cf7c9", "#8a7bff", "#ff6fb5", "#ffc46b", "#6bc5ff", "#ff8a5b"];
const RANGES = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3 };
const TIME_STEPS = [15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const shortName = (name) => name.replace(/^\[.*?\]\s*/, ""); // drop event tags like "[🎃]"

// ---------- state ----------
let places = loadPlaces();
let games = []; // latest API result, in `places` order
const local = loadLocal(); // { [universeId]: [{ t, v }] }
const series = new Map(); // universeId -> server history + local samples, merged
const hidden = new Set(); // universe IDs switched off in the chart legend
let range = RANGES[read("pulse.range")] ? read("pulse.range") : "24h";
let mode = read("pulse.mode") === "pct" ? "pct" : "abs"; // chart values: players, or % change since the range start

// a game's points for the chart: in range, and as % change from the first one in "pct" mode
function plotPoints(g) {
  const pts = inRange(series.get(g.universeId) || []);
  if (mode === "abs" || !pts.length) return pts.map((p) => ({ ...p, raw: p.v }));
  const base = pts[0].v || 1;
  return pts.map((p) => ({ t: p.t, v: (p.v / base - 1) * 100, raw: p.v }));
}
const pctLabel = (v) => `${v > 0 ? "+" : ""}${Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)}%`;
let hover = null; // pointer x over the chart
let first = true;

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function loadPlaces() {
  const fromHash = location.hash.slice(1).split(",").filter((s) => /^\d+$/.test(s));
  if (fromHash.length) return fromHash.slice(0, MAX_GAMES);
  return read("pulse.places", DEFAULT_PLACES);
}
function savePlaces() {
  store("pulse.places", places);
  window.history.replaceState(null, "", `#${places.join(",")}`);
}
function loadLocal() {
  const h = read("pulse.history", {});
  const cutoff = Date.now() - LOCAL_MS;
  for (const id in h) h[id] = h[id].filter((p) => p.t > cutoff);
  return h;
}

// ---------- data ----------
async function refresh() {
  if (!places.length) {
    games = [];
    buildSeries();
    render();
    return;
  }
  setStatus("Updating…", false);
  try {
    const res = await fetch(`/api/games?places=${places.join(",")}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);

    // drop places Roblox couldn't resolve so they don't fail every poll
    if (body.notFound?.length) {
      showError(`Couldn't find place ${body.notFound.join(", ")}.`);
      places = places.filter((p) => !body.notFound.includes(p));
      savePlaces();
    } else showError("");

    const byPlace = new Map(body.games.map((g) => [String(g.placeId), g]));
    // a place ID can belong to a universe whose root place differs; fall back to API order
    games = places.map((p) => byPlace.get(p)).filter(Boolean);
    if (games.length < body.games.length) games = body.games;

    const now = Date.now();
    for (const g of games) {
      (local[g.universeId] ||= []).push({ t: now, v: g.playing });
      local[g.universeId] = local[g.universeId].filter((p) => p.t > now - LOCAL_MS);
    }
    store("pulse.history", local);
    buildSeries();
    setStatus(`Live · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, true);
    render();
  } catch (err) {
    setStatus("Offline", false);
    showError(err.message);
  } finally {
    restartPollBar();
    $("#add button").classList.remove("busy");
  }
}

// merge the server's 10-minute history with this browser's 30-second samples
function buildSeries() {
  series.clear();
  for (const g of games) {
    const pts = [...(g.history || []).map(([t, v]) => ({ t, v })), ...(local[g.universeId] || [])].sort((a, b) => a.t - b.t);
    const merged = [];
    for (const p of pts) {
      const last = merged[merged.length - 1];
      if (last && p.t - last.t < 20_000) merged[merged.length - 1] = p;
      else merged.push(p);
    }
    series.set(g.universeId, merged);
  }
}

const inRange = (pts) => {
  const from = Date.now() - RANGES[range];
  return pts.filter((p) => p.t >= from);
};

// linear interpolation inside the data; null outside it
function valueAt(pts, t) {
  if (!pts.length || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  const i = pts.findIndex((p) => p.t >= t);
  if (i === 0 || pts[i].t === t) return pts[i].v;
  const a = pts[i - 1], b = pts[i];
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

// fractional change over the last `ms`, or null without enough history
function changeOver(pts, ms) {
  if (pts.length < 2) return null;
  const now = pts[pts.length - 1];
  const then = valueAt(pts, now.t - ms);
  return then ? (now.v - then) / then : null;
}

// total players across tracked games over the last `ms`, at every timestamp any of them has
function totalSeries(ms = RANGES[range]) {
  const from = Date.now() - ms;
  const lists = games.map((g) => (series.get(g.universeId) || []).filter((p) => p.t >= from)).filter((l) => l.length);
  if (!lists.length || lists.length !== games.length) return [];
  const start = Math.max(...lists.map((l) => l[0].t));
  const times = [...new Set(lists.flatMap((l) => l.map((p) => p.t)))].filter((t) => t >= start).sort((a, b) => a - b);
  return times.map((t) => ({ t, v: lists.reduce((n, l) => n + (valueAt(l, t) ?? l[l.length - 1].v), 0) }));
}

function parsePlace(input) {
  const s = input.trim();
  const m = s.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i) || s.match(/^(\d{3,15})$/);
  return m ? m[1] : null;
}

// ---------- rendering ----------
function render() {
  const total = games.reduce((n, g) => n + g.playing, 0);
  renderTotal(total);
  renderCards();
  renderShare(total);
  renderLegend();
  updateChart();
  first = false;
}

const colorOf = (g) => COLORS[games.indexOf(g) % COLORS.length];

// count a number up/down to its new value, flashing on live changes
function tween(el, to, fmt = (n) => full.format(n)) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
  if (from) {
    el.classList.remove("tick-up", "tick-down");
    void el.offsetWidth; // restart the flash animation
    el.classList.add(to > from ? "tick-up" : "tick-down");
  }
  const start = performance.now(), dur = from ? 700 : 1200;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function trend(el, change, label) {
  if (change == null || !Number.isFinite(change)) {
    el.textContent = "";
    el.className = "trend";
    return;
  }
  const up = change >= 0;
  el.textContent = `${up ? "▲" : "▼"} ${Math.abs(change * 100).toFixed(1)}% ${label}`;
  el.className = `trend ${up ? "up" : "down"}`;
}

// shrink a big number's font until its final value fits on one line
function fitText(el, text) {
  const shown = el.textContent;
  el.style.fontSize = "";
  el.textContent = text;
  const { scrollWidth, clientWidth } = el;
  if (scrollWidth > clientWidth) el.style.fontSize = `${Math.floor((parseFloat(getComputedStyle(el).fontSize) * clientWidth) / scrollWidth)}px`;
  el.textContent = shown;
}

function renderTotal(total) {
  $(".big-stat").classList.remove("loading");
  fitText($("#total"), full.format(total));
  tween($("#total"), total);
  const tot = totalSeries();
  trend($("#total-delta"), changeOver(totalSeries(2 * 3600e3), 3600e3), "in 1h"); // independent of the chosen range
  const vs = tot.map((p) => p.v);
  $("#peak").textContent = vs.length > 1 ? nf.format(Math.max(...vs)) : "—";
  $("#low").textContent = vs.length > 1 ? nf.format(Math.min(...vs)) : "—";
  drawSpark($("#total-spark"), tot, "#7cf7c9");
}

const cardEls = new Map(); // universeId -> card element, updated in place between polls

function renderCards() {
  const root = $("#games");
  root.querySelectorAll(".skeleton").forEach((s) => s.remove());
  const ids = new Set(games.map((g) => g.universeId));
  for (const [id, el] of cardEls) if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
  games.forEach((g, i) => {
    let el = cardEls.get(g.universeId);
    if (!el) {
      el = createCard(g);
      el.style.animationDelay = `${first ? i * 80 : 0}ms`;
      cardEls.set(g.universeId, el);
    }
    if (root.children[i] !== el) root.insertBefore(el, root.children[i] ?? null);
    updateCard(el, g);
  });
}

function createCard(g) {
  const el = $("#card-tpl").content.firstElementChild.cloneNode(true);
  const icon = el.querySelector(".icon");
  icon.addEventListener("load", () => icon.classList.add("loaded"), { once: true });
  icon.src = g.icon || "";
  const name = el.querySelector(".name");
  name.textContent = g.name;
  name.href = g.url;
  el.querySelector(".creator").append(`by ${g.creator}`, g.creatorVerified ? Object.assign(document.createElement("span"), { className: "verified", textContent: " ✓" }) : "");
  el.querySelector(".remove").addEventListener("click", () => {
    places = places.filter((p) => p !== String(g.placeId));
    savePlaces();
    let gone = false;
    const done = () => {
      if (gone) return;
      gone = true;
      games = games.filter((x) => x.universeId !== g.universeId);
      cardEls.delete(g.universeId);
      el.remove();
      buildSeries();
      render();
    };
    if (reduceMotion) return done();
    el.style.animationDelay = "0ms"; // don't inherit the staggered entrance delay
    el.classList.add("leaving");
    el.addEventListener("animationend", (e) => e.target === el && done());
    setTimeout(done, 450); // in case the animation never reports finishing
  });
  return el;
}

function updateCard(el, g) {
  const color = colorOf(g);
  const pts = inRange(series.get(g.universeId) || []);
  const votes = g.upVotes + g.downVotes;
  const rating = votes ? (g.upVotes / votes) * 100 : 0;
  el.style.setProperty("--c", color);
  el.classList.toggle("muted", hidden.has(g.universeId));
  tween(el.querySelector(".ccu-value"), g.playing);
  trend(el.querySelector(".trend"), changeOver(series.get(g.universeId) || [], 3600e3), "1h");
  const vs = pts.map((p) => p.v);
  el.querySelector(".peak").textContent = vs.length > 1 ? `Peak ${nf.format(Math.max(...vs))}` : "";
  el.querySelector(".low").textContent = vs.length > 1 ? `Low ${nf.format(Math.min(...vs))}` : "";
  el.querySelector(".visits").textContent = nf.format(g.visits);
  el.querySelector(".favorites").textContent = nf.format(g.favorites);
  el.querySelector(".rating").textContent = votes ? `${rating.toFixed(1)}%` : "—";
  el.querySelector(".updated").textContent = relTime(g.updated);
  el.querySelector(".rating-bar i").style.width = `${rating}%`;
  requestAnimationFrame(() => drawSpark(el.querySelector(".spark"), pts, color));
}

function renderShare(total) {
  const bar = $("#share"), key = $("#share-key");
  const segs = new Map([...bar.children].map((d) => [d.dataset.id, d]));
  bar.replaceChildren(...games.map((g) => {
    const d = segs.get(String(g.universeId)) ?? Object.assign(document.createElement("div"), { style: "flex-grow: 0" });
    const pct = total ? (g.playing / total) * 100 : 0;
    d.dataset.id = g.universeId;
    d.style.setProperty("--c", colorOf(g));
    requestAnimationFrame(() => (d.style.flexGrow = Math.max(pct, 0.5))); // grows in from 0 on first paint
    d.textContent = pct >= 9 ? `${pct.toFixed(0)}%` : "";
    d.title = `${g.name}: ${pct.toFixed(1)}%`;
    return d;
  }));
  key.replaceChildren(...games.map((g) => {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = colorOf(g);
    const b = document.createElement("b");
    b.textContent = `${total ? ((g.playing / total) * 100).toFixed(1) : 0}%`;
    s.append(i, shortName(g.name).slice(0, 24), b);
    return s;
  }));
}

function renderLegend() {
  $("#legend").replaceChildren(...games.map((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.setProperty("--c", colorOf(g));
    b.setAttribute("aria-pressed", String(!hidden.has(g.universeId)));
    b.title = "Show or hide on the chart";
    const i = document.createElement("i");
    b.append(i, shortName(g.name).slice(0, 22));
    b.addEventListener("click", () => {
      hidden.has(g.universeId) ? hidden.delete(g.universeId) : hidden.add(g.universeId);
      renderLegend();
      cardEls.get(g.universeId)?.classList.toggle("muted", hidden.has(g.universeId));
      updateChart();
    });
    return b;
  }));
}

function relTime(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return "just now";
}

// ---------- charts (hand-drawn canvas, no library) ----------
function setupCanvas(canvas) {
  const dpr = devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}

// smooth curve through points that never overshoots them (monotone cubic, as in d3's curveMonotoneX)
function smoothPath(ctx, P) {
  const n = P.length;
  ctx.moveTo(P[0][0], P[0][1]);
  if (n < 2) return;
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = P[i + 1][0] - P[i][0];
    m[i] = dx[i] ? (P[i + 1][1] - P[i][1]) / dx[i] : 0;
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    ctx.bezierCurveTo(P[i][0] + h, P[i][1] + h * t[i], P[i + 1][0] - h, P[i + 1][1] - h * t[i + 1], P[i + 1][0], P[i + 1][1]);
  }
}

function fillArea(ctx, P, bottom, color, top) {
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, color + "40");
  grad.addColorStop(1, color + "00");
  ctx.beginPath();
  smoothPath(ctx, P);
  ctx.lineTo(P[P.length - 1][0], bottom);
  ctx.lineTo(P[0][0], bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function drawSpark(canvas, pts, color) {
  const wrap = canvas.parentElement;
  wrap.classList.toggle("pending", pts.length < 2);
  const { ctx, width, height } = setupCanvas(canvas);
  if (pts.length < 2) return;
  if (!canvas._drawn && !reduceMotion) canvas.classList.add("draw-in");
  canvas._drawn = true;
  const vs = pts.map((p) => p.v);
  const span = Math.max(...vs) - Math.min(...vs) || Math.max(...vs) * 0.1 || 1;
  const lo = Math.min(...vs) - span * 0.15, hi = Math.max(...vs) + span * 0.15;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const P = pts.map((p) => [3 + ((p.t - t0) / (t1 - t0 || 1)) * (width - 9), 3 + (1 - (p.v - lo) / (hi - lo)) * (height - 6)]);
  fillArea(ctx, P, height, color, 0);
  ctx.beginPath();
  smoothPath(ctx, P);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();
  const [ex, ey] = P[P.length - 1];
  ctx.beginPath();
  ctx.arc(ex, ey, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// round axis bounds to friendly numbers (1, 2, 2.5, 5 x 10^n)
function niceScale(lo, hi, ticks = 4) {
  const raw = (hi - lo) / ticks || hi || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

// the main chart eases between axis ranges and draws itself in on first load
const chart = { view: null, from: null, to: null, animStart: 0, reveal: reduceMotion ? 1 : 0, revealStart: null, raf: 0 };

function chartTarget() {
  const t1 = Date.now();
  const pts = games.filter((g) => !hidden.has(g.universeId)).flatMap(plotPoints);
  if (!pts.length) return null;
  const vs = pts.map((p) => p.v);
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const pad = (vmax - vmin) * 0.12 || Math.abs(vmax) * 0.1 || 1;
  const s = niceScale(mode === "abs" ? Math.max(0, vmin - pad) : vmin - pad, vmax + pad);
  const t0 = Math.min(t1 - 60e3, Math.min(...pts.map((p) => p.t))); // span the data, at least a minute wide
  return { t0, t1, lo: s.lo, hi: s.hi, step: s.step };
}

function updateChart() {
  const target = chartTarget();
  $(".chart-wrap").classList.remove("loading");
  if (!target) {
    chart.view = null;
    drawChart();
    return;
  }
  if (!chart.view || reduceMotion) chart.view = { ...target };
  else {
    chart.from = { ...chart.view };
    chart.to = target;
    chart.animStart = performance.now();
  }
  kickChart();
}

function kickChart() {
  if (!chart.raf) chart.raf = requestAnimationFrame(chartFrame);
}

function chartFrame(now) {
  chart.raf = 0;
  let busy = false;
  if (chart.to) {
    const p = Math.min(1, (now - chart.animStart) / 550), e = 1 - (1 - p) ** 3;
    for (const k of ["t0", "t1", "lo", "hi"]) chart.view[k] = chart.from[k] + (chart.to[k] - chart.from[k]) * e;
    chart.view.step = chart.to.step;
    if (p < 1) busy = true;
    else chart.to = null;
  }
  if (chart.reveal < 1) {
    chart.revealStart ??= now;
    chart.reveal = Math.min(1, (now - chart.revealStart) / 1200);
    busy ||= chart.reveal < 1;
  }
  drawChart();
  if (busy) kickChart();
}

function drawChart() {
  const canvas = $("#chart");
  const { ctx, width, height } = setupCanvas(canvas);
  const v = chart.view;
  if (!v) {
    placeEnds([]);
    hideTip();
    ctx.font = "13px Space Grotesk, sans-serif";
    ctx.fillStyle = "#868bb0";
    ctx.textAlign = "center";
    ctx.fillText(games.length ? "All games are hidden. Pick one in the legend." : "Track a game to start charting.", width / 2, height / 2);
    return;
  }
  const pad = { l: 52, r: 16, t: 12, b: 26 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const x = (t) => pad.l + ((t - v.t0) / (v.t1 - v.t0)) * W;
  const y = (val) => pad.t + (1 - (val - v.lo) / (v.hi - v.lo)) * H;
  const reveal = 1 - (1 - chart.reveal) ** 3;

  // grid + axis labels
  ctx.font = "11px JetBrains Mono, monospace";
  ctx.fillStyle = "#868bb0";
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.textAlign = "right";
  ctx.setLineDash([3, 5]);
  for (let val = Math.ceil(v.lo / v.step) * v.step; val <= v.hi + v.step * 0.01; val += v.step) {
    const yy = Math.round(y(val)) + 0.5;
    if (yy < pad.t - 1 || yy > height - pad.b + 1) continue;
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(width - pad.r, yy);
    ctx.stroke();
    ctx.fillText(mode === "pct" ? pctLabel(Math.round(val * 100) / 100) : nf.format(val), pad.l - 10, yy + 4);
  }
  ctx.setLineDash([]);
  // time labels on round local times, spaced so they never repeat
  const maxTicks = Math.max(2, Math.floor(W / 100));
  const step = TIME_STEPS.find((s) => (v.t1 - v.t0) / s <= maxTicks) ?? 12 * 3600e3;
  const tz = new Date().getTimezoneOffset() * 60e3;
  const fmt = step < 60e3 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
  for (let t = Math.ceil((v.t0 - tz) / step) * step + tz; t <= v.t1; t += step) {
    const tx = x(t);
    ctx.textAlign = tx < pad.l + 30 ? "left" : tx > width - pad.r - 30 ? "right" : "center";
    ctx.fillText(new Date(t).toLocaleTimeString([], fmt), tx, height - 6);
  }

  // series, revealed left to right on first load
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l - 4, 0, W * reveal + 8, height);
  ctx.clip();
  const ends = [], rows = [];
  for (const g of games) {
    if (hidden.has(g.universeId)) continue;
    const pts = plotPoints(g);
    if (!pts.length) continue;
    const c = colorOf(g);
    const P = pts.map((p) => [x(p.t), y(p.v)]);
    if (P.length > 1) {
      fillArea(ctx, P, height - pad.b, c, pad.t);
      ctx.beginPath();
      smoothPath(ctx, P);
      ctx.strokeStyle = c;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      ctx.shadowColor = c;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ends.push({ c, x: P[P.length - 1][0], y: P[P.length - 1][1] });
    rows.push({ g, c, pts });
  }
  ctx.restore();
  placeEnds(chart.reveal >= 1 ? ends : []);

  // hover crosshair + tooltip
  if (hover === null || chart.reveal < 1 || !rows.length || hover < pad.l || hover > width - pad.r) return hideTip();
  const ht = v.t0 + ((hover - pad.l) / W) * (v.t1 - v.t0);
  const hits = rows.map((r) => ({ ...r, p: r.pts.reduce((a, b) => (Math.abs(b.t - ht) < Math.abs(a.t - ht) ? b : a)) }));
  const snapT = hits.reduce((a, b) => (Math.abs(b.p.t - ht) < Math.abs(a.p.t - ht) ? b : a)).p.t;
  const cx = Math.round(x(snapT)) + 0.5;
  ctx.strokeStyle = "rgba(255,255,255,.28)";
  ctx.beginPath();
  ctx.moveTo(cx, pad.t);
  ctx.lineTo(cx, height - pad.b);
  ctx.stroke();
  for (const h of hits) {
    ctx.beginPath();
    ctx.arc(x(h.p.t), y(h.p.v), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#07080f";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = h.c;
    ctx.stroke();
  }
  const tip = $("#tooltip");
  tip.replaceChildren(
    Object.assign(document.createElement("span"), { className: "tip-time", textContent: new Date(snapT).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) }),
    ...hits.sort((a, b) => b.p.v - a.p.v).map(({ g, c, p }) => {
      const r = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = c;
      const b = document.createElement("b");
      b.textContent = mode === "pct" ? `${pctLabel(p.v)} · ${nf.format(p.raw)}` : full.format(p.v);
      r.append(i, b, ` ${shortName(g.name).slice(0, 18)}`);
      return r;
    })
  );
  tip.hidden = false;
  const flip = cx + 20 + tip.offsetWidth > width;
  tip.style.transform = `translate(${flip ? cx - tip.offsetWidth - 16 : cx + 16}px, ${pad.t + 6}px)`;
}

function hideTip() {
  $("#tooltip").hidden = true;
}

// pulsing dots at the live end of each line (CSS-animated, so the canvas doesn't redraw for them)
function placeEnds(ends) {
  const box = $("#ends");
  while (box.children.length < ends.length) box.append(document.createElement("span"));
  [...box.children].forEach((s, i) => {
    const e = ends[i];
    s.hidden = !e;
    if (!e) return;
    s.style.setProperty("--c", e.c);
    s.style.transform = `translate(${e.x}px, ${e.y}px)`;
  });
}

// ---------- UI wiring ----------
function setStatus(text, on) {
  $("#status").textContent = text;
  $(".live").classList.toggle("on", on);
}
function showError(msg) {
  $("#error").textContent = msg;
  $("#error").hidden = !msg;
}
function restartPollBar() {
  const bar = $(".poll i");
  bar.classList.remove("run");
  void bar.offsetWidth;
  bar.classList.add("run");
}
function setRange(r) {
  range = r;
  store("pulse.range", r);
  document.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === r)));
  document.querySelectorAll(".range-label").forEach((s) => (s.textContent = r));
  if (games.length) render();
}

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const place = parsePlace($("#query").value);
  if (!place) return showError("That doesn't look like a Roblox game link or place ID.");
  if (places.includes(place)) return showError("Already tracking that game.");
  if (places.length >= MAX_GAMES) return showError(`You can track up to ${MAX_GAMES} games at once.`);
  places.push(place);
  savePlaces();
  $("#query").value = "";
  $("#add button").classList.add("busy");
  refresh();
});

document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setRange(b.dataset.range)));

function setMode(m) {
  mode = m;
  store("pulse.mode", m);
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  if (games.length) updateChart();
}
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
setMode(mode);

const plot = $("#chart");
plot.addEventListener("pointermove", (e) => {
  hover = e.offsetX;
  drawChart();
});
plot.addEventListener("pointerdown", (e) => {
  hover = e.offsetX;
  drawChart();
});
for (const type of ["pointerleave", "pointercancel"]) {
  plot.addEventListener(type, () => {
    hover = null;
    drawChart();
  });
}

// redraw canvases whenever the layout changes width, so they never render stretched
let resizeTimer, lastWidth = innerWidth;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (innerWidth === lastWidth && chart.view) return drawChart();
    lastWidth = innerWidth;
    games.length && render();
  }, 80);
}).observe(plot);

$("#games").replaceChildren(...places.map(() => Object.assign(document.createElement("div"), { className: "card skeleton" })));
setRange(range);
refresh();
setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
