/**
 * Google Maps Controller
 * Replicates Google Maps Android tile rendering, location puck,
 * navigation route polyline, and connected V2V road vehicle presence.
 */

class GoogleMapController {
  constructor(containerId = 'map') {
    this.containerId = containerId;
    this.map = null;
    this.tileLayers = {};
    this.currentTileLayer = null;

    // Default center: Avinashi Rd / GD Naidu Flyover, Coimbatore
    this.defaultLat = 11.02580;
    this.defaultLon = 77.01600;

    // Markers and Layers
    this.hostMarker = null;
    this.accuracyCircle = null; // Leaflet accuracy circle showing real GPS precision
    this.vehicleMarkers = {};
    this.routeCasing = null;
    this.routePolyline = null;
    this.destMarker = null;
    this.radarCircle = null;
    this.hazardMarkers = [];
    this.collisionImpactMarker = null;
    this.collisionTrajectoryLines = [];
    this.ambulanceCorridorLayers = [];
    this.analysisRadiusM = 500.0;
    this.isAmbulanceMode = false;
    this.isSosActive = false;

    this.activeLayerKey = 'google_roads';
  }

  init(startLat, startLon) {
    const lat = startLat || this.defaultLat;
    const lon = startLon || this.defaultLon;

    this.map = L.map(this.containerId, {
      center: [lat, lon],
      zoom: 17,
      zoomControl: false,
      attributionControl: false
    });

    // Authentic High-Quality Google Map Tile Layers (Default & Satellite)
    this.tileLayers = {
      google_roads: L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 21,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
      }),
      google_satellite: L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        maxZoom: 21,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
      }),
      carto_voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd'
      })
    };

    // Try Google Roads first, fallback to Carto Voyager if network blocks Google tiles
    this.currentTileLayer = this.tileLayers.google_roads;
    this.currentTileLayer.addTo(this.map);

    let tileErrorCount = 0;
    this.currentTileLayer.on('tileerror', () => {
      tileErrorCount++;
      if (tileErrorCount > 3 && this.currentTileLayer === this.tileLayers.google_roads) {
        console.warn("Switching to Carto Voyager fallback tiles");
        this.switchLayer('carto_voyager');
      }
    });

    // Custom attribution control (bottom right)
    L.control.attribution({ position: 'bottomright', prefix: 'Google Maps UI • Smart V2V System' }).addTo(this.map);

    return this.map;
  }

  switchLayer(layerKey) {
    if (this.tileLayers[layerKey] && this.currentTileLayer !== this.tileLayers[layerKey]) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = this.tileLayers[layerKey];
      this.currentTileLayer.addTo(this.map);
      this.activeLayerKey = layerKey;
    }
  }

  panTo(lat, lon, zoom = 17) {
    if (!this.map) return;
    this.map.setView([lat, lon], zoom, { animate: true, duration: 0.5 });
  }

  resetNorth() {
    if (!this.map) return;
    // Resets view bearing (Leaflet standard North up)
    const center = this.map.getCenter();
    this.map.panTo(center, { animate: true });
    const icon = document.getElementById('gmaps-compass-icon');
    if (icon) icon.style.transform = 'rotate(0deg)';
  }

  // -------------------------------------------------------------
  // USER LOCATION PUCK (Google Maps Blue Dot + Directional Beam + Accuracy Halo)
  // -------------------------------------------------------------
  updateHostPosition(lat, lon, heading = 0, accuracy = 3.0) {
    if (!this.map) return;
    this.hostLat = lat;
    this.hostLon = lon;

    // When accident scene is frozen, keep host vehicle in its collided state!
    if (this.isAccidentFrozen) {
      return;
    }

    const headingDeg = Math.round(heading || 0);
    const radiusM = Math.max(accuracy || 3.0, 5.0);

    // Google Maps Accuracy Ring (soft blue circular halo matching GPS accuracy)
    if (!this.accuracyCircle) {
      this.accuracyCircle = L.circle([lat, lon], {
        radius: radiusM,
        color: '#1a73e8',
        weight: 1,
        opacity: 0.45,
        fillColor: '#4285f4',
        fillOpacity: 0.12,
        interactive: false
      }).addTo(this.map);
    } else {
      this.accuracyCircle.setLatLng([lat, lon]);
      this.accuracyCircle.setRadius(radiusM);
    }

    const puckHtml = `
      <div class="gmaps-host-puck ${this.isSosActive ? 'sos-beacon' : ''} ${this.isAmbulanceMode ? 'ambulance-beacon' : ''}">
        <div class="gmaps-puck-accuracy-ring"></div>
        <div class="gmaps-puck-beam" style="transform: rotate(${headingDeg}deg);"></div>
        <div class="gmaps-puck-dot"></div>
      </div>
    `;

    const puckIcon = L.divIcon({
      className: 'gmaps-puck-icon-wrapper',
      html: puckHtml,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    if (!this.hostMarker) {
      this.hostMarker = L.marker([lat, lon], { icon: puckIcon, zIndexOffset: 2000 }).addTo(this.map);
    } else {
      this.hostMarker.setLatLng([lat, lon]);
      this.hostMarker.setIcon(puckIcon);
    }

    // Update V2V Analysis Zone (500m standard, 1000m in Ambulance Mode)
    this.updateAnalysisZone(lat, lon, this.analysisRadiusM || 500.0, this.isAmbulanceMode || false);

    // Update compass needle rotation
    const compassIcon = document.getElementById('gmaps-compass-icon');
    if (compassIcon) {
      compassIcon.style.transform = `rotate(${-headingDeg}deg)`;
    }
  }

  // -------------------------------------------------------------
  // V2V RADAR ANALYSIS ZONE (500m Standard / 1000m Ambulance Mode)
  // -------------------------------------------------------------
  updateAnalysisZone(lat, lon, radiusM = 500.0, isAmbulance = false) {
    if (!this.map) return;
    this.analysisRadiusM = radiusM;
    this.isAmbulanceMode = isAmbulance;

    const strokeColor = isAmbulance ? '#dc2626' : '#1a73e8';
    const fillColor = isAmbulance ? '#ef4444' : '#4285f4';
    const fillOpacity = isAmbulance ? 0.09 : 0.04;
    const dashArray = isAmbulance ? '8, 6' : null;

    if (!this.radarCircle) {
      this.radarCircle = L.circle([lat, lon], {
        radius: radiusM,
        color: strokeColor,
        weight: isAmbulance ? 2.5 : 1.5,
        opacity: isAmbulance ? 0.85 : 0.45,
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        dashArray: dashArray,
        interactive: false
      }).addTo(this.map);
    } else {
      this.radarCircle.setLatLng([lat, lon]);
      this.radarCircle.setRadius(radiusM);
      this.radarCircle.setStyle({
        color: strokeColor,
        weight: isAmbulance ? 2.5 : 1.5,
        opacity: isAmbulance ? 0.85 : 0.45,
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        dashArray: dashArray
      });
    }
  }

  showAmbulanceCorridors(corridors) {
    this.clearAmbulanceCorridors();
    if (!corridors || corridors.length === 0) return;

    this.ambulanceCorridorLayers = [];
    corridors.forEach(c => {
      const poly = c.corridor_polygon_latlng;
      if (poly && poly.length >= 4) {
        const latlngs = poly.map(pt => [pt.lat, pt.lon]);
        const layer = L.polygon(latlngs, {
          color: '#dc2626',
          weight: 2.5,
          opacity: 0.9,
          fillColor: '#ef4444',
          fillOpacity: 0.22,
          dashArray: '6, 6'
        }).addTo(this.map);
        this.ambulanceCorridorLayers.push(layer);
      }
    });
  }

  clearAmbulanceCorridors() {
    if (this.ambulanceCorridorLayers && this.ambulanceCorridorLayers.length > 0) {
      this.ambulanceCorridorLayers.forEach(l => this.map.removeLayer(l));
      this.ambulanceCorridorLayers = [];
    }
  }

  setSosBeacon(active) {
    this.isSosActive = active;
    if (this.hostMarker && this.hostMarker.getLatLng()) {
      const latlng = this.hostMarker.getLatLng();
      this.updateHostPosition(latlng.lat, latlng.lng, 0, 5);
    }
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // -------------------------------------------------------------
  // CONNECTED V2V ROAD VEHICLES (Real-time moving vehicles on route)
  // -------------------------------------------------------------
  updateConnectedVehicles(vehicles, myDeviceId, isVisible = false, alerts = []) {
    if (!this.map) return;

    // Retain frozen accident scene vehicles; do not wipe or move them
    if (this.isAccidentFrozen) {
      return;
    }

    // Dynamic radius check: 1000m (1km) in Ambulance Mode, 500m in Standard Mode
    const maxRadius = this.analysisRadiusM || 500.0;

    // Identify which vehicles are part of an active collision alert
    const threatenedVehicles = new Set();
    if (alerts && alerts.length > 0) {
      alerts.forEach(a => {
        if (a.level === 'critical' || a.level === 'warning') {
          if (a.source_vehicle_id) threatenedVehicles.add(a.source_vehicle_id);
          if (a.target_vehicle_id) threatenedVehicles.add(a.target_vehicle_id);
        }
      });
    }

    const activeIds = new Set();

    for (const [vid, v] of Object.entries(vehicles)) {
      if (vid === myDeviceId) continue; // Don't draw our own device as another car
      if (!v || v.latitude === undefined || v.longitude === undefined) continue;

      // Filter out synthetic background traffic (e.g. v2v_car_lead, v2v_truck_corridor).
      // Only real connected users/devices appear on the map.
      // The only simulated vehicle allowed is during an explicit collision simulation ('v2v_car_nearby').
      const isSyntheticTraffic = typeof vid === 'string' && (
        vid.startsWith('v2v_car_lead') ||
        vid.startsWith('v2v_car_trail') ||
        vid.startsWith('v2v_truck_corridor') ||
        vid.startsWith('sim_')
      );
      if (isSyntheticTraffic) continue;

      if (typeof vid === 'string' && vid === 'v2v_car_nearby' && !this.isCollisionSimActive) {
        continue;
      }

      // Strict radius check: calculate distance from host if host coordinates are known
      let distM = v.distance_from_host_m;
      if (this.hostLat && this.hostLon && v.latitude && v.longitude) {
        distM = this._haversine(this.hostLat, this.hostLon, v.latitude, v.longitude);
      }
      if (distM !== undefined && distM > maxRadius) {
        continue;
      }

      activeIds.add(vid);
      const pos = [v.latitude, v.longitude];
      const speedKmh = Math.round((v.speed_smoothed || v.speed_raw || 0) * 3.6);
      const heading = v.heading_deg || 0;
      const isAmbulance = (v.role === 'ambulance' || v.ambulance_active || v.vehicle_type === 'ambulance');
      const isBike = (v.vehicle_type === 'bike' || (v.label && v.label.toLowerCase().includes('bike')));
      const isThreatened = threatenedVehicles.has(vid);

      let carColor = '#475569'; // Standard vehicle slate
      if (isAmbulance) carColor = '#dc2626';
      else if (isThreatened) carColor = '#ea580c'; // Highlight threatened car in warning color
      else if (isBike) carColor = '#0284c7';

      let vehicleSvg;
      if (isBike) {
        vehicleSvg = `
          <svg viewBox="0 0 32 32" width="24" height="24">
            <circle cx="16" cy="7" r="4" fill="${carColor}"/>
            <rect x="14" y="11" width="4" height="14" rx="2" fill="${carColor}"/>
            <circle cx="16" cy="11" r="2.5" fill="#fef08a"/>
            <circle cx="16" cy="25" r="2.5" fill="#ef4444"/>
          </svg>
        `;
      } else {
        vehicleSvg = `
          <svg viewBox="0 0 32 32" width="26" height="26">
            <rect x="9" y="3" width="14" height="26" rx="4" fill="${carColor}" stroke="#ffffff" stroke-width="1.5"/>
            <rect x="11" y="8" width="10" height="5" rx="1" fill="#1e293b"/>
            <rect x="11" y="18" width="10" height="4" rx="1" fill="#1e293b"/>
            <circle cx="11" cy="4" r="1.5" fill="#fef08a"/>
            <circle cx="21" cy="4" r="1.5" fill="#fef08a"/>
            <circle cx="11" cy="27" r="1.5" fill="#ef4444"/>
            <circle cx="21" cy="27" r="1.5" fill="#ef4444"/>
          </svg>
        `;
      }

      const typeIcon = isAmbulance ? '🚑 ' : (isBike ? '🏍️ ' : '🚗 ');
      const html = `
        <div class="gmaps-v2v-car ${isThreatened ? 'threat-pulse' : ''} ${isAmbulance ? 'ambulance-pulse' : ''}">
          <div class="v2v-car-badge" style="${isThreatened ? 'background:#dc2626; color:#fff; font-weight:800;' : (isAmbulance ? 'background:#b91c1c; color:#fff; font-weight:800;' : '')}">
            ${isThreatened ? '⚠️ ' : typeIcon}${v.label || 'V2V Device'} • ${speedKmh} km/h
          </div>
          <div class="v2v-car-body" style="transform: rotate(${heading}deg);">
            ${vehicleSvg}
          </div>
        </div>
      `;

      const carIcon = L.divIcon({
        className: 'v2v-marker-wrapper',
        html: html,
        iconSize: [32, 40],
        iconAnchor: [16, 26]
      });

      if (!this.vehicleMarkers[vid]) {
        this.vehicleMarkers[vid] = L.marker(pos, { icon: carIcon, zIndexOffset: 1200 }).addTo(this.map);
      } else {
        this.vehicleMarkers[vid].setLatLng(pos);
        this.vehicleMarkers[vid].setIcon(carIcon);
      }
    }

    // Clean up markers for vehicles no longer in 500m active set
    for (const vid of Object.keys(this.vehicleMarkers)) {
      if (!activeIds.has(vid)) {
        this.map.removeLayer(this.vehicleMarkers[vid]);
        delete this.vehicleMarkers[vid];
      }
    }

    // Render impact point and trajectory vectors if collision alert exists
    if (alerts && alerts.length > 0) {
      this.renderCollisionPrediction(alerts, vehicles, myDeviceId);
    } else {
      this.clearCollisionPrediction();
    }
  }

  // -------------------------------------------------------------
  // DYNAMIC COLLISION PREDICTION VECTORS & IMPACT POINT MARKER
  // Implements Section IV-E, IV-F: Vector intersection and visual warning
  // Collision detection is strictly performed between "Me" and nearby vehicle
  // -------------------------------------------------------------
  showCollisionPrediction(impactPos, alert, vehicles) {
    if (this.accidentImpactMarker) return;
    const impactLat = Array.isArray(impactPos) ? impactPos[0] : impactPos.lat;
    const impactLon = Array.isArray(impactPos) ? impactPos[1] : impactPos.lon;
    const alerts = [
      {
        level: (alert && alert.level) || 'warning',
        t_star: (alert && alert.t_star) || 5,
        source_vehicle_id: (alert && alert.source_vehicle_id) || 'v2v_car_nearby',
        target_vehicle_id: (alert && alert.target_vehicle_id) || '',
        impact_point: { lat: impactLat, lon: impactLon }
      }
    ];
    this.renderCollisionPrediction(alerts, vehicles, (alert && alert.target_vehicle_id) || '');
  }

  renderCollisionPrediction(alerts, vehicles, hostDeviceId) {
    if (this.accidentImpactMarker) return; // Keep persistent accident wreckage/freeze marker
    this.clearCollisionPrediction();
    if (!alerts || alerts.length === 0) return;

    // Strictly find alert between "me" (host) and a nearby vehicle
    const colAlert = alerts.find(a =>
      (!hostDeviceId || a.target_vehicle_id === hostDeviceId || a.source_vehicle_id === hostDeviceId) &&
      (a.level === 'critical' || a.level === 'warning' || a.level === 'advisory') &&
      a.impact_point && a.impact_point.lat
    ) || alerts.find(a =>
      (a.level === 'critical' || a.level === 'warning' || a.level === 'advisory') &&
      a.impact_point && a.impact_point.lat
    );

    if (!colAlert) return;

    const impact = colAlert.impact_point;
    const impactPos = [impact.lat, impact.lon];
    const isCritical = (colAlert.level === 'critical');
    const color = isCritical ? '#dc2626' : (colAlert.level === 'warning' ? '#ea580c' : '#f59e0b');

    // 1. Animated Impact Point Marker at the road intersection
    const html = `
      <div class="collision-impact-pin">
        <div class="impact-ring" style="border-color:${color};"></div>
        <div class="impact-core" style="background:${color};">💥</div>
        <div class="impact-label" style="background:${color};">
          ${colAlert.level.toUpperCase()} • ${colAlert.t_star || '--'}s
        </div>
      </div>
    `;

    const icon = L.divIcon({
      className: 'impact-marker-wrapper',
      html: html,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    this.collisionImpactMarker = L.marker(impactPos, { icon, zIndexOffset: 3200 }).addTo(this.map);

    // 2. Dynamic Trajectory Projection Lines from "Me" and the nearby converging car to the impact point
    const srcV = vehicles[colAlert.source_vehicle_id];
    const tgtV = vehicles[colAlert.target_vehicle_id];

    let srcPos = (srcV && srcV.latitude && srcV.longitude) ? [srcV.latitude, srcV.longitude] : null;
    let tgtPos = (tgtV && tgtV.latitude && tgtV.longitude) ? [tgtV.latitude, tgtV.longitude] : null;

    if (!srcPos && this.hostMarker) {
      const p = this.hostMarker.getLatLng();
      srcPos = [p.lat, p.lng];
    }
    if (!tgtPos && this.hostMarker) {
      const p = this.hostMarker.getLatLng();
      tgtPos = [p.lat, p.lng];
    }

    if (srcPos) {
      const line1 = L.polyline([srcPos, impactPos], {
        color: color,
        weight: 3.5,
        opacity: 0.9,
        dashArray: '5, 8'
      }).addTo(this.map);
      this.collisionTrajectoryLines.push(line1);
    }

    if (tgtPos) {
      const line2 = L.polyline([tgtPos, impactPos], {
        color: color,
        weight: 3.5,
        opacity: 0.9,
        dashArray: '5, 8'
      }).addTo(this.map);
      this.collisionTrajectoryLines.push(line2);
    }
  }

  clearCollisionPrediction() {
    if (this.collisionImpactMarker) {
      this.map.removeLayer(this.collisionImpactMarker);
      this.collisionImpactMarker = null;
    }
    if (this.collisionTrajectoryLines && this.collisionTrajectoryLines.length > 0) {
      this.collisionTrajectoryLines.forEach(l => this.map.removeLayer(l));
      this.collisionTrajectoryLines = [];
    }
  }

  showAccidentCollisionScene(hostLat, hostLon, hostHeading, otherLat, otherLon, otherHeading, otherLabel = "Red Hatchback (Collided)", impactLat = null, impactLon = null) {
    this.isAccidentFrozen = true;
    this.clearCollisionPrediction();
    this.clearAccidentImpactMarker();

    // 1. Host Vehicle (Blue) - Stopped with 0 km/h and prominent label
    const hostHtml = `
      <div class="gmaps-v2v-car collided-car-host" style="display:flex; flex-direction:column; align-items:center;">
        <div class="v2v-car-badge" style="background:#1a73e8; color:#ffffff; font-weight:800; border:1.5px solid #ffffff; box-shadow:0 3px 8px rgba(0,0,0,0.4); white-space:nowrap; padding:3px 8px; border-radius:12px; font-size:11px;">
          🚗 Your Vehicle (Collided) • 0 km/h
        </div>
        <div class="v2v-car-body" style="transform: rotate(${Math.round(hostHeading || 0)}deg); margin-top:2px;">
          <svg viewBox="0 0 32 32" width="28" height="28">
            <rect x="9" y="3" width="14" height="26" rx="4" fill="#1a73e8" stroke="#ffffff" stroke-width="2"/>
            <rect x="11" y="8" width="10" height="5" rx="1" fill="#0d47a1"/>
            <rect x="11" y="18" width="10" height="4" rx="1" fill="#0d47a1"/>
            <circle cx="11" cy="4" r="1.5" fill="#fef08a"/>
            <circle cx="21" cy="4" r="1.5" fill="#fef08a"/>
          </svg>
        </div>
      </div>
    `;

    const hostIcon = L.divIcon({
      className: 'gmaps-collided-host-icon',
      html: hostHtml,
      iconSize: [160, 50],
      iconAnchor: [80, 42]
    });

    if (!this.hostMarker) {
      this.hostMarker = L.marker([hostLat, hostLon], { icon: hostIcon, zIndexOffset: 3500 }).addTo(this.map);
    } else {
      this.hostMarker.setLatLng([hostLat, hostLon]);
      this.hostMarker.setIcon(hostIcon);
      this.hostMarker.setZIndexOffset(3500);
    }

    // 2. Collided Other Vehicle (Red Hatchback) - Stopped with 0 km/h and prominent label
    const otherHtml = `
      <div class="gmaps-v2v-car collided-car-other" style="display:flex; flex-direction:column; align-items:center;">
        <div class="v2v-car-badge" style="background:#dc2626; color:#ffffff; font-weight:800; border:1.5px solid #ffffff; box-shadow:0 3px 8px rgba(0,0,0,0.4); white-space:nowrap; padding:3px 8px; border-radius:12px; font-size:11px;">
          💥 ${otherLabel} • 0 km/h
        </div>
        <div class="v2v-car-body" style="transform: rotate(${Math.round(otherHeading || 0)}deg); margin-top:2px;">
          <svg viewBox="0 0 32 32" width="28" height="28">
            <rect x="9" y="3" width="14" height="26" rx="4" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
            <rect x="11" y="8" width="10" height="5" rx="1" fill="#7f1d1d"/>
            <rect x="11" y="18" width="10" height="4" rx="1" fill="#7f1d1d"/>
            <circle cx="11" cy="4" r="1.5" fill="#fef08a"/>
            <circle cx="21" cy="4" r="1.5" fill="#fef08a"/>
          </svg>
        </div>
      </div>
    `;

    const otherIcon = L.divIcon({
      className: 'gmaps-collided-other-icon',
      html: otherHtml,
      iconSize: [160, 50],
      iconAnchor: [80, 42]
    });

    if (!this.collidedOtherMarker) {
      this.collidedOtherMarker = L.marker([otherLat, otherLon], { icon: otherIcon, zIndexOffset: 3550 }).addTo(this.map);
    } else {
      this.collidedOtherMarker.setLatLng([otherLat, otherLon]);
      this.collidedOtherMarker.setIcon(otherIcon);
      this.collidedOtherMarker.setZIndexOffset(3550);
    }

    // 3. Central Crash Impact Pin placed directly at collision intersection
    const finalImpactLat = (impactLat !== null && impactLat !== undefined) ? impactLat : ((hostLat + otherLat) / 2.0);
    const finalImpactLon = (impactLon !== null && impactLon !== undefined) ? impactLon : ((hostLon + otherLon) / 2.0);
    const crashHtml = `
      <div class="crash-impact-pin">
        <div class="crash-impact-ring"></div>
        <div class="crash-impact-core">💥</div>
        <div class="crash-impact-label">ACCIDENT OCCURRED</div>
      </div>
    `;
    const crashIcon = L.divIcon({
      className: 'crash-marker-wrapper',
      html: crashHtml,
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });
    this.accidentImpactMarker = L.marker([finalImpactLat, finalImpactLon], { icon: crashIcon, zIndexOffset: 4000 }).addTo(this.map);

    this.map.panTo([finalImpactLat, finalImpactLon], { animate: true, duration: 0.5 });
  }

  showAccidentImpactMarker(lat, lon) {
    this.clearAccidentImpactMarker();
    this.clearCollisionPrediction();

    const crashHtml = `
      <div class="crash-impact-pin">
        <div class="crash-impact-ring"></div>
        <div class="crash-impact-core">💥</div>
        <div class="crash-impact-label">ACCIDENT OCCURRED</div>
      </div>
    `;

    const icon = L.divIcon({
      className: 'crash-marker-wrapper',
      html: crashHtml,
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });

    this.accidentImpactMarker = L.marker([lat, lon], { icon, zIndexOffset: 4000 }).addTo(this.map);
    this.map.panTo([lat, lon], { animate: true, duration: 0.5 });
  }

  clearAccidentImpactMarker() {
    this.isAccidentFrozen = false;
    if (this.accidentImpactMarker) {
      this.map.removeLayer(this.accidentImpactMarker);
      this.accidentImpactMarker = null;
    }
    if (this.collidedOtherMarker) {
      this.map.removeLayer(this.collidedOtherMarker);
      this.collidedOtherMarker = null;
    }
  }

  // -------------------------------------------------------------
  // ROUTING: GOOGLE MAPS AUTHENTIC BLUE ROUTE POLYLINE
  // -------------------------------------------------------------
  displayRoute(routeData) {
    if (!routeData || !routeData.coordinates || routeData.coordinates.length < 2) return;

    this.clearRoute();

    const coords = routeData.coordinates; // [[lat, lon], ...]

    // 1. Google Maps Dark Blue Outer Border / Casing
    this.routeCasing = L.polyline(coords, {
      color: '#185abc',
      weight: 10,
      opacity: 0.95,
      lineJoin: 'round',
      lineCap: 'round'
    }).addTo(this.map);

    // 2. Google Maps Navigation Sky Blue Inner Line
    this.routePolyline = L.polyline(coords, {
      color: '#4285f4',
      weight: 6,
      opacity: 0.98,
      lineJoin: 'round',
      lineCap: 'round'
    }).addTo(this.map);

    // 3. Destination Pin (Google Maps Classic Red Pin B)
    const destCoord = coords[coords.length - 1];
    const pinHtml = `
      <div class="gmaps-dest-pin">
        <div class="dest-pin-head">
          <span class="dest-pin-label">B</span>
        </div>
        <div class="dest-pin-shadow"></div>
      </div>
    `;

    const pinIcon = L.divIcon({
      className: 'dest-pin-wrapper',
      html: pinHtml,
      iconSize: [32, 42],
      iconAnchor: [16, 40]
    });

    this.destMarker = L.marker(destCoord, { icon: pinIcon, zIndexOffset: 1900 }).addTo(this.map);

    // Fit map smoothly to the route bounds with padding
    try {
      this.map.fitBounds(this.routePolyline.getBounds(), {
        padding: [80, 80],
        maxZoom: 18,
        animate: true
      });
    } catch (e) {}
  }

  clearRoute() {
    if (this.routeCasing) {
      this.map.removeLayer(this.routeCasing);
      this.routeCasing = null;
    }
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.destMarker) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }
    for (const vid of Object.keys(this.vehicleMarkers)) {
      this.map.removeLayer(this.vehicleMarkers[vid]);
      delete this.vehicleMarkers[vid];
    }
    this.clearHazards();
  }

  // -------------------------------------------------------------
  // V2V COLLISION HAZARDS ON ROUTE
  // -------------------------------------------------------------
  showRouteHazards(hazards) {
    this.clearHazards();
    if (!hazards || hazards.length === 0) return;

    hazards.forEach(h => {
      const alert = h.alert;
      if (!alert || !alert.impact_point) return;
      const pos = [alert.impact_point.lat, alert.impact_point.lon];

      const hazardHtml = `
        <div style="background:#d93025; color:#fff; border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(217,48,37,0.5); font-size:14px; border:2px solid #fff;">
          ⚠️
        </div>
      `;

      const icon = L.divIcon({
        className: 'hazard-icon-pin',
        html: hazardHtml,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const m = L.marker(pos, { icon, zIndexOffset: 2500 }).addTo(this.map);
      this.hazardMarkers.push(m);
    });
  }

  clearHazards() {
    this.hazardMarkers.forEach(m => this.map.removeLayer(m));
    this.hazardMarkers = [];
  }
}

// Global instance
window.mapController = new GoogleMapController();
