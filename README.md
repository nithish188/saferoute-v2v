# Smart V2V Collision System
### Smartphone-Based Predictive Collision Warning with Emergency Vehicle Clearance and Women Safety Support

> **Research Paper Implementation**  
> **Authors:** S. Surya, S. Tamilarasan, R. Thirunavukkarasu, K. Vaishnavi  
> **Department:** Computer Science and Engineering  
> **Institution:** Jai Shriram Engineering College, Tiruppur, Tamilnadu, India  

---

## 📌 Executive Summary

Most accident-related automotive applications are **reactive**—forwarding crash coordinates to emergency services only after an impact has occurred. The **Smart V2V Collision System** moves intervention to the seconds before impact by turning ordinary smartphones and Android in-vehicle dashboard displays into vehicle-to-vehicle (V2V) collision avoidance nodes without requiring costly dedicated on-board hardware (DSRC/OBU).

This project implements the entire IEEE paper specification, featuring:
1. **Google Maps-Like User Interface** with high-resolution vector/satellite/night maps, turn navigation banner, Google-style speedometer, and rotating heading directional markers.
2. **Predictive Closest-Approach Engine** implementing analytical equations (1)–(10) to compute $t^*$, $d_{min}$, and dynamic error margins $D_{safe}$.
3. **Emergency Vehicle Clearance (Ambulance Mode)** implementing equations (11)–(12) with a $500\text{ m} \times 30\text{ m}$ priority corridor.
4. **Women Safety Mode** featuring an opt-in one-touch SOS panic trigger, live tracking URL generation, simulated SMS gateway outbox, and distress alarms.
5. **Interactive Analytical Workbench** verifying all 5 representative scenarios from **Table III** with 100% mathematical precision.
6. **Real Device GPS Support** connecting smartphone browser GPS to the server via HTML5 Geolocation API.

---

## 🏛️ System Architecture (Fig. 2)

The system is structured in four decoupled layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Client Layer (Android / Web)                      │
│   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────┐ │
│   │    Driver Mode     │   │   Ambulance Mode   │   │  Women Safety  │ │
│   │ Map & Alerts Radar │   │Priority Clearance  │   │  (SOS Panic)   │ │
│   └────────────────────┘   └────────────────────┘   └────────────────┘ │
│                     Location Service (GPS Fused)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS / WebSocket (JSON Stream)
┌───────────────────────────────────▼────────────────────────────────────┐
│                          Communication Layer                           │
│   • Bi-directional WebSockets (`/ws/stream`)                           │
│   • REST Ingestion API (`/api/telemetry`)                              │
│   • Simulated SMS Gateway & Push Dispatcher (`/api/sos/sms-log`)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                         Backend Server Layer                           │
│   ┌────────────────────────────────┐ ┌───────────────────────────────┐ │
│   │ Location Ingestion & Timestamp │ │ Speed & Heading Estimator     │ │
│   ├────────────────────────────────┤ ├───────────────────────────────┤ │
│   │ Spatial Grid Index (Rs = 300m) │ │ Collision Prediction Engine   │ │
│   ├────────────────────────────────┤ ├───────────────────────────────┤ │
│   │ Alert Dispatcher (TTS Voice)   │ │ Emergency Ambulance & SOS     │ │
│   └────────────────────────────────┘ └───────────────────────────────┘ │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Data Layer (SQLite Store)                        │
│   • Live Positions • User & Guardian DB • Event & Collision Logs       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📐 Mathematical Formulation (Section IV & V)

### 1. Distance, Speed & Heading (Eq. 1 – 4)
* **Haversine Distance:**
  $$d = 2R \arcsin \sqrt{\sin^2(\Delta\phi/2) + \cos\phi_1 \cos\phi_2 \sin^2(\Delta\lambda/2)}$$
* **Exponential Speed Smoothing:**
  $$v = d / \Delta t, \quad \hat{v}_k = \alpha v_k + (1-\alpha) \hat{v}_{k-1} \quad (\alpha = 0.6)$$
* **Heading Bearing:**
  $$\theta = \text{atan2}(\sin\Delta\lambda \cos\phi_2, \, \cos\phi_1\sin\phi_2 - \sin\phi_1\cos\phi_2\cos\Delta\lambda)$$

