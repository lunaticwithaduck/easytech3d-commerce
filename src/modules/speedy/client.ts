import type { Logger } from '@medusajs/framework/types'

// Speedy REST API docs: https://api.speedy.bg/web-api.html
const DEFAULT_API_URL = 'https://api.speedy.bg/v1'

// Speedy's numeric id for Bulgaria in their location nomenclature. Configurable in case Speedy
// changes this, since it's not documented as a stable constant anywhere client-facing.
const DEFAULT_COUNTRY_ID = 100000001

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h - Speedy's site/office nomenclature changes rarely.

export type SpeedySite = {
  id: number
  name: string
  postCode: string
  region: string
}

export type SpeedyOffice = {
  id: number
  name: string
  address: string
  siteId: number | null
  /** "OFFICE" for a staffed office, "APT" for an automated parcel terminal (locker). */
  type: 'OFFICE' | 'APT'
}

export type SpeedyCreateShipmentInput = {
  deliveryType: 'ADDRESS' | 'OFFICE'
  officeId?: number
  receiver: {
    firstName: string
    lastName: string
    phone: string
    address1: string
    city: string
    postalCode: string
  }
  codAmount?: number
  orderReference: string
}

export type SpeedyCreateShipmentResult = {
  shipmentId: string
  trackingUrl?: string
}

type RawSpeedySite = { id: number; name: string; postCode?: string; region?: string }
type RawSpeedyOffice = { id: number; name: string; address?: { fullAddressString?: string }; siteId?: number; type?: string }

export class SpeedyClient {
  private readonly logger: Logger
  private readonly apiUrl: string
  private readonly username?: string
  private readonly password?: string
  private readonly countryId: number

  private sitesCache: { data: SpeedySite[]; expiresAt: number } | null = null
  private officesCache: { data: SpeedyOffice[]; expiresAt: number } | null = null

  constructor(logger: Logger) {
    this.logger = logger
    this.apiUrl = (process.env.SPEEDY_API_URL || DEFAULT_API_URL).replace(/\/+$/, '')
    this.username = process.env.SPEEDY_USERNAME
    this.password = process.env.SPEEDY_PASSWORD
    this.countryId = process.env.SPEEDY_COUNTRY_ID ? Number(process.env.SPEEDY_COUNTRY_ID) : DEFAULT_COUNTRY_ID
  }

