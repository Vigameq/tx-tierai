# TierAI Dashboard + Chat (Angular drop-in)

This folder contains standalone Angular files you can copy into your Angular workspace.

## Files
- `src/app/components/tierai-dashboard/tierai-dashboard.component.ts`
- `src/app/components/tierai-dashboard/tierai-dashboard.component.html`
- `src/app/components/tierai-dashboard/tierai-dashboard.component.css`
- `src/app/services/chat.service.ts`
- `src/app/models/chat.models.ts`

## Wire into app routes
Example route:
```ts
{
  path: 'tierai',
  loadComponent: () =>
    import('./components/tierai-dashboard/tierai-dashboard.component').then(m => m.TieraiDashboardComponent)
}
```

## Required Angular setup
- Ensure `HttpClient` is provided globally:
```ts
provideHttpClient()
```

## API endpoint
Update `baseUrl` in `chat.service.ts`:
```ts
private readonly baseUrl = 'https://YOUR_API_GATEWAY_URL';
```

## Grafana integration
Replace the placeholder block in `tierai-dashboard.component.html` with your iframe/embed panel when ready.