### 2. Local Tangent Plane & Velocity Vectors (Eq. 5 – 6)
* Reference coordinate $(\phi_0, \lambda_0)$ around Jai Shriram Engineering College (11.0583° N, 77.4116° E):
  $$x = R(\lambda - \lambda_0)\cos\phi_0, \quad y = R(\phi - \phi_0)$$
  $$\mathbf{V} = \hat{v}(\sin\theta, \, \cos\theta)$$

### 3. Closest Approach Prediction (Eq. 7 – 10)
Given relative position $\mathbf{r} = \mathbf{p}_j - \mathbf{p}_i$ and relative velocity $\mathbf{u} = \mathbf{V}_j - \mathbf{V}_i$:
* **Time of Closest Approach:**
  $$t^* = - \frac{\mathbf{r} \cdot \mathbf{u}}{|\mathbf{u}|^2}$$
* **Separation at Closest Approach:**
  $$d_{min} = |\mathbf{r} + \mathbf{u}t^*|$$
* **Dynamic Safety Threshold (widened for GPS inaccuracy):**
  $$D_{safe} = D_v + k \cdot \max(a_i, a_j) = 2.0 + 1.5 \times 3.0 = 6.5\text{ m}$$
* **Collision Alert Condition:**
  $$0 < t^* \le 10\text{ s} \quad \text{and} \quad d_{min} \le D_{safe}$$

### 4. Alert Level Grading (Section IV-F)
| Level | Time Condition | Spoken Audio Prompt Example |
| :--- | :--- | :--- |
| **Advisory** | $6 < t^* \le 10\text{ s}$ | *"Advisory: Vehicle approaching from the left, 8 seconds"* |
| **Warning** | $3 < t^* \le 6\text{ s}$ | *"Warning: Vehicle approaching from the right, 5 seconds"* |
| **Critical** | $0 < t^* \le 3\text{ s}$ | *"Critical alert: Vehicle approaching from the front, 2 seconds"* |

### 5. Ambulance Priority Corridor (Eq. 11 – 12)
Ambulance position $\mathbf{p}_E$, heading unit vector $\mathbf{h}_E$:
* Longitudinal distance ahead: $s_j = (\mathbf{p}_j - \mathbf{p}_E) \cdot \mathbf{h}_E$
* Sideways cross-track offset: $\ell_j = (\mathbf{p}_j - \mathbf{p}_E) \times \mathbf{h}_E$
* **Give-Way Condition:** Alert vehicle $j$ if and only if:
  $$0 < s_j \le 500\text{ m} \quad \text{and} \quad |\ell_j| \le 30\text{ m}$$

---

## 🧪 Analytical Validation (Table III)

The system was evaluated against the paper's benchmark scenarios ($D_v = 2\text{ m}, k = 1.5, a = 3\text{ m} \implies D_{safe} = 6.5\text{ m}$):

| Scenario | Vehicle A | Vehicle B | Paper $t^*$ | Paper $d_{min}$ | Paper Decision | System Result | Status |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **S1 Side-road junction** | 15 m/s North | 10 m/s East (-60m, 90m) | 6.0 s | 0.0 m | **Warning** | **Warning** | ✅ Verified |
| **S2 Rear approach** | 10 m/s North | 20 m/s North (30m behind) | 3.0 s | 0.0 m | **Critical** | **Critical** | ✅ Verified |
| **S3 Side by side** | 12 m/s North | 12 m/s North (3.5m apart) | None | 3.5 m | **No alert** | **No alert** | ✅ Verified |
| **S4 Crossing, late** | 15 m/s North | 10 m/s East (-150m, 90m) | 8.8 s | 74.9 m | **No alert** | **No alert** | ✅ Verified |
| **S5 Moving apart** | 10 m/s North | 20 m/s North (40m ahead) | -4.0 s | 40.0 m | **No alert** | **No alert** | ✅ Verified |

---

## 🚀 Quick Start Guide

### Prerequisites
* Python 3.10+ (Standard libraries + FastAPI, Uvicorn, WebSockets already installed)
* Any modern web browser (Chrome, Edge, Firefox, Safari)

### Run the System
Simply run the launcher script from the project folder:
```powershell
python run.py
```
This automatically:
1. Detects a free port (default `8080`).
2. Starts the FastAPI & WebSockets backend server.
3. Automatically opens your default web browser to `http://localhost:8080`.

---

## 🕹️ Interactive Features in the Google Maps UI

