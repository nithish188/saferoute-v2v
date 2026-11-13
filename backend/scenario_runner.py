"""
Analytical Scenario Runner
Replicates Section VI-B & Table III of IEEE paper:
- S1 Side-road junction (15 m/s north vs 10 m/s east -> t*=6.0s, dmin=0.0m -> Warning)
- S2 Rear approach (10 m/s north vs 20 m/s north, 30m behind -> t*=3.0s, dmin=0.0m -> Critical)
- S3 Side by side (12 m/s north vs 12 m/s north, 3.5m apart -> t*=none, dmin=3.5m -> No alert)
- S4 Crossing, late (15 m/s north vs 10 m/s east, 150m west -> t*=8.8s, dmin=74.9m -> No alert)
- S5 Moving apart (10 m/s north vs 20 m/s north, 40m ahead -> t*=-4.0s, dmin=40.0m -> No alert)
"""

import math
import time
from typing import Dict, Any, List
from backend.config import DEFAULT_REF_LAT, DEFAULT_REF_LON
from backend.models import VehicleState, VehicleRole, AlertLevel
from backend.estimator import unproject_from_local_plane, build_velocity_vector
from backend.prediction_engine import CollisionPredictionEngine

class ScenarioEvaluator:
    def __init__(self, ref_lat: float = DEFAULT_REF_LAT, ref_lon: float = DEFAULT_REF_LON):
        self.ref_lat = ref_lat
        self.ref_lon = ref_lon
        self.engine = CollisionPredictionEngine(ref_lat=ref_lat, ref_lon=ref_lon)

    def get_predefined_scenarios(self) -> Dict[str, Dict[str, Any]]:
        return {
            "S1": {
                "id": "S1",
                "name": "Side-road junction",
                "description": "Vehicle A travels north at 15 m/s (54 km/h); Vehicle B approaches from a side road on the left (60 m west, 90 m north) moving east at 10 m/s (36 km/h). Both reach the junction simultaneously.",
                "vehicle_a": {
                    "id": "veh_A",
                    "name": "Vehicle A (Main Road)",
                    "pos_x": 0.0,
                    "pos_y": 0.0,
                    "speed": 15.0,
                    "heading": 0.0,  # North
                    "accuracy": 3.0
                },
                "vehicle_b": {
                    "id": "veh_B",
                    "name": "Vehicle B (Side Road)",
                    "pos_x": -60.0,
                    "pos_y": 90.0,
                    "speed": 10.0,
                    "heading": 90.0,  # East
                    "accuracy": 3.0
                },
                "expected": {
                    "t_star": 6.0,
                    "d_min": 0.0,
                    "d_safe": 6.5,
                    "decision": "Warning",
                    "reason": "Closest approach occurs in 6.0 s with 0.0 m separation (<= 6.5 m safe distance)."
                }
            },
            "S2": {
                "id": "S2",
                "name": "Rear approach",
                "description": "Vehicle A travels north at 10 m/s (36 km/h); faster Vehicle B travels north at 20 m/s (72 km/h) starting 30 m behind A.",
                "vehicle_a": {
                    "id": "veh_A",
                    "name": "Vehicle A (Lead Car)",
                    "pos_x": 0.0,
                    "pos_y": 0.0,
                    "speed": 10.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "vehicle_b": {
                    "id": "veh_B",
                    "name": "Vehicle B (Overtaking Car)",
                    "pos_x": 0.0,
                    "pos_y": -30.0,
                    "speed": 20.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "expected": {
                    "t_star": 3.0,
                    "d_min": 0.0,
                    "d_safe": 6.5,
                    "decision": "Critical",
                    "reason": "Closest approach occurs in 3.0 s with 0.0 m separation (<= 3.0 s critical threshold)."
                }
            },
            "S3": {
                "id": "S3",
                "name": "Side by side",
                "description": "Two vehicles travel parallel in adjacent lanes at identical velocities (12 m/s north) with 3.5 m separation.",
                "vehicle_a": {
                    "id": "veh_A",
                    "name": "Vehicle A (Lane 1)",
                    "pos_x": 0.0,
                    "pos_y": 0.0,
                    "speed": 12.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "vehicle_b": {
                    "id": "veh_B",
                    "name": "Vehicle B (Lane 2)",
                    "pos_x": 3.5,
                    "pos_y": 0.0,
                    "speed": 12.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "expected": {
                    "t_star": None,
                    "d_min": 3.5,
                    "d_safe": 6.5,
                    "decision": "No alert",
                    "reason": "Relative velocity is 0 m/s; vehicles maintain constant separation and will never collide."
                }
            },
            "S4": {
                "id": "S4",
                "name": "Crossing, late",
                "description": "Vehicle A travels north at 15 m/s; Vehicle B travels east at 10 m/s from 150 m west and 90 m north. Paths cross, but arrival times differ significantly.",
                "vehicle_a": {
                    "id": "veh_A",
                    "name": "Vehicle A",
                    "pos_x": 0.0,
                    "pos_y": 0.0,
                    "speed": 15.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "vehicle_b": {
                    "id": "veh_B",
                    "name": "Vehicle B",
                    "pos_x": -150.0,
                    "pos_y": 90.0,
                    "speed": 10.0,
                    "heading": 90.0,
                    "accuracy": 3.0
                },
                "expected": {
                    "t_star": 8.8,
                    "d_min": 74.9,
                    "d_safe": 6.5,
                    "decision": "No alert",
                    "reason": "Minimum separation at closest approach is 74.9 m, far exceeding Dsafe (6.5 m)."
                }
            },
            "S5": {
                "id": "S5",
                "name": "Moving apart",
                "description": "Vehicle A travels north at 10 m/s; Vehicle B travels north at 20 m/s starting 40 m ahead.",
                "vehicle_a": {
                    "id": "veh_A",
                    "name": "Vehicle A",
                    "pos_x": 0.0,
                    "pos_y": 0.0,
                    "speed": 10.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "vehicle_b": {
                    "id": "veh_B",
                    "name": "Vehicle B",
                    "pos_x": 0.0,
                    "pos_y": 40.0,
                    "speed": 20.0,
                    "heading": 0.0,
                    "accuracy": 3.0
                },
                "expected": {
                    "t_star": -4.0,
                    "d_min": 40.0,
                    "d_safe": 6.5,
                    "decision": "No alert",
                    "reason": "t* is negative (-4.0 s); distance between vehicles is increasing."
                }
            }
        }

    def run_scenario(self, scenario_id: str) -> Dict[str, Any]:
        scenarios = self.get_predefined_scenarios()
        if scenario_id not in scenarios:
            raise ValueError(f"Unknown scenario ID: {scenario_id}")

        sc = scenarios[scenario_id]
        v_a_cfg = sc["vehicle_a"]
        v_b_cfg = sc["vehicle_b"]

        lat_a, lon_a = unproject_from_local_plane(v_a_cfg["pos_x"], v_a_cfg["pos_y"], self.ref_lat, self.ref_lon)
        lat_b, lon_b = unproject_from_local_plane(v_b_cfg["pos_x"], v_b_cfg["pos_y"], self.ref_lat, self.ref_lon)

        vx_a, vy_a = build_velocity_vector(v_a_cfg["speed"], v_a_cfg["heading"])
        vx_b, vy_b = build_velocity_vector(v_b_cfg["speed"], v_b_cfg["heading"])

        now = time.time()
        va = VehicleState(
            vehicle_id=v_a_cfg["id"],
            label=v_a_cfg["name"],
            role=VehicleRole.STANDARD,
            latitude=lat_a,
            longitude=lon_a,
            accuracy=v_a_cfg["accuracy"],
            speed_raw=v_a_cfg["speed"],
            speed_smoothed=v_a_cfg["speed"],
            heading_deg=v_a_cfg["heading"],
            pos_x=v_a_cfg["pos_x"],
            pos_y=v_a_cfg["pos_y"],
            vel_x=vx_a,
            vel_y=vy_a,
            timestamp=now,
            last_update_monotonic=now
        )

        vb = VehicleState(
            vehicle_id=v_b_cfg["id"],
            label=v_b_cfg["name"],
            role=VehicleRole.STANDARD,
            latitude=lat_b,
            longitude=lon_b,
            accuracy=v_b_cfg["accuracy"],
            speed_raw=v_b_cfg["speed"],
            speed_smoothed=v_b_cfg["speed"],
            heading_deg=v_b_cfg["heading"],
            pos_x=v_b_cfg["pos_x"],
            pos_y=v_b_cfg["pos_y"],
            vel_x=vx_b,
            vel_y=vy_b,
            timestamp=now,
            last_update_monotonic=now
        )

        res = self.engine.compute_closest_approach(va, vb)
        alerts = self.engine.generate_alerts_for_pair(va, vb, now)

        decision_map = {
            AlertLevel.CRITICAL: "Critical",
            AlertLevel.WARNING: "Warning",
            AlertLevel.ADVISORY: "Advisory",
            AlertLevel.NONE: "No alert"
        }
        computed_decision = decision_map.get(res.level, "No alert")

        # Step by step analytical calculations
        rx = v_b_cfg["pos_x"] - v_a_cfg["pos_x"]
        ry = v_b_cfg["pos_y"] - v_a_cfg["pos_y"]
        ux = vx_b - vx_a
        uy = vy_b - vy_a

        return {
            "scenario_id": scenario_id,
            "name": sc["name"],
            "description": sc["description"],
            "analytical_steps": {
                "r_vector": [round(rx, 2), round(ry, 2)],
                "u_vector": [round(ux, 2), round(uy, 2)],
                "r_dot_u": round(res.r_dot_u, 2),
                "u_squared": round(res.u_sq, 2),
                "t_star": res.t_star,
                "d_min": res.d_min,
                "d_safe": res.d_safe,
                "computed_decision": computed_decision,
                "expected": sc["expected"]
            },
            "vehicles": {
                "A": va.model_dump(),
                "B": vb.model_dump()
            },
            "alerts": [a.model_dump() for a in alerts]
        }
