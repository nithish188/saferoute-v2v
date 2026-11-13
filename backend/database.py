"""
Database and Event Log Service
Implements Data Layer (Fig. 2) with SQLite:
- Live position store
- User and contact database
- Event and alert log for historical analysis
"""

import sqlite3
import json
import time
from typing import List, Dict, Any, Optional

DB_PATH = "v2v_system.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Vehicles / Device table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS vehicles (
        vehicle_id TEXT PRIMARY KEY,
        label TEXT,
        role TEXT,
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        speed REAL,
        heading REAL,
        last_seen REAL
    )
    """)

    # Alerts log table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS alerts_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT,
        timestamp REAL,
        level TEXT,
        source_vehicle_id TEXT,
        target_vehicle_id TEXT,
        t_star REAL,
        d_min REAL,
        d_safe REAL,
        relative_bearing TEXT,
        message TEXT,
        impact_point TEXT
    )
    """)

    # Emergency contacts table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS emergency_contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT,
        phone TEXT,
        relationship TEXT,
        is_primary INTEGER
    )
    """)

    # SOS events table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS sos_events (
        sos_id TEXT PRIMARY KEY,
        user_id TEXT,
        user_name TEXT,
        tracking_token TEXT,
        latitude REAL,
        longitude REAL,
        timestamp REAL,
        status TEXT,
        sms_details TEXT
    )
    """)

    # Position track log for replay & trajectory verification
    cur.execute("""
    CREATE TABLE IF NOT EXISTS position_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vehicle_id TEXT,
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        speed REAL,
        heading REAL,
        timestamp REAL
    )
    """)

    conn.commit()
    conn.close()

class DatabaseManager:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        init_db()

    def get_connection(self):
        return sqlite3.connect(self.db_path)

    def log_position(self, vehicle_id: str, lat: float, lon: float, acc: float, speed: float, heading: float, ts: float):
        try:
            with self.get_connection() as conn:
                conn.execute(
                    "INSERT INTO position_telemetry (vehicle_id, latitude, longitude, accuracy, speed, heading, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (vehicle_id, lat, lon, acc, speed, heading, ts)
                )
        except Exception:
            pass

    def log_alert(self, alert_dict: Dict[str, Any]):
        try:
            with self.get_connection() as conn:
                impact_str = json.dumps(alert_dict.get("impact_point", {}))
                conn.execute("""
                    INSERT INTO alerts_log (alert_id, timestamp, level, source_vehicle_id, target_vehicle_id, t_star, d_min, d_safe, relative_bearing, message, impact_point)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    alert_dict.get("alert_id"),
                    alert_dict.get("timestamp", time.time()),
                    alert_dict.get("level"),
                    alert_dict.get("source_vehicle_id"),
                    alert_dict.get("target_vehicle_id"),
                    alert_dict.get("t_star"),
                    alert_dict.get("d_min"),
                    alert_dict.get("d_safe"),
                    alert_dict.get("relative_bearing"),
                    alert_dict.get("message"),
                    impact_str
                ))
        except Exception:
            pass

    def get_recent_alerts(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("SELECT * FROM alerts_log ORDER BY id DESC LIMIT ?", (limit,))
            rows = cur.fetchall()
            return [dict(row) for row in rows]

    def log_sos_event(self, sos_dict: Dict[str, Any]):
        try:
            with self.get_connection() as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO sos_events (sos_id, user_id, user_name, tracking_token, latitude, longitude, timestamp, status, sms_details)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    sos_dict.get("sos_id"),
                    sos_dict.get("user_id"),
                    sos_dict.get("user_name"),
                    sos_dict.get("tracking_token"),
                    sos_dict.get("latitude"),
                    sos_dict.get("longitude"),
                    sos_dict.get("timestamp"),
                    "ACTIVE" if sos_dict.get("active") else "RESOLVED",
                    json.dumps(sos_dict.get("sms_logs", []))
                ))
        except Exception:
            pass

