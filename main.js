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
let deviceHeading = 0; // Compass heading (0-360)
let currentStats = { signal: -100, latency: 999, provider: "Unknown" };
let lastCloudSync = 0; // Timestamp of last cloud sync
let currentFilter = "all"; // all, wifi, cellular

// Track existing signal box elements by pin index (for AR rendering)
const signalBoxElements = new Map();

// Constants
const FOV = 80; // Approximate phone camera horizontal Field of View
const MAX_Render_DIST = 100; // Show pins within 100 meters
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
  fetchISP(); // Detect Provider

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
  if (!sb) {
    console.warn("Sync skipped: Supabase not ready");
    return;
  }

  const payload = {
    lat: pin.lat,
    lon: pin.lon,
    signal: pin.signal,
    latency: pin.latency || 0,
    bandwidth: pin.bandwidth || 0,
    quality: pin.quality || 0,
    type: pin.connection || "WiFi", // Use connection as cloud 'type'
    provider: pin.provider || "Unknown", // Upload ISP
  };
  console.log("Attempting Upload to Supabase:", payload);

  try {
    const { data, error } = await sb.from("wifi_readings").insert(payload);

    if (error) {
      console.error(
        "Cloud sync error (Supabase):",
        error.message,
        error.details,
      );
    } else {
      console.log("📡 Synced to cloud (Supabase)");
    }
  } catch (e) {
    console.error("Cloud sync exception:", e);
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

    // Debug: Log the bounding box
    console.log("Fetching Query:", {
      lat: smoothedLocation.lat,
      lon: smoothedLocation.lon,
      minLat: smoothedLocation.lat - latDelta,
      maxLat: smoothedLocation.lat + latDelta,
      minLon: smoothedLocation.lon - lonDelta,
      maxLon: smoothedLocation.lon + lonDelta,
    });

    // Select ALL columns to prevent errors if specific columns are missing
    const { data, error } = await sb
      .from("wifi_readings")
      .select("*")
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
      type: r.type || "WiFi",
    }));

    // Update heatmap with cloud data
    // Update heatmap with cloud data and REFRESH PROVIDER LIST
    updateHeatmapWithCloudData(true);
    lastCloudSync = Date.now();
    cloudStatus.textContent = `${readings.length} nearby`;
    cloudStatus.style.color = "#22c55e";
    console.log(`☁️ Synced ${readings.length} community readings`);
  } else {
    cloudStatus.textContent = "0 nearby";
    cloudStatus.style.color = "#94a3b8";
  }
};

// Update heatmap to include cloud data

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

// Fetch ISP Name using ipapi.co
const fetchISP = async () => {
  try {
    const response = await fetch("https://ipapi.co/json/");
    if (response.ok) {
      const data = await response.json();
      if (data.org) {
        console.log("ISP Detected:", data.org);
        currentStats.provider = data.org;

        // Update UI
        const providerEl = document.getElementById("current-provider");
        if (providerEl) providerEl.textContent = data.org;

        // Auto-Switch Filter to this ISP
        currentFilter = data.org;
        const select = document.getElementById("isp-filter");
        if (select) {
          // Add option if missing
          let found = false;
          for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].value === data.org) found = true;
          }
          if (!found) {
            const opt = document.createElement("option");
            opt.value = data.org;
            opt.textContent = data.org;
            select.appendChild(opt);
          }
          select.value = data.org;

          // Refresh heatmap with new filter
          updateHeatmapWithCloudData(false);
        }
      }
    }
  } catch (e) {
    console.warn("ISP Fetch failed", e);
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
    // 1. Try to get real stats from Local Python Server first
    try {
      const resp = await fetch("http://localhost:5000/api/wifi-stats");
      if (resp.ok) {
        const stats = await resp.json();
        currentStats = {
          signal: stats.signal,
          latency: stats.latency,
          connection: stats.connection,
          provider: currentStats.provider || "Unknown",
          bandwidth: stats.bandwidth,
          quality: stats.quality,
        };
        console.log("Real WiFi stats acquired from Local Server");
      } else {
        throw new Error("Local server unresponsive");
      }
    } catch (localErr) {
      // 2. Fallback to Browser Estimation (for mobile or if server is down)
      const connInfo = estimateSignalFromConnection();
      const latency = (await measureLatency()) || connInfo.rtt || 50;
      currentStats = {
        signal: connInfo.signal,
        latency: latency,
        connection: connInfo.type,
        effectiveType: connInfo.effectiveType,
        provider: currentStats.provider || "Unknown",
        bandwidth: 50.0, // Default estimate
        quality: 75, // Default estimate
      };
    }

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

const dropPin = async () => {
  if (!smoothedLocation) {
    alert("Wait for GPS lock...");
    return;
  }

  const newPin = {
    lat: smoothedLocation.lat,
    lon: smoothedLocation.lon,
    signal: currentStats.signal,
    latency: currentStats.latency,
    bandwidth: currentStats.bandwidth || 0,
    quality: currentStats.quality || 0,
    connection: currentStats.connection, // WiFi or Cellular
    provider: currentStats.provider, // ISP Name
    timestamp: new Date().toISOString(),
  };

  pins.push(newPin);
  savePins();
  addMarkerToMap(newPin);
  document.getElementById("pin-count").textContent = pins.length;

  // 1. Sync to cloud (Supabase)
  syncToCloud(newPin);

  // 2. Sync to local database (Python Server)
  try {
    await fetch("http://localhost:5000/api/save-reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newPin),
    });
    console.log("📡 Synced to local database");
  } catch (e) {
    console.warn("Local sync failed (Is server.py running?)", e);
  }
};

