import type { Logger } from '@medusajs/framework/types'

// Econt OpenAPI spec: https://ee.econt.com/services/openapi.yaml
// Demo environment (nomenclature lookups only - see README): https://demo.econt.com/ee/services
// Production environment: https://ee.econt.com/services
const DEFAULT_DEMO_API_URL = 'https://demo.econt.com/ee/services'
// Econt's publicly documented demo credentials. Valid ONLY against the demo host above, and
// ONLY for read-only nomenclature endpoints (cities/offices). Never used to create real shipments.
const DEMO_USERNAME = 'iasp-dev'
const DEMO_PASSWORD = '1Asp-dev'

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h - Econt's city/office nomenclature changes rarely.

export type EcontCity = {
  id: number
  name: string
  postCode: string
  regionName: string
}

export type EcontOffice = {
  id: number
  code: string
  name: string
  fullAddress: string
  cityId: number | null
  /** true when the office is an automated parcel station ("APS" / locker) rather than a staffed office. */
  isAPS: boolean
}

export type EcontCreateLabelInput = {
  /** ADDRESS or OFFICE delivery. */
  deliveryType: 'ADDRESS' | 'OFFICE'
  officeCode?: string
  receiver: {
    firstName: string
    lastName: string
    phone: string
    address1: string
    city: string
    postalCode: string
  }
  /** Cash-on-delivery amount in major currency units, or undefined when not COD. */
  codAmount?: number
  codCurrency?: string
  orderReference: string
}

export type EcontCreateLabelResult = {
  shipmentNumber: string
  labelUrl?: string
  trackingUrl?: string
}

type RawEcontCity = {
  id: number
  name: string
  postCode?: string
  regionName?: string
}

type RawEcontOffice = {
  id: number
  code: string
  name: string
  isAPS?: boolean
  isMPS?: boolean
  address?: {
    fullAddress?: string
    city?: { id?: number }
  }
}

export class EcontClient {
  private readonly logger: Logger
  private readonly apiUrl: string
  private readonly username: string
  private readonly password: string
  /** true when no ECONT_USERNAME was configured and we fell back to the public demo credentials. */
  private readonly usingDemoFallback: boolean

  private citiesCache: { data: EcontCity[]; expiresAt: number } | null = null
  private officesCache: { data: EcontOffice[]; expiresAt: number } | null = null

  constructor(logger: Logger) {
    this.logger = logger

    const configuredUsername = process.env.ECONT_USERNAME
    this.usingDemoFallback = !configuredUsername

    this.apiUrl = (process.env.ECONT_API_URL || DEFAULT_DEMO_API_URL).replace(/\/+$/, '')
    this.username = configuredUsername || DEMO_USERNAME
    this.password = configuredUsername ? process.env.ECONT_PASSWORD || '' : DEMO_PASSWORD
  }

