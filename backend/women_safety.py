"""
Women Safety Support & SOS Emergency Service
Implements Section V-B of IEEE paper:
- Opt-in Women Safety mode
- Emergency Guardian contact management
- One-touch SOS Button trigger
- Real-time location sharing via unique tracking token
- Simulated SMS Gateway & Push Notification dispatcher
- Continuous position updates until cancelled
"""

import time
import uuid
from typing import Dict, List, Optional, Any
from backend.models import GuardianContact, SOSPayload, SOSState

class WomenSafetyService:
    def __init__(self):
        # user_id -> List[GuardianContact]
        self.contacts_db: Dict[str, List[GuardianContact]] = {
            "default_user": [
                GuardianContact(
                    id="gc_1",
                    name="Parent / Father",
                    phone="+91 98421 12345",
                    relationship="Father",
                    is_primary=True
                ),
                GuardianContact(
                    id="gc_2",
                    name="Sister / Guardian",
                    phone="+91 94432 67890",
                    relationship="Sister",
                    is_primary=False
                )
            ]
        }
        # active SOS tracking: tracking_token -> SOSState
        self.active_sos: Dict[str, SOSState] = {}
        # user_id -> tracking_token
        self.user_sos_map: Dict[str, str] = {}
        # Outbox / SMS Gateway simulation log
        self.sms_gateway_log: List[Dict[str, Any]] = []

    def get_contacts(self, user_id: str) -> List[GuardianContact]:
        return self.contacts_db.get(user_id, self.contacts_db.get("default_user", []))

    def update_contacts(self, user_id: str, contacts: List[GuardianContact]):
        self.contacts_db[user_id] = contacts

    def trigger_sos(self, payload: SOSPayload, base_url: str = "") -> SOSState:
        """
        Activates SOS: creates tracking token, prepares live location link,
        and simulates immediate SMS dispatch to all configured guardians.
        """
        user_id = payload.user_id
        now = time.time()
        sos_id = f"sos_{int(now)}_{uuid.uuid4().hex[:6]}"
        tracking_token = f"trk_{uuid.uuid4().hex[:10]}"

        # Merge contacts from payload or fallback to saved
        contacts = payload.contacts if payload.contacts else self.get_contacts(user_id)
        if not contacts:
            contacts = self.get_contacts("default_user")

        tracking_url = f"{base_url}/#guardian?token={tracking_token}"

        sms_logs = []
        for contact in contacts:
            sms_text = (
                f"🚨 EMERGENCY ALERT from {payload.user_name}!\n"
                f"Location: https://maps.google.com/?q={payload.latitude},{payload.longitude}\n"
                f"Track live journey: {tracking_url}\n"
                f"Message: {payload.message}\n"
                f"Immediate action needed. Time: {time.strftime('%H:%M:%S', time.localtime(now))}"
            )
            log_entry = {
                "sms_id": f"sms_{uuid.uuid4().hex[:8]}",
                "recipient_name": contact.name,
                "recipient_phone": contact.phone,
                "timestamp": now,
                "status": "DELIVERED",
                "message": sms_text
            }
            sms_logs.append(log_entry)
            self.sms_gateway_log.append(log_entry)

        sos_state = SOSState(
            sos_id=sos_id,
            user_id=user_id,
            user_name=payload.user_name,
            latitude=payload.latitude,
            longitude=payload.longitude,
            timestamp=now,
            active=True,
            tracking_token=tracking_token,
            sms_logs=sms_logs
        )

        self.active_sos[tracking_token] = sos_state
        self.user_sos_map[user_id] = tracking_token
        return sos_state

    def update_sos_location(self, tracking_token: str, lat: float, lon: float) -> Optional[SOSState]:
        if tracking_token in self.active_sos:
            state = self.active_sos[tracking_token]
            state.latitude = lat
            state.longitude = lon
            state.timestamp = time.time()
            return state
        return None

    def cancel_sos(self, user_id: str) -> Optional[SOSState]:
        token = self.user_sos_map.get(user_id)
        if token and token in self.active_sos:
            state = self.active_sos[token]
            state.active = False
            # Log resolution SMS
            for log in state.sms_logs:
                res_entry = {
                    "sms_id": f"sms_res_{uuid.uuid4().hex[:8]}",
                    "recipient_name": log["recipient_name"],
                    "recipient_phone": log["recipient_phone"],
                    "timestamp": time.time(),
                    "status": "DELIVERED",
                    "message": f"✅ SAFE STATUS UPDATE: {state.user_name} has marked the emergency as resolved."
                }
                self.sms_gateway_log.append(res_entry)
            del self.user_sos_map[user_id]
            return state
        return None

    def get_sos_by_token(self, token: str) -> Optional[SOSState]:
        return self.active_sos.get(token)

    def get_all_active_sos(self) -> List[SOSState]:
        return [s for s in self.active_sos.values() if s.active]

