from flask import Flask, jsonify, request
from flask_cors import CORS
import subprocess
import time
import json
import os
import sqlite3
from datetime import datetime
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestRegressor
import threading

app = Flask(__name__)
CORS(app)

# Serve static files
app.static_folder = os.path.dirname(os.path.abspath(__file__))

# Database setup
DB_PATH = "wifi_data.db"

def init_db():
    """Initialize SQLite database for storing WiFi readings"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS wifi_readings (
            id INTEGER PRIMARY KEY,
            lat REAL,
            lon REAL,
            signal INTEGER,
            bandwidth REAL,
            latency INTEGER,
            connection TEXT,
            quality INTEGER,
            timestamp TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

def get_all_readings():
    """Fetch all stored WiFi readings from database"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT lat, lon, signal, bandwidth, latency, connection, quality, timestamp FROM wifi_readings')
    rows = c.fetchall()
    conn.close()
    
    readings = []
    for row in rows:
        readings.append({
            'lat': row[0],
            'lon': row[1],
            'signal': row[2],
            'bandwidth': row[3],
            'latency': row[4],
            'connection': row[5],
            'quality': row[6],
            'timestamp': row[7]
        })
    return readings

# Signal prediction model
class SignalPredictor:
    def __init__(self):
        self.model = RandomForestRegressor(n_estimators=10, random_state=42)
        self.scaler = StandardScaler()
        self.trained = False
        self.load_model()
    
    def train(self, readings):
        """Train model on existing WiFi readings"""
        if len(readings) < 5:
            self.trained = False
            return
        
        # Extract features and targets
        X = np.array([[r['lat'], r['lon']] for r in readings])
        y = np.array([r['signal'] for r in readings])
        
        X_scaled = self.scaler.fit_transform(X)
        self.model.fit(X_scaled, y)
        self.trained = True
    
    def predict(self, lat, lon):
        """Predict signal strength at given coordinates"""
        if not self.trained:
            return None
        try:
            X = np.array([[lat, lon]]).reshape(1, -1)
            X_scaled = self.scaler.transform(X)
            prediction = self.model.predict(X_scaled)[0]
            return int(prediction)
        except:
            return None
    
    def load_model(self):
        """Load model from stored readings"""
        readings = get_all_readings()
        if readings:
            self.train(readings)

signal_predictor = SignalPredictor()

def save_reading(lat, lon, signal, bandwidth, latency, connection, quality):
    """Save WiFi reading to database"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    timestamp = datetime.now().isoformat()
    c.execute('''
        INSERT INTO wifi_readings (lat, lon, signal, bandwidth, latency, connection, quality, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (lat, lon, signal, bandwidth, latency, connection, quality, timestamp))
    conn.commit()
    conn.close()
    
    # Retrain model with new data
    threading.Thread(target=lambda: signal_predictor.train(get_all_readings())).start()

@app.route('/')
def serve_index():
    return app.send_static_file('index.html')

@app.route('/<path:path>')
def serve_static(path):
    if path.endswith('.js') or path.endswith('.css') or path.endswith('.html'):
        return app.send_static_file(path)
    return 'Not Found', 404

@app.route('/api/wifi-stats')
def get_wifi_stats():
    """Get current WiFi stats from Windows netsh command"""
    try:
        result = subprocess.run(
            ['netsh', 'wlan', 'show', 'interfaces'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        connection_info = parse_wifi_interface(result.stdout)
        signal = connection_info['signal']
        
        # Get latency
        latency = ping_host('8.8.8.8')
        
        # Estimate bandwidth
        bandwidth = estimate_bandwidth(signal)
        
        stats = {
            'bandwidth': round(bandwidth, 1),
            'latency': latency,
            'signal': signal,
            'connection': connection_info['ssid'],
            'quality': connection_info['quality'],
            'timestamp': datetime.now().isoformat()
        }
        
        return jsonify(stats)
    
    except Exception as error:
        print(f"Error getting WiFi stats: {error}")
        return jsonify({
            'bandwidth': None,
            'latency': None,
            'signal': None,
            'connection': None,
            'quality': None,
            'error': str(error)
        }), 500

def parse_wifi_interface(output):
    """Parse netsh wlan show interfaces output"""
    lines = output.split('\n')
    result = {'ssid': 'Unknown', 'signal': -70, 'quality': 0}
    
    for line in lines:
        if 'SSID' in line and ':' in line:
            match = line.split(':', 1)[1].strip()
            if match:
                result['ssid'] = match
        
        if 'Signal' in line and '%' in line:
            try:
                quality = int(''.join(filter(str.isdigit, line.split('%')[0].split()[-1])))
                result['quality'] = quality
                result['signal'] = round(-100 + (quality / 100) * 40)
            except:
                pass
    
    return result

def ping_host(host):
    """Ping a host and return latency in ms"""
    try:
        start = time.time()
        subprocess.run(
            ['ping', '-n', '1', host],
            capture_output=True,
            timeout=5
        )
        latency = int((time.time() - start) * 1000)
        return latency
    except:
        return None

def estimate_bandwidth(signal):
    """Estimate bandwidth from signal strength"""
    if signal > -50:
        return np.random.uniform(150, 200)
    elif signal > -60:
        return np.random.uniform(100, 150)
    elif signal > -70:
        return np.random.uniform(50, 80)
    elif signal > -80:
        return np.random.uniform(20, 40)
    else:
        return np.random.uniform(5, 15)

@app.route('/api/save-reading', methods=['POST'])
def save_reading_endpoint():
    """Save a WiFi reading with location data"""
    data = request.get_json()
    try:
        save_reading(
            data['lat'],
            data['lon'],
            data['signal'],
            data['bandwidth'],
            data['latency'],
            data['connection'],
            data['quality']
        )
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400

@app.route('/api/predict-signal')
def predict_signal():
    """Predict signal strength at given coordinates"""
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    
    if lat is None or lon is None:
        return jsonify({'error': 'Missing lat/lon'}), 400
    
    prediction = signal_predictor.predict(lat, lon)
    
    return jsonify({
        'predicted_signal': prediction,
        'model_trained': signal_predictor.trained
    })

@app.route('/api/readings')
def get_readings():
    """Get all stored WiFi readings"""
    readings = get_all_readings()
    return jsonify({'readings': readings})

@app.route('/api/clear-data', methods=['POST'])
def clear_data():
    """Clear all stored WiFi readings"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('DELETE FROM wifi_readings')
    conn.commit()
    conn.close()
    signal_predictor.trained = False
    return jsonify({'success': True})

if __name__ == '__main__':
    print("WiFi Vision AR server running at http://localhost:5000")
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False, threaded=True)
