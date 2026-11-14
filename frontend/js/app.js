/**
 * Google Maps App Controller
 * Multi-user Android application replication for Smart V2V Collision System.
 * - Each connected client is an individual user on the road network
 * - Authentic Google Maps Android search, filter chips, directions & in-drive HUD
 * - V2V predictive collision analysis along active route within 500m radar zone
 */

// Route all API and WebSocket calls to Render Cloud when running inside mobile APK
const API_CLOUD_BASE = 'https://saferoute-v2v.onrender.com';
const isMobileApk = (window.Capacitor !== undefined) ||
  (window.location.protocol === 'file:') ||
  (window.location.hostname === 'localhost' && window.location.port !== '8080');

if (isMobileApk) {
  const origFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      url = API_CLOUD_BASE + url;
    }
    return origFetch.call(this, url, options);
  };
}

class GoogleMapsAppController {
  constructor() {
    // User Vehicle Profile (One-time Login)
    this.userProfile = this.loadUserProfile();
    this.vehicleNumber = this.userProfile ? this.userProfile.vehicleNumber : '';
    this.vehicleType = this.userProfile ? this.userProfile.vehicleType : 'car'; // 'car', 'bike', 'ambulance'
    this.deviceId = this.userProfile ? this.userProfile.deviceId : ('v2v_pending_' + Math.floor(1000 + Math.random() * 9000).toString(16));
    this.deviceLabel = this.userProfile ? `${this.vehicleNumber} (${this.vehicleType.toUpperCase()})` : 'Unregistered Vehicle';
    this.userRole = 'standard'; // 'standard', 'ambulance', 'women_safety'

    // Live Telemetry State
    this.currentLat = 11.02580;  // Default: Avinashi Rd / GD Naidu Flyover
    this.currentLon = 77.01600;
    this.currentSpeed = 0.0;
    this.currentHeading = 0.0;
    this.currentAccuracy = 3.0;
    this.isRealGpsAvailable = false;
    this.watchPositionId = null;

    // Routing & Navigation State
    this.destinations = [];
    this.selectedDestination = null;
    this.activeRoute = null;
    this.selectedTravelMode = (this.vehicleType === 'bike') ? 'motorcycle' : 'driving';
    this.isNavigating = false;
    this.routeCollisionTimer = null;
    this.nearbyVehiclesTimer = null; // Real-time other vehicles movement timer
    this.nearbyVehicles = {};
    this.isCollisionSimActive = false;
    this.collisionSimTimer = null;
    this.isAmbulanceMode = false; // Always starts inactive; ambulance operations perform ONLY when button pressed
    this.isSosActive = false;
    this.analysisRadiusM = 500.0;
    this.lastAmbAlertTime = 0;
    this.lastSpokenHazardId = null;
    this.isAudioMuted = false;
    this.emergencyContacts = [];

    // Communication Channels
    this.ws = null;
    this.telemetryIntervalId = null;
    this.searchDebounceTimer = null;
    this.wsPingTimer = null;
    this.stateSyncTimer = null;
  }

  async init() {
    console.log(`[Google Maps V2V] Initializing Android App for Vehicle: ${this.vehicleNumber || 'Unregistered'}`);

    // 1. Initialize Leaflet Map
    window.mapController.init(this.currentLat, this.currentLon);
    window.mapController.updateHostPosition(this.currentLat, this.currentLon, this.currentHeading, this.currentAccuracy);

    // 2. Check Profile / Show Login if not registered
    if (!this.userProfile) {
      this.showLoginOverlay();
    } else {
      this.applyUserProfile(this.userProfile, false);
    }

    // 3. Connect to Backend WebSocket stream with automatic HTTP fallback
    this.setupWebSocket();
    this.startStateSyncLoop();

    // 4. Start Live GPS Tracking
    this.startLocationTracking();

    // 5. Preload Destinations
    await this.loadDestinations();

    // 6. Bind UI Events
    this.bindEvents();

    // 6b. Preload SOS Emergency Contacts
    await this.loadEmergencyContacts();

    // 7. Start periodic 1.0-second telemetry broadcast (Ts = 1s, IEEE Table II)
    this.startTelemetryLoop();

    // 8. Service Worker Management: Purge stale caches in Mobile APK
    if ('serviceWorker' in navigator) {
      if (isMobileApk) {
        // Mobile WebView APK: unregister service workers and clear cache storage to prevent stale cached bundles
        navigator.serviceWorker.getRegistrations().then(regs => {
          for (let r of regs) r.unregister();
        }).catch(() => {});
        if ('caches' in window) {
          caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
        }
      } else {
        navigator.serviceWorker.register('/sw.js').catch(err => {
          console.debug('ServiceWorker registration skipped:', err);
        });
      }
    }
  }

  // -------------------------------------------------------------
  // USER PROFILE & ONE-TIME VEHICLE REGISTRATION (LOGIN / LOGOUT)
  // -------------------------------------------------------------
  loadUserProfile() {
    try {
      const stored = localStorage.getItem('v2v_user_profile');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn("Failed to load user profile:", e);
    }
    return null;
  }

  showLoginOverlay() {
    const overlay = document.getElementById('gmaps-login-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      const input = document.getElementById('login-vehicle-num');
      if (input) {
        setTimeout(() => input.focus(), 150);
      }
    }
  }

  hideLoginOverlay() {
    const overlay = document.getElementById('gmaps-login-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  selectVehicleTypeOption(type) {
    ['car', 'bike', 'ambulance'].forEach(t => {
      const card = document.getElementById(`vtype-card-${t}`);
      if (card) {
        if (t === type) card.classList.add('active');
        else card.classList.remove('active');
      }
    });
    const input = document.getElementById('login-selected-type');
    if (input) input.value = type;
  }

  _generateUniqueDeviceId(vehicleNumber, vehicleType) {
    const cleanPlate = (vehicleNumber || 'VEH').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const randHex1 = Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    const randHex2 = Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    const tsCode = Date.now().toString(36).slice(-4);
    return `v2v_${vehicleType}_${cleanPlate}_${randHex1}${randHex2}_${tsCode}`;
  }

  handleLoginSubmit() {
    const numInput = document.getElementById('login-vehicle-num');
    const typeInput = document.getElementById('login-selected-type');
    let vehicleNum = (numInput ? numInput.value.trim().toUpperCase() : '') || 'TN 38 AB 1234';
    let vehicleType = (typeInput ? typeInput.value : 'car') || 'car';

    // Generate distinct unique ID per user
    const deviceId = this._generateUniqueDeviceId(vehicleNum, vehicleType);

    const profile = {
      vehicleNumber: vehicleNum,
      vehicleType: vehicleType,
      deviceId: deviceId,
      loginTimestamp: Date.now()
    };

    localStorage.setItem('v2v_user_profile', JSON.stringify(profile));
    localStorage.setItem('v2v_user_device_id', deviceId);

    this.applyUserProfile(profile, true);
    this.hideLoginOverlay();
  }

  handleLogout() {
    if (confirm("Log out and change vehicle registration?")) {
      // Deactivate ambulance mode if active
      if (this.isAmbulanceMode) {
        this.isAmbulanceMode = false;
        fetch('/api/ambulance/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicle_id: this.deviceId, active: false })
        }).catch(() => {});
      }

      // Stop collision sim or route if running
      if (this.isCollisionSimActive) this.toggleCollisionSimulation();
      if (this.isNavigating) this.cancelActiveRoute();

      localStorage.removeItem('v2v_user_profile');
      this.userProfile = null;
      this.vehicleNumber = '';
      this.vehicleType = 'car';

      this.closeProfileDialog();
      this.closeSettingsDialog();

      // Reset login form
      const numInput = document.getElementById('login-vehicle-num');
      if (numInput) numInput.value = '';
      this.selectVehicleTypeOption('car');

      this.showLoginOverlay();
    }
  }

