/**
 * Crop Atlas — Google Apps Script + Google Sheets Shared Database & Hybrid Fetcher
 *
 * Implements:
 * 1. 11-sheet relational schema in Google Sheets (Users, Sessions, Crops, ClimateCache,
 *    SoilCache, MapSPAMCache, PhotoCache, Fields, PlantingLogs, UserBookmarks, ApiLogs).
 * 2. Salted multi-round SHA-256 password hashing (never stores plaintext passwords) + Guest Mode.
 * 3. Server-side UrlFetchApp fetching & caching when possible (EcoCrop CSV, NASA POWER,
 *    ISRIC SoilGrids WMS, Wikimedia Commons, Photon OSM).
 * 4. Client write-back endpoints (saveMapSPAM for binary S3 COG reads, plus saveClimate,
 *    saveSoil, savePhoto, saveCatalogBatch fallbacks) so client-fetched data is stored in
 *    Google Sheets for all other users.
 * 5. Role-based access control (guest, user, admin, dev) with Admin & Dev management APIs.
 */

const SCHEMA = {
  Users: [
    "user_id", "username", "display_name", "role",
    "salt", "password_hash", "status", "created_at", "last_login_at"
  ],
  Sessions: [
    "token_hash", "user_id", "username", "display_name", "role", "expires_at", "created_at"
  ],
  Crops: [
    "id", "ecoport_code", "scientific", "name", "icon", "aliases",
    "category", "family", "lifespan",
    "tmin", "toptmin", "toptmax", "tmax",
    "rmin", "roptmin", "roptmax", "rmax",
    "phmin", "phoptmin", "phoptmax", "phmax",
    "texture", "drainage", "gmin", "gmax", "is_starter", "updated_at"
  ],
  ClimateCache: [
    "coord_key", "lat", "lon", "t2m_json", "rain_json",
    "period_label", "period_title", "fetched_by", "fetched_at"
  ],
  SoilCache: [
    "coord_key", "lat", "lon", "ph", "sand", "silt", "clay",
    "usda_texture", "source", "fetched_by", "fetched_at"
  ],
  MapSPAMCache: [
    "cell_key", "lat", "lon", "records_json", "fetched_by", "fetched_at"
  ],
  PhotoCache: [
    "scientific", "url", "pageURL", "author", "license", "licenseURL", "exact", "fetched_by", "fetched_at"
  ],
  Fields: [
    "field_id", "user_id", "username", "name", "lat", "lon",
    "area_ha", "lab_ph", "lab_texture", "notes", "created_at", "updated_at"
  ],
  PlantingLogs: [
    "log_id", "field_id", "user_id", "crop_id", "crop_name", "family",
    "season_year", "planting_month", "water_supply", "priority", "notes", "created_at"
  ],
  UserBookmarks: [
    "user_id", "saved_ids_json", "recent_ids_json", "updated_at"
  ],
  ApiLogs: [
    "log_id", "timestamp", "actor_user_id", "actor_role", "action",
    "source", "status", "latency_ms", "detail"
  ]
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ECOCROP_CSV_URL = "https://raw.githubusercontent.com/OpenCLIM/ecocrop/main/EcoCrop_DB.csv";
const HASH_ROUNDS = 250;

const STARTER_CROPS = [
  {
    id: "rice", name: "Rice", scientific: "Oryza sativa", icon: "🌾",
    aliases: "paddy rice, asian rice", category: "Cereals", family: "Poaceae", lifespan: "Annual",
    tmin: 10, toptmin: 20, toptmax: 30, tmax: 36,
    rmin: 800, roptmin: 1200, roptmax: 2200, rmax: 3500,
    phmin: 4.5, phoptmin: 5.5, phoptmax: 7.0, phmax: 8.0,
    texture: "medium, heavy", drainage: "poor, medium", gmin: 90, gmax: 180, is_starter: true
  },
  {
    id: "maize", name: "Maize (Corn)", scientific: "Zea mays", icon: "🌽",
    aliases: "corn, sweet corn", category: "Cereals", family: "Poaceae", lifespan: "Annual",
    tmin: 10, toptmin: 18, toptmax: 32, tmax: 40,
    rmin: 400, roptmin: 600, roptmax: 1200, rmax: 2500,
    phmin: 5.0, phoptmin: 5.5, phoptmax: 7.5, phmax: 8.2,
    texture: "medium, light", drainage: "well", gmin: 70, gmax: 160, is_starter: true
  },
  {
    id: "wheat", name: "Wheat", scientific: "Triticum aestivum", icon: "🥖",
    aliases: "bread wheat, common wheat", category: "Cereals", family: "Poaceae", lifespan: "Annual",
    tmin: 3, toptmin: 15, toptmax: 24, tmax: 32,
    rmin: 300, roptmin: 450, roptmax: 900, rmax: 1600,
    phmin: 5.5, phoptmin: 6.0, phoptmax: 7.5, phmax: 8.5,
    texture: "medium, heavy", drainage: "well", gmin: 90, gmax: 210, is_starter: true
  },
  {
    id: "potato", name: "Potato", scientific: "Solanum tuberosum", icon: "🥔",
    aliases: "irish potato, white potato", category: "Roots/Tubers", family: "Solanaceae", lifespan: "Annual",
    tmin: 7, toptmin: 15, toptmax: 21, tmax: 28,
    rmin: 400, roptmin: 500, roptmax: 900, rmax: 1800,
    phmin: 4.8, phoptmin: 5.2, phoptmax: 6.5, phmax: 7.5,
    texture: "light, medium", drainage: "well", gmin: 90, gmax: 140, is_starter: true
  },
  {
    id: "soybean", name: "Soybean", scientific: "Glycine max", icon: "🫘",
    aliases: "soya bean, edamame", category: "Pulses", family: "Fabaceae", lifespan: "Annual",
    tmin: 10, toptmin: 20, toptmax: 30, tmax: 38,
    rmin: 450, roptmin: 600, roptmax: 1500, rmax: 2500,
    phmin: 5.0, phoptmin: 6.0, phoptmax: 7.0, phmax: 7.8,
    texture: "medium", drainage: "well", gmin: 80, gmax: 140, is_starter: true
  },
  {
    id: "coffee", name: "Arabica Coffee", scientific: "Coffea arabica", icon: "☕",
    aliases: "coffee, highland coffee", category: "Beverages", family: "Rubiaceae", lifespan: "Perennial",
    tmin: 12, toptmin: 18, toptmax: 24, tmax: 30,
    rmin: 1000, roptmin: 1400, roptmax: 2200, rmax: 3000,
    phmin: 4.5, phoptmin: 5.2, phoptmax: 6.5, phmax: 7.0,
    texture: "medium", drainage: "well", gmin: 210, gmax: 300, is_starter: true
  },
  {
    id: "cassava", name: "Cassava", scientific: "Manihot esculenta", icon: "🌿",
    aliases: "manioc, tapioca, yuca", category: "Roots/Tubers", family: "Euphorbiaceae", lifespan: "Perennial",
    tmin: 16, toptmin: 24, toptmax: 31, tmax: 38,
    rmin: 500, roptmin: 1000, roptmax: 1800, rmax: 4000,
    phmin: 4.2, phoptmin: 5.5, phoptmax: 6.8, phmax: 8.0,
    texture: "light, medium", drainage: "well", gmin: 240, gmax: 365, is_starter: true
  },
  {
    id: "sunflower", name: "Sunflower", scientific: "Helianthus annuus", icon: "🌻",
    aliases: "common sunflower, oilseed sunflower", category: "Cereals", family: "Asteraceae", lifespan: "Annual",
    tmin: 8, toptmin: 18, toptmax: 28, tmax: 36,
    rmin: 300, roptmin: 500, roptmax: 1000, rmax: 1600,
    phmin: 5.5, phoptmin: 6.0, phoptmax: 7.5, phmax: 8.2,
    texture: "medium, light", drainage: "well", gmin: 80, gmax: 130, is_starter: true
  }
];

/**
 * Run this once from the Apps Script editor (or automatically on first request)
 * to initialize all 11 tabs and seed demo accounts.
 */
function setupDatabase() {
  const ss = getSpreadsheet_();
  ensureSchema_(ss);
  seedDefaultData_(ss);
  return { ok: true, spreadsheetName: ss.getName() };
}

function doGet(e) {
  return handleRequest_("GET", e);
}

function doPost(e) {
  return handleRequest_("POST", e);
}

function handleRequest_(method, e) {
  const startMs = Date.now();
  let params = Object.assign({}, (e && e.parameter) || {});
  if (method === "POST" && e && e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      if (body && typeof body === "object") {
        params = Object.assign(params, body);
      }
    } catch (err) {
      return jsonResponse_({ ok: false, error: "Invalid JSON body: " + err.message });
    }
  }

  const action = String(params.action || "health").trim();
  const ss = getSpreadsheet_();
  ensureSchema_(ss);

  const session = resolveSession_(ss, params.token);
  let result;
  let logSource = "cache";

  try {
    switch (action) {
      case "health":
        result = {
          ok: true,
          service: "Crop Atlas Apps Script DB",
          spreadsheet: ss.getName(),
          timestamp: new Date().toISOString(),
          session: session ? { username: session.username, role: session.role } : null
        };
        break;

      // ---------------- AUTH & SESSIONS ----------------
      case "register":
        result = registerUser_(ss, params);
        logSource = "apps_script";
        break;
      case "login":
        result = loginUser_(ss, params);
        logSource = "apps_script";
        break;
      case "guestSession":
        result = {
          ok: true,
          user: { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" },
          token: "guest"
        };
        break;
      case "logout":
        result = logoutUser_(ss, params.token);
        break;
      case "me":
        result = { ok: true, user: session };
        break;

      // ---------------- HYBRID CATALOG ----------------
      case "getCatalog":
        result = getCatalog_(ss, false);
        logSource = result.source || "cache";
        break;
      case "syncCatalog":
        requireRole_(session, ["admin", "dev"]);
        result = getCatalog_(ss, true);
        logSource = "apps_script";
        break;
      case "saveCatalogBatch":
        result = saveCatalogBatch_(ss, params.crops);
        logSource = "client";
        break;

      // ---------------- HYBRID CLIMATE ----------------
      case "getClimate":
        result = getOrFetchClimate_(ss, params.lat, params.lon);
        logSource = result.source || "cache";
        break;
      case "saveClimate":
        result = saveClimateRecord_(ss, params.record, "client");
        logSource = "client";
        break;

      // ---------------- HYBRID SOIL ----------------
      case "getSoil":
        result = getOrFetchSoil_(ss, params.lat, params.lon);
        logSource = result.source || "cache";
        break;
      case "saveSoil":
        result = saveSoilRecord_(ss, params.record, "client");
        logSource = "client";
        break;

      // ---------------- HYBRID MAPSPAM 2020 (CLIENT COG WRITE-BACK) ----------------
      case "getMapSPAM":
        result = getMapSPAM_(ss, params.cell_key);
        logSource = result.source || "cache";
        break;
      case "saveMapSPAM":
        result = saveMapSPAM_(ss, params.cell_key, params.lat, params.lon, params.records);
        logSource = "client";
        break;

      // ---------------- HYBRID PHOTOS & PHOTON SEARCH ----------------
      case "getPhoto":
        result = getOrFetchPhoto_(ss, params.scientific);
        logSource = result.source || "cache";
        break;
      case "savePhoto":
        result = savePhotoRecord_(ss, params.scientific, params.photo, "client");
        logSource = "client";
        break;
      case "searchLocation":
        result = searchLocationPhoton_(params.q);
        logSource = "apps_script";
        break;

      // ---------------- USER BOOKMARKS, FIELDS & PLANTING LOGS ----------------
      case "getBookmarks":
        result = getBookmarks_(ss, session);
        break;
      case "saveBookmarks":
        result = saveBookmarks_(ss, session, params.saved, params.recent);
        break;
      case "listFields":
        result = listFields_(ss, session);
        break;
      case "saveField":
        result = saveField_(ss, session, params.field);
        break;
      case "deleteField":
        result = deleteField_(ss, session, params.field_id);
        break;
      case "listPlantingLogs":
        result = listPlantingLogs_(ss, session, params.field_id);
        break;
      case "addPlantingLog":
        result = addPlantingLog_(ss, session, params.log);
        break;
      case "deletePlantingLog":
        result = deletePlantingLog_(ss, session, params.log_id);
        break;

      // ---------------- ADMIN & DEV CONSOLE ----------------
      case "adminOverview":
        requireRole_(session, ["admin", "dev"]);
        result = adminOverview_(ss);
        break;
      case "adminListUsers":
        requireRole_(session, ["admin", "dev"]);
        result = adminListUsers_(ss);
        break;
      case "adminUpdateUser":
        requireRole_(session, ["admin", "dev"]);
        result = adminUpdateUser_(ss, params);
        break;
      case "adminUpsertCrop":
        requireRole_(session, ["admin", "dev"]);
        result = adminUpsertCrop_(ss, params.crop);
        break;
      case "adminClearCache":
        requireRole_(session, ["admin", "dev"]);
        result = adminClearCache_(ss, params.target, params.key);
        break;
      case "devGetLogs":
        requireRole_(session, ["admin", "dev"]);
        result = devGetLogs_(ss, Number(params.limit) || 60);
        break;

      default:
        result = { ok: false, error: "Unknown action: " + action };
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  const latencyMs = Date.now() - startMs;
  if (action !== "devGetLogs") {
    appendApiLog_(
      ss,
      session ? session.user_id : "guest",
      session ? session.role : "guest",
      action,
      logSource,
      result && result.ok ? "OK" : "ERROR",
      latencyMs,
      result && result.ok ? (result.detail || "") : (result && result.error ? result.error : "")
    );
  }

  return jsonResponse_(result);
}

// ============================================================================
// SPREADSHEET & SCHEMA HELPERS
// ============================================================================

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SPREADSHEET_ID");
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSchema_(ss) {
  const names = Object.keys(SCHEMA);
  let usersCreated = false;
  for (let i = 0; i < names.length; i++) {
    const sheetName = names[i];
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(SCHEMA[sheetName]);
      sheet.setFrozenRows(1);
      if (sheetName === "Users") usersCreated = true;
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(SCHEMA[sheetName]);
      sheet.setFrozenRows(1);
      if (sheetName === "Users") usersCreated = true;
    }
  }
  if (usersCreated) {
    seedDefaultData_(ss);
  }
}

function seedDefaultData_(ss) {
  const userSheet = ss.getSheetByName("Users");
  if (userSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const defaults = [
      { id: "usr_admin", username: "admin", name: "Dr. Nida (Admin)", role: "admin", pass: "admin123" },
      { id: "usr_dev", username: "dev", name: "Kanya (System Dev)", role: "dev", pass: "dev123" },
      { id: "usr_farmer", username: "farmer", name: "Somchai (Farmer)", role: "user", pass: "farmer123" }
    ];
    for (let i = 0; i < defaults.length; i++) {
      const u = defaults[i];
      const salt = Utilities.getUuid();
      const clientPreHash = sha256Hex_(u.pass + ":" + u.username.toLowerCase());
      const pwHash = hashWithSalt_(clientPreHash, salt);
      userSheet.appendRow([u.id, u.username, u.name, u.role, salt, pwHash, "active", now, now]);
    }
  }

  const cropSheet = ss.getSheetByName("Crops");
  if (cropSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const rows = STARTER_CROPS.map(function(c) {
      return cropObjectToRow_(c, now);
    });
    if (rows.length > 0) {
      cropSheet.getRange(2, 1, rows.length, SCHEMA.Crops.length).setValues(rows);
    }
  }
}

function readSheetObjects_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const obj = { _rowIndex: r + 1 };
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    out.push(obj);
  }
  return out;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// PASSWORD HASHING & AUTHENTICATION
// ============================================================================

function sha256Hex_(text) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  return digest.map(function(b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function hashWithSalt_(clientPreHash, salt) {
  let acc = salt + ":" + clientPreHash;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    acc = sha256Hex_(acc + ":" + i);
  }
  return acc;
}

function registerUser_(ss, params) {
  const username = String(params.username || "").trim().toLowerCase();
  const displayName = String(params.display_name || username).trim();
  const passwordHashClient = String(params.password_hash || "").trim();
  const requestedRole = String(params.role || "user").trim().toLowerCase();
  const bootstrapCode = String(params.bootstrap_code || "").trim();

  if (!username || username.length < 3) {
    return { ok: false, error: "Username must be at least 3 characters." };
  }
  if (!passwordHashClient || passwordHashClient.length < 32) {
    return { ok: false, error: "Client password hash is required." };
  }

  return withLock_(function() {
    const users = readSheetObjects_(ss, "Users");
    for (let i = 0; i < users.length; i++) {
      if (String(users[i].username).toLowerCase() === username) {
        return { ok: false, error: "Username already exists." };
      }
    }

    const expectedCode =
      PropertiesService.getScriptProperties().getProperty("ADMIN_BOOTSTRAP_CODE") ||
      "CROP-ATLAS-ADMIN-2026";
    let role = "user";
    if ((requestedRole === "admin" || requestedRole === "dev") && bootstrapCode === expectedCode) {
      role = requestedRole;
    }

    const userId = "usr_" + Utilities.getUuid().slice(0, 8);
    const salt = Utilities.getUuid();
    const finalHash = hashWithSalt_(passwordHashClient, salt);
    const now = new Date().toISOString();

    ss.getSheetByName("Users").appendRow([
      userId, username, displayName, role, salt, finalHash, "active", now, now
    ]);

    const token = issueSessionToken_(ss, {
      user_id: userId,
      username: username,
      display_name: displayName,
      role: role
    });

    return {
      ok: true,
      user: { user_id: userId, username: username, display_name: displayName, role: role },
      token: token
    };
  });
}

function loginUser_(ss, params) {
  const username = String(params.username || "").trim().toLowerCase();
  const passwordHashClient = String(params.password_hash || "").trim();

  const users = readSheetObjects_(ss, "Users");
  let matched = null;
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].username).toLowerCase() === username) {
      matched = users[i];
      break;
    }
  }

  if (!matched) {
    return { ok: false, error: "Invalid username or password." };
  }
  if (String(matched.status) !== "active") {
    return { ok: false, error: "Account is disabled. Contact an administrator." };
  }

  const candidateHash = hashWithSalt_(passwordHashClient, String(matched.salt));
  if (candidateHash !== String(matched.password_hash)) {
    return { ok: false, error: "Invalid username or password." };
  }

  const now = new Date().toISOString();
  ss.getSheetByName("Users").getRange(matched._rowIndex, 9).setValue(now);

  const userObj = {
    user_id: String(matched.user_id),
    username: String(matched.username),
    display_name: String(matched.display_name),
    role: String(matched.role)
  };
  const token = issueSessionToken_(ss, userObj);

  return { ok: true, user: userObj, token: token };
}

