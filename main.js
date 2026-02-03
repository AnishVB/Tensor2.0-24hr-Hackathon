// WiFi Vision AR - Cross-Platform Network Mapping

// Supabase Configuration
const SUPABASE_URL = "https://dimipsvkjuyctqeohkri.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpbWlwc3ZranV5Y3RxZW9oa3JpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMjE1NjAsImV4cCI6MjA4NTY5NzU2MH0._JpbddtuHlvN9_gxF_gzevPn53A10Idp2y0eg6lvq2U";

// Lazy-load supabase client to avoid blocking errors
let supabaseClient = null;
const getSupabase = () => {
  if (!supabaseClient && window.supabase) {
    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
    );
  }
  return supabaseClient;
};

// State
let pins = []; // Local pins (for AR rendering)
let cloudPins = []; // All pins from cloud (for heatmap)
let userLocation = null; // { lat, lon, accuracy }
let smoothedLocation = null; // Kalman-filtered location
let lastAutoPinLocation = null; // Last location where we auto-dropped a pin
let deviceHeading = 0; // Compass heading (0-360)
let currentStats = { signal: -100, latency: 999 };
let lastCloudSync = 0; // Timestamp of last cloud sync

// Track existing signal box elements by pin index (for AR rendering)
const signalBoxElements = new Map();

// Constants
const FOV = 60; // Approximate phone camera horizontal Field of View
const MAX_Render_DIST = 100; // Show pins within 100 meters
const AUTO_PIN_DISTANCE = 3; // Auto-drop pin every 3 meters
const MIN_ACCURACY_FOR_PIN = 20; // Only auto-drop if accuracy < 20m
const CLOUD_SYNC_INTERVAL = 10000; // Sync cloud data every 10 seconds
const NEARBY_RADIUS_KM = 1; // Fetch readings within 1km

// Kalman Filter for GPS smoothing
class GPSKalmanFilter {
  constructor() {
    this.lat = null;
    this.lon = null;
    this.variance = -1; // Negative means uninitialized
    this.minAccuracy = 1; // Minimum accuracy in meters
  }

  process(lat, lon, accuracy) {
    if (accuracy < this.minAccuracy) accuracy = this.minAccuracy;

    if (this.variance < 0) {
      // First reading
      this.lat = lat;
      this.lon = lon;
      this.variance = accuracy * accuracy;
    } else {
      // Kalman gain
      const k = this.variance / (this.variance + accuracy * accuracy);

      // Update estimates
      this.lat += k * (lat - this.lat);
      this.lon += k * (lon - this.lon);
      this.variance = (1 - k) * this.variance;
    }

    return { lat: this.lat, lon: this.lon, variance: Math.sqrt(this.variance) };
  }
}

const gpsFilter = new GPSKalmanFilter();

// DOM Elements
const signalBoxContainer = document.getElementById("signal-boxes");
const guideArrow = document.getElementById("guide-arrow");
const guideText = document.getElementById("guide-text");
const loadingOverlay = document.getElementById("loading-overlay");

// --- 1. Initialization & Persistence ---

const init = async () => {
  // Safety: hide loading after 5s no matter what
  setTimeout(() => {
    if (loadingOverlay) loadingOverlay.classList.add("hidden");
  }, 5000);

  startCamera();
  initMap();
  loadPins(); // Load from LocalStorage

  // Start Sensors
  startLocationTracking();
  startCompass();

  // Start Data Loop
  setInterval(updateNetworkStats, 2000); // Ping every 2s
  setInterval(renderAR, 50); // High FPS AR loop
  setInterval(updateAgentGuide, 1000); // Agent logic every 1s
  setInterval(syncCloudData, CLOUD_SYNC_INTERVAL); // Sync cloud data periodically

  // Initial cloud sync after a short delay (wait for GPS)
  setTimeout(syncCloudData, 3000);
};

// --- Cloud Sync Functions ---

// Upload a reading to the cloud
const syncToCloud = async (pin) => {
  const sb = getSupabase();
  if (!sb) return; // Supabase not loaded yet

  try {
    const { error } = await sb.from("wifi_readings").insert({
      lat: pin.lat,
      lon: pin.lon,
      signal: pin.signal,
      latency: pin.latency || 0,
    });

    if (error) {
      console.error("Cloud sync error:", error);
    } else {
      console.log("📡 Synced to cloud");
    }
  } catch (e) {
    console.error("Cloud sync failed:", e);
  }
};

