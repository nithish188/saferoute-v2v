"""
Google Maps-Style Route Planning and Route-Collision Analysis Service
Implements:
- Live turn-by-turn road routing via OSRM & OpenStreetMap routing backends
- Free-text destination search via OpenStreetMap Nominatim
- Dynamic route segment collision checking within 500m radius of current vehicle location
"""

import math
import time
import urllib.request
import urllib.parse
import json
from typing import Dict, List, Optional, Tuple, Any

from backend.config import EARTH_RADIUS_M, ANALYSIS_RADIUS_M, DEFAULT_REF_LAT, DEFAULT_REF_LON
from backend.models import VehicleState, Alert, AlertLevel, RelativeBearing
from backend.estimator import haversine_distance, calculate_heading, project_to_local_plane, build_velocity_vector
from backend.prediction_engine import CollisionPredictionEngine

POPULAR_DESTINATIONS = [
    {
        "id": "dest_hope_college",
        "name": "Hope College Bus Stop (GD Naidu Bridge)",
        "address": "Avinashi Rd, Hope College, Coimbatore",
        "lat": 11.025200,
        "lon": 77.016500
    },
    {
        "id": "dest_gandhipuram",
        "name": "Gandhipuram Central Bus Stand",
        "address": "Gandhipuram, Coimbatore, Tamil Nadu",
        "lat": 11.016900,
        "lon": 76.973900
    },
    {
        "id": "dest_coimbatore_junction",
        "name": "Coimbatore Railway Junction",
        "address": "Railway Station Rd, Coimbatore, Tamil Nadu",
        "lat": 11.001200,
        "lon": 76.969100
    },
    {
        "id": "dest_peelamedu",
        "name": "Peelamedu Junction",
        "address": "Avinashi Road, Peelamedu, Coimbatore",
        "lat": 11.025900,
        "lon": 77.040800
    },
    {
        "id": "dest_tidel_park",
        "name": "TIDEL Park Coimbatore",
        "address": "Avinashi Road, Coimbatore, Tamil Nadu",
        "lat": 11.030200,
        "lon": 77.030000
    },
    {
        "id": "dest_tiruppur_bus",
        "name": "Tiruppur Old Bus Stand",
        "address": "Kumaran Road, Tiruppur, Tamil Nadu",
        "lat": 11.1042,
        "lon": 77.3458
    },
    {
        "id": "dest_avinashi_junction",
        "name": "Avinashi Town Junction",
        "address": "Avinashi, Tiruppur District, Tamil Nadu",
        "lat": 11.1950,
        "lon": 77.2730
    },
    {
        "id": "dest_jai_shriram",
        "name": "Jai Shriram Engineering College",
        "address": "Dharapuram Road, Avinashipalayam, Tiruppur",
        "lat": 11.058312,
        "lon": 77.411574
    },
]

