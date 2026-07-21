/* ============================================================
   Ridgewood Command Center — front-end
   Reads the JSON committed by the GitHub Action, and (for the
   freshest possible weather) also talks to a couple of CORS-
   friendly APIs live in the browser.
   ============================================================ */

"use strict";

const RIDGEWOOD = { lat: 40.7002, lon: -73.906 };
const NWS_UA = "RidgewoodCommandCenter (github.com/ebbanflo/ridgewood)";

/* ---------- tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Read a committed data file, cache-busted so the phone sees fresh commits.
async function loadData(name) {
  try {
    return await getJSON(`data/${name}?t=${Date.now()}`);
  } catch (e) {
    console.warn("no local data for", name, e.message);
    return null;
  }
}

function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Map an NWS text/icon to a friendly emoji.
function wxEmoji(text) {
  const t = (text || "").toLowerCase();
  if (/thunder|t-storm|tstm/.test(t)) return "⛈️";
  if (/snow|flurr|sleet|wintry|blizzard/.test(t)) return "🌨️";
  if (/rain|shower|drizzle/.test(t)) return "🌧️";
  if (/fog|mist|haze/.test(t)) return "🌫️";
  if (/cloud|overcast/.test(t) && /partly|few|mostly sunny/.test(t)) return "⛅";
  if (/cloud|overcast/.test(t)) return "☁️";
  if (/clear|sunny|fair/.test(t)) return "☀️";
  if (/wind|breez/.test(t)) return "🌬️";
  return "🌤️";
}

/* ============================================================
   WEATHER
   ============================================================ */
async function initWeather() {
  let wx = await loadData("weather.json"); // committed data (also has forecast)

  // Paint committed data right away so nothing sits on "loading…".
  if (wx) renderWeather(wx);

  // Try a live current-conditions read so the header stays fresh between
  // Action runs. NWS is CORS-enabled.
  try {
    const pts = await getJSON(
      `https://api.weather.gov/points/${RIDGEWOOD.lat},${RIDGEWOOD.lon}`,
      { headers: { Accept: "application/geo+json" } }
    );
    const stationsUrl = pts.properties.observationStations;
    const stations = await getJSON(stationsUrl);
    const sid = stations.features[0].properties.stationIdentifier;
    const obs = (
      await getJSON(`https://api.weather.gov/stations/${sid}/observations/latest`)
    ).properties;
    const c = obs.temperature && obs.temperature.value;
    if (c != null) {
      wx = wx || { current: {}, hours: [], periods: [] };
      wx.current = wx.current || {};
      wx.current.tempF = Math.round((c * 9) / 5 + 32);
      wx.current.text = obs.textDescription || wx.current.text;
      wx.current.observedAt = obs.timestamp;
    }
  } catch (e) {
    console.warn("live weather failed, using committed data:", e.message);
  }

  renderWeather(wx);
}

