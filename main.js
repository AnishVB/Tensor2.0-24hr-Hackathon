// AR Camera and Pin System
const videoEl = document.getElementById("camera-viewport");
const arOverlay = document.getElementById("ar-overlay");
const heatmapOverlay = document.getElementById("heatmap-overlay");
const dropPinBtn = document.getElementById("drop-pin-btn");
const clearPinsBtn = document.getElementById("clear-pins-btn");
const toggleHeatmapBtn = document.getElementById("toggle-heatmap-btn");

let pins = [];
let userLocation = null;
let map = null;
let heatmapLayer = null;
let heatmapVisible = false;
let userMarker = null;
let pinMarkers = [];
let lastTrackingLocation = null;
let autoTrackingReadings = [];
const TRACKING_DISTANCE_THRESHOLD = 3; // meters

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
    await fetch("http://localhost:5000/api/save-reading", {
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

// Start camera stream
const startCamera = async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("Camera API not supported");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "environment",
      },
      audio: false,
    });

    videoEl.srcObject = stream;
    await videoEl.play();
  } catch (error) {
    console.error("Camera access denied:", error);
    alert("Camera access required for AR mode");
  }
};

// Get network statistics from server
const getCurrentNetworkStats = async () => {
  const response = await fetch("http://localhost:5000/api/wifi-stats");
  if (!response.ok) {
    throw new Error("Server error");
  }
  const stats = await response.json();
  return {
    bandwidth: stats.bandwidth,
    latency: stats.latency,
    signal: stats.signal,
    connection: stats.connection,
    quality: stats.quality || 0,
    timestamp: stats.timestamp,
  };
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
      updateHeatmap();
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

  let stats;
  try {
    // Get real WiFi stats from server
    stats = await getCurrentNetworkStats();
  } catch (error) {
    console.warn("Could not fetch real WiFi stats:", error);
    updateNetworkStatsFailure();
    alert("Network stats fetch failed. Pin not dropped.");
    return;
  }

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
    const marker = L.marker([pin.lat, pin.lon], {
      icon: L.icon({
        iconUrl:
          "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxNiIgY3k9IjEwIiByPSI2IiBmaWxsPSIjZmYzMzY2Ii8+PHBhdGggZD0iTTE2IDEwTDEzIDI0SDE5TDE2IDEwWiIgZmlsbD0iI2ZmMzM2NiIvPjwvc3ZnPg==",
        iconSize: [32, 32],
        popupAnchor: [0, -16],
      }),
    })
      .bindPopup(
        `
      <div class="popup-content">
        <h4>Pin - ${pin.timestamp}</h4>
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

  // Add to AR overlay
  const pinEl = document.createElement("div");
  pinEl.className = "ar-pin";
  pinEl.innerHTML = `
    <div class="pin-core"></div>
    <div class="pin-label">${pins.length}</div>
  `;
  arOverlay.appendChild(pinEl);

  // Update pin count
  document.getElementById("pin-count").textContent = pins.length;

  // Update network stats
  updateNetworkStats(pin.stats);
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
  arOverlay.innerHTML = "";
  pinMarkers.forEach((marker) => map.removeLayer(marker));
  pinMarkers = [];

  document.getElementById("pin-count").textContent = "0";
  document.getElementById("bandwidth").textContent = "-- Mbps";
  document.getElementById("latency").textContent = "-- ms";
  document.getElementById("signal").textContent = "-- dBm";
  document.getElementById("connection").textContent = "--";

  updateHeatmap();
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

// Update heatmap
const updateHeatmap = () => {
  if (!heatmapVisible || !map || pins.length === 0) {
    if (heatmapLayer) {
      map.removeLayer(heatmapLayer);
    }
    return;
  }

  // Prepare heatmap data
  const heatData = pins.map((pin) => {
    // Normalize signal strength to 0-1 for heatmap intensity
    const intensity = Math.abs(pin.signal) / 100;
    return [pin.lat, pin.lon, intensity];
  });

  // Remove old heatmap
  if (heatmapLayer) {
    map.removeLayer(heatmapLayer);
  }

  // Create new heatmap
  heatmapLayer = L.heatLayer(heatData, {
    radius: 25,
    blur: 15,
    maxZoom: 1,
    gradient: {
      0.4: "blue",
      0.65: "lime",
      0.8: "yellow",
      1.0: "red",
    },
  }).addTo(map);
};

// Toggle heatmap visibility
const toggleHeatmap = () => {
  heatmapVisible = !heatmapVisible;
  toggleHeatmapBtn.classList.toggle("active", heatmapVisible);
  updateHeatmap();
};

// Animate pins in AR overlay
const animateARPins = () => {
  const pinElements = arOverlay.querySelectorAll(".ar-pin");
  pinElements.forEach((el, index) => {
    // Rotate pins
    el.style.transform = `rotate(${(index * 360) / pinElements.length}deg)`;
    // Pulse effect
    el.style.animation = `pulse 2s ease-in-out infinite`;
    el.style.animationDelay = `${index * 0.1}s`;
  });
};

// Event listeners
dropPinBtn.addEventListener("click", dropPin);
clearPinsBtn.addEventListener("click", clearAllPins);
toggleHeatmapBtn.addEventListener("click", toggleHeatmap);

// Initialize
startCamera();
initMap();
startLocationTracking();

// Update network stats periodically
setInterval(() => {
  if (pins.length > 0) {
    updateNetworkStats(pins[pins.length - 1].stats);
  }
}, 2000);

// Animate AR pins
setInterval(animateARPins, 100);
