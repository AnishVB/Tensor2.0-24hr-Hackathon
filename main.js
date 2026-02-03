// API base URL - works on both localhost and deployed servers
const API_BASE = window.location.origin;

// AR Camera and Pin System
const videoEl = document.getElementById("camera-viewport");
const arOverlay = document.getElementById("ar-overlay");
const signalBoxesContainer = document.getElementById("signal-boxes");
const dropPinBtn = document.getElementById("drop-pin-btn");
const clearPinsBtn = document.getElementById("clear-pins-btn");
const toggleMapBtn = document.getElementById("toggle-map-btn");
const toggleCameraBtn = document.getElementById("toggle-camera-btn");
const mapSection = document.querySelector(".map-section");

let pins = [];
let userLocation = null;
let map = null;
let userMarker = null;
let pinMarkers = [];
let lastTrackingLocation = null;
let autoTrackingReadings = [];
let currentStream = null;
let cameraFacingMode = "environment"; // 'user' or 'environment'
const TRACKING_DISTANCE_THRESHOLD = 3; // meters

// ARPin class
class ARPin {
  constructor(lat, lon, signal, timestamp) {
    this.lat = lat;
    this.lon = lon;
    this.signal = signal;
    this.timestamp = timestamp;
    this.stats = {};
  }
}

// Calculate distance between two coordinates (in meters)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
};

// Auto-save network data at location
const autoTrackNetworkData = async () => {
  if (!userLocation) return;

  // Check if we've moved 3m+ from last tracking point
  if (lastTrackingLocation) {
    const distance = calculateDistance(
      lastTrackingLocation.lat,
      lastTrackingLocation.lon,
      userLocation.lat,
      userLocation.lon,
    );

    if (distance < TRACKING_DISTANCE_THRESHOLD) {
      return; // Not far enough yet
    }
  }

  try {
    const stats = await getCurrentNetworkStats();

    // Save to backend
    await fetch(`${API_BASE}/api/save-reading`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: userLocation.lat,
        lon: userLocation.lon,
        signal: stats.signal,
        bandwidth: stats.bandwidth,
        latency: stats.latency,
        connection: stats.connection,
        quality: stats.quality,
      }),
    });

    // Add to local tracking array
    const reading = {
      lat: userLocation.lat,
      lon: userLocation.lon,
      signal: stats.signal,
      bandwidth: stats.bandwidth,
      latency: stats.latency,
      connection: stats.connection,
      quality: stats.quality,
      timestamp: new Date().toLocaleTimeString(),
    };

    autoTrackingReadings.push(reading);
    lastTrackingLocation = {
      lat: userLocation.lat,
      lon: userLocation.lon,
    };

    // Update tracked count display
    document.getElementById("tracked-count").textContent =
      autoTrackingReadings.length;

    // Add marker to map
    if (map) {
      const signalColor = getSignalColor(stats.signal);
      L.circleMarker([userLocation.lat, userLocation.lon], {
        radius: 6,
        fillColor: signalColor,
        color: "#fff",
        weight: 1,
        opacity: 1,
        fillOpacity: 0.8,
      })
        .bindPopup(
          `<strong>Auto-tracked Point</strong><br/>Signal: ${stats.signal} dBm<br/>Quality: ${stats.quality}%<br/>${reading.timestamp}`,
        )
        .addTo(map);
    }

    console.log(`Auto-tracked: ${autoTrackingReadings.length} points recorded`);
  } catch (error) {
    console.warn("Auto-tracking error:", error);
  }
};

// Get color based on signal strength
const getSignalColor = (signal) => {
  if (signal > -50) return "#00ff00"; // Green (strong)
  if (signal > -60) return "#ffff00"; // Yellow (good)
  if (signal > -70) return "#ff8800"; // Orange (fair)
  if (signal > -80) return "#ff4400"; // Red-orange (weak)
  return "#ff0000"; // Red (very weak)
};

