import type { BannerFormat } from './banner-styles'

export interface BannerProductSummary {
  id:                  string
  name:                string
  category:            string | null
  brand:               string | null
  price:               number
  sale_price:          number | null
  photo_url:           string | null
  short_description:   string | null
}

export interface BannerGenerateInput {
  productIds:     string[]
  styleKey:       string
  /** Override do prompt resolvido (avancado — opcional). */
  customPrompt?:  string
  /** Adicoes ao prompt padrao (ex.: "use cores mais frias"). */
  customAdditions?: string
  /** Override do formato sugerido pelo estilo. */
  format?:        BannerFormat
  /** Quantas variacoes gerar (1-4). Default 1. */
  variations?:    number
}

export interface BannerGenerateOutput {
  images:           Array<{ url: string }>
  promptUsed:       string
  styleKey:         string
  format:           BannerFormat
  costUsd:          number
  fallbackUsed:     boolean
  primaryError?:    string
}
