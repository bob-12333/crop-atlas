"use strict";

// -----------------------------------------------------
// Helpers and state
// -----------------------------------------------------

const $ = id => document.getElementById(id);

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"
];

const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const CATALOG_URL =
  "https://raw.githubusercontent.com/OpenCLIM/ecocrop/main/EcoCrop_DB.csv";

let viewer;
let marker;
let selectedLocation = null;
let selectedCrop = null;
let climate = null;
let activeTab = "all";
let catalogLoaded = false;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function cleanText(value) {
  const text = String(value || "").trim();
  if (text === "NA") return "";

  const parsed = new DOMParser().parseFromString(text, "text/html");

  return (parsed.body.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result !== -999 ? result : null;
}

function formatValue(value, unit = "", decimals = 1) {
  if (!Number.isFinite(value)) return "Not available";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: decimals
  }) + (unit ? ` ${unit}` : "");
}

function rangeText(min, max, unit = "") {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return "Not available";
  }

  return `${min}–${max}${unit ? " " + unit : ""}`;
}

function readStorage(key) {
  try {
    const result = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

let savedCrops = readStorage("cropAtlasSaved");
let recentCrops = readStorage("cropAtlasRecent");

function saveStorage() {
  try {
    localStorage.setItem("cropAtlasSaved", JSON.stringify(savedCrops));
    localStorage.setItem("cropAtlasRecent", JSON.stringify(recentCrops));
  } catch {
    // The app can still run when browser storage is unavailable.
  }
}

function showMapMessage(message) {
  $("mapMessage").textContent = message;
  $("mapMessage").hidden = !message;
}

// -----------------------------------------------------
// Crop database
// -----------------------------------------------------

function starter(id, name, scientific, icon, values) {
  const [
    tmin, toptmin, toptmax, tmax,
    rmin, roptmin, roptmax, rmax,
    gmin, gmax
  ] = values;

  return {
    id, name, scientific, icon,
    tmin, toptmin, toptmax, tmax,
    rmin, roptmin, roptmax, rmax,
    gmin, gmax,
    phmin: null, phmax: null,
    phoptmin: null, phoptmax: null,
    texture: "", drainage: "", family: "",
    category: "", lifespan: "", aliases: name
  };
}

let crops = [
  starter("rice", "Rice", "Oryza sativa", "🌾",
    [10, 20, 30, 36, 1000, 1500, 2000, 4000, 80, 180]),

  starter("maize", "Maize", "Zea mays", "🌽",
    [10, 18, 33, 47, 400, 600, 1200, 1800, 65, 365]),

  starter("wheat", "Wheat", "Triticum aestivum", "🌾",
    [5, 15, 23, 27, 300, 750, 900, 1600, 90, 250]),

  starter("potato", "Potato", "Solanum tuberosum", "🥔",
    [7, 15, 25, 30, 250, 500, 800, 2000, 90, 160]),

  starter("soybean", "Soybean", "Glycine max", "🌱",
    [10, 20, 33, 38, 450, 600, 1500, 1800, 75, 180]),

  starter("coffee", "Arabica coffee", "Coffea arabica", "☕",
    [10, 14, 28, 34, 750, 1400, 2300, 4200, 210, 330]),

  starter("cassava", "Cassava", "Manihot esculenta", "🌿",
    [10, 20, 29, 35, 500, 1000, 1500, 5000, 180, 365]),

  starter("sunflower", "Sunflower", "Helianthus annuus", "🌻",
    [5, 17, 34, 45, 300, 600, 1000, 1600, 70, 200])
];

const startersByScientific = new Map(
  crops.map(crop => [crop.scientific, crop])
);

const preferredNames = {
  "Myristica fragrans": "Nutmeg",
  "Abelmoschus esculentus": "Okra",
  "Allium cepa": "Onion",
  "Allium sativum": "Garlic",
  "Ananas comosus": "Pineapple",
  "Arachis hypogaea": "Peanut",
  "Carica papaya": "Papaya",
  "Cicer arietinum": "Chickpea",
  "Citrullus lanatus": "Watermelon",
  "Cocos nucifera": "Coconut",
  "Cucumis sativus": "Cucumber",
  "Daucus carota": "Carrot",
  "Durio zibethinus": "Durian",
  "Ipomoea batatas": "Sweet potato",
  "Lactuca sativa": "Lettuce",
  "Lens culinaris": "Lentil",
  "Lycopersicon esculentum": "Tomato",
  "Solanum lycopersicum": "Tomato",
  "Mangifera indica": "Mango",
  "Persea americana": "Avocado",
  "Phaseolus vulgaris": "Common bean",
  "Pisum sativum": "Pea",
  "Saccharum officinarum": "Sugarcane",
  "Solanum melongena": "Eggplant",
  "Sorghum bicolor": "Sorghum",
  "Theobroma cacao": "Cacao",
  "Vigna radiata": "Mung bean",
  "Vigna unguiculata": "Cowpea",
  "Vitis vinifera": "Grape",
  "Zingiber officinale": "Ginger"
};

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];

    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (
      (character === "\n" || character === "\r") && !quoted
    ) {
      if (character === "\r" && text[i + 1] === "\n") i++;

      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);

      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);

  const headers = (rows.shift() || []).map(value =>
    value.replace(/^\uFEFF/, "").trim()
  );

  return rows.map(values =>
    Object.fromEntries(
      headers.map((key, index) => [key, values[index] || ""])
    )
  );
}

async function loadCatalog() {
  $("catalogStatus").textContent = "Loading plant database…";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  async function fetchEcoCropFromClient() {
    const response = await fetch(CATALOG_URL, {
      signal: controller.signal
    });

    if (!response.ok) throw new Error("Catalog request failed");

    const buffer = await response.arrayBuffer();
    const records = parseCSV(
      new TextDecoder("windows-1252").decode(buffer)
    );

    const merged = new Map(crops.map(crop => [crop.scientific, crop]));

    for (const record of records) {
      const scientific = cleanText(record.ScientificName);
      const category = cleanText(record.CAT);
      const original = startersByScientific.get(scientific);

      const foodRecord =
        /vegetables|fruits|cereals|pulses|roots\/tubers|beverages|spices/i
          .test(category);

      if (!scientific || (!foodRecord && !original)) continue;

      const aliases = cleanText(record.COMNAME);
      const firstName = aliases.split(",")[0].trim();

      merged.set(scientific, {
        id: original?.id || `eco-${record.EcoPortCode || scientific}`,
        name:
          original?.name ||
          preferredNames[scientific] ||
          firstName ||
          scientific,
        scientific,
        icon: original?.icon || "🌱",
        aliases,
        category,
        family: cleanText(record.FAMNAME).split(":").pop() || "",
        lifespan: cleanText(record.LISPA),
        tmin: number(record.TMIN),
        toptmin: number(record.TOPMN),
        toptmax: number(record.TOPMX),
        tmax: number(record.TMAX),
        rmin: number(record.RMIN),
        roptmin: number(record.ROPMN),
        roptmax: number(record.ROPMX),
        rmax: number(record.RMAX),
        phmin: number(record.PHMIN),
        phmax: number(record.PHMAX),
        phoptmin: number(record.PHOPMN),
        phoptmax: number(record.PHOPMX),
        gmin: number(record.GMIN),
        gmax: number(record.GMAX),
        texture: cleanText(record.TEXT),
        drainage: cleanText(record.DRA)
      });
    }

    return [...merged.values()];
  }

  try {
    const dbRes = window.CropAtlasDB
      ? await window.CropAtlasDB.getOrFetchCatalog(fetchEcoCropFromClient)
      : { crops: await fetchEcoCropFromClient(), source: "client" };

    crops = (dbRes.crops || []).sort((a, b) => {
      const first = startersByScientific.has(a.scientific);
      const second = startersByScientific.has(b.scientific);

      return first !== second
        ? first ? -1 : 1
        : a.name.localeCompare(b.name);
    });

    catalogLoaded = true;

    if (selectedCrop) {
      selectedCrop =
        crops.find(crop => crop.id === selectedCrop.id) || selectedCrop;
    }

    const srcBadge =
      dbRes.source === "db_cache"
        ? "Database"
        : "Saved to database";

    $("catalogStatus").textContent =
      `${crops.length.toLocaleString()} plant records · ${srcBadge}`;

    renderLibrary();
    refreshAssessment();
  } catch (error) {
    $("catalogStatus").textContent =
      "8 starter crops · full database unavailable. Refresh to retry.";
    if (typeof showUserError === "function") {
      showUserError(
        "Crop catalog could not load completely",
        "Using the 8 built-in starter crops for now. You can retry loading the full plant database.",
        () => loadCatalog()
      );
    }
    console.error("Crop database:", error);
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------
// Globe
// -----------------------------------------------------

async function initializeGlobe() {
  try {
    if (!window.Cesium) throw new Error("Cesium did not load");

    viewer = new Cesium.Viewer("globe", {
      baseLayer: false,
      baseLayerPicker: false,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false
    });

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(100.5, 15, 18000000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }
    });

    const controls = viewer.scene.screenSpaceCameraController;

    controls.zoomFactor = 2;
    controls.inertiaZoom = 0.55;
    controls.maximumZoomDistance = 30000000;
    controls.minimumZoomDistance = 30;
    controls.maximumMovementRatio = 0.02;
    controls.inertiaSpin = 0.3;
    controls.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
    controls.tiltEventTypes = [Cesium.CameraEventType.RIGHT_DRAG];
    controls.zoomEventTypes = [
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH
    ];
    controls.lookEventTypes = undefined;

    viewer.canvas.addEventListener("contextmenu", event => {
      event.preventDefault();
    });

    viewer.screenSpaceEventHandler.removeInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
    );

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

    handler.setInputAction(click => {
      const ray = viewer.camera.getPickRay(click.position);
      if (!ray) return;

      const position = viewer.scene.globe.pick(ray, viewer.scene);
      if (!position) return;

      const point = Cesium.Cartographic.fromCartesian(position);

      selectLocation({
        name: "Selected location",
        latitude: Cesium.Math.toDegrees(point.latitude),
        longitude: Cesium.Math.toDegrees(point.longitude)
      });

      closeSearch();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    try {
      const satellite =
        await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/" +
          "World_Imagery/MapServer",
          { maximumLevel: 17 }
        );

      viewer.imageryLayers.addImageryProvider(satellite);
    } catch (error) {
      showMapMessage("Satellite imagery could not load. Refresh to retry.");
      console.error("Satellite:", error);
    }

    try {
      const labels =
        await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/" +
          "Reference/World_Boundaries_and_Places/MapServer"
        );

      const layer = viewer.imageryLayers.addImageryProvider(labels);
      layer.alpha = 0.9;

      // This service chooses labels according to its tile zoom level.
      layer.show = true;
    } catch (error) {
      console.warn("Labels unavailable:", error);
    }
  } catch (error) {
    console.error("Globe:", error);

    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    viewer = null;

    showMapMessage(
      "Earth could not load. Check your connection and browser WebGL support."
    );
  }
}

