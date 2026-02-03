import sqlite3
import json

DB_PATH = "wifi_data.db"

def check_db():
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT * FROM wifi_readings ORDER BY timestamp DESC LIMIT 5")
        rows = c.fetchall()
        
        # Get column names
        names = [description[0] for description in c.description]
        
        result = []
        for row in rows:
            result.append(dict(zip(names, row)))
            
        print(json.dumps(result, indent=2))
        conn.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_db()
