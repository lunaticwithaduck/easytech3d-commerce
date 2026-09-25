import { defineConfig, loadEnv } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// Production (Railway) runs two services from this repo: `medusa` (MEDUSA_WORKER_MODE=server,
// API + admin at /app) and `medusa-worker` (MEDUSA_WORKER_MODE=worker, admin disabled). Both share
// Postgres and Redis. Locally, leave REDIS_URL unset to fall back to the in-memory modules.
const REDIS_URL = process.env.REDIS_URL

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: REDIS_URL,
    workerMode: (process.env.MEDUSA_WORKER_MODE as 'shared' | 'worker' | 'server') || 'shared',
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || 'supersecret',
      cookieSecret: process.env.COOKIE_SECRET || 'supersecret',
    },
  },
  admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN === 'true',
    backendUrl: process.env.MEDUSA_BACKEND_URL,
  },
  modules: REDIS_URL
    ? [
        {
          resolve: '@medusajs/medusa/caching',
          options: {
            providers: [
              {
                resolve: '@medusajs/caching-redis',
                id: 'caching-redis',
                is_default: true,
                options: { redisUrl: REDIS_URL },
              },
            ],
          },
        },
        {
          resolve: '@medusajs/medusa/event-bus-redis',
          options: { redisUrl: REDIS_URL },
        },
        {
          resolve: '@medusajs/medusa/workflow-engine-redis',
          options: { redis: { redisUrl: REDIS_URL } },
        },
        {
          resolve: '@medusajs/medusa/locking',
          options: {
            providers: [
              {
                resolve: '@medusajs/medusa/locking-redis',
                id: 'locking-redis',
                is_default: true,
                options: { redisUrl: REDIS_URL },
              },
            ],
          },
        },
      ]
    : [],
})
