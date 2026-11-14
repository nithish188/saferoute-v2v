"""
Smart V2V Collision System - Backend Server
Implements Section III-B Layered Architecture (Fig. 2):
- Location Ingestion API (validate, timestamp)
- Speed and Heading Estimator
- Spatial Neighbour Search (Grid Index)
- Collision Prediction Engine
- Alert Dispatcher (WebSocket & REST)
- Emergency Vehicle (Ambulance) Service
- Women Safety & SOS Service
- Data Layer (SQLite store)
- Table III Scenario Runner & Interactive City Simulation
"""

import os
import sys
import time
import math
import json
import asyncio
import uuid
from typing import Dict, List, Optional, Set, Any
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.config import (
    HOST, PORT, DEFAULT_REF_LAT, DEFAULT_REF_LON,
    LOCATION_UPDATE_PERIOD_TS, NEIGHBOUR_RADIUS_RS,
    PREDICTION_HORIZON_TH, MINIMUM_MOVING_SPEED_VMIN,
    VEHICLE_SIZE_MARGIN_DV, ACCURACY_FACTOR_K,
    SPEED_SMOOTHING_ALPHA, ALERT_COOLDOWN_SEC,
    AMBULANCE_CORRIDOR_LENGTH_LE, AMBULANCE_CORRIDOR_HALF_WIDTH_WE,
    ANALYSIS_RADIUS_M, AMBULANCE_ANALYSIS_RADIUS_M
)
from backend.models import (
    VehicleRole, AlertLevel, RelativeBearing,
    LocationUpdate, VehicleState, Alert,
    GuardianContact, SOSPayload, SOSState
)
from backend.estimator import (
    haversine_distance, calculate_heading, smooth_speed,
    project_to_local_plane, unproject_from_local_plane,
    build_velocity_vector
)
from backend.grid_index import SpatialGridIndex
from backend.prediction_engine import CollisionPredictionEngine
from backend.ambulance_service import AmbulanceClearanceService
from backend.women_safety import WomenSafetyService
from backend.scenario_runner import ScenarioEvaluator
from backend.database import DatabaseManager
from backend.routing_service import RouteService