function issueSessionToken_(ss, userObj) {
  const rawToken = "tok_" + Utilities.getUuid() + "_" + Utilities.getUuid();
  const tokenHash = sha256Hex_(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  ss.getSheetByName("Sessions").appendRow([
    tokenHash,
    userObj.user_id,
    userObj.username,
    userObj.display_name,
    userObj.role,
    expires.toISOString(),
    now.toISOString()
  ]);
  return rawToken;
}

function resolveSession_(ss, rawToken) {
  if (!rawToken || rawToken === "guest") {
    return { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" };
  }
  const tokenHash = sha256Hex_(String(rawToken));
  const sessions = readSheetObjects_(ss, "Sessions");
  const nowIso = new Date().toISOString();
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (String(s.token_hash) === tokenHash && String(s.expires_at) > nowIso) {
      return {
        user_id: String(s.user_id),
        username: String(s.username),
        display_name: String(s.display_name),
        role: String(s.role)
      };
    }
  }
  return { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" };
}

function logoutUser_(ss, rawToken) {
  if (!rawToken || rawToken === "guest") return { ok: true };
  const tokenHash = sha256Hex_(String(rawToken));
  return withLock_(function() {
    const sheet = ss.getSheetByName("Sessions");
    const sessions = readSheetObjects_(ss, "Sessions");
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (String(sessions[i].token_hash) === tokenHash) {
        sheet.deleteRow(sessions[i]._rowIndex);
      }
    }
    return { ok: true };
  });
}

function requireRole_(session, allowedRoles) {
  if (!session || allowedRoles.indexOf(session.role) === -1) {
    throw new Error("Forbidden: requires role " + allowedRoles.join(" or "));
  }
}

// ============================================================================
// HYBRID DATA FETCHERS & GOOGLE SHEETS CACHE
// ============================================================================

function cropObjectToRow_(c, nowIso) {
  return [
    c.id || "",
    c.ecoport_code || "",
    c.scientific || "",
    c.name || "",
    c.icon || "🌱",
    c.aliases || "",
    c.category || "",
    c.family || "",
    c.lifespan || "",
    c.tmin ?? "", c.toptmin ?? "", c.toptmax ?? "", c.tmax ?? "",
    c.rmin ?? "", c.roptmin ?? "", c.roptmax ?? "", c.rmax ?? "",
    c.phmin ?? "", c.phoptmin ?? "", c.phoptmax ?? "", c.phmax ?? "",
    c.texture || "",
    c.drainage || "",
    c.gmin ?? "", c.gmax ?? "",
    Boolean(c.is_starter),
    nowIso
  ];
}

function rowToCropObject_(r) {
  const num = function(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) && n !== -999 ? n : null;
  };
  return {
    id: String(r.id),
    scientific: String(r.scientific),
    name: String(r.name),
    icon: String(r.icon || "🌱"),
    aliases: String(r.aliases || ""),
    category: String(r.category || ""),
    family: String(r.family || ""),
    lifespan: String(r.lifespan || ""),
    tmin: num(r.tmin), toptmin: num(r.toptmin), toptmax: num(r.toptmax), tmax: num(r.tmax),
    rmin: num(r.rmin), roptmin: num(r.roptmin), roptmax: num(r.roptmax), rmax: num(r.rmax),
    phmin: num(r.phmin), phoptmin: num(r.phoptmin), phoptmax: num(r.phoptmax), phmax: num(r.phmax),
    texture: String(r.texture || ""),
    drainage: String(r.drainage || ""),
    gmin: num(r.gmin), gmax: num(r.gmax),
    is_starter: Boolean(r.is_starter)
  };
}

