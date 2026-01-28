#!/usr/bin/env python3
"""
TierAI IoT Core Simulator (Option 1)
-----------------------------------
Publishes simulated telemetry + state heartbeat + occasional alarms to AWS IoT Core
using MQTT over TLS (mTLS) with X.509 certs.

Topics (PUBLISH):
  - tierai/servexl/edgeblr01/telemetry
  - tierai/servexl/edgeblr01/state      (retained heartbeat)
  - tierai/servexl/edgeblr01/alarms

Requirements:
  pip install paho-mqtt

Files needed in same folder (or update paths):
  - AmazonRootCA1.pem
  - <your-certificate>.pem.crt
  - <your-private>.pem.key

Run:
  python3 tierai_iot_sim.py
"""

import json
import random
import ssl
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from paho.mqtt import client as mqtt


# -----------------------------
# CONFIG (edit these)
# -----------------------------
IOT_ENDPOINT = "a2b9h5i04yynsk-ats.iot.ap-southeast-1.amazonaws.com"
IOT_PORT = 8883

# Use the correct CA file name you downloaded from Amazon Trust Services
CA_FILE = "AmazonRootCA1.pem"

CERT_FILE = "89782870c4795de15f0a654c417aafb0ac7f685f9e68d50801846cb38b848268-certificate.pem.crt"
KEY_FILE = "89782870c4795de15f0a654c417aafb0ac7f685f9e68d50801846cb38b848268-private.pem.key"

TENANT = "servexl"
GATEWAY_ID = "edgeblr01"

# IMPORTANT: If your IoT policy restricts iot:Connect to a specific client-id,
# set CLIENT_ID to match that allowed value (often the Thing Name).
CLIENT_ID = "tierai-servexl-edgeblr01"  # safer than "...-sim" for strict policies

TOPIC_TELEMETRY = f"tierai/{TENANT}/{GATEWAY_ID}/telemetry"
TOPIC_STATE = f"tierai/{TENANT}/{GATEWAY_ID}/state"
TOPIC_ALARMS = f"tierai/{TENANT}/{GATEWAY_ID}/alarms"

PUBLISH_INTERVAL_SEC = 1
HEARTBEAT_INTERVAL_SEC = 30
ALARM_PROBABILITY = 0.03  # ~3% chance each second (tune as you like)

# Sim ranges
TEMP_RANGE_C = (20.0, 45.0)
HUM_RANGE_RH = (20.0, 85.0)

# Alarm thresholds (example)
TEMP_HIGH_C = 40.0
HUM_HIGH_RH = 80.0

# Enable verbose MQTT logs
ENABLE_MQTT_LOGS = True


# -----------------------------
# Helpers
# -----------------------------
def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_exists_or_exit(path: str) -> None:
    try:
        with open(path, "rb"):
            pass
    except Exception as e:
        print(f"ERROR: Cannot read file '{path}': {e}", file=sys.stderr)
        sys.exit(1)


