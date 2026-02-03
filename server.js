const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { promisify } = require("util");

const app = express();
const execAsync = promisify(exec);

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// Get current WiFi stats
app.get("/api/wifi-stats", async (req, res) => {
  try {
    const stats = await getRealWiFiStats();
    res.json(stats);
  } catch (error) {
    console.error("Error getting WiFi stats:", error);
    res.status(500).json({
      bandwidth: "0",
      latency: 0,
      signal: -100,
      connection: "Error",
      error: error.message,
    });
  }
});

// Get WiFi networks in range
app.get("/api/wifi-networks", async (req, res) => {
  try {
    const networks = await getAvailableNetworks();
    res.json(networks);
  } catch (error) {
    console.error("Error getting WiFi networks:", error);
    res.status(500).json({ error: error.message });
  }
});

// Ping latency test
app.get("/api/ping", async (req, res) => {
  try {
    const host = req.query.host || "8.8.8.8";
    const latency = await pingHost(host);
    res.json({ latency, host });
  } catch (error) {
    console.error("Ping error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get real WiFi statistics
async function getRealWiFiStats() {
  // For Windows - get WiFi interface info
  const { stdout } = await execAsync("netsh wlan show interfaces");
  const connectionInfo = parseWiFiInterface(stdout);

  // Get latency
  const latency = await pingHost("8.8.8.8");

  // Estimate bandwidth from signal strength
  const signal = connectionInfo.signal || -70;
  const bandwidth = estimateBandwidth(signal);

  return {
    bandwidth: bandwidth.toFixed(1),
    latency: Math.round(latency),
    signal: signal,
    connection: connectionInfo.ssid || "Unknown",
    quality: connectionInfo.quality || 0,
    timestamp: new Date().toISOString(),
  };
}

// Parse WiFi interface output from netsh command
function parseWiFiInterface(output) {
  const lines = output.split("\n");
  const result = {
    ssid: "Unknown",
    signal: -70,
    quality: 0,
  };

  for (let line of lines) {
    if (line.includes("SSID")) {
      const match = line.match(/:\s*(.+?)$/);
      if (match) result.ssid = match[1].trim();
    }
    if (line.includes("Signal")) {
      const match = line.match(/:\s*(\d+)%/);
      if (match) {
        const quality = parseInt(match[1]);
        result.quality = quality;
        // Convert quality percentage to dBm (rough estimation)
        result.signal = Math.round(-100 + (quality / 100) * 40);
      }
    }
    if (line.includes("Channel")) {
      const match = line.match(/:\s*(\d+)/);
      if (match) result.channel = match[1];
    }
  }

  return result;
}

// Get available WiFi networks
async function getAvailableNetworks() {
  try {
    const { stdout } = await execAsync("netsh wlan show networks");
    const networks = parseNetworks(stdout);
    return networks;
  } catch (error) {
    return [];
  }
}

function parseNetworks(output) {
  const networks = [];
  const lines = output.split("\n");
  let currentNetwork = {};

  for (let line of lines) {
    if (line.includes("SSID")) {
      const match = line.match(/:\s*(.+?)$/);
      if (match) {
        if (currentNetwork.ssid) networks.push(currentNetwork);
        currentNetwork = { ssid: match[1].trim() };
      }
    }
    if (line.includes("Authentication")) {
      const match = line.match(/:\s*(.+?)$/);
      if (match) currentNetwork.auth = match[1].trim();
    }
  }

  if (currentNetwork.ssid) networks.push(currentNetwork);
  return networks;
}

// Ping a host to get latency
async function pingHost(host) {
  const start = Date.now();
  await execAsync(`ping -n 1 ${host}`, { timeout: 5000 });
  const latency = Date.now() - start;
  return latency;
}

// Estimate bandwidth from signal strength (simplified model)
function estimateBandwidth(signal) {
  // Better signal = higher bandwidth
  // Signal: -30 to -90 dBm typical range
  if (signal > -50) return Math.random() * 50 + 150; // Strong signal: 150-200 Mbps
  if (signal > -60) return Math.random() * 50 + 100; // Good signal: 100-150 Mbps
  if (signal > -70) return Math.random() * 30 + 50; // Fair signal: 50-80 Mbps
  if (signal > -80) return Math.random() * 20 + 20; // Weak signal: 20-40 Mbps
  return Math.random() * 10 + 5; // Very weak: 5-15 Mbps
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WiFi Vision AR server running at http://localhost:${PORT}`);
});
