"""
Speed, Heading, Projection and Bearing Estimator
Implements Section IV-B, IV-C, IV-F of IEEE paper:
- Haversine Distance (Eq. 1)
- Raw Speed & Exponential Smoothing (Eq. 2, Eq. 3)
- Forward Bearing / Heading (Eq. 4)
- Local Tangent Plane Projection (Eq. 5)
- Velocity Vector Generation (Eq. 6)
- Relative Bearing Angle Classification (Section IV-F)
"""

import math
from typing import Tuple
from backend.config import EARTH_RADIUS_M, SPEED_SMOOTHING_ALPHA
from backend.models import RelativeBearing

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Computes ground distance using Haversine formula (Eq. 1):
    d = 2R arcsin( sqrt( sin^2(dphi/2) + cos(phi1)*cos(phi2)*sin^2(dlambda/2) ) )
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    a = min(1.0, max(0.0, a))
    c = 2.0 * math.asin(math.sqrt(a))
    return EARTH_RADIUS_M * c

def calculate_heading(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Computes initial bearing / heading clockwise from true North in degrees [0, 360) (Eq. 4):
    Y = sin(dlambda) * cos(phi2)
    X = cos(phi1)*sin(phi2) - sin(phi1)*cos(phi2)*cos(dlambda)
    theta = atan2(Y, X)
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_lambda = math.radians(lon2 - lon1)

    y = math.sin(delta_lambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta_lambda)

    bearing_rad = math.atan2(y, x)
    bearing_deg = (math.degrees(bearing_rad) + 360.0) % 360.0
    return bearing_deg

def smooth_speed(raw_speed: float, previous_smoothed: float, alpha: float = SPEED_SMOOTHING_ALPHA) -> float:
    """
    Applies exponential filter to suppress GPS jitter (Eq. 3):
    v_hat_k = alpha * v_k + (1 - alpha) * v_hat_k-1
    """
    if previous_smoothed <= 0.0:
        return raw_speed
    return alpha * raw_speed + (1.0 - alpha) * previous_smoothed

def project_to_local_plane(lat: float, lon: float, ref_lat: float, ref_lon: float) -> Tuple[float, float]:
    """
    Projects latitude and longitude onto a local Cartesian tangent plane (Eq. 5):
    x = R * (lambda - lambda0) * cos(phi0)  [East, meters]
    y = R * (phi - phi0)                    [North, meters]
    """
    ref_phi_rad = math.radians(ref_lat)
    delta_lambda_rad = math.radians(lon - ref_lon)
    delta_phi_rad = math.radians(lat - ref_lat)

    x = EARTH_RADIUS_M * delta_lambda_rad * math.cos(ref_phi_rad)
    y = EARTH_RADIUS_M * delta_phi_rad
    return x, y

def unproject_from_local_plane(x: float, y: float, ref_lat: float, ref_lon: float) -> Tuple[float, float]:
    """
    Inverse projection from local Cartesian tangent plane back to lat/lon.
    """
    ref_phi_rad = math.radians(ref_lat)
    delta_phi_rad = y / EARTH_RADIUS_M
    delta_lambda_rad = x / (EARTH_RADIUS_M * math.cos(ref_phi_rad))

    lat = ref_lat + math.degrees(delta_phi_rad)
    lon = ref_lon + math.degrees(delta_lambda_rad)
    return lat, lon

def build_velocity_vector(speed: float, heading_deg: float) -> Tuple[float, float]:
    """
    Builds 2D velocity vector V = v_hat * (sin(theta), cos(theta)) (Eq. 6)
    Vx = speed * sin(theta) [East component]
    Vy = speed * cos(theta) [North component]
    """
    theta_rad = math.radians(heading_deg)
    vx = speed * math.sin(theta_rad)
    vy = speed * math.cos(theta_rad)
    return vx, vy

def classify_relative_bearing(source_heading_deg: float, los_bearing_deg: float) -> Tuple[RelativeBearing, float]:
    """
    Classifies the relative bearing of an approaching vehicle relative to driver's heading:
    front, right, rear, left (Section IV-F).
    """
    rel_angle = (los_bearing_deg - source_heading_deg + 360.0) % 360.0

    if rel_angle <= 45.0 or rel_angle >= 315.0:
        return RelativeBearing.FRONT, rel_angle
    elif 45.0 < rel_angle <= 135.0:
        return RelativeBearing.RIGHT, rel_angle
    elif 135.0 < rel_angle <= 225.0:
        return RelativeBearing.REAR, rel_angle
    else:
        return RelativeBearing.LEFT, rel_angle

