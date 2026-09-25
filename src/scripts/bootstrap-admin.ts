import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

/**
 * Pre-deploy step (after migrations): while no admin user exists, make sure a valid invite for
 * ADMIN_INVITE_EMAIL exists and log its accept link. The owner opens the link and chooses a
 * password in the admin — no password ever lives in env vars or logs. No-op once any admin exists.
 */
export default async function bootstrapAdmin({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const email = process.env.ADMIN_INVITE_EMAIL?.trim().toLowerCase()
  if (!email) {
    logger.info('bootstrap-admin: ADMIN_INVITE_EMAIL not set, skipping')
    return
  }

  const userModule = container.resolve(Modules.USER)
  const [admin] = await userModule.listUsers({}, { take: 1 })
  if (admin) {
    logger.info('bootstrap-admin: an admin user exists, nothing to do')
    return
  }

  let [invite] = await userModule.listInvites({ email }, { take: 1 })
  if (!invite) {
    invite = await userModule.createInvites({ email })
  } else if (new Date(invite.expires_at) <= new Date()) {
    ;[invite] = await userModule.refreshInviteTokens([invite.id])
  }

  const base = process.env.MEDUSA_BACKEND_URL ?? 'http://localhost:9000'
  logger.info(`bootstrap-admin: accept the admin invite at ${base}/app/invite?token=${invite.token}`)
}
