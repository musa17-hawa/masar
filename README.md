# Masar

**From LiDAR sensor to a product.** Masar (مسار, Arabic for *trail*) turns a LiDAR point cloud and an aerial image into a 3D hiking trail you can orbit and walk through in the browser, then writes a report on it: distance, climb, walking time, difficulty, steps, obstacles, stream crossings, water and shade.

It is a course project by a team of three. The interface is in English, Hebrew and Arabic.

```
npm start        →  http://localhost:3000
```

No build step and no required dependencies: the server is plain Node, and the 3D engine is hand-written WebGL 2.

---

## Contents

1. [Quick start](#quick-start)
2. [What is in the app](#what-is-in-the-app)
3. [Getting data](#getting-data)
4. [Scanning a trail with an iPhone](#scanning-a-trail-with-an-iphone)
5. [How a trail is built](#how-a-trail-is-built)
6. [How the report is calculated](#how-the-report-is-calculated)
7. [Configuration](#configuration)
8. [Hosting behind a Cloudflare Tunnel](#hosting-behind-a-cloudflare-tunnel)
9. [Accounts and security](#accounts-and-security)
10. [Project layout](#project-layout)
11. [Known limits](#known-limits)
12. [Data credits](#data-credits)

---

## Quick start

You need **Node.js 20 or newer**.

```bash
npm install      # optional: only adds LAZ support (the laz-perf package)
npm start
```

Open <http://localhost:3000>. The landing page is public. Press **Open the studio**; on first run Masar asks you to create the admin account.

Then, to see it working without any data of your own, open **Trails** and build one of the two samples:

- **Sample: alpine switchbacks** is a synthetic airborne survey in Swiss LV95 coordinates with a GPS track.
- **Sample: forest steps** is a synthetic phone scan with stone steps, a rock and a low branch.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with auto-restart when server files change |
| `npm test` | Self-test: starts a throwaway server, builds a sample, checks the report |
| `npm run sample` | Write the sample files to `./samples` so you can practise the upload flow by hand |
| `npm run add-user -- you@example.com "password" "Name" [admin]` | Add an account from the command line (stop the server first) |

---

## What is in the app

| Page | Address | Purpose |
| --- | --- | --- |
| Landing | `/` | Scroll-driven story: the same 3D scene goes from raw points to sorted, coloured, traced and walked. Public. |
| Sign in / setup | `/login`, `/setup` | Accounts. Everything below needs a session. |
| Trails | `/trails` | Library of built trails with live build progress. |
| New trail | `/new` | Four-step wizard: source, files, details, build. |
| Phone capture | `/capture` | Guided field workflow for a LiDAR iPhone: GPS track and photos in the browser, coaching for the scan, then build. |
| Viewer | `/trail/<id>` | Orbit the model or walk the trail at eye level. Colour by photo, elevation, type or slope. Draw or adopt a trail line. Attach imagery. |
| Report | `/trail/<id>/report` | The trail report. Prints cleanly to PDF. |
| Team | `/team` | Admins add and remove people; everyone can change their password. |

---

## Getting data

One point cloud is enough. Everything else is optional and makes the result richer.

| You bring | Formats | Notes |
| --- | --- | --- |
| Point cloud (required) | LAS 1.0–1.4, LAZ, PLY (ASCII or binary), XYZ / TXT / CSV / PTS, or a `.zip` of any of these | Several tiles can be uploaded together |
| Aerial image | GeoTIFF, or JPG / PNG with a world file of the same name (`.jgw`, `.pgw`, `.tfw`, `.wld`) | Can also be fetched automatically, see below |
| GPS track | GPX, KML, GeoJSON | Without one you draw the line on the model, or adopt a path mapped in OpenStreetMap |
| Photos | JPG, PNG (HEIC uploads too, but only Safari displays it) | Pinned along the trail by their GPS position |

### Swiss data (swisstopo)

1. On swisstopo.admin.ch open the **swissSURFACE3D** product page and select the 1 km tiles that cover your trail.
2. Download them as zipped LAS and drop the `.zip` files into the wizard as they are.
3. Optional: download **SWISSIMAGE 10 cm** for the same tiles as GeoTIFF. Or leave *Fetch an aerial image* ticked and Masar requests the image from the swisstopo WMS for exactly the area it built.
4. Export the route as GPX from any hiking app (Mapeak, Komoot, SwitzerlandMobility and so on).

Swiss coordinates (LV95, EPSG:2056, and the older LV03, EPSG:21781) are detected automatically. Israel TM (EPSG:2039) and UTM zones are supported too.

With a GPS track, Masar keeps a corridor around the track (60 m each side by default) and discards the rest of the tile, so a 1 km² tile with tens of millions of points still gives a model that runs smoothly.

### Online lookups

When the server has internet access and the trail has map coordinates, Masar asks:

- **OpenStreetMap** (Overpass API) for springs, drinking water, huts, viewpoints, streams and mapped footpaths near the trail.
- **swisstopo WMS** (Swiss coordinates) or **Esri World Imagery** (elsewhere) for an aerial image, if you did not upload one.

Set `ALLOW_NETWORK=0` to switch both off. Nothing fails without them; the report says what was not checked.

---

## Scanning a trail with an iPhone

**Why not a pure web capture?** Browsers on iOS (Safari, and Chrome, which uses the same engine) cannot read the LiDAR sensor. So the scan itself is made in a scanner app, and Masar handles everything around it.

Open **Phone capture** on the phone. It walks you through four steps:

1. **Prepare.** Checklist, and a check of what this phone and browser can do.
2. **Track and photos.** Masar records a GPS track and geotagged photos. The screen stays on, and the page tells you when the GPS is weak or you are moving too fast. The session is saved on the phone, so it survives a reload.
3. **Scan.** Illustrated coaching for the scanner app: tilt, pace, sweep, what to do at steps, and how to export.
4. **Build.** Pick the exported scan file; Masar uploads it with the track and photos and builds the trail.

Practical points:

- **Location needs HTTPS.** The capture page only records GPS when Masar is opened through an `https://` address (your Cloudflare Tunnel domain) or `localhost`. A plain `http://192.168.x.x` address will not work on the phone.
- **GPS recording pauses while another app is in front.** With one phone, record the track and photos on the way out and scan on the way back. With two phones, one scans while the other keeps the capture page open.
- **Scanner apps.** Any app that exports a point cloud as PLY or LAS works, for example Scaniverse, Polycam or 3d Scanner App. Export options differ by app and version, and some need a paid plan, so do a test export before the trip.
- **Keep one scan to roughly 100 m of trail.** Longer scans drift. For a longer trail, scan in sections and build each as its own trail.
- A phone scan has no map coordinates. Heights in its report are relative to the lowest scanned point, and the GPS track gives the scan its position on the map.

### Would a native app be better?

A native iOS app (Swift + ARKit) could read LiDAR depth directly and fuse it with GPS in one pass. It needs a Mac with Xcode and an Apple developer account to install on a phone, and it would only replace steps 2 and 3 above; the processing, viewer and report stay the same. The web workflow was chosen because it runs today on any phone without installing anything from the team. A companion app that posts scans to the existing upload API (`POST /api/trails`, `POST /api/trails/<id>/files`, `PUT` chunks, `POST /process`) is the natural next step.

---

## How a trail is built

Uploads go to the server in 16 MB chunks (resumable). A build then runs in a worker thread, one at a time:

1. **Read.** Stream the point cloud; detect the coordinate system from the file header or the coordinate range. Phone scans get their up-axis detected.
2. **Crop and thin.** Keep the corridor around the GPS track (or the area you gave), then thin to one point per voxel so the model stays within `POINT_BUDGET`.
3. **Find the ground.** Use the survey's own classification when it has one; otherwise a lowest-point grid filter separates ground from vegetation and objects.
4. **Terrain.** Build a height grid (DEM) from ground points and fill small holes. Build a canopy grid from everything above it.
5. **Trail line.** Project the GPS track onto the terrain. For a phone scan with no track, find the path along the scan's long axis. No line at all is fine: draw it later in the viewer.
6. **Context.** Fetch OpenStreetMap features for the area (optional).
7. **Measure.** Walk the line across the terrain and the points beside it; write `report.json`.
8. **Pack.** Write quantised points, the DEM and metadata as compact binary files for the viewer.

The aerial image is draped afterwards: your GeoTIFF is decoded and cut to the model's footprint in the browser, or the server fetches one. In the viewer each point takes the colour of the pixel above it.

Results live in `data/trails/<id>/`. Delete a trail in the app to remove its folder.

---

## How the report is calculated

| Figure | Method |
| --- | --- |
| Distance, climb, descent | From the trail line on the terrain grid, smoothed so that sensor noise does not add false climb |
| Walking time | DIN 33466 hiking formula: 4 km/h horizontally, 300 m/h up, 500 m/h down; the larger of the horizontal and vertical time plus half the smaller. No breaks. |
| Grade | Share of the trail in five grade classes, plus the 90th-percentile and maximum grade |
| Steps and stairs | Sudden height changes along the tread (phone scans only); steps of 35 cm or more are flagged as high steps |
| Obstacles, overhangs, narrow passages | Non-ground points standing on or hanging over the tread, and the clear width between objects (phone scans only) |
| Stream crossings | Streams mapped in OpenStreetMap that cross the line; otherwise channels in the terrain, marked as inferred |
| Water sources | Springs, taps, wells and fountains from OpenStreetMap near the trail |
| Shade | Share of the trail with canopy points above it |
| Exposure | Share of the trail with a steep fall close to one side |
| Difficulty | A 0–100 score from steepness (30%), footing (25%), exposure (15%) and effort (30%), where effort is kilometres plus one per 100 m of climb. Mapped to five levels, with an approximate SAC grade. |

The difficulty rating is Masar's own estimate, not an official classification. Surveys age, and a model cannot see ice, mud or a fallen tree from last week. The report is for planning; it does not replace judgement on the trail.

An airborne survey (roughly half-metre detail) shows the shape of the route. Only a phone scan (centimetre detail) can resolve single steps, stones and path width, and the report says so when that detail is missing.

---

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Uploads, built trails and the account database |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | – | Create the first admin on first start instead of using `/setup` |
| `POINT_BUDGET` | `1500000` | Points kept per trail. Lower it on a small machine or for phones. |
| `DEM_MAX_CELLS` | `1536` | Longest side of the terrain grid, in cells |
| `WORKER_MEMORY_MB` | `3072` | Memory limit for a build |
| `MAX_UPLOAD_GB` | `6` | Upload limit per trail |
| `ALLOW_NETWORK` | `1` | Set to `0` to stop calls to OpenStreetMap and imagery services |

---

## Hosting behind a Cloudflare Tunnel

Masar is ready for this: session cookies become `Secure` when the request arrives over HTTPS, the client IP is read from Cloudflare's header for sign-in rate limiting, and uploads are chunked below Cloudflare's 100 MB request limit.

### With Docker Compose

```bash
cp .env.example .env        # set ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
docker compose up -d --build
```

The app listens on port 3000 and keeps its data in `./data`.

1. In the Cloudflare Zero Trust dashboard, create a tunnel (or open your existing one) and add a **public hostname**, for example `masar.yourdomain.com`.
2. Set its service to `http://<homelab-ip>:3000` if `cloudflared` already runs on the host, or to `http://masar:3000` if you run `cloudflared` inside this compose file (uncomment the `cloudflared` service and put the tunnel token in `.env` as `TUNNEL_TOKEN`).
3. Open `https://masar.yourdomain.com`. Sign in with the admin account, then add your teammates under **Team**.

### Without Docker

```bash
npm install
npm start          # or run it under systemd / pm2
```

Point the tunnel's public hostname at `http://localhost:3000`.

### Before you publish

- Set a strong `ADMIN_PASSWORD`. The landing page is public; the studio, the API and every trail file need a session.
- For a second lock in front of the login, add a Cloudflare Access policy to the hostname.
- Back up the `data` folder. It holds the accounts (`db.json`) and all trails.
- Esri World Imagery is used as the fallback image source outside Switzerland. Check Esri's terms before making trails built with it public, or upload your own imagery.
- The pages load the IBM Plex typefaces from Google Fonts. Without that connection they fall back to system fonts.

---

## Accounts and security

- Passwords are hashed with scrypt. Sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie.
- Sign-in is rate limited per address.
- State-changing requests from another origin are refused.
- Roles: an **admin** can add and remove people; a **member** can build, view and delete trails.
- There is no email. An admin sets a temporary password and tells the person; they change it under **Team**.

---

## Project layout

```
server/
  index.js            HTTP server, routes, static files
  auth.js  db.js      accounts, sessions, JSON database
  jobs.js             build queue (one worker thread at a time)
  sample.js           generators for the two synthetic samples
  geo/proj.js         coordinate transforms (LV95, LV03, ITM, UTM ↔ WGS 84)
  pipeline/
    readers.js        LAS / LAZ / PLY / XYZ / ZIP readers
    worker.js         the build: crop, thin, ground, terrain, pack
    grid.js           terrain and canopy grids
    analyze.js        the trail report
    track.js          GPX / KML / GeoJSON
    osm.js            OpenStreetMap lookups
    imagery.js        aerial image requests
    exif.js           GPS from photo EXIF
public/
  index.html          landing page
  app/*.html          app pages (thin shells)
  js/gl/              WebGL 2 engine and camera controls
  js/pages/           one module per page
  js/i18n/            en, he, ar
  js/imagery.js       GeoTIFF decoding and image fitting in the browser
  css/                design system and page styles
  demo/               the scene animated on the landing page
scripts/              add-user, make-sample, build-demo, selftest
```

---

## Known limits

- **LAZ** needs `npm install` (the optional `laz-perf` package) and loads the whole file into memory; files above about 1.6 GB must be converted to LAS or cropped first.
- **One scan per phone trail.** Separate phone scans do not share a coordinate frame and are not merged.
- **Phone scans are not georeferenced.** They get a map position from the GPS track but are not rotated or scaled to fit the map.
- Build error messages from the server are in English only.
- Point classification without survey classes is geometric (ground, vegetation, object). It does not recognise materials.
- Tested with the two synthetic samples, in desktop and mobile browser layouts and in all three languages. It has not yet been run against real swisstopo tiles, a real scanner-app export, or the live OpenStreetMap and imagery services, so expect to tune `POINT_BUDGET` and corridor width on the first real trail.

---

## Data credits

- swissSURFACE3D and SWISSIMAGE © swisstopo, free to use with attribution.
- Map features © OpenStreetMap contributors (ODbL).
- Fallback imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics), subject to Esri's terms.
- Typeface: IBM Plex Sans (SIL Open Font License).
