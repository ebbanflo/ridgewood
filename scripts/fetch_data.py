#!/usr/bin/env python3
"""
Ridgewood Command Center — data fetcher.

Runs on a GitHub Actions cron (every ~10 min) and writes JSON files into /data
that the static front-end reads. Everything here uses free, key-less sources:

  - Weather + hazard alerts : National Weather Service (api.weather.gov)
  - News mentions           : Google News RSS
  - New stores / restaurants: Google News RSS (filtered)

Design goals:
  - Never hard-crash the whole run because one source is down. Each section is
    wrapped so a failure preserves the previously-committed JSON.
  - Be polite to the APIs (proper User-Agent, small number of requests).
"""

import json
import os
import re
import sys
import time
import html
import datetime as dt
from urllib.parse import quote
from xml.etree import ElementTree as ET

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Center of Ridgewood, Queens, NYC (near Myrtle & Wyckoff).
LAT = 40.7002
LON = -73.9060

# NWS asks every client to identify itself.
UA = "RidgewoodCommandCenter/1.0 (github.com/ebbanflo/ridgewood; contact via github)"
HEADERS = {"User-Agent": UA, "Accept": "application/geo+json"}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def get_json(url, **kw):
    r = SESSION.get(url, timeout=25, **kw)
    r.raise_for_status()
    return r.json()


def load_existing(name):
    """Return previously written JSON so a failing source keeps last-good data."""
    path = os.path.join(DATA_DIR, name)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def write_json(name, payload):
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"  wrote {name} ({os.path.getsize(path)} bytes)")


# ---------------------------------------------------------------------------
# Weather (National Weather Service)
# ---------------------------------------------------------------------------

def fetch_weather():
    # /points resolves our lat/lon to the forecast + observation endpoints.
    points = get_json(f"https://api.weather.gov/points/{LAT},{LON}")
    props = points["properties"]

    forecast_url = props["forecast"]
    hourly_url = props["forecastHourly"]
    stations_url = props["observationStations"]
    rel = props.get("relativeLocation", {}).get("properties", {})
    place = f"{rel.get('city', 'Ridgewood')}, {rel.get('state', 'NY')}"

    current = {}
    try:
        stations = get_json(stations_url)
        station_id = stations["features"][0]["properties"]["stationIdentifier"]
        obs = get_json(
            f"https://api.weather.gov/stations/{station_id}/observations/latest"
        )["properties"]

        def c_to_f(c):
            return None if c is None else round(c * 9 / 5 + 32)

        current = {
            "tempF": c_to_f((obs.get("temperature") or {}).get("value")),
            "feelsF": c_to_f(
                (obs.get("heatIndex") or {}).get("value")
                if (obs.get("heatIndex") or {}).get("value") is not None
                else (obs.get("windChill") or {}).get("value")
            ),
            "humidity": _round((obs.get("relativeHumidity") or {}).get("value")),
            "windMph": _mps_to_mph((obs.get("windSpeed") or {}).get("value")),
            "windDir": _deg_to_compass((obs.get("windDirection") or {}).get("value")),
            "text": obs.get("textDescription"),
            "icon": obs.get("icon"),
            "station": station_id,
            "observedAt": obs.get("timestamp"),
        }
    except Exception as e:
        print(f"  ! current obs failed: {e}")

    # Multi-day forecast periods.
    forecast = get_json(forecast_url)["properties"]["periods"]
    periods = [
        {
            "name": p["name"],
            "isDaytime": p["isDaytime"],
            "tempF": p["temperature"],
            "unit": p["temperatureUnit"],
            "wind": f"{p.get('windSpeed', '')} {p.get('windDirection', '')}".strip(),
            "short": p["shortForecast"],
            "detailed": p["detailedForecast"],
            "icon": p.get("icon"),
            "precip": (p.get("probabilityOfPrecipitation") or {}).get("value"),
        }
        for p in forecast[:10]
    ]

    # Next few hours (for a compact strip).
    hourly = get_json(hourly_url)["properties"]["periods"][:12]
    hours = [
        {
            "time": h["startTime"],
            "tempF": h["temperature"],
            "short": h["shortForecast"],
            "icon": h.get("icon"),
            "precip": (h.get("probabilityOfPrecipitation") or {}).get("value"),
        }
        for h in hourly
    ]

    # If current obs missing a temp, borrow from the first forecast hour.
    if not current.get("tempF") and hours:
        current["tempF"] = hours[0]["tempF"]
        current.setdefault("text", hours[0]["short"])

    return {
        "updated": now_iso(),
        "place": place,
        "coords": {"lat": LAT, "lon": LON},
        "current": current,
        "periods": periods,
        "hours": hours,
    }


def _round(v):
    return None if v is None else round(v)


def _mps_to_mph(v):
    # NWS wind speed comes in km/h despite the SI-looking key on some stations;
    # unit is documented as m/s in wmoUnit:km_h-1 ... normalize defensively.
    return None if v is None else round(v * 0.621371)