// Fetch nearby readings from all users
const fetchNearbyReadings = async () => {
  const sb = getSupabase();
  if (!smoothedLocation || !sb) return [];

  try {
    // Calculate bounding box for nearby readings
    const latDelta = NEARBY_RADIUS_KM / 111; // ~111km per degree latitude
    const lonDelta =
      NEARBY_RADIUS_KM /
      (111 * Math.cos((smoothedLocation.lat * Math.PI) / 180));

    const { data, error } = await sb
      .from("wifi_readings")
      .select("lat, lon, signal, latency, created_at")
      .gte("lat", smoothedLocation.lat - latDelta)
      .lte("lat", smoothedLocation.lat + latDelta)
      .gte("lon", smoothedLocation.lon - lonDelta)
      .lte("lon", smoothedLocation.lon + lonDelta)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("Fetch error:", error);
      return [];
    }

    return data || [];
  } catch (e) {
    console.error("Fetch failed:", e);
    return [];
  }
};

// Periodic sync - fetch community data and update heatmap
const syncCloudData = async () => {
  const readings = await fetchNearbyReadings();

  const cloudStatus = document.getElementById("cloud-status");

  if (readings.length > 0) {
    cloudPins = readings.map((r) => ({
      lat: r.lat,
      lon: r.lon,
      signal: r.signal,
      latency: r.latency,
    }));

    // Update heatmap with cloud data
    updateHeatmapWithCloudData();
    lastCloudSync = Date.now();
    cloudStatus.textContent = `${readings.length} nearby`;
    cloudStatus.style.color = "#22c55e";
    console.log(`☁️ Synced ${readings.length} community readings`);
  } else {
    cloudStatus.textContent = "No data";
    cloudStatus.style.color = "#94a3b8";
  }
};

