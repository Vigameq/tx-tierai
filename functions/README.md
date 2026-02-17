# TierAI Backend on Firebase Functions (Node.js)

## Function
- HTTP function name: `chat`
- File: `functions/index.js`
- Method: `POST`
- Body:
```json
{
  "device_id": "servexl/edgeblr01",
  "message": "Is this device at risk?"
}
```

## What it does
- Reads latest context from `TierAIContext` (5m + 60m)
- Reads recent telemetry from `TierAITelemetry`
- Calls AWS Bedrock model
- Returns:
```json
{
  "answer": "...",
  "device_id": "servexl/edgeblr01",
  "context_used": { "latest_5m": {}, "latest_60m": {} }
}
```

## Required env vars
Create `functions/.env`:
```bash
AWS_REGION=ap-southeast-1
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20240620-v1:0
TELEMETRY_TABLE=TierAITelemetry
CONTEXT_TABLE=TierAIContext
MAX_TELEMETRY_ROWS=30

# AWS credentials for DynamoDB + Bedrock access
AWS_ACCESS_KEY_ID=YOUR_KEY
AWS_SECRET_ACCESS_KEY=YOUR_SECRET
# Optional if needed:
# AWS_SESSION_TOKEN=...
```

## Deploy
```bash
firebase use YOUR_FIREBASE_PROJECT_ID
cd functions
npm install
cd ..
firebase deploy --only functions
```

## Local emulator
```bash
cd functions
npm install
cd ..
firebase emulators:start --only functions
```

Local URL format:
`http://127.0.0.1:5001/YOUR_FIREBASE_PROJECT_ID/asia-southeast1/chat`

## Frontend API URL
Set runtime variable in Angular `index.html`:
```html
<script>
  window.__TIERAI_API_URL__ = "https://asia-southeast1-YOUR_FIREBASE_PROJECT_ID.cloudfunctions.net/chat";
</script>
```
