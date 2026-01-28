import boto3
import random
import time

alias = '/tierai/servexl/edgeblr01/sensor1/temp_degC'

client = boto3.client('iotsitewise', region_name='ap-southeast-1')

while True:
    temperature = round(random.uniform(20, 45), 2)
    epoch = int(time.time())

    payload = {
        "entries": [
            {
                "entryId": f"{epoch}-{random.randint(1000,9999)}",
                "propertyAlias": alias,
                "propertyValues": [
                    {
                        "value": {"doubleValue": temperature},
                        "timestamp": {"timeInSeconds": epoch},
                        "quality": "GOOD"
                    }
                ]
            }
        ]
    }

    client.batch_put_asset_property_value(entries=payload["entries"])
    print("Sent:", temperature)

    time.sleep(1)
