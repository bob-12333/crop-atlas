# Crop Atlas: Administrator & Developer Guide

This document provides the complete operational and technical reference for administrators and developers maintaining the **Crop Atlas** production system.

---

## 1. System Overview & Production Endpoint

**Crop Atlas** is a spatial agronomic decision-support application combining an interactive 3D globe (`CesiumJS`), multi-source environmental data (**FAO EcoCrop**, **NASA POWER**, **ISRIC SoilGrids**, **IFPRI MapSPAM 2020**, **Photon OSM**, **Wikimedia Commons**), and a shared central database backend (`apps_script/Code.gs`).

### Repository Structure
- `src/` — Full production web application (`src/index.html`, `src/app.js`, `src/db-client.js`) with database autosave, user/admin roles, dashboard, rearrangeable 3-window layout, mobile support, and CSV exports.
- `standalone/` — Zero-backend standalone edition (`standalone/index.html`, `standalone/app.js`, `standalone/README.txt`) that runs purely in the browser without user accounts or an external database.
- `apps_script/` — Backend database service (`apps_script/Code.gs` and `apps_script/SETUP.md`).
- `docs/` — Technical documentation (`docs/admin-developer-guide.md`).

### Embedded Production Backend URL
The production frontend (`src/index.html`) embeds the deployed backend URL from `link.txt`:

```text
https://script.google.com/macros/s/AKfycbyo4qNupyCVOw-txsiprqLS6pCL9EKZBimmzYeWh9HQgbGA97Dg_0T3bHGFxUG9kiWLZg/exec
```

It is declared in `src/index.html` via:
1. `<meta name="crop-atlas-db-url" content="https://script.google.com/macros/s/AKfycbyo4qNupyCVOw-txsiprqLS6pCL9EKZBimmzYeWh9HQgbGA97Dg_0T3bHGFxUG9kiWLZg/exec">`
2. `window.CROP_ATLAS_DB_URL` before loading `src/db-client.js`.

> [!NOTE]
> **Rotating or Updating the Backend URL:** If you deploy a new backend version, update the embedded URL in `src/index.html`. No debug or endpoint-configuration dialogs are exposed to end users in the production HTML.

---

## 2. Database Schema Reference (11 Tables)

The backend manages 11 structured tables automatically initialized by `setupDatabase()` / `ensureSchema_()` in `apps_script/Code.gs`:

| Table Name | Primary Key | Columns | Description |
| :--- | :--- | :--- | :--- |
| **`Users`** | `user_id` | `user_id`, `username`, `display_name`, `role`, `salt`, `password_hash`, `status`, `created_at`, `last_login_at` | User accounts. Passwords are stored exclusively as salted 250-round SHA-256 digests. |
| **`Sessions`** | `token_hash` | `token_hash`, `user_id`, `username`, `display_name`, `role`, `expires_at`, `created_at` | Active 7-day authentication sessions (stores SHA-256 hash of session tokens). |
| **`Crops`** | `id` | `id`, `ecoport_code`, `scientific`, `name`, `icon`, `aliases`, `category`, `family`, `lifespan`, `tmin..tmax`, `rmin..rmax`, `phmin..phmax`, `texture`, `drainage`, `gmin`, `gmax`, `is_starter`, `updated_at` | Master plant reference catalog (8 starters + FAO EcoCrop records + admin overrides). |
| **`ClimateCache`** | `coord_key` | `coord_key` (`lat4,lon4`), `lat`, `lon`, `t2m_json`, `rain_json`, `period_label`, `period_title`, `fetched_by`, `fetched_at` | Shared cache of NASA POWER monthly & annual temperature/rainfall averages. |
| **`SoilCache`** | `coord_key` | `coord_key` (`lat5,lon5`), `lat`, `lon`, `ph`, `sand`, `silt`, `clay`, `usda_texture`, `source`, `fetched_by`, `fetched_at` | Shared cache of ISRIC SoilGrids 0–5 cm estimates and USDA soil texture classification. |
| **`MapSPAMCache`** | `cell_key` | `cell_key` (`x,y`), `lat`, `lon`, `records_json`, `fetched_by`, `fetched_at` | Shared cache of 10 km harvested-area bands decoded from MapSPAM 2020 COG by clients. |
| **`PhotoCache`** | `scientific` | `scientific`, `url`, `pageURL`, `author`, `license`, `licenseURL`, `exact`, `fetched_by`, `fetched_at` | Shared cache of verified Wikimedia Commons crop reference photographs. |
| **`Fields`** | `field_id` | `field_id`, `user_id`, `username`, `name`, `lat`, `lon`, `area_ha`, `lab_ph`, `lab_texture`, `notes`, `created_at`, `updated_at` | User-saved agricultural fields and laboratory soil override measurements. |
| **`PlantingLogs`** | `log_id` | `log_id`, `field_id`, `user_id`, `crop_id`, `crop_name`, `family`, `season_year`, `planting_month`, `water_supply`, `priority`, `notes`, `created_at` | Multi-season crop planting history per field powering rotation warnings. |
| **`UserBookmarks`** | `user_id` | `user_id`, `saved_ids_json`, `recent_ids_json`, `updated_at` | Cloud-synced `Saved` and `Recent` crop lists for authenticated users. |
| **`ApiLogs`** | `log_id` | `log_id`, `timestamp`, `actor_user_id`, `actor_role`, `action`, `source`, `status`, `latency_ms`, `detail` | Operational telemetry and error trace log inspected in the Admin Console. |

