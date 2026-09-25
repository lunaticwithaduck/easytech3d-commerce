import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

// This service's domain is the backoffice address: opening it lands on the admin dashboard.
export const GET = (_req: MedusaRequest, res: MedusaResponse) => {
  res.redirect(302, '/app')
}