function getCatalog_(ss, forceRefresh) {
  const existing = readSheetObjects_(ss, "Crops");
  if (!forceRefresh && existing.length > STARTER_CROPS.length) {
    return {
      ok: true,
      source: "cache",
      crops: existing.map(rowToCropObject_),
      detail: "Loaded " + existing.length + " crops from Crops sheet"
    };
  }

  // Server-side fetch of FAO EcoCrop CSV via UrlFetchApp when possible
  try {
    const resp = UrlFetchApp.fetch(ECOCROP_CSV_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error("EcoCrop HTTP " + resp.getResponseCode());
    }
    const csvText = resp.getContentText("ISO-8859-1");
    const parsed = parseEcoCropCsv_(csvText);
    saveCatalogBatch_(ss, parsed);
    return {
      ok: true,
      source: "apps_script",
      crops: parsed,
      detail: "Synced " + parsed.length + " EcoCrop records via Apps Script"
    };
  } catch (err) {
    return {
      ok: true,
      source: "cache",
      crops: existing.map(rowToCropObject_),
      warning: "Server CSV sync failed (" + err.message + "); returning current sheet rows."
    };
  }
}

function saveCatalogBatch_(ss, cropsArray) {
  if (!Array.isArray(cropsArray) || cropsArray.length === 0) {
    return { ok: false, error: "No crop records provided." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("Crops");
    const now = new Date().toISOString();
    const bySci = {};
    for (let i = 0; i < STARTER_CROPS.length; i++) {
      bySci[STARTER_CROPS[i].scientific] = STARTER_CROPS[i];
    }
    for (let i = 0; i < cropsArray.length; i++) {
      const c = cropsArray[i];
      if (!c || !c.scientific) continue;
      const starter = bySci[c.scientific];
      bySci[c.scientific] = Object.assign({}, starter || {}, c, {
        id: (starter && starter.id) || c.id || ("eco-" + c.scientific),
        name: (starter && starter.name) || c.name || c.scientific,
        icon: (starter && starter.icon) || c.icon || "🌱",
        is_starter: Boolean(starter || c.is_starter)
      });
    }
    const keys = Object.keys(bySci);
    const rows = keys.map(function(k) { return cropObjectToRow_(bySci[k], now); });
    sheet.clearContents();
    sheet.appendRow(SCHEMA.Crops);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, SCHEMA.Crops.length).setValues(rows);
    }
    return { ok: true, count: rows.length, detail: "Saved " + rows.length + " crops to sheet" };
  });
}

