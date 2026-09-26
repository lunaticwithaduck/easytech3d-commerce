import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { getEcontClient } from '../../../../../modules/econt/client'
import { getSpeedyClient } from '../../../../../modules/speedy/client'
import { isCarrier, type CourierCitiesQueryType } from '../../validators'

// GET /store/couriers/{econt|speedy}/cities?q=
// Contract: contracts/medusa-storefront.md ("Courier offices")
export async function GET(
  req: MedusaRequest<{}, CourierCitiesQueryType>,
  res: MedusaResponse
) {
  const carrier = req.params.carrier

  if (!isCarrier(carrier)) {
    return res.status(404).json({
      message: `Unknown carrier '${carrier}'. Expected one of: econt, speedy.`,
    })
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const q = req.validatedQuery.q

  if (carrier === 'econt') {
    const client = getEcontClient(logger)
    const cities = await client.searchCities(q)
    return res.json({
      cities: cities.map((c) => ({ id: c.id, name: c.name, post_code: c.postCode, region: c.regionName })),
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

  const sites = await client.searchSites(q)
  return res.json({
    cities: sites.map((s) => ({ id: s.id, name: s.name, post_code: s.postCode, region: s.region })),
  })
}