  /** Unlike Econt, Speedy has no public demo account - any use of the API requires real credentials. */
  hasCredentials(): boolean {
    return !!this.username && !!this.password
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.hasCredentials()) {
      throw new Error('Speedy credentials are not configured (SPEEDY_USERNAME / SPEEDY_PASSWORD)')
    }

    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: this.username, password: this.password, ...body }),
    })

    const json = await res.json().catch(() => null)

    if (!res.ok || (json && typeof json === 'object' && 'error' in json && json.error)) {
      const message =
        (json && typeof json === 'object' && 'error' in json && (json as any).error?.message) ||
        `Speedy API request to ${path} failed with status ${res.status}`
      throw new Error(message)
    }

    return json as T
  }

  private async fetchSites(): Promise<SpeedySite[]> {
    const now = Date.now()
    if (this.sitesCache && this.sitesCache.expiresAt > now) {
      return this.sitesCache.data
    }

    const res = await this.post<{ sites?: RawSpeedySite[] }>('/location/site', {
      countryId: this.countryId,
    })

    const sites: SpeedySite[] = (res.sites ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      postCode: s.postCode ?? '',
      region: s.region ?? '',
    }))

    this.sitesCache = { data: sites, expiresAt: now + CACHE_TTL_MS }
    return sites
  }

  private async fetchOffices(): Promise<SpeedyOffice[]> {
    const now = Date.now()
    if (this.officesCache && this.officesCache.expiresAt > now) {
      return this.officesCache.data
    }

    const res = await this.post<{ offices?: RawSpeedyOffice[] }>('/location/office', {
      countryId: this.countryId,
    })

    const offices: SpeedyOffice[] = (res.offices ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      address: o.address?.fullAddressString ?? '',
      siteId: o.siteId ?? null,
      type: o.type === 'APT' ? 'APT' : 'OFFICE',
    }))

    this.officesCache = { data: offices, expiresAt: now + CACHE_TTL_MS }
    return offices
  }

  /** Sites (cities) matching `q` (case-insensitive substring). */
  async searchSites(q?: string): Promise<SpeedySite[]> {
    const sites = await this.fetchSites()
    if (!q?.trim()) return sites
    const needle = q.trim().toLowerCase()
    return sites.filter((s) => s.name.toLowerCase().includes(needle))
  }

  async officesForSite(siteId: number): Promise<SpeedyOffice[]> {
    const offices = await this.fetchOffices()
    return offices.filter((o) => o.siteId === siteId)
  }

  private async resolveSiteId(cityName: string): Promise<number | undefined> {
    const sites = await this.fetchSites()
    const needle = cityName.trim().toLowerCase()
    const exact = sites.find((s) => s.name.toLowerCase() === needle)
    if (exact) return exact.id
    const partial = sites.find((s) => s.name.toLowerCase().includes(needle))
    return partial?.id
  }

  /**
   * Creates a Speedy shipment (/shipment). Requires SPEEDY_USERNAME/SPEEDY_PASSWORD.
   *
   * TODO(service id): Speedy requires a numeric `service.serviceId` (e.g. courier/standard
   * domestic service). This isn't documented as a stable public constant, so it's read from
   * SPEEDY_SERVICE_ID with a common default for domestic Speedy Standard, but should be
   * confirmed against the merchant's actual Speedy contract before going live.
   * TODO(weight/content): as with Econt, per-item weight isn't modelled on
   * Medusa's FulfillmentItemDTO yet; a conservative placeholder is used.
   */
  async createShipment(input: SpeedyCreateShipmentInput): Promise<SpeedyCreateShipmentResult> {
    const serviceId = process.env.SPEEDY_SERVICE_ID ? Number(process.env.SPEEDY_SERVICE_ID) : 505

    const recipient: Record<string, unknown> = {
      phone1: { number: input.receiver.phone },
      clientName: `${input.receiver.firstName} ${input.receiver.lastName}`.trim(),
    }

    if (input.deliveryType === 'OFFICE' && input.officeId) {
      recipient.dropoffOfficeId = input.officeId
    } else {
      const siteId = await this.resolveSiteId(input.receiver.city)
      recipient.address = {
        siteId,
        siteName: siteId ? undefined : input.receiver.city,
        streetName: input.receiver.address1,
        postCode: input.receiver.postalCode,
      }
    }

    const payment: Record<string, unknown> = { courierServicePayer: 'SENDER' }
    if (input.codAmount !== undefined) {
      payment.cod = { amount: input.codAmount, processingType: 'CASH' }
    }

    const res = await this.post<{ id?: string | number }>('/shipment', {
      recipient,
      service: { serviceId, autoAdjustPickupDate: true },
      content: { parcelsCount: 1, contents: 'Goods', package: 'BOX' },
      payment,
      ref1: input.orderReference,
    })

    if (!res.id) {
      throw new Error('Speedy createShipment did not return a shipment id')
    }

    return {
      shipmentId: String(res.id),
      trackingUrl: `https://www.speedy.bg/en/track-shipment?shipmentNumber=${res.id}`,
    }
  }

  async cancelShipment(shipmentId: string): Promise<void> {
    await this.post('/shipment/cancel', { shipments: [{ id: shipmentId }] }).catch((err) => {
      this.logger.warn(`Speedy: failed to cancel shipment ${shipmentId}: ${err.message}`)
    })
  }
}

// A single process-wide client so the 12h nomenclature cache is actually shared between the
// fulfillment provider (src/modules/speedy/service.ts) and the public store routes
// (src/api/store/couriers/[carrier]/*) instead of each resolving a fresh, empty cache.
let singleton: SpeedyClient | undefined
export function getSpeedyClient(logger: Logger): SpeedyClient {
  if (!singleton) {
    singleton = new SpeedyClient(logger)
  }
  return singleton
}