function updateMarker(location) {
  if (!viewer) return;

  const position = Cesium.Cartesian3.fromDegrees(
    location.longitude, location.latitude
  );

  if (marker) {
    marker.position = position;
  } else {
    marker = viewer.entities.add({
      position,
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#c4e99d"),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }
}

function selectLocation(location, fly = false) {
  selectedLocation = location;
  resetSoilInputs();

  $("locationName").textContent = location.name;

  $("locationCoordinates").textContent =
    `${Math.abs(location.latitude).toFixed(4)}° ` +
    `${location.latitude >= 0 ? "N" : "S"} · ` +
    `${Math.abs(location.longitude).toFixed(4)}° ` +
    `${location.longitude >= 0 ? "E" : "W"}`;

  updateMarker(location);
  scheduleClimate(location);

  if (fly && viewer) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        location.longitude, location.latitude, 50000
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: 2
    });
  }
}

$("homeButton").onclick = () => {
  if (!viewer) return;

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(100.5, 15, 18000000),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    duration: 1.5
  });
};

$("zoomInButton").onclick = () => {
  if (!viewer) return;
  const height = viewer.camera.positionCartographic.height;
  viewer.camera.zoomIn(Math.max(0, height - 30) * 0.25);
};

$("zoomOutButton").onclick = () => {
  if (!viewer) return;
  const height = viewer.camera.positionCartographic.height;

  viewer.camera.zoomOut(
    Math.min(height * 0.25, Math.max(0, 30000000 - height))
  );
};

let terrainProvider;
let terrainOn = false;
let terrainBusy = false;

$("terrainButton").onclick = async () => {
  if (!viewer || terrainBusy) return;

  terrainBusy = true;
  $("terrainButton").disabled = true;

  try {
    if (terrainOn) {
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      terrainOn = false;
      showMapMessage("");
    } else {
      showMapMessage("Loading 3D terrain…");

      if (!terrainProvider) {
        terrainProvider =
          await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
            "https://elevation3d.arcgis.com/arcgis/rest/services/" +
            "WorldElevation3D/Terrain3D/ImageServer"
          );
      }

      viewer.terrainProvider = terrainProvider;
      terrainOn = true;
      showMapMessage("Terrain enabled. Zoom closer and right-drag to tilt.");
    }

    $("terrainButton").classList.toggle("active", terrainOn);
    $("terrainButton").setAttribute("aria-pressed", String(terrainOn));
  } catch (error) {
    showMapMessage("Terrain could not load. Try again later.");
    console.error("Terrain:", error);
  } finally {
    terrainBusy = false;
    $("terrainButton").disabled = false;
  }
};

// -----------------------------------------------------
// Location autocomplete
// -----------------------------------------------------

let searchTimer;
let searchRequest;
let searchVersion = 0;

function closeSearch() {
  clearTimeout(searchTimer);
  if (searchRequest) searchRequest.abort();
  searchVersion++;
  $("searchResults").replaceChildren();
}

function searchMessage(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "search-message";
  paragraph.textContent = message;
  $("searchResults").replaceChildren(paragraph);
}

function queueSearch() {
  closeSearch();

  const query = $("locationSearch").value.trim();

  if (query.length >= 2) {
    searchTimer = setTimeout(() => searchLocations(query), 400);
  }
}

$("locationSearch").addEventListener("input", event => {
  if (!event.isComposing) queueSearch();
});

$("locationSearch").addEventListener("compositionend", queueSearch);

$("locationSearch").addEventListener("keydown", event => {
  if (event.key === "Escape") closeSearch();

  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    clearTimeout(searchTimer);

    const query = $("locationSearch").value.trim();
    if (query.length >= 2) searchLocations(query);
  }
});

document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".search-area")) closeSearch();
});

async function searchLocations(query) {
  if (searchRequest) searchRequest.abort();

  const request = new AbortController();
  searchRequest = request;

  const version = ++searchVersion;
  const timeout = setTimeout(() => request.abort(), 20000);

  searchMessage("Searching addresses and places…");

  try {
    const url = new URL("https://photon.komoot.io/api/");

    url.searchParams.set("q", query);
    url.searchParams.set("limit", "20");

    const response = await fetch(url, {
      signal: request.signal
    });

    if (!response.ok) {
      throw new Error(`Place search status ${response.status}`);
    }

    const data = await response.json();

    if (version !== searchVersion) return;

    $("searchResults").replaceChildren();

    const places = (data.features || []).filter(feature => {
      const coordinates = feature.geometry?.coordinates;

      return feature.geometry?.type === "Point" &&
        Array.isArray(coordinates) &&
        Number.isFinite(coordinates[0]) &&
        Number.isFinite(coordinates[1]);
    });

    if (!places.length) {
      searchMessage(
        "No mapped places found. Add the city or district, " +
        "try another spelling, or select the point on the map."
      );
      return;
    }

    for (const feature of places) {
      const place = feature.properties || {};

      const [longitude, latitude] =
        feature.geometry.coordinates;

      const address = [
        place.housenumber,
        place.street
      ].filter(Boolean).join(" ");

      const title =
        place.name ||
        address ||
        place.city ||
        place.district ||
        place.state ||
        "Mapped location";

      const detailParts = [
        address,
        place.district,
        place.city,
        place.state,
        place.country
      ].filter(value => value && value !== title);

      const detail = [...new Set(detailParts)].join(", ");

      const kind = place.osm_value || place.type || "place";

      const icon =
        kind === "restaurant" ? "🍽️" :
        kind === "cafe" ? "☕" :
        kind === "hospital" ? "🏥" :
        kind === "school" ? "🏫" :
        kind === "mall" ? "🛍️" :
        place.type === "city" ? "🏙️" :
        "📍";

      const button = document.createElement("button");

      button.type = "button";
      button.className = "search-result";
      button.title = [title, detail].filter(Boolean).join(", ");

      button.style.cssText = `
        height: 64px;
        padding: 8px 12px;
        white-space: normal;
        text-align: left;
      `;

      const name = document.createElement("strong");
      name.textContent = `${icon} ${title}`;

      name.style.cssText = `
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      `;

      const description = document.createElement("small");
      description.textContent = detail || kind.replaceAll("_", " ");

      description.style.cssText = `
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        margin-top: 3px;
      `;

      button.append(name, description);

      button.onclick = () => {
        const fullName = [title, detail]
          .filter(Boolean)
          .join(", ");

        // Use the existing selection function so soil, climate,
        // and local crop lookups still update.
        selectLocation({
          name: fullName,
          latitude,
          longitude
        });

        $("locationSearch").value = title;
        closeSearch();

        if (!viewer) return;

        const type = place.type || "";

        const height =
          type === "country" ? 2500000 :
          type === "state" ? 400000 :
          type === "city" ? 50000 :
          type === "district" ? 20000 :
          type === "locality" ? 10000 :
          type === "street" ? 3500 :
          1500;

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            height
          ),
          orientation: {
            heading: 0,
            pitch: -Math.PI / 2,
            roll: 0
          },
          duration: 2
        });
      };

      $("searchResults").appendChild(button);
    }

    const credit = document.createElement("p");
    credit.className = "search-message";
    credit.style.fontSize = "11px";

    credit.appendChild(
      document.createTextNode("Search: Photon · ")
    );

    const link = document.createElement("a");
    link.href = "https://www.openstreetmap.org/copyright";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "© OpenStreetMap contributors";

    credit.appendChild(link);
    $("searchResults").appendChild(credit);

    // About five results visible; scroll inside for more.
    $("searchResults").style.maxHeight = "320px";
    $("searchResults").style.overflowY = "auto";
    $("searchResults").scrollTop = 0;

  } catch (error) {
    if (version !== searchVersion) return;

    searchMessage(
      "Place search could not load. Try again, " +
      "or click a location directly on the map."
    );

    if (typeof showUserError === "function" && error?.name !== "AbortError") {
      showUserError(
        "Location search unavailable",
        "Could not reach the address search service. You can retry the search or click any point directly on the 3D Earth.",
        () => searchLocations(query)
      );
    }

    console.error("Place search:", error);
  } finally {
    clearTimeout(timeout);
  }
}
// -----------------------------------------------------
// NASA POWER climate averages
// -----------------------------------------------------

let climateTimer;
let climateRequest;
let climateVersion = 0;
const climateCache = new Map();

function scheduleClimate(location) {
  clearTimeout(climateTimer);
  if (climateRequest) climateRequest.abort();

  const version = ++climateVersion;
  climate = null;

  $("nasaStatus").textContent = "Loading NASA climate averages…";
  $("retryClimate").hidden = true;
  $("monthlyRows").replaceChildren();

  refreshAssessment();

  climateTimer = setTimeout(() => {
    loadClimate(location, version);
  }, 600);
}

