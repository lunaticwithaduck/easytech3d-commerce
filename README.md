# easytech3d-commerce

Commerce backend and admin for [easytech3d.com](https://www.easytech3d.com/), built on
[Medusa v2](https://docs.medusajs.com). Replaces the custom
[`easytech3d-backend`](https://github.com/lunaticwithaduck/easytech3d-backend) (NestJS) and
[`easytech3d-admin`](https://github.com/lunaticwithaduck/easytech3d-admin) dashboards. The
[storefront](https://github.com/lunaticwithaduck/easytech3d) stays a separate Next.js app.

- Admin dashboard: `<backend-url>/app`
- Store API: `<backend-url>/store/*` · Admin API: `<backend-url>/admin/*`
- Health: `<backend-url>/health`

## Local development

```sh
pnpm install
cp .env.template .env      # DATABASE_URL, secrets, CORS
pnpm medusa db:migrate
pnpm dev                   # http://localhost:9000, admin at /app
```

Leave `REDIS_URL` unset locally to use the in-memory cache, event bus, workflow engine and locking.

## Deployment (Railway)

One Docker image, two services sharing Postgres + Redis:

| service | env | notes |
|---|---|---|
| `medusa` | `MEDUSA_WORKER_MODE=server` | API + admin; pre-deploy `npm run predeploy` (migrate + admin invite); healthcheck `/health` |
| `medusa-worker` | `MEDUSA_WORKER_MODE=worker`, `DISABLE_MEDUSA_ADMIN=true` | subscribers, scheduled jobs, workflows |

Both need `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET`; the server also needs
`STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS` and `MEDUSA_BACKEND_URL`.

## First admin

Set `ADMIN_INVITE_EMAIL` on the `medusa` service. While no admin exists, every deploy logs an
invite link (`bootstrap-admin: accept the admin invite at …`) from the pre-deploy step; open it
and choose a password. After that the step is a no-op.

## Couriers (Econt, Speedy)

Two fulfillment module providers, registered in `medusa-config.ts` under `@medusajs/medusa/fulfillment`
alongside the default `manual` provider (`@medusajs/medusa/fulfillment-manual`, id `manual`) - kept
registered because the store import creates its shipping options (`data.carrier` `ECONT`/`SPEEDY`,
flat prices) on `manual_manual`, not on these providers yet. See
`contracts/medusa-storefront.md` ("Courier offices") for the storefront-facing contract.

- `src/modules/econt` (provider id **`econt`**) and `src/modules/speedy` (provider id **`speedy`**).
  Each exposes fulfillment options tagged with `carrier: 'ECONT' | 'SPEEDY'`, validates shipping
  method `data` (`delivery_type: 'ADDRESS' | 'OFFICE'`, `office_code`/`office_name` required for
  `OFFICE`), and implements `createFulfillment`/`cancelFulfillment` against the courier's API.
- **Live price calculation is not implemented** (`canCalculate` returns `false` on both -
  shipping is flat-priced by the store import for now, per the contract). See the
  `TODO(live pricing)` comments in `src/modules/{econt,speedy}/service.ts` for where to wire up
  real rate calculation later (both couriers' APIs support a "calculate/quote" mode).
- **Cash on delivery**: when creating a shipment/label, both providers check whether the order's
  payment was completed with `pp_system_default` (the storefront's "Наложен платеж" / COD
  provider) via `query.graph` on `order.payment_collections.payment_sessions`, and if so pass the
  order's `total` as the COD amount to the courier.
- **Missing credentials**: if a provider's credentials aren't configured, `createFulfillment` logs
  a warning and returns empty data (`{ skipped_reason: 'missing_credentials' }`) instead of
  throwing, so the fulfillment still succeeds and can be handled manually.
- **Nomenclature caching**: city/office lists are fetched from the courier's API and cached
  in-process for 12h (they change rarely), shared between the fulfillment provider and the public
  store routes below via a per-courier singleton client.

### Public store routes

- `GET /store/couriers/{econt|speedy}/cities?q=` → `{ cities: { id, name, post_code, region }[] }`
- `GET /store/couriers/{econt|speedy}/offices?city_id=` →
  `{ offices: { code, name, address, type: 'office' | 'locker' }[] }`

Both require the storefront's publishable API key, like all other `/store/*` routes. Query params
are validated with `zod` (`src/api/store/couriers/validators.ts`, wired up in `src/api/middlewares.ts`).
Speedy responds `503` when its credentials aren't configured (Econt always works, falling back to
the public demo account for nomenclature - see below).

### Environment

| var | default | notes |
|---|---|---|
| `ECONT_API_URL` | `https://demo.econt.com/ee/services` | Econt's demo host when unset. |
| `ECONT_USERNAME` | *(unset → demo account)* | When unset, falls back to Econt's public demo credentials (`iasp-dev`), which are **only used for nomenclature (cities/offices) lookups** - `createFulfillment` treats the demo fallback the same as "no credentials" and never creates a real shipment with it. |
| `ECONT_PASSWORD` | *(unset → demo account)* | Same fallback rule as `ECONT_USERNAME`. |
| `SPEEDY_API_URL` | `https://api.speedy.bg/v1` | |
| `SPEEDY_USERNAME` | *(none)* | Speedy has no public demo account - both nomenclature lookups and shipment creation require real credentials. |
| `SPEEDY_PASSWORD` | *(none)* | |

Optional, advanced (sensible defaults, only override if the courier account needs it):
`SPEEDY_COUNTRY_ID` (Speedy's numeric id for Bulgaria in its location nomenclature) and
`SPEEDY_SERVICE_ID` (the Speedy service/product to book shipments under).
