import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { getEcontClient } from '../../../../../modules/econt/client'
import { getSpeedyClient } from '../../../../../modules/speedy/client'
import { isCarrier, type CourierOfficesQueryType } from '../../validators'

// GET /store/couriers/{econt|speedy}/offices?city_id=
// Contract: contracts/medusa-storefront.md ("Courier offices")
export async function GET(
  req: MedusaRequest<{}, CourierOfficesQueryType>,
  res: MedusaResponse
) {
  const carrier = req.params.carrier

  if (!isCarrier(carrier)) {
    return res.status(404).json({
      message: `Unknown carrier '${carrier}'. Expected one of: econt, speedy.`,
    })
  }

  const cityId = Number(req.validatedQuery.city_id)
  if (!Number.isFinite(cityId)) {
    return res.status(400).json({ message: 'city_id must be a numeric id (see /cities response).' })
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  if (carrier === 'econt') {
    const client = getEcontClient(logger)
    const offices = await client.officesForCity(cityId)
    return res.json({
      offices: offices.map((o) => ({
        code: o.code,
        name: o.name,
        address: o.fullAddress,
        type: o.isAPS ? ('locker' as const) : ('office' as const),
      })),
    })
  }

  // speedy
  const client = getSpeedyClient(logger)
  if (!client.hasCredentials()) {
    return res.status(503).json({
      message:
        'Speedy nomenclature is unavailable: SPEEDY_USERNAME/SPEEDY_PASSWORD are not configured.',
    })
  }

  const offices = await client.officesForSite(cityId)
  return res.json({
    offices: offices.map((o) => ({
      code: String(o.id),
      name: o.name,
      address: o.address,
      type: o.type === 'APT' ? ('locker' as const) : ('office' as const),
    })),
  })
}
