import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import SpeedyFulfillmentProviderService from './service'

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [SpeedyFulfillmentProviderService],
})
