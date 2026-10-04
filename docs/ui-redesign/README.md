# KryptonRemote UI redesign

The current design uses a midnight sidebar, a light workspace, violet controls, and illustrated remote connection panels. Both frontends import the shared visual system from `packages/ui-theme.css`.

The browser connection hub has a dedicated connection form, formatted Remote IDs, a PIN visibility control, and inline validation. The desktop hub includes device identity, connection controls, recent devices, a connection guide, and separate navigation views. Live-session controls use a scoped dark palette.

## Previews

- Browser / admin: http://127.0.0.1:3000
- Desktop: http://127.0.0.1:1420

Start with `npm run dev --workspace=@krypton/admin-web` and `npm run dev --workspace=@krypton/desktop`.

## Verification

Both frontend production builds pass. Browser checks cover all navigation tabs, nine-digit ID validation, formatted IDs, PIN visibility, request payloads, offline error recovery, URL-prefilled IDs, desktop preview feedback, and responsive layouts at 1440, 1100, 900, and 390 pixels. No uncaught page errors or page-level horizontal overflow were observed.

The `v2-*` screenshots document the current design. Browser screenshots use isolated, mocked API responses for UI testing; displayed control-plane status and fleet counts are test fixtures. Live WebRTC transport and Windows native integration were not exercised in this redesign pass. The older screenshots and `qa-result.json` document the earlier graphite/lime design.
