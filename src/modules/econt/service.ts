import { AbstractFulfillmentProviderService } from '@medusajs/framework/utils'
import { MedusaError } from '@medusajs/framework/utils'
import type {
  Logger,
  RemoteQueryFunction,
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from '@medusajs/framework/types'
import { EcontClient, getEcontClient } from './client'

type InjectedDependencies = {
  logger: Logger
  query: RemoteQueryFunction
}

/** The payment provider id used for cash-on-delivery (see contracts/medusa-storefront.md). */
const COD_PAYMENT_PROVIDER_ID = 'pp_system_default'

class EcontFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = 'econt'

  protected readonly logger_: Logger
  protected readonly query_: RemoteQueryFunction
  protected readonly client_: EcontClient

  constructor({ logger, query }: InjectedDependencies) {
    super()
    this.logger_ = logger
    this.query_ = query
    this.client_ = getEcontClient(logger)
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      { id: 'econt_address', carrier: 'ECONT', name: 'Econt - delivery to address' },
      { id: 'econt_office', carrier: 'ECONT', name: 'Econt - delivery to office/APS' },
    ]
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<any> {
    const deliveryType = data.delivery_type

    if (deliveryType !== 'ADDRESS' && deliveryType !== 'OFFICE') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `data.delivery_type must be 'ADDRESS' or 'OFFICE', got: ${String(deliveryType)}`
      )
    }

    if (deliveryType === 'OFFICE' && !data.office_code) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "data.office_code is required when data.delivery_type is 'OFFICE'"
      )
    }

    return data
  }

  async validateOption(_data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  // TODO(live pricing): Econt shipping options are flat-priced by the manager's import for now
  // (see contracts/medusa-storefront.md). Flip this to true and implement calculatePrice() once
  // live Econt rate calculation is wanted - Econt's CreateLabel supports mode: "calculate" for
  // getting a quote without creating a shipment.
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO['optionData'],
    _data: CalculateShippingOptionPriceDTO['data'],
    _context: CalculateShippingOptionPriceDTO['context']
  ): Promise<CalculatedShippingOptionPrice> {
    throw new Error('Econt fulfillment provider does not support price calculation yet')
  }

  private async isCashOnDelivery(orderId: string): Promise<boolean> {
    try {
      const { data } = await this.query_.graph({
        entity: 'order',
        fields: ['payment_collections.payment_sessions.provider_id', 'payment_collections.payment_sessions.status'],
        filters: { id: orderId },
      })

      const order = data?.[0] as
        | { payment_collections?: { payment_sessions?: { provider_id: string; status: string }[] }[] }
        | undefined

      return !!order?.payment_collections?.some((pc) =>
        pc.payment_sessions?.some((ps) => ps.provider_id === COD_PAYMENT_PROVIDER_ID)
      )
    } catch (err) {
      this.logger_.warn(`Econt: could not determine payment method for order ${orderId}: ${(err as Error).message}`)
      return false
    }
  }

  async createFulfillment(
    data: Record<string, unknown>,
    _items: Partial<Omit<FulfillmentItemDTO, 'fulfillment'>>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, 'provider_id' | 'data' | 'items'>>,
    _additionalData?: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    if (!this.client_.hasShipmentCredentials()) {
      this.logger_.warn(
        'Econt: ECONT_USERNAME/ECONT_PASSWORD are not configured (or only the public demo ' +
          'credentials are available). Skipping label creation - fulfil this order manually.'
      )
      return { data: { skipped_reason: 'missing_credentials' }, labels: [] }
    }

    const address = fulfillment.delivery_address
    if (!address) {
      this.logger_.warn('Econt: fulfillment has no delivery address, skipping label creation')
      return { data: { skipped_reason: 'missing_address' }, labels: [] }
    }

    const deliveryType = (data.delivery_type as 'ADDRESS' | 'OFFICE') ?? 'ADDRESS'
    const isCod = order?.id ? await this.isCashOnDelivery(order.id) : false

    try {
      const result = await this.client_.createLabel({
        deliveryType,
        officeCode: data.office_code as string | undefined,
        receiver: {
          firstName: address.first_name ?? '',
          lastName: address.last_name ?? '',
          phone: address.phone ?? '',
          address1: address.address_1 ?? '',
          city: address.city ?? '',
          postalCode: address.postal_code ?? '',
        },
        codAmount: isCod && order?.total !== undefined ? Number(order.total) : undefined,
        codCurrency: order?.currency_code?.toUpperCase(),
        orderReference: order?.display_id ? String(order.display_id) : order?.id ?? '',
      })

      return {
        data: {
          shipment_number: result.shipmentNumber,
        },
        labels: [
          {
            tracking_number: result.shipmentNumber,
            tracking_url: result.trackingUrl ?? '',
            label_url: result.labelUrl ?? '',
          },
        ],
      }
    } catch (err) {
      this.logger_.error(`Econt: failed to create shipment for order ${order?.id}: ${(err as Error).message}`)
      return { data: { skipped_reason: 'econt_api_error' }, labels: [] }
    }
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<any> {
    const shipmentNumber = data.shipment_number as string | undefined
    if (!shipmentNumber || !this.client_.hasShipmentCredentials()) {
      return {}
    }
    await this.client_.cancelLabel(shipmentNumber)
    return {}
  }

  async createReturnFulfillment(fulfillment: Record<string, unknown>): Promise<CreateFulfillmentResult> {
    return { data: { ...(fulfillment.data as object) }, labels: [] }
  }

  async getFulfillmentDocuments(): Promise<never[]> {
    return []
  }

  async getReturnDocuments(): Promise<never[]> {
    return []
  }

  async getShipmentDocuments(): Promise<never[]> {
    return []
  }

  async retrieveDocuments(): Promise<void> {
    return
  }
}

export default EcontFulfillmentProviderService
