import { defineMiddlewares, validateAndTransformQuery } from '@medusajs/framework/http'
import { CourierCitiesQuerySchema, CourierOfficesQuerySchema } from './store/couriers/validators'

export default defineMiddlewares({
  routes: [
    {
      matcher: '/store/couriers/:carrier/cities',
      method: 'GET',
      middlewares: [validateAndTransformQuery(CourierCitiesQuerySchema, {})],
    },
    {
      matcher: '/store/couriers/:carrier/offices',
      method: 'GET',
      middlewares: [validateAndTransformQuery(CourierOfficesQuerySchema, {})],
    },
  ],
})
