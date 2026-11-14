"""
Data Models for Smart V2V Collision System
Implements data schemas for Layered Architecture (Fig. 2)
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum
import time

class VehicleRole(str, Enum):
    STANDARD = "standard"
    AMBULANCE = "ambulance"
    WOMEN_SAFETY = "women_safety"
    POLICE = "police"

class AlertLevel(str, Enum):
    NONE = "none"
    ADVISORY = "advisory"
    WARNING = "warning"
    CRITICAL = "critical"
    AMBULANCE_CLEAR = "ambulance_clearance"
    SOS_ALERT = "sos_alert"

class RelativeBearing(str, Enum):
    FRONT = "front"
    RIGHT = "right"
    REAR = "rear"
    LEFT = "left"
    UNKNOWN = "unknown"

class LocationUpdate(BaseModel):
    vehicle_id: str
    latitude: float
    longitude: float
    timestamp: float = Field(default_factory=time.time)
    accuracy: float = 3.0  # reported GPS accuracy in meters (ai, aj)
    speed: Optional[float] = None  # optional direct speed fix
    heading: Optional[float] = None  # optional direct heading fix
    role: VehicleRole = VehicleRole.STANDARD
    label: Optional[str] = None
    vehicle_type: Optional[str] = "car"
    vehicle_number: Optional[str] = None
    ambulance_active: Optional[bool] = False
    sos_active: Optional[bool] = False

class VehicleState(BaseModel):
    vehicle_id: str
    label: str
    role: VehicleRole
    vehicle_type: Optional[str] = "car"
    vehicle_number: Optional[str] = None
    latitude: float
    longitude: float
    accuracy: float
    speed_raw: float = 0.0          # v = d / dt (m/s)
    speed_smoothed: float = 0.0     # v_hat (m/s) via exponential smoothing
    heading_deg: float = 0.0        # theta in degrees clockwise from North
    pos_x: float = 0.0              # projected meters from reference origin (East)
    pos_y: float = 0.0              # projected meters from reference origin (North)
    vel_x: float = 0.0              # Vx = v_hat * sin(theta)
    vel_y: float = 0.0              # Vy = v_hat * cos(theta)
    timestamp: float
    last_update_monotonic: float
    is_active: bool = True
    ambulance_active: bool = False
    sos_active: bool = False
    distance_from_host_m: Optional[float] = None
    in_analysis_zone: bool = True

class Alert(BaseModel):
    alert_id: str
    timestamp: float
    level: AlertLevel
    source_vehicle_id: str
    target_vehicle_id: str
    t_star: Optional[float] = None
    d_min: Optional[float] = None
    d_safe: Optional[float] = None
    relative_bearing: RelativeBearing = RelativeBearing.UNKNOWN
    bearing_deg: Optional[float] = None
    message: str
    spoken_text: str
    target_pos: Optional[Dict[str, float]] = None
    source_pos: Optional[Dict[str, float]] = None
    impact_point: Optional[Dict[str, float]] = None

class GuardianContact(BaseModel):
    id: str
    name: str
    phone: str
    relationship: str
    is_primary: bool = False

class SOSPayload(BaseModel):
    user_id: str
    user_name: str
    latitude: float
    longitude: float
    accuracy: float = 3.0
    contacts: List[GuardianContact] = []
    message: Optional[str] = "EMERGENCY SOS: Immediate assistance required!"

class SOSState(BaseModel):
    sos_id: str
    user_id: str
    user_name: str
    latitude: float
    longitude: float
    timestamp: float
    active: bool
    tracking_token: str
    sms_logs: List[Dict[str, Any]] = []

class ScenarioDefinition(BaseModel):
    scenario_id: str
    name: str
    description: str
    vehicle_a: Dict[str, Any]
    vehicle_b: Dict[str, Any]
    expected_t_star: Optional[float]
    expected_d_min: Optional[float]
    expected_decision: str

