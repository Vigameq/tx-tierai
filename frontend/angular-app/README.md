# TierAI Angular App (Standalone)

## Run locally
```bash
cd frontend/angular-app
npm install
npm start
```

App URL: `http://localhost:4200`

## Backend URL
By default frontend calls Firebase Functions emulator URL:
`http://127.0.0.1:5001/YOUR_FIREBASE_PROJECT_ID/asia-southeast1/chat`

To override at runtime, set in `src/index.html` before app bootstrap:
```html
<script>
  window.__TIERAI_API_URL__ = "https://asia-southeast1-YOUR_FIREBASE_PROJECT_ID.cloudfunctions.net/chat";
</script>
```

## Route
- `/tierai`

## Notes
- Dashboard includes a Grafana placeholder panel region.
- Chat calls `POST /chat` on the Python backend.
