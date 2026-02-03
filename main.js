// WiFi Vision AR - Cross-Platform Network Mapping

// State
let pins = []; // { lat, lon, signal, latency, timestamp }
let userLocation = null; // { lat, lon, accuracy }
let deviceHeading = 0; // Compass heading (0-360)
let currentStats = { signal: -100, latency: 999 };

// Track existing signal box elements by pin index (for AR rendering)
const signalBoxElements = new Map();

// Constants
const FOV = 60; // Approximate phone camera horizontal Field of View
const MAX_Render_DIST = 50; // Only show pins within 50 meters

// DOM Elements
const signalBoxContainer = document.getElementById("signal-boxes");
const guideArrow = document.getElementById("guide-arrow");
const guideText = document.getElementById("guide-text");
const loadingOverlay = document.getElementById("loading-overlay");

// --- 1. Initialization & Persistence ---

const init = async () => {
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
  if (!userLocation) {
    alert("Wait for GPS lock...");
    return;
  }

  const newPin = {
    lat: userLocation.lat,
    lon: userLocation.lon,
    signal: currentStats.signal,
    latency: currentStats.latency,
    timestamp: Date.now(),
  };

  pins.push(newPin);
  savePins();
  addMarkerToMap(newPin);
  document.getElementById("pin-count").textContent = pins.length;
};

const clearPins = () => {
  if (confirm("Clear all data?")) {
    pins = [];
    savePins();
    // Clear Map
    map.eachLayer((layer) => {
      if (layer instanceof L.CircleMarker) map.removeLayer(layer);
    });
    // Re-add user marker
    if (userMarker) userMarker.addTo(map);
    document.getElementById("pin-count").textContent = 0;
    // Clear AR signal boxes
    signalBoxContainer.innerHTML = "";
    signalBoxElements.clear();
  }
};

// --- 3. Spatial AR Logic (The "Locking") ---

const renderAR = () => {
  if (!userLocation) return;

  const visiblePins = new Set();

  pins.forEach((pin, index) => {
    // 1. Calculate Distance
    const dist = getDistanceFromLatLonInM(
      userLocation.lat,
      userLocation.lon,
      pin.lat,
      pin.lon,
    );
    if (dist > MAX_Render_DIST) return; // Too far to see

    // 2. Calculate Bearing (Angle to pin relative to North)
    const bearing = getBearing(
      userLocation.lat,
      userLocation.lon,
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
  if (pins.length < 2) {
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
      userLocation.lat,
      userLocation.lon,
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

const startLocationTracking = () => {
  navigator.geolocation.watchPosition(
    (pos) => {
      userLocation = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      document.getElementById("accuracy").textContent = Math.round(
        userLocation.accuracy,
      );

      if (userMarker && map) {
        // Add marker to map if not already added
        if (!map.hasLayer(userMarker)) {
          userMarker.addTo(map);
        }
        userMarker.setLatLng([userLocation.lat, userLocation.lon]);

        // Auto-zoom to user location on first GPS fix
        if (!hasZoomedToUser) {
          map.setView([userLocation.lat, userLocation.lon], 17);
          hasZoomedToUser = true;
        }
      }
    },
    (err) => console.error("GPS Error", err),
    { enableHighAccuracy: true, maximumAge: 0 },
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

let map, userMarker;
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
};

const addMarkerToMap = (pin) => {
  if (!map) return;
  L.circleMarker([pin.lat, pin.lon], {
    radius: 6,
    fillColor: getSignalColor(pin.signal),
    color: "#fff",
    weight: 1,
    fillOpacity: 0.8,
  }).addTo(map);
};

const updateMapMarkers = () => {
  if (!map) return;
  pins.forEach(addMarkerToMap);
};

// Event Listeners
document.getElementById("drop-pin-btn").addEventListener("click", dropPin);
document.getElementById("clear-pins-btn").addEventListener("click", clearPins);

// Boot
init();