function renderWeather(wx) {
  if (!wx) return;
  const cur = wx.current || {};
  const emoji = wxEmoji(cur.text);
  $("#wxEmoji").textContent = emoji;
  $("#wxTemp").textContent = cur.tempF != null ? `${cur.tempF}°` : "—°";
  $("#wxText").textContent = cur.text || "—";

  // Hourly strip
  const strip = $("#wxStrip");
  strip.innerHTML = "";
  (wx.hours || []).slice(0, 12).forEach((h) => {
    const box = el("div", "wx-hour");
    const d = new Date(h.time);
    const hr = isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric" });
    box.appendChild(el("div", "h-time", hr));
    box.appendChild(el("div", "h-emoji", wxEmoji(h.short)));
    box.appendChild(el("div", "h-temp", `${h.tempF}°`));
    if (h.precip) box.appendChild(el("div", "h-precip", `${h.precip}%`));
    strip.appendChild(box);
  });

  // Detail line from the first forecast period
  const detail = $("#wxDetail");
  const p = (wx.periods || [])[0];
  if (p) {
    detail.innerHTML =
      `<strong>${p.name}:</strong> ${p.detailed}` +
      (cur.humidity != null || cur.windMph != null
        ? `<br><strong>Now:</strong> ` +
          [
            cur.feelsF != null ? `feels ${cur.feelsF}°` : null,
            cur.humidity != null ? `${cur.humidity}% humidity` : null,
            cur.windMph != null
              ? `wind ${cur.windMph} mph ${cur.windDir || ""}`.trim()
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "");
  } else {
    detail.textContent = "";
  }
}

/* ============================================================
   MAP  (Leaflet + OSM, warm-tinted; RainViewer radar; NWS hazards)
   ============================================================ */
let MAP, radarLayer, hazardLayer;
const layerState = { radar: true, hazards: true };

function initMap() {
  MAP = L.map("map", {
    center: [RIDGEWOOD.lat, RIDGEWOOD.lon],
    zoom: 15,
    zoomControl: true,
    scrollWheelZoom: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(MAP);

  // A soft ring marking "Ridgewood + a few blocks" for orientation & safety.
  L.circle([RIDGEWOOD.lat, RIDGEWOOD.lon], {
    radius: 1200,
    color: "#5c7f4e",
    weight: 2,
    dashArray: "4 6",
    fillColor: "#7fa06a",
    fillOpacity: 0.06,
  })
    .addTo(MAP)
    .bindPopup("Ridgewood, Queens — core area");

  L.marker([RIDGEWOOD.lat, RIDGEWOOD.lon])
    .addTo(MAP)
    .bindPopup("Ridgewood · Myrtle–Wyckoff");

  hazardLayer = L.layerGroup().addTo(MAP);

  initRadar();
  wireMapToggles();
}

async function initRadar() {
  try {
    const maps = await getJSON("https://api.rainviewer.com/public/weather-maps.json");
    const frames = (maps.radar && maps.radar.past) || [];
    if (!frames.length) return;
    const last = frames[frames.length - 1];
    // 512px tiles, color scheme 4 (universal blue), smooth + snow.
    const url = `${maps.host}${last.path}/512/{z}/{x}/{y}/4/1_1.png`;
    radarLayer = L.tileLayer(url, { opacity: 0.55, zIndex: 400 });
    if (layerState.radar) radarLayer.addTo(MAP);
  } catch (e) {
    console.warn("radar failed:", e.message);
  }
}

function wireMapToggles() {
  $("#mapToggles").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-layer]");
    if (!btn) return;
    const layer = btn.dataset.layer;
    layerState[layer] = !layerState[layer];
    btn.classList.toggle("is-on", layerState[layer]);
    if (layer === "radar" && radarLayer) {
      layerState.radar ? radarLayer.addTo(MAP) : MAP.removeLayer(radarLayer);
    }
    if (layer === "hazards" && hazardLayer) {
      layerState.hazards ? hazardLayer.addTo(MAP) : MAP.removeLayer(hazardLayer);
    }
  });
}

function severityColor(sev) {
  switch ((sev || "").toLowerCase()) {
    case "extreme": return "#7b1f10";
    case "severe":  return "#b8472e";
    case "moderate":return "#d98a3d";
    case "minor":   return "#e4b768";
    default:        return "#c76b4a";
  }
}

/* ============================================================
   HAZARDS / ALERTS
   ============================================================ */
function renderAlerts(data) {
  const banner = $("#alertBanner");
  const alerts = (data && data.alerts) || [];

  // Banner
  banner.innerHTML = "";
  if (!alerts.length) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    alerts.forEach((a) => {
      const item = el("div", "alert-item");
      const title = el("div", "alert-title");
      title.append(el("span", null, "⚠️"), el("span", null, a.event || "Alert"));
      item.appendChild(title);
      const meta = [];
      if (a.severity) meta.push(a.severity);
      if (a.expires) meta.push("until " + new Date(a.expires).toLocaleString());
      if (meta.length) item.appendChild(el("div", "alert-meta", meta.join(" · ")));
      if (a.headline || a.description) {
        const det = el("details");
        det.appendChild(el("summary", null, "Details"));
        det.appendChild(
          el("div", "alert-body", a.instruction || a.description || a.headline)
        );
        item.appendChild(det);
      }
      banner.appendChild(item);
    });
  }

  // Map polygons
  if (!hazardLayer) return;
  hazardLayer.clearLayers();
  alerts.forEach((a) => {
    if (!a.geometry) return;
    try {
      L.geoJSON(a.geometry, {
        style: {
          color: severityColor(a.severity),
          weight: 2,
          fillColor: severityColor(a.severity),
          fillOpacity: 0.18,
        },
      })
        .bindPopup(`<strong>${a.event || "Alert"}</strong><br>${a.headline || ""}`)
        .addTo(hazardLayer);
    } catch (e) {
      /* ignore malformed geometry */
    }
  });
}

