const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { promisify } = require("util");

const app = express();
const execAsync = promisify(exec);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- API Endpoints ---

// 1. Get Network Stats (Hybrid: Hardware or Ping)
app.get("/api/wifi-stats", async (req, res) => {
  try {
    // Attempt to get hardware stats (Windows Only)
    let hardwareStats = {};
    try {
      if (process.platform === "win32") {
        const { stdout } = await execAsync("netsh wlan show interfaces");
        hardwareStats = parseWiFiInterface(stdout);
      }
    } catch (e) {
      // Ignore hardware errors on non-Windows/Mobile
    }

    // Always run a real latency test (The "Truth")
    const latency = await pingHost("8.8.8.8");

    // Logic: If we have hardware signal, use it. If not, estimate from latency.
    // Latency < 30ms ~= Strong Signal (-50dBm)
    // Latency > 150ms ~= Weak Signal (-90dBm)
    const derivedSignal =
      hardwareStats.signal || Math.max(-90, -50 - (latency - 30) / 2);

    const stats = {
      bandwidth: estimateBandwidth(derivedSignal),
      latency: Math.round(latency),
      signal: Math.round(derivedSignal),
      connection: hardwareStats.ssid || "Mobile/Unknown",
      quality: hardwareStats.quality || Math.max(0, 100 - latency / 2),
      timestamp: new Date().toISOString(),
    };

    res.json(stats);
  } catch (error) {
    console.error("Stats Error:", error);
    // Emergency Fallback so app never crashes
    res.json({
      bandwidth: "5.0",
      latency: 999,
      signal: -100,
      connection: "Offline",
      quality: 0,
    });
  }
});

// 2. Simple Ping (For pure latency checks)
app.get("/api/ping", async (req, res) => {
  const start = Date.now();
  try {
    await execAsync("ping -c 1 8.8.8.8").catch(() => {}); // Linux/Mac
    // Windows fallback happens automatically or use a library
  } catch (e) {}
  res.json({ latency: Date.now() - start });
});

// 3. Save Reading (Stub for Database)
app.post("/api/save-reading", (req, res) => {
  // In a real app, save to MongoDB/SQLite here
  console.log("Reading Saved:", req.body);
  res.sendStatus(200);
});

// --- Helper Functions ---

function parseWiFiInterface(output) {
  const result = { ssid: null, signal: null, quality: 0 };
  const lines = output.split("\n");
  for (let line of lines) {
    if (line.includes("SSID") && !line.includes("BSSID"))
      result.ssid = line.split(":")[1].trim();
    if (line.includes("Signal")) {
      const parts = line.split(":");
      if (parts[1]) {
        result.quality = parseInt(parts[1].replace("%", "").trim());
        // Map 0-100% to -100dBm to -50dBm
        result.signal = -100 + result.quality / 2;
      }
    }
  }
  return result;
}

async function pingHost(host) {
  const start = Date.now();
  try {
    // Timeout set to 2s to prevent hanging
    const cmd =
      process.platform === "win32"
        ? `ping -n 1 -w 2000 ${host}`
        : `ping -c 1 -W 2 ${host}`;
    await execAsync(cmd);
    return Date.now() - start;
  } catch (e) {
    return 999; // Timeout/Fail
  }
}

function estimateBandwidth(signal) {
  if (signal > -50) return (150 + Math.random() * 50).toFixed(1);
  if (signal > -70) return (50 + Math.random() * 30).toFixed(1);
  if (signal > -85) return (10 + Math.random() * 10).toFixed(1);
  return (1 + Math.random()).toFixed(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
