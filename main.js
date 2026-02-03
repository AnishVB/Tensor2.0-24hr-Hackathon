const API_BASE = window.location.origin;

// State
let pins = []; // { lat, lon, signal, latency, timestamp }
let userLocation = null; // { lat, lon, accuracy }
let deviceHeading = 0; // Compass heading (0-360)
let currentStats = { signal: -100, latency: 999 };

// Constants
const FOV = 60; // Approximate phone camera horizontal Field of View
const MAX_Render_DIST = 50; // Only show pins within 50 meters

// DOM Elements
const signalBoxContainer = document.getElementById("signal-boxes");
const guideArrow = document.getElementById("guide-arrow");
const guideText = document.getElementById("guide-text");

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

// --- 2. Network & Data Logic ---

const updateNetworkStats = async () => {
  try {
    const res = await fetch(`${API_BASE}/api/wifi-stats`);
    const data = await res.json();
    currentStats = data;

    // Update HUD
    document.getElementById("overlay-signal").textContent =
      `${data.signal} dBm`;
    document.getElementById("overlay-latency").textContent =
      `${data.latency} ms`;

    // Colorize HUD
    const color = getSignalColor(data.signal);
    document.getElementById("overlay-signal").style.color = color;
  } catch (e) {
    console.error("Fetch stats failed", e);
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
  }
};

// --- 3. Spatial AR Logic (The "Locking") ---

const renderAR = () => {
  signalBoxContainer.innerHTML = ""; // Clear frame
  if (!userLocation) return;

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
      // 5. Create Element
      const el = document.createElement("div");
      el.className = "signal-box";
      el.style.backgroundColor = getSignalColor(pin.signal);
      el.style.borderColor = getSignalColor(pin.signal);

      // 6. Position on Screen (0% = Left, 100% = Right)
      // center (0 deg) -> 50%
      const screenX = 50 + (relativeAngle / (FOV / 2)) * 50;
      el.style.left = `${screenX}%`;

      // 7. Scale by distance (Pseudo-3D)
      // Closer = Lower on screen & Larger
      const scale = Math.max(0.5, 1 - dist / MAX_Render_DIST);
      el.style.top = `${50 + dist * 2}%`; // Simple horizon offset
      el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      el.style.zIndex = Math.floor(100 - dist); // Closer on top

      el.innerHTML = `
        <div>#${index + 1}</div>
        <div class="box-dist">${dist.toFixed(1)}m</div>
        <div>${pin.signal}dBm</div>
      `;

      signalBoxContainer.appendChild(el);
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
      if (userMarker && map)
        userMarker.setLatLng([userLocation.lat, userLocation.lon]);
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
  if (dbm > -50) return "#00ff00"; // Green
  if (dbm > -70) return "#ffff00"; // Yellow
  if (dbm > -85) return "#ff8800"; // Orange
  return "#ff0000"; // Red
}

// --- 6. Camera & Map Setup ---

const startCamera = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    document.getElementById("camera-viewport").srcObject = stream;
  } catch (e) {
    alert("Camera Access Denied");
  }
};

let map, userMarker;
const initMap = () => {
  map = L.map("map").setView([0, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(map);
  userMarker = L.circleMarker([0, 0], { radius: 5, color: "#00f3ff" }).addTo(
    map,
  );
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