const clearPins = () => {
  if (confirm("Remove your local pins? (Cloud data will remain)")) {
    pins = [];
    savePins();

    // Clear Map markers (Local + Cloud)
    // We clear detailed markers but then restore cloud markers via updateHeatmapWithCloudData
    if (markersLayer) markersLayer.clearLayers();

    // Also remove any rogue markers added directly to map (deprecated but safe cleanup)
    map.eachLayer((layer) => {
      if (layer instanceof L.CircleMarker && layer !== userMarker)
        map.removeLayer(layer);
    });

    // Re-add user marker
    if (userMarker) userMarker.addTo(map);

    // Refresh Map (Restores Cloud Pins & Heatmap)
    updateHeatmapWithCloudData();

    // Clear AR signal boxes
    signalBoxContainer.innerHTML = "";
    signalBoxElements.clear();
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
    let relativeAngle = getShortestAngleDiff(bearing, deviceHeading);

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
      // Standard perspective: things get smaller as they get further
      const scale = Math.max(0.4, 1 - (dist / MAX_Render_DIST) * 0.8);

      // Vertical position: Dynamic horizon
      // If perpendicular (90deg), horizon is 50%
      // Each degree of tilt shifts horizon by ~1.5% of screen height
      const tiltOffset = (deviceTilt - 90) * 1.5;
      el.style.top = `${50 + tiltOffset}%`;

      el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      el.style.zIndex = Math.floor(100 - dist);

      el.innerHTML = `
        <div style="font-size: 10px; opacity: 0.8">${pin.provider || "Unknown"}</div>
        <div class="box-dist">${dist.toFixed(1)}m</div>
        <div style="color: ${color}; font-weight: bold">${pin.signal}dBm</div>
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
    // 3D Floor Effect: Tilt it back (rotateX) then rotate to point (rotateZ)
    guideArrow.style.transform = `translate(-50%, -50%) perspective(500px) rotateX(60deg) rotateZ(${relativeAngle}deg)`;
    guideText.textContent = `Stronger Signal Detected (${bestPin.signal} dBm)`;
  } else {
    guideArrow.style.display = "none";
    guideText.textContent = "You are in a Good Zone";
  }
};

// --- 5. Sensors & Math Helpers ---

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
  // iOS Permission Check (handled lazily if needed)
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    // Note: This must be triggered by user interaction usually
  }

  // Handler for device orientation
  const handleOrientation = (e) => {
    let heading = 0;

    if (e.webkitCompassHeading) {
      // iOS - direct magnetic heading
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== null) {
      // Android
      if (e.absolute === true || e.absolute === undefined) {
        // deviceorientationabsolute or standard absolute
        heading = 360 - e.alpha;
      } else {
        // relative orientation - best guess
        heading = 360 - e.alpha;
      }
    }

    // Simple smoothing could be added here if needed
    // Apply Low-Pass Filter (Smoothing)
    // 0.8 = Very snappy (almost instant), 0.1 = Very floaty
    const smoothFactor = 0.8;
    if (Math.abs(getShortestAngleDiff(heading, deviceHeading)) > 1) {
      deviceHeading = lerpAngle(deviceHeading, heading, smoothFactor);
      // Keep in 0-360 range
      deviceHeading = (deviceHeading + 360) % 360;
    }

    // Capture Tilt (Beta) - Upright is ~90
    let currentTilt = e.beta || 90;
    // Constrain tilt to reasonable holding angles (45 to 135)
    currentTilt = Math.max(45, Math.min(135, currentTilt));

    // Smooth Tilt
    if (Math.abs(currentTilt - deviceTilt) > 1) {
      deviceTilt = deviceTilt + (currentTilt - deviceTilt) * 0.1; // Slower smoothing for tilt
    }

    // Update Map View Cone (Blue Triangle)
    if (map && smoothedLocation) {
      if (!viewCone) {
        viewCone = L.polygon([], {
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.3, // Slightly more opaque
          stroke: false, // Remove outline
        }).addTo(map);
      }

      // Calculate triangle points (30m distance - smaller)
      const center = [smoothedLocation.lat, smoothedLocation.lon];
      const dist = 30; // meters
      const angleLeft = (heading - 40) * (Math.PI / 180);
      const angleRight = (heading + 40) * (Math.PI / 180);

      // Naive projection for short distance (sufficient)
      // lat += dist * cos(angle) / 111111
      // lon += dist * sin(angle) / (111111 * cos(lat))
      const p1 = [
        smoothedLocation.lat + (dist * Math.cos(angleLeft)) / 111111,
        smoothedLocation.lon +
          (dist * Math.sin(angleLeft)) /
            (111111 * Math.cos((smoothedLocation.lat * Math.PI) / 180)),
      ];
      const p2 = [
        smoothedLocation.lat + (dist * Math.cos(angleRight)) / 111111,
        smoothedLocation.lon +
          (dist * Math.sin(angleRight)) /
            (111111 * Math.cos((smoothedLocation.lat * Math.PI) / 180)),
      ];

      viewCone.setLatLngs([center, p1, p2]);
    }
  };

  // Try to use absolute orientation first (Chrome Android)
  if ("ondeviceorientationabsolute" in window) {
    window.addEventListener("deviceorientationabsolute", handleOrientation);
  } else {
    window.addEventListener("deviceorientation", handleOrientation);
  }
};

// Shortest distance between two angles (handles 0/360 wrap)
function getShortestAngleDiff(target, current) {
  let diff = (target - current) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function lerpAngle(start, end, t) {
  const diff = getShortestAngleDiff(end, start);
  return start + diff * t;
}

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

let map, userMarker, heatLayer, markersLayer, viewCone;
let hasZoomedToUser = false; // Track if we've zoomed to user location
let deviceTilt = 90; // Default upright

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

  markersLayer = L.layerGroup().addTo(map);

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
      0.0: "red", // Bad signal - Intense Red
      0.25: "#ff6600", // Poor - Orange
      0.5: "#ffaa00", // Medium - Amber
      0.75: "#7fff00", // Good - Lime
      1.0: "#00ff88", // Excellent - Mint
    },
  }).addTo(map);

  // Initialize Map Controls
  const ispFilter = document.getElementById("isp-filter");
  if (ispFilter) {
    ispFilter.addEventListener("change", (e) => {
      currentFilter = e.target.value;
      updateHeatmapWithCloudData(false); // Don't repopulate dropdown to avoid loop
    });
  }
};

// Update heatmap to include cloud data (and populate filter options)
const updateHeatmapWithCloudData = (populateOptions = true) => {
  if (!heatLayer || !map) return;

  // Combine local and cloud pins
  const allPins = [...pins, ...cloudPins];

  if (populateOptions) {
    const providers = new Set(
      allPins.map((p) =>
        p.provider && p.provider.trim() ? p.provider : "Unknown ISP",
      ),
    );
    const select = document.getElementById("isp-filter");
    if (select) {
      // Keep "All Providers" and current selection
      const current = select.value;
      select.innerHTML = '<option value="all">Show All Networks</option>';

      providers.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        opt.style.color = "black";
        opt.style.backgroundColor = "white";
        select.appendChild(opt);
      });
      select.value = current;
    }
  }

  // Filter based on selection
  const filteredPins = allPins.filter((pin) => {
    if (currentFilter === "all") return true;
    const pName =
      pin.provider && pin.provider.trim() ? pin.provider : "Unknown ISP";
    return pName === currentFilter;
  });

  const heatData = filteredPins.map((pin) => [
    pin.lat,
    pin.lon,
    signalToIntensity(pin.signal),
  ]);

  // Update Heatmap
  heatLayer.setLatLngs(heatData);

  // Update Markers (Interactive Dots)
  if (markersLayer) {
    markersLayer.clearLayers();
    filteredPins.forEach((pin) => {
      const color = getSignalColor(pin.signal);
      const marker = L.circleMarker([pin.lat, pin.lon], {
        radius: 5,
        fillColor: color,
        color: "#fff",
        weight: 1,
        fillOpacity: 0.9,
      }).addTo(markersLayer);

      // Popup with stats
      marker.bindPopup(`
        <div style="font-size:12px; font-family:sans-serif;">
          <strong>${pin.provider || "Unknown Provider"}</strong><br/>
          Signal: <span style="color:${color}; font-weight:bold">${pin.signal} dBm</span><br/>
          Latency: ${pin.latency || "--"} ms<br/>
          ${pin.type || "WiFi"}<br/>
          <span style="color:#aaa; font-size:10px">${new Date(pin.timestamp || pin.created_at).toLocaleString()}</span>
        </div>
      `);
    });
  }

  // Update count
  const totalCount = new Set(
    filteredPins.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`),
  ).size;
  document.getElementById("pin-count").textContent = totalCount;
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

  // Update heatmap and provider list
  updateHeatmapWithCloudData(true);
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
  // Update heatmap with all pins (Cloud + Local) and refresh info
  updateHeatmapWithCloudData(true);
};

// Event Listeners
document.getElementById("drop-pin-btn").addEventListener("click", dropPin);
document.getElementById("clear-pins-btn").addEventListener("click", clearPins);

// Boot
init();