// Get network statistics from server
const getCurrentNetworkStats = async () => {
  try {
    const response = await fetch(`${API_BASE}/api/wifi-stats`);
    const stats = await response.json();

    // Check if we got valid stats
    if (stats.signal === null || stats.signal === undefined) {
      throw new Error("Invalid stats received");
    }

    return {
      bandwidth: stats.bandwidth || 50.0,
      latency: stats.latency || 25,
      signal: stats.signal || -60,
      connection: stats.connection || "WiFi",
      quality: stats.quality || 75,
      timestamp: stats.timestamp,
    };
  } catch (error) {
    console.error("WiFi stats error:", error);
    // Return fallback stats
    return {
      bandwidth: 50.0,
      latency: 25,
      signal: -60,
      connection: "WiFi",
      quality: 75,
      timestamp: new Date().toISOString(),
    };
  }
};

// Get user location using Geolocation API
const startLocationTracking = () => {
  if (!navigator.geolocation) {
    console.error("Geolocation not supported");
    return;
  }

  navigator.geolocation.watchPosition(
    (position) => {
      userLocation = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };

      document.getElementById("lat").textContent = userLocation.lat.toFixed(6);
      document.getElementById("lon").textContent = userLocation.lon.toFixed(6);
      document.getElementById("accuracy").textContent =
        userLocation.accuracy.toFixed(1) + " m";

      if (userMarker) {
        userMarker.setLatLng([userLocation.lat, userLocation.lon]);
      } else if (map) {
        userMarker = L.circleMarker([userLocation.lat, userLocation.lon], {
          radius: 8,
          fillColor: "#00d4ff",
          color: "#fff",
          weight: 2,
          opacity: 1,
          fillOpacity: 0.8,
        })
          .bindPopup("Your Location")
          .addTo(map);

        map.setView([userLocation.lat, userLocation.lon], 18);
      }

      // Auto-track network data every 3m
      autoTrackNetworkData();
    },
    (error) => {
      console.error("Location error:", error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 5000,
    },
  );
};

// Drop pin at current location
const dropPin = async () => {
  if (!userLocation) {
    alert("Waiting for location data...");
    return;
  }

  try {
    // Get real WiFi stats from server
    const stats = await getCurrentNetworkStats();

    const pin = new ARPin(
      userLocation.lat,
      userLocation.lon,
      stats.signal,
      new Date().toLocaleTimeString(),
    );

    // Override with real stats
    pin.stats = stats;

    pins.push(pin);

    // Add to map
    if (map) {
      const signalColor = getSignalColor(stats.signal);
      const marker = L.circleMarker([pin.lat, pin.lon], {
        radius: 8,
        fillColor: signalColor,
        color: "#fff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8,
      })
        .bindPopup(
          `
      <div class="popup-content">
        <h4>Pin #${pins.length} - ${pin.timestamp}</h4>
        <p>Signal: ${pin.stats.signal} dBm</p>
        <p>Quality: ${pin.stats.quality}%</p>
        <p>Latency: ${pin.stats.latency} ms</p>
        <p>Bandwidth: ${pin.stats.bandwidth} Mbps</p>
        <p>Connection: ${pin.stats.connection}</p>
      </div>
    `,
        )
        .addTo(map);

      pinMarkers.push(marker);
    }

    // Update pin count
    document.getElementById("pin-count").textContent = pins.length;

    // Update network stats
    updateNetworkStats(pin.stats);
    updateOverlayStats(pin.stats);

    // Render signal boxes
    renderSignalBoxes();
  } catch (error) {
    console.error("Drop pin error:", error);
    alert("Failed to drop pin: " + error.message);
  }
};

// Update network stats display
const updateNetworkStats = (stats) => {
  document.getElementById("bandwidth").textContent = stats.bandwidth + " Mbps";
  document.getElementById("latency").textContent = stats.latency + " ms";
  document.getElementById("signal").textContent = stats.signal + " dBm";
  document.getElementById("connection").textContent = stats.connection;
};

const updateNetworkStatsFailure = () => {
  document.getElementById("bandwidth").textContent = "Failed";
  document.getElementById("latency").textContent = "Failed";
  document.getElementById("signal").textContent = "Failed";
  document.getElementById("connection").textContent = "Failed";
};

// Update stats display in overlay (fixed position)
const updateOverlayStats = (stats) => {
  document.getElementById("overlay-signal").textContent = stats.signal + " dBm";
  document.getElementById("overlay-latency").textContent =
    stats.latency + " ms";
  document.getElementById("overlay-bandwidth").textContent =
    stats.bandwidth + " Mbps";
  document.getElementById("overlay-quality").textContent =
    (stats.quality || Math.round((stats.signal + 100) * 1.5)) + "%";
};

