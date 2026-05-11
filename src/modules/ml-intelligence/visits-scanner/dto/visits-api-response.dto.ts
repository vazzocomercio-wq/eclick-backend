/**
 * Shape do payload retornado pelo endpoint ML
 * GET /items/{id}/visits/time_window?last=N&unit=day
 *
 * Validado no smoke F11 (2026-05-11):
 *   {
 *     item_id: 'MLB5304689760',
 *     date_from: '2026-05-04T00:00:00Z',
 *     date_to:   '2026-05-11T00:00:00Z',
 *     total_visits: 1,
 *     last: 7,
 *     unit: 'day',
 *     results: [{ date, total, visits_detail: [{company, quantity}] }]
 *   }
 */
export interface MlVisitsDetail {
  company?:  string
  quantity?: number
}

export interface MlVisitsDailyPoint {
  date:           string                 // ISO datetime
  total:          number
  visits_detail?: MlVisitsDetail[]
}

export interface MlItemVisitsTimeWindowResponse {
  item_id?:      string
  date_from?:    string
  date_to?:      string
  total_visits?: number
  last?:         number
  unit?:         string
  results?:      MlVisitsDailyPoint[]
}