async function initAlerts() {
  let data = await loadData("alerts.json");
  // Live refresh (CORS ok)
  try {
    const live = await getJSON(
      `https://api.weather.gov/alerts/active?point=${RIDGEWOOD.lat},${RIDGEWOOD.lon}`,
      { headers: { Accept: "application/geo+json" } }
    );
    data = {
      alerts: (live.features || []).map((f) => ({
        event: f.properties.event,
        severity: f.properties.severity,
        headline: f.properties.headline,
        description: f.properties.description,
        instruction: f.properties.instruction,
        expires: f.properties.expires,
        geometry: f.geometry,
      })),
    };
  } catch (e) {
    console.warn("live alerts failed, using committed:", e.message);
  }
  renderAlerts(data);
}

/* ============================================================
   NEWS  +  NEW PLACES
   ============================================================ */
function renderFeed(container, items, kind) {
  container.innerHTML = "";
  if (!items || !items.length) {
    container.appendChild(
      el(
        "p",
        "empty",
        kind === "places" ? "No new spots reported yet." : "No fresh mentions yet."
      )
    );
    return;
  }
  items.forEach((it) => {
    const isPlace = kind === "places";
    const card = el("a", isPlace ? "place-card" : "news-item");
    card.href = it.link || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.appendChild(el("div", isPlace ? "p-title" : "n-title", it.title));

    const meta = el("div", isPlace ? "p-meta" : "n-meta");
    if (it.source) meta.appendChild(el("span", isPlace ? "p-source" : "n-source", it.source));
    const when = timeAgo(it.published);
    if (when) {
      if (it.source) meta.appendChild(el("span", null, "·"));
      meta.appendChild(el("span", null, when));
    }
    card.appendChild(meta);

    if (it.summary) card.appendChild(el("div", isPlace ? "p-summary" : "n-summary", it.summary));
    container.appendChild(card);
  });
}

async function initNews() {
  const data = await loadData("news.json");
  renderFeed($("#newsFeed"), data && data.items, "news");
  if (data && data.items) $("#newsCount").textContent = data.items.length;
  if (data && data.stale) $("#newsFeed").appendChild(el("p", "stale-note", "· showing last saved results"));
}

async function initPlaces() {
  const data = await loadData("places.json");
  renderFeed($("#placesFeed"), data && data.items, "places");
  if (data && data.items) $("#placesCount").textContent = data.items.length;
  if (data && data.stale) $("#placesFeed").appendChild(el("p", "stale-note", "· showing last saved results"));
}

/* ============================================================
   STATUS + BOOT
   ============================================================ */
async function initStatus() {
  const s = await loadData("status.json");
  if (s && s.updated) {
    $("#statusLine").textContent = `updated ${timeAgo(s.updated)} · refreshes every 10 min`;
  }
}

// Run an init without letting its failure take down the others.
function safe(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === "function") r.catch((e) => console.warn(fn.name, e));
  } catch (e) {
    console.warn(fn.name, e);
  }
}

function boot() {
  safe(initMap);
  safe(initWeather);
  safe(initAlerts);
  safe(initNews);
  safe(initPlaces);
  safe(initStatus);

  // Soft auto-refresh of the live bits every 5 minutes while the app is open.
  setInterval(() => {
    safe(initWeather);
    safe(initAlerts);
  }, 5 * 60 * 1000);

  // Refresh committed feeds when the phone wakes / returns to the app.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      initNews();
      initPlaces();
      initStatus();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