function getOrFetchClimate_(ss, latRaw, lonRaw) {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!isFinite(lat) || !isFinite(lon)) {
    return { ok: false, error: "Invalid coordinates for climate lookup." };
  }
  const coordKey = lat.toFixed(4) + "," + lon.toFixed(4);
  const rows = readSheetObjects_(ss, "ClimateCache");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].coord_key) === coordKey) {
      const t2mObj = JSON.parse(rows[i].t2m_json || "{}");
      const rainObj = JSON.parse(rows[i].rain_json || "{}");
      return {
        ok: true,
        source: "cache",
        record: {
          coord_key: coordKey,
          lat: Number(rows[i].lat),
          lon: Number(rows[i].lon),
          temperature: t2mObj,
          precipitation: rainObj.daily || rainObj,
          annualPrecipitation: rainObj.annualPrecipitation ?? rainObj.ANN ?? null,
          period: String(rows[i].period_label || ""),
          periodTitle: String(rows[i].period_title || ""),
          fetchedBy: String(rows[i].fetched_by || "cache"),
          fetchedAt: String(rows[i].fetched_at || "")
        }
      };
    }
  }

  // Cache miss -> Fetch from NASA POWER via Apps Script UrlFetchApp
  const url =
    "https://power.larc.nasa.gov/api/temporal/climatology/point" +
    "?parameters=T2M,PRECTOTCORR&community=AG" +
    "&longitude=" + encodeURIComponent(lon) +
    "&latitude=" + encodeURIComponent(lat) +
    "&format=JSON";

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    return { ok: false, error: "NASA POWER HTTP " + resp.getResponseCode() };
  }
  const data = JSON.parse(resp.getContentText());
  const params = data && data.properties && data.properties.parameter;
  const units = data && data.parameters;
  if (!params || !params.T2M || !params.PRECTOTCORR) {
    return { ok: false, error: "Missing T2M/PRECTOTCORR in NASA POWER response" };
  }
  const tUnit = String((units && units.T2M && units.T2M.units) || "");
  const rUnit = String((units && units.PRECTOTCORR && units.PRECTOTCORR.units) || "");
  if (!/^(C|°C|degC)$/i.test(tUnit) || !/^mm\/day$/i.test(rUnit)) {
    return { ok: false, error: "Unexpected NASA POWER units" };
  }

  const fillValue = (data.header && data.header.fill_value !== undefined) ? data.header.fill_value : -999;
  const temperature = {};
  const precipitation = {};
  let annualPrecipitation = 0;
  let allMonthsValid = true;

  const allKeys = MONTHS.concat(["ANN"]);
  for (let i = 0; i < allKeys.length; i++) {
    const k = allKeys[i];
    const tVal = Number(params.T2M[k]);
    temperature[k] = (isFinite(tVal) && tVal !== -999 && tVal !== fillValue) ? tVal : null;
    const rVal = Number(params.PRECTOTCORR[k]);
    precipitation[k] = (isFinite(rVal) && rVal !== -999 && rVal !== fillValue) ? rVal : null;
  }

  for (let m = 0; m < MONTHS.length; m++) {
    const k = MONTHS[m];
    if (precipitation[k] !== null && precipitation[k] >= 0) {
      annualPrecipitation += precipitation[k] * DAYS[m];
    } else {
      allMonthsValid = false;
    }
  }

  const periodRange = String((data.header && data.header.range) || "");
  const headerTitle = String((data.header && data.header.title) || "");
  const record = {
    coord_key: coordKey,
    lat: lat,
    lon: lon,
    temperature: temperature,
    precipitation: precipitation,
    annualPrecipitation: allMonthsValid ? annualPrecipitation : null,
    period: periodRange,
    periodTitle: headerTitle
  };

  saveClimateRecord_(ss, record, "apps_script");
  return { ok: true, source: "apps_script", record: record };
}