---

## 3. Authentication, Password Security & Role Provisioning

### 3.1 Two-Stage Salted SHA-256 Password Pipeline
1. **Client Pre-Hashing (`src/db-client.js`):**
   Before transmitting credentials, the browser hashes `rawPassword + ":" + username.toLowerCase()` via Web Crypto `SHA-256` (with a deterministic pure-JS SHA-256 fallback). Plaintext passwords never leave the browser.
2. **Server Salted Iterated Hashing (`apps_script/Code.gs`):**
   The server generates a unique per-user UUID `salt` and hashes `salt + ":" + clientPreHash` across **250 rounds** of SHA-256 (`Utilities.computeDigest`) before saving `password_hash` and `salt` in `Users`.

### 3.2 User Roles & Permissions
| Role | Access Level | Capabilities |
| :--- | :--- | :--- |
| **`guest`** | Public / Anonymous | Accesses **📊 Dashboard**, **🌍 3D Globe & Inspector**, **🌱 Rotation Planner**, and **📥 CSV Exports**. Reads shared spatial caches, contributes validated spatial cache write-backs, and autosaves bookmarks/fields locally in the browser. |
| **`user`** | Registered Farmer / Researcher | All Guest capabilities **plus** automatic cloud database autosave for **Saved Fields**, **Lab Soil Overrides**, **Planting History Logs**, and **Bookmarks** across devices. |
| **`admin`** | System Administrator / Lead Agronomist | All User capabilities **plus** access to the **🛠️ Admin Console** to sync the master crop catalog, add/override crop bounds, manage user roles/statuses, purge spatial caches, and export administrative CSVs. |
| **`dev`** | Developer / Maintainer | All Admin capabilities **plus** telemetry monitoring (`ApiLogs` latency, cache hit sources, and error diagnostics). |

### 3.3 How to Provision `admin` and `dev` Accounts
Because the production frontend hides debug hints and one-click demo buttons:
1. **Method A — Invite / Bootstrap Code during Registration:**
   - Open **Account → Create Account**, select **`Administrator`** or **`Developer`** under Account Role, and enter the configured `ADMIN_BOOTSTRAP_CODE` in the **Admin / Developer Invite Code** field.
   - Set or rotate `ADMIN_BOOTSTRAP_CODE` in **Project Settings → Script Properties** on the backend (defaults to `CROP-ATLAS-ADMIN-2026` if unset).
2. **Method B — Promote an Existing User from the Admin Console:**
   - Sign in with an existing `admin` account, open **🛠️ Admin → User Accounts & Role Access Control**, change the user's role dropdown to `admin` or `dev`, and click **Save**.
3. **Method C — Initial Database Seed (`setupDatabase`):**
   - Running `setupDatabase()` on the backend seeds three initial accounts (`admin` / `admin123`, `dev` / `dev123`, `farmer` / `farmer123`). Rotate or disable default accounts in the Admin Console after onboarding production administrators.

---

## 4. Administrator Guide (Using the Admin Console)

When signed in with an `admin` or `dev` account, the **🛠️ Admin** button appears in the top navigation bar:

1. **Database Table Overview:**
   - Displays real-time record counts across all 11 database tables (`Users`, `Sessions`, `Crops`, `ClimateCache`, `SoilCache`, `MapSPAMCache`, `PhotoCache`, `Fields`, `PlantingLogs`, `UserBookmarks`, `ApiLogs`).
2. **Catalog & Crop Bounds Manager:**
   - Click **☁️ Sync Master Crop Database** to instruct the backend to download and parse the latest FAO EcoCrop database and update the `Crops` table.
   - Use the **Save Crop to Database** form to insert custom local crops or adjust temperature, rainfall, and soil pH tolerance bounds (`min_tol`, `min_pref`, `max_pref`, `max_tol`).
3. **Shared Spatial Cache Maintenance:**
   - Inspect cached coordinate and grid cell keys across `ClimateCache`, `SoilCache`, `MapSPAMCache`, and `PhotoCache`.
   - Click **Purge** on any cache domain if upstream dataset versions change or if you need to force fresh lookups.
4. **User Account & Security Management:**
   - Review all registered accounts, verify their `salt` and `password_hash` digest prefixes, promote/demote roles (`user`, `admin`, `dev`), or set an account status to `disabled` to revoke login access immediately.
   - Click **⬇ Users (.csv)** or **⬇ Logs (.csv)** for auditing.

