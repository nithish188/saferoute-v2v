"""
Collision Prediction Engine
Implements Section IV-E, IV-F of IEEE paper:
- Relative position r = pj - pi
- Relative velocity u = Vj - Vi
- Time of closest approach t* = - (r . u) / |u|^2 (Eq. 7)
- Minimum distance dmin = | r + u * t* | (Eq. 8)
- Collision risk condition: 0 < t* <= Th and dmin <= Dsafe (Eq. 9)
- Dynamic safety distance: Dsafe = Dv + k * max(ai, aj) (Eq. 10)
- Graded Alert Levels: Advisory (<=10s), Warning (<=6s), Critical (<=3s)
- Spoken audio warnings & relative bearing (Front, Right, Rear, Left)
- Impact point projection & cooldown management
"""

import math
import time
from typing import Dict, List, Optional, Tuple
from backend.config import (
    PREDICTION_HORIZON_TH,
    VEHICLE_SIZE_MARGIN_DV,
    ACCURACY_FACTOR_K,
    ALERT_THRESHOLD_ADVISORY,
    ALERT_THRESHOLD_WARNING,
    ALERT_THRESHOLD_CRITICAL,
    ALERT_COOLDOWN_SEC,
    DEFAULT_REF_LAT,
    DEFAULT_REF_LON
)
from backend.models import VehicleState, Alert, AlertLevel, RelativeBearing
from backend.estimator import classify_relative_bearing, unproject_from_local_plane

class PredictionResult:
    def __init__(self,
                 t_star: Optional[float],
                 d_min: float,
                 d_safe: float,
                 is_risk: bool,
                 level: AlertLevel,
                 r_dot_u: float,
                 u_sq: float):
        self.t_star = t_star
        self.d_min = d_min
        self.d_safe = d_safe
        self.is_risk = is_risk
        self.level = level
        self.r_dot_u = r_dot_u
        self.u_sq = u_sq