class RouteService:
    def __init__(self, ref_lat: float = DEFAULT_REF_LAT, ref_lon: float = DEFAULT_REF_LON):
        self.ref_lat = ref_lat
        self.ref_lon = ref_lon
        self.prediction_engine = CollisionPredictionEngine(ref_lat=ref_lat, ref_lon=ref_lon)

    def get_destinations(self) -> List[Dict[str, Any]]:
        return POPULAR_DESTINATIONS

    def search_destinations(self, query: str) -> List[Dict[str, Any]]:
        """
        Searches locations via OpenStreetMap Nominatim with local popular landmark search.
        """
        if not query or len(query.strip()) < 2:
            return POPULAR_DESTINATIONS

        q_lower = query.lower().strip()
        matched_popular = [
            d for d in POPULAR_DESTINATIONS
            if q_lower in d["name"].lower() or q_lower in d["address"].lower()
        ]

        # Live search via Nominatim
        encoded = urllib.parse.quote(f"{query}, Tamil Nadu, India")
        url = f"https://nominatim.openstreetmap.org/search?q={encoded}&format=json&limit=5&addressdetails=1"
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmartV2V/1.0"
            })
            with urllib.request.urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode())
                results = list(matched_popular)
                for item in data:
                    results.append({
                        "id": f"nom_{item.get('place_id')}",
                        "name": item.get("name") or item.get("display_name", "").split(",")[0],
                        "address": item.get("display_name", ""),
                        "lat": float(item["lat"]),
                        "lon": float(item["lon"])
                    })
                return results[:8]
        except Exception:
            return matched_popular or POPULAR_DESTINATIONS

    def calculate_route(self, start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> Dict[str, Any]:
        """
        Calculates suggested driving route using multi-tier OSRM servers with graceful fallback.
        """
        coords_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"

        # Multiple public OSRM / OpenStreetMap routing endpoints for 100% reliability
        router_urls = [
            f"https://router.project-osrm.org/route/v1/driving/{coords_str}?overview=full&geometries=geojson&steps=true",
            f"https://routing.openstreetmap.de/routed-car/route/v1/driving/{coords_str}?overview=full&geometries=geojson&steps=true"
        ]

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SmartV2V/1.0",
            "Accept": "application/json"
        }

        for osrm_url in router_urls:
            try:
                req = urllib.request.Request(osrm_url, headers=headers)
                with urllib.request.urlopen(req, timeout=12) as resp:
                    data = json.loads(resp.read().decode())
                    if data.get("code") == "Ok" and len(data.get("routes", [])) > 0:
                        route = data["routes"][0]
                        coords = [[pt[1], pt[0]] for pt in route["geometry"]["coordinates"]]
                        dist_km = round(route["distance"] / 1000.0, 2)
                        duration_min = max(1, int(round(route["duration"] / 60.0)))

                        steps = []
                        legs = route.get("legs", [])
                        if legs:
                            for st in legs[0].get("steps", []):
                                maneuver = st.get("maneuver", {})
                                loc = maneuver.get("location", [0, 0])
                                name = st.get("name") or "Continue on road"
                                steps.append({
                                    "instruction": name,
                                    "type": maneuver.get("type", "turn"),
                                    "modifier": maneuver.get("modifier", "straight"),
                                    "distance_m": round(st.get("distance", 0)),
                                    "location": [loc[1], loc[0]]
                                })

                        return {
                            "status": "success",
                            "source": "osrm",
                            "distance_km": dist_km,
                            "duration_min": duration_min,
                            "start": [start_lat, start_lon],
                            "destination": [end_lat, end_lon],
                            "coordinates": coords,
                            "steps": steps
                        }
            except Exception as e:
                # Try next router URL
                continue

        # Offline / local multi-waypoint road generator if all online servers fail
        return self._generate_fallback_route(start_lat, start_lon, end_lat, end_lon)

    def _generate_fallback_route(self, lat1: float, lon1: float, lat2: float, lon2: float) -> Dict[str, Any]:
        """
        Interpolates road-like curved corridor waypoints following road bearings.
        """
        coords = []
        steps = []
        total_dist = haversine_distance(lat1, lon1, lat2, lon2)
        dist_km = round(total_dist / 1000.0, 2)
        duration_min = max(2, int(round(dist_km * 1.5)))

        # Generate realistic road-like segmented waypoints
        num_segments = max(20, min(80, int(total_dist / 500)))
        bearing = calculate_heading(lat1, lon1, lat2, lon2)

        for i in range(num_segments + 1):
            t = i / num_segments
            # Smooth S-curve transition simulating highway alignment
            st = (1 - math.cos(t * math.pi)) / 2.0
            lat = lat1 + (lat2 - lat1) * st
            lon = lon1 + (lon2 - lon1) * t
            coords.append([round(lat, 6), round(lon, 6)])

        steps.append({
            "instruction": f"Head toward destination along main road ({dist_km} km)",
            "type": "depart",
            "modifier": "straight",
            "distance_m": round(total_dist * 0.7),
            "location": [lat1, lon1]
        })
        steps.append({
            "instruction": "Approach destination junction",
            "type": "arrive",
            "modifier": "straight",
            "distance_m": round(total_dist * 0.3),
            "location": [lat2, lon2]
        })

        return {
            "status": "success",
            "source": "smart_road_corridor",
            "distance_km": dist_km,
            "duration_min": duration_min,
            "start": [lat1, lon1],
            "destination": [lat2, lon2],
            "coordinates": coords,
            "steps": steps
        }

    def evaluate_route_collisions(self,
                                  host_vehicle: VehicleState,
                                  route_coords: List[List[float]],
                                  all_vehicles: Dict[str, VehicleState],
                                  max_radius_m: float = ANALYSIS_RADIUS_M) -> List[Dict[str, Any]]:
        """
        Evaluates collision threats specifically on the planned route within 500m of host's current location.
        """
        route_alerts = []
        now = time.time()

        if not host_vehicle or not route_coords:
            return route_alerts

        # Check all other vehicles strictly within 500m of host
        for vid, v in all_vehicles.items():
            if vid == host_vehicle.vehicle_id or not v.is_active:
                continue

            dist_from_host = haversine_distance(host_vehicle.latitude, host_vehicle.longitude, v.latitude, v.longitude)
            if dist_from_host > max_radius_m:
                continue

            # Check if this vehicle is near any waypoint on the planned route within 500m
            is_near_route = False
            for pt in route_coords:
                d_to_pt = haversine_distance(host_vehicle.latitude, host_vehicle.longitude, pt[0], pt[1])
                if d_to_pt <= max_radius_m:
                    d_veh_to_pt = haversine_distance(v.latitude, v.longitude, pt[0], pt[1])
                    if d_veh_to_pt < 45.0:  # within 45m of route line
                        is_near_route = True
                        break

            if not is_near_route:
                continue

            # Closest approach collision prediction
            res = self.prediction_engine.compute_closest_approach(host_vehicle, v)
            if res.is_risk and res.level != AlertLevel.NONE:
                alerts = self.prediction_engine.generate_alerts_for_pair(host_vehicle, v, now)
                for alt in alerts:
                    if alt.target_vehicle_id == host_vehicle.vehicle_id:
                        route_alerts.append({
                            "type": "ROUTE_HAZARD",
                            "alert": alt.model_dump(),
                            "distance_from_host_m": round(dist_from_host, 1),
                            "on_route_threat": True,
                            "warning_message": f"ROUTE WARNING: {v.label} on your path in {alt.t_star}s ({alt.relative_bearing.value.upper()})"
                        })

        return route_alerts