app = FastAPI(
    title="Smart V2V Collision System",
    description="Smartphone-Based Predictive Collision Warning with Emergency Vehicle Clearance and Women Safety Support (Jai Shriram Engineering College)",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Reference point for projection
ref_lat = DEFAULT_REF_LAT
ref_lon = DEFAULT_REF_LON

# Core Services
grid_index = SpatialGridIndex(cell_size=NEIGHBOUR_RADIUS_RS, v_min=MINIMUM_MOVING_SPEED_VMIN)
prediction_engine = CollisionPredictionEngine(
    t_horizon=PREDICTION_HORIZON_TH,
    d_v=VEHICLE_SIZE_MARGIN_DV,
    k=ACCURACY_FACTOR_K,
    cooldown_sec=ALERT_COOLDOWN_SEC,
    ref_lat=ref_lat,
    ref_lon=ref_lon
)
ambulance_service = AmbulanceClearanceService(ref_lat=ref_lat, ref_lon=ref_lon)
women_safety_service = WomenSafetyService()
scenario_evaluator = ScenarioEvaluator(ref_lat=ref_lat, ref_lon=ref_lon)
db_manager = DatabaseManager()

# In-Memory State
vehicles: Dict[str, VehicleState] = {}
previous_locations: Dict[str, Dict[str, Any]] = {}
active_alerts: Dict[str, Alert] = {}
ambulance_corridors: List[Dict[str, Any]] = []
active_host_vehicle_id: str = "car_host"
system_ambulance_mode: bool = False
active_route: Dict[str, Any] = {}  # Global/fallback route
active_routes: Dict[str, Dict[str, Any]] = {}  # Per-device active routes: vehicle_id -> route_dict

# Route Service
route_service = RouteService(ref_lat=DEFAULT_REF_LAT, ref_lon=DEFAULT_REF_LON)

def cleanup_stale_vehicles(max_idle_seconds: float = 20.0):
    """Prunes vehicles that haven't sent telemetry within max_idle_seconds."""
    now = time.time()
    stale_ids = [vid for vid, v in vehicles.items() if now - v.last_update_monotonic > max_idle_seconds]
    for vid in stale_ids:
        v = vehicles.pop(vid, None)
        previous_locations.pop(vid, None)
        active_routes.pop(vid, None)
        grid_index.remove_vehicle(vid)

# WebSocket Connection Manager with Lock to prevent concurrent socket write collisions
class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._last_broadcast_time = 0.0

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return

        async with self._lock:
            dead = []
            for ws in list(self.active_connections):
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.active_connections.discard(ws)

ws_manager = ConnectionManager()

# Mount frontend static directory
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

@app.get("/", response_class=FileResponse)
async def serve_index():
    index_file = frontend_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return HTMLResponse("<h1>Smart V2V Collision System</h1><p>Frontend not found.</p>")

@app.get("/manifest.json")
async def serve_manifest():
    manifest_file = frontend_dir / "manifest.json"
    if manifest_file.exists():
        return FileResponse(manifest_file, media_type="application/manifest+json")
    return JSONResponse({})

@app.get("/sw.js")
async def serve_sw():
    sw_file = frontend_dir / "sw.js"
    if sw_file.exists():
        return FileResponse(
            sw_file,
            media_type="application/javascript",
            headers={"Service-Worker-Allowed": "/"}
        )
    return HTMLResponse("", status_code=404)

# -------------------------------------------------------------
# Telemetry Ingestion & Core V2V Prediction Loop
# -------------------------------------------------------------
def process_single_telemetry(update: LocationUpdate) -> Optional[VehicleState]:
    now = time.time()
    v_id = update.vehicle_id
    label = update.label or f"User-{v_id[-4:]}"

    prev = previous_locations.get(v_id)
    raw_speed = update.speed if update.speed is not None else 0.0
    heading_deg = update.heading if update.heading is not None else 0.0
    smoothed_spd = raw_speed

    if prev is not None:
        dt = max(0.1, now - prev["timestamp"])
        dist = haversine_distance(prev["lat"], prev["lon"], update.latitude, update.longitude)
        if update.speed is None:
            raw_speed = dist / dt
        if update.heading is None and dist > 0.5:
            heading_deg = calculate_heading(prev["lat"], prev["lon"], update.latitude, update.longitude)
        prev_smoothed = prev.get("smoothed_speed", raw_speed)
        smoothed_spd = smooth_speed(raw_speed, prev_smoothed, SPEED_SMOOTHING_ALPHA)
    else:
        smoothed_spd = raw_speed

    px, py = project_to_local_plane(update.latitude, update.longitude, ref_lat, ref_lon)
    vx, vy = build_velocity_vector(smoothed_spd, heading_deg)

    existing_v = vehicles.get(v_id)
    ambulance_active = getattr(update, "ambulance_active", None)
    if ambulance_active is None:
        ambulance_active = existing_v.ambulance_active if existing_v else (update.role == VehicleRole.AMBULANCE)
    sos_active = getattr(update, "sos_active", None)
    if sos_active is None:
        sos_active = existing_v.sos_active if existing_v else (update.role == VehicleRole.WOMEN_SAFETY)

    v_state = VehicleState(
        vehicle_id=v_id,
        label=label,
        role=update.role,
        vehicle_type=getattr(update, "vehicle_type", "car"),
        vehicle_number=getattr(update, "vehicle_number", None),
        latitude=update.latitude,
        longitude=update.longitude,
        accuracy=update.accuracy,
        speed_raw=round(raw_speed, 2),
        speed_smoothed=round(smoothed_spd, 2),
        heading_deg=round(heading_deg, 1),
        pos_x=round(px, 2),
        pos_y=round(py, 2),
        vel_x=round(vx, 2),
        vel_y=round(vy, 2),
        timestamp=now,
        last_update_monotonic=now,
        is_active=True,
        ambulance_active=bool(ambulance_active),
        sos_active=bool(sos_active)
    )

    vehicles[v_id] = v_state
    previous_locations[v_id] = {
        "lat": update.latitude,
        "lon": update.longitude,
        "timestamp": now,
        "smoothed_speed": smoothed_spd,
        "heading": heading_deg
    }

    grid_index.update_vehicle(v_state)
    db_manager.log_position(v_id, update.latitude, update.longitude, update.accuracy, smoothed_spd, heading_deg, now)
    return v_state

@app.post("/api/telemetry")
async def ingest_telemetry(update: LocationUpdate):
    global active_host_vehicle_id
    active_host_vehicle_id = update.vehicle_id
    v_state = process_single_telemetry(update)
    new_alerts = await evaluate_all_risks()
    await broadcast_system_state()

    v_id = update.vehicle_id
    vehicle_alerts = [a.model_dump() for a in new_alerts if a.target_vehicle_id == v_id or a.source_vehicle_id == v_id]

    return {
        "status": "success",
        "vehicle": v_state.model_dump(),
        "alerts_count": len(vehicle_alerts),
        "alerts": vehicle_alerts
    }

@app.post("/api/telemetry/batch")
async def ingest_batch_telemetry(updates: List[LocationUpdate]):
    """Batch ingestion for high-performance multi-vehicle simulation without socket collisions."""
    for update in updates:
        process_single_telemetry(update)
    new_alerts = await evaluate_all_risks()
    await broadcast_system_state()
    return {"status": "success", "processed": len(updates), "alerts_count": len(new_alerts)}

async def evaluate_all_risks() -> List[Alert]:
    now = time.time()
    cleanup_stale_vehicles(max_idle_seconds=15.0)
    alerts_generated: List[Alert] = []
    global ambulance_corridors
    ambulance_corridors = []

    # 1. Identify Host Vehicle (user's current location / "me")
    host_v = vehicles.get(active_host_vehicle_id)
    if not host_v:
        # Search for non-simulated user devices first
        for vid, v in vehicles.items():
            if v.is_active and not vid.startswith("v2v_"):
                host_v = v
                break
        if not host_v and vehicles:
            host_v = next(iter(vehicles.values()))

    # Determine analysis radius: 1000m (1km) in Ambulance Mode, 500m in Standard Mode
    is_host_ambulance = system_ambulance_mode or bool(host_v and (host_v.role == VehicleRole.AMBULANCE or host_v.ambulance_active))
    current_analysis_radius = AMBULANCE_ANALYSIS_RADIUS_M if is_host_ambulance else ANALYSIS_RADIUS_M

    # 2. Radius distance computation from host using Haversine (1000m in Ambulance Mode)
    if host_v:
        for vid, v in vehicles.items():
            dist = haversine_distance(host_v.latitude, host_v.longitude, v.latitude, v.longitude)
            v.distance_from_host_m = round(dist, 1)
            v.in_analysis_zone = (dist <= current_analysis_radius)

    # 3. V2V Collision Prediction: STRICTLY between Host ("Me") and Nearby Vehicles (IEEE Section IV-E & IV-F)
    # Collision detection and alerts are ONLY performed between host ("me") and nearby vehicles, NEVER between other cars.
    if host_v and host_v.is_active:
        for v in vehicles.values():
            if not v.is_active or v.vehicle_id == host_v.vehicle_id:
                continue
            if not getattr(v, "in_analysis_zone", True):
                continue
            # Stationary filter: parked or stopped vehicles cannot produce a dynamic collision risk
            if host_v.speed_smoothed < 1.5 and v.speed_smoothed < 1.5:
                continue

            # Analytical Closest Approach (Eq. 7, 8, 9, 10) between "Me" and nearby vehicle
            res = prediction_engine.compute_closest_approach(host_v, v)
            if res.is_risk and res.level != AlertLevel.NONE:
                pair_alerts = prediction_engine.generate_alerts_for_pair(host_v, v, now)
                for alt in pair_alerts:
                    alerts_generated.append(alt)
                    active_alerts[alt.alert_id] = alt
                    db_manager.log_alert(alt.model_dump())

    # If active route exists, also evaluate route-specific hazards
    if active_route.get("coordinates") and host_v:
        route_hazards = route_service.evaluate_route_collisions(
            host_v,
            active_route["coordinates"],
            vehicles,
            max_radius_m=current_analysis_radius
        )
        for rh in route_hazards:
            alt_dict = rh.get("alert")
            if alt_dict:
                alt = Alert(**alt_dict)
                if alt.alert_id not in active_alerts:
                    alerts_generated.append(alt)
                    active_alerts[alt.alert_id] = alt
                    db_manager.log_alert(alt.model_dump())

    # 4. Ambulance Priority Corridor Evaluation (Section V-A)
    # Radius is 1000m (1km) and continuous alerts are shared to all vehicles on ambulance's route
    for v_id, v in vehicles.items():
        if (v.role == VehicleRole.AMBULANCE or v.ambulance_active) and v.is_active:
            amb_route = active_route.get("coordinates") if (host_v and host_v.vehicle_id == v.vehicle_id) else None
            amb_alerts, summary = ambulance_service.evaluate_clearance(
                v, vehicles, now, route_coords=amb_route
            )
            ambulance_corridors.append(summary)
            if amb_alerts:
                alerts_generated.extend(amb_alerts)
                for a in amb_alerts:
                    active_alerts[a.alert_id] = a
                    db_manager.log_alert(a.model_dump())

    # Clean stale alerts (older than 4 seconds)
    stale_ids = [aid for aid, a in active_alerts.items() if now - a.timestamp > 4.0]
    for sid in stale_ids:
        del active_alerts[sid]

    return alerts_generated

def get_current_state_payload() -> dict:
    cleanup_stale_vehicles(max_idle_seconds=15.0)
    host_v = vehicles.get(active_host_vehicle_id)
    if not host_v and vehicles:
        host_v = next(iter(vehicles.values()))

    is_host_ambulance = system_ambulance_mode or bool(host_v and (host_v.role == VehicleRole.AMBULANCE or host_v.ambulance_active))
    current_analysis_radius = AMBULANCE_ANALYSIS_RADIUS_M if is_host_ambulance else ANALYSIS_RADIUS_M

    # Calculate exact distance from host vehicle for every vehicle
    if host_v:
        for vid, v in vehicles.items():
            dist = haversine_distance(host_v.latitude, host_v.longitude, v.latitude, v.longitude)
            v.distance_from_host_m = round(dist, 1)
            v.in_analysis_zone = (dist <= current_analysis_radius)

    return {
        "type": "STATE_UPDATE",
        "timestamp": time.time(),
        "host_vehicle_id": host_v.vehicle_id if host_v else active_host_vehicle_id,
        "analysis_radius_m": current_analysis_radius,
        "is_ambulance_mode": is_host_ambulance,
        "vehicles": {vid: v.model_dump() for vid, v in vehicles.items() if v.is_active},
        "alerts": [
            a.model_dump() for a in active_alerts.values()
            if not host_v or a.target_vehicle_id == host_v.vehicle_id or a.source_vehicle_id == host_v.vehicle_id
        ],
        "ambulance_corridors": ambulance_corridors,
        "active_sos": [s.model_dump() for s in women_safety_service.get_all_active_sos()],
        "active_route": active_route
    }

async def broadcast_system_state():
    await ws_manager.broadcast(get_current_state_payload())

@app.get("/api/state")
async def get_live_state():
    """REST endpoint for instant polling or fallback sync."""
    return get_current_state_payload()

# -------------------------------------------------------------
# WebSocket Stream with Ping/Pong & Safe Text Protocol
# -------------------------------------------------------------
@app.websocket("/ws/stream")
async def websocket_endpoint(websocket: WebSocket):
    try:
        await ws_manager.connect(websocket)
        # Send initial full state immediately
        await websocket.send_json({
            "type": "INITIAL_STATE",
            "timestamp": time.time(),
            "reference": {"lat": ref_lat, "lon": ref_lon},
            "parameters": {
                "Ts": LOCATION_UPDATE_PERIOD_TS,
                "Rs": NEIGHBOUR_RADIUS_RS,
                "Th": PREDICTION_HORIZON_TH,
                "vmin": MINIMUM_MOVING_SPEED_VMIN,
                "Dv": VEHICLE_SIZE_MARGIN_DV,
                "k": ACCURACY_FACTOR_K,
                "alpha": SPEED_SMOOTHING_ALPHA,
                "Le": AMBULANCE_CORRIDOR_LENGTH_LE,
                "we": AMBULANCE_CORRIDOR_HALF_WIDTH_WE
            },
            "vehicles": {vid: v.model_dump() for vid, v in vehicles.items() if v.is_active},
            "alerts": [a.model_dump() for a in active_alerts.values()],
            "ambulance_corridors": ambulance_corridors,
            "active_sos": [s.model_dump() for s in women_safety_service.get_all_active_sos()],
            "active_route": active_route
        })

        while True:
            # Safely receive text or heartbeat
            raw = await websocket.receive_text()
            if raw == "ping":
                await websocket.send_text("pong")
            else:
                try:
                    data = json.loads(raw)
                    if data.get("type") == "PING":
                        await websocket.send_json({"type": "PONG", "timestamp": time.time()})
                    elif data.get("type") == "IDENTIFY":
                        vid = data.get("vehicle_id") or data.get("device_id")
                        if vid and vid in vehicles:
                            v_role = VehicleRole.AMBULANCE if data.get("role") == "ambulance" else VehicleRole.STANDARD
                            vehicles[vid].role = v_role
                            if data.get("label"):
                                vehicles[vid].label = data["label"]
                            if data.get("vehicle_type"):
                                vehicles[vid].vehicle_type = data["vehicle_type"]
                            if data.get("vehicle_number"):
                                vehicles[vid].vehicle_number = data["vehicle_number"]
                    elif data.get("type") == "TELEMETRY":
                        update = LocationUpdate(**data.get("payload", {}))
                        global active_host_vehicle_id
                        active_host_vehicle_id = update.vehicle_id
                        process_single_telemetry(update)
                        await evaluate_all_risks()
                        await broadcast_system_state()
                except Exception as inner_e:
                    print("Error parsing incoming WS frame:", inner_e)
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception as e:
        import traceback
        print("FATAL EXCEPTION IN WS ENDPOINT:", type(e), e)
        traceback.print_exc()
        await ws_manager.disconnect(websocket)

# -------------------------------------------------------------
# Mode & Vehicle Management Endpoints
# -------------------------------------------------------------
class SetHostVehiclePayload(BaseModel):
    vehicle_id: str

@app.post("/api/host-vehicle")
async def set_active_host_vehicle(payload: SetHostVehiclePayload):
    """Sets which vehicle represents the user's current location for 500m radius filtering."""
    global active_host_vehicle_id, ref_lat, ref_lon
    active_host_vehicle_id = payload.vehicle_id
    if active_host_vehicle_id in vehicles:
        ref_lat = vehicles[active_host_vehicle_id].latitude
        ref_lon = vehicles[active_host_vehicle_id].longitude
    await evaluate_all_risks()
    await broadcast_system_state()
    return {"status": "success", "host_vehicle_id": active_host_vehicle_id, "analysis_radius_m": ANALYSIS_RADIUS_M}

class VehicleRegisterPayload(BaseModel):
    vehicle_id: str
    label: str
    role: VehicleRole = VehicleRole.STANDARD
    latitude: Optional[float] = None
    longitude: Optional[float] = None

@app.post("/api/vehicles/register")
async def register_vehicle(payload: VehicleRegisterPayload):
    v_id = payload.vehicle_id
    lat = payload.latitude or ref_lat
    lon = payload.longitude or ref_lon
    px, py = project_to_local_plane(lat, lon, ref_lat, ref_lon)
    now = time.time()

    v_state = VehicleState(
        vehicle_id=v_id,
        label=payload.label,
        role=payload.role,
        latitude=lat,
        longitude=lon,
        accuracy=3.0,
        speed_raw=0.0,
        speed_smoothed=0.0,
        heading_deg=0.0,
        pos_x=px,
        pos_y=py,
        vel_x=0.0,
        vel_y=0.0,
        timestamp=now,
        last_update_monotonic=now,
        ambulance_active=(payload.role == VehicleRole.AMBULANCE),
        sos_active=(payload.role == VehicleRole.WOMEN_SAFETY)
    )
    vehicles[v_id] = v_state
    grid_index.update_vehicle(v_state)
    await broadcast_system_state()
    return {"status": "registered", "vehicle": v_state.model_dump()}

@app.delete("/api/vehicles/{vehicle_id}")
async def remove_vehicle(vehicle_id: str):
    if vehicle_id in vehicles:
        vehicles[vehicle_id].is_active = False
        del vehicles[vehicle_id]
        grid_index.remove_vehicle(vehicle_id)
        if vehicle_id in previous_locations:
            del previous_locations[vehicle_id]
        await evaluate_all_risks()
        await broadcast_system_state()
        return {"status": "removed", "vehicle_id": vehicle_id}
    raise HTTPException(status_code=404, detail="Vehicle not found")

@app.post("/api/vehicles/clear-all")
async def clear_all_vehicles(keep_host: bool = False):
    """Clears all vehicle states and alerts for a clean reset."""
    global system_ambulance_mode
    system_ambulance_mode = False
    vehicles.clear()
    previous_locations.clear()
    active_alerts.clear()
    grid_index.clear()
    ambulance_corridors.clear()
    await broadcast_system_state()
    return {"status": "cleared"}

# -------------------------------------------------------------
# Ambulance Mode Endpoints (Section V-A)
# -------------------------------------------------------------
class AmbulanceTogglePayload(BaseModel):
    vehicle_id: str
    active: bool

@app.post("/api/ambulance/toggle")
async def toggle_ambulance(payload: AmbulanceTogglePayload):
    global system_ambulance_mode
    system_ambulance_mode = payload.active
    v_id = payload.vehicle_id
    if v_id not in vehicles:
        for cand in [active_host_vehicle_id, "my_phone_device", "car_host"]:
            if cand in vehicles:
                v_id = cand
                break
    if v_id in vehicles:
        v = vehicles[v_id]
        v.role = VehicleRole.AMBULANCE if payload.active else VehicleRole.STANDARD
        v.ambulance_active = payload.active
        await evaluate_all_risks()
        await broadcast_system_state()
        return {
            "status": "updated",
            "vehicle_id": v_id,
            "ambulance_active": v.ambulance_active,
            "analysis_radius_m": AMBULANCE_ANALYSIS_RADIUS_M if payload.active else ANALYSIS_RADIUS_M
        }
    return {
        "status": "updated",
        "vehicle_id": v_id,
        "ambulance_active": payload.active,
        "analysis_radius_m": AMBULANCE_ANALYSIS_RADIUS_M if payload.active else ANALYSIS_RADIUS_M
    }

# -------------------------------------------------------------
# Women Safety Mode Endpoints (Section V-B)
# -------------------------------------------------------------
@app.get("/api/sos/contacts")
async def get_emergency_contacts(user_id: str = "default_user"):
    contacts = women_safety_service.get_contacts(user_id)
    return {"contacts": [c.model_dump() for c in contacts]}

@app.post("/api/sos/contacts")
async def save_emergency_contacts(contacts: List[GuardianContact], user_id: str = "default_user"):
    women_safety_service.update_contacts(user_id, contacts)
    return {"status": "saved", "count": len(contacts)}

@app.post("/api/sos/trigger")
async def trigger_sos(payload: SOSPayload, request: Request):
    base_url = str(request.base_url).rstrip("/")
    sos_state = women_safety_service.trigger_sos(payload, base_url)

    if payload.user_id in vehicles:
        vehicles[payload.user_id].sos_active = True

    db_manager.log_sos_event(sos_state.model_dump())

    sos_alert = Alert(
        alert_id=f"sos_alt_{sos_state.sos_id}",
        timestamp=sos_state.timestamp,
        level=AlertLevel.SOS_ALERT,
        source_vehicle_id=payload.user_id,
        target_vehicle_id="ALL_GUARDIANS",
        message=f"WOMEN SAFETY SOS: {payload.user_name} triggered emergency distress!",
        spoken_text=f"Distress alert activated for {payload.user_name}. Live location sent to emergency contacts.",
        target_pos={"lat": payload.latitude, "lon": payload.longitude},
        source_pos={"lat": payload.latitude, "lon": payload.longitude}
    )
    active_alerts[sos_alert.alert_id] = sos_alert

    await broadcast_system_state()
    return {"status": "activated", "sos": sos_state.model_dump()}

@app.post("/api/sos/update")
async def update_sos_location(token: str, lat: float, lon: float):
    state = women_safety_service.update_sos_location(token, lat, lon)
    if state:
        await broadcast_system_state()
        return {"status": "updated", "sos": state.model_dump()}
    raise HTTPException(status_code=404, detail="Active SOS session not found")

@app.post("/api/sos/cancel")
async def cancel_sos(user_id: str):
    state = women_safety_service.cancel_sos(user_id)
    if user_id in vehicles:
        vehicles[user_id].sos_active = False

    stale_sos = [aid for aid, a in active_alerts.items() if a.level == AlertLevel.SOS_ALERT and a.source_vehicle_id == user_id]
    for aid in stale_sos:
        del active_alerts[aid]

    if state:
        db_manager.log_sos_event(state.model_dump())
    await broadcast_system_state()
    return {"status": "cancelled", "sos": state.model_dump() if state else None}

@app.get("/api/sos/track/{token}")
async def track_sos_live(token: str):
    state = women_safety_service.get_sos_by_token(token)
    if not state:
        raise HTTPException(status_code=404, detail="Tracking session not found or expired")
    return {"status": "success", "session": state.model_dump()}

@app.get("/api/sos/sms-log")
async def get_sms_log():
    return {"sms_logs": women_safety_service.sms_gateway_log}

# -------------------------------------------------------------
# Post-Collision Accident Reporting & Emergency Dispatch (Hospitals & Police)
# -------------------------------------------------------------
NEARBY_EMERGENCY_FACILITIES = {
    "hospitals": [
        {
            "id": "hosp_sumith",
            "name": "Sumith Multispeciality Hospital",
            "type": "Multi-Speciality Emergency Trauma Care",
            "address": "Hope College, Avinashi Rd, Coimbatore",
            "latitude": 11.025950,
            "longitude": 77.014200,
            "phone": "+91 422 257 8899",
            "emergency_no": "108"
        },
        {
            "id": "hosp_psg",
            "name": "PSG Hospitals",
            "type": "General Hospital & Critical Care Unit",
            "address": "Avinashi Road, Peelamedu, Coimbatore",
            "latitude": 11.027600,
            "longitude": 77.029800,
            "phone": "+91 422 257 0170",
            "emergency_no": "108"
        },
        {
            "id": "hosp_kmch",
            "name": "Kovai Medical Center & Hospital (KMCH)",
            "type": "Level-1 Comprehensive Trauma Center",
            "address": "Avinashi Road, Civil Aerodrome Post, Coimbatore",
            "latitude": 11.042500,
            "longitude": 77.042300,
            "phone": "+91 422 432 3800",
            "emergency_no": "108"
        }
    ],
    "police_stations": [
        {
            "id": "police_peelamedu",
            "name": "Peelamedu Police Station (B-4)",
            "type": "City Law Enforcement & Highway Patrol",
            "address": "Avinashi Road, Peelamedu, Coimbatore",
            "latitude": 11.026100,
            "longitude": 77.024500,
            "phone": "+91 422 257 2222",
            "emergency_no": "112"
        },
        {
            "id": "police_traffic_peelamedu",
            "name": "Peelamedu Traffic Police Station",
            "type": "Traffic Incident Response Unit",
            "address": "Near Hope College Flyover, Coimbatore",
            "latitude": 11.025300,
            "longitude": 77.017200,
            "phone": "+91 422 257 1100",
            "emergency_no": "112"
        }
    ]
}

class AccidentReportPayload(BaseModel):
    vehicle_id: str
    collided_vehicle_id: Optional[str] = "v2v_car_nearby"
    latitude: float
    longitude: float
    speed_at_impact: float = 0.0
    impact_time: Optional[float] = None
    description: str = "Accident occured"

accident_reports: List[Dict[str, Any]] = []

@app.post("/api/accident/report")
async def report_accident(payload: AccidentReportPayload):
    """
    Called when a collision with host vehicle is confirmed on map.
    Freezes vehicle movements, identifies closest Hospital & Police Station,
    generates emergency dispatch tickets, logs incident, and broadcasts alert.
    """
    now = payload.impact_time or time.time()
    lat = payload.latitude
    lon = payload.longitude

    # Calculate distance and ETA to hospitals
    sorted_hospitals = []
    for h in NEARBY_EMERGENCY_FACILITIES["hospitals"]:
        dist = haversine_distance(lat, lon, h["latitude"], h["longitude"])
        eta_min = max(1, round(dist / 666.0)) # ~40 km/h emergency transit
        sorted_hospitals.append({
            **h,
            "distance_m": round(dist, 1),
            "eta_min": eta_min,
            "status": "Ambulance Dispatched (108)"
        })
    sorted_hospitals.sort(key=lambda x: x["distance_m"])

    # Calculate distance and ETA to police stations
    sorted_police = []
    for p in NEARBY_EMERGENCY_FACILITIES["police_stations"]:
        dist = haversine_distance(lat, lon, p["latitude"], p["longitude"])
        eta_min = max(1, round(dist / 666.0))
        sorted_police.append({
            **p,
            "distance_m": round(dist, 1),
            "eta_min": eta_min,
            "status": "Patrol Unit Dispatched (112)"
        })
    sorted_police.sort(key=lambda x: x["distance_m"])

    nearest_hospital = sorted_hospitals[0] if sorted_hospitals else None
    nearest_police = sorted_police[0] if sorted_police else None

    accident_id = f"acc_{int(now)}_{uuid.uuid4().hex[:6]}"
    report_entry = {
        "accident_id": accident_id,
        "timestamp": now,
        "vehicle_id": payload.vehicle_id,
        "collided_vehicle_id": payload.collided_vehicle_id,
        "location": {
            "latitude": lat,
            "longitude": lon,
            "address": "Avinashi Road near Hope College / GD Naidu Flyover, Coimbatore"
        },
        "speed_at_impact_kmh": round(payload.speed_at_impact, 1),
        "description": "Accident occured",
        "nearest_hospital": nearest_hospital,
        "nearest_police": nearest_police,
        "status": "DISPATCHED"
    }

    accident_reports.append(report_entry)
    db_manager.log_alert({
        "alert_id": f"alert_{accident_id}",
        "timestamp": now,
        "level": "critical",
        "source_vehicle_id": payload.vehicle_id,
        "target_vehicle_id": "EMERGENCY_DISPATCH",
        "message": f"Accident occured at Avinashi Rd. Dispatched to {nearest_hospital['name'] if nearest_hospital else 'Hospital'} & {nearest_police['name'] if nearest_police else 'Police Station'}."
    })

    # Freeze vehicles on backend: zero speed and position set to impact point
    for vid in [payload.vehicle_id, payload.collided_vehicle_id]:
        if vid and vid in vehicles:
            v = vehicles[vid]
            v.latitude = lat
            v.longitude = lon
            v.speed_raw = 0.0
            v.speed_smoothed = 0.0
            v.vel_x = 0.0
            v.vel_y = 0.0

    # Top-priority accident alert
    hosp_name = nearest_hospital['name'] if nearest_hospital else "Hospital"
    police_name = nearest_police['name'] if nearest_police else "Police Station"
    accident_alert = Alert(
        alert_id=f"alert_{accident_id}",
        timestamp=now,
        level=AlertLevel.CRITICAL,
        source_vehicle_id=payload.vehicle_id,
        target_vehicle_id="ALL",
        message=f"ACCIDENT OCCURRED: Nearest Emergency Assistance Dispatched ({hosp_name} & {police_name}).",
        spoken_text="Accident occurred. Emergency alert dispatched to nearest hospital and police station.",
        target_pos={"lat": lat, "lon": lon},
        source_pos={"lat": lat, "lon": lon},
        impact_point={"lat": lat, "lon": lon}
    )
    active_alerts[accident_alert.alert_id] = accident_alert

    await broadcast_system_state()
    return {
        "status": "dispatched",
        "report": report_entry
    }

@app.get("/api/accident/list")
async def list_accidents():
    return {"accidents": accident_reports}

# -------------------------------------------------------------
# Scenario Evaluation & Analytical Endpoints (Table III)
# -------------------------------------------------------------
@app.get("/api/scenarios/list")
async def list_scenarios():
    return {"scenarios": scenario_evaluator.get_predefined_scenarios()}

@app.get("/api/scenarios/run/{scenario_id}")
async def run_scenario_endpoint(scenario_id: str):
    try:
        result = scenario_evaluator.run_scenario(scenario_id)
        return {"status": "success", "result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/scenarios/load-into-simulation/{scenario_id}")
async def load_scenario_into_sim(scenario_id: str):
    await clear_all_vehicles()
    res = scenario_evaluator.run_scenario(scenario_id)
    v_a = VehicleState(**res["vehicles"]["A"])
    v_b = VehicleState(**res["vehicles"]["B"])

    vehicles[v_a.vehicle_id] = v_a
    vehicles[v_b.vehicle_id] = v_b
    grid_index.update_vehicle(v_a)
    grid_index.update_vehicle(v_b)

    await evaluate_all_risks()
    await broadcast_system_state()
    return {"status": "loaded", "scenario": res}

@app.get("/api/alerts/history")
async def get_alert_history(limit: int = 50):
    return {"history": db_manager.get_recent_alerts(limit)}

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "system": "Smart V2V Collision System",
        "active_vehicles": len(vehicles),
        "active_alerts": len(active_alerts),
        "connected_clients": len(ws_manager.active_connections),
        "active_route_status": "navigating" if active_route.get("coordinates") else "idle",
        "uptime": time.time()
    }