  /**
   * Real (non-demo) credentials are required to create actual shipments/labels. The public demo
   * account is only good for nomenclature (read-only) lookups.
   */
  hasShipmentCredentials(): boolean {
    return !this.usingDemoFallback && !!this.password
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64')
    return `Basic ${token}`
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader(),
      },
      body: JSON.stringify(body),
    })

    const json = await res.json().catch(() => null)

    if (!res.ok) {
      const message =
        (json && typeof json === 'object' && 'message' in json && String((json as any).message)) ||
        `Econt API request to ${path} failed with status ${res.status}`
      throw new Error(message)
    }

    return json as T
  }

  private async fetchCities(): Promise<EcontCity[]> {
    const now = Date.now()
    if (this.citiesCache && this.citiesCache.expiresAt > now) {
      return this.citiesCache.data
    }

    const res = await this.post<{ cities?: RawEcontCity[] }>(
      '/Nomenclatures/NomenclaturesService.getCities.json',
      { countryCode: 'BGR' }
    )

    const cities: EcontCity[] = (res.cities ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      postCode: c.postCode ?? '',
      regionName: c.regionName ?? '',
    }))

    this.citiesCache = { data: cities, expiresAt: now + CACHE_TTL_MS }
    return cities
  }

  private async fetchOffices(): Promise<EcontOffice[]> {
    const now = Date.now()
    if (this.officesCache && this.officesCache.expiresAt > now) {
      return this.officesCache.data
    }

    const res = await this.post<{ offices?: RawEcontOffice[] }>(
      '/Nomenclatures/NomenclaturesService.getOffices.json',
      { countryCode: 'BGR' }
    )

    const offices: EcontOffice[] = (res.offices ?? []).map((o) => ({
      id: o.id,
      code: o.code,
      name: o.name,
      fullAddress: o.address?.fullAddress ?? '',
      cityId: o.address?.city?.id ?? null,
      isAPS: !!o.isAPS,
    }))

    this.officesCache = { data: offices, expiresAt: now + CACHE_TTL_MS }
    return offices
  }

  /** Cities matching `q` (case-insensitive substring on the Bulgarian name). Econt's nomenclature
   * endpoint has no server-side name filter, so the full (cached) list is filtered in-process. */
  async searchCities(q?: string): Promise<EcontCity[]> {
    const cities = await this.fetchCities()
    if (!q?.trim()) return cities
    const needle = q.trim().toLowerCase()
    return cities.filter((c) => c.name.toLowerCase().includes(needle))
  }

  async officesForCity(cityId: number): Promise<EcontOffice[]> {
    const offices = await this.fetchOffices()
    return offices.filter((o) => o.cityId === cityId)
  }

  private async resolveCityId(cityName: string): Promise<number | undefined> {
    const cities = await this.fetchCities()
    const needle = cityName.trim().toLowerCase()
    const exact = cities.find((c) => c.name.toLowerCase() === needle)
    if (exact) return exact.id
    const partial = cities.find((c) => c.name.toLowerCase().includes(needle))
    return partial?.id
  }

  /**
   * Creates an Econt shipment/label (CreateLabel). Requires real (non-demo) credentials -
   * callers must check {@link hasShipmentCredentials} first.
   *
   * TODO(live pricing/sender profile): the sender is currently left unset so Econt falls back to
   * the authenticated e-commerce account's own registered profile/address. If the production
   * Econt account requires an explicit sender address, extend this payload accordingly.
   * TODO(weight): package weight is not modelled on Medusa's FulfillmentItemDTO; we send a
   * conservative placeholder (1kg) until real per-item weights are wired through.
   */
  async createLabel(input: EcontCreateLabelInput): Promise<EcontCreateLabelResult> {
    const services: Record<string, unknown> = {}
    if (input.codAmount !== undefined) {
      services.cdAmount = input.codAmount
      services.cdCurrency = input.codCurrency ?? 'BGN'
      services.cdType = 'GET_CD'
    }

    const label: Record<string, unknown> = {
      shipmentType: 'PACK',
      packCount: 1,
      weight: 1,
      services,
      receiverClient: {
        name: `${input.receiver.firstName} ${input.receiver.lastName}`.trim(),
        phones: [input.receiver.phone],
      },
      orderNumber: input.orderReference,
    }

    if (input.deliveryType === 'OFFICE' && input.officeCode) {
      label.receiverOfficeCode = input.officeCode
    } else {
      const cityId = await this.resolveCityId(input.receiver.city)
      label.receiverAddress = {
        city: cityId ? { id: cityId, name: input.receiver.city } : { name: input.receiver.city },
        fullAddress: input.receiver.address1,
        postCode: input.receiver.postalCode,
      }
    }

    const res = await this.post<{
      label?: { shipmentNumber?: string; pdfURL?: string }
    }>('/Shipments/LabelService.createLabel.json', { label, mode: 'create' })

    const shipmentNumber = res.label?.shipmentNumber
    if (!shipmentNumber) {
      throw new Error('Econt CreateLabel did not return a shipment number')
    }

    return {
      shipmentNumber,
      labelUrl: res.label?.pdfURL,
      trackingUrl: `https://www.econt.com/services/shipment/track.php?shipmentNumber=${shipmentNumber}`,
    }
  }

  async cancelLabel(shipmentNumber: string): Promise<void> {
    await this.post('/Shipments/LabelService.deleteLabels.json', {
      shipmentNumbers: [shipmentNumber],
    }).catch((err) => {
      this.logger.warn(`Econt: failed to cancel shipment ${shipmentNumber}: ${err.message}`)
    })
  }
}

// A single process-wide client so the 12h nomenclature cache is actually shared between the
// fulfillment provider (src/modules/econt/service.ts) and the public store routes
// (src/api/store/couriers/[carrier]/*) instead of each resolving a fresh, empty cache.
let singleton: EcontClient | undefined
export function getEcontClient(logger: Logger): EcontClient {
  if (!singleton) {
    singleton = new EcontClient(logger)
  }
  return singleton
}
