# Crop Atlas

**Crop Atlas** is an interactive 3D spatial agronomic decision-support web application for exploring historical climate, surface soil estimates, and nearby cultivation patterns to screen crop suitability and plan multi-season crop rotations.

---

## Repository Structure

```text
.
├── src/                        # Production Web App (Database-Connected Edition)
│   ├── index.html              # Responsive UI (Dashboard, 3D Globe, Inspector, Admin Console)
│   ├── app.js                  # Application logic, autosave, CSV export & rearrangeable layout
│   └── db-client.js            # Database SDK, salted SHA-256 auth & offline sync queue
├── standalone/                 # Standalone Zero-Backend Edition (No Users / No Database)
│   ├── index.html              # Pure client-side 3-pane interface (Rearrangeable + Mobile UI)
│   ├── app.js                  # Direct browser queries to EcoCrop, NASA POWER, SoilGrids & MapSPAM
│   └── README.txt              # Quick-start instructions for the standalone edition
├── apps_script/                # Central Database Backend (Google Apps Script + Google Sheets)
│   ├── Code.gs                 # 11-table database router, hybrid server fetcher & salted SHA-256 auth
│   └── SETUP.md                # Backend deployment and configuration guide
├── docs/                       # Documentation
│   └── admin-developer-guide.md # Complete Administrator & Developer Reference
└── README.md
```

---

## Getting Started

### Option 1: Run the Full Production App (`src/`)
Includes the **Overview Dashboard**, **Real-Time Database Autosave**, **Saved Fields & Lab Soil Overrides**, **Planting History Logs**, **CSV Exports**, **User / Guest Mode**, and **Admin Console**.

```bash
cd src
python3 -m http.server 8000
```
Open **`http://localhost:8000`** in your browser.

### Option 2: Run the Standalone Edition (`standalone/`)
Runs 100% in the browser with **no user accounts, no login system, and no external database**. Bookmarks (`Saved` and `Recent` crops) are stored locally in browser `localStorage`, while still supporting the rearrangeable 3-window desktop/tablet layout and mobile bottom navigation bar.

```bash
cd standalone
python3 -m http.server 8000
```
Open **`http://localhost:8000`** in your browser.

---

## Key Features

- **Interactive 3D Earth Globe (`CesiumJS`) & Location Search (`Photon OSM`):** Click any coordinate on Earth or search by town/address with optional 3D terrain elevation.
- **FAO EcoCrop Catalog (~2,000+ Plant Records):** Instant startup with 8 embedded starter crops (Rice, Maize, Wheat, Potato, Soybean, Arabica Coffee, Cassava, Sunflower) upgraded seamlessly by the FAO EcoCrop reference catalog.
- **Multi-Source Spatial Screening:**
  - **Climate (`NASA POWER`):** Monthly and annual temperature (`T2M`, °C) and precipitation (`PRECTOTCORR`, mm).
  - **Surface Soil (`ISRIC SoilGrids` 0–5 cm):** Mapped estimates for soil pH in water, sand %, silt %, clay %, and computed **USDA Soil Texture Class**.
  - **Nearby Historical Cultivation (`IFPRI MapSPAM 2020`):** Partial HTTP byte-range reads of 10 km global Cloud-Optimized GeoTIFF harvested-area bands via `GeoTIFF.js`.
- **Next-Crop Rotation Planner:** Screens candidate crops against site temperature, annual rainfall, and soil pH while flagging same-family monoculture rotation cautions.
- **Rearrangeable 3-Window Desktop/Tablet Layout & Mobile UI:**
  - Drag-and-drop (`⋮⋮`) or use arrow controls (`◀` / `▶`) to reorder the **Crop Library**, **3D Globe**, and **Site & Crop Inspector** windows on computer and tablet screens.
  - Dedicated mobile bottom tab bar (**Crops**, **Globe**, **Inspect**) and touch-friendly controls on smartphones (`<= 860px`).

---

## Documentation

- **Administrator & Developer Guide:** See [`docs/admin-developer-guide.md`](docs/admin-developer-guide.md) for the database schema, salted SHA-256 authentication architecture, role provisioning, autosave lifecycle, and CSV export specifications.
- **Backend Setup Guide:** See [`apps_script/SETUP.md`](apps_script/SETUP.md) for deploying or updating `apps_script/Code.gs`.