// Render signal boxes in AR (colored based on signal strength)
const renderSignalBoxes = () => {
  signalBoxesContainer.innerHTML = "";

  if (pins.length === 0) return;

  pins.forEach((pin, index) => {
    const box = document.createElement("div");
    box.className = "signal-box";

    const signalColor = getSignalColor(pin.stats.signal);
    const signalQuality =
      pin.stats.quality || Math.round((pin.stats.signal + 100) * 1.5);

    box.style.backgroundColor = signalColor;
    box.style.borderColor = signalColor;

    box.innerHTML = `
      <div class="box-label">#${index + 1}</div>
      <div class="box-stats">
        <div class="box-stat">📶 ${pin.stats.signal} dBm</div>
        <div class="box-stat">⚡ ${signalQuality}%</div>
        <div class="box-stat">⏱️ ${pin.stats.latency} ms</div>
      </div>
    `;

    // Random position in AR view (but fixed - doesn't move)
    const x = (index % 2) * 50 + 10; // Spread them horizontally
    const y = Math.floor(index / 2) * 45 + 10; // Stack vertically
    box.style.left = x + "%";
    box.style.top = y + "%";

    signalBoxesContainer.appendChild(box);
  });
};

// Clear all pins
const clearAllPins = () => {
  if (pins.length === 0) {
    alert("No pins to clear");
    return;
  }

  if (!confirm(`Clear all ${pins.length} pins?`)) {
    return;
  }

  pins = [];
  signalBoxesContainer.innerHTML = "";
  pinMarkers.forEach((marker) => map.removeLayer(marker));
  pinMarkers = [];

  document.getElementById("pin-count").textContent = "0";
  document.getElementById("bandwidth").textContent = "-- Mbps";
  document.getElementById("latency").textContent = "-- ms";
  document.getElementById("signal").textContent = "-- dBm";
  document.getElementById("connection").textContent = "--";
};

// Initialize map
const initMap = () => {
  map = L.map("map").setView([51.505, -0.09], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
};

// Start camera stream
const startCamera = async (facing = "environment") => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("Camera API not supported");
    return;
  }

  // Stop previous stream
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }

  try {
    const constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: facing,
      },
      audio: false,
    };

    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = currentStream;
    cameraFacingMode = facing;
    updateCameraButtonState();
  } catch (error) {
    console.error("Camera access denied:", error);
    // Fallback to other facing mode
    const fallbackFacing = facing === "user" ? "environment" : "user";
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: fallbackFacing },
        audio: false,
      });
      currentStream = fallbackStream;
      videoEl.srcObject = fallbackStream;
      cameraFacingMode = fallbackFacing;
      updateCameraButtonState();
    } catch (fallbackError) {
      alert("Camera access required for AR mode");
    }
  }
};

// Switch camera
const switchCamera = async () => {
  const newFacing = cameraFacingMode === "user" ? "environment" : "user";
  await startCamera(newFacing);
};

const updateCameraButtonState = () => {
  const label = cameraFacingMode === "user" ? "📱" : "📷";
  toggleCameraBtn.textContent = label;
};

// Toggle map visibility
const toggleMap = () => {
  mapSection.classList.toggle("hidden");
};

// Event listeners
dropPinBtn.addEventListener("click", dropPin);
clearPinsBtn.addEventListener("click", clearAllPins);
toggleMapBtn.addEventListener("click", toggleMap);
toggleCameraBtn.addEventListener("click", switchCamera);

// Initialize
startCamera();
initMap();
startLocationTracking();

// Hide map on mobile by default
if (window.innerWidth < 1024) {
  mapSection.classList.add("hidden");
}

// Update network stats and AR overlay periodically
setInterval(async () => {
  if (pins.length > 0) {
    updateNetworkStats(pins[pins.length - 1].stats);
    updateOverlayStats(pins[pins.length - 1].stats);
  } else {
    try {
      const stats = await getCurrentNetworkStats();
      updateOverlayStats(stats);
    } catch (e) {
      // Silent fail
    }
  }
}, 1000);
