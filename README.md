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
| `medusa` | `MEDUSA_WORKER_MODE=server` | API + admin; pre-deploy `medusa db:migrate`; healthcheck `/health` |
| `medusa-worker` | `MEDUSA_WORKER_MODE=worker`, `DISABLE_MEDUSA_ADMIN=true` | subscribers, scheduled jobs, workflows |

Both need `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET`; the server also needs
`STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS` and `MEDUSA_BACKEND_URL`.