def _deg_to_compass(deg):
    if deg is None:
        return None
    dirs = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ]
    return dirs[int((deg / 22.5) + 0.5) % 16]


# ---------------------------------------------------------------------------
# Hazards / active alerts (NWS)
# ---------------------------------------------------------------------------

def fetch_alerts():
    data = get_json(
        f"https://api.weather.gov/alerts/active?point={LAT},{LON}"
    )
    features = data.get("features", [])
    alerts = []
    for f in features:
        p = f["properties"]
        alerts.append(
            {
                "id": p.get("id"),
                "event": p.get("event"),
                "severity": p.get("severity"),
                "urgency": p.get("urgency"),
                "certainty": p.get("certainty"),
                "headline": p.get("headline"),
                "description": p.get("description"),
                "instruction": p.get("instruction"),
                "onset": p.get("onset"),
                "expires": p.get("expires"),
                "sender": p.get("senderName"),
                "geometry": f.get("geometry"),
            }
        )
    return {"updated": now_iso(), "count": len(alerts), "alerts": alerts}


# ---------------------------------------------------------------------------
# Google News RSS helpers
# ---------------------------------------------------------------------------

def google_news_rss(query, limit=15):
    url = (
        "https://news.google.com/rss/search?q="
        + quote(query)
        + "&hl=en-US&gl=US&ceid=US:en"
    )
    r = SESSION.get(
        url,
        timeout=25,
        headers={"User-Agent": "Mozilla/5.0 (RidgewoodCommandCenter)"},
    )
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for item in root.iter("item"):
        title = _text(item, "title")
        link = _text(item, "link")
        pub = _text(item, "pubDate")
        desc = _strip_html(_text(item, "description"))
        source_el = item.find("source")
        source = source_el.text if source_el is not None else None
        # Google News titles are "Headline - Source"; split the source out.
        src_from_title = None
        if title and " - " in title:
            head, _, tail = title.rpartition(" - ")
            if head:
                src_from_title = tail
                title = head
        items.append(
            {
                "title": html.unescape(title or "").strip(),
                "link": link,
                "published": pub,
                "source": source or src_from_title,
                "summary": (desc or "")[:280],
            }
        )
        if len(items) >= limit:
            break
    return items


def _text(el, tag):
    node = el.find(tag)
    return node.text if node is not None else None


def _strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return html.unescape(s).strip()


def fetch_news():
    items = google_news_rss('"Ridgewood Queens" OR "Ridgewood, Queens"', limit=18)
    # Drop obvious NJ Ridgewood noise where possible.
    cleaned = [
        it for it in items
        if "new jersey" not in (it["title"] + it["summary"]).lower()
        and ", nj" not in (it["title"] + it["summary"]).lower()
    ]
    return {"updated": now_iso(), "count": len(cleaned), "items": cleaned}


def fetch_places():
    query = (
        '"Ridgewood Queens" (restaurant OR cafe OR coffee OR bar OR bakery '
        'OR shop OR store OR opening OR opens OR "now open" OR "new spot")'
    )
    items = google_news_rss(query, limit=18)
    keywords = (
        "open", "opens", "opening", "new", "debut", "launch", "arrives",
        "restaurant", "cafe", "coffee", "bar", "bakery", "shop", "store",
    )
    filtered = []
    seen = set()
    for it in items:
        blob = (it["title"] + " " + it["summary"]).lower()
        if "new jersey" in blob or ", nj" in blob:
            continue
        if not any(k in blob for k in keywords):
            continue
        key = it["title"].lower()
        if key in seen:
            continue
        seen.add(key)
        filtered.append(it)
    return {"updated": now_iso(), "count": len(filtered), "items": filtered[:12]}


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

TASKS = [
    ("weather.json", fetch_weather),
    ("alerts.json", fetch_alerts),
    ("news.json", fetch_news),
    ("places.json", fetch_places),
]


def main():
    ok = True
    for name, fn in TASKS:
        print(f"Fetching {name} ...")
        try:
            payload = fn()
            write_json(name, payload)
        except Exception as e:
            ok = False
            print(f"  ! {name} failed: {e}", file=sys.stderr)
            existing = load_existing(name)
            if existing is not None:
                existing["stale"] = True
                existing["lastError"] = str(e)
                existing["lastErrorAt"] = now_iso()
                write_json(name, existing)
                print("  -> preserved previous data (marked stale)")
            else:
                # First run with no prior data: write an empty-but-valid shell.
                write_json(
                    name,
                    {"updated": now_iso(), "stale": True, "lastError": str(e),
                     "items": [], "alerts": [], "count": 0},
                )
        time.sleep(1)  # be gentle between sources

    # A small manifest so the UI can show one "last refreshed" timestamp.
    write_json("status.json", {"updated": now_iso(), "allOk": ok})
    print("Done." if ok else "Done (with some errors).")


if __name__ == "__main__":
    main()
