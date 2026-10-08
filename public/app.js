const DEFAULT_PLACES = ["920587237", "2753915549", "4924922222", "6516141723"];
const POLL_MS = 30_000;
const HISTORY_MS = 3 * 60 * 60 * 1000; // keep 3 hours of samples
const MAX_GAMES = 6;
const COLORS = ["#7cf7c9", "#8a7bff", "#ff6fb5", "#ffc46b", "#6bc5ff", "#ff8a5b"];

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// ---------- state ----------
let places = loadPlaces();
let games = []; // latest API result, in `places` order
const history = loadHistory(); // { [universeId]: [{ t, v }] }
let hover = null; // { x, t } for chart tooltip

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
function loadHistory() {
  const h = read("pulse.history", {});
  const cutoff = Date.now() - HISTORY_MS;
  for (const id in h) h[id] = h[id].filter((p) => p.t > cutoff);
  return h;
}

// ---------- data ----------
async function refresh() {
  if (!places.length) {
    games = [];
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
      (history[g.universeId] ||= []).push({ t: now, v: g.playing });
      history[g.universeId] = history[g.universeId].filter((p) => p.t > now - HISTORY_MS);
    }
    store("pulse.history", history);
    setStatus(`Live · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, true);
    render();
  } catch (err) {
    setStatus("Offline", false);
    showError(err.message);
  }
}

function parsePlace(input) {
  const s = input.trim();
  const m = s.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i) || s.match(/^(\d{3,15})$/);
  return m ? m[1] : null;
}

// ---------- rendering ----------
function render() {
  const total = games.reduce((n, g) => n + g.playing, 0);
  $("#total").textContent = games.length ? full.format(total) : "—";
  renderCards();
  renderShare(total);
  renderLegend();
  drawChart();
}

const colorOf = (g) => COLORS[games.indexOf(g) % COLORS.length];

function renderCards() {
  const root = $("#games");
  const tpl = $("#card-tpl");
  root.replaceChildren(...games.map((g) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const hist = history[g.universeId] || [];
    const prev = hist.length > 1 ? hist[hist.length - 2].v : null;
    const votes = g.upVotes + g.downVotes;
    const rating = votes ? (g.upVotes / votes) * 100 : 0;

    el.style.setProperty("--c", colorOf(g));
    el.querySelector(".icon").src = g.icon || "";
    const name = el.querySelector(".name");
    name.textContent = g.name;
    name.href = g.url;
    el.querySelector(".creator").innerHTML = "";
    el.querySelector(".creator").append(`by ${g.creator}`, g.creatorVerified ? Object.assign(document.createElement("span"), { className: "verified", textContent: " ✓" }) : "");
    el.querySelector(".ccu-value").textContent = full.format(g.playing);
    if (prev !== null && prev !== g.playing) {
      const d = g.playing - prev;
      const delta = el.querySelector(".delta");
      delta.textContent = `${d > 0 ? "▲" : "▼"} ${full.format(Math.abs(d))}`;
      delta.classList.add(d > 0 ? "up" : "down");
    }
    el.querySelector(".visits").textContent = nf.format(g.visits);
    el.querySelector(".favorites").textContent = nf.format(g.favorites);
    el.querySelector(".rating").textContent = votes ? `${rating.toFixed(1)}%` : "—";
    el.querySelector(".updated").textContent = relTime(g.updated);
    el.querySelector(".rating-bar i").style.width = `${rating}%`;
    el.querySelector(".remove").addEventListener("click", () => {
      places = places.filter((p) => p !== String(g.placeId));
      games = games.filter((x) => x !== g);
      savePlaces();
      render();
    });
    requestAnimationFrame(() => drawSpark(el.querySelector(".spark"), hist, colorOf(g)));
    return el;
  }));
}

function renderShare(total) {
  $("#share").replaceChildren(...games.map((g) => {
    const d = document.createElement("div");
    const pct = total ? (g.playing / total) * 100 : 0;
    d.style.setProperty("--c", colorOf(g));
    d.style.flexGrow = Math.max(pct, 0.5);
    d.textContent = pct >= 8 ? `${g.name.replace(/^\[.*?\]\s*/, "")} ${pct.toFixed(0)}%` : "";
    d.title = `${g.name}: ${pct.toFixed(1)}%`;
    return d;
  }));
}

function renderLegend() {
  $("#legend").replaceChildren(...games.map((g) => {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = colorOf(g);
    s.append(i, g.name.replace(/^\[.*?\]\s*/, "").slice(0, 22));
    return s;
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
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}

function drawSpark(canvas, hist, color) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (hist.length < 2) {
    ctx.fillStyle = "#868bb0";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillText("collecting samples…", 0, height / 2 + 4);
    return;
  }
  const vs = hist.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
  const pts = hist.map((p) => [((p.t - t0) / (t1 - t0 || 1)) * width, height - 4 - ((p.v - min) / span) * (height - 8)]);
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, color + "55");
  grad.addColorStop(1, color + "00");
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawChart() {
  const canvas = $("#chart");
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 56, r: 12, t: 10, b: 24 };
  const series = games.map((g) => ({ g, pts: history[g.universeId] || [] })).filter((s) => s.pts.length);
  const all = series.flatMap((s) => s.pts);
  ctx.font = "11px JetBrains Mono, monospace";

  if (!all.length) {
    ctx.fillStyle = "#868bb0";
    ctx.fillText("Waiting for data…", pad.l, height / 2);
    return;
  }
  const t1 = Date.now();
  const t0 = Math.min(t1 - 10 * 60 * 1000, ...all.map((p) => p.t)); // at least a 10 minute window
  const max = Math.max(...all.map((p) => p.v)) * 1.1 || 1;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);

  // grid + axis labels
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.fillStyle = "#868bb0";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(width - pad.r, y(v));
    ctx.stroke();
    ctx.fillText(nf.format(v), pad.l - 8, y(v) + 4);
  }
  ctx.textAlign = "center";
  const ticks = Math.max(2, Math.min(6, Math.floor((width - pad.l) / 90)));
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) / ticks) * i;
    ctx.fillText(new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), x(t), height - 6);
  }

  for (const { g, pts } of series) {
    const c = colorOf(g);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.shadowColor = c;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(x(last.t), y(last.v), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  }

  // hover crosshair + tooltip
  const tip = $("#tooltip");
  if (!hover) {
    tip.hidden = true;
    return;
  }
  const ht = t0 + ((hover.x - pad.l) / (width - pad.l - pad.r)) * (t1 - t0);
  const rows = series.map(({ g, pts }) => {
    const p = pts.reduce((a, b) => (Math.abs(b.t - ht) < Math.abs(a.t - ht) ? b : a));
    return { g, p };
  });
  const snapT = rows[0].p.t;
  ctx.strokeStyle = "rgba(255,255,255,.25)";
  ctx.beginPath();
  ctx.moveTo(x(snapT), pad.t);
  ctx.lineTo(x(snapT), height - pad.b);
  ctx.stroke();
  tip.replaceChildren(
    Object.assign(document.createElement("span"), { textContent: new Date(snapT).toLocaleTimeString() }),
    ...rows.map(({ g, p }) => {
      const r = document.createElement("span");
      r.style.color = colorOf(g);
      const b = document.createElement("b");
      b.textContent = full.format(p.v);
      r.append(`● `, b, ` ${g.name.replace(/^\[.*?\]\s*/, "").slice(0, 18)}`);
      return r;
    })
  );
  tip.hidden = false;
  const left = Math.min(x(snapT) + 36, canvas.parentElement.clientWidth - tip.offsetWidth - 8);
  tip.style.left = `${left}px`;
  tip.style.top = "64px";
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

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const place = parsePlace($("#query").value);
  if (!place) return showError("That doesn't look like a Roblox game link or place ID.");
  if (places.includes(place)) return showError("Already tracking that game.");
  if (places.length >= MAX_GAMES) return showError(`You can track up to ${MAX_GAMES} games at once.`);
  places.push(place);
  savePlaces();
  $("#query").value = "";
  refresh();
});

$("#chart").addEventListener("pointermove", (e) => {
  hover = { x: e.offsetX };
  drawChart();
});
$("#chart").addEventListener("pointerleave", () => {
  hover = null;
  drawChart();
});
// redraw whenever the chart's box changes size, so the canvas never renders stretched
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 80);
}).observe($("#chart"));

$("#games").replaceChildren(...places.map(() => Object.assign(document.createElement("div"), { className: "card skeleton" })));
refresh();
setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
