/**
 * Women Safety & SOS Emergency Controller
 * Implements Section V-B of IEEE paper:
 * - One-touch SOS Button
 * - Live location sharing link generation
 * - Emergency guardian contact management
 * - Simulated SMS Gateway outbox logger
 * - Cancel emergency update
 */

class SOSController {
  constructor() {
    this.isActive = false;
    this.trackingToken = null;
    this.sosSession = null;
    this.userId = "user_women_safety";
    this.userName = "Priya S.";
    this.userPhone = "+91 98401 22334";
    this.updateIntervalId = null;
    this.contacts = [];
  }

  async init() {
    await this.loadContacts();
    this.renderContacts();
    await this.refreshSmsLog();
  }

  async loadContacts() {
    try {
      const resp = await fetch('/api/sos/contacts');
      const data = await resp.json();
      this.contacts = data.contacts || [];
    } catch (e) {
      console.warn("Failed to load contacts:", e);
    }
  }

  renderContacts() {
    const listEl = document.getElementById('guardian-contacts-list');
    if (!listEl) return;

    if (this.contacts.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b; font-size:12px;">No emergency contacts added yet.</div>';
      return;
    }

    listEl.innerHTML = this.contacts.map(c => `
      <div class="contact-item">
        <div>
          <div class="contact-name">${c.name} ${c.is_primary ? '⭐ (Primary)' : ''}</div>
          <div class="contact-phone">${c.relationship} • ${c.phone}</div>
        </div>
        <button class="gm-icon-btn" onclick="sosController.callContact('${c.phone}')" title="Call">📞</button>
      </div>
    `).join('');
  }

  async triggerSOS() {
    if (this.isActive) {
      // Toggle off / cancel
      await this.cancelSOS();
      return;
    }

    // Determine current coordinates (real GPS coordinates from appController)
    const lat = (window.appController && window.appController.currentLat) ? window.appController.currentLat : (window.mapController ? window.mapController.defaultLat : 11.02580);
    const lon = (window.appController && window.appController.currentLon) ? window.appController.currentLon : (window.mapController ? window.mapController.defaultLon : 77.01600);

    const payload = {
      user_id: this.userId,
      user_name: this.userName,
      latitude: lat,
      longitude: lon,
      accuracy: 2.0,
      contacts: this.contacts,
      message: "EMERGENCY: Urgent assistance needed! Traveling alone at night."
    };

    try {
      const resp = await fetch('/api/sos/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();

      if (data.status === 'activated') {
        this.isActive = true;
        this.sosSession = data.sos;
        this.trackingToken = data.sos.tracking_token;

        // UI updates
        this.updateSOSUI(true);

        // Sound alarm and speech
        window.audioEngine.startDistressSiren();
        window.audioEngine.speak("Emergency SOS activated. Live location and alert messages dispatched to guardians.", true);

        // Start continuous position reporting
        this.startPositionStream();

        // Refresh SMS log display
        await this.refreshSmsLog();
      }
    } catch (e) {
      console.error("SOS trigger failed:", e);
    }
  }

  async cancelSOS() {
    try {
      const resp = await fetch(`/api/sos/cancel?user_id=${this.userId}`, { method: 'POST' });
      const data = await resp.json();

      this.isActive = false;
      this.sosSession = null;
      this.trackingToken = null;

      if (this.updateIntervalId) {
        clearInterval(this.updateIntervalId);
        this.updateIntervalId = null;
      }

      window.audioEngine.stopDistressSiren();
      window.audioEngine.speak("Emergency status resolved. Safety notice sent to contacts.");

      this.updateSOSUI(false);
      await this.refreshSmsLog();
    } catch (e) {
      console.error("SOS cancel failed:", e);
    }
  }

  updateSOSUI(active) {
    const btn = document.getElementById('sos-main-btn');
    const badge = document.getElementById('sos-badge-status');
    const tokenBox = document.getElementById('sos-tracking-link-box');

    if (btn) {
      if (active) {
        btn.classList.add('active-distress');
        btn.querySelector('.sos-btn-text').innerText = 'ACTIVE';
        btn.querySelector('.sos-btn-sub').innerText = 'TAP TO CANCEL';
      } else {
        btn.classList.remove('active-distress');
        btn.querySelector('.sos-btn-text').innerText = 'SOS';
        btn.querySelector('.sos-btn-sub').innerText = 'ONE-TOUCH PANIC';
      }
    }

    if (badge) {
      if (active) {
        badge.className = 'sos-status-badge sos-active-badge';
        badge.innerHTML = '🚨 DISTRESS ACTIVE • BROADCASTING GPS';
      } else {
        badge.className = 'sos-status-badge sos-standby-badge';
        badge.innerHTML = '🟢 SYSTEM STANDBY • READY';
      }
    }

    if (tokenBox) {
      if (active && this.trackingToken) {
        tokenBox.style.display = 'block';
        const link = `${window.location.origin}/#guardian?token=${this.trackingToken}`;
        const input = document.getElementById('sos-live-link-input');
        if (input) input.value = link;
      } else {
        tokenBox.style.display = 'none';
      }
    }
  }

  startPositionStream() {
    if (this.updateIntervalId) clearInterval(this.updateIntervalId);

    this.updateIntervalId = setInterval(async () => {
      if (!this.isActive || !this.trackingToken) return;

      const hostCar = window.simulationEngine.simulatedVehicles["car_host"];
      const lat = hostCar ? hostCar.latitude : window.mapController.refLat;
      const lon = hostCar ? hostCar.longitude : window.mapController.refLon;

      try {
        await fetch(`/api/sos/update?token=${this.trackingToken}&lat=${lat}&lon=${lon}`, {
          method: 'POST'
        });
      } catch (e) {}
    }, 2000);
  }

  async refreshSmsLog() {
    try {
      const resp = await fetch('/api/sos/sms-log');
      const data = await resp.json();
      const logs = data.sms_logs || [];

      const box = document.getElementById('sms-gateway-log-box');
      if (!box) return;

      if (logs.length === 0) {
        box.innerHTML = '<div style="color:#64748b;">SMS Outbox is idle.</div>';
        return;
      }

      box.innerHTML = logs.slice(-8).reverse().map(l => `
        <div class="sms-log-entry">
          <div class="sms-log-header">📤 [${new Date(l.timestamp * 1000).toLocaleTimeString()}] To: ${l.recipient_name} (${l.recipient_phone}) - STATUS: ${l.status}</div>
          <div style="white-space: pre-wrap; color: #94a3b8;">${l.message}</div>
        </div>
      `).join('');
    } catch (e) {
      console.warn("SMS log fetch failed:", e);
    }
  }

  copyTrackingLink() {
    const input = document.getElementById('sos-live-link-input');
    if (input) {
      input.select();
      navigator.clipboard.writeText(input.value);
      alert("Live Tracking link copied to clipboard! Share this link with guardians.");
    }
  }

  callContact(phone) {
    window.open(`tel:${phone}`);
  }

  callPolice() {
    window.open(`tel:112`);
  }
}

window.sosController = new SOSController();

