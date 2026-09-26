import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules, ProductStatus } from '@medusajs/framework/utils'
import { createWorkflow, transform, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import {
  createApiKeysWorkflow,
  createCustomersWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createProductTagsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresStep,
  updateStoresWorkflow,
} from '@medusajs/medusa/core-flows'

/**
 * One-off migration off Shopify. Idempotent: every step skips what already exists, so it can be
 * re-run after a partial failure. Run it from a machine that has the exports — customer and order
 * data must never be committed (this repo is public):
 *
 *   CATALOG_SNAPSHOT=../server/prisma/data/catalog-snapshot.json \
 *   SHOPIFY_EXPORT_DIR=~/Downloads \
 *   DATABASE_URL=<Postgres-Medusa URL> medusa exec ./src/scripts/import-shopify.ts
 *
 * - Store setup: EUR (tax-inclusive), region "България" + 20% VAT, sales channel "Storefront",
 *   publishable key, stock locations Sofia/Speedy/Econt, Econt + Speedy flat shipping options.
 * - Catalog from the server's normalized snapshot (EUR cents; see server/prisma/seed.ts --dump):
 *   Shopify collections → product categories, tags, inventory per location.
 * - Customers (customers_export.csv) and historical orders (orders_export_1.csv) — orders stay in
 *   BGN, the currency they were paid in (contracts/euro.md).
 */

const EUR = 'eur'
const REGION_NAME = 'България'
const SALES_CHANNEL = 'Storefront'
// Shopify inventory location keys (server seed) → Medusa stock locations.
const LOCATIONS = [
  { key: 'sofia', name: 'София (ж.к. Люлин 7)', city: 'София', address_1: 'ж.к. Люлин 7' },
  { key: 'speedy', name: 'Спиди', city: 'София', address_1: '' },
  { key: 'ekont', name: 'Еконт', city: 'София', address_1: '' },
] as const
// contracts/euro.md: Econt 3.06 €, Speedy 3.57 €, free from 53.69 € of items.
const SHIPPING = [
  { carrier: 'ECONT', name: 'Еконт', code: 'econt', amount: 3.06 },
  { carrier: 'SPEEDY', name: 'Спиди', code: 'speedy', amount: 3.57 },
] as const
const FREE_SHIPPING_FROM = 53.69

// ---- snapshot shapes (server/prisma/catalog-writer.ts) ----
type SeedVariant = {
  sku: string
  title: string
  priceCents: number
  compareAtCents: number | null
  available: boolean
  options: string[]
  imageSrc: string | null
  position: number
  levels: { location: string; quantity: number }[]
}
type SeedProduct = {
  handle: string
  title: string
  vendor: string
  descriptionHtml: string
  tags: string[]
  seoTitle: string | null
  seoDescription: string | null
  available: boolean
  images: { src: string; alt: string; position: number }[]
  options: { name: string; position: number; values: string[] }[]
  variants: SeedVariant[]
}
type SeedCollection = {
  handle: string
  title: string
  descriptionHtml: string
  imageSrc: string | null
  imageAlt: string | null
  position: number
  productHandles: string[]
}

// ---- tiny RFC 4180 CSV reader (quoted fields, embedded commas/newlines) ----
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...data] = rows
  return data
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}
// Shopify prefixes numeric-looking fields (zip, phone, sku) with a quote.
const t = (s: string | undefined) => (s ?? '').trim().replace(/^'/, '')
const money = (s: string | undefined) => Math.round((Number.parseFloat(t(s)) || 0) * 100) / 100
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

const updateStoreCurrencies = createWorkflow(
  'easytech3d-update-store-currencies',
  (input: { store_id: string }) => {
    const normalized = transform({ input }, ({ input }) => ({
      selector: { id: input.store_id },
      update: {
        supported_currencies: [{ currency_code: EUR, is_default: true }],
      },
    }))
    return new WorkflowResponse(updateStoresStep(normalized))
  },
)

export default async function importShopify({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const only = new Set((process.env.IMPORT_ONLY ?? 'setup,catalog,customers,orders').split(','))

  // ------------------------------------------------------------------ setup
  const storeModule = container.resolve(Modules.STORE)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
  const regionModule = container.resolve(Modules.REGION)
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT)
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)

  const [store] = await storeModule.listStores()
  let [salesChannel] = await salesChannelModule.listSalesChannels({ name: SALES_CHANNEL })
  let [region] = await regionModule.listRegions({ name: REGION_NAME })
  let locations = await stockLocationModule.listStockLocations({})
  let [shippingProfile] = await fulfillmentModule.listShippingProfiles({ type: 'default' })

  if (only.has('setup') && !region) {
    logger.info('setup: store, region, tax, sales channel, locations, shipping, publishable key')
    if (!salesChannel) {
      const { result } = await createSalesChannelsWorkflow(container).run({
        input: { salesChannelsData: [{ name: SALES_CHANNEL, description: 'easytech3d.com storefront' }] },
      })
      salesChannel = result[0]
    }
    await updateStoreCurrencies(container).run({ input: { store_id: store.id } })

    const { result: regions } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: REGION_NAME,
            currency_code: EUR,
            countries: ['bg'],
            payment_providers: ['pp_system_default'],
            automatic_taxes: true,
            is_tax_inclusive: true,
          },
        ],
      },
    })
    region = regions[0]
    await createTaxRegionsWorkflow(container).run({
      input: [
        {
          country_code: 'bg',
          provider_id: 'tp_system',
          default_tax_rate: { rate: 20, code: 'VAT', name: 'ДДС 20%' },
        },
      ],
    })

    const { result: created } = await createStockLocationsWorkflow(container).run({
      input: {
        locations: LOCATIONS.map((l) => ({
          name: l.name,
          address: { city: l.city, country_code: 'BG', address_1: l.address_1 },
        })),
      },
    })
    locations = created
    const sofia = created[0]
    for (const loc of created) {
      await link.create({
        [Modules.STOCK_LOCATION]: { stock_location_id: loc.id },
        [Modules.FULFILLMENT]: { fulfillment_provider_id: 'manual_manual' },
      })
      await linkSalesChannelsToStockLocationWorkflow(container).run({
        input: { id: loc.id, add: [salesChannel.id] },
      })
    }
    await updateStoresWorkflow(container).run({
      input: {
        selector: { id: store.id },
        update: {
          name: 'EasyTech3D',
          default_sales_channel_id: salesChannel.id,
          default_region_id: region.id,
          default_location_id: sofia.id,
        },
      },
    })

    if (!shippingProfile) {
      const { result } = await createShippingProfilesWorkflow(container).run({
        input: { data: [{ name: 'Default Shipping Profile', type: 'default' }] },
      })
      shippingProfile = result[0]
    }
    // Everything ships from Sofia; the courier module can later swap provider_id to econt/speedy.
    const fulfillmentSet = await fulfillmentModule.createFulfillmentSets({
      name: 'Доставка от София',
      type: 'shipping',
      service_zones: [{ name: 'България', geo_zones: [{ country_code: 'bg', type: 'country' }] }],
    })
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: sofia.id },
      [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
    })
    await createShippingOptionsWorkflow(container).run({
      input: SHIPPING.map((s) => ({
        name: s.name,
        price_type: 'flat' as const,
        provider_id: 'manual_manual',
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: shippingProfile.id,
        type: { label: s.name, description: `Доставка с ${s.name}`, code: s.code },
        data: { carrier: s.carrier },
        prices: [
          { currency_code: EUR, amount: s.amount },
          { region_id: region.id, amount: s.amount },
          {
            currency_code: EUR,
            amount: 0,
            rules: [{ attribute: 'item_total', operator: 'gte' as const, value: FREE_SHIPPING_FROM }],
          },
        ],
        rules: [
          { attribute: 'enabled_in_store', value: 'true', operator: 'eq' as const },
          { attribute: 'is_return', value: 'false', operator: 'eq' as const },
        ],
      })),
    })

    const { data: keys } = await query.graph({ entity: 'api_key', fields: ['id'], filters: { type: 'publishable' } })
    let keyId = keys[0]?.id as string | undefined
    if (!keyId) {
      const { result } = await createApiKeysWorkflow(container).run({
        input: { api_keys: [{ title: 'Storefront', type: 'publishable', created_by: '' }] },
      })
      keyId = result[0].id
    }
    // Medusa creates a default key on the default sales channel; stock availability needs the key
    // scoped to exactly one channel, so the key is Storefront-only.
    const { data: keyChannels } = await query.graph({
      entity: 'api_key',
      fields: ['sales_channels.id'],
      filters: { id: keyId },
    })
    const otherChannels = (keyChannels[0]?.sales_channels ?? [])
      .map((sc) => sc?.id as string)
      .filter((id) => id && id !== salesChannel.id)
    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: { id: keyId, add: [salesChannel.id], remove: otherChannels },
    })

    // Tax-inclusive prices (VAT is in the shown price) for the region and for EUR; Medusa creates
    // the EUR preference as tax-exclusive by default.
    const pricingModule = container.resolve(Modules.PRICING)
    const prefs = await pricingModule.listPricePreferences({})
    await pricingModule.upsertPricePreferences(
      [
        { attribute: 'region_id', value: region.id },
        { attribute: 'currency_code', value: EUR },
      ].map((p) => ({
        id: prefs.find((x) => x.attribute === p.attribute && x.value === p.value)?.id,
        ...p,
        is_tax_inclusive: true,
      })),
    )
    logger.info(`setup: done (region ${region.id}, sales channel ${salesChannel.id})`)
  }
  if (!region || !salesChannel || !shippingProfile) throw new Error('Run the setup step first.')
  const locationIdByKey = new Map<string, string>(
    LOCATIONS.map((l) => [l.key, locations.find((loc) => loc.name === l.name)?.id as string]),
  )

  // ---------------------------------------------------------------- catalog
  if (only.has('catalog')) {
    const file = process.env.CATALOG_SNAPSHOT
    if (!file) throw new Error('CATALOG_SNAPSHOT is required for the catalog step')
    const snapshot = JSON.parse(readFileSync(file, 'utf-8')) as {
      products: SeedProduct[]
      collections: SeedCollection[]
    }

    // Categories (Shopify collections, many-to-many).
    const { data: existingCats } = await query.graph({ entity: 'product_category', fields: ['id', 'handle'] })
    const catIdByHandle = new Map<string, string>(existingCats.map((c) => [c.handle, c.id]))
    const newCats = snapshot.collections.filter((c) => !catIdByHandle.has(c.handle))
    if (newCats.length) {
      const { result } = await createProductCategoriesWorkflow(container).run({
        input: {
          product_categories: newCats.map((c) => ({
            name: c.title,
            handle: c.handle,
            description: c.descriptionHtml,
            is_active: true,
            is_internal: false,
            rank: c.position,
            metadata: { image_src: c.imageSrc, image_alt: c.imageAlt },
          })),
        },
      })
      for (const c of result) catIdByHandle.set(c.handle, c.id)
    }
    const catsByProduct = new Map<string, string[]>()
    for (const c of snapshot.collections) {
      for (const h of c.productHandles) {
        catsByProduct.set(h, [...(catsByProduct.get(h) ?? []), catIdByHandle.get(c.handle) as string])
      }
    }

    // Tags.
    const { data: existingTags } = await query.graph({ entity: 'product_tag', fields: ['id', 'value'] })
    const tagIdByValue = new Map<string, string>(existingTags.map((x) => [x.value, x.id]))
    const newTags = [...new Set(snapshot.products.flatMap((p) => p.tags))].filter((v) => !tagIdByValue.has(v))
    if (newTags.length) {
      const { result } = await createProductTagsWorkflow(container).run({
        input: { product_tags: newTags.map((value) => ({ value })) },
      })
      for (const x of result) tagIdByValue.set(x.value, x.id)
    }

    // Products.
    const { data: existingProducts } = await query.graph({ entity: 'product', fields: ['handle'] })
    const have = new Set(existingProducts.map((p) => p.handle))
    const todo = snapshot.products.filter((p) => !have.has(p.handle))
    for (const batch of chunk(todo, 20)) {
      await createProductsWorkflow(container).run({
        input: {
          products: batch.map((p) => {
            const options = p.options.length
              ? p.options.map((o) => ({ title: o.name, values: o.values }))
              : [{ title: 'Title', values: ['Default Title'] }]
            return {
              title: p.title,
              handle: p.handle,
              description: p.descriptionHtml,
              status: ProductStatus.PUBLISHED,
              thumbnail: p.images[0]?.src,
              images: p.images.map((i) => ({ url: i.src })),
              options,
              shipping_profile_id: shippingProfile.id,
              sales_channels: [{ id: salesChannel.id }],
              category_ids: catsByProduct.get(p.handle) ?? [],
              tag_ids: p.tags.map((v) => tagIdByValue.get(v) as string),
              metadata: { vendor: p.vendor, seo_title: p.seoTitle, seo_description: p.seoDescription },
              variants: p.variants.map((v) => ({
                title: v.title,
                sku: v.sku,
                // No stock record in Shopify but sellable → don't track stock.
                manage_inventory: v.levels.length > 0 || !v.available,
                allow_backorder: false,
                variant_rank: v.position,
                options: p.options.length
                  ? Object.fromEntries(p.options.map((o, i) => [o.name, v.options[i]]))
                  : { Title: 'Default Title' },
                prices: [{ currency_code: EUR, amount: v.priceCents / 100 }],
                metadata: {
                  compare_at_amount: v.compareAtCents == null ? null : v.compareAtCents / 100,
                  image_src: v.imageSrc,
                },
              })),
            }
          }),
        },
      })
      logger.info(`catalog: +${batch.length} products`)
    }

    // Inventory levels per location (only for newly created tracked variants).
    const snapshotVariants = new Map(snapshot.products.flatMap((p) => p.variants.map((v) => [v.sku, v])))
    const { data: items } = await query.graph({
      entity: 'inventory_item',
      fields: ['id', 'sku', 'location_levels.id'],
    })
    const levels = items
      .filter((it) => !it.location_levels?.length && snapshotVariants.has(it.sku as string))
      .flatMap((it) => {
        const v = snapshotVariants.get(it.sku as string) as SeedVariant
        const lv = v.levels.length ? v.levels : [{ location: 'sofia', quantity: 0 }]
        return lv.map((l) => ({
          inventory_item_id: it.id,
          location_id: locationIdByKey.get(l.location) as string,
          stocked_quantity: Math.max(0, l.quantity),
        }))
      })
    for (const batch of chunk(levels, 100)) {
      await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: batch } })
    }
    logger.info(`catalog: ${todo.length} products, ${levels.length} inventory levels`)
  }

  const dir = process.env.SHOPIFY_EXPORT_DIR
  const readExport = (f: string) => {
    if (!dir) throw new Error('SHOPIFY_EXPORT_DIR is required for customers/orders')
    return parseCsv(readFileSync(join(dir, f), 'utf-8'))
  }

  // -------------------------------------------------------------- customers
  const customerModule = container.resolve(Modules.CUSTOMER)
  if (only.has('customers')) {
    const existing = await customerModule.listCustomers({}, { select: ['metadata'], take: 10000 })
    const seen = new Set(existing.map((c) => String(c.metadata?.shopify_customer_id ?? '')))
    const rows = readExport('customers_export.csv').filter((c) => !seen.has(t(c['Customer ID'])))
    const data = rows.map((c) => {
      const address1 = t(c['Default Address Address1'])
      return {
        email: t(c.Email).toLowerCase() || null,
        first_name: t(c['First Name']) || null,
        last_name: t(c['Last Name']) || null,
        phone: t(c.Phone) || t(c['Default Address Phone']) || null,
        company_name: t(c['Default Address Company']) || null,
        has_account: false,
        addresses: address1
          ? [
              {
                first_name: t(c['First Name']),
                last_name: t(c['Last Name']),
                company: t(c['Default Address Company']),
                address_1: address1,
                address_2: t(c['Default Address Address2']),
                city: t(c['Default Address City']),
                postal_code: t(c['Default Address Zip']),
                province: t(c['Default Address Province Code']),
                country_code: (t(c['Default Address Country Code']) || 'BG').toLowerCase(),
                phone: t(c['Default Address Phone']),
                is_default_shipping: true,
                is_default_billing: true,
              },
            ]
          : [],
        metadata: {
          shopify_customer_id: t(c['Customer ID']),
          accepts_email_marketing: t(c['Accepts Email Marketing']) === 'yes',
          accepts_sms_marketing: t(c['Accepts SMS Marketing']) === 'yes',
          shopify_total_spent: t(c['Total Spent']),
          shopify_total_orders: t(c['Total Orders']),
          shopify_tags: t(c.Tags),
          shopify_note: t(c.Note),
        },
      }
    })
    for (const batch of chunk(data, 50)) {
      await createCustomersWorkflow(container).run({ input: { customersData: batch } })
    }
    logger.info(`customers: +${data.length}`)
  }

  // ----------------------------------------------------------------- orders
  const orderModule = container.resolve(Modules.ORDER)
  if (only.has('reset-orders')) {
    // Deletes only orders this script imported (they carry metadata.shopify_name).
    const imported = (await orderModule.listOrders({}, { select: ['id', 'metadata'], take: 10000 })).filter(
      (o) => o.metadata?.shopify_name,
    )
    if (imported.length) await orderModule.deleteOrders(imported.map((o) => o.id))
    logger.info(`reset-orders: deleted ${imported.length} imported orders`)
  }
  if (only.has('orders')) {
    const existing = await orderModule.listOrders({}, { select: ['metadata'], take: 10000 })
    const seen = new Set(existing.map((o) => String(o.metadata?.shopify_name ?? '')))

    const byName = new Map<string, Record<string, string>[]>()
    for (const r of readExport('orders_export_1.csv')) {
      if (!byName.has(r.Name)) byName.set(r.Name, [])
      byName.get(r.Name)?.push(r)
    }

    const customers = await customerModule.listCustomers({}, { select: ['id', 'email'], take: 10000 })
    const customerIdByEmail = new Map(customers.filter((c) => c.email).map((c) => [c.email as string, c.id]))
    const skus = [...new Set([...byName.values()].flat().map((r) => t(r['Lineitem sku'])).filter(Boolean))]
    const { data: variants } = await query.graph({
      entity: 'product_variant',
      fields: ['id', 'sku', 'title', 'product.id', 'product.handle', 'product.title', 'product.thumbnail'],
      filters: { sku: skus },
    })
    const variantBySku = new Map(variants.map((v) => [v.sku as string, v]))

    const vat = [{ code: 'VAT', rate: 20, description: 'ДДС 20%' }]
    const address = (h: Record<string, string>, kind: 'Shipping' | 'Billing') => {
      const [first, ...rest] = t(h[`${kind} Name`]).split(/\s+/)
      return {
        first_name: first ?? '',
        last_name: rest.join(' '),
        company: t(h[`${kind} Company`]),
        address_1: t(h[`${kind} Address1`]),
        address_2: t(h[`${kind} Address2`]),
        city: t(h[`${kind} City`]),
        postal_code: t(h[`${kind} Zip`]),
        province: t(h[`${kind} Province Name`]),
        country_code: (t(h[`${kind} Country`]) || 'BG').toLowerCase(),
        phone: t(h[`${kind} Phone`]) || t(h.Phone),
      }
    }

    let created = 0
    for (const [name, rows] of byName) {
      if (seen.has(name)) continue
      const h = rows[0]
      const text = ['Shipping Method', 'Shipping Address1', 'Shipping Address2', 'Shipping Company', 'Notes', 'Tags']
        .map((k) => h[k] ?? '')
        .join(' ')
      const carrier = /speedy|спиди/i.test(text) ? 'SPEEDY' : 'ECONT'
      const office = /office|офис|автомат/i.test(text)
      const fin = t(h['Financial Status'])
      const cancelled = Boolean(t(h['Cancelled at'])) || fin === 'voided'
      const email = t(h.Email).toLowerCase()
      const discount = money(h['Discount Amount'])

      // Shopify line prices are gross; its order-level discount is spread over the lines (up to each
      // line total) as tax-inclusive adjustments, so Medusa's totals equal Shopify's.
      let discountLeft = discount
      const items = rows
        .filter((r) => t(r['Lineitem name']))
        .map((r) => {
          const v = variantBySku.get(t(r['Lineitem sku']))
          const quantity = Number.parseInt(t(r['Lineitem quantity']), 10) || 1
          const unitPrice = money(r['Lineitem price'])
          const share = Math.min(discountLeft, Math.round(quantity * unitPrice * 100) / 100)
          discountLeft = Math.round((discountLeft - share) * 100) / 100
          return {
            title: v?.product?.title ?? t(r['Lineitem name']),
            subtitle: v ? v.title : undefined,
            thumbnail: v?.product?.thumbnail ?? undefined,
            quantity,
            unit_price: unitPrice,
            adjustments:
              share > 0
                ? [{ code: t(h['Discount Code']) || 'SHOPIFY', amount: share, is_tax_inclusive: true }]
                : [],
            is_tax_inclusive: true,
            tax_lines: vat,
            requires_shipping: true,
            variant_id: v?.id,
            variant_sku: t(r['Lineitem sku']) || undefined,
            variant_title: v?.title,
            product_id: v?.product?.id,
            product_handle: v?.product?.handle,
            product_title: v?.product?.title ?? t(r['Lineitem name']),
            metadata: { shopify_line_name: t(r['Lineitem name']) },
          }
        })

      await orderModule.createOrders({
        currency_code: 'bgn',
        email: email || undefined,
        customer_id: email ? customerIdByEmail.get(email) : undefined,
        sales_channel_id: salesChannel.id,
        status: cancelled ? 'canceled' : fin === 'pending' ? 'pending' : 'completed',
        no_notification: true,
        shipping_address: address(h, 'Shipping'),
        billing_address: address(h, 'Billing'),
        items,
        shipping_methods: [
          {
            name: carrier === 'SPEEDY' ? 'Спиди' : 'Еконт',
            amount: money(h.Shipping),
            is_tax_inclusive: true,
            tax_lines: vat,
            data: { carrier, delivery_type: office ? 'OFFICE' : 'ADDRESS', office_name: office ? t(h['Shipping Address1']) : null },
          },
        ],
        transactions:
          fin === 'paid' || fin === 'partially_refunded'
            ? [{ amount: money(h.Total), currency_code: 'bgn', reference: 'shopify', reference_id: name }]
            : [],
        metadata: {
          shopify_name: name,
          shopify_id: t(h.Id),
          shopify_created_at: t(h['Created at']),
          shopify_total: money(h.Total),
          financial_status: fin,
          fulfillment_status: t(h['Fulfillment Status']),
          payment_method: t(h['Payment Method']),
          courier: /speedy|спиди|econt|еконт|ekont/i.test(text) ? 'stated' : 'defaulted to Econt',
          discount_code: t(h['Discount Code']) || null,
          discount_amount: discount || null,
          cancelled_at: t(h['Cancelled at']) || null,
          notes: t(h.Notes) || null,
        },
      })
      created++
    }
    logger.info(`orders: +${created}`)
  }
}