function saveClimateRecord_(ss, record, fetchedBy) {
  if (!record || !record.coord_key) {
    return { ok: false, error: "Invalid climate record" };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("ClimateCache");
    const rows = readSheetObjects_(ss, "ClimateCache");
    const now = new Date().toISOString();
    const t2mPayload = record.temperature || record.t2m || {};
    const rainPayload = {
      daily: record.precipitation || record.rain || {},
      annualPrecipitation: record.annualPrecipitation ?? null
    };
    const rowValues = [
      String(record.coord_key),
      Number(record.lat),
      Number(record.lon),
      JSON.stringify(t2mPayload),
      JSON.stringify(rainPayload),
      String(record.period || record.periodLabel || ""),
      String(record.periodTitle || ""),
      String(fetchedBy || "client"),
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].coord_key) === String(record.coord_key)) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, updated: true, coord_key: record.coord_key };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, created: true, coord_key: record.coord_key };
  });
}

function getOrFetchSoil_(ss, latRaw, lonRaw) {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!isFinite(lat) || !isFinite(lon)) {
    return { ok: false, error: "Invalid coordinates for soil lookup." };
  }
  const coordKey = lat.toFixed(5) + "," + lon.toFixed(5);
  const rows = readSheetObjects_(ss, "SoilCache");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].coord_key) === coordKey) {
      const r = rows[i];
      const phVal = r.ph === "" ? null : Number(r.ph);
      return {
        ok: true,
        source: "cache",
        record: {
          coord_key: coordKey,
          lat: Number(r.lat),
          lon: Number(r.lon),
          ph: phVal,
          phh2o: phVal,
          sand: r.sand === "" ? null : Number(r.sand),
          silt: r.silt === "" ? null : Number(r.silt),
          clay: r.clay === "" ? null : Number(r.clay),
          usda_texture: String(r.usda_texture || ""),
          source: String(r.source || "soilgrids_0_5cm"),
          fetchedBy: String(r.fetched_by || "cache"),
          fetchedAt: String(r.fetched_at || ""),
          retrievedAt: String(r.fetched_at || new Date().toISOString()),
          partial: false
        }
      };
    }
  }

  // Cache miss -> Fetch 4 SoilGrids WMS layers in parallel via UrlFetchApp.fetchAll
  const delta = 0.005;
  const bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
  const props = ["phh2o", "sand", "silt", "clay"];
  const requests = props.map(function(prop) {
    const layer = prop + "_0-5cm_mean";
    const url =
      "https://maps.isric.org/mapserv?map=/map/" + prop + ".map" +
      "&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo" +
      "&LAYERS=" + layer + "&QUERY_LAYERS=" + layer +
      "&SRS=EPSG:4326&BBOX=" + bbox +
      "&WIDTH=101&HEIGHT=101&X=50&Y=50" +
      "&INFO_FORMAT=application/json&FEATURE_COUNT=1";
    return { url: url, muteHttpExceptions: true };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  const parsed = { phh2o: null, sand: null, silt: null, clay: null };
  let anySuccess = false;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    const res = responses[i];
    if (res.getResponseCode() !== 200) continue;
    const json = JSON.parse(res.getContentText());
    const feat = json && json.features && json.features[0];
    const rawVal = feat && feat.properties ? Number(feat.properties.pixel_value) : null;
    if (rawVal !== null && isFinite(rawVal) && rawVal > 0) {
      const scaled = rawVal / 10.0;
      if ((prop === "phh2o" && scaled <= 14) || (prop !== "phh2o" && scaled <= 100)) {
        parsed[prop] = scaled;
        anySuccess = true;
      }
    }
  }

  if (!anySuccess) {
    return { ok: false, error: "SoilGrids returned no valid surface values." };
  }

  const nowIso = new Date().toISOString();
  const record = {
    coord_key: coordKey,
    lat: lat,
    lon: lon,
    ph: parsed.phh2o,
    phh2o: parsed.phh2o,
    sand: parsed.sand,
    silt: parsed.silt,
    clay: parsed.clay,
    usda_texture: classifyUsdaTexture_(parsed.sand, parsed.silt, parsed.clay),
    source: "soilgrids_0_5cm",
    retrievedAt: nowIso,
    partial: false
  };

  saveSoilRecord_(ss, record, "apps_script");
  return { ok: true, source: "apps_script", record: record };
}

