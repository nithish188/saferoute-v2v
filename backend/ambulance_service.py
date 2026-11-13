"""
Emergency Vehicle Clearance Service (Ambulance Mode)
Implements Section V-A of IEEE paper:
- Ambulance position pE, heading unit vector hE
- Distance ahead: sj = (pj - pE) . hE (Eq. 11)
- Sideways cross-track offset: lj = (pj - pE) x hE (Eq. 12)
- Give-way condition: 0 < sj <= Le (500m) and |lj| <= we (30m)
- Corridor polygon computation for map overlay
"""

import math
import time
from typing import Dict, List, Optional, Tuple, Any
from backend.config import (
    AMBULANCE_CORRIDOR_LENGTH_LE,
    AMBULANCE_CORRIDOR_HALF_WIDTH_WE,
    DEFAULT_REF_LAT,
    DEFAULT_REF_LON
)
from backend.models import VehicleState, Alert, AlertLevel, RelativeBearing
from backend.estimator import unproject_from_local_plane, haversine_distance

class AmbulanceClearanceService:
    def __init__(self,
                 le: float = AMBULANCE_CORRIDOR_LENGTH_LE,
                 we: float = AMBULANCE_CORRIDOR_HALF_WIDTH_WE,
                 ref_lat: float = DEFAULT_REF_LAT,
                 ref_lon: float = DEFAULT_REF_LON):
        self.le = le  # 750 m corridor length ahead in ambulance mode
        self.we = we  # 30 m corridor half-width
        self.ref_lat = ref_lat
        self.ref_lon = ref_lon

    def evaluate_clearance(self,
                           ambulance: VehicleState,
                           vehicles: Dict[str, VehicleState],
                           current_time: float = None,
                           route_coords: Optional[List[List[float]]] = None) -> Tuple[List[Alert], Dict[str, Any]]:
        """
        Calculates vehicles directly inside the ambulance corridor and along the ambulance's route within 750m.
        Generates continuous clearance alerts for all vehicles in the ambulance path.
        """
        if current_time is None:
            current_time = time.time()

        alerts: List[Alert] = []
        vehicles_in_corridor: List[str] = []

        # Ambulance heading unit vector hE = (sin theta_E, cos theta_E)
        theta_rad = math.radians(ambulance.heading_deg)
        hx = math.sin(theta_rad)
        hy = math.cos(theta_rad)

        xe, ye = ambulance.pos_x, ambulance.pos_y

        for v_id, vj in vehicles.items():
            if v_id == ambulance.vehicle_id or not vj.is_active:
                continue

            # 1. Delta vector: pj - pE
            dx = vj.pos_x - xe
            dy = vj.pos_y - ye

            # Eq. 11: Longitudinal distance ahead
            sj = dx * hx + dy * hy

            # Eq. 12: Sideways offset (2D cross product: dx * hy - dy * hx)
            lj = dx * hy - dy * hx

            is_in_path = False
            dist_ahead = sj

            # Condition A: Straight-ahead 750m corridor
            if 0.0 < sj <= self.le and abs(lj) <= self.we:
                is_in_path = True
                dist_ahead = sj
            # Condition B: If ambulance has an active planned route, check if vehicle is on route ahead up to 750m
            elif route_coords and len(route_coords) > 1:
                dist_direct = haversine_distance(ambulance.latitude, ambulance.longitude, vj.latitude, vj.longitude)
                if dist_direct <= self.le:
                    # Check proximity to planned route waypoints
                    for pt in route_coords:
                        d_amb_to_pt = haversine_distance(ambulance.latitude, ambulance.longitude, pt[0], pt[1])
                        if d_amb_to_pt <= self.le:
                            d_vj_to_pt = haversine_distance(vj.latitude, vj.longitude, pt[0], pt[1])
                            if d_vj_to_pt <= 35.0:  # within 35m of route
                                is_in_path = True
                                dist_ahead = dist_direct
                                break

            if is_in_path:
                vehicles_in_corridor.append(v_id)
                dist_ahead_rounded = max(10, int(round(dist_ahead)))

                alert = Alert(
                    alert_id=f"amb_clr_{v_id}_{int(current_time*1000)}",
                    timestamp=current_time,
                    level=AlertLevel.AMBULANCE_CLEAR,
                    source_vehicle_id=ambulance.vehicle_id,
                    target_vehicle_id=v_id,
                    t_star=None,
                    d_min=round(dist_ahead, 1),
                    d_safe=round(self.we, 1),
                    relative_bearing=RelativeBearing.REAR,
                    bearing_deg=180.0,
                    message=f"🚨 EMERGENCY VEHICLE CLEARANCE: Ambulance approaching ({dist_ahead_rounded}m)! Please pull over to the left immediately.",
                    spoken_text=f"Emergency: Ambulance approaching from behind, {dist_ahead_rounded} meters. Please clear the lane immediately.",
                    target_pos={"lat": vj.latitude, "lon": vj.longitude},
                    source_pos={"lat": ambulance.latitude, "lon": ambulance.longitude}
                )
                alerts.append(alert)

        corridor_poly = self.compute_corridor_polygon(xe, ye, hx, hy)

        summary = {
            "ambulance_id": ambulance.vehicle_id,
            "corridor_length_m": self.le,
            "corridor_half_width_m": self.we,
            "vehicles_cleared_count": len(vehicles_in_corridor),
            "vehicle_ids_in_corridor": vehicles_in_corridor,
            "corridor_polygon_latlng": corridor_poly,
            "is_continuous_broadcast": True
        }

        return alerts, summary

    def compute_corridor_polygon(self, xe: float, ye: float, hx: float, hy: float) -> List[Dict[str, float]]:
        """
        Computes 4 corners of the corridor rectangle on the map:
        Width vector perpendicular to heading: (-hy, hx)
        """
        perp_x = -hy
        perp_y = hx

        # 4 Local points:
        # P1: rear-left near ambulance (slightly back by 5m)
        # P2: rear-right near ambulance
        # P3: front-right at distance Le
        # P4: front-left at distance Le
        rear_offset = -5.0
        p1 = (xe + rear_offset * hx - self.we * perp_x, ye + rear_offset * hy - self.we * perp_y)
        p2 = (xe + rear_offset * hx + self.we * perp_x, ye + rear_offset * hy + self.we * perp_y)
        p3 = (xe + self.le * hx + self.we * perp_x, ye + self.le * hy + self.we * perp_y)
        p4 = (xe + self.le * hx - self.we * perp_x, ye + self.le * hy - self.we * perp_y)

        poly_latlng = []
        for lx, ly in [p1, p2, p3, p4]:
            lat, lon = unproject_from_local_plane(lx, ly, self.ref_lat, self.ref_lon)
            poly_latlng.append({"lat": lat, "lon": lon})

        return poly_latlng