class TierAIIoTSim:
    def __init__(self) -> None:
        self.connected = False
        self.last_heartbeat = 0.0

        self.client = mqtt.Client(
            client_id=CLIENT_ID,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )

        # Callbacks
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_publish = self._on_publish
        if ENABLE_MQTT_LOGS:
            self.client.on_log = self._on_log

        # TLS setup
        self.client.tls_set(
            ca_certs=CA_FILE,
            certfile=CERT_FILE,
            keyfile=KEY_FILE,
            tls_version=ssl.PROTOCOL_TLSv1_2,
        )
        self.client.tls_insecure_set(False)

        # Recommended: set keepalive + automatic reconnect delays
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

    # ---- MQTT callbacks ----
    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Dict[str, Any], rc: int, properties=None) -> None:
        # rc == 0 means success
        self.connected = (rc == 0)
        print(f"✅ CONNECT rc={rc} (0=OK)")
        if self.connected:
            # Publish an initial retained heartbeat immediately
            self.publish_state(status="online", retain=True)

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, rc: int, properties=None) -> None:
        self.connected = False
        print(f"❌ DISCONNECT rc={rc}")

    def _on_publish(self, client: mqtt.Client, userdata: Any, mid: int) -> None:
        # This confirms the message has been handed off to the network stack
        # (not necessarily fully delivered to subscribers, but good signal)
        # Uncomment if you want very chatty logs:
        # print(f"✅ PUBLISHED mid={mid}")
        pass

    def _on_log(self, client: mqtt.Client, userdata: Any, level: int, buf: str) -> None:
        # Useful for TLS/policy debug
        print("MQTT:", buf)

    # ---- Publish methods ----
    def publish_state(self, status: str = "online", retain: bool = True) -> None:
        payload = {
            "tenant": TENANT,
            "gateway_id": GATEWAY_ID,
            "status": status,
            "ts": utc_iso(),
            "uptime_sec": int(time.time()),  # placeholder; replace with real uptime if needed
            "version": "sim-1.0",
        }
        info = self.client.publish(TOPIC_STATE, json.dumps(payload), qos=1, retain=retain)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            print(f"⚠️ STATE publish failed rc={info.rc}")
        else:
            print(f"📍 STATE → {TOPIC_STATE} retain={retain} payload={payload}")

    def publish_telemetry(self, epoch: int, temp: float, hum: float) -> None:
        payload = {
            "tenant": TENANT,
            "gateway_id": GATEWAY_ID,
            "ts": epoch,  # epoch seconds (handy for SiteWise mapping)
            "readings": [
                {"name": "Temp", "value": temp, "unit": "degC"},
                {"name": "Humidity", "value": hum, "unit": "RH"},
            ],
        }
        info = self.client.publish(TOPIC_TELEMETRY, json.dumps(payload), qos=1)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            print(f"⚠️ TELEMETRY publish failed rc={info.rc}")
        else:
            print(f"📈 TELEMETRY → {TOPIC_TELEMETRY} {payload}")

    def publish_alarm(self, epoch: int, alarm_type: str, severity: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        payload = {
            "tenant": TENANT,
            "gateway_id": GATEWAY_ID,
            "ts": epoch,
            "type": alarm_type,
            "severity": severity,  # INFO/WARN/CRITICAL
            "message": message,
            "details": details or {},
        }
        info = self.client.publish(TOPIC_ALARMS, json.dumps(payload), qos=1)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            print(f"⚠️ ALARM publish failed rc={info.rc}")
        else:
            print(f"🚨 ALARM → {TOPIC_ALARMS} {payload}")

    # ---- Main loop ----
    def run(self) -> None:
        # Validate files early (better errors)
        file_exists_or_exit(CA_FILE)
        file_exists_or_exit(CERT_FILE)
        file_exists_or_exit(KEY_FILE)

        print("Connecting to:", IOT_ENDPOINT, "port", IOT_PORT)
        self.client.connect(IOT_ENDPOINT, IOT_PORT, keepalive=60)
        self.client.loop_start()

        # Give connection a moment (callbacks will print status)
        time.sleep(2)

        self.last_heartbeat = time.time()

        try:
            while True:
                now = time.time()
                epoch = int(now)

                # Heartbeat every HEARTBEAT_INTERVAL_SEC seconds
                if now - self.last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
                    self.publish_state(status="online", retain=True)
                    self.last_heartbeat = now

                # Simulated telemetry
                temp = round(random.uniform(*TEMP_RANGE_C), 2)
                hum = round(random.uniform(*HUM_RANGE_RH), 2)
                self.publish_telemetry(epoch=epoch, temp=temp, hum=hum)

                # Optional: emit alarms based on thresholds or random probability
                if temp >= TEMP_HIGH_C:
                    self.publish_alarm(
                        epoch=epoch,
                        alarm_type="TEMP_HIGH",
                        severity="WARN" if temp < (TEMP_HIGH_C + 2) else "CRITICAL",
                        message=f"High temperature detected: {temp} degC",
                        details={"temp": temp, "threshold": TEMP_HIGH_C},
                    )
                if hum >= HUM_HIGH_RH:
                    self.publish_alarm(
                        epoch=epoch,
                        alarm_type="HUMIDITY_HIGH",
                        severity="WARN",
                        message=f"High humidity detected: {hum} RH",
                        details={"humidity": hum, "threshold": HUM_HIGH_RH},
                    )
                if random.random() < ALARM_PROBABILITY:
                    self.publish_alarm(
                        epoch=epoch,
                        alarm_type="SIM_RANDOM_EVENT",
                        severity="INFO",
                        message="Random simulated event (test)",
                        details={"note": "This is a simulator-generated event."},
                    )

                time.sleep(PUBLISH_INTERVAL_SEC)

        except KeyboardInterrupt:
            print("\nStopping simulator...")

        finally:
            # Publish offline status retained (optional)
            try:
                self.publish_state(status="offline", retain=True)
            except Exception:
                pass
            self.client.loop_stop()
            self.client.disconnect()


if __name__ == "__main__":
    sim = TierAIIoTSim()
    sim.run()