function saveSoilRecord_(ss, record, fetchedBy) {
  if (!record || !record.coord_key) {
    return { ok: false, error: "Invalid soil record" };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("SoilCache");
    const rows = readSheetObjects_(ss, "SoilCache");
    const now = new Date().toISOString();
    const phVal = record.ph !== undefined && record.ph !== null ? record.ph : record.phh2o;
    const texture = record.usda_texture || classifyUsdaTexture_(record.sand, record.silt, record.clay);
    const rowValues = [
      String(record.coord_key),
      Number(record.lat),
      Number(record.lon),
      phVal ?? "",
      record.sand ?? "",
      record.silt ?? "",
      record.clay ?? "",
      texture,
      String(record.source || "soilgrids_0_5cm"),
      String(fetchedBy || "client"),
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].coord_key) === String(record.coord_key)) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, updated: true, coord_key: record.coord_key };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, created: true, coord_key: record.coord_key };
  });
}

function getMapSPAM_(ss, cellKey) {
  if (!cellKey) return { ok: false, error: "Missing cell_key" };
  const rows = readSheetObjects_(ss, "MapSPAMCache");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].cell_key) === String(cellKey)) {
      return {
        ok: true,
        source: "cache",
        cell_key: String(cellKey),
        records: JSON.parse(rows[i].records_json || "[]"),
        fetchedAt: String(rows[i].fetched_at || "")
      };
    }
  }
  return { ok: false, cacheMiss: true, cell_key: String(cellKey) };
}

function saveMapSPAM_(ss, cellKey, lat, lon, records) {
  if (!cellKey || !Array.isArray(records)) {
    return { ok: false, error: "Invalid MapSPAM payload" };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("MapSPAMCache");
    const rows = readSheetObjects_(ss, "MapSPAMCache");
    const now = new Date().toISOString();
    const rowValues = [
      String(cellKey),
      Number(lat) || 0,
      Number(lon) || 0,
      JSON.stringify(records),
      "client",
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].cell_key) === String(cellKey)) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, updated: true, cell_key: cellKey };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, created: true, cell_key: cellKey, detail: "Saved " + records.length + " bands" };
  });
}

function getOrFetchPhoto_(ss, scientificRaw) {
  const scientific = String(scientificRaw || "").trim();
  if (!scientific) return { ok: false, error: "Missing scientific name" };

  const rows = readSheetObjects_(ss, "PhotoCache");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].scientific) === scientific) {
      const pageLink = String(rows[i].pageURL || "");
      const artistName = String(rows[i].author || "");
      const isExact = Boolean(rows[i].exact);
      return {
        ok: true,
        source: "cache",
        photo: {
          url: String(rows[i].url || ""),
          page: pageLink,
          pageURL: pageLink,
          title: scientific,
          artist: artistName,
          author: artistName,
          license: String(rows[i].license || ""),
          licenseURL: String(rows[i].licenseURL || ""),
          verified: isExact,
          exact: isExact
        }
      };
    }
  }

  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
    "&generator=search&gsrnamespace=6&gsrlimit=1" +
    "&gsrsearch=" + encodeURIComponent('filetype:bitmap "' + scientific + '"') +
    "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900";

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    return { ok: false, error: "Wikimedia HTTP " + resp.getResponseCode() };
  }
  const data = JSON.parse(resp.getContentText());
  const pages = Object.values((data.query && data.query.pages) || {});
  const info = pages[0] && pages[0].imageinfo && pages[0].imageinfo[0];
  if (!info || (!info.thumburl && !info.url)) {
    return { ok: false, error: "No Commons photo found" };
  }
  const meta = info.extmetadata || {};
  const artistName = stripHtml_((meta.Artist && meta.Artist.value) || "Wikimedia Commons contributor");
  const pageLink = info.descriptionurl || "";
  const photo = {
    url: info.thumburl || info.url,
    page: pageLink,
    pageURL: pageLink,
    title: String((pages[0] && pages[0].title) || scientific).replace(/^File:/, ""),
    artist: artistName,
    author: artistName,
    license: stripHtml_((meta.LicenseShortName && meta.LicenseShortName.value) || "Free license"),
    licenseURL: (meta.LicenseUrl && meta.LicenseUrl.value) || "",
    verified: false,
    exact: false
  };
  savePhotoRecord_(ss, scientific, photo, "apps_script");
  return { ok: true, source: "apps_script", photo: photo };
}

function savePhotoRecord_(ss, scientific, photo, fetchedBy) {
  if (!scientific || !photo || !photo.url) {
    return { ok: false, error: "Invalid photo record" };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("PhotoCache");
    const rows = readSheetObjects_(ss, "PhotoCache");
    const now = new Date().toISOString();
    const rowValues = [
      String(scientific),
      String(photo.url || ""),
      String(photo.pageURL || photo.page || ""),
      String(photo.author || photo.artist || ""),
      String(photo.license || ""),
      String(photo.licenseURL || ""),
      Boolean(photo.exact || photo.verified),
      String(fetchedBy || "client"),
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].scientific) === String(scientific)) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, updated: true };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, created: true };
  });
}

function searchLocationPhoton_(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return { ok: true, features: [] };
  const url = "https://photon.komoot.io/api/?limit=20&q=" + encodeURIComponent(q);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    return { ok: false, error: "Photon HTTP " + resp.getResponseCode() };
  }
  const data = JSON.parse(resp.getContentText());
  return { ok: true, features: (data && data.features) || [] };
}

