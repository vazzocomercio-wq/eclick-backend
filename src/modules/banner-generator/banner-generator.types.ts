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
  /** Formato unico (legado, use formats[] preferencialmente). */
  format?:        BannerFormat
  /** Lista de formatos a gerar em paralelo (ex: ['wide', 'square'] gera
   * desktop+mobile). Se omitido, cai no `format` ou no default do estilo. */
  formats?:       BannerFormat[]
  /** Quantas variacoes gerar POR FORMATO (1-4). Default 1. */
  variations?:    number
}

export interface BannerGenerateOutput {
  /** Imagens geradas — agora com format por item. */
  images:           Array<{ url: string; format: BannerFormat }>
  promptUsed:       string
  styleKey:         string
  /** Formatos gerados (pode ter 1 ou N). */
  formats:          BannerFormat[]
  costUsd:          number
  fallbackUsed:     boolean
  primaryError?:    string
}