async function loadClimate(location, version) {
  const cacheKey =
    `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;

  if (climateCache.has(cacheKey)) {
    if (version !== climateVersion) return;
    climate = climateCache.get(cacheKey);
    displayClimate();
    return;
  }

  const request = new AbortController();
  climateRequest = request;
  const timeout = setTimeout(() => request.abort(), 30000);

  async function fetchNasaPowerFromClient() {
    const url = new URL(
      "https://power.larc.nasa.gov/api/temporal/climatology/point"
    );

    url.searchParams.set("parameters", "T2M,PRECTOTCORR");
    url.searchParams.set("community", "AG");
    url.searchParams.set("latitude", location.latitude);
    url.searchParams.set("longitude", location.longitude);
    url.searchParams.set("format", "JSON");

    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error(`NASA status ${response.status}`);

    const data = await response.json();

    if (!data.properties?.parameter) {
      throw new Error("No climate parameters");
    }

    const tempUnits = data.parameters?.T2M?.units || "";
    const rainUnits = data.parameters?.PRECTOTCORR?.units || "";

    if (!/^(C|°C|degC)$/i.test(tempUnits) ||
        !/^mm\/day$/i.test(rainUnits)) {
      throw new Error("Unexpected NASA units");
    }

    const fillValue = data.header?.fill_value ?? -999;

    function cleanSeries(series) {
      return Object.fromEntries(
        [...MONTHS, "ANN"].map(key => {
          const value = number(series?.[key]);
          return [key, value === fillValue ? null : value];
        })
      );
    }

    const temperature = cleanSeries(data.properties.parameter.T2M);
    const precipitation =
      cleanSeries(data.properties.parameter.PRECTOTCORR);

    const completeRain = MONTHS.every(key =>
      precipitation[key] !== null && precipitation[key] >= 0
    );

    const annualPrecipitation = completeRain
      ? MONTHS.reduce(
          (sum, key, index) => sum + precipitation[key] * DAYS[index], 0
        )
      : null;

    return {
      temperature,
      precipitation,
      annualPrecipitation,
      period: String(data.header?.range || "")
    };
  }

  try {
    const dbRes = window.CropAtlasDB
      ? await window.CropAtlasDB.getOrFetchClimate(location, fetchNasaPowerFromClient)
      : { climate: await fetchNasaPowerFromClient(), source: "client" };

    if (version !== climateVersion) return;

    climate = dbRes.climate;
    climateCache.set(cacheKey, climate);
    displayClimate();
  } catch (error) {
    if (version !== climateVersion) return;

    climate = null;
    $("nasaStatus").textContent =
      "NASA data could not load. Check your connection or retry.";
    $("retryClimate").hidden = false;

    if (typeof showUserError === "function") {
      showUserError(
        "Climate data could not load",
        "Unable to fetch historical climate averages for this location. Check your network connection or click Retry.",
        () => scheduleClimate(location)
      );
    }

    refreshAssessment();
    console.error("NASA POWER:", error);
  } finally {
    clearTimeout(timeout);
  }
}

function displayClimate() {
  if (!climate) return;

  const years = climate.period.match(/\b(?:19|20)\d{2}\b/g);
  const srcNote =
    climate.dbSource === "db_cache"
      ? " · Cached in database"
      : climate.dbSource === "db_saved"
        ? " · Saved to database"
        : "";

  $("nasaStatus").textContent = (years?.length >= 2
    ? `NASA POWER · Climate averages, ${years[0]}–${years[years.length - 1]}`
    : "NASA POWER · Long-term climate averages") + srcNote;

  $("nasaStatus").title = climate.period;
  $("retryClimate").hidden = true;
  $("monthlyRows").replaceChildren();

  MONTHS.forEach((month, index) => {
    const row = document.createElement("tr");

    const rain = climate.precipitation[month];
    const monthlyRain = Number.isFinite(rain) && rain >= 0
      ? rain * DAYS[index]
      : null;

    [
      month,
      formatValue(climate.temperature[month], "", 1),
      formatValue(monthlyRain, "", 0)
    ].forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });

    $("monthlyRows").appendChild(row);
  });

  refreshAssessment();
}

$("retryClimate").onclick = () => {
  if (selectedLocation) scheduleClimate(selectedLocation);
};

$("climateMonth").onchange = refreshAssessment;

// -----------------------------------------------------
// Clear climate comparison
// -----------------------------------------------------

function compareRange(value, min, bestMin, bestMax, max) {
  const values = [value, min, bestMin, bestMax, max];

  if (!values.every(Number.isFinite)) {
    return { level: null, label: "Not enough data", className: "warning" };
  }

  if (!(min <= bestMin && bestMin <= bestMax && bestMax <= max)) {
    return {
      level: null,
      label: "Reference range needs review",
      className: "warning"
    };
  }

  if (value < min) {
    return { level: 0, label: "Below recorded range", className: "bad" };
  }

  if (value > max) {
    return { level: 0, label: "Above recorded range", className: "bad" };
  }

  if (value >= bestMin && value <= bestMax) {
    return {
      level: 2,
      label: "Within preferred range",
      className: "good"
    };
  }

  return {
    level: 1,
    label: "Within tolerance; outside preferred range",
    className: "warning"
  };
}

function compareCrop(crop) {
  const month = $("climateMonth").value;

  return {
    temperature: compareRange(
      climate.temperature[month],
      crop.tmin, crop.toptmin, crop.toptmax, crop.tmax
    ),
    rainfall: compareRange(
      climate.annualPrecipitation,
      crop.rmin, crop.roptmin, crop.roptmax, crop.rmax
    )
  };
}

function refreshAssessment() {
  updateAssessment();
  renderRecommendations();
}

function metricCard(title, value, result, preferred, tolerance) {
  const symbol = result
    ? result.level === 2 ? "✓" : result.level === null ? "?" : "!"
    : "";

  return `
    <section class="metric-card">
      <div class="metric-title">${escapeHTML(title)}</div>
      <div class="metric-value">${escapeHTML(value)}</div>
      ${result ? `
        <div class="metric-status ${result.className}">
          ${symbol} ${escapeHTML(result.label)}
        </div>
        <div class="metric-range">
          Preferred: ${escapeHTML(preferred)}<br>
          Tolerance: ${escapeHTML(tolerance)}
        </div>
      ` : ""}
    </section>
  `;
}

function updateAssessment() {
  const badge = $("climateMatch");
  const panel = $("assessment");

  badge.className = "badge";

  if (!selectedLocation) {
    badge.textContent = "Choose a location";
    panel.textContent = "Click the Earth or search for a city or town.";
    return;
  }

  if (!climate) {
    badge.textContent = $("retryClimate").hidden
      ? "Loading climate data…"
      : "Climate data unavailable";

    panel.textContent = $("retryClimate").hidden
      ? "Your location’s climate averages will appear here."
      : "Use the retry button below to request NASA data again.";

    return;
  }

  const month = $("climateMonth").value;
  const temperatureTitle = month === "ANN"
    ? "🌡️ Average temperature · annual"
    : `🌡️ Average temperature · ${month}`;

  const localTemp = formatValue(climate.temperature[month], "°C", 1);
  const localRain =
    formatValue(climate.annualPrecipitation, "mm/year", 0);

  if (!selectedCrop) {
    badge.textContent = "Climate loaded · choose a crop";

    panel.innerHTML =
      metricCard(temperatureTitle, localTemp) +
      metricCard("🌧️ Rainfall · annual total", localRain) +
      '<p class="note">Select a crop to compare its reference ranges.</p>';

    return;
  }

  const crop = selectedCrop;
  const results = compareCrop(crop);
  const levels = [results.temperature.level, results.rainfall.level];

  if (levels.includes(0)) {
    badge.textContent = "⚠ Climate limits to check";
    badge.classList.add("bad");
  } else if (levels.includes(null)) {
    badge.textContent = "? More data needed";
    badge.classList.add("warning");
  } else if (levels.every(level => level === 2)) {
    badge.textContent = "✓ Both within preferred ranges";
    badge.classList.add("good");
  } else {
    badge.textContent = "! Within tolerance ranges";
    badge.classList.add("warning");
  }

  panel.innerHTML =
    metricCard(
      temperatureTitle,
      localTemp,
      results.temperature,
      rangeText(crop.toptmin, crop.toptmax, "°C"),
      rangeText(crop.tmin, crop.tmax, "°C")
    ) +
    metricCard(
      "🌧️ Rainfall · annual total",
      localRain,
      results.rainfall,
      rangeText(crop.roptmin, crop.roptmax, "mm/year"),
      rangeText(crop.rmin, crop.rmax, "mm/year")
    ) +
    `
      <p class="note">
        Climate comparison only. Soil, planting season,
        irrigation, and crop variety also matter.
      </p>
      <details>
        <summary>What do these results mean?</summary>
        <p>
          <strong>Preferred:</strong> inside the recorded optimal range.
          <strong>Tolerance:</strong> inside the broader reference limits.
        </p>
        <p>
          Results outside those limits need investigation.
          They do not prove cultivation is impossible.
          A match does not guarantee a successful harvest.
        </p>
      </details>
    `;
}

// -----------------------------------------------------
// Climate-based crop suggestions
// -----------------------------------------------------

let suggestionLimit = 5;

function renderRecommendations() {
  const container = $("recommendations");
  container.replaceChildren();

  function message(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "muted";
    paragraph.textContent = text;
    container.appendChild(paragraph);
  }

  if (!selectedLocation) {
    message("Click a location to see suggestions.");
    return;
  }

  if (!climate) {
    message("Suggestions appear when climate data loads.");
    return;
  }

  const matches = crops.map(crop => {
    const result = compareCrop(crop);
    const temp = result.temperature.level;
    const rain = result.rainfall.level;

    return {
      crop,
      temp,
      rain,
      score: temp !== null && rain !== null ? temp + rain : -1
    };
  }).filter(item =>
    item.temp !== null &&
    item.rain !== null &&
    item.temp > 0 &&
    item.rain > 0
  ).sort((a, b) =>
    b.score - a.score || a.crop.name.localeCompare(b.crop.name)
  );

  if (!matches.length) {
    message(
      "No crops with complete reference data matched both climate ranges. " +
      "This does not mean no crops can grow here."
    );
    return;
  }

  const month = $("climateMonth").value;

  message(
    `${matches.length} reference-range matches · ` +
    `${month === "ANN" ? "annual" : month} temperature + annual rainfall. ` +
    (catalogLoaded ? "" : "Using the starter crops while the catalog loads.")
  );

  for (const item of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";

    const title = document.createElement("strong");
    title.textContent = `${item.crop.icon} ${item.crop.name}`;

    const reason = document.createElement("small");
    reason.textContent = item.score === 4
      ? "✓ Both climate values within preferred ranges"
      : "Both within tolerance; at least one outside preferred range";

    button.append(title, reason);
    button.onclick = () => selectCrop(item.crop);
    container.appendChild(button);
  }

  
  message(
    "Grouped by range match, then alphabetically—not predicted yield or profit. " +
    "No land-use or soil check is applied."
  );
}

// -----------------------------------------------------
// Library, bookmarks, recent history
// -----------------------------------------------------

function selectCrop(crop) {
  selectedCrop = crop;
   updateSoilAssessment();

  recentCrops = [
    crop.id,
    ...recentCrops.filter(id => id !== crop.id)
  ].slice(0, 100);

  saveStorage();

  $("cropPreview").textContent = crop.icon;
  $("selectedCropName").textContent = `${crop.icon} ${crop.name}`;
  $("selectedScientific").textContent = crop.scientific;
  $("cropDetailsButton").disabled = false;

  renderLibrary();
  updateAssessment();
}

function renderLibrary() {
  const query = $("cropSearch").value.trim().toLowerCase();
  let visible = crops;

  if (activeTab === "saved") {
    visible = crops.filter(crop => savedCrops.includes(crop.id));
  }

  if (activeTab === "recent") {
    visible = recentCrops.map(id =>
      crops.find(crop => crop.id === id)
    ).filter(Boolean);
  }

  visible = visible.filter(crop =>
    `${crop.name} ${crop.scientific} ${crop.aliases}`
      .toLowerCase()
      .includes(query)
  );

  document.querySelectorAll("[data-tab]").forEach(button => {
    const active = button.dataset.tab === activeTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  $("cropList").replaceChildren();

  if (!visible.length) {
    const paragraph = document.createElement("p");
    paragraph.className = "muted";
    paragraph.textContent = query
      ? "No matching crops."
      : activeTab === "saved"
        ? "Click ☆ beside a crop to save it."
        : "Crops you inspect will appear here.";

    $("cropList").appendChild(paragraph);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const crop of visible) {
    const row = document.createElement("div");
    row.className = "crop-row";
    row.classList.toggle("selected", selectedCrop?.id === crop.id);

    const select = document.createElement("button");
    select.type = "button";
    select.className = "crop-select";

    const name = document.createElement("span");
    name.textContent = `${crop.icon} ${crop.name}`;

    const scientific = document.createElement("small");
    scientific.textContent = crop.scientific;

    select.append(name, scientific);
    select.onclick = () => selectCrop(crop);

    const saved = savedCrops.includes(crop.id);
    const bookmark = document.createElement("button");

    bookmark.type = "button";
    bookmark.className = "bookmark";
    bookmark.textContent = saved ? "★" : "☆";
    bookmark.setAttribute(
      "aria-label", `${saved ? "Unsave" : "Save"} ${crop.name}`
    );

    bookmark.onclick = () => {
      savedCrops = saved
        ? savedCrops.filter(id => id !== crop.id)
        : [...savedCrops, crop.id];

      saveStorage();
      renderLibrary();
    };

    row.append(select, bookmark);
    fragment.appendChild(row);
  }

  $("cropList").appendChild(fragment);
}

$("cropSearch").addEventListener("input", renderLibrary);

document.querySelectorAll("[data-tab]").forEach(button => {
  button.onclick = () => {
    activeTab = button.dataset.tab;
    renderLibrary();
  };
});

// -----------------------------------------------------
// Detailed crop profiles
// -----------------------------------------------------

function requirement(label, value) {
  return `
    <div class="requirement">
      <span>${escapeHTML(label)}</span>
      <strong>${escapeHTML(value)}</strong>
    </div>
  `;
}

function buildProfile(crop) {
  const riceStory = crop.id === "rice" ? `
    <h3>🌾 More than flooded paddies</h3>
    <p>
      Rice is grown in irrigated fields, rainfed lowlands,
      and upland systems. Those systems manage water differently.
      Annual rainfall alone cannot tell us which system fits a field.
    </p>
    <p>
      <a
        href="https://www.fao.org/agriculture/crops/thematic-sitemap/theme/spi/scpi-home/managing-ecosystems/sustainable-rice-systems/rice-what/en/"
        target="_blank"
        rel="noopener"
      >Read about rice growing systems · FAO</a>
    </p>
  ` : `
    <p>
      Explore the reference conditions recorded for
      <em>${escapeHTML(crop.scientific)}</em>.
      These are a starting point for research, not a complete growing guide.
    </p>
  `;

  return `
    ${riceStory}

    <h3>🌡️ Growing conditions</h3>
    <div class="requirements">
      ${requirement(
        "Preferred temperature",
        rangeText(crop.toptmin, crop.toptmax, "°C")
      )}
      ${requirement(
        "Temperature tolerance",
        rangeText(crop.tmin, crop.tmax, "°C")
      )}
      ${requirement(
        "Preferred annual rainfall",
        rangeText(crop.roptmin, crop.roptmax, "mm/year")
      )}
      ${requirement(
        "Annual rainfall tolerance",
        rangeText(crop.rmin, crop.rmax, "mm/year")
      )}
      ${requirement(
        "Preferred soil pH",
        rangeText(crop.phoptmin, crop.phoptmax)
      )}
      ${requirement(
        "Soil pH tolerance",
        rangeText(crop.phmin, crop.phmax)
      )}
    </div>

    <h3>🪨 Soil & drainage</h3>
    <p>
      <strong>Recorded texture:</strong>
      ${escapeHTML(crop.texture || "Not available")}<br>
      <strong>Recorded drainage:</strong>
      ${escapeHTML(crop.drainage || "Not available")}
    </p>
    <p class="note">
      These describe crop requirements. They are not soil measurements
      from the point you clicked.
    </p>

    <h3>🗓️ Growth-cycle reference</h3>
    <p>
      ${escapeHTML(rangeText(crop.gmin, crop.gmax, "days"))}.
      Interpretation varies between annual and perennial plants.
      This is not a guaranteed planting-to-harvest time.
    </p>

    <h3>🔎 Before choosing this crop</h3>
    <ul>
      <li>Check the local variety and planting calendar.</li>
      <li>Check seasonal rainfall and irrigation access.</li>
      <li>Test soil pH, drainage, depth, and salinity.</li>
      <li>Consider heat, frost, pests, and diseases.</li>
      <li>Ask a local agricultural specialist about field conditions.</li>
    </ul>

    <h3>🔄 Planning a rotation</h3>
    <p>
      Consider the previous crop, shared pests and diseases,
      residues, soil conditions, and water needs.
      This version does not yet calculate rotation recommendations.
    </p>

    <h3>📚 Database record</h3>
    <p>
      <strong>Family:</strong>
      ${escapeHTML(crop.family || "Not available")}<br>
      <strong>Category:</strong>
      ${escapeHTML(crop.category || "Not available")}<br>
      <strong>Lifespan:</strong>
      ${escapeHTML(crop.lifespan || "Not available")}
    </p>
    <p class="note">
      Source: FAO EcoCrop via
      <a
        href="https://github.com/OpenCLIM/ecocrop"
        target="_blank"
        rel="noopener"
      >OpenCLIM</a>.
      Missing values are left unavailable.
    </p>
  `;
}

// -----------------------------------------------------
// Reference photos with credits
// -----------------------------------------------------

const cropDialog = $("cropDialog");
const photoCache = new Map();
let photoRequest;
let photoVersion = 0;

function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function addCreditLink(parent, text, address) {
  const url = safeURL(address);
  if (!url) return;

  const link = document.createElement("a");
  link.textContent = text;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.appendChild(link);
}

function displayPhoto(photo, version, crop) {
  if (version !== photoVersion || !cropDialog.open) return;

  const image = $("profilePhoto");

  image.onload = () => {
    if (version !== photoVersion) return;
    image.hidden = false;
    $("profileIcon").hidden = true;
  };

  image.onerror = () => {
    if (version !== photoVersion) return;
    image.hidden = true;
    $("profileIcon").hidden = false;
    $("photoCredit").textContent = "Photo unavailable.";
  };

  image.alt = `${crop.scientific} — ${photo.title}`;
  image.src = photo.url;

  const credit = $("photoCredit");
  credit.replaceChildren();

  credit.appendChild(document.createTextNode(
    `${photo.verified ? "" : "Reference photo; verify identification. "}` +
    `Photo: ${photo.artist}. `
  ));

  addCreditLink(credit, "Source", photo.page);
  credit.appendChild(document.createTextNode(" · "));
  addCreditLink(credit, photo.license || "License", photo.licenseURL);
}

async function loadPhoto(crop) {
  if (photoRequest) photoRequest.abort();

  const version = ++photoVersion;
  const image = $("profilePhoto");

  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.hidden = true;

  $("profileIcon").hidden = false;
  $("photoCredit").textContent = "Loading reference photograph…";

  if (photoCache.has(crop.scientific)) {
    displayPhoto(photoCache.get(crop.scientific), version, crop);
    return;
  }

  if (crop.id === "rice") {
    const photo = {
      url:
        "https://upload.wikimedia.org/wikipedia/commons/4/4d/" +
        "Rice_plant_%28Oryza_sativa%29.jpg",
      title: "Rice plant (Oryza sativa)",
      artist: "Kalaiyarasiselvam",
      page:
        "https://commons.wikimedia.org/wiki/" +
        "File:Rice_plant_(Oryza_sativa).jpg",
      license: "CC BY-SA 4.0",
      licenseURL: "https://creativecommons.org/licenses/by-sa/4.0/",
      verified: true
    };

    photoCache.set(crop.scientific, photo);
    displayPhoto(photo, version, crop);
    return;
  }

  const request = new AbortController();
  photoRequest = request;
  const timeout = setTimeout(() => request.abort(), 18000);

  async function fetchPhotoFromClient() {
    const url = new URL("https://commons.wikimedia.org/w/api.php");

    const parameters = {
      action: "query",
      format: "json",
      origin: "*",
      generator: "search",
      gsrsearch: `"${crop.scientific}" filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "1",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "900"
    };

    Object.entries(parameters).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error("Photo request failed");

    const data = await response.json();
    const page = Object.values(data.query?.pages || {})[0];
    const info = page?.imageinfo?.[0];

    if (!info) throw new Error("No image found");

    const metadata = info.extmetadata || {};

    const photo = {
      url: safeURL(info.thumburl || info.url),
      page: safeURL(info.descriptionurl),
      title: String(page.title || "").replace(/^File:/, ""),
      artist: cleanText(metadata.Artist?.value) || "See source",
      license: cleanText(metadata.LicenseShortName?.value),
      licenseURL: metadata.LicenseUrl?.value,
      verified: false
    };

    if (!photo.url) throw new Error("Invalid image URL");
    return photo;
  }

  try {
    const dbRes = window.CropAtlasDB
      ? await window.CropAtlasDB.getOrFetchPhoto(crop.scientific, fetchPhotoFromClient)
      : { photo: await fetchPhotoFromClient(), source: "client" };

    if (version !== photoVersion) return;

    const photo = dbRes.photo;
    if (!photo || !photo.url) throw new Error("Invalid image URL");

    photoCache.set(crop.scientific, photo);
    displayPhoto(photo, version, crop);
  } catch {
    if (version !== photoVersion) return;

    $("photoCredit").textContent =
      "No photo could be loaded. Crop information is still available.";
  } finally {
    clearTimeout(timeout);
  }
}

