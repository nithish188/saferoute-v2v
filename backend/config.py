"""
Smart V2V Collision System - Configuration & Parameters
Based on IEEE Paper Table II (Design Parameters of the Prototype)
Authors: S. Surya, S. Tamilarasan, R. Thirunavukkarasu, K. Vaishnavi
Department of Computer Science and Engineering, Jai Shriram Engineering College
"""

import math

# Earth Radius for spherical calculations (meters)
EARTH_RADIUS_M = 6371000.0

# Analysis & Observation Zone
ANALYSIS_RADIUS_M = 500.0           # Strict 500m radius analysis zone centered on current user location

# Table II Parameters
LOCATION_UPDATE_PERIOD_TS = 1.0     # Ts = 1 s
NEIGHBOUR_RADIUS_RS = 300.0         # Rs = 300 m (also grid index cell side)
PREDICTION_HORIZON_TH = 10.0        # Th = 10 s
MINIMUM_MOVING_SPEED_VMIN = 2.0     # vmin = 2 m/s (~7.2 km/h)
VEHICLE_SIZE_MARGIN_DV = 2.0        # Dv = 2 m
ACCURACY_FACTOR_K = 1.5             # k = 1.5
SPEED_SMOOTHING_ALPHA = 0.6         # alpha = 0.6

# Alert Level thresholds on t* (seconds)
ALERT_THRESHOLD_ADVISORY = 10.0     # t* <= 10 s
ALERT_THRESHOLD_WARNING = 6.0       # t* <= 6 s
ALERT_THRESHOLD_CRITICAL = 3.0      # t* <= 3 s

# Ambulance Corridor & Radius parameters
AMBULANCE_CORRIDOR_LENGTH_LE = 750.0 # Le = 750 m (Increased from 500m)
AMBULANCE_CORRIDOR_HALF_WIDTH_WE = 30.0 # we = 30 m
AMBULANCE_ANALYSIS_RADIUS_M = 750.0 # 750 m analysis radius in Ambulance Mode

# Alert Cooldown (seconds)
ALERT_COOLDOWN_SEC = 5.0

# Server settings
HOST = "0.0.0.0"
PORT = 8080

# Reference Origin for Local Plane Tangent Projection (Eq. 5)
# GD Naidu Flyover / Avinashi Road / Hope College junction, Coimbatore, Tamil Nadu
DEFAULT_REF_LAT = 11.02580
DEFAULT_REF_LON = 77.01600

