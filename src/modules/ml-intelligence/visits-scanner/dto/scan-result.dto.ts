export interface ScanOptions {
  periodDays:           number[]                  // default [7]; pode passar [7, 30]
  rateLimitMs:          number                    // default 1000
  maxRetries:           number                    // default 3
  maxItemsPerSeller?:   number                    // safety cap, default 2000
}

export interface ScanResult {
  organizationId:    string
  sellerId:          number
  periodDays:        number
  itemsTotal:        number
  success:           number
  skipped:           number                       // 404/410 - item morto
  failed:            number                       // esgotou retries
  durationMs:        number
  errorsByStatus:    Record<number, number>
}

export interface ScanItemResult {
  ok:         boolean
  httpStatus: number
  visits?:    number
  error?:     string
}
