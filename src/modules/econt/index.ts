import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import EcontFulfillmentProviderService from './service'

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [EcontFulfillmentProviderService],
})