$("cropDetailsButton").onclick = () => {
  if (!selectedCrop) return;

  $("profileName").textContent = selectedCrop.name;
  $("profileScientific").textContent = selectedCrop.scientific;
  $("profileIcon").textContent = selectedCrop.icon;
  $("profileContent").innerHTML = buildProfile(selectedCrop);

  cropDialog.showModal();
  cropDialog.scrollTop = 0;
  loadPhoto(selectedCrop);
};

cropDialog.addEventListener("close", () => {
  photoVersion++;
  if (photoRequest) photoRequest.abort();
});

// -----------------------------------------------------
// Start
// -----------------------------------------------------

initializeGlobe();
renderLibrary();
loadCatalog();
// -----------------------------------------------------
// Automatic soil information
// -----------------------------------------------------

let soilData = null;
let soilState = "idle";
let soilTimer;
let soilRequest;
let soilVersion = 0;

const soilCache = new Map();

function updateSoilAssessment() {
  const panel = $("soilAssessment");

  if (soilState === "idle") {
    panel.textContent = "Click a location to load soil estimates.";
    return;
  }

  if (soilState === "loading") {
    panel.textContent = "Loading soil estimates…";
    return;
  }

  if (soilState === "error") {
    panel.textContent =
      "Soil data could not load. Use the retry button below.";
    return;
  }

  if (!soilData) {
    panel.textContent = "Soil data unavailable.";
    return;
  }

  const anyData = ["phh2o", "sand", "silt", "clay"].some(
    key => Number.isFinite(soilData[key])
  );

  if (!anyData) {
    panel.textContent =
      "No soil estimates were returned for this point. " +
      "Try a nearby rural area. Some cities and water bodies " +
      "have no mapped soil data.";
    return;
  }

  const ph = soilData.phh2o;
  let phCard;

  if (Number.isFinite(ph) && selectedCrop) {
    const crop = selectedCrop;

    const result = compareRange(
      ph,
      crop.phmin,
      crop.phoptmin,
      crop.phoptmax,
      crop.phmax
    );

    let label = result.label;

    if (result.level === 0) {
      label = ph < crop.phmin
        ? "More acidic than the crop’s recorded range"
        : "More alkaline than the crop’s recorded range";
    }

    phCard = metricCard(
      "🪨 Estimated soil pH · in water",
      formatValue(ph, "", 1),
      { ...result, label },
      rangeText(crop.phoptmin, crop.phoptmax),
      rangeText(crop.phmin, crop.phmax)
    );
  } else {
    phCard = metricCard(
      "🪨 Estimated soil pH · in water",
      formatValue(ph, "", 1)
    );
  }

  function row(label, value) {
    return `
      <tr>
        <td>${escapeHTML(label)}</td>
        <td>${escapeHTML(formatValue(value, "%", 1))}</td>
      </tr>
    `;
  }

  const usdaClass =
    soilData.lab_texture ||
    soilData.usda_texture ||
    (window.CropAtlasDB
      ? window.CropAtlasDB.classifyUsdaTexture(soilData.sand, soilData.silt, soilData.clay)
      : "Unknown");

  panel.innerHTML = `
    ${phCard}

    <section class="metric-card">
      <h3>Estimated soil composition</h3>

      <table>
        <tbody>
          ${row("Sand", soilData.sand)}
          ${row("Silt", soilData.silt)}
          ${row("Clay", soilData.clay)}
          <tr>
            <td>USDA Texture Class</td>
            <td><strong>${escapeHTML(usdaClass)}</strong>${soilData.lab_texture ? " (Lab Override)" : ""}</td>
          </tr>
        </tbody>
      </table>

      <p class="note" style="margin:10px 0 0;">
        Percentages may differ slightly from 100% due to rounding.
        Missing values stay unavailable.
      </p>
    </section>

    <p class="note">
      Drainage: unavailable.<br>
      Total soil depth: unavailable.<br>
      Only pH is compared with crop requirements here.
      Crop suggestions remain climate-based.
    </p>
  `;
}

