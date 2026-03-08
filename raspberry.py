#!/usr/bin/env python3
"""
TierAI Raspberry Pi publisher (DHT22 + MQTT mTLS)
Publishes to:
  tierai/<tenant>/<gateway_id>/telemetry
  tierai/<tenant>/<gateway_id>/state
  tierai/<tenant>/<gateway_id>/alarms
"""

import json
import ssl
import time
from datetime import datetime, timezone

import Adafruit_DHT
from paho.mqtt import client as mqtt

# ---------- CONFIG ----------
IOT_ENDPOINT = "a2b9h5i04yynsk-ats.iot.ap-southeast-1.amazonaws.com"
IOT_PORT = 8883
CA_FILE = "AmazonRootCA1.pem"
CERT_FILE = "<your-certificate>.pem.crt"
KEY_FILE = "<your-private>.pem.key"
CLIENT_ID = "tierai-servexl-edgeblr01"

TENANT = "servexl"
GATEWAY_ID = "edgeblr01"
DEVICE_ID = f"{TENANT}/{GATEWAY_ID}"

TOPIC_TELEMETRY = f"tierai/{TENANT}/{GATEWAY_ID}/telemetry"
TOPIC_STATE = f"tierai/{TENANT}/{GATEWAY_ID}/state"
TOPIC_ALARMS = f"tierai/{TENANT}/{GATEWAY_ID}/alarms"

PUBLISH_INTERVAL_SEC = 5
HEARTBEAT_INTERVAL_SEC = 30

TEMP_HIGH_C = 40.0
HUM_HIGH_RH = 80.0

# DHT22 on BCM GPIO4 (physical pin 7)
DHT_SENSOR = Adafruit_DHT.DHT22
DHT_PIN = 4
# ---------------------------


def utc_iso():
    return datetime.now(timezone.utc).isoformat()


def compute_status_code(temp_c, hum_rh):
    # 0=OK, 1=WARN, 2=CRITICAL
    if temp_c >= TEMP_HIGH_C + 2 or hum_rh >= HUM_HIGH_RH + 5:
        return 2
    if temp_c >= TEMP_HIGH_C or hum_rh >= HUM_HIGH_RH:
        return 1
    return 0


def on_connect(client, userdata, flags, rc):
    print(f"CONNECTED rc={rc}")


def on_disconnect(client, userdata, rc):
    print(f"DISCONNECTED rc={rc}")


def publish_state(client, status="online", retain=True):
    payload = {
        "tenant": TENANT,
        "gateway_id": GATEWAY_ID,
        "device_id": DEVICE_ID,
        "status": status,
        "ts": int(time.time()),
        "ts_iso": utc_iso(),
    }
    client.publish(TOPIC_STATE, json.dumps(payload), qos=1, retain=retain)
    print("STATE:", payload)


def publish_alarm(client, alarm_type, severity, message, details=None):
    payload = {
        "tenant": TENANT,
        "gateway_id": GATEWAY_ID,
        "device_id": DEVICE_ID,
        "ts": int(time.time()),
        "type": alarm_type,
        "severity": severity,
        "message": message,
        "details": details or {},
    }
    client.publish(TOPIC_ALARMS, json.dumps(payload), qos=1)
    print("ALARM:", payload)


def main():
    client = mqtt.Client(client_id=CLIENT_ID, protocol=mqtt.MQTTv311, clean_session=True)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    client.tls_set(
        ca_certs=CA_FILE,
        certfile=CERT_FILE,
        keyfile=KEY_FILE,
        tls_version=ssl.PROTOCOL_TLSv1_2,
    )
    client.tls_insecure_set(False)
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    client.connect(IOT_ENDPOINT, IOT_PORT, keepalive=60)
    client.loop_start()

    time.sleep(2)
    publish_state(client, "online", retain=True)
    last_hb = time.time()

    try:
        while True:
            now = time.time()
            humidity, temp = Adafruit_DHT.read_retry(DHT_SENSOR, DHT_PIN)

            if humidity is None or temp is None:
                print("Sensor read failed; skipping publish")
                time.sleep(PUBLISH_INTERVAL_SEC)
                continue

            temp = round(float(temp), 2)
            humidity = round(float(humidity), 2)
            ts = int(now)
            status_code = compute_status_code(temp, humidity)

            # Schema aligned for your IoT rule: get(readings,0).value / get(readings,1).value
            payload = {
                "tenant": TENANT,
                "gateway_id": GATEWAY_ID,
                "device_id": DEVICE_ID,
                "ts": ts,
                "status_code": status_code,
                "readings": [
                    {"name": "Temp", "value": temp, "unit": "degC"},
                    {"name": "Humidity", "value": humidity, "unit": "RH"},
                ],
            }

            client.publish(TOPIC_TELEMETRY, json.dumps(payload), qos=1)
            print("TELEMETRY:", payload)

            if temp >= TEMP_HIGH_C:
                publish_alarm(
                    client,
                    "TEMP_HIGH",
                    "CRITICAL" if temp >= TEMP_HIGH_C + 2 else "WARN",
                    f"High temperature detected: {temp} degC",
                    {"temp": temp, "threshold": TEMP_HIGH_C},
                )
            if humidity >= HUM_HIGH_RH:
                publish_alarm(
                    client,
                    "HUMIDITY_HIGH",
                    "WARN",
                    f"High humidity detected: {humidity} RH",
                    {"humidity": humidity, "threshold": HUM_HIGH_RH},
                )

            if now - last_hb >= HEARTBEAT_INTERVAL_SEC:
                publish_state(client, "online", retain=True)
                last_hb = now

            time.sleep(PUBLISH_INTERVAL_SEC)

    except KeyboardInterrupt:
        pass
    finally:
        publish_state(client, "offline", retain=True)
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
