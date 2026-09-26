import { z } from '@medusajs/framework/zod'

export const CourierCitiesQuerySchema = z.object({
  q: z.string().trim().optional(),
})
export type CourierCitiesQueryType = z.infer<typeof CourierCitiesQuerySchema>

export const CourierOfficesQuerySchema = z.object({
  city_id: z.string().trim().min(1, 'city_id is required'),
})
export type CourierOfficesQueryType = z.infer<typeof CourierOfficesQuerySchema>

export const CARRIERS = ['econt', 'speedy'] as const
export type Carrier = (typeof CARRIERS)[number]

export function isCarrier(value: string): value is Carrier {
  return (CARRIERS as readonly string[]).includes(value)
}