// Update heatmap to include cloud data
const updateHeatmapWithCloudData = () => {
  if (!heatLayer || !map) return;

  // Combine local and cloud pins for heatmap
  const allPins = [...pins, ...cloudPins];

  const heatData = allPins.map((pin) => [
    pin.lat,
    pin.lon,
    signalToIntensity(pin.signal),
  ]);

  heatLayer.setLatLngs(heatData);

  // Update community pin count
  const totalCount = new Set(
    allPins.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`),
  ).size;
  document.getElementById("pin-count").textContent = totalCount;
};

const loadPins = () => {
  const saved = localStorage.getItem("wifi_vision_pins");
  if (saved) {
    pins = JSON.parse(saved);
    updateMapMarkers();
    document.getElementById("pin-count").textContent = pins.length;
  }
};

const savePins = () => {
  localStorage.setItem("wifi_vision_pins", JSON.stringify(pins));
};

// --- 2. Network & Data Logic (Cross-Platform) ---

// Measure real latency by fetching a small resource
const measureLatency = async () => {
  try {
    const start = performance.now();
    // Fetch a tiny resource with cache busting
    await fetch("https://www.google.com/favicon.ico", {
      mode: "no-cors",
      cache: "no-store",
    });
    const latency = Math.round(performance.now() - start);
    return Math.min(latency, 999); // Cap at 999ms
  } catch {
    return null;
  }
};

// Estimate signal strength from connection info
const estimateSignalFromConnection = () => {
  const connection =
    navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;

  if (!connection) {
    // Fallback: use a reasonable default
    return { signal: -65, type: "WiFi" };
  }

  const effectiveType = connection.effectiveType || "4g";
  const rtt = connection.rtt || 100;
  const downlink = connection.downlink || 10;

  // Estimate signal based on effective connection type and RTT
  let signal;
  let type = connection.type || "wifi";

  // Convert connection type to display name
  const typeNames = {
    wifi: "WiFi",
    cellular: "4G/LTE",
    ethernet: "Ethernet",
    none: "Offline",
    unknown: "Unknown",
  };

  // Estimate dBm from effective type and RTT
  if (effectiveType === "4g" && rtt < 100) {
    signal = -50 + Math.floor(Math.random() * 10); // Excellent: -50 to -40
  } else if (effectiveType === "4g") {
    signal = -65 + Math.floor(Math.random() * 10); // Good: -65 to -55
  } else if (effectiveType === "3g") {
    signal = -75 + Math.floor(Math.random() * 5); // Medium: -75 to -70
  } else if (effectiveType === "2g") {
    signal = -85 + Math.floor(Math.random() * 5); // Poor: -85 to -80
  } else {
    signal = -90; // Slow/Bad
  }

  // Adjust based on downlink speed
  if (downlink > 50) signal = Math.min(signal + 10, -40);
  else if (downlink < 1) signal = Math.max(signal - 10, -95);

  return {
    signal,
    type: typeNames[type] || "WiFi",
    effectiveType,
    downlink,
    rtt: connection.rtt,
  };
};

const updateNetworkStats = async () => {
  try {
    // Get connection info (works on all platforms)
    const connInfo = estimateSignalFromConnection();

    // Measure real latency
    const latency = await measureLatency();

    currentStats = {
      signal: connInfo.signal,
      latency: latency || connInfo.rtt || 50,
      connection: connInfo.type,
      effectiveType: connInfo.effectiveType,
    };

    // Update HUD
    document.getElementById("overlay-signal").textContent =
      `${currentStats.signal} dBm`;
    document.getElementById("overlay-latency").textContent =
      `${currentStats.latency} ms`;

    // Colorize HUD based on signal
    const color = getSignalColor(currentStats.signal);
    document.getElementById("overlay-signal").style.color = color;
  } catch (e) {
    console.error("Stats update failed", e);
  }
};

const dropPin = () => {
  if (!smoothedLocation) {
    alert("Wait for GPS lock...");
    return;
  }

  const newPin = {
    lat: smoothedLocation.lat,
    lon: smoothedLocation.lon,
    signal: currentStats.signal,
    latency: currentStats.latency,
    timestamp: Date.now(),
  };

  pins.push(newPin);
  savePins();
  addMarkerToMap(newPin);
  document.getElementById("pin-count").textContent = pins.length;

  // Sync to cloud for other users to see
  syncToCloud(newPin);

  // Update last auto-pin location to prevent immediate auto-drop
  lastAutoPinLocation = {
    lat: smoothedLocation.lat,
    lon: smoothedLocation.lon,
  };
};

const clearPins = () => {
  if (confirm("Clear all data?")) {
    pins = [];
    savePins();
    // Clear Map markers
    map.eachLayer((layer) => {
      if (layer instanceof L.CircleMarker) map.removeLayer(layer);
    });
    // Re-add user marker
    if (userMarker) userMarker.addTo(map);
    // Clear heatmap
    if (heatLayer) heatLayer.setLatLngs([]);
    document.getElementById("pin-count").textContent = 0;
    // Clear AR signal boxes
    signalBoxContainer.innerHTML = "";
    signalBoxElements.clear();
    // Reset auto-pin tracking
    lastAutoPinLocation = null;
  }
};

// --- 3. Spatial AR Logic (The "Locking") ---

const renderAR = () => {
  if (!smoothedLocation) return;

  const visiblePins = new Set();

  pins.forEach((pin, index) => {
    // 1. Calculate Distance using smoothed location
    const dist = getDistanceFromLatLonInM(
      smoothedLocation.lat,
      smoothedLocation.lon,
      pin.lat,
      pin.lon,
    );
    if (dist > MAX_Render_DIST) return; // Too far to see

    // 2. Calculate Bearing (Angle to pin relative to North)
    const bearing = getBearing(
      smoothedLocation.lat,
      smoothedLocation.lon,
      pin.lat,
      pin.lon,
    );

    // 3. Calculate Relative Angle (Where is it relative to phone camera?)
    let relativeAngle = bearing - deviceHeading;
    // Normalize to -180 to 180
    while (relativeAngle < -180) relativeAngle += 360;
    while (relativeAngle > 180) relativeAngle -= 360;

    // 4. Check if in FOV (Is it on screen?)
    if (Math.abs(relativeAngle) < FOV / 2) {
      visiblePins.add(index);

      // 5. Get or create element
      let el = signalBoxElements.get(index);
      if (!el) {
        el = document.createElement("div");
        el.className = "signal-box";
        el.dataset.pinIndex = index;
        signalBoxContainer.appendChild(el);
        signalBoxElements.set(index, el);
      }

      // 6. Update styling
      const color = getSignalColor(pin.signal);
      el.style.borderLeftColor = color;
      el.style.borderLeftWidth = "3px";

      // 7. Position on Screen (0% = Left, 100% = Right)
      const screenX = 50 + (relativeAngle / (FOV / 2)) * 50;
      el.style.left = `${screenX}%`;

      // 8. Scale by distance (Pseudo-3D)
      const scale = Math.max(0.6, 1 - dist / MAX_Render_DIST);
      el.style.top = `${40 + dist * 1.5}%`;
      el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      el.style.zIndex = Math.floor(100 - dist);

      el.innerHTML = `
        <div>#${index + 1}</div>
        <div class="box-dist">${dist.toFixed(1)}m</div>
        <div style="color: ${color}">${pin.signal}dBm</div>
      `;
    }
  });

  // Remove elements for pins no longer visible
  signalBoxElements.forEach((el, index) => {
    if (!visiblePins.has(index)) {
      el.remove();
      signalBoxElements.delete(index);
    }
  });
};

// --- 4. Agentic Navigation (The "Direction") ---

const updateAgentGuide = () => {
  if (pins.length < 2 || !smoothedLocation) {
    guideArrow.style.display = "none";
    guideText.textContent = "";
    return;
  }

  // Find Best Signal Pin
  const bestPin = pins.reduce((prev, curr) =>
    prev.signal > curr.signal ? prev : curr,
  );

  // If current signal is much worse than best pin (> 5dB difference)
  if (currentStats.signal < bestPin.signal - 5) {
    const bearingToBest = getBearing(
      smoothedLocation.lat,
      smoothedLocation.lon,
      bestPin.lat,
      bestPin.lon,
    );
    let relativeAngle = bearingToBest - deviceHeading;

    guideArrow.style.display = "block";
    guideArrow.style.transform = `translate(-50%, -50%) rotate(${relativeAngle}deg)`;
    guideText.textContent = `Stronger Signal Detected (${bestPin.signal} dBm)`;
  } else {
    guideArrow.style.display = "none";
    guideText.textContent = "You are in a Good Zone";
  }
};

// --- 5. Sensors & Math Helpers ---

// Auto-drop a pin at current location
const autoDropPin = () => {
  if (!smoothedLocation) return;

  const newPin = {
    lat: smoothedLocation.lat,
    lon: smoothedLocation.lon,
    signal: currentStats.signal,
    latency: currentStats.latency,
    timestamp: Date.now(),
    auto: true, // Mark as auto-dropped
  };

  pins.push(newPin);
  savePins();
  addMarkerToMap(newPin);
  document.getElementById("pin-count").textContent = pins.length;

  // Sync to cloud for other users to see
  syncToCloud(newPin);

  // Update last auto-pin location
  lastAutoPinLocation = {
    lat: smoothedLocation.lat,
    lon: smoothedLocation.lon,
  };
};

// Check if we should auto-drop a pin
const checkAutoDrop = () => {
  const autoStatus = document.getElementById("auto-status");

  if (!smoothedLocation) {
    autoStatus.textContent = "WAIT";
    autoStatus.style.color = "#f59e0b";
    return;
  }

  if (userLocation.accuracy > MIN_ACCURACY_FOR_PIN) {
    // Skip if accuracy is poor
    autoStatus.textContent = "LOW ACC";
    autoStatus.style.color = "#ef4444";
    return;
  }

  autoStatus.textContent = "ON";
  autoStatus.style.color = "#22c55e";

  if (!lastAutoPinLocation) {
    // First pin
    autoDropPin();
    return;
  }

  // Calculate distance from last auto-pin
  const dist = getDistanceFromLatLonInM(
    lastAutoPinLocation.lat,
    lastAutoPinLocation.lon,
    smoothedLocation.lat,
    smoothedLocation.lon,
  );

  if (dist >= AUTO_PIN_DISTANCE) {
    autoDropPin();
  }
};

const startLocationTracking = () => {
  navigator.geolocation.watchPosition(
    (pos) => {
      const rawLat = pos.coords.latitude;
      const rawLon = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      // Apply Kalman filter for smoothing
      const filtered = gpsFilter.process(rawLat, rawLon, accuracy);

      // Store raw location
      userLocation = {
        lat: rawLat,
        lon: rawLon,
        accuracy: accuracy,
      };

      // Use smoothed location for AR
      smoothedLocation = {
        lat: filtered.lat,
        lon: filtered.lon,
        accuracy: filtered.variance,
      };

      // Update accuracy display with color coding
      const accDisplay = document.getElementById("accuracy");
      accDisplay.textContent = Math.round(accuracy);
      if (accuracy <= 5) {
        accDisplay.style.color = "#22c55e"; // Green - excellent
      } else if (accuracy <= 15) {
        accDisplay.style.color = "#f59e0b"; // Amber - okay
      } else {
        accDisplay.style.color = "#ef4444"; // Red - poor
      }

      if (userMarker && map) {
        // Add marker to map if not already added
        if (!map.hasLayer(userMarker)) {
          userMarker.addTo(map);
        }
        // Use smoothed location for marker
        userMarker.setLatLng([smoothedLocation.lat, smoothedLocation.lon]);

        // Auto-zoom to user location on first GPS fix
        if (!hasZoomedToUser) {
          map.setView([smoothedLocation.lat, smoothedLocation.lon], 18); // Zoom level 18 for street detail
          hasZoomedToUser = true;
        }
      }

      // Check if we should auto-drop a pin
      checkAutoDrop();
    },
    (err) => {
      console.error("GPS Error", err);
      // Show error to user
      document.getElementById("accuracy").textContent = "ERR";
      document.getElementById("accuracy").style.color = "#ef4444";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    },
  );
};

const startCompass = () => {
  // iOS Permission Check
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    // Need a button click to trigger this on iOS, usually handled in init UI
  }

  window.addEventListener("deviceorientation", (e) => {
    // Android (alpha is compass) vs iOS (webkitCompassHeading)
    if (e.webkitCompassHeading) {
      deviceHeading = e.webkitCompassHeading;
    } else if (e.alpha) {
      deviceHeading = 360 - e.alpha; // Android is counter-clockwise
    }
  });
};

// Haversine Distance
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Bearing Formula
function getBearing(startLat, startLng, destLat, destLng) {
  startLat = deg2rad(startLat);
  startLng = deg2rad(startLng);
  destLat = deg2rad(destLat);
  destLng = deg2rad(destLng);

  const y = Math.sin(destLng - startLng) * Math.cos(destLat);
  const x =
    Math.cos(startLat) * Math.sin(destLat) -
    Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
  let brng = Math.atan2(y, x);
  brng = rad2deg(brng);
  return (brng + 360) % 360;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}
function rad2deg(rad) {
  return rad * (180 / Math.PI);
}

function getSignalColor(dbm) {
  if (dbm > -50) return "#00ff88"; // Excellent - Mint
  if (dbm > -60) return "#7fff00"; // Good - Lime
  if (dbm > -70) return "#ffaa00"; // Medium - Amber
  if (dbm > -80) return "#ff6600"; // Poor - Orange
  return "#ff3366"; // Bad - Red/Pink
}

// --- 6. Camera & Map Setup ---

const startCamera = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    document.getElementById("camera-viewport").srcObject = stream;
    // Hide loading overlay after camera starts
    setTimeout(() => {
      if (loadingOverlay) loadingOverlay.classList.add("hidden");
    }, 1000);
  } catch (e) {
    alert("Camera Access Denied");
    if (loadingOverlay) loadingOverlay.classList.add("hidden");
  }
};

let map, userMarker, heatLayer;
let hasZoomedToUser = false; // Track if we've zoomed to user location

const initMap = () => {
  map = L.map("map", {
    zoomControl: false, // Cleaner look without zoom buttons
  }).setView([20, 78], 4); // Default view over India

  // CartoDB Voyager - cleaner, more modern tiles
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    },
  ).addTo(map);

  // User marker - initially hidden until we get GPS
  userMarker = L.circleMarker([0, 0], {
    radius: 8,
    color: "#0ea5e9",
    fillColor: "#0ea5e9",
    fillOpacity: 0.3,
    weight: 2,
  });
  // Don't add to map yet - will add when we have location

  // Initialize empty heatmap layer
  heatLayer = L.heatLayer([], {
    radius: 25,
    blur: 15,
    maxZoom: 18,
    max: 1.0,
    gradient: {
      0.0: "#ff3366", // Bad signal - red
      0.25: "#ff6600", // Poor - orange
      0.5: "#ffaa00", // Medium - amber
      0.75: "#7fff00", // Good - lime
      1.0: "#00ff88", // Excellent - mint
    },
  }).addTo(map);
};

// Convert signal dBm to heatmap intensity (0-1)
const signalToIntensity = (dbm) => {
  // -90 dBm = 0 (worst), -40 dBm = 1 (best)
  const normalized = (dbm + 90) / 50;
  return Math.max(0, Math.min(1, normalized));
};

// Update heatmap with current pins
const updateHeatmap = () => {
  if (!heatLayer || !map) return;

  const heatData = pins.map((pin) => [
    pin.lat,
    pin.lon,
    signalToIntensity(pin.signal),
  ]);

  heatLayer.setLatLngs(heatData);
};

const addMarkerToMap = (pin) => {
  if (!map) return;
  L.circleMarker([pin.lat, pin.lon], {
    radius: 4,
    fillColor: getSignalColor(pin.signal),
    color: "#fff",
    weight: 1,
    fillOpacity: 0.9,
  }).addTo(map);

  // Update heatmap
  updateHeatmap();
};

const updateMapMarkers = () => {
  if (!map) return;
  pins.forEach((pin) => {
    L.circleMarker([pin.lat, pin.lon], {
      radius: 4,
      fillColor: getSignalColor(pin.signal),
      color: "#fff",
      weight: 1,
      fillOpacity: 0.9,
    }).addTo(map);
  });
  // Update heatmap with all pins
  updateHeatmap();
};

// Event Listeners
document.getElementById("drop-pin-btn").addEventListener("click", dropPin);
document.getElementById("clear-pins-btn").addEventListener("click", clearPins);

// Boot
init();
