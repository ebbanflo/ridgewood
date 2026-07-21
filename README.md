# 🌿 Ridgewood Command Center

A little mobile web-app command center for **Ridgewood, Queens, NYC** —
a warm, light, sage-green dashboard with a soft *Pet Sounds* influence.

It shows, top to bottom:

1. **Live weather** beside the **Ridgewood** wordmark in the header.
2. A **map** of Ridgewood (plus a few surrounding blocks for safety) with
   **radar** and **hazard/alert** overlays, an hourly strip, and a forecast note.
3. **Ridgewood in the News** — recent news mentions of Ridgewood, Queens.
4. **New Around Town** — freshly opened stores, cafés, and restaurants.

Data refreshes automatically **every 10 minutes** via GitHub Actions
(the same "war room" pattern), and the header weather also updates *live*
in your browser between runs.

---

## How it works

```
┌────────────────────┐     every 10 min      ┌──────────────────────┐
│ GitHub Actions cron │ ───────────────────▶ │ scripts/fetch_data.py │
└────────────────────┘                        └──────────┬───────────┘
                                                          │ writes JSON
                                                          ▼
                                              data/weather.json
                                              data/alerts.json
                                              data/news.json
                                              data/places.json
                                              data/status.json
                                                          │ committed to repo
                                                          ▼
┌────────────────────┐   reads JSON + live    ┌──────────────────────┐
│  GitHub Pages (SPA) │ ◀───────────────────  │ index.html / app.js   │
└────────────────────┘                        └──────────────────────┘
```

### Data sources (all free, no API keys)

| Feed            | Source                                   |
|-----------------|------------------------------------------|
| Weather         | National Weather Service (`api.weather.gov`) |
| Hazards/alerts  | NWS active alerts (with map polygons)    |
| Radar overlay   | RainViewer (`api.rainviewer.com`)        |
| News mentions   | Google News RSS                          |
| New places      | Google News RSS (filtered)               |
| Map tiles       | OpenStreetMap via Leaflet                |

Weather, alerts, and radar are also fetched **live client-side** (those APIs
allow CORS), so the map and header stay fresh even between Action runs. News
and new-places come from the committed JSON, since RSS needs a server-side fetch.

---

## Deploying (GitHub Pages)

1. Merge this branch into `main`.
2. In **Settings → Pages**, set **Source: Deploy from a branch**, branch
   **`main`**, folder **`/ (root)`**. Save.
3. In **Settings → Actions → General**, ensure **Workflow permissions** is set to
   **Read and write permissions** (so the cron can commit refreshed data).
4. The app lives at `https://<your-user>.github.io/ridgewood/`.
5. On your phone: open that URL in Safari/Chrome → **Add to Home Screen** for a
   full-screen app icon.

The refresh workflow (`.github/workflows/refresh.yml`) runs every 10 minutes,
on manual dispatch, and on pushes to `main`.

> **Note on cron timing:** GitHub's scheduled Actions run on a best-effort basis
> and can be delayed during peak load. The live client-side weather/alerts fetch
> keeps the most important data current regardless.

---

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The map, live weather, alerts, and radar work locally. News/places show their
empty-state until the Action has run (or you run `python scripts/fetch_data.py`
somewhere with open network access).

---

## Customizing

- **Location:** change `LAT`/`LON` in both `scripts/fetch_data.py` and the
  `RIDGEWOOD` constant in `app.js`.
- **Map area ring:** the dashed "core area" circle radius is set in
  `app.js` (`L.circle(..., { radius: 1200 })`).
- **Look & feel:** the palette lives at the top of `styles.css` (`:root`).
- **Refresh cadence:** the cron in `.github/workflows/refresh.yml`.

---

*Green &amp; light, sun-washed and a little faded — like a good day at the beach.*