---

## 5. Developer Guide (Architecture, Autosave, Error Handling & Layout)

### 5.1 Hybrid Server/Client Data Fetching
To maximize speed and stay within backend execution quotas:
- **Server-First Lookups (`getCatalog`, `getClimate`, `getSoil`, `getPhoto`):** The client requests data from the backend first. On a cache hit, the database returns the stored record immediately. On a cache miss, the backend fetches from the upstream provider when possible, stores the record in the database, and returns it.
- **Client Fetch + Database Write-Back (`saveMapSPAM`, `saveClimate`, `saveSoil`, `savePhoto`, `saveCatalogBatch`):**
  - Binary Cloud-Optimized GeoTIFF (`MapSPAM 2020`) byte-range reading requires `GeoTIFF.js` in the browser. On a `getMapSPAM` cache miss, the client decodes the 10 km cell from S3 and automatically POSTs the parsed crop area bands back to `saveMapSPAM` so subsequent users receive an instant database cache hit.
  - If the backend cannot reach an upstream API directly, the client seamlessly fetches from the upstream endpoint and writes the normalized record back to the database.

### 5.2 Real-Time Autosave Engine & Offline Queue
- **Debounced Triggers (`src/app.js`):**
  - Editing any field input (`#fieldNameInput`, `#fieldAreaInput`, `#fieldLabPhInput`, `#fieldLabTextureSelect`) triggers a `900 ms` debounced autosave (`scheduleFieldAutosave()`).
  - Starring/unstarring a crop or inspecting a crop triggers a `650 ms` debounced bookmark autosave.
  - Adding/removing planting history logs or loading new spatial data triggers background database persistence.
- **Visual Status States (`src/db-client.js`):**
  - `saving`: Displays **`⟳ Saving…`** in `#autosaveStatusPill`.
  - `saved`: Displays **`✓ Saved`** (with the last-saved timestamp in the hover tooltip so the badge stays compact and never overlaps navigation items).
  - `offline` / `error`: Queues the mutation in `localStorage` (`cropAtlasPendingSaves_v2`), displays **`⚠ Saved locally`**, and automatically flushes the queue when `window` fires the `online` event or when the user clicks the status pill.

### 5.3 User Error Notification System
Use the global helper functions in `src/app.js` whenever adding new network or user actions:
- `showUserError(title, message, retryCallback)`: Renders an accessible alert banner in `#userNotificationRegion` with a plain-language explanation, optional **Retry** button, and **Dismiss (`✕`)** button.
- `showUserNotice(message, type)`: Renders a transient confirmation or status toast (`type`: `"info"` | `"success"` | `"warning"`).

### 5.4 CSV Export Engine
All CSV exports use `CropAtlasDB.downloadCSV(filename, headers, rows)` in `src/db-client.js`, which prepends a UTF-8 Byte-Order Mark (`\uFEFF`) and escapes double quotes, commas, and multiline strings per RFC 4180 so files open without encoding corruption in Excel and desktop GIS/statistical software.

### 5.5 Responsive Layout, Rearrangeable 3-Window Workspace & Mobile Architecture
- **Full-Viewport Flexbox Shell (`src/index.html`):**
  - `body` uses `display: flex; flex-direction: column; height: 100dvh;` with a 3-column CSS Grid top bar (`.header-brand`, `.header-nav`, `.header-meta`) so the right-side status pills and left/center navigation tools never overlap.
- **Rearrangeable 3 Windows (Desktop & Tablet `> 860px`):**
  - The three explorer windows (`library`, `map`, `inspector`) each include a `.pane-header` bar supporting **HTML5 Drag-and-Drop** (`⋮⋮`), **1-click left/right arrow controls (`◀` / `▶`)** for touch tablets and keyboard users, and a **Reset Layout (`↺`)** button.
  - `applyPaneOrder()` in `src/app.js` dynamically recalculates `grid-template-columns` so whichever column holds the 3D Globe (`map`) receives `minmax(0, 1fr)`, updates pane borders cleanly, persists the user's preferred order in `localStorage` (`cropAtlasPaneOrder`), and triggers `viewer.resize()`.
- **Comprehensive Mobile Support (`<= 860px`):**
  - Replaces the desktop 3-column grid with a full-screen single-pane view controlled by a **sticky bottom navigation bar** (`#mobileBottomNav`: **Crops**, **Globe**, **Inspect**, **Home**) with safe-area-inset support.
  - Collapses secondary header navigation into a touch-friendly **mobile drawer menu** (`#mobileMenuBtn` / `#mobileNavDrawer`).
  - Displays a floating **`📍 Inspect <location> ➔`** action pill (`#mobileInspectJumpBtn`) on the 3D Globe after selecting a coordinate so mobile users can jump straight to climate and soil results in one tap.