// ============================================================================
// USER BOOKMARKS, SAVED FIELDS & PLANTING LOGS
// ============================================================================

function getBookmarks_(ss, session) {
  if (!session || session.role === "guest") {
    return { ok: true, saved: [], recent: [], guest: true };
  }
  const rows = readSheetObjects_(ss, "UserBookmarks");
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].user_id) === session.user_id) {
      return {
        ok: true,
        saved: JSON.parse(rows[i].saved_ids_json || "[]"),
        recent: JSON.parse(rows[i].recent_ids_json || "[]")
      };
    }
  }
  return { ok: true, saved: [], recent: [] };
}

function saveBookmarks_(ss, session, saved, recent) {
  if (!session || session.role === "guest") {
    return { ok: true, guest: true };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("UserBookmarks");
    const rows = readSheetObjects_(ss, "UserBookmarks");
    const now = new Date().toISOString();
    const rowValues = [
      session.user_id,
      JSON.stringify(Array.isArray(saved) ? saved : []),
      JSON.stringify(Array.isArray(recent) ? recent.slice(0, 100) : []),
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].user_id) === session.user_id) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true };
  });
}

function listFields_(ss, session) {
  const rows = readSheetObjects_(ss, "Fields");
  const isAdmin = session && (session.role === "admin" || session.role === "dev");
  const filtered = rows.filter(function(r) {
    if (isAdmin) return true;
    return session && session.role !== "guest" && String(r.user_id) === session.user_id;
  });
  return { ok: true, fields: filtered };
}

function saveField_(ss, session, field) {
  if (!session || session.role === "guest") {
    return { ok: false, error: "Sign in required to save fields to the Google Sheets database." };
  }
  if (!field || !field.name || !isFinite(Number(field.lat)) || !isFinite(Number(field.lon))) {
    return { ok: false, error: "Field name and valid coordinates are required." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("Fields");
    const rows = readSheetObjects_(ss, "Fields");
    const now = new Date().toISOString();
    const fieldId = String(field.field_id || ("fld_" + Utilities.getUuid().slice(0, 8)));
    const rowValues = [
      fieldId,
      session.user_id,
      session.username,
      String(field.name).trim(),
      Number(field.lat),
      Number(field.lon),
      field.area_ha === "" || field.area_ha === null || field.area_ha === undefined ? "" : Number(field.area_ha),
      field.lab_ph === "" || field.lab_ph === null || field.lab_ph === undefined ? "" : Number(field.lab_ph),
      String(field.lab_texture || ""),
      String(field.notes || ""),
      String(field.created_at || now),
      now
    ];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].field_id) === fieldId) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, field_id: fieldId, updated: true };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, field_id: fieldId, created: true };
  });
}

function deleteField_(ss, session, fieldId) {
  if (!session || session.role === "guest") {
    return { ok: false, error: "Sign in required." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("Fields");
    const rows = readSheetObjects_(ss, "Fields");
    const isAdmin = session.role === "admin" || session.role === "dev";
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].field_id) === String(fieldId)) {
        if (!isAdmin && String(rows[i].user_id) !== session.user_id) {
          return { ok: false, error: "Cannot delete another user's field." };
        }
        sheet.deleteRow(rows[i]._rowIndex);
        return { ok: true };
      }
    }
    return { ok: false, error: "Field not found." };
  });
}

function listPlantingLogs_(ss, session, fieldId) {
  const rows = readSheetObjects_(ss, "PlantingLogs");
  const isAdmin = session && (session.role === "admin" || session.role === "dev");
  const filtered = rows.filter(function(r) {
    if (fieldId && String(r.field_id) !== String(fieldId)) return false;
    if (isAdmin) return true;
    return session && session.role !== "guest" && String(r.user_id) === session.user_id;
  });
  return { ok: true, logs: filtered };
}

function addPlantingLog_(ss, session, log) {
  if (!session || session.role === "guest") {
    return { ok: false, error: "Sign in required to save planting logs." };
  }
  if (!log || !log.crop_id) {
    return { ok: false, error: "Crop is required for planting log." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("PlantingLogs");
    const logId = "log_" + Utilities.getUuid().slice(0, 8);
    const now = new Date().toISOString();
    sheet.appendRow([
      logId,
      String(log.field_id || ""),
      session.user_id,
      String(log.crop_id),
      String(log.crop_name || log.crop_id),
      String(log.family || ""),
      String(log.season_year || new Date().getFullYear()),
      String(log.planting_month || "ANN"),
      String(log.water_supply || "unknown"),
      String(log.priority || "explore"),
      String(log.notes || ""),
      now
    ]);
    return { ok: true, log_id: logId };
  });
}

function deletePlantingLog_(ss, session, logId) {
  if (!session || session.role === "guest") {
    return { ok: false, error: "Sign in required." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("PlantingLogs");
    const rows = readSheetObjects_(ss, "PlantingLogs");
    const isAdmin = session.role === "admin" || session.role === "dev";
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].log_id) === String(logId)) {
        if (!isAdmin && String(rows[i].user_id) !== session.user_id) {
          return { ok: false, error: "Cannot delete another user's log." };
        }
        sheet.deleteRow(rows[i]._rowIndex);
        return { ok: true };
      }
    }
    return { ok: false, error: "Log not found." };
  });
}

// ============================================================================
// ADMIN & DEV CONSOLE HANDLERS
// ============================================================================

function adminOverview_(ss) {
  const counts = {};
  const names = Object.keys(SCHEMA);
  for (let i = 0; i < names.length; i++) {
    const sh = ss.getSheetByName(names[i]);
    counts[names[i]] = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
  }
  return {
    ok: true,
    spreadsheetName: ss.getName(),
    counts: counts,
    updatedAt: new Date().toISOString()
  };
}

function adminListUsers_(ss) {
  const users = readSheetObjects_(ss, "Users").map(function(u) {
    return {
      user_id: String(u.user_id),
      username: String(u.username),
      display_name: String(u.display_name),
      role: String(u.role),
      salt_preview: String(u.salt || "").slice(0, 8) + "…",
      hash_preview: String(u.password_hash || "").slice(0, 12) + "…",
      status: String(u.status),
      created_at: String(u.created_at),
      last_login_at: String(u.last_login_at)
    };
  });
  return { ok: true, users: users };
}