function resetSoilInputs() {
  clearTimeout(soilTimer);

  if (soilRequest) soilRequest.abort();

  const version = ++soilVersion;
  const location = selectedLocation;

  soilData = null;
  $("soilSource").textContent = "";
  $("retrySoil").hidden = true;

  if (!location) {
    soilState = "idle";
    updateSoilAssessment();
    return;
  }

  soilState = "loading";
  updateSoilAssessment();

  soilTimer = setTimeout(() => {
    loadSoil(location, version);
  }, 700);
}

async function fetchSoilProperty(property, location, signal) {
  const layer = `${property}_0-5cm_mean`;
  const offset = 0.005;

  const url = new URL("https://maps.isric.org/mapserv");

  const parameters = {
    map: `/map/${property}.map`,
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetFeatureInfo",
    LAYERS: layer,
    QUERY_LAYERS: layer,
    STYLES: "",
    SRS: "EPSG:4326",

    BBOX: [
      location.longitude - offset,
      location.latitude - offset,
      location.longitude + offset,
      location.latitude + offset
    ].join(","),

    WIDTH: "101",
    HEIGHT: "101",
    X: "50",
    Y: "50",
    FORMAT: "image/png",
    INFO_FORMAT: "application/geo+json",
    FEATURE_COUNT: "1"
  };

  Object.entries(parameters).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Soil service status ${response.status}`);
  }

  const text = await response.text();

  if (!text.trim()) return null;

  const data = JSON.parse(text);

  if (!Array.isArray(data.features)) {
    throw new Error("Unexpected soil response");
  }

  if (!data.features.length) return null;

  const properties = data.features[0]?.properties;
  const value = properties?.pixel_value;

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const raw = Number(value);
  const unit = String(properties.unit || "").replace(/\s/g, "");

  if (!Number.isFinite(raw) || raw < 0) return null;

  if (property === "phh2o") {
    if (unit !== "pH*10") {
      throw new Error("Unexpected soil pH units");
    }

    const ph = raw / 10;
    return ph <= 14 ? ph : null;
  }

  if (unit !== "g/kg") {
    throw new Error("Unexpected soil composition units");
  }

  const percentage = raw / 10;
  return percentage <= 100 ? percentage : null;
}

function showSoilSource(data) {
  const date = new Date(data.retrievedAt).toLocaleDateString();
  const dbNote =
    data.dbSource === "db_cache"
      ? " [Cached in database]"
      : data.dbSource === "db_saved"
        ? " [Saved to database]"
        : "";

  $("soilSource").textContent =
    "ISRIC SoilGrids · mapped mean estimates · 0–5 cm." + dbNote + " " +
    `Retrieved ${date}; this is not the soil sampling date. ` +
    (data.partial
      ? "Some properties could not load."
      : "Map update date is not supplied by this response.");
}

async function loadSoil(location, version) {
  const key =
    `${location.latitude.toFixed(5)},` +
    `${location.longitude.toFixed(5)}`;

  if (soilCache.has(key)) {
    if (version !== soilVersion) return;

    soilData = soilCache.get(key);
    soilState = "loaded";
    showSoilSource(soilData);
    updateSoilAssessment();
    return;
  }

  const request = new AbortController();
  soilRequest = request;

  const timeout = setTimeout(() => request.abort(), 30000);
  const names = ["phh2o", "sand", "silt", "clay"];

  async function fetchSoilFromClient() {
    const results = await Promise.allSettled(
      names.map(name =>
        fetchSoilProperty(name, location, request.signal)
      )
    );

    const failures = results.filter(
      result => result.status === "rejected"
    ).length;

    const fetchedSoil = Object.fromEntries(
      names.map((name, index) => [
        name,
        results[index].status === "fulfilled"
          ? results[index].value
          : null
      ])
    );

    const anyData = names.some(name =>
      Number.isFinite(fetchedSoil[name])
    );

    if (failures === names.length || (failures > 0 && !anyData)) {
      throw new Error("Soil requests failed");
    }

    fetchedSoil.retrievedAt = new Date().toISOString();
    fetchedSoil.partial = failures > 0;
    return fetchedSoil;
  }

  try {
    const dbRes = window.CropAtlasDB
      ? await window.CropAtlasDB.getOrFetchSoil(location, fetchSoilFromClient)
      : { soil: await fetchSoilFromClient(), source: "client" };

    if (version !== soilVersion) return;

    soilData = dbRes.soil;
    soilState = "loaded";

    if (!soilData.partial) soilCache.set(key, soilData);

    $("retrySoil").hidden = !soilData.partial;

    showSoilSource(soilData);
    updateSoilAssessment();
  } catch (error) {
    if (version !== soilVersion) return;

    soilData = null;
    soilState = "error";

    $("soilSource").textContent =
      "ISRIC SoilGrids · request unsuccessful.";
    $("retrySoil").hidden = false;

    if (typeof showUserError === "function") {
      showUserError(
        "Soil estimates could not load",
        "Surface soil data (0–5 cm) could not be retrieved for this location. Climate screening is still available.",
        () => resetSoilInputs()
      );
    }

    updateSoilAssessment();
    console.error("SoilGrids:", error);
  } finally {
    clearTimeout(timeout);
  }
}

$("retrySoil").onclick = resetSoilInputs;

const previousRefreshAssessment = refreshAssessment;

refreshAssessment = function () {
  previousRefreshAssessment();
  updateSoilAssessment();
};

if (selectedLocation) {
  resetSoilInputs();
} else {
  updateSoilAssessment();
}
// -----------------------------------------------------
// Next-crop exploration
// -----------------------------------------------------

const rotationDialog = $("rotationDialog");

$("openRotation").onclick = () => {
  const previousValue = $("previousCrop").value;

  $("previousCrop").replaceChildren();

  const unknown = document.createElement("option");
  unknown.value = "";
  unknown.textContent = "Unknown / no previous crop";
  $("previousCrop").appendChild(unknown);

  const sorted = [...crops].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  for (const crop of sorted) {
    const option = document.createElement("option");
    option.value = crop.id;
    option.textContent = `${crop.name} — ${crop.scientific}`;
    $("previousCrop").appendChild(option);
  }

  $("previousCrop").value = previousValue;

  $("rotationLocation").textContent = selectedLocation
    ? `Location: ${selectedLocation.name} · ` +
      `${selectedLocation.latitude.toFixed(4)}, ` +
      `${selectedLocation.longitude.toFixed(4)}`
    : "Choose a location on the map first.";

  $("rotationResults").replaceChildren();
  rotationDialog.showModal();
};

$("compareRotation").onclick = () => {
  const results = $("rotationResults");
results.replaceChildren();

// Keep the summary outside the scrolling crop list.
results.style.maxHeight = "none";
results.style.overflowY = "visible";

const summary = document.createElement("div");

const container = document.createElement("div");
container.style.cssText = `
  max-height: 480px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 6px;
`;

results.append(summary, container);
  function message(text, className = "note") {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  summary.appendChild(paragraph);
}
  if (!selectedLocation) {
    message("Close this panel and select a location first.");
    return;
  }

  if (!climate) {
    message(
      "Climate data is unavailable or still loading. " +
      "Wait for NASA data, or retry it in the location panel."
    );
    return;
  }

  const previousCrops = crops.filter(crop =>
  selectedPreviousCropIds.has(crop.id)
);

// Existing messages use this to check whether anything was selected.
const previous = previousCrops[0] || null;

  const month = $("plantingMonth").value || "ANN";
  const temperature = climate.temperature[month];
  const rainfall = climate.annualPrecipitation;

  // Soil is optional. Never substitute a guessed pH.
  const ph = soilState === "loaded" &&
    Number.isFinite(soilData?.phh2o)
      ? soilData.phh2o
      : null;

  const waterText =
    $("waterSupply").selectedOptions[0].textContent;

  const priorityText =
    $("farmerPriority").selectedOptions[0].textContent;

  message(
    `Your context: ${waterText}; priority: ${priorityText}. ` +
    "These choices do not change the ranking yet."
  );

  message(
    month === "ANN"
      ? "Screening uses annual mean temperature and annual rainfall."
      : `Screening uses ${month} average temperature and annual rainfall. ` +
        "This does not check conditions across the full growing season."
  );

  const candidates = [];

  let missingClimate = 0;
  let missingPH = 0;

  for (const crop of crops) {
    // This panel explores alternatives to the previous crop.
    if (selectedPreviousCropIds.has(crop.id)) continue;

    const temp = compareRange(
      temperature,
      crop.tmin,
      crop.toptmin,
      crop.toptmax,
      crop.tmax
    );

    const rain = compareRange(
      rainfall,
      crop.rmin,
      crop.roptmin,
      crop.roptmax,
      crop.rmax
    );

    if (temp.level === null || rain.level === null) {
      missingClimate++;
      continue;
    }

    if (temp.level === 0 || rain.level === 0) continue;

    let soilResult = null;

    if (ph !== null) {
      soilResult = compareRange(
        ph,
        crop.phmin,
        crop.phoptmin,
        crop.phoptmax,
        crop.phmax
      );

      if (soilResult.level === 0) continue;
      if (soilResult.level === null) missingPH++;
    }

    const previousFamilies = previousCrops.map(item =>
  String(item.family || "").trim().toLowerCase()
);

// Only mark the family check complete if every selected crop
// has a recorded family.
const previousFamily =
  previousFamilies.length && previousFamilies.every(Boolean)
    ? "known"
    : "";

const candidateFamily =
  String(crop.family || "").trim().toLowerCase();

const sameFamily = Boolean(
  candidateFamily && previousFamilies.includes(candidateFamily)
);

    candidates.push({
      crop,
      temp,
      rain,
      soilResult,
      sameFamily,
      familyKnown: Boolean(previousFamily && candidateFamily),
      score: temp.level + rain.level
    });
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.crop.name.localeCompare(b.crop.name)
  );

  const heading = document.createElement("h3");
  heading.textContent = "Crops to investigate";
  heading.style.marginTop = "24px";
  container.appendChild(heading);

  if (!candidates.length) {
    message(
      "No alternatives passed this limited screen with the available " +
      "data. This does not establish that no crops can grow here."
    );
  }

  for (const item of candidates) {
    const card = document.createElement("section");
    card.className = "metric-card";

    const title = document.createElement("h3");
    title.textContent = `${item.crop.icon} ${item.crop.name}`;
    card.appendChild(title);

    function line(text, className = "note") {
      const paragraph = document.createElement("p");
      paragraph.className = className;
      paragraph.textContent = text;
      card.appendChild(paragraph);
    }

    line(
      `Temperature: ${item.temp.label}.`,
      item.temp.className
    );

    line(
      `Annual rainfall: ${item.rain.label}.`,
      item.rain.className
    );

    if (ph === null) {
      line("Soil pH: not checked; location estimate unavailable.");
    } else if (item.soilResult.level === null) {
      line("Soil pH: crop reference data unavailable or needs review.");
    } else {
      line(
        `Estimated soil pH: ${item.soilResult.label}.`,
        item.soilResult.className
      );
    }

    if (!previous) {
      line("Previous crop unknown; rotation relationship not checked.");
    } else if (!item.familyKnown) {
      line("Plant family data missing; rotation relationship needs review.");
    } else if (item.sameFamily) {
      line(
        "Same recorded plant family as the previous crop. " +
        "Review shared pest and disease risks with local guidance.",
        "warning"
      );
    } else {
      line(
        "Different recorded plant family. " +
        "This alone does not establish a suitable rotation."
      );
    }

    const inspect = document.createElement("button");
    inspect.textContent = "Inspect this crop ↗";

    inspect.onclick = () => {
      selectCrop(item.crop);
      rotationDialog.close();
      $("cropDetailsButton").click();
    };

    card.appendChild(inspect);
    container.appendChild(card);
  }

  message(
    `${candidates.length} candidates found. ` +
    `${missingClimate} records lacked complete, valid climate ranges.`
  );

  if (ph !== null && missingPH) {
    message(
      `${missingPH} candidates have unverified pH compatibility ` +
      "because their pH reference ranges are missing or invalid."
    );
  }

  message(
    "Order: climate range matches, then alphabetical. " +
    "Soil pH outside recorded limits is excluded when available; " +
    "missing pH compatibility stays explicitly unknown. " +
    "These are exploration candidates, not validated rotation recommendations."
  );
};
// Keep crop results inside scrollable boxes.
for (const id of ["recommendations", "rotationResults"]) {
  const box = document.getElementById(id);

  if (box) {
    box.style.maxHeight = "480px";
    box.style.overflowY = "auto";
    box.style.overscrollBehavior = "contain";
    box.style.paddingRight = "6px";
    box.tabIndex = 0;
  }
}
// -----------------------------------------------------
// Crops grown nearby · MapSPAM 2020
// -----------------------------------------------------

const localCropSection = document.createElement("section");

localCropSection.innerHTML = `
  <h3>★ Crops grown nearby</h3>

  <p class="note">
    Ranked by estimated harvested area within this map cell.
    Reference year: 2020 · approximately 10 km resolution.
    This describes cultivation, not suitability.
  </p>

  <div id="localCropStatus" class="note" role="status">
    Select a location to load cultivation estimates.
  </div>

  <div id="localCropList" style="
    max-height: 420px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 6px;
  "></div>

  <button id="retryLocalCrops" type="button" hidden>
    Retry cultivation data
  </button>

  <p class="note">
    Source:
    <a
      href="https://cgiar-climate-data-hub.github.io/catalog/spam2020/"
      target="_blank"
      rel="noopener"
    >IFPRI MapSPAM · CGIAR Data Hub</a>.
    Covers 46 crops and crop groups.
    Missing data does not mean a crop is absent.
  </p>

  <div class="divider"></div>
`;

const recommendationBox = $("recommendations");

const heading = recommendationBox
  .previousElementSibling
  ?.previousElementSibling;

if (heading?.tagName === "H3") {
  heading.before(localCropSection);
} else {
  recommendationBox.before(localCropSection);
}

let localCropTimer;
let localCropVersion = 0;
let localCropImagePromise;

const localCropCache = new Map();

// Only map crop categories that have a clear species match.
// Broad groups such as "Other Vegetables" stay as groups.
const localCropSpecies = {
  whea: ["Triticum aestivum"],
  rice: ["Oryza sativa"],
  maiz: ["Zea mays"],
  barl: ["Hordeum vulgare"],
  pmil: ["Pennisetum glaucum", "Cenchrus americanus"],
  sorg: ["Sorghum bicolor"],
  pota: ["Solanum tuberosum"],
  swpo: ["Ipomoea batatas"],
  cass: ["Manihot esculenta"],
  chic: ["Cicer arietinum"],
  cowp: ["Vigna unguiculata"],
  pige: ["Cajanus cajan"],
  lent: ["Lens culinaris"],
  soyb: ["Glycine max"],
  grou: ["Arachis hypogaea"],
  cnut: ["Cocos nucifera"],
  oilp: ["Elaeis guineensis"],
  sunf: ["Helianthus annuus"],
  sesa: ["Sesamum indicum"],
  sugc: ["Saccharum officinarum"],
  sugb: ["Beta vulgaris"],
  coff: ["Coffea arabica"],
  rcof: ["Coffea canephora"],
  coco: ["Theobroma cacao"],
  teas: ["Camellia sinensis"],
  toma: ["Solanum lycopersicum", "Lycopersicon esculentum"],
  onio: ["Allium cepa"],
  rubb: ["Hevea brasiliensis"]
};

function loadGeoTIFFLibrary() {
  if (window.GeoTIFF) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");

    script.src =
      "https://cdn.jsdelivr.net/npm/geotiff@3.0.4/dist-browser/geotiff.js";

    script.onload = () => {
      if (window.GeoTIFF) {
        resolve();
      } else {
        reject(new Error("Map reader did not initialize"));
      }
    };

    script.onerror = () => {
      script.remove();
      reject(new Error("Could not load map reader"));
    };

    document.head.appendChild(script);
  });
}

async function getLocalCropImage() {
  if (!localCropImagePromise) {
    localCropImagePromise = (async () => {
      await loadGeoTIFFLibrary();

      const tiff = await GeoTIFF.fromUrl(
        "https://digital-atlas.s3.amazonaws.com/cdh/data/" +
        "mapspam2020-v2r2/cog/spam2020-harvested_area-all.tif",
        {
          allowFullFile: false,
          cacheSize: 50
        }
      );

      const image = await tiff.getImage();

      // Validate geographic coordinates before sampling.
      const keys = image.getGeoKeys();

      if (keys.GeographicTypeGeoKey !== 4326) {
        throw new Error("Unexpected cultivation map projection");
      }

      const metadata = [];

for (let index = 0; index < image.getSamplesPerPixel(); index++) {
  const item = await image.getGDALMetadata(index);
  metadata.push(item);
}

      if (!metadata.every(item =>
        item?.DESCRIPTION &&
        String(item.UNITTYPE).toLowerCase() === "ha"
      )) {
        throw new Error("Missing crop codes or unexpected units");
      }

      return { image, metadata };
    })().catch(error => {
      localCropImagePromise = null;
      throw error;
    });
  }

  return localCropImagePromise;
}

function renderLocalCrops(records) {
  const list = $("localCropList");
  list.replaceChildren();

  if (!records.length) {
    $("localCropStatus").textContent =
      "No positive harvested-area estimates were returned for this " +
      "cell. This does not prove crops are absent.";
    return;
  }

  $("localCropStatus").textContent =
    `${records.length} crop categories with positive estimates. ` +
    "★ marks the five largest among the available categories.";

  records.forEach((record, index) => {
    const species = localCropSpecies[record.code] || [];

    const crop = crops.find(item =>
      species.includes(item.scientific)
    );

    const card = document.createElement("section");
    card.className = "metric-card";

    const title = document.createElement("h3");
    title.textContent =
      `${index < 5 ? "★ " : ""}${record.name}`;

    const area = document.createElement("p");
    area.className = "note";
    area.textContent =
      `Estimated harvested area: ` +
      `${formatValue(record.area, "ha", 1)} · 2020`;

    card.append(title, area);

    const comparison = document.createElement("p");
    comparison.className = "note";

    if (crop && climate) {
      const result = compareCrop(crop);
      const levels = [
        result.temperature.level,
        result.rainfall.level
      ];

      if (levels.includes(0)) {
        comparison.textContent =
          "⚠ Current climate screen flags a reference-range limit. " +
          "Cultivation does not guarantee suitability.";
      } else if (levels.includes(null)) {
        comparison.textContent =
          "Climate compatibility is not fully assessed.";
      } else {
        comparison.textContent =
          "Temperature and annual rainfall pass the current " +
          "reference-range screen. Soil and season still matter.";
      }
    } else {
      comparison.textContent =
        "Not assessed against a specific crop record.";
    }

    card.appendChild(comparison);

    if (crop) {
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.textContent = "Inspect this crop ↗";

      inspect.onclick = () => {
        selectCrop(crop);
        $("cropDetailsButton").click();
      };

      card.appendChild(inspect);
    }

    list.appendChild(card);
  });
}

function scheduleLocalCrops() {
  clearTimeout(localCropTimer);

  const location = selectedLocation;
  const version = ++localCropVersion;

  $("localCropList").replaceChildren();
  $("retryLocalCrops").hidden = true;

  if (!location) {
    $("localCropStatus").textContent = "Select a location first.";
    return;
  }

  $("localCropStatus").textContent =
    "Loading cultivation estimates… The first lookup may take a while.";

  localCropTimer = setTimeout(async () => {
    try {
      const { image, metadata } = await getLocalCropImage();

      if (version !== localCropVersion) return;

      const origin = image.getOrigin();
      const resolution = image.getResolution();

      const x = Math.floor(
        (location.longitude - origin[0]) / resolution[0]
      );

      const y = Math.floor(
        (location.latitude - origin[1]) / resolution[1]
      );

      if (
        x < 0 || y < 0 ||
        x >= image.getWidth() ||
        y >= image.getHeight()
      ) {
        throw new Error("Location outside cultivation map");
      }

      const key = `${x},${y}`;

      if (localCropCache.has(key)) {
        renderLocalCrops(localCropCache.get(key));
        return;
      }

      async function fetchMapSpamCellFromClientCog() {
        // Read the selected map cell, rather than the full global map.
        const values = await image.readRasters({
          window: [x, y, x + 1, y + 1]
        });

        return metadata.map((item, index) => ({
          code: String(item.DESCRIPTION).toLowerCase().trim(),
          name: String(item.long_name || item.DESCRIPTION),
          area: Number(values[index][0])
        })).filter(item =>
          Number.isFinite(item.area) && item.area > 0
        ).sort((a, b) => b.area - a.area);
      }

      const dbRes = window.CropAtlasDB
        ? await window.CropAtlasDB.getOrFetchMapSPAM(key, location, fetchMapSpamCellFromClientCog)
        : { records: await fetchMapSpamCellFromClientCog(), source: "client" };

      if (version !== localCropVersion) return;

      const records = dbRes.records || [];
      localCropCache.set(key, records);
      renderLocalCrops(records);
      if (dbRes.source === "db_cache") {
        $("localCropStatus").textContent += " · Cached in database";
      } else if (dbRes.source === "db_saved") {
        $("localCropStatus").textContent += " · Saved to database";
      }
    } catch (error) {
      if (version !== localCropVersion) return;

      $("localCropStatus").textContent =
        "Cultivation data unavailable. No local-popularity " +
        "ranking has been assigned.";

      $("retryLocalCrops").hidden = false;
      if (typeof showUserError === "function") {
        showUserError(
          "Nearby cultivation data unavailable",
          "Could not load historical harvested-area estimates for this grid cell. You can still inspect climate and soil suitability.",
          () => scheduleLocalCrops()
        );
      }
      console.error("Local cultivation:", error);
    }
  }, 800);
}

$("retryLocalCrops").onclick = scheduleLocalCrops;

// Connect cultivation lookup to the existing map selection.
const selectLocationBeforeLocalCrops = selectLocation;

selectLocation = function (location, fly = false) {
  selectLocationBeforeLocalCrops(location, fly);
  scheduleLocalCrops();
};

// Refresh the displayed climate notes when the comparison changes.
const refreshBeforeLocalCrops = refreshAssessment;

refreshAssessment = function () {
  refreshBeforeLocalCrops();

  if (selectedLocation && $("localCropList").children.length) {
    // Reuse cached results; avoid another network lookup.
    const location = selectedLocation;

    getLocalCropImage().then(({ image }) => {
      if (location !== selectedLocation) return;

      const origin = image.getOrigin();
      const resolution = image.getResolution();

      const x = Math.floor(
        (location.longitude - origin[0]) / resolution[0]
      );

      const y = Math.floor(
        (location.latitude - origin[1]) / resolution[1]
      );

      const records = localCropCache.get(`${x},${y}`);
      if (records) renderLocalCrops(records);
    }).catch(() => {});
  }
};

if (selectedLocation) scheduleLocalCrops();
// -----------------------------------------------------
// Searchable picker for multiple previous crops
// -----------------------------------------------------

const selectedPreviousCropIds = new Set();

function renderPreviousCropPicker() {
  const tags = $("previousCropTags");
  const results = $("previousCropMatches");
  const hint = $("previousCropHint");

  tags.replaceChildren();
  results.replaceChildren();

  const selected = crops.filter(crop =>
    selectedPreviousCropIds.has(crop.id)
  );

  for (const crop of selected) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.textContent = `${crop.icon} ${crop.name} ×`;
    tag.title = `Remove ${crop.name}`;
    tag.setAttribute("aria-label", `Remove ${crop.name}`);

    tag.style.cssText = `
      padding:6px 10px;
      border-radius:20px;
      border-color:var(--accent);
      font-size:13px;
    `;

    tag.onclick = () => {
      selectedPreviousCropIds.delete(crop.id);
      $("rotationResults").replaceChildren();
      renderPreviousCropPicker();
    };

    tags.appendChild(tag);
  }

  const query = $("previousCropSearch").value
    .trim()
    .toLowerCase();

  if (!query) {
    hint.textContent = selected.length
      ? `${selected.length} previous crops selected. Search to add another.`
      : "Search to add crops. Leave empty if the crop history is unknown.";
    return;
  }

  const matches = crops.filter(crop =>
    !selectedPreviousCropIds.has(crop.id) &&
    `${crop.name} ${crop.scientific} ${crop.aliases || ""}`
      .toLowerCase()
      .includes(query)
  ).sort((a, b) => {
    // Put exact common-name matches first.
    const aExact = a.name.toLowerCase() === query;
    const bExact = b.name.toLowerCase() === query;

    return Number(bExact) - Number(aExact) ||
      a.name.localeCompare(b.name);
  });

  hint.textContent = matches.length
    ? `${matches.length} matches. Click a crop to add it.`
    : "No matching record. Try its scientific name or another spelling.";

  const fragment = document.createDocumentFragment();

  for (const crop of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";

    const name = document.createElement("strong");
    name.textContent = `${crop.icon} ${crop.name}`;

    const scientific = document.createElement("small");
    scientific.textContent = crop.scientific;

    button.append(name, scientific);

    button.onclick = () => {
      selectedPreviousCropIds.add(crop.id);
      $("previousCropSearch").value = "";
      $("rotationResults").replaceChildren();

      renderPreviousCropPicker();
      $("previousCropSearch").focus();
    };

    fragment.appendChild(button);
  }

  results.appendChild(fragment);
  results.scrollTop = 0;
}

$("previousCropSearch").addEventListener(
  "input",
  renderPreviousCropPicker
);

// Keep the existing planner-opening behavior.
const openRotationBeforeCropSearch = $("openRotation").onclick;

$("openRotation").onclick = () => {
  openRotationBeforeCropSearch();
  $("previousCropSearch").value = "";
  renderPreviousCropPicker();
};

// Clear the previous field's crop history when location changes.
const selectLocationBeforeCropHistory = selectLocation;

selectLocation = function (location, fly = false) {
  selectedPreviousCropIds.clear();
  $("previousCropSearch").value = "";
  $("rotationResults").replaceChildren();

  selectLocationBeforeCropHistory(location, fly);
  renderPreviousCropPicker();
};

renderPreviousCropPicker();


// ============================================================================
// STANDALONE REARRANGEABLE 3-WINDOW LAYOUT (DESKTOP/TABLET) & MOBILE UX
// ============================================================================

const DEFAULT_PANE_ORDER = ["library", "map", "inspector"];
const PANE_ORDER_STORAGE_KEY = "cropAtlasPaneOrder";
let paneOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PANE_ORDER_STORAGE_KEY) || "null");
    if (
      Array.isArray(saved) &&
      saved.length === 3 &&
      DEFAULT_PANE_ORDER.every(k => saved.includes(k))
    ) {
      return saved;
    }
  } catch {}
  return [...DEFAULT_PANE_ORDER];
})();

let activeMobilePane = "map";

function getPaneTrackSize(paneKey) {
  const isTablet = window.innerWidth <= 1024;
  if (paneKey === "map") return "minmax(0, 1fr)";
  if (paneKey === "library") return isTablet ? "205px" : "245px";
  return isTablet ? "295px" : "340px";
}

function applyPaneOrder() {
  const workspace = $("explorerWorkspace");
  if (!workspace) return;

  const isMobile = window.innerWidth <= 860;
  const panes = Array.from(workspace.querySelectorAll(".explorer-pane"));

  if (!isMobile) {
    workspace.style.gridTemplateColumns = paneOrder.map(getPaneTrackSize).join(" ");
  } else {
    workspace.style.gridTemplateColumns = "";
  }

  panes.forEach(pane => {
    const key = pane.dataset.pane;
    const idx = paneOrder.indexOf(key);
    pane.style.order = String(idx >= 0 ? idx : 0);

    if (!isMobile) {
      pane.style.borderLeft = "0";
      pane.style.borderRight = idx < 2 ? "1px solid var(--border)" : "0";
    } else {
      pane.style.borderLeft = "0";
      pane.style.borderRight = "0";
    }

    const leftBtn = pane.querySelector(`[data-move-pane="${key}"][data-dir="-1"]`);
    const rightBtn = pane.querySelector(`[data-move-pane="${key}"][data-dir="1"]`);
    if (leftBtn) leftBtn.disabled = idx <= 0;
    if (rightBtn) rightBtn.disabled = idx >= 2;
  });

  try {
    localStorage.setItem(PANE_ORDER_STORAGE_KEY, JSON.stringify(paneOrder));
  } catch {}

  if (viewer) {
    requestAnimationFrame(() => viewer.resize());
  }
}

function movePaneByOffset(paneKey, delta) {
  const idx = paneOrder.indexOf(paneKey);
  const nextIdx = idx + delta;
  if (idx < 0 || nextIdx < 0 || nextIdx >= paneOrder.length) return;
  const copy = [...paneOrder];
  const [moved] = copy.splice(idx, 1);
  copy.splice(nextIdx, 0, moved);
  paneOrder = copy;
  applyPaneOrder();
}

function swapOrMovePane(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const fromIdx = paneOrder.indexOf(sourceKey);
  const toIdx = paneOrder.indexOf(targetKey);
  if (fromIdx < 0 || toIdx < 0) return;
  const copy = [...paneOrder];
  [copy[fromIdx], copy[toIdx]] = [copy[toIdx], copy[fromIdx]];
  paneOrder = copy;
  applyPaneOrder();
}

document.querySelectorAll("[data-move-pane]").forEach(btn => {
  btn.onclick = event => {
    event.stopPropagation();
    movePaneByOffset(btn.dataset.movePane, Number(btn.dataset.dir));
  };
});

if ($("resetPaneLayoutBtn")) {
  $("resetPaneLayoutBtn").onclick = event => {
    event.stopPropagation();
    paneOrder = [...DEFAULT_PANE_ORDER];
    applyPaneOrder();
  };
}

let draggedPaneKey = null;

document.querySelectorAll("[data-drag-pane]").forEach(headerEl => {
  const key = headerEl.dataset.dragPane;
  const paneEl = headerEl.closest(".explorer-pane");

  headerEl.addEventListener("dragstart", event => {
    draggedPaneKey = key;
    if (paneEl) paneEl.classList.add("pane-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    }
  });

  headerEl.addEventListener("dragend", () => {
    draggedPaneKey = null;
    document.querySelectorAll(".explorer-pane").forEach(el => {
      el.classList.remove("pane-dragging", "pane-drop-target");
    });
  });
});

document.querySelectorAll(".explorer-pane").forEach(paneEl => {
  const targetKey = paneEl.dataset.pane;

  paneEl.addEventListener("dragover", event => {
    if (!draggedPaneKey || draggedPaneKey === targetKey) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    paneEl.classList.add("pane-drop-target");
  });

  paneEl.addEventListener("dragleave", event => {
    if (!paneEl.contains(event.relatedTarget)) {
      paneEl.classList.remove("pane-drop-target");
    }
  });

  paneEl.addEventListener("drop", event => {
    if (!draggedPaneKey || draggedPaneKey === targetKey) return;
    event.preventDefault();
    paneEl.classList.remove("pane-drop-target");
    swapOrMovePane(draggedPaneKey, targetKey);
  });
});

function setMobileActiveTab(tabName) {
  activeMobilePane = tabName;
  document.querySelectorAll(".explorer-pane").forEach(pane => {
    pane.classList.toggle("mobile-active-pane", pane.dataset.pane === tabName);
  });
  if (tabName === "map" && viewer) {
    requestAnimationFrame(() => viewer.resize());
  }
  document.querySelectorAll("#mobileBottomNav [data-mobile-tab]").forEach(btn => {
    btn.classList.toggle("active-mobile-tab", btn.dataset.mobileTab === activeMobilePane);
  });
}

document.querySelectorAll("#mobileBottomNav [data-mobile-tab]").forEach(btn => {
  btn.onclick = () => setMobileActiveTab(btn.dataset.mobileTab);
});

if ($("mobileInspectJumpBtn")) {
  $("mobileInspectJumpBtn").onclick = () => setMobileActiveTab("inspector");
}

const selectLocationBeforeStandaloneMobile = selectLocation;
selectLocation = function (location, fly = false) {
  selectLocationBeforeStandaloneMobile(location, fly);
  const jumpBtn = $("mobileInspectJumpBtn");
  if (jumpBtn && location) {
    jumpBtn.textContent = `📍 Inspect ${location.name || "location"} ➔`;
    jumpBtn.classList.add("visible");
  }
};

window.addEventListener("resize", applyPaneOrder);
applyPaneOrder();