1. **Google Maps Search & Driving HUD:**
   - Search box with location lookups.
   - Live speedometer circle with km/h, m/s, compass heading, and GPS accuracy.
   - Green navigation banner displaying corridor status and collision radar.
2. **Spoken Voice Warnings (Web Speech API):**
   - Natural spoken text alerts with relative bearing ("Vehicle approaching from the left, 4 seconds").
   - Synthesized warning chimes and critical alarm sirens.
3. **Emergency Ambulance Mode (Section V-A):**
   - Click `🚑 Ambulance Mode` to view the projected $500\text{ m} \times 60\text{ m}$ priority corridor polygon on the road.
   - Selective alerts sent only to vehicles in the path; vehicles on adjacent roads remain undisturbed.
4. **Women Safety Mode (Section V-B):**
   - Click `🛡️ Women Safety SOS` to reveal the large red panic button.
   - Pressing the button dispatches simulated SMS alerts with a **live location tracking link** (`/#guardian?token=...`) to stored guardians.
   - Live location streams continuously until cancelled.
5. **Table III Scenario Workbench:**
   - Click `🧪 Table III Scenarios` in the top chip bar.
   - Select S1, S2, S3, S4, or S5 to view real-time vector calculations ($r \cdot u, |u|^2, t^*, d_{min}$) and watch the simulated cars drive on the map!
6. **Real Phone GPS Mode:**
   - Click `📍 Use Real Phone GPS` to stream your phone's real GPS fixes directly to the server.
7. **In-Vehicle Head Unit / Android Auto Cockpit Mode:**
   - Click `🖥️ In-Vehicle Head Unit HUD` for high-contrast nighttime automotive dashboard display.

---

## 📂 Project Structure

```
jaishriram2 Antigeave/
├── backend/
│   ├── app.py                 # FastAPI backend, REST endpoints & WebSocket broadcaster
│   ├── config.py              # Table II parameters (Ts, Rs, Th, vmin, Dv, k, alpha, Le, we)
│   ├── models.py              # Pydantic schemas (VehicleState, Alert, SOSPayload, etc.)
│   ├── estimator.py           # Haversine, exponential smoothing, heading, plane projection
│   ├── grid_index.py          # Spatial 2D grid index for neighbour selection (Rs = 300m)
│   ├── prediction_engine.py   # Vector closest-approach calculation (Eq. 7 - 10)
│   ├── ambulance_service.py   # Ambulance clearance corridor calculation (Eq. 11 - 12)
│   ├── women_safety.py        # SOS management, guardian SMS simulation & live tracking
│   ├── scenario_runner.py     # Analytical scenario runner reproducing Table III
│   └── database.py            # SQLite storage for persistent telemetry and logs
├── frontend/
│   ├── index.html             # Google Maps Single Page Application
│   ├── css/
│   │   ├── google_maps.css    # Google Maps authentic aesthetic, search bar, chips, HUD
│   │   └── style.css          # SOS panic button, Table III inspector, car markers
│   └── js/
│       ├── app.js             # Core UI state coordinator & WebSocket listener
│       ├── map_controller.js  # Leaflet map engine with Google Roads/Satellite/Night tiles
│       ├── audio_alerts.js    # Spoken voice synthesis & spatial hazard chimes
│       ├── simulation.js      # Table III animator & multi-car traffic simulator
│       └── sos_controller.js  # Women safety SOS trigger, SMS outbox & live link
├── tests/
│   └── test_prediction.py     # Automated unit test suite verifying Table III
├── run.py                     # One-click system launcher
└── README.md                  # Complete documentation and IEEE paper reference
```

---

## 🧪 Unit Testing

Run the automated test suite verifying all formulas and Table III analytical benchmarks:
```powershell
python -m unittest tests/test_prediction.py
```
Output:
```
.....
----------------------------------------------------------------------
Ran 5 tests in 0.003s

OK
```

---

## 📜 Citation & Credits
Implemented faithfully according to the research paper:  
*S. Surya, S. Tamilarasan, R. Thirunavukkarasu, and K. Vaishnavi, "Smart V2V Collision System: Smartphone-Based Predictive Collision Warning with Emergency Vehicle Clearance and Women Safety Support", Department of Computer Science and Engineering, Jai Shriram Engineering College, Tiruppur, Tamilnadu, India.*

