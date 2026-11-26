# OpsBrain dashboard

The Open Brain dashboard for OpsBrain: browse, search, capture and work with everything the company remembers, in the Dautel Design System.

This is OB1's Open Brain dashboard (`dashboards/open-brain-dashboard-next`, created by [Alan Shurafa](https://github.com/alanshurafa) for [Open Brain](https://github.com/NateBJones-Projects/OB1)), connected to OpsBrain. The pages, components and behavior are OB1's. The styling and logos follow the Dautel Design System. The app talks to OpsBrain's Open Brain REST API (`/open-brain-rest`, in `server/rest.ts`), which maps Open Brain thoughts onto OpsBrain records with OpsBrain's permissions, attribution and history.

The full guide, including the page list, the field mapping and the API, is [docs/opsbrain/08-dashboard.md](../docs/opsbrain/08-dashboard.md).

## Run it with OpsBrain (Docker Compose)

From the repository root, set `DASHBOARD_SESSION_SECRET` in `deploy/.env` (`openssl rand -hex 32`), then:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile dashboard up -d --build
```

The dashboard listens on `127.0.0.1:3000`. Publish it through your reverse proxy with TLS, and sign in with your own OpsBrain key.

## Run it for development

Start OpsBrain (`deno task start` in the repository root), then:

```bash
npm ci
```

```bash
cp .env.example .env.local
```

Set `SESSION_SECRET` in `.env.local` (and `AUTH_COOKIE_SECURE=false` for http://localhost), then:

```bash
npm run dev
```

## Settings

| Variable | Required | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Yes | OpsBrain's Open Brain REST API, for example `http://opsbrain:8787/open-brain-rest`. Only the dashboard's server calls it. Set at build time |
| `SESSION_SECRET` | Yes | 32+ characters; encrypts the session cookie (`openssl rand -hex 32`) |
| `AUTH_COOKIE_SECURE` | No | `true` behind HTTPS (the default when the app URL is https); `false` for a local http:// test |
| `RESTRICTED_PASSPHRASE_HASH` | No | SHA-256 of a passphrase that shows restricted records the person can already read |
| `OPSBRAIN_UI_THEME` | No | `dautel` (default), `mocha`, `macchiato`, `frappe` or `latte`; fixed at build time |
| `NEXT_TELEMETRY_DISABLED` | No | Set to `1` (the Docker image does) so Next.js sends no telemetry |

## Styling

- `app/dautel-tokens.css` holds the Dautel Design System tokens (all five themes), copied from the design system. Change them upstream first.
- `app/globals.css` maps the dashboard's color names (`bg-primary`, `text-secondary`, `violet` and so on) and the palette colors its components use onto Dautel role tokens. It also sets the fonts, the small square corners and the page grid.
- `app/fonts/` serves Manrope and JetBrains Mono locally (SIL OFL 1.1).
- `public/brand/` and `app/icon.svg` hold the Dautel mark and favicon.

## Credits

Open Brain dashboard by [Alan Shurafa](https://github.com/alanshurafa), part of [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones. OpsBrain is a fork of Open Brain, licensed under [FSL-1.1-MIT](../LICENSE.md). [EXTENSIONS.md](EXTENSIONS.md) is OB1's guide to adding pages.
