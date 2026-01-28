#pip install paho-mqtt
import json
import ssl
import time
import random
from datetime import datetime, timezone
from paho.mqtt import client as mqtt

IOT_ENDPOINT = "a2b9h5i04yynsk-ats.iot.ap-southeast-1.amazonaws.com"
IOT_PORT = 8883

CA_FILE = "AmazonRootCA.pem"
CERT_FILE = "89782870c4795de15f0a654c417aafb0ac7f685f9e68d50801846cb38b848268-certificate.pem.crt"
KEY_FILE = "89782870c4795de15f0a654c417aafb0ac7f685f9e68d50801846cb38b848268-private.pem.key"

CLIENT_ID = "tierai-servexl-edgeblr01-sim"
TOPIC_TELEMETRY = "tierai/servexl/edgeblr01/telemetry"
TOPIC_STATE = "tierai/servexl/edgeblr01/state"

def on_connect(client, userdata, flags, rc, properties=None):
    print("Connected to IoT Core, rc=", rc)
    # send a state message once on connect
    state = {
        "gateway_id": "edgeblr01",
        "status": "online",
        "ts": datetime.now(timezone.utc).isoformat()
    }
    client.publish(TOPIC_STATE, json.dumps(state), qos=1)

mqttc = mqtt.Client(client_id=CLIENT_ID, protocol=mqtt.MQTTv311)
mqttc.on_connect = on_connect

mqttc.tls_set(
    ca_certs=CA_FILE,
    certfile=CERT_FILE,
    keyfile=KEY_FILE,
    tls_version=ssl.PROTOCOL_TLSv1_2
)
mqttc.tls_insecure_set(False)

mqttc.connect(IOT_ENDPOINT, IOT_PORT, keepalive=60)
mqttc.loop_start()

while True:
    epoch = int(time.time())
    temperature = round(random.uniform(20, 45), 2)
    humidity = round(random.uniform(20, 80), 2)

    msg = {
        "tenant": "servexl",
        "gateway_id": "edgeblr01",
        "ts": epoch,
        "readings": [
            {"name": "Temp", "value": temperature, "unit": "degC"},
            {"name": "Humidity", "value": humidity, "unit": "RH"}
        ]
    }

    mqttc.publish(TOPIC_TELEMETRY, json.dumps(msg), qos=1)
    print("Published:", msg)
    time.sleep(1)