function adminUpdateUser_(ss, params) {
  const targetUserId = String(params.target_user_id || "");
  return withLock_(function() {
    const sheet = ss.getSheetByName("Users");
    const users = readSheetObjects_(ss, "Users");
    for (let i = 0; i < users.length; i++) {
      if (String(users[i].user_id) === targetUserId) {
        if (params.new_role) {
          sheet.getRange(users[i]._rowIndex, 4).setValue(String(params.new_role));
        }
        if (params.new_status) {
          sheet.getRange(users[i]._rowIndex, 7).setValue(String(params.new_status));
        }
        return { ok: true };
      }
    }
    return { ok: false, error: "User not found." };
  });
}

function adminUpsertCrop_(ss, crop) {
  if (!crop || !crop.scientific || !crop.name) {
    return { ok: false, error: "Crop name and scientific name are required." };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName("Crops");
    const rows = readSheetObjects_(ss, "Crops");
    const now = new Date().toISOString();
    const rowValues = cropObjectToRow_(crop, now);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].scientific) === String(crop.scientific) || String(rows[i].id) === String(crop.id)) {
        sheet.getRange(rows[i]._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
        return { ok: true, updated: true };
      }
    }
    sheet.appendRow(rowValues);
    return { ok: true, created: true };
  });
}

function adminClearCache_(ss, targetSheet, key) {
  const allowed = ["ClimateCache", "SoilCache", "MapSPAMCache", "PhotoCache", "ApiLogs"];
  if (allowed.indexOf(targetSheet) === -1) {
    return { ok: false, error: "Invalid cache target: " + targetSheet };
  }
  return withLock_(function() {
    const sheet = ss.getSheetByName(targetSheet);
    if (!key) {
      sheet.clearContents();
      sheet.appendRow(SCHEMA[targetSheet]);
      return { ok: true, clearedAll: true, target: targetSheet };
    }
    const rows = readSheetObjects_(ss, targetSheet);
    const pkCol = SCHEMA[targetSheet][0];
    let deleted = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][pkCol]) === String(key)) {
        sheet.deleteRow(rows[i]._rowIndex);
        deleted++;
      }
    }
    return { ok: true, deleted: deleted, target: targetSheet };
  });
}

function devGetLogs_(ss, limit) {
  const rows = readSheetObjects_(ss, "ApiLogs");
  return {
    ok: true,
    logs: rows.slice(Math.max(0, rows.length - limit)).reverse()
  };
}

function appendApiLog_(ss, actorUserId, actorRole, action, source, status, latencyMs, detail) {
  try {
    const sheet = ss.getSheetByName("ApiLogs");
    if (!sheet) return;
    sheet.appendRow([
      "req_" + Utilities.getUuid().slice(0, 8),
      new Date().toISOString(),
      String(actorUserId || "guest"),
      String(actorRole || "guest"),
      String(action || ""),
      String(source || ""),
      String(status || ""),
      Number(latencyMs) || 0,
      String(detail || "").slice(0, 300)
    ]);
  } catch (e) {
    // Non-fatal logging failure
  }
}

// ============================================================================
// AGRONOMIC & CSV UTILITIES
// ============================================================================

function classifyUsdaTexture_(sandRaw, siltRaw, clayRaw) {
  const sand = Number(sandRaw);
  const silt = Number(siltRaw);
  const clay = Number(clayRaw);
  if (!isFinite(sand) || !isFinite(silt) || !isFinite(clay)) return "Unknown";
  if (clay >= 40 && silt < 40 && sand <= 45) return "Clay";
  if (clay >= 40 && silt >= 40) return "Silty Clay";
  if (clay >= 35 && sand > 45) return "Sandy Clay";
  if (clay >= 27 && clay < 40 && sand <= 20) return "Silty Clay Loam";
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "Clay Loam";
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "Sandy Clay Loam";
  if (silt >= 80 && clay < 12) return "Silt";
  if (silt >= 50 && clay < 27) return "Silt Loam";
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "Loam";
  if (sand > 52 && (silt + 2 * clay) >= 30 && clay < 20) return "Sandy Loam";
  if (sand >= 70 && (silt + 1.5 * clay) >= 15) return "Loamy Sand";
  return "Sand";
}

function stripHtml_(text) {
  return String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseEcoCropCsv_(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && next === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return STARTER_CROPS;

  const headers = rows[0].map(function(h, idx) {
    const cleaned = idx === 0 ? h.replace(/^\uFEFF/, "") : h;
    return cleaned.trim();
  });

  const num = function(v) {
    if (v === null || v === undefined || v === "" || v === "NA") return null;
    const n = Number(v);
    return isFinite(n) && n !== -999 ? n : null;
  };
  const clean = function(v) {
    const s = stripHtml_(v);
    return s === "NA" ? "" : s;
  };

  const bySci = {};
  for (let i = 0; i < STARTER_CROPS.length; i++) {
    bySci[STARTER_CROPS[i].scientific] = STARTER_CROPS[i];
  }

  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (!vals || vals.length < 5) continue;
    const rec = {};
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = vals[c];
    }
    const sci = clean(rec.ScientificName);
    const cat = clean(rec.CAT);
    const starter = bySci[sci];
    const isFood = /vegetables|fruits|cereals|pulses|roots\/tubers|beverages|spices/i.test(cat);
    if (!sci || (!isFood && !starter)) continue;

    const aliases = clean(rec.COMNAME);
    const firstName = aliases.split(",")[0].trim();
    bySci[sci] = {
      id: (starter && starter.id) || ("eco-" + (rec.EcoPortCode || sci)),
      ecoport_code: clean(rec.EcoPortCode),
      name: (starter && starter.name) || firstName || sci,
      scientific: sci,
      icon: (starter && starter.icon) || "🌱",
      aliases: aliases,
      category: cat,
      family: (clean(rec.FAMNAME).split(":").pop() || "").trim(),
      lifespan: clean(rec.LISPA),
      tmin: num(rec.TMIN), toptmin: num(rec.TOPMN), toptmax: num(rec.TOPMX), tmax: num(rec.TMAX),
      rmin: num(rec.RMIN), roptmin: num(rec.ROPMN), roptmax: num(rec.ROPMX), rmax: num(rec.RMAX),
      phmin: num(rec.PHMIN), phoptmin: num(rec.PHOPMN), phoptmax: num(rec.PHOPMX), phmax: num(rec.PHMAX),
      texture: clean(rec.TEXT),
      drainage: clean(rec.DRA),
      gmin: num(rec.GMIN), gmax: num(rec.GMAX),
      is_starter: Boolean(starter)
    };
  }

  return Object.keys(bySci).map(function(k) { return bySci[k]; });
}