# -------------------------------------------------------------
# Routing & Navigation Endpoints (Section III - Google Maps Style)
# -------------------------------------------------------------

@app.get("/api/route/destinations")
async def get_destinations():
    """Returns popular destination landmarks around Tiruppur / Jai Shriram Engineering College."""
    return {"destinations": route_service.get_destinations()}

@app.get("/api/route/search")
async def search_route_destination(q: str):
    """Searches locations via OpenStreetMap Nominatim with local popular landmark search."""
    return {"results": route_service.search_destinations(q)}

@app.post("/api/route/set-active")
async def set_active_route(route: Dict[str, Any]):
    """Allows client-resolved route to be stored and broadcast to all connected displays."""
    global active_route
    active_route = route
    await broadcast_system_state()
    return {"status": "success", "route": active_route}

class RouteCalculatePayload(BaseModel):
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    destination_name: Optional[str] = None

@app.post("/api/route/calculate")
async def calculate_route(payload: RouteCalculatePayload):
    """
    Calculates a driving route from start to destination using OSRM with local fallback.
    Stores the route in memory and broadcasts it via WebSocket so all connected clients
    immediately display the new route polyline.
    """
    global active_route
    result = route_service.calculate_route(
        payload.start_lat, payload.start_lon,
        payload.end_lat, payload.end_lon
    )
    if result.get("status") == "success":
        result["destination_name"] = payload.destination_name or f"({payload.end_lat:.4f}, {payload.end_lon:.4f})"
        active_route = result
        await broadcast_system_state()
        return {"status": "success", "route": result}
    else:
        raise HTTPException(status_code=503, detail="Route calculation failed. Try again or check connectivity.")

@app.post("/api/route/clear")
async def clear_route():
    """Clears the active navigation route and broadcasts the update."""
    global active_route
    active_route = {}
    await broadcast_system_state()
    return {"status": "cleared"}

@app.get("/api/route/collision-check")
async def route_collision_check():
    """
    Checks if any vehicle within 500m of the host poses a collision risk on the active route.
    Returns a list of ROUTE_HAZARD alerts.
    """
    host_v = vehicles.get(active_host_vehicle_id)
    if not host_v:
        return {"route_hazards": [], "message": "No host vehicle registered"}

    if not active_route.get("coordinates"):
        return {"route_hazards": [], "message": "No active route. Calculate a route first."}

    hazards = route_service.evaluate_route_collisions(
        host_v,
        active_route["coordinates"],
        vehicles
    )
    return {
        "route_hazards": hazards,
        "hazard_count": len(hazards),
        "route_source": active_route.get("source", "unknown"),
        "analysis_radius_m": ANALYSIS_RADIUS_M
    }
