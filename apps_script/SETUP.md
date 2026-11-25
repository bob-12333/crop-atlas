# Google Apps Script + Google Sheets Database Setup Guide

This directory contains the complete backend (`Code.gs`) that turns a **Google Spreadsheet** into a shared relational database and server-side API fetcher for **Crop Atlas**.

---

## 1. Create the Google Spreadsheet
1. Open [Google Sheets](https://sheets.google.com) and create a new blank spreadsheet named **`Crop Atlas Database`**.
2. Copy the **Spreadsheet ID** from its URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
   *(Tip: If you create the Apps Script directly from the spreadsheet via **Extensions → Apps Script**, `SpreadsheetApp.getActiveSpreadsheet()` works automatically even without setting `SPREADSHEET_ID`!)*

---

## 2. Add `Code.gs` to Google Apps Script
1. In your Google Sheet, click **Extensions → Apps Script**.
2. Replace the default `Code.gs` content with the full contents of `apps_script/Code.gs`.
3. *(Optional)* In Apps Script, open **Project Settings (⚙️) → Script Properties** and add:
   - `SPREADSHEET_ID`: your Google Sheet ID (only required if running as a standalone script not bound to the sheet).
   - `ADMIN_BOOTSTRAP_CODE`: secret code to allow registering an `admin` or `dev` account from the web UI (defaults to `CROP-ATLAS-ADMIN-2026` if not set).
4. In the Apps Script editor toolbar, select the function **`setupDatabase`** and click **Run**.
   - Grant the requested permissions (`Spreadsheets`, `UrlFetchApp`, `LockService`).
   - This automatically creates all **11 database tabs** (`Users`, `Sessions`, `Crops`, `ClimateCache`, `SoilCache`, `MapSPAMCache`, `PhotoCache`, `Fields`, `PlantingLogs`, `UserBookmarks`, `ApiLogs`) with formatted headers and seeds default `admin`, `dev`, and `user` demo accounts (all with salted SHA-256 password hashes).

---

## 3. Deploy as a Web App
1. In the top-right of the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to **Select type** and choose **Web app**.
3. Set:
   - **Description:** `Crop Atlas Database API v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` *(Required so the browser client can send CORS-safe `GET` and `POST text/plain` requests without OAuth popups).*
4. Click **Deploy** and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).

---

## 4. Connect to Crop Atlas (`/src`)
1. Open Crop Atlas (`http://localhost:8000` when serving `/src`).
2. Click **⚙️ DB Config** in the top header.
3. Paste your **Apps Script Web App URL** and click **Test & Save Connection**.
   - When no Web App URL is entered (or when testing offline), Crop Atlas automatically runs in **Local Shared-DB Simulator Mode** (using the exact same 11-table schema, salted SHA-256 auth, and hybrid write-back pipeline inside browser storage) so every feature works immediately out of the box.

### Default Demo Accounts (Seeded Automatically)
| Username | Default Password | Role | Interface Unlocked |
| :--- | :--- | :--- | :--- |
| `admin` | `admin123` | `admin` | **Explorer** + **Admin / Dev Console** (Catalog sync, User management, Cache purge) |
| `dev` | `dev123` | `dev` | **Explorer** + **Admin / Dev Console** (Live `ApiLogs`, Latency telemetry, Raw API tester) |
| `farmer` | `farmer123` | `user` | **Explorer** with cloud-synced **Saved Fields**, **Lab Soil Overrides**, and **Planting Logs** |
| *(Guest Mode)* | *(No password)* | `guest` | **Explorer** reading shared Google Sheet caches & contributing spatial write-backs |
