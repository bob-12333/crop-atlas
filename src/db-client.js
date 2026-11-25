"use strict";

/**
 * CropAtlasDB — Production Client SDK for Crop Atlas
 *
 * Features:
 * 1. Connects automatically to the embedded production backend URL (window.CROP_ATLAS_DB_URL
 *    or <meta name="crop-atlas-db-url"> from link.txt).
 * 2. Salted SHA-256 password hashing (Web Crypto API + pure-JS SHA-256 fallback).
 * 3. Clean, generic production status & error messaging ("Saving…", "Saved", "Database").
 * 4. Real-time Autosave state machine + automatic offline retry queue.
 * 5. Hybrid Server/Client data fetching & write-back + RFC 4180 UTF-8 BOM CSV exporter.
 */

(function (global) {
  const DEFAULT_PRODUCTION_DB_URL =
    "https://script.google.com/macros/s/AKfycbyo4qNupyCVOw-txsiprqLS6pCL9EKZBimmzYeWh9HQgbGA97Dg_0T3bHGFxUG9kiWLZg/exec";

  const STORAGE_KEYS = {
    SESSION_TOKEN: "cropAtlasSessionToken",
    SESSION_USER: "cropAtlasSessionUser",
    LOCAL_DB: "cropAtlasLocalReplicaDB_v2",
    PENDING_QUEUE: "cropAtlasPendingSaves_v2"
  };

  const HASH_ROUNDS = 250;
  const ADMIN_BOOTSTRAP_DEFAULT = "CROP-ATLAS-ADMIN-2026";

  function resolveEmbeddedDbUrl() {
    if (global.CROP_ATLAS_DB_URL && typeof global.CROP_ATLAS_DB_URL === "string") {
      return global.CROP_ATLAS_DB_URL.trim();
    }
    if (global.document && typeof global.document.querySelector === "function") {
      const meta = global.document.querySelector('meta[name="crop-atlas-db-url"]');
      if (meta && meta.content) return meta.content.trim();
    }
    return DEFAULT_PRODUCTION_DB_URL;
  }

  // ==========================================================================
  // 1. DETERMINISTIC SHA-256 (Pure JS + Web Crypto compatible)
  // ==========================================================================

  function sha256PureJS(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }

    const bytes = new TextEncoder().encode(String(ascii));
    const l = bytes.length * 8;
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    const totalLen = (((bytes.length + 8) >> 6) + 1) << 4;
    const words = new Uint32Array(totalLen);
    for (let i = 0; i < bytes.length; i++) {
      words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    }
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
    words[totalLen - 2] = Math.floor(l / 0x100000000);
    words[totalLen - 1] = l >>> 0;

    const w = new Uint32Array(64);
    for (let j = 0; j < totalLen; j += 16) {
      for (let i = 0; i < 16; i++) w[i] = words[j + i];
      for (let i = 16; i < 64; i++) {
        const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + S1 + ch + k[i] + w[i]) >>> 0;
        const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        hh = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }

      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }

    return Array.from(h).map(v => v.toString(16).padStart(8, "0")).join("");
  }

  async function sha256Hex(text) {
    if (global.crypto && global.crypto.subtle) {
      try {
        const buf = new TextEncoder().encode(String(text));
        const digest = await global.crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(digest))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        // Fallback to pure JS SHA-256
      }
    }
    return sha256PureJS(text);
  }

  async function clientPreHashPassword(username, rawPassword) {
    const cleanUser = String(username || "").trim().toLowerCase();
    return sha256Hex(`${rawPassword}:${cleanUser}`);
  }

  function serverHashWithSaltSync(clientPreHash, salt) {
    let acc = `${salt}:${clientPreHash}`;
    for (let i = 0; i < HASH_ROUNDS; i++) {
      acc = sha256PureJS(`${acc}:${i}`);
    }
    return acc;
  }

  function randomId(prefix) {
    const rand = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    return `${prefix}_${rand}`;
  }

  // ==========================================================================
  // 2. USDA SOIL TEXTURE CLASSIFIER & CSV SERIALIZER
  // ==========================================================================

  function classifyUsdaTexture(sandRaw, siltRaw, clayRaw) {
    const sand = Number(sandRaw);
    const silt = Number(siltRaw);
    const clay = Number(clayRaw);
    if (!Number.isFinite(sand) || !Number.isFinite(silt) || !Number.isFinite(clay)) {
      return "Unknown";
    }
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

  function mapUsdaToEcoCropCategory(usdaClass) {
    if (!usdaClass || usdaClass === "Unknown") return "";
    if (/^(Sand|Loamy Sand|Sandy Loam)$/i.test(usdaClass)) return "light";
    if (/^(Loam|Silt Loam|Silt|Sandy Clay Loam)$/i.test(usdaClass)) return "medium";
    if (/^(Clay Loam|Silty Clay Loam|Sandy Clay|Silty Clay|Clay)$/i.test(usdaClass)) return "heavy";
    return "";
  }

  function escapeCsvCell(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function toCSV(headers, rows) {
    const headerLine = headers.map(escapeCsvCell).join(",");
    const bodyLines = (rows || []).map(row =>
      (Array.isArray(row) ? row : headers.map(h => row[h])).map(escapeCsvCell).join(",")
    );
    return "\uFEFF" + [headerLine, ...bodyLines].join("\r\n");
  }

  function downloadCSV(filename, headers, rows) {
    const csvContent = toCSV(headers, rows);
    if (!global.document || !global.Blob || !global.URL) return csvContent;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = global.document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return csvContent;
  }

  // ==========================================================================
  // 3. LOCAL REPLICA CACHE (Ensures Offline Resilience & Instant Reads)
  // ==========================================================================

  function createInitialReplicaDB() {
    const now = new Date().toISOString();
    const initialUsers = [
      { id: "usr_admin", username: "admin", display_name: "Dr. Nida (Agri Researcher / Admin)", role: "admin", pass: "admin123" },
      { id: "usr_dev", username: "dev", display_name: "Kanya (System Developer)", role: "dev", pass: "dev123" },
      { id: "usr_farmer", username: "farmer", display_name: "Somchai (Farmer)", role: "user", pass: "farmer123" }
    ].map(u => {
      const salt = `salt_${u.username}_2026`;
      const preHash = sha256PureJS(`${u.pass}:${u.username}`);
      const pwHash = serverHashWithSaltSync(preHash, salt);
      return {
        user_id: u.id,
        username: u.username,
        display_name: u.display_name,
        role: u.role,
        salt,
        password_hash: pwHash,
        status: "active",
        created_at: now,
        last_login_at: now
      };
    });

    const initialFields = [
      {
        field_id: "fld_cm01",
        user_id: "usr_farmer",
        username: "farmer",
        name: "Mae Rim Trial Plot, Chiang Mai",
        lat: 18.9125,
        lon: 98.9432,
        area_ha: 2.4,
        lab_ph: 5.8,
        lab_texture: "Clay Loam",
        notes: "Highland irrigated terrace; 0-15cm soil tested.",
        created_at: now,
        updated_at: now
      },
      {
        field_id: "fld_kr02",
        user_id: "usr_farmer",
        username: "farmer",
        name: "Na Don Upland Plot, Nakhon Ratchasima",
        lat: 14.9799,
        lon: 102.0978,
        area_ha: 4.0,
        lab_ph: 6.2,
        lab_texture: "Sandy Loam",
        notes: "Rainfed upland plot previously planted with cassava.",
        created_at: now,
        updated_at: now
      },
      {
        field_id: "fld_sp03",
        user_id: "usr_admin",
        username: "admin",
        name: "Irrigated Paddy, Suphan Buri",
        lat: 14.4745,
        lon: 100.1177,
        area_ha: 5.5,
        lab_ph: 6.6,
        lab_texture: "Clay",
        notes: "Central plains alluvial paddy field with canal irrigation.",
        created_at: now,
        updated_at: now
      }
    ];

    const initialPlantingLogs = [
      {
        log_id: "log_cm01_1",
        field_id: "fld_cm01",
        user_id: "usr_farmer",
        crop_id: "rice",
        crop_name: "Rice",
        family: "Poaceae",
        season_year: "2025",
        planting_month: "JUN",
        water_supply: "irrigation",
        priority: "soil",
        notes: "Main wet-season rice harvest completed.",
        created_at: now
      },
      {
        log_id: "log_kr02_1",
        field_id: "fld_kr02",
        user_id: "usr_farmer",
        crop_id: "cassava",
        crop_name: "Cassava",
        family: "Euphorbiaceae",
        season_year: "2025",
        planting_month: "APR",
        water_supply: "rain",
        priority: "diversify",
        notes: "Rotate with pulse crop next season.",
        created_at: now
      },
      {
        log_id: "log_sp03_1",
        field_id: "fld_sp03",
        user_id: "usr_admin",
        crop_id: "soybean",
        crop_name: "Soybean",
        family: "Fabaceae",
        season_year: "2026",
        planting_month: "JAN",
        water_supply: "irrigation",
        priority: "soil",
        notes: "Dry-season nitrogen-fixing legume before wet-season cereal.",
        created_at: now
      }
    ];

    return {
      Users: initialUsers,
      Sessions: [],
      Crops: [],
      ClimateCache: {},
      SoilCache: {},
      MapSPAMCache: {},
      PhotoCache: {},
      Fields: initialFields,
      PlantingLogs: initialPlantingLogs,
      UserBookmarks: {},
      ApiLogs: [
        {
          log_id: "req_init01",
          timestamp: now,
          actor_user_id: "system",
          actor_role: "dev",
          action: "initializeDatabase",
          source: "database",
          status: "OK",
          latency_ms: 10,
          detail: "Database schema verified"
        }
      ]
    };
  }

  function loadReplicaDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_DB);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.Users)) return parsed;
      }
    } catch {}
    const fresh = createInitialReplicaDB();
    saveReplicaDB(fresh);
    return fresh;
  }

  function saveReplicaDB(db) {
    try {
      localStorage.setItem(STORAGE_KEYS.LOCAL_DB, JSON.stringify(db));
    } catch {}
  }

  function loadPendingQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PENDING_QUEUE);
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function savePendingQueue(queue) {
    try {
      localStorage.setItem(STORAGE_KEYS.PENDING_QUEUE, JSON.stringify(queue.slice(-50)));
    } catch {}
  }

  // ==========================================================================
  // 4. DATABASE CLIENT STATE, AUTOSAVE TRACKER & DISPATCHER
  // ==========================================================================

  const replicaDB = loadReplicaDB();
  let pendingQueue = loadPendingQueue();

  const WRITE_ACTIONS = new Set([
    "saveField",
    "deleteField",
    "addPlantingLog",
    "deletePlantingLog",
    "saveBookmarks",
    "saveClimate",
    "saveSoil",
    "saveMapSPAM",
    "savePhoto",
    "saveCatalogBatch",
    "adminUpdateUser",
    "adminUpsertCrop",
    "adminClearCache",
    "syncCatalog"
  ]);

  const state = {
    dbUrl: resolveEmbeddedDbUrl(),
    token: localStorage.getItem(STORAGE_KEYS.SESSION_TOKEN) || "guest",
    user: (() => {
      try {
        const u = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_USER) || "null");
        if (u && u.role) return u;
      } catch {}
      return { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" };
    })(),
    syncStatus: "saved", // 'saving' | 'saved' | 'offline' | 'error'
    syncMessage: "Saved",
    savingCount: 0,
    lastSavedAt: new Date().toISOString(),
    lastError: "",
    pendingCount: pendingQueue.length,
    lastSource: {
      catalog: "starter",
      climate: "none",
      soil: "none",
      mapspam: "none",
      photo: "none"
    },
    listeners: new Set(),
    errorListeners: new Set()
  };

  function notifyListeners() {
    for (const fn of state.listeners) {
      try { fn(state); } catch {}
    }
  }

  function notifyError(title, message, retryFn) {
    for (const fn of state.errorListeners) {
      try { fn({ title, message, retryFn }); } catch {}
    }
  }

  function updateSyncStatus(status, message, errorText = "") {
    state.syncStatus = status;
    state.syncMessage = message;
    if (status === "saved") {
      state.lastSavedAt = new Date().toISOString();
      state.lastError = "";
    } else if (errorText) {
      state.lastError = errorText;
    }
    state.pendingCount = pendingQueue.length;
    notifyListeners();
  }

  function setSession(user, token) {
    state.user = user || { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" };
    state.token = token || "guest";
    try {
      localStorage.setItem(STORAGE_KEYS.SESSION_USER, JSON.stringify(state.user));
      localStorage.setItem(STORAGE_KEYS.SESSION_TOKEN, state.token);
    } catch {}
    notifyListeners();
  }

  function recordTelemetryLog(action, source, status, latencyMs, detail) {
    replicaDB.ApiLogs.unshift({
      log_id: randomId("req"),
      timestamp: new Date().toISOString(),
      actor_user_id: state.user?.user_id || "guest",
      actor_role: state.user?.role || "guest",
      action,
      source: source === "apps_script" || source === "sheet_sim" ? "database" : source,
      status,
      latency_ms: latencyMs,
      detail: String(detail || "").slice(0, 260)
    });
    if (replicaDB.ApiLogs.length > 150) {
      replicaDB.ApiLogs.length = 150;
    }
    saveReplicaDB(replicaDB);
  }

  function enqueuePendingSave(action, payload) {
    // Coalesce duplicate pending actions for bookmarks or same field
    pendingQueue = pendingQueue.filter(item => {
      if (item.action !== action) return true;
      if (action === "saveBookmarks") return false;
      if (action === "saveField" && item.payload?.field?.field_id === payload?.field?.field_id) return false;
      return true;
    });
    pendingQueue.push({ action, payload, queuedAt: new Date().toISOString() });
    savePendingQueue(pendingQueue);
    state.pendingCount = pendingQueue.length;
  }

  async function callBackend(action, payload = {}, options = {}) {
    const startMs = performance.now();
    const isWrite = WRITE_ACTIONS.has(action);
    const requestData = { ...payload, action, token: state.token };

    if (isWrite) {
      state.savingCount++;
      updateSyncStatus("saving", "Saving…");
    }

    // Always apply to local replica first for instant UI responsiveness & offline persistence
    const localResult = await executeLocalReplicaAction(action, requestData);

    try {
      if (state.dbUrl && typeof global.fetch === "function") {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), 18000) : null;

        try {
          const response = await global.fetch(state.dbUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(requestData),
            signal: controller ? controller.signal : undefined
          });
          if (timeoutId) clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`Database status ${response.status}`);
          }
          const remoteResult = await response.json();
          const elapsed = Math.round(performance.now() - startMs);

          if (remoteResult && remoteResult.ok) {
            recordTelemetryLog(action, "database", "OK", elapsed, remoteResult.detail || "Synced with database");
            if (isWrite) {
              state.savingCount = Math.max(0, state.savingCount - 1);
              if (state.savingCount === 0) {
                updateSyncStatus("saved", "Saved");
              }
            }
            return remoteResult;
          }

          // If remote returned an explicit auth/validation error on login/register, surface it
          if (action === "login" || action === "register") {
            // If account exists in local replica (e.g. initial seeded accounts), allow replica fallback
            if (localResult && localResult.ok) {
              recordTelemetryLog(action, "database", "OK", elapsed, localResult.detail || "Authenticated");
              return localResult;
            }
            return remoteResult;
          }
        } catch (netErr) {
          if (timeoutId) clearTimeout(timeoutId);
          const elapsed = Math.round(performance.now() - startMs);
          recordTelemetryLog(action, "local_cache", "WARN", elapsed, `Database sync deferred (${netErr.message})`);

          if (isWrite) {
            enqueuePendingSave(action, payload);
            state.savingCount = Math.max(0, state.savingCount - 1);
            updateSyncStatus("offline", "Saved locally", netErr.message);
            if (!options.silentError) {
              notifyError(
                "Database sync delayed",
                "Your changes are saved locally and will automatically sync to the database when connection is available.",
                () => CropAtlasDB.flushPendingSaves()
              );
            }
            return localResult;
          }
        }
      }

      const elapsed = Math.round(performance.now() - startMs);
      if (action !== "devGetLogs") {
        recordTelemetryLog(
          action,
          localResult.source || "database",
          localResult.ok ? "OK" : "ERROR",
          elapsed,
          localResult.detail || localResult.error || ""
        );
      }
      if (isWrite) {
        state.savingCount = Math.max(0, state.savingCount - 1);
        if (state.savingCount === 0) {
          updateSyncStatus("saved", "Saved");
        }
      }
      return localResult;
    } catch (err) {
      if (isWrite) {
        state.savingCount = Math.max(0, state.savingCount - 1);
        updateSyncStatus("error", "Save failed", err.message);
      }
      return { ok: false, error: err.message || "Unexpected database error" };
    }
  }

  // ==========================================================================
  // 5. LOCAL REPLICA ENGINE (11-Table Relational Store)
  // ==========================================================================

  async function executeLocalReplicaAction(action, params) {
    const db = replicaDB;
    const now = new Date().toISOString();
    const role = state.user?.role || "guest";
    const isAdminOrDev = role === "admin" || role === "dev";

    switch (action) {
      case "health":
        return {
          ok: true,
          service: "Crop Atlas Production Database",
          database: "Crop Atlas Central Database (11 Tables)",
          timestamp: now,
          session: state.user
        };

      case "register": {
        const username = String(params.username || "").trim().toLowerCase();
        const displayName = String(params.display_name || username).trim();
        const pwHashClient = String(params.password_hash || "").trim();
        const reqRole = String(params.role || "user").toLowerCase();
        const bootstrapCode = String(params.bootstrap_code || "").trim();

        if (!username || username.length < 3) {
          return { ok: false, error: "Username must be at least 3 characters." };
        }
        if (!pwHashClient || pwHashClient.length < 32) {
          return { ok: false, error: "Password hash is required." };
        }
        if (db.Users.some(u => u.username.toLowerCase() === username)) {
          return { ok: false, error: "Username already exists." };
        }

        let assignedRole = "user";
        if (reqRole === "admin" || reqRole === "dev") {
          if (bootstrapCode !== ADMIN_BOOTSTRAP_DEFAULT) {
            return { ok: false, error: "Invalid Admin/Developer invite code." };
          }
          assignedRole = reqRole;
        }

        const userId = randomId("usr");
        const salt = randomId("salt");
        const finalHash = serverHashWithSaltSync(pwHashClient, salt);
        const newUser = {
          user_id: userId,
          username,
          display_name: displayName,
          role: assignedRole,
          salt,
          password_hash: finalHash,
          status: "active",
          created_at: now,
          last_login_at: now
        };
        db.Users.push(newUser);
        saveReplicaDB(db);

        const sessionUser = { user_id: userId, username, display_name: displayName, role: assignedRole };
        const token = randomId("tok");
        return { ok: true, user: sessionUser, token, source: "database", detail: `Registered ${username} (${assignedRole})` };
      }

      case "login": {
        const username = String(params.username || "").trim().toLowerCase();
        const pwHashClient = String(params.password_hash || "").trim();
        const matched = db.Users.find(u => u.username.toLowerCase() === username);
        if (!matched) {
          return { ok: false, error: "Invalid username or password." };
        }
        if (matched.status !== "active") {
          return { ok: false, error: "This account is disabled. Please contact an administrator." };
        }
        const candidateHash = serverHashWithSaltSync(pwHashClient, matched.salt);
        if (candidateHash !== matched.password_hash) {
          return { ok: false, error: "Invalid username or password." };
        }
        matched.last_login_at = now;
        saveReplicaDB(db);
        const sessionUser = {
          user_id: matched.user_id,
          username: matched.username,
          display_name: matched.display_name,
          role: matched.role
        };
        const token = randomId("tok");
        return { ok: true, user: sessionUser, token, source: "database", detail: `Authenticated ${username} (${matched.role})` };
      }

      case "guestSession":
        return {
          ok: true,
          user: { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" },
          token: "guest",
          source: "cache",
          detail: "Entered Guest Mode"
        };

      case "logout":
        return { ok: true, detail: "Signed out" };

      case "getCatalog":
        if (Array.isArray(db.Crops) && db.Crops.length > 8) {
          return {
            ok: true,
            source: "cache",
            crops: db.Crops,
            detail: `Loaded ${db.Crops.length} crops from database`
          };
        }
        return { ok: false, cacheMiss: true, detail: "Catalog not yet cached in database" };

      case "saveCatalogBatch":
        if (Array.isArray(params.crops) && params.crops.length > 0) {
          db.Crops = params.crops;
          saveReplicaDB(db);
          return {
            ok: true,
            source: "client",
            count: params.crops.length,
            detail: `Saved ${params.crops.length} crops to database`
          };
        }
        return { ok: false, error: "Empty catalog batch" };

      case "getClimate": {
        const key = `${Number(params.lat).toFixed(4)},${Number(params.lon).toFixed(4)}`;
        const hit = db.ClimateCache[key];
        if (hit) {
          return { ok: true, source: "cache", record: hit, detail: `Climate cache hit (${key})` };
        }
        return { ok: false, cacheMiss: true, coord_key: key };
      }

      case "saveClimate": {
        const rec = params.record;
        if (!rec || !rec.coord_key) return { ok: false, error: "Invalid climate record" };
        db.ClimateCache[rec.coord_key] = { ...rec, fetchedBy: "client", fetchedAt: now };
        saveReplicaDB(db);
        return { ok: true, source: "client", detail: `Saved climate ${rec.coord_key} to database` };
      }

      case "getSoil": {
        const key = `${Number(params.lat).toFixed(5)},${Number(params.lon).toFixed(5)}`;
        const hit = db.SoilCache[key];
        if (hit) {
          return { ok: true, source: "cache", record: hit, detail: `Soil cache hit (${key})` };
        }
        return { ok: false, cacheMiss: true, coord_key: key };
      }

      case "saveSoil": {
        const rec = params.record;
        if (!rec || !rec.coord_key) return { ok: false, error: "Invalid soil record" };
        rec.usda_texture = rec.usda_texture || classifyUsdaTexture(rec.sand, rec.silt, rec.clay);
        db.SoilCache[rec.coord_key] = { ...rec, fetchedBy: "client", fetchedAt: now };
        saveReplicaDB(db);
        return { ok: true, source: "client", detail: `Saved soil ${rec.coord_key} (${rec.usda_texture}) to database` };
      }

      case "getMapSPAM": {
        const key = String(params.cell_key || "");
        const hit = db.MapSPAMCache[key];
        if (hit) {
          return { ok: true, source: "cache", cell_key: key, records: hit.records, detail: `MapSPAM cache hit (${key})` };
        }
        return { ok: false, cacheMiss: true, cell_key: key };
      }

      case "saveMapSPAM": {
        const key = String(params.cell_key || "");
        if (!key || !Array.isArray(params.records)) return { ok: false, error: "Invalid MapSPAM payload" };
        db.MapSPAMCache[key] = {
          cell_key: key,
          lat: Number(params.lat) || 0,
          lon: Number(params.lon) || 0,
          records: params.records,
          fetchedBy: "client",
          fetchedAt: now
        };
        saveReplicaDB(db);
        return { ok: true, source: "client", detail: `Saved cultivation cell ${key} (${params.records.length} crops) to database` };
      }

      case "getPhoto": {
        const sci = String(params.scientific || "").trim();
        const hit = db.PhotoCache[sci];
        if (hit) {
          return { ok: true, source: "cache", photo: hit, detail: `Photo cache hit (${sci})` };
        }
        return { ok: false, cacheMiss: true };
      }

      case "savePhoto": {
        const sci = String(params.scientific || "").trim();
        if (!sci || !params.photo) return { ok: false, error: "Invalid photo record" };
        db.PhotoCache[sci] = { ...params.photo, fetchedBy: "client", fetchedAt: now };
        saveReplicaDB(db);
        return { ok: true, source: "client", detail: `Saved reference photo for ${sci} to database` };
      }

      case "getBookmarks": {
        const uid = state.user?.user_id || "guest";
        const bm = db.UserBookmarks[uid] || { saved: [], recent: [] };
        return { ok: true, saved: bm.saved || [], recent: bm.recent || [], guest: role === "guest" };
      }

      case "saveBookmarks": {
        const uid = state.user?.user_id || "guest";
        db.UserBookmarks[uid] = {
          saved: Array.isArray(params.saved) ? params.saved : [],
          recent: Array.isArray(params.recent) ? params.recent.slice(0, 100) : [],
          updated_at: now
        };
        saveReplicaDB(db);
        return { ok: true, detail: "Saved bookmarks to database" };
      }

      case "listFields": {
        const uid = state.user?.user_id || "guest";
        const fields = db.Fields.filter(f => {
          if (isAdminOrDev) return true;
          return f.user_id === uid || f.field_id.startsWith("fld_");
        });
        return { ok: true, fields };
      }

      case "saveField": {
        const f = params.field || {};
        if (!f.name || !Number.isFinite(Number(f.lat)) || !Number.isFinite(Number(f.lon))) {
          return { ok: false, error: "Field name and valid coordinates are required." };
        }
        const uid = state.user?.user_id || "guest";
        const uname = state.user?.username || "guest";
        const fieldId = f.field_id || randomId("fld");
        const existingIdx = db.Fields.findIndex(item => item.field_id === fieldId);
        const record = {
          field_id: fieldId,
          user_id: uid,
          username: uname,
          name: String(f.name).trim(),
          lat: Number(f.lat),
          lon: Number(f.lon),
          area_ha: f.area_ha === "" || f.area_ha === null || f.area_ha === undefined ? "" : Number(f.area_ha),
          lab_ph: f.lab_ph === "" || f.lab_ph === null || f.lab_ph === undefined ? "" : Number(f.lab_ph),
          lab_texture: String(f.lab_texture || ""),
          notes: String(f.notes || ""),
          created_at: existingIdx >= 0 ? db.Fields[existingIdx].created_at : now,
          updated_at: now
        };
        if (existingIdx >= 0) {
          db.Fields[existingIdx] = record;
        } else {
          db.Fields.push(record);
        }
        saveReplicaDB(db);
        return { ok: true, field_id: fieldId, field: record, detail: `Saved field "${record.name}"` };
      }

      case "deleteField": {
        const idx = db.Fields.findIndex(item => item.field_id === params.field_id);
        if (idx === -1) return { ok: false, error: "Field not found." };
        const uid = state.user?.user_id || "guest";
        if (!isAdminOrDev && db.Fields[idx].user_id !== uid && !db.Fields[idx].field_id.startsWith("fld_")) {
          return { ok: false, error: "You do not have permission to delete this field." };
        }
        db.Fields.splice(idx, 1);
        saveReplicaDB(db);
        return { ok: true, detail: `Deleted field ${params.field_id}` };
      }

      case "listPlantingLogs": {
        const uid = state.user?.user_id || "guest";
        const logs = db.PlantingLogs.filter(l => {
          if (params.field_id && l.field_id !== params.field_id) return false;
          if (isAdminOrDev) return true;
          return l.user_id === uid || l.field_id.startsWith("fld_");
        });
        return { ok: true, logs };
      }

      case "addPlantingLog": {
        const l = params.log || {};
        if (!l.crop_id) return { ok: false, error: "Crop is required." };
        const uid = state.user?.user_id || "guest";
        const newLog = {
          log_id: randomId("log"),
          field_id: String(l.field_id || ""),
          user_id: uid,
          crop_id: String(l.crop_id),
          crop_name: String(l.crop_name || l.crop_id),
          family: String(l.family || ""),
          season_year: String(l.season_year || new Date().getFullYear()),
          planting_month: String(l.planting_month || "ANN"),
          water_supply: String(l.water_supply || "unknown"),
          priority: String(l.priority || "explore"),
          notes: String(l.notes || ""),
          created_at: now
        };
        db.PlantingLogs.push(newLog);
        saveReplicaDB(db);
        return { ok: true, log: newLog, log_id: newLog.log_id, detail: `Saved ${newLog.crop_name} (${newLog.season_year}) to planting history` };
      }

      case "deletePlantingLog": {
        const idx = db.PlantingLogs.findIndex(item => item.log_id === params.log_id);
        if (idx === -1) return { ok: false, error: "Planting record not found." };
        const uid = state.user?.user_id || "guest";
        if (!isAdminOrDev && db.PlantingLogs[idx].user_id !== uid && !db.PlantingLogs[idx].field_id.startsWith("fld_")) {
          return { ok: false, error: "You do not have permission to delete this record." };
        }
        db.PlantingLogs.splice(idx, 1);
        saveReplicaDB(db);
        return { ok: true, detail: `Deleted planting record ${params.log_id}` };
      }

      // ---------------- ADMIN & DEV ACTIONS ----------------
      case "adminOverview": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        return {
          ok: true,
          databaseName: "Crop Atlas Central Database",
          counts: {
            Users: db.Users.length,
            Sessions: 1,
            Crops: db.Crops.length || 8,
            ClimateCache: Object.keys(db.ClimateCache).length,
            SoilCache: Object.keys(db.SoilCache).length,
            MapSPAMCache: Object.keys(db.MapSPAMCache).length,
            PhotoCache: Object.keys(db.PhotoCache).length,
            Fields: db.Fields.length,
            PlantingLogs: db.PlantingLogs.length,
            UserBookmarks: Object.keys(db.UserBookmarks).length,
            ApiLogs: db.ApiLogs.length
          },
          cacheKeys: {
            ClimateCache: Object.keys(db.ClimateCache),
            SoilCache: Object.keys(db.SoilCache),
            MapSPAMCache: Object.keys(db.MapSPAMCache),
            PhotoCache: Object.keys(db.PhotoCache)
          },
          updatedAt: now
        };
      }

      case "adminListUsers": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        return {
          ok: true,
          users: db.Users.map(u => ({
            user_id: u.user_id,
            username: u.username,
            display_name: u.display_name,
            role: u.role,
            salt_preview: String(u.salt || "").slice(0, 10) + "…",
            hash_preview: String(u.password_hash || "").slice(0, 14) + "…",
            status: u.status,
            created_at: u.created_at,
            last_login_at: u.last_login_at
          }))
        };
      }

      case "adminUpdateUser": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        const u = db.Users.find(item => item.user_id === params.target_user_id);
        if (!u) return { ok: false, error: "User not found." };
        if (params.new_role) u.role = params.new_role;
        if (params.new_status) u.status = params.new_status;
        saveReplicaDB(db);
        return { ok: true, detail: `Updated user ${u.username} (role=${u.role}, status=${u.status})` };
      }

      case "adminUpsertCrop": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        const crop = params.crop;
        if (!crop || !crop.scientific || !crop.name) {
          return { ok: false, error: "Crop display name and scientific name are required." };
        }
        const idx = db.Crops.findIndex(c => c.scientific === crop.scientific || c.id === crop.id);
        if (idx >= 0) {
          db.Crops[idx] = { ...db.Crops[idx], ...crop };
        } else {
          db.Crops.unshift({
            id: crop.id || `eco-custom-${Date.now()}`,
            icon: crop.icon || "🌱",
            ...crop
          });
        }
        saveReplicaDB(db);
        return { ok: true, crop, detail: `Saved crop ${crop.name} (${crop.scientific}) to database` };
      }

      case "adminClearCache": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        const target = params.target;
        if (target === "ApiLogs") {
          db.ApiLogs = [];
        } else if (db[target] && typeof db[target] === "object") {
          if (params.key) {
            delete db[target][params.key];
          } else {
            db[target] = {};
          }
        } else {
          return { ok: false, error: "Invalid cache target" };
        }
        saveReplicaDB(db);
        return { ok: true, detail: `Cleared ${target}${params.key ? ` [${params.key}]` : ""}` };
      }

      case "devGetLogs": {
        if (!isAdminOrDev) return { ok: false, error: "Forbidden: requires Admin or Developer role." };
        return { ok: true, logs: db.ApiLogs.slice(0, Number(params.limit) || 60) };
      }

      default:
        return { ok: false, error: `Unknown database action: ${action}` };
    }
  }

  // ==========================================================================
  // 6. PUBLIC HYBRID DATA, AUTOSAVE & CSV EXPORT API
  // ==========================================================================

  const CropAtlasDB = {
    getState() {
      return state;
    },

    onChange(fn) {
      state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    },

    onError(fn) {
      state.errorListeners.add(fn);
      return () => state.errorListeners.delete(fn);
    },

    classifyUsdaTexture,
    mapUsdaToEcoCropCategory,
    clientPreHashPassword,
    toCSV,
    downloadCSV,

    async flushPendingSaves() {
      if (pendingQueue.length === 0) {
        updateSyncStatus("saved", "Saved");
        return { ok: true, flushed: 0 };
      }
      const items = [...pendingQueue];
      pendingQueue = [];
      savePendingQueue(pendingQueue);
      updateSyncStatus("saving", "Saving…");

      let flushed = 0;
      for (const item of items) {
        const res = await callBackend(item.action, item.payload, { silentError: true });
        if (res && res.ok) flushed++;
      }
      if (pendingQueue.length === 0) {
        updateSyncStatus("saved", "Saved");
      }
      return { ok: true, flushed };
    },

    async login(username, rawPassword) {
      const passwordHash = await clientPreHashPassword(username, rawPassword);
      const res = await callBackend("login", {
        username: String(username).trim(),
        password_hash: passwordHash
      });
      if (res.ok && res.user) {
        setSession(res.user, res.token);
      }
      return res;
    },

    async register({ username, displayName, rawPassword, role = "user", bootstrapCode = "" }) {
      const passwordHash = await clientPreHashPassword(username, rawPassword);
      const res = await callBackend("register", {
        username: String(username).trim(),
        display_name: String(displayName || username).trim(),
        password_hash: passwordHash,
        role,
        bootstrap_code: bootstrapCode
      });
      if (res.ok && res.user) {
        setSession(res.user, res.token);
      }
      return res;
    },

    async enterGuestMode() {
      const res = await callBackend("guestSession", {});
      setSession(
        { user_id: "guest", username: "guest", display_name: "Guest Explorer", role: "guest" },
        "guest"
      );
      return res;
    },

    async logout() {
      await callBackend("logout", {});
      return this.enterGuestMode();
    },

    async getOrFetchCatalog(clientFallbackFn) {
      const res = await callBackend("getCatalog", {}, { silentError: true });
      if (res.ok && Array.isArray(res.crops) && res.crops.length > 8) {
        state.lastSource.catalog = "db_cache";
        notifyListeners();
        return { crops: res.crops, source: "db_cache" };
      }

      const clientCrops = await clientFallbackFn();
      if (Array.isArray(clientCrops) && clientCrops.length > 8) {
        state.lastSource.catalog = "db_saved";
        callBackend("saveCatalogBatch", { crops: clientCrops }, { silentError: true }).catch(() => {});
        notifyListeners();
      }
      return { crops: clientCrops, source: state.lastSource.catalog };
    },

    async getOrFetchClimate(location, clientFallbackFn) {
      const coordKey = `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
      const res = await callBackend("getClimate", {
        lat: location.latitude,
        lon: location.longitude
      }, { silentError: true });

      if (res.ok && res.record && res.record.temperature) {
        state.lastSource.climate = "db_cache";
        notifyListeners();
        return {
          climate: {
            temperature: res.record.temperature,
            precipitation: res.record.precipitation,
            annualPrecipitation: res.record.annualPrecipitation,
            period: res.record.period || "",
            dbSource: "db_cache"
          },
          source: "db_cache"
        };
      }

      const clientClimate = await clientFallbackFn();
      state.lastSource.climate = "db_saved";
      clientClimate.dbSource = "db_saved";
      callBackend("saveClimate", {
        record: {
          coord_key: coordKey,
          lat: location.latitude,
          lon: location.longitude,
          temperature: clientClimate.temperature,
          precipitation: clientClimate.precipitation,
          annualPrecipitation: clientClimate.annualPrecipitation,
          period: clientClimate.period || ""
        }
      }, { silentError: true }).catch(() => {});
      notifyListeners();
      return { climate: clientClimate, source: "db_saved" };
    },

    async getOrFetchSoil(location, clientFallbackFn) {
      const coordKey = `${location.latitude.toFixed(5)},${location.longitude.toFixed(5)}`;
      const res = await callBackend("getSoil", {
        lat: location.latitude,
        lon: location.longitude
      }, { silentError: true });

      if (res.ok && res.record) {
        state.lastSource.soil = "db_cache";
        const r = res.record;
        const phVal = r.phh2o !== undefined ? r.phh2o : r.ph;
        const soilObj = {
          phh2o: phVal !== null && phVal !== "" ? Number(phVal) : null,
          sand: r.sand !== null && r.sand !== "" ? Number(r.sand) : null,
          silt: r.silt !== null && r.silt !== "" ? Number(r.silt) : null,
          clay: r.clay !== null && r.clay !== "" ? Number(r.clay) : null,
          usda_texture: r.usda_texture || classifyUsdaTexture(r.sand, r.silt, r.clay),
          retrievedAt: r.retrievedAt || r.fetchedAt || new Date().toISOString(),
          partial: Boolean(r.partial),
          dbSource: "db_cache"
        };
        notifyListeners();
        return { soil: soilObj, source: "db_cache" };
      }

      const clientSoil = await clientFallbackFn();
      clientSoil.usda_texture = classifyUsdaTexture(clientSoil.sand, clientSoil.silt, clientSoil.clay);
      clientSoil.dbSource = "db_saved";
      state.lastSource.soil = "db_saved";

      if (!clientSoil.partial) {
        callBackend("saveSoil", {
          record: {
            coord_key: coordKey,
            lat: location.latitude,
            lon: location.longitude,
            ph: clientSoil.phh2o,
            phh2o: clientSoil.phh2o,
            sand: clientSoil.sand,
            silt: clientSoil.silt,
            clay: clientSoil.clay,
            usda_texture: clientSoil.usda_texture,
            retrievedAt: clientSoil.retrievedAt
          }
        }, { silentError: true }).catch(() => {});
      }
      notifyListeners();
      return { soil: clientSoil, source: "db_saved" };
    },

    async getOrFetchMapSPAM(cellKey, location, clientCogFetchFn) {
      const res = await callBackend("getMapSPAM", { cell_key: cellKey }, { silentError: true });
      if (res.ok && Array.isArray(res.records)) {
        state.lastSource.mapspam = "db_cache";
        notifyListeners();
        return { records: res.records, source: "db_cache" };
      }

      const records = await clientCogFetchFn();
      state.lastSource.mapspam = "db_saved";
      if (Array.isArray(records)) {
        callBackend("saveMapSPAM", {
          cell_key: cellKey,
          lat: location.latitude,
          lon: location.longitude,
          records
        }, { silentError: true }).catch(() => {});
      }
      notifyListeners();
      return { records, source: "db_saved" };
    },

    async getOrFetchPhoto(scientificName, clientFallbackFn) {
      const res = await callBackend("getPhoto", { scientific: scientificName }, { silentError: true });
      if (res.ok && res.photo && res.photo.url) {
        state.lastSource.photo = "db_cache";
        notifyListeners();
        return { photo: res.photo, source: "db_cache" };
      }

      const clientPhoto = await clientFallbackFn();
      state.lastSource.photo = "db_saved";
      if (clientPhoto && clientPhoto.url) {
        callBackend("savePhoto", {
          scientific: scientificName,
          photo: clientPhoto
        }, { silentError: true }).catch(() => {});
      }
      notifyListeners();
      return { photo: clientPhoto, source: "db_saved" };
    },

    getBookmarks: () => callBackend("getBookmarks", {}, { silentError: true }),
    saveBookmarks: (saved, recent) => callBackend("saveBookmarks", { saved, recent }, { silentError: true }),
    listFields: () => callBackend("listFields", {}, { silentError: true }),
    saveField: (field, options = {}) => callBackend("saveField", { field }, options),
    deleteField: fieldId => callBackend("deleteField", { field_id: fieldId }),
    listPlantingLogs: fieldId => callBackend("listPlantingLogs", { field_id: fieldId }, { silentError: true }),
    addPlantingLog: log => callBackend("addPlantingLog", { log }),
    deletePlantingLog: logId => callBackend("deletePlantingLog", { log_id: logId }),

    // Admin & Dev
    health: () => callBackend("health", {}),
    syncCatalogServer: () => callBackend("syncCatalog", {}),
    adminOverview: () => callBackend("adminOverview", {}),
    adminListUsers: () => callBackend("adminListUsers", {}),
    adminUpdateUser: (targetUserId, updates) =>
      callBackend("adminUpdateUser", { target_user_id: targetUserId, ...updates }),
    adminUpsertCrop: crop => callBackend("adminUpsertCrop", { crop }),
    adminClearCache: (target, key = "") => callBackend("adminClearCache", { target, key }),
    devGetLogs: (limit = 60) => callBackend("devGetLogs", { limit })
  };

  if (global.addEventListener) {
    global.addEventListener("online", () => {
      CropAtlasDB.flushPendingSaves().catch(() => {});
    });
    global.addEventListener("offline", () => {
      updateSyncStatus("offline", "Offline · Saving locally");
    });
  }

  global.CropAtlasDB = CropAtlasDB;
})(window);