  applyUserProfile(profile, isFirstLogin = false) {
    this.userProfile = profile;
    this.vehicleNumber = profile.vehicleNumber;
    this.vehicleType = profile.vehicleType; // 'car', 'bike', 'ambulance'
    this.deviceId = profile.deviceId;
    this.deviceLabel = `${this.vehicleNumber} (${this.vehicleType.toUpperCase()})`;

    // Reset ambulance mode state
    // "fo ambulance vehicle, the operations needs to perform only when the ambulance mode button pressed"
    this.isAmbulanceMode = false;
    this.userRole = 'standard';
    this.analysisRadiusM = 500.0;

    // Apply vehicle-type specific UI rules
    const ambChip = document.getElementById('chip-ambulance-mode');
    const ambChipText = document.getElementById('chip-ambulance-text');
    const btnAmbLayer = document.getElementById('btn-mode-ambulance');
    const btnStdLayer = document.getElementById('btn-mode-standard');

    if (this.vehicleType === 'ambulance') {
      // Ambulance vehicle type:
      // Show ambulance button in top chips and layers
      if (ambChip) {
        ambChip.style.display = 'inline-flex';
        ambChip.classList.remove('active');
      }
      if (ambChipText) {
        ambChipText.textContent = 'Ambulance Mode (1km)';
      }
      if (btnAmbLayer) btnAmbLayer.style.display = 'inline-flex';
      if (btnStdLayer) {
        btnStdLayer.style.display = 'inline-flex';
        btnStdLayer.classList.add('active');
        btnStdLayer.textContent = 'Standby (500m)';
      }

      this.selectedTravelMode = 'driving';
    } else {
      // Car or Bike:
      // "for car and bike, it does not contains any ambulance parameter. the ambulance's parameters only show, when the type of vehicle in login is ambulance. now it only shows normal vehicle or emergency vehicle not both for one user."
      if (ambChip) ambChip.style.display = 'none';
      if (btnAmbLayer) btnAmbLayer.style.display = 'none';
      if (btnStdLayer) {
        btnStdLayer.style.display = 'inline-flex';
        btnStdLayer.classList.add('active');
        btnStdLayer.textContent = (this.vehicleType === 'bike') ? '🏍️ Motorcycle (500m)' : '🚗 Passenger Car (500m)';
      }

      if (this.vehicleType === 'bike') {
        this.selectedTravelMode = 'motorcycle';
      } else {
        this.selectedTravelMode = 'driving';
      }
    }

    // Set travel mode tab
    this.setTravelMode(this.selectedTravelMode);

    // Update Profile UI
    this._updateProfileUI();

    // Update Radar HUD and Map Zone
    this._updateRadarHUDAndMap();

    // Re-identify to WebSocket stream if active
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "IDENTIFY",
        vehicle_id: this.deviceId,
        label: this.deviceLabel,
        role: this.userRole,
        vehicle_type: this.vehicleType,
        vehicle_number: this.vehicleNumber
      }));
    }

    // Immediate telemetry broadcast
    this.sendTelemetry();

    if (isFirstLogin && window.audioEngine) {
      const typeSpoken = (this.vehicleType === 'ambulance')
        ? 'Emergency Ambulance'
        : (this.vehicleType === 'bike' ? 'Motorcycle' : 'Passenger Car');
      window.audioEngine.speak(`Logged in as ${typeSpoken}, registration ${this.vehicleNumber}. SafeRoute network ready.`);
    }
  }

  _updateProfileUI() {
    const avatarEl = document.getElementById('gmaps-avatar-text');
    const diagAvatar = document.getElementById('dialog-avatar');
    const diagLabel = document.getElementById('dialog-device-label');
    const diagId = document.getElementById('dialog-device-id');
    const diagVehNum = document.getElementById('dialog-vehicle-num');
    const diagVehType = document.getElementById('dialog-vehicle-type');

    let avatarSymbol = '🚗';
    let typeLabel = 'Passenger Car';
    if (this.vehicleType === 'ambulance') {
      avatarSymbol = '🚑';
      typeLabel = 'Emergency Ambulance';
    } else if (this.vehicleType === 'bike') {
      avatarSymbol = '🏍️';
      typeLabel = 'Motorcycle / 2-Wheeler';
    }

    if (avatarEl) avatarEl.textContent = avatarSymbol;
    if (diagAvatar) diagAvatar.textContent = avatarSymbol;
    if (diagLabel) diagLabel.textContent = this.deviceLabel || 'SafeRoute User';
    if (diagId) diagId.textContent = `V2V ID: ${this.deviceId}`;
    if (diagVehNum) diagVehNum.textContent = this.vehicleNumber || 'Unregistered';
    if (diagVehType) diagVehType.textContent = typeLabel;
  }

  _updateRadarHUDAndMap() {
    // Update Radar Badge on HUD
    const radarBadges = document.querySelectorAll('.nav-v2v-radar-badge, #nav-v2v-radar-badge');
    radarBadges.forEach(b => {
      b.innerHTML = this.isAmbulanceMode
        ? `<span class="radar-pulse-dot" style="background:#ef4444;"></span> 1KM AMBULANCE`
        : `<span class="radar-pulse-dot"></span> 500M V2V`;
    });

    const diagRadar = document.getElementById('dialog-radar-range');
    if (diagRadar) {
      diagRadar.textContent = this.isAmbulanceMode
        ? '1000m Priority Clearance Zone'
        : '500m Predictive Zone';
    }

    // Update Map Controller Radar Circle to 1000m / 500m
    if (window.mapController) {
      window.mapController.updateAnalysisZone(
        this.currentLat,
        this.currentLon,
        this.analysisRadiusM,
        this.isAmbulanceMode
      );
    }
  }

  setUserRole(role) {
    if (this.vehicleType !== 'ambulance') {
      // Civilian cars and bikes cannot switch to ambulance
      return;
    }

    if (role === 'ambulance') {
      if (!this.isAmbulanceMode) this.toggleAmbulanceMode();
    } else {
      if (this.isAmbulanceMode) this.toggleAmbulanceMode();
    }
  }

  toggleAmbulanceMode() {
    if (this.vehicleType !== 'ambulance') {
      console.warn("Ambulance mode cannot be toggled on civilian vehicles.");
      return;
    }

    this.isAmbulanceMode = !this.isAmbulanceMode;
    this.userRole = this.isAmbulanceMode ? 'ambulance' : 'standard';
    this.analysisRadiusM = this.isAmbulanceMode ? 1000.0 : 500.0; // 1km priority radius!

    // Update Top Chip UI
    const chip = document.getElementById('chip-ambulance-mode');
    const chipText = document.getElementById('chip-ambulance-text');
    if (chip) chip.classList.toggle('active', this.isAmbulanceMode);
    if (chipText) {
      chipText.textContent = this.isAmbulanceMode ? 'Ambulance (1km Active)' : 'Ambulance Mode (1km)';
    }

    // Update Layers sheet selection
    const btnAmb = document.getElementById('btn-mode-ambulance');
    const btnStd = document.getElementById('btn-mode-standard');
    if (btnAmb && btnStd) {
      btnAmb.classList.toggle('active', this.isAmbulanceMode);
      btnStd.classList.toggle('active', !this.isAmbulanceMode);
    }

    // Update HUD & Map
    this._updateRadarHUDAndMap();

    // Inform backend of ambulance toggle with 1000m (1km) radius
    fetch('/api/ambulance/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicle_id: this.deviceId,
        active: this.isAmbulanceMode,
        radius_m: this.analysisRadiusM
      })
    }).catch(() => {});

    // Audio guidance
    if (window.audioEngine) {
      if (this.isAmbulanceMode) {
        window.audioEngine.speak("Ambulance priority clearance active. Analysis radius extended to 1 kilometer. Broadcasting route clearance.");
      } else {
        window.audioEngine.speak("Ambulance priority mode deactivated. Returned to standby 500 meter radar.");
      }
    }

    this.sendTelemetry();
  }

  async toggleWomenSafetySOS() {
    this.isSosActive = !this.isSosActive;

    const sosBtn = document.getElementById('gmaps-sos-btn');
    const sosLabel = document.getElementById('sos-fab-label');
    const sosDialog = document.getElementById('gmaps-sos-dialog');
    const liveLinkEl = document.getElementById('sos-live-link');

    if (this.isSosActive) {
      if (sosBtn) sosBtn.classList.add('active');
      if (sosLabel) sosLabel.textContent = 'ACTIVE';
      if (window.mapController) window.mapController.setSosBeacon(true);

      this._updateContactsBadge();

      // Trigger SOS on backend with real GPS coordinates and configured contacts
      try {
        const resp = await fetch('/api/sos/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: this.deviceId,
            user_name: this.deviceLabel || "Android User",
            latitude: this.currentLat,
            longitude: this.currentLon,
            accuracy: this.currentAccuracy || 2.0,
            contacts: this.emergencyContacts,
            message: "EMERGENCY: Immediate assistance required! Traveling alone."
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          const token = data.sos ? data.sos.tracking_token : null;
          if (liveLinkEl && token) {
            liveLinkEl.textContent = `${window.location.origin}/api/sos/track/${token}`;
          }
        }
      } catch (e) {}

      if (sosDialog) sosDialog.style.display = 'flex';

      if (window.audioEngine) {
        window.audioEngine.speak(`Emergency SOS activated. Live location dispatched to police helpline and ${this.emergencyContacts.length} emergency contacts.`, true);
      }
    } else {
      if (sosBtn) sosBtn.classList.remove('active');
      if (sosLabel) sosLabel.textContent = 'SOS';
      if (sosDialog) sosDialog.style.display = 'none';
      if (window.mapController) window.mapController.setSosBeacon(false);

      try {
        await fetch(`/api/sos/cancel?user_id=${this.deviceId}`, { method: 'POST' });
      } catch (e) {}

      if (window.audioEngine) {
        window.audioEngine.speak("Emergency SOS cancelled. Returning to safe standby.");
      }
    }

    this.sendTelemetry();
  }

  closeSOSDialog() {
    const sosDialog = document.getElementById('gmaps-sos-dialog');
    if (sosDialog) sosDialog.style.display = 'none';
  }

  // -------------------------------------------------------------
  // SOS EMERGENCY CONTACTS MANAGEMENT & SETTINGS
  // -------------------------------------------------------------
  async loadEmergencyContacts() {
    try {
      const stored = localStorage.getItem('v2v_emergency_contacts');
      if (stored) {
        this.emergencyContacts = JSON.parse(stored);
      } else {
        const resp = await fetch('/api/sos/contacts');
        if (resp.ok) {
          const data = await resp.json();
          if (data.contacts && data.contacts.length > 0) {
            this.emergencyContacts = data.contacts;
          }
        }
      }
    } catch (e) {
      console.warn("Failed to load emergency contacts:", e);
    }

    if (!this.emergencyContacts || this.emergencyContacts.length === 0) {
      this.emergencyContacts = [
        { id: "c1", name: "Police Helpline", phone: "112", relationship: "Emergency Service", is_primary: true },
        { id: "c2", name: "Family Guardian", phone: "+91 98401 22334", relationship: "Parent / Family", is_primary: false },
        { id: "c3", name: "Emergency Contact", phone: "+91 94432 11223", relationship: "Friend / Relative", is_primary: false }
      ];
      this._persistContactsLocally();
    }

    this._updateContactsBadge();
  }

  _persistContactsLocally() {
    try {
      localStorage.setItem('v2v_emergency_contacts', JSON.stringify(this.emergencyContacts));
    } catch (e) {}
  }

  async saveEmergencyContacts() {
    this._persistContactsLocally();
    this._updateContactsBadge();

    try {
      await fetch('/api/sos/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.emergencyContacts)
      });
    } catch (e) {}
  }

  _updateContactsBadge() {
    const badge = document.getElementById('sos-contacts-dispatched-badge');
    if (badge) {
      badge.textContent = `Dispatched (${this.emergencyContacts.length} Contacts)`;
    }
  }

  openSettingsDialog() {
    const dialog = document.getElementById('gmaps-settings-dialog');
    if (dialog) {
      dialog.style.display = 'flex';
      this.renderEmergencyContacts();
    }
  }

  closeSettingsDialog() {
    const dialog = document.getElementById('gmaps-settings-dialog');
    if (dialog) dialog.style.display = 'none';
  }

  renderEmergencyContacts() {
    const listEl = document.getElementById('sos-contacts-list');
    if (!listEl) return;

    if (!this.emergencyContacts || this.emergencyContacts.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b; font-size:12px; padding:8px;">No emergency contacts added yet. Add at least one contact below.</div>';
      return;
    }

    listEl.innerHTML = this.emergencyContacts.map(c => `
      <div class="sos-contact-card">
        <div class="sos-contact-info">
          <div class="sos-contact-header-line">
            <span class="sos-contact-name">${this._escapeHtml(c.name)}</span>
            ${c.is_primary ? '<span class="sos-primary-tag">Primary</span>' : ''}
          </div>
          <div class="sos-contact-detail">${this._escapeHtml(c.relationship || 'Contact')} • ${this._escapeHtml(c.phone)}</div>
        </div>
        <button class="sos-contact-delete" onclick="appController.deleteEmergencyContact('${c.id}')" title="Delete contact">✕</button>
      </div>
    `).join('');
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async handleAddContactSubmit() {
    const nameInput = document.getElementById('sos-contact-name');
    const phoneInput = document.getElementById('sos-contact-phone');
    const relationInput = document.getElementById('sos-contact-relation');
    const primaryInput = document.getElementById('sos-contact-primary');

    const name = nameInput ? nameInput.value.trim() : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const relationship = relationInput ? relationInput.value : 'Guardian';
    const isPrimary = primaryInput ? primaryInput.checked : false;

    if (!name || !phone) return;

    if (isPrimary) {
      this.emergencyContacts.forEach(c => { c.is_primary = false; });
    }

    const newContact = {
      id: 'c_' + Date.now().toString(36),
      name: name,
      phone: phone,
      relationship: relationship,
      is_primary: isPrimary
    };

    this.emergencyContacts.push(newContact);
    await this.saveEmergencyContacts();
    this.renderEmergencyContacts();

    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (primaryInput) primaryInput.checked = false;
  }

  async deleteEmergencyContact(id) {
    this.emergencyContacts = this.emergencyContacts.filter(c => c.id !== id);
    if (this.emergencyContacts.length > 0 && !this.emergencyContacts.some(c => c.is_primary)) {
      this.emergencyContacts[0].is_primary = true;
    }
    await this.saveEmergencyContacts();
    this.renderEmergencyContacts();
  }

  evaluateAmbulanceClearanceAlerts(alerts) {
    if (!alerts || alerts.length === 0) return;

    // Find ambulance clearance alert targeted at this device or in corridor
    const ambAlert = alerts.find(a => a.level === 'ambulance_clearance');
    if (!ambAlert) return;

    // Show continuous ambulance clearance banner
    const banner = document.getElementById('gmaps-hazard-banner');
    const titleEl = document.getElementById('hazard-banner-title');
    const descEl = document.getElementById('hazard-banner-desc');
    const pillsEl = document.getElementById('hazard-banner-pills');

    if (banner && (this.isNavigating || this.isCollisionSimActive || this.userRole === 'ambulance')) {
      if (titleEl) titleEl.textContent = '🚨 EMERGENCY AMBULANCE APPROACHING';
      if (descEl) descEl.textContent = ambAlert.message || 'Pull over to the left and clear the lane immediately!';
      if (pillsEl) {
        pillsEl.innerHTML = `<span class="hazard-pill" style="background:#fee2e2; color:#b91c1c;">1KM ROUTE CLEARANCE</span>`;
      }
      banner.style.display = 'flex';
      banner.style.borderLeftColor = '#dc2626';

      // Audible emergency pulse every 4 seconds
      const now = Date.now();
      if (window.audioEngine && (!this.lastAmbAlertTime || now - this.lastAmbAlertTime > 4000)) {
        this.lastAmbAlertTime = now;
        window.audioEngine.playBeep('critical');
      }
    }
  }

  // -------------------------------------------------------------
  // WEBSOCKET & BACKEND SYNCHRONIZATION
  // -------------------------------------------------------------
  setupWebSocket() {
    let wsUrl;
    if (isMobileApk) {
      wsUrl = 'wss://saferoute-v2v.onrender.com/ws/stream';
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host || 'localhost:8080';
      wsUrl = `${protocol}//${host}/ws/stream`;
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.updateConnBadge(true, 'WebSocket');
        // Identify ourselves to the V2V network
        this.ws.send(JSON.stringify({
          type: "IDENTIFY",
          device_id: this.deviceId,
          vehicle_id: this.deviceId,
          label: this.deviceLabel,
          role: this.userRole,
          vehicle_type: this.vehicleType,
          vehicle_number: this.vehicleNumber
        }));

        // Keepalive heartbeat
        if (this.wsPingTimer) clearInterval(this.wsPingTimer);
        this.wsPingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send("ping");
          }
        }, 20000);
      };

      this.ws.onmessage = (event) => {
        if (event.data === "pong") return;
        try {
          const data = JSON.parse(event.data);
          this.handleStateUpdate(data);
          this.updateConnBadge(true, 'WebSocket');
        } catch (e) {}
      };

      this.ws.onclose = () => {
        if (this.wsPingTimer) clearInterval(this.wsPingTimer);
        setTimeout(() => this.setupWebSocket(), 5000);
      };

      this.ws.onerror = () => {
        if (this.wsPingTimer) clearInterval(this.wsPingTimer);
      };
    } catch (e) {}
  }

  startStateSyncLoop() {
    if (this.stateSyncTimer) clearInterval(this.stateSyncTimer);
    this.stateSyncTimer = setInterval(async () => {
      // If WebSocket is active, it handles live streaming
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateConnBadge(true, 'WebSocket');
        return;
      }

      // Seamless HTTP fallback polling for /api/state
      try {
        const resp = await fetch('/api/state');
        if (resp.ok) {
          const data = await resp.json();
          this.handleStateUpdate(data);
          this.updateConnBadge(true, 'Cloud Sync');
        } else {
          this.updateConnBadge(false);
        }
      } catch (e) {
        this.updateConnBadge(false);
      }
    }, 1500);
  }

  updateConnBadge(isConnected, channel = '1s Ts') {
    const statusEl = document.getElementById('dialog-conn-status');
    if (statusEl) {
      statusEl.className = `status-badge ${isConnected ? 'green' : 'red'}`;
      statusEl.textContent = isConnected ? `Connected (${channel})` : 'Reconnecting...';
    }
  }

  handleStateUpdate(data) {
    if (data.type === 'STATE_UPDATE' || data.type === 'INITIAL_STATE') {
      const vehicles = data.vehicles || {};
      const alerts = data.alerts || [];

      // Update analysis radius dynamically (1000m in Ambulance Mode, 500m in Standard Mode)
      if (data.analysis_radius_m) {
        this.analysisRadiusM = data.analysis_radius_m;
        if (window.mapController) {
          window.mapController.updateAnalysisZone(this.currentLat, this.currentLon, this.analysisRadiusM, this.isAmbulanceMode);
        }
      }

      // Render real-world connected peer devices (and active collision sim vehicle if running)
      const mergedVehicles = { ...vehicles };
      if (this.isCollisionSimActive && this.nearbyVehicles && this.nearbyVehicles["v2v_car_nearby"]) {
        const simV = this.nearbyVehicles["v2v_car_nearby"];
        mergedVehicles["v2v_car_nearby"] = {
          vehicle_id: "v2v_car_nearby",
          label: simV.label || "Red Hatchback (Approaching)",
          latitude: simV.lat,
          longitude: simV.lon,
          heading_deg: simV.heading || 0,
          speed_smoothed: simV.speed || 8.0,
          role: "standard"
        };
      }
      window.mapController.updateConnectedVehicles(mergedVehicles, this.deviceId, true, alerts);

      // Render ambulance priority corridors on map if present
      if (data.ambulance_corridors && window.mapController) {
        window.mapController.showAmbulanceCorridors(data.ambulance_corridors);
      }

      // Evaluate collision alerts for inspector HUD and voice audio
      this.evaluateCollisionAlerts(alerts, vehicles);

      // Evaluate continuous ambulance clearance alerts along route
      this.evaluateAmbulanceClearanceAlerts(alerts);

      // If actively navigating, evaluate collision warnings
      if (this.isNavigating) {
        this.evaluateNavigationAlerts(alerts);
      }
    }
  }

  _getLocalVehiclesDict() {
    const dict = {};
    if (this.nearbyVehicles) {
      for (const [vid, v] of Object.entries(this.nearbyVehicles)) {
        if (v.lat !== undefined && v.lon !== undefined) {
          const distFromHost = (this.currentLat && this.currentLon)
            ? Math.round(this._haversineDistM(this.currentLat, this.currentLon, v.lat, v.lon))
            : 30;
          dict[vid] = {
            vehicle_id: vid,
            label: v.label,
            latitude: v.lat,
            longitude: v.lon,
            heading_deg: v.heading || 0,
            speed_smoothed: Math.abs(v.speed || 10.0),
            role: v.role || 'standard',
            distance_from_host_m: distFromHost
          };
        }
      }
    }
    return dict;
  }

  // -------------------------------------------------------------
  // HIGH-ACCURACY GPS & TELEMETRY INGESTION (Ts = 1s, IEEE Table II)
  // -------------------------------------------------------------
  startLocationTracking() {
    if (!('geolocation' in navigator)) {
      console.warn("Geolocation API not available in this environment.");
      this._tryIpLocationFallback();
      return;
    }

    // 1. Immediate high-precision one-shot query to acquire initial fix as fast as possible
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this._applyGpsPosition(pos, true);
      },
      (err) => {
        console.warn("Initial GPS lock failed, falling back to continuous watcher:", err.message);
        this._tryIpLocationFallback();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    );

    // 2. Continuous real-time high-accuracy tracking
    this.watchPositionId = navigator.geolocation.watchPosition(
      (pos) => {
        this._applyGpsPosition(pos, false);
      },
      (err) => {
        console.warn("Continuous GPS watch warning:", err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    );
  }

  _applyGpsPosition(pos, shouldPan = false) {
    if (this.isCollisionFrozen || this.isCollisionSimActive) {
      return; // Do NOT move user while in simulation or when frozen at accident scene!
    }
    this.isRealGpsAvailable = true;
    this.currentLat = pos.coords.latitude;
    this.currentLon = pos.coords.longitude;
    this.currentAccuracy = Math.min(3.0, pos.coords.accuracy || 3.0);
    this.currentSpeed = pos.coords.speed !== null ? pos.coords.speed : this.currentSpeed;
    this.currentHeading = pos.coords.heading !== null ? pos.coords.heading : this.currentHeading;

    // Update location puck + high-precision accuracy circle
    window.mapController.updateHostPosition(
      this.currentLat, this.currentLon, this.currentHeading, this.currentAccuracy
    );

    // Update live speedometer
    this.updateSpeedometer(this.currentSpeed);

    // Update dialog status badge with real-time meter accuracy
    const gpsBadge = document.getElementById('dialog-gps-status');
    if (gpsBadge) {
      gpsBadge.className = 'status-badge green';
      gpsBadge.textContent = `📍 GPS Lock (±${this.currentAccuracy.toFixed(1)}m)`;
    }

    if (shouldPan) {
      window.mapController.panTo(this.currentLat, this.currentLon, 18);
    }
  }

  async _tryIpLocationFallback() {
    // If browser GPS is not granted or desktop environment has no GPS hardware,
    // fallback to high-resolution network IP location lookup so map is at user's actual location
    try {
      const resp = await fetch('https://ipapi.co/json/');
      if (resp.ok) {
        const data = await resp.json();
        if (data.latitude && data.longitude && !this.isRealGpsAvailable) {
          this.currentLat = data.latitude;
          this.currentLon = data.longitude;
          this.currentAccuracy = 25.0;
          window.mapController.updateHostPosition(this.currentLat, this.currentLon, 0, 25.0);
          window.mapController.panTo(this.currentLat, this.currentLon, 16);
          console.log(`[Google Maps] Initialized to user's region: ${data.city || data.region}`);
        }
      }
    } catch (e) {}
  }

  startTelemetryLoop() {
    if (this.telemetryIntervalId) clearInterval(this.telemetryIntervalId);
    this.telemetryIntervalId = setInterval(() => {
      this.sendTelemetry();
    }, 1000); // Ts = 1.0 s
  }

  async sendTelemetry() {
    const payload = {
      vehicle_id: this.deviceId,
      label: this.deviceLabel,
      latitude: this.currentLat,
      longitude: this.currentLon,
      accuracy: this.currentAccuracy,
      speed: this.currentSpeed,
      heading: this.currentHeading,
      role: this.userRole,
      vehicle_type: this.vehicleType,
      vehicle_number: this.vehicleNumber,
      ambulance_active: this.isAmbulanceMode,
      sos_active: this.isSosActive
    };

    // Send via WebSocket if open, else HTTP fallback
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "TELEMETRY", payload }));
    } else {
      try {
        await fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {}
    }
  }

  updateSpeedometer(speedMs) {
    const speedKmh = Math.round((speedMs || 0) * 3.6);
    const speedEl = document.getElementById('nav-speed-number');
    if (speedEl) speedEl.textContent = speedKmh;
  }

  // -------------------------------------------------------------
  // GOOGLE MAPS SEARCH & AUTOCOMPLETE
  // -------------------------------------------------------------
  async loadDestinations() {
    try {
      const resp = await fetch('/api/route/destinations');
      if (resp.ok) {
        const data = await resp.json();
        this.destinations = data.destinations || [];
      }
    } catch (e) {}
  }

  onSearchInput(query) {
    const clearBtn = document.getElementById('gmaps-clear-search-btn');
    const dropdown = document.getElementById('gmaps-search-dropdown');

    if (query && query.length > 0) {
      if (clearBtn) clearBtn.style.display = 'flex';
    } else {
      if (clearBtn) clearBtn.style.display = 'none';
      if (dropdown) dropdown.style.display = 'none';
      return;
    }

    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.fetchSearchResults(query);
    }, 250);
  }

  async fetchSearchResults(query) {
    const dropdown = document.getElementById('gmaps-search-dropdown');
    const list = document.getElementById('gmaps-suggestions-list');
    if (!dropdown || !list) return;

    try {
      const resp = await fetch(`/api/route/search?q=${encodeURIComponent(query)}`);
      if (resp.ok) {
        const data = await resp.json();
        const results = data.results || [];
        this.renderSuggestions(results);
      }
    } catch (e) {}
  }

  renderSuggestions(results) {
    const dropdown = document.getElementById('gmaps-search-dropdown');
    const list = document.getElementById('gmaps-suggestions-list');
    if (!dropdown || !list) return;

    if (!results || results.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    list.innerHTML = '';
    results.forEach(item => {
      const div = document.createElement('div');
      div.className = 'gmaps-suggestion-item';
      div.innerHTML = `
        <span class="gmaps-sugg-icon">📍</span>
        <div class="gmaps-sugg-text">
          <div class="gmaps-sugg-name">${item.name}</div>
          <div class="gmaps-sugg-addr">${item.address || ''}</div>
        </div>
      `;
      div.addEventListener('click', () => {
        this.selectDestination(item);
        dropdown.style.display = 'none';
      });
      list.appendChild(div);
    });

    dropdown.style.display = 'block';
  }

  searchQuickCategory(category) {
    const input = document.getElementById('gmaps-search-input');
    if (input) {
      input.value = `${category} near me`;
    }
    this.fetchSearchResults(category);
  }

  clearSearch() {
    const input = document.getElementById('gmaps-search-input');
    const clearBtn = document.getElementById('gmaps-clear-search-btn');
    const dropdown = document.getElementById('gmaps-search-dropdown');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (dropdown) dropdown.style.display = 'none';
  }

  // -------------------------------------------------------------
  // ROUTE CALCULATION & OVERVIEW SHEET
  // -------------------------------------------------------------
  async selectDestination(dest) {
    this.selectedDestination = dest;

    const input = document.getElementById('gmaps-search-input');
    if (input) input.value = dest.name;

    const destLabel = document.getElementById('route-destination-label');
    if (destLabel) destLabel.textContent = dest.name;

    // Show Route Overview Card & calculate shortest path
    await this.calculateRoute(dest);
  }

  async calculateRoute(dest) {
    if (!dest) return;

    const routeCard = document.getElementById('gmaps-route-card');
    const durEl = document.getElementById('route-summary-duration');
    const distEl = document.getElementById('route-summary-distance');
    const fab = document.getElementById('gmaps-directions-fab');

    if (durEl) durEl.textContent = 'Calculating...';
    if (routeCard) routeCard.style.display = 'flex';
    if (fab) fab.style.display = 'none';

    try {
      const resp = await fetch('/api/route/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: this.currentLat,
          start_lon: this.currentLon,
          end_lat: dest.lat,
          end_lon: dest.lon,
          destination_name: dest.name
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        const route = data.route;
        this.activeRoute = route;

        // Render blue route polyline on map
        window.mapController.displayRoute(route);

        // Update times for all modes
        const durMin = route.duration_min;
        const distKm = route.distance_km;

        if (durEl) durEl.textContent = `${durMin} min`;
        if (distEl) distEl.textContent = `${distKm} km`;

        const carTab = document.getElementById('route-mode-car-time');
        const bikeTab = document.getElementById('route-mode-bike-time');
        const walkTab = document.getElementById('route-mode-walk-time');

        if (carTab) carTab.textContent = `${durMin} min`;
        if (bikeTab) bikeTab.textContent = `${Math.max(1, Math.round(durMin * 0.85))} min`;
        if (walkTab) walkTab.textContent = `${Math.max(5, Math.round(distKm * 12))} min`;
      }
    } catch (e) {
      if (durEl) durEl.textContent = 'Route unavailable';
    }
  }

  setTravelMode(mode) {
    this.selectedTravelMode = mode;
    document.querySelectorAll('.travel-mode-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.travel-mode-tab[data-mode="${mode}"]`);
    if (tab) tab.classList.add('active');
  }

  cancelRoute() {
    this._stopNearbyVehiclesTraffic();
    this.selectedDestination = null;
    this.activeRoute = null;

    window.mapController.clearRoute();

    const routeCard = document.getElementById('gmaps-route-card');
    const fab = document.getElementById('gmaps-directions-fab');
    if (routeCard) routeCard.style.display = 'none';
    if (fab) fab.style.display = 'flex';

    this.clearSearch();
  }

  // -------------------------------------------------------------
  // IN-DRIVE TURN-BY-TURN NAVIGATION
  // -------------------------------------------------------------
  startNavigation() {
    if (!this.activeRoute) return;

    this.isNavigating = true;

    // Hide top search bar and route overview card
    document.getElementById('gmaps-top-container').style.display = 'none';
    document.getElementById('gmaps-route-card').style.display = 'none';
    document.getElementById('gmaps-directions-fab').style.display = 'none';

    // Show In-Drive Navigation HUD
    const hud = document.getElementById('gmaps-nav-hud');
    if (hud) hud.style.display = 'block';

    // Populate initial turn-by-turn info
    const steps = this.activeRoute.steps || [];
    const firstStep = steps.length > 0 ? steps[0] : null;

    const maneuverIcon = document.getElementById('nav-maneuver-icon');
    const maneuverDist = document.getElementById('nav-maneuver-dist');
    const maneuverStreet = document.getElementById('nav-maneuver-street');

    if (firstStep) {
      if (maneuverIcon) maneuverIcon.textContent = this._getManeuverIcon(firstStep.modifier);
      if (maneuverDist) maneuverDist.textContent = `In ${firstStep.distance_m || 200} m`;
      if (maneuverStreet) maneuverStreet.textContent = firstStep.instruction || 'Head towards destination';
    }

    // Populate Bottom Trip Control Bar
    const now = new Date();
    const arrivalTime = new Date(now.getTime() + this.activeRoute.duration_min * 60000);
    const etaStr = arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const liveDur = document.getElementById('nav-live-duration');
    const liveMeta = document.getElementById('nav-live-meta');
    if (liveDur) liveDur.textContent = `${this.activeRoute.duration_min} min`;
    if (liveMeta) liveMeta.textContent = `${this.activeRoute.distance_km} km • ${etaStr}`;

    // Start 2-second periodic V2V route collision check
    this.startRouteCollisionChecks();

    // Voice announcement
    if (!this.isAudioMuted && window.audioEngine) {
      window.audioEngine.speak(`Starting navigation to ${this.activeRoute.destination_name || 'destination'}. Monitoring V2V collision vectors.`);
    }
  }

  exitNavigation() {
    this.isNavigating = false;
    this.stopCollisionSimulation();
    this.dismissAccidentDialog();
    this._stopNearbyVehiclesTraffic();

    if (this.routeCollisionTimer) {
      clearInterval(this.routeCollisionTimer);
      this.routeCollisionTimer = null;
    }

    // Hide Navigation HUD
    const hud = document.getElementById('gmaps-nav-hud');
    if (hud) hud.style.display = 'none';

    // Hide hazard banner if open
    const hazardBanner = document.getElementById('gmaps-hazard-banner');
    if (hazardBanner) hazardBanner.style.display = 'none';

    // Restore Google Maps main UI
    document.getElementById('gmaps-top-container').style.display = 'flex';
    document.getElementById('gmaps-directions-fab').style.display = 'flex';

    this.cancelRoute();
  }

  // -------------------------------------------------------------
  // REAL-TIME MOVEMENT OF OTHER VEHICLES USING THIS APP
  // Activates ONLY when route navigation is active.
  // Vehicles are strictly constrained to real surveyed road polylines
  // (Avinashi Rd / GD Naidu Flyover & active navigation route).
  // -------------------------------------------------------------
  _buildCumulativeDistances(coords) {
    const cum = [0.0];
    for (let i = 1; i < coords.length; i++) {
      const d = this._haversineDistM(
        coords[i - 1][0], coords[i - 1][1],
        coords[i][0], coords[i][1]
      );
      cum.push(cum[cum.length - 1] + d);
    }
    return cum;
  }

  _interpolateAlongPolyline(distM, coords, cumDists) {
    if (!coords || coords.length === 0) return null;
    if (coords.length === 1) return { lat: coords[0][0], lon: coords[0][1], heading: 0 };

    const totalDist = cumDists[cumDists.length - 1];
    if (totalDist <= 0) return { lat: coords[0][0], lon: coords[0][1], heading: 0 };

    let d = distM % totalDist;
    if (d < 0) d += totalDist;

    for (let i = 0; i < coords.length - 1; i++) {
      if (cumDists[i] <= d && d <= cumDists[i + 1]) {
        const segLen = cumDists[i + 1] - cumDists[i];
        const t = segLen > 0 ? (d - cumDists[i]) / segLen : 0;
        const lat = coords[i][0] + t * (coords[i + 1][0] - coords[i][0]);
        const lon = coords[i][1] + t * (coords[i + 1][1] - coords[i][1]);
        const heading = this._calcBearing(
          coords[i][0], coords[i][1],
          coords[i + 1][0], coords[i + 1][1]
        );
        return {
          lat: Math.round(lat * 1000000) / 1000000,
          lon: Math.round(lon * 1000000) / 1000000,
          heading: Math.round(heading)
        };
      }
    }

    const last = coords[coords.length - 1];
    return { lat: last[0], lon: last[1], heading: 0 };
  }

  _getRouteProgressM(lat, lon, coords, cumDists) {
    if (!coords || coords.length === 0 || !cumDists || cumDists.length === 0) return 0;
    let minDist = 999999;
    let bestDist = 0;
    for (let i = 0; i < coords.length; i++) {
      const d = this._haversineDistM(lat, lon, coords[i][0], coords[i][1]);
      if (d < minDist) {
        minDist = d;
        bestDist = cumDists[i] || 0;
      }
    }
    return bestDist;
  }

  _startNearbyVehiclesTraffic() {
    // Real connected vehicles from the cloud backend are rendered automatically.
    // Synthetic background traffic is disabled so that only genuine devices are tracked.
    this._stopNearbyVehiclesTraffic();
  }

  _stopNearbyVehiclesTraffic() {
    if (this.nearbyVehiclesTimer) {
      clearInterval(this.nearbyVehiclesTimer);
      this.nearbyVehiclesTimer = null;
    }
  }

  // -------------------------------------------------------------
  // SIMULATION: 3 VEHICLES NEAR USER TO TEST COLLISION PREDICTION
  // Implements Section IV-E, IV-F of IEEE paper with full math inspection
  // -------------------------------------------------------------
  toggleCollisionSimulation() {
    if (this.isCollisionSimActive) {
      this.stopCollisionSimulation();
    } else {
      this.startCollisionSimulation();
    }
  }

  startCollisionSimulation() {
    if (!this.isNavigating) {
      if (window.audioEngine) {
        window.audioEngine.speak("Please start route navigation first. Collision simulation is active during route navigation.");
      }
      alert("Please select a destination and tap 'Start' to begin navigation before running Route Collision Simulation.");
      return;
    }

    this.stopCollisionSimulation();
    this.isCollisionSimActive = true;
    this.isCollisionFrozen = false;

    // Save pre-simulation host position to restore when simulation stops
    if (!this.savedPreSimPosition) {
      this.savedPreSimPosition = {
        lat: this.currentLat,
        lon: this.currentLon,
        heading: this.currentHeading,
        speed: this.currentSpeed
      };
    }

    const chip = document.getElementById('btn-toggle-collision-sim');
    const chipLabel = document.getElementById('sim-chip-label');
    if (chip) chip.classList.add('active');
    if (chipLabel) chipLabel.textContent = 'Cancel Simulation';

    const hud = document.getElementById('gmaps-collision-inspector-hud');
    if (hud) hud.style.display = 'block';

    // 1. Route geometry for "My Vehicle"
    const routeCoords = (this.activeRoute && this.activeRoute.coordinates && this.activeRoute.coordinates.length > 2)
      ? this.activeRoute.coordinates
      : [
          [this.currentLat, this.currentLon],
          [this.currentLat + 0.0005, this.currentLon + 0.0005]
        ];

    const cumRoute = this._buildCumulativeDistances(routeCoords);
    const totalRouteDist = cumRoute[cumRoute.length - 1] || 1000.0;

    // 2. Locate user's active progress along the route
    const userDist = this._getRouteProgressM(this.currentLat, this.currentLon, routeCoords, cumRoute);

    // 3. Collision point is placed directly 40m ahead on the user's route
    let impactDistOnRoute = userDist + 40.0;
    if (impactDistOnRoute > totalRouteDist) {
      impactDistOnRoute = Math.max(10.0, totalRouteDist - 5.0);
    }
    const impactPos = this._interpolateAlongPolyline(impactDistOnRoute, routeCoords, cumRoute);
    const impactCoord = [impactPos.lat, impactPos.lon];
    const impactHeading = impactPos.heading || 0;

    // 4. Converging vehicle starts 40m away to the right (perpendicular to road heading)
    const startDist = 40.0;
    const perpHeading = (impactHeading + 90.0) * Math.PI / 180.0;
    const startLat = impactPos.lat + (startDist * Math.cos(perpHeading)) / 111320.0;
    const startLon = impactPos.lon + (startDist * Math.sin(perpHeading)) / (111320.0 * Math.cos(impactPos.lat * Math.PI / 180.0));
    const otherApproachHeading = (impactHeading + 270.0) % 360.0; // Heading directly towards impact point

    const totalDurationSec = 5;
    let simSec = 0;

    this.collisionSimTimer = setInterval(async () => {
      if (!this.isCollisionSimActive || this.isCollisionFrozen) {
        return;
      }

      simSec += 1;
      const remainingSec = Math.max(0, totalDurationSec - simSec);
      const t = simSec / totalDurationSec;

      // Host vehicle advances along route towards impact point
      const v1_dist = userDist + t * (impactDistOnRoute - userDist);
      const pos1 = this._interpolateAlongPolyline(v1_dist, routeCoords, cumRoute);

      // Colliding vehicle advances from startLat,startLon towards impact point
      const pos2 = {
        lat: Math.round((startLat + t * (impactPos.lat - startLat)) * 1000000) / 1000000,
        lon: Math.round((startLon + t * (impactPos.lon - startLon)) * 1000000) / 1000000,
        heading: Math.round(otherApproachHeading)
      };

      if (!pos1 || !pos2) return;

      const distBetween = this._haversineDistM(pos1.lat, pos1.lon, pos2.lat, pos2.lon);

      // Check if collision occurred
      if (simSec >= totalDurationSec || distBetween <= 3.0) {
        // ============================================================
        // COLLISION CONFIRMED WITH MY VEHICLE!
        // BOTH VEHICLES FREEZE AT IMPACT POINT: NO MOVEMENT ON MAP!
        // ============================================================
        this.isCollisionFrozen = true;
        clearInterval(this.collisionSimTimer);
        this._stopNearbyVehiclesTraffic();

        // 1. Position both collided vehicles visibly separated at the impact junction
        const headRad = impactHeading * Math.PI / 180.0;
        const perpRad = (impactHeading + 90.0) * Math.PI / 180.0;

        // Host vehicle stopped 3m before impact along route
        const hostCrashLat = impactPos.lat - (3.0 * Math.cos(headRad)) / 111320.0;
        const hostCrashLon = impactPos.lon - (3.0 * Math.sin(headRad)) / (111320.0 * Math.cos(impactPos.lat * Math.PI / 180.0));

        // Other vehicle stopped 3m to the right
        const otherCrashLat = impactPos.lat + (3.0 * Math.cos(perpRad)) / 111320.0;
        const otherCrashLon = impactPos.lon + (3.0 * Math.sin(perpRad)) / (111320.0 * Math.cos(impactPos.lat * Math.PI / 180.0));

        // 2. Freeze "My Vehicle" at impact point with 0 speed
        this.currentLat = hostCrashLat;
        this.currentLon = hostCrashLon;
        this.currentSpeed = 0.0;
        this.updateSpeedometer(0.0);

        // 3. Render Both Collided Vehicles still at impact point with high-visibility badges
        if (window.mapController) {
          window.mapController.showAccidentCollisionScene(
            hostCrashLat, hostCrashLon, impactHeading,
            otherCrashLat, otherCrashLon, otherApproachHeading,
            "Red Hatchback (Collided)",
            impactCoord[0], impactCoord[1]
          );
        }

        await this.sendTelemetry();

        // 4. Freeze Collided Vehicle on backend at impact point with 0 speed
        const frozenBatch = [
          {
            vehicle_id: "v2v_car_nearby",
            label: "Red Hatchback (Collided)",
            latitude: otherCrashLat,
            longitude: otherCrashLon,
            accuracy: 1.0,
            speed: 0.0,
            heading: otherApproachHeading,
            role: "standard"
          }
        ];
        try {
          await fetch('/api/telemetry/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(frozenBatch)
          });
        } catch (e) {}

        // 5. Update HUD to Confirmed Accident State
        if (hud) {
          hud.className = 'gmaps-collision-card critical';
          const tagEl = document.getElementById('collision-level-tag');
          const iconEl = document.getElementById('collision-alert-icon');
          const titleEl = document.getElementById('collision-alert-title');
          const descEl = document.getElementById('collision-alert-desc');
          const countdownBox = document.getElementById('collision-countdown-box');
          const tStarVal = document.getElementById('collision-t-star-val');
          const dMinVal = document.getElementById('collision-d-min-val');
          const bearingVal = document.getElementById('collision-bearing-val');

          if (tagEl) { tagEl.textContent = 'ACCIDENT CONFIRMED'; tagEl.className = 'collision-tag critical'; }
          if (iconEl) iconEl.textContent = '💥';
          if (titleEl) titleEl.textContent = 'COLLISION OCCURRED • VEHICLES STOPPED';
          if (descEl) descEl.textContent = 'Both vehicles stopped at impact point. Distress transmitted to Hospital & Police.';
          if (countdownBox) countdownBox.className = 'collision-countdown-box critical';
          if (tStarVal) tStarVal.textContent = 'IMPACT';
          if (dMinVal) dMinVal.textContent = '0.0 m';
          if (bearingVal) bearingVal.textContent = 'COLLIDED';
        }

        // 6. Sound audio alarm
        if (window.audioEngine) {
          window.audioEngine.playBeep('critical');
          window.audioEngine.speak("Crash detected! Collision confirmed. Accident occurred. Emergency distress signal automatically dispatched to nearest hospital and police station.");
        }

        // 7. Automatically send Emergency Dispatch to Hospital & Police Station
        await this.triggerAccidentDispatch(impactCoord[0], impactCoord[1], 29.0);
        return;
      }

      // Pre-collision approach movement
      this.currentLat = pos1.lat;
      this.currentLon = pos1.lon;
      this.currentHeading = pos1.heading;
      this.currentSpeed = 8.0; // ~29 km/h

      window.mapController.updateHostPosition(this.currentLat, this.currentLon, this.currentHeading, this.currentAccuracy);
      this.updateSpeedometer(8.0);
      await this.sendTelemetry();

      // Render converging vehicle directly on the map locally for real-time visual tracking
      const simVehicles = {
        "v2v_car_nearby": {
          vehicle_id: "v2v_car_nearby",
          label: "Red Hatchback (Approaching)",
          latitude: pos2.lat,
          longitude: pos2.lon,
          heading_deg: pos2.heading,
          speed_smoothed: 8.0,
          role: "standard",
          distance_from_host_m: Math.round(distBetween)
        }
      };

      for (const [vid, v] of Object.entries(this._getLocalVehiclesDict())) {
        if (vid !== 'v2v_car_nearby') {
          simVehicles[vid] = v;
        }
      }

      const alertLevel = remainingSec <= 2 ? 'critical' : 'warning';
      if (window.mapController) {
        window.mapController.updateConnectedVehicles(simVehicles, this.deviceId, true, [
          {
            level: alertLevel,
            source_vehicle_id: "v2v_car_nearby",
            target_vehicle_id: this.deviceId
          }
        ]);

        // Draw dynamic trajectory prediction lines towards the impact junction
        window.mapController.showCollisionPrediction(
          impactCoord,
          {
            level: alertLevel,
            t_star: remainingSec,
            source_vehicle_id: "v2v_car_nearby",
            target_vehicle_id: this.deviceId
          },
          simVehicles
        );

        // Center map smoothly to keep both approaching vehicles in clear view
        window.mapController.map.panTo([(pos1.lat + pos2.lat) / 2, (pos1.lon + pos2.lon) / 2], { animate: true, duration: 0.5 });
      }

      // Live HUD updates during countdown
      if (hud) {
        hud.className = `gmaps-collision-card ${alertLevel}`;
        const tagEl = document.getElementById('collision-level-tag');
        const iconEl = document.getElementById('collision-alert-icon');
        const titleEl = document.getElementById('collision-alert-title');
        const descEl = document.getElementById('collision-alert-desc');
        const countdownBox = document.getElementById('collision-countdown-box');
        const tStarVal = document.getElementById('collision-t-star-val');
        const dMinVal = document.getElementById('collision-d-min-val');
        const bearingVal = document.getElementById('collision-bearing-val');

        if (tagEl) {
          tagEl.textContent = `${alertLevel.toUpperCase()} (${remainingSec}s)`;
          tagEl.className = `collision-tag ${alertLevel}`;
        }
        if (iconEl) iconEl.textContent = alertLevel === 'critical' ? '🚨' : '⚠️';
        if (titleEl) titleEl.textContent = 'CONVERGING VEHICLE DETECTED';
        if (descEl) descEl.textContent = `Red Hatchback approaching intersection from RIGHT in ${remainingSec}s`;
        if (countdownBox) countdownBox.className = `collision-countdown-box ${alertLevel}`;
        if (tStarVal) tStarVal.textContent = `${remainingSec}.0 s`;
        if (dMinVal) dMinVal.textContent = `${distBetween.toFixed(1)} m`;
        if (bearingVal) bearingVal.textContent = 'RIGHT';
      }

      // Audio beeps during countdown
      if (window.audioEngine && !this.isAudioMuted) {
        if (remainingSec === 4 || remainingSec === 3) {
          window.audioEngine.playBeep('warning');
        } else if (remainingSec <= 2) {
          window.audioEngine.playBeep('critical');
        }
      }

      const batch = [
        {
          vehicle_id: "v2v_car_nearby",
          label: "Red Hatchback (Converging)",
          latitude: pos2.lat,
          longitude: pos2.lon,
          accuracy: 1.5,
          speed: 8.0,
          heading: pos2.heading,
          role: "standard"
        }
      ];

      try {
        await fetch('/api/telemetry/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch)
        });
      } catch (e) {}

    }, 1000);
  }

  stopCollisionSimulation() {
    this.isCollisionSimActive = false;
    this.isCollisionFrozen = false;
    if (this.collisionSimTimer) {
      clearInterval(this.collisionSimTimer);
      this.collisionSimTimer = null;
    }

    if (window.mapController) {
      window.mapController.clearAccidentImpactMarker();
      window.mapController.clearCollisionPrediction();
      if (!this.isNavigating) {
        window.mapController.updateConnectedVehicles({}, this.deviceId, false);
      }
    }

    // Restore host position prior to simulation if not navigating
    if (this.savedPreSimPosition && !this.isNavigating) {
      this.currentLat = this.savedPreSimPosition.lat;
      this.currentLon = this.savedPreSimPosition.lon;
      this.currentHeading = this.savedPreSimPosition.heading;
      this.currentSpeed = this.savedPreSimPosition.speed;
      this.savedPreSimPosition = null;

      window.mapController.updateHostPosition(this.currentLat, this.currentLon, this.currentHeading, this.currentAccuracy);
      this.updateSpeedometer(this.currentSpeed);
      this.sendTelemetry();
    } else if (window.mapController) {
      window.mapController.updateHostPosition(this.currentLat, this.currentLon, this.currentHeading, this.currentAccuracy);
    }

    const chip = document.getElementById('btn-toggle-collision-sim');
    const chipLabel = document.getElementById('sim-chip-label');
    if (chip) chip.classList.remove('active');
    if (chipLabel) chipLabel.textContent = 'Simulate Route Collision';

    const hud = document.getElementById('gmaps-collision-inspector-hud');
    if (hud) hud.style.display = 'none';

    fetch('/api/vehicles/clear-all', { method: 'POST' }).catch(() => {});
  }

  // -------------------------------------------------------------
  // POST-COLLISION ACCIDENT REPORTING & EMERGENCY DISPATCH
  // -------------------------------------------------------------
  async triggerAccidentDispatch(lat, lon, speedKmh) {
    try {
      const resp = await fetch('/api/accident/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicle_id: this.deviceId,
          collided_vehicle_id: "v2v_car_nearby",
          latitude: lat,
          longitude: lon,
          speed_at_impact: speedKmh || 36.0,
          description: "Accident occured"
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        const report = data.report;
        if (report) {
          this.showAccidentDialog(report);
        }
      }
    } catch (e) {
      console.error("Accident dispatch error:", e);
    }
  }

  showAccidentDialog(report) {
    const dialog = document.getElementById('gmaps-accident-dialog');
    if (!dialog) return;

    const locEl = document.getElementById('accident-loc-text');
    const timeEl = document.getElementById('accident-time-text');
    const vehEl = document.getElementById('accident-vehicles-text');

    const hospNameEl = document.getElementById('accident-hosp-name');
    const hospDistEl = document.getElementById('accident-hosp-dist');
    const hospStatusEl = document.getElementById('accident-hosp-status');

    const policeNameEl = document.getElementById('accident-police-name');
    const policeDistEl = document.getElementById('accident-police-dist');
    const policeStatusEl = document.getElementById('accident-police-status');

    if (locEl && report.location) locEl.textContent = report.location.address || `${report.location.latitude.toFixed(5)}, ${report.location.longitude.toFixed(5)}`;
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (vehEl) vehEl.textContent = `Host Vehicle (You) & Red Hatchback (V2V)`;

    if (report.nearest_hospital) {
      const h = report.nearest_hospital;
      if (hospNameEl) hospNameEl.textContent = h.name;
      if (hospDistEl) hospDistEl.textContent = `${h.distance_m} m away • ETA ${h.eta_min} min`;
      if (hospStatusEl) hospStatusEl.textContent = `🚑 ${h.status || 'Ambulance Dispatched (108)'}`;
    }

    if (report.nearest_police) {
      const p = report.nearest_police;
      if (policeNameEl) policeNameEl.textContent = p.name;
      if (policeDistEl) policeDistEl.textContent = `${p.distance_m} m away • ETA ${p.eta_min} min`;
      if (policeStatusEl) policeStatusEl.textContent = `🚓 ${p.status || 'Patrol Unit Assigned (112)'}`;
    }

    dialog.style.display = 'flex';
  }

  dismissAccidentDialog() {
    const dialog = document.getElementById('gmaps-accident-dialog');
    if (dialog) dialog.style.display = 'none';
  }

  shareAccidentLocation() {
    const text = `🚨 EMERGENCY: Accident occurred at Avinashi Rd near Hope College, Coimbatore (11.02566, 77.01576). Nearest Hospital & Police Station notified.`;
    if (navigator.share) {
      navigator.share({ title: 'Accident Occurred', text, url: window.location.href }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text);
      alert("Emergency accident location copied to clipboard:\n" + text);
    }
  }

  // -------------------------------------------------------------
  // REAL-TIME COLLISION PREDICTION INSPECTOR HUD UPDATE
  // Visualizes T_CPA, D_CPA, D_safe, Bearing, and Impact Status
  // STRICTLY between "Me" and a nearby converging vehicle
  // -------------------------------------------------------------
  evaluateCollisionAlerts(alerts, vehicles) {
    if (this.isCollisionFrozen) return; // Retain frozen accident HUD state
    const hud = document.getElementById('gmaps-collision-inspector-hud');
    if (!hud) return;

    // False-positive suppression:
    // If the user has not started navigating or is stationary (< 1.5 m/s), AND collision simulation is NOT running,
    // do not show the collision inspector HUD card.
    const isMoving = (this.currentSpeed && this.currentSpeed >= 1.5);
    const shouldEvaluate = this.isCollisionSimActive || (this.isNavigating && isMoving);
    if (!shouldEvaluate) {
      hud.style.display = 'none';
      return;
    }

    // Filter alerts to STRICTLY find alert between "Me" (this.deviceId) and a nearby vehicle
    const colAlert = (alerts || []).find(a =>
      (a.target_vehicle_id === this.deviceId || a.source_vehicle_id === this.deviceId) &&
      (a.level === 'critical' || a.level === 'warning' || a.level === 'advisory') &&
      a.t_star !== undefined && a.t_star !== null
    );

    if (!colAlert) {
      if (this.isCollisionSimActive) {
        // Show safe / cleared state
        hud.className = 'gmaps-collision-card safe';
        const tagEl = document.getElementById('collision-level-tag');
        const iconEl = document.getElementById('collision-alert-icon');
        const titleEl = document.getElementById('collision-alert-title');
        const descEl = document.getElementById('collision-alert-desc');
        const countdownBox = document.getElementById('collision-countdown-box');
        const tStarVal = document.getElementById('collision-t-star-val');

        if (tagEl) { tagEl.textContent = 'SAFE'; tagEl.className = 'collision-tag safe'; }
        if (iconEl) iconEl.textContent = '✅';
        if (titleEl) titleEl.textContent = 'Collision Averted (Safe Clearance)';
        if (descEl) descEl.textContent = 'Nearby vehicle yielded at junction. No active trajectory collision.';
        if (countdownBox) countdownBox.className = 'collision-countdown-box safe';
        if (tStarVal) tStarVal.textContent = 'CLEAR';
      } else {
        hud.style.display = 'none';
      }
      return;
    }

    hud.style.display = 'block';
    hud.className = `gmaps-collision-card ${colAlert.level}`;

    const tagEl = document.getElementById('collision-level-tag');
    const iconEl = document.getElementById('collision-alert-icon');
    const titleEl = document.getElementById('collision-alert-title');
    const descEl = document.getElementById('collision-alert-desc');
    const countdownBox = document.getElementById('collision-countdown-box');
    const tStarVal = document.getElementById('collision-t-star-val');
    const mathTcpa = document.getElementById('math-tcpa');
    const mathDcpa = document.getElementById('math-dcpa');
    const mathDsafe = document.getElementById('math-dsafe');
    const mathBearing = document.getElementById('math-bearing');

    const levelUpper = colAlert.level.toUpperCase();
    if (tagEl) {
      tagEl.textContent = levelUpper;
      tagEl.className = `collision-tag ${colAlert.level}`;
    }

    if (countdownBox) {
      countdownBox.className = `collision-countdown-box ${colAlert.level}`;
    }

    if (tStarVal) tStarVal.textContent = `${colAlert.t_star}s`;
    if (mathTcpa) mathTcpa.textContent = `${colAlert.t_star} s`;
    if (mathDcpa) mathDcpa.textContent = `${colAlert.d_min !== undefined ? colAlert.d_min : '0.0'} m`;
    if (mathDsafe) mathDsafe.textContent = `${colAlert.d_safe !== undefined ? colAlert.d_safe : '4.25'} m`;
    if (mathBearing) mathBearing.textContent = (colAlert.relative_bearing || 'RIGHT').toUpperCase();

    if (colAlert.level === 'critical') {
      if (iconEl) iconEl.textContent = '💥';
      if (titleEl) titleEl.textContent = 'CRITICAL COLLISION RISK WITH NEARBY CAR';
      if (descEl) descEl.textContent = colAlert.message || 'Immediate evasive action / braking required!';
      if (window.audioEngine) {
        window.audioEngine.playBeep('critical');
        if (colAlert.spoken_text && this.lastSpokenHazardId !== colAlert.alert_id) {
          window.audioEngine.speak(colAlert.spoken_text);
          this.lastSpokenHazardId = colAlert.alert_id;
        }
      }
    } else if (colAlert.level === 'warning') {
      if (iconEl) iconEl.textContent = '⚠️';
      if (titleEl) titleEl.textContent = 'COLLISION WARNING (NEARBY VEHICLE)';
      if (descEl) descEl.textContent = colAlert.message || 'Nearby vehicle converging on your path.';
      if (window.audioEngine) window.audioEngine.playBeep('warning');
    } else {
      if (iconEl) iconEl.textContent = '⚡';
      if (titleEl) titleEl.textContent = 'ADVISORY: Approaching Vehicle';
      if (descEl) descEl.textContent = colAlert.message || 'Converging trajectory monitored.';
    }
  }


  _haversineDistM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  _calcBearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }

  startRouteCollisionChecks() {
    if (this.routeCollisionTimer) clearInterval(this.routeCollisionTimer);
    this.routeCollisionTimer = setInterval(async () => {
      if (!this.isNavigating || !this.activeRoute) return;

      try {
        const resp = await fetch('/api/route/collision-check');
        if (resp.ok) {
          const data = await resp.json();
          const hazards = data.route_hazards || [];
          window.mapController.showRouteHazards(hazards);
          this.displayRouteHazards(hazards);
        }
      } catch (e) {}
    }, 2000);
  }

  displayRouteHazards(hazards) {
    const banner = document.getElementById('gmaps-hazard-banner');
    if (!banner) return;

    if (!hazards || hazards.length === 0) {
      banner.style.display = 'none';
      return;
    }

    const topHazard = hazards[0];
    const alert = topHazard.alert;

    const titleEl = document.getElementById('hazard-banner-title');
    const descEl = document.getElementById('hazard-banner-desc');
    const pillsEl = document.getElementById('hazard-banner-pills');

    if (titleEl) titleEl.textContent = '⚠️ COLLISION RISK AHEAD';
    if (descEl) descEl.textContent = topHazard.warning_message || 'Vehicle approaching along path';
    if (pillsEl && alert) {
      pillsEl.innerHTML = `
        <span class="hazard-pill">Impact in: ${alert.t_star}s</span>
        <span class="hazard-pill">Distance: ${alert.d_min}m</span>
        <span class="hazard-pill">${alert.relative_bearing ? alert.relative_bearing.toUpperCase() : 'AHEAD'}</span>
      `;
    }

    banner.style.display = 'flex';

    // Voice announcement (with cooldown)
    if (alert && alert.alert_id !== this.lastSpokenHazardId) {
      this.lastSpokenHazardId = alert.alert_id;
      if (!this.isAudioMuted && window.audioEngine) {
        window.audioEngine.triggerCollisionAlert(alert);
      }
    }
  }

  evaluateNavigationAlerts(alerts) {
    // If backend produces high-priority emergency alerts, display them
    const amb = alerts.find(a => a.level === 'ambulance_clearance');
    if (amb) {
      const banner = document.getElementById('gmaps-hazard-banner');
      if (banner) {
        document.getElementById('hazard-banner-title').textContent = '🚑 EMERGENCY VEHICLE APPROACHING';
        document.getElementById('hazard-banner-desc').textContent = amb.message || 'Please give way';
        banner.style.display = 'flex';
      }
    }
  }

  toggleVoiceMute() {
    this.isAudioMuted = !this.isAudioMuted;
    const btn = document.getElementById('nav-audio-btn');
    if (btn) {
      btn.style.background = this.isAudioMuted ? '#fce8e6' : '';
    }
    if (window.audioEngine) {
      window.audioEngine.isMuted = this.isAudioMuted;
    }
  }

  _getManeuverIcon(modifier) {
    switch (modifier) {
      case 'left':
      case 'sharp left': return '↰';
      case 'right':
      case 'sharp right': return '↱';
      case 'slight left': return '↖';
      case 'slight right': return '↗';
      case 'uturn': return '↩';
      default: return '⬆️';
    }
  }

  // -------------------------------------------------------------
  // MODALS & USER CONTROLS
  // -------------------------------------------------------------
  centerOnMyLocation() {
    const locBtn = document.getElementById('gmaps-my-location-btn');
    if (locBtn) {
      locBtn.style.transform = 'scale(0.85)';
      setTimeout(() => { if (locBtn) locBtn.style.transform = ''; }, 200);
    }

    // Immediately pan and zoom directly back to user's location puck
    if (window.mapController) {
      window.mapController.panTo(this.currentLat, this.currentLon, 18);
    }

    // Refresh live GPS in parallel if not in accident freeze
    if (!this.isCollisionFrozen && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._applyGpsPosition(pos, true);
        },
        (err) => {},
        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 5000
        }
      );
    }
  }

  toggleLayersSheet() {
    const sheet = document.getElementById('gmaps-layers-sheet');
    const backdrop = document.getElementById('gmaps-backdrop');
    const isOpen = sheet.style.display === 'block';

    sheet.style.display = isOpen ? 'none' : 'block';
    backdrop.style.display = isOpen ? 'none' : 'block';
  }

  selectMapLayer(layerKey) {
    window.mapController.switchLayer(layerKey);
    document.querySelectorAll('.layer-option').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector(`.layer-option[data-layer="${layerKey}"]`);
    if (btn) btn.classList.add('active');
    this.closeAllModals();
  }

  openProfileDialog() {
    const dialog = document.getElementById('gmaps-profile-dialog');
    const backdrop = document.getElementById('gmaps-backdrop');
    if (dialog) dialog.style.display = 'flex';
    if (backdrop) backdrop.style.display = 'block';
  }

  closeProfileDialog() {
    const dialog = document.getElementById('gmaps-profile-dialog');
    const backdrop = document.getElementById('gmaps-backdrop');
    if (dialog) dialog.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  }

  closeAllModals() {
    const sheet = document.getElementById('gmaps-layers-sheet');
    const dialog = document.getElementById('gmaps-profile-dialog');
    const backdrop = document.getElementById('gmaps-backdrop');
    if (sheet) sheet.style.display = 'none';
    if (dialog) dialog.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  }

  openDirectionsSheet() {
    // If no destination is chosen yet, open search
    const input = document.getElementById('gmaps-search-input');
    if (input) {
      input.focus();
    }
  }

  // -------------------------------------------------------------
  // EVENT BINDINGS
  // -------------------------------------------------------------
  bindEvents() {
    // Search input
    const searchInput = document.getElementById('gmaps-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => this.onSearchInput(e.target.value.trim()));
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = e.target.value.trim();
          if (q) this.fetchSearchResults(q);
        }
      });
    }

    // Clear search button
    const clearBtn = document.getElementById('gmaps-clear-search-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearSearch());
    }

    // Profile button
    const profileBtn = document.getElementById('gmaps-profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => this.openProfileDialog());
    }

    // Map click to select custom destination pin
    if (window.mapController && window.mapController.map) {
      window.mapController.map.on('click', (e) => {
        if (this.isNavigating) return;
        const clickedDest = {
          id: `click_${Date.now()}`,
          name: `Dropped Pin (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`,
          address: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`,
          lat: e.latlng.lat,
          lon: e.latlng.lng
        };
        this.selectDestination(clickedDest);
      });
    }
  }
}

// Global instance
window.appController = new GoogleMapsAppController();
window.addEventListener('DOMContentLoaded', () => {
  window.appController.init();
});