class CollisionPredictionEngine:
    def __init__(self,
                 t_horizon: float = PREDICTION_HORIZON_TH,
                 d_v: float = VEHICLE_SIZE_MARGIN_DV,
                 k: float = ACCURACY_FACTOR_K,
                 cooldown_sec: float = ALERT_COOLDOWN_SEC,
                 ref_lat: float = DEFAULT_REF_LAT,
                 ref_lon: float = DEFAULT_REF_LON):
        self.t_horizon = t_horizon
        self.d_v = d_v
        self.k = k
        self.cooldown_sec = cooldown_sec
        self.ref_lat = ref_lat
        self.ref_lon = ref_lon
        # pair_key -> timestamp of last emitted alert
        self.alert_history: Dict[Tuple[str, str], float] = {}

    def compute_closest_approach(self,
                                 vi: VehicleState,
                                 vj: VehicleState) -> PredictionResult:
        """
        Analytically computes closest approach (Eq. 7, 8, 9, 10) between two vehicles.
        """
        # Relative position r = pj - pi
        rx = vj.pos_x - vi.pos_x
        ry = vj.pos_y - vi.pos_y

        # Relative velocity u = Vj - Vi
        ux = vj.vel_x - vi.vel_x
        uy = vj.vel_y - vi.vel_y

        r_dot_u = rx * ux + ry * uy
        u_sq = ux * ux + uy * uy

        # Safe distance threshold (Eq. 10)
        # Cap GPS accuracy contribution to prevent false positive explosion from cell/wifi geolocation
        eff_acc = min(max(vi.accuracy, vj.accuracy), 3.0)
        d_safe = self.d_v + self.k * eff_acc

        # Constant separation condition (e.g., Scenario S3 side-by-side or identical velocities)
        if u_sq < 1e-4:
            # Vehicles keep constant separation
            current_distance = math.sqrt(rx * rx + ry * ry)
            return PredictionResult(
                t_star=None,
                d_min=round(current_distance, 2),
                d_safe=round(d_safe, 2),
                is_risk=False,
                level=AlertLevel.NONE,
                r_dot_u=r_dot_u,
                u_sq=u_sq
            )

        # Closest approach time (Eq. 7)
        t_star = - (r_dot_u) / u_sq

        # Closest approach separation (Eq. 8)
        # Note: If t* < 0, closest approach occurred in the past and vehicles are moving apart.
        # Future minimum separation in t >= 0 is current separation |r| (as reported in Table III Scenario S5).
        if t_star < 0:
            d_min = math.sqrt(rx * rx + ry * ry)
        else:
            rx_min = rx + ux * t_star
            ry_min = ry + uy * t_star
            d_min = math.sqrt(rx_min * rx_min + ry_min * ry_min)

        dist_now = math.sqrt(rx * rx + ry * ry)

        # Directional verification: ensure vehicle is actually approaching along line of sight
        # Prevents false warnings when a vehicle drives perpendicular on an elevated flyover or parallel road
        if vi.speed_smoothed < 1.0 and vj.speed_smoothed >= 1.0 and dist_now > 5.0:
            cos_approach_j = (-rx * vj.vel_x - ry * vj.vel_y) / (dist_now * max(0.1, vj.speed_smoothed))
            if cos_approach_j < 0.5:
                return PredictionResult(
                    t_star=round(t_star, 2) if t_star else None,
                    d_min=round(d_min, 2),
                    d_safe=round(d_safe, 2),
                    is_risk=False,
                    level=AlertLevel.NONE,
                    r_dot_u=r_dot_u,
                    u_sq=u_sq
                )
        elif vj.speed_smoothed < 1.0 and vi.speed_smoothed >= 1.0 and dist_now > 5.0:
            cos_approach_i = (rx * vi.vel_x + ry * vi.vel_y) / (dist_now * max(0.1, vi.speed_smoothed))
            if cos_approach_i < 0.5:
                return PredictionResult(
                    t_star=round(t_star, 2) if t_star else None,
                    d_min=round(d_min, 2),
                    d_safe=round(d_safe, 2),
                    is_risk=False,
                    level=AlertLevel.NONE,
                    r_dot_u=r_dot_u,
                    u_sq=u_sq
                )

        # Check condition (Eq. 9): 0 < t* <= Th and dmin <= Dsafe
        is_risk = False
        level = AlertLevel.NONE

        if 0.0 < t_star <= self.t_horizon and d_min <= d_safe:
            is_risk = True
            if t_star <= ALERT_THRESHOLD_CRITICAL:
                level = AlertLevel.CRITICAL
            elif t_star <= ALERT_THRESHOLD_WARNING:
                level = AlertLevel.WARNING
            else:
                level = AlertLevel.ADVISORY

        return PredictionResult(
            t_star=round(t_star, 2),
            d_min=round(d_min, 2),
            d_safe=round(d_safe, 2),
            is_risk=is_risk,
            level=level,
            r_dot_u=r_dot_u,
            u_sq=u_sq
        )

    def generate_alerts_for_pair(self,
                                 vi: VehicleState,
                                 vj: VehicleState,
                                 current_time: float = None) -> List[Alert]:
        """
        Evaluates pair (vi, vj) and generates mutual alerts if risk is detected.
        Applies bearing classification and spoken audio prompt generation.
        """
        if current_time is None:
            current_time = time.time()

        res = self.compute_closest_approach(vi, vj)
        if not res.is_risk or res.level == AlertLevel.NONE:
            return []

        pair_key = tuple(sorted([vi.vehicle_id, vj.vehicle_id]))
        # Cooldown check
        last_alert_time = self.alert_history.get(pair_key, 0.0)
        # We always return alerts for real-time visualization, but flag audio cooldown if needed
        self.alert_history[pair_key] = current_time

        # Calculate impact point in local coordinates and project to lat/lon
        impact_x = vi.pos_x + vi.vel_x * res.t_star
        impact_y = vi.pos_y + vi.vel_y * res.t_star
        impact_lat, impact_lon = unproject_from_local_plane(
            impact_x, impact_y, self.ref_lat, self.ref_lon
        )

        alerts: List[Alert] = []

        # Generate alert for vehicle i (warning about vehicle j)
        alert_i = self._build_directional_alert(
            target=vi,
            source=vj,
            res=res,
            current_time=current_time,
            impact_lat=impact_lat,
            impact_lon=impact_lon
        )
        alerts.append(alert_i)

        # Generate alert for vehicle j (warning about vehicle i)
        alert_j = self._build_directional_alert(
            target=vj,
            source=vi,
            res=res,
            current_time=current_time,
            impact_lat=impact_lat,
            impact_lon=impact_lon
        )
        alerts.append(alert_j)

        return alerts

    def _build_directional_alert(self,
                                 target: VehicleState,
                                 source: VehicleState,
                                 res: PredictionResult,
                                 current_time: float,
                                 impact_lat: float,
                                 impact_lon: float) -> Alert:
        """
        Builds user-tailored directional alert with bearing (front, right, rear, left)
        and speech synthesis text as required by Section IV-F.
        """
        # Vector from target to source
        dx = source.pos_x - target.pos_x
        dy = source.pos_y - target.pos_y
        los_rad = math.atan2(dx, dy)
        los_deg = (math.degrees(los_rad) + 360.0) % 360.0

        rel_bearing, rel_angle = classify_relative_bearing(target.heading_deg, los_deg)

        sec_rounded = max(1, int(round(res.t_star)))
        bearing_str = rel_bearing.value

        level_name = res.level.value.upper()
        msg = f"{level_name}: Vehicle approaching from the {bearing_str} in {sec_rounded}s (min dist: {res.d_min:.1f}m)"
        spoken = f"{level_name.capitalize()}: Vehicle approaching from the {bearing_str}, {sec_rounded} seconds"

        return Alert(
            alert_id=f"alt_{target.vehicle_id}_{source.vehicle_id}_{int(current_time*1000)}",
            timestamp=current_time,
            level=res.level,
            source_vehicle_id=source.vehicle_id,
            target_vehicle_id=target.vehicle_id,
            t_star=res.t_star,
            d_min=res.d_min,
            d_safe=res.d_safe,
            relative_bearing=rel_bearing,
            bearing_deg=round(rel_angle, 1),
            message=msg,
            spoken_text=spoken,
            target_pos={"lat": target.latitude, "lon": target.longitude},
            source_pos={"lat": source.latitude, "lon": source.longitude},
            impact_point={"lat": impact_lat, "lon": impact_lon}
        )
