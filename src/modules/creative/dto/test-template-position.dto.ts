/**
 * F6 — body para POST /creative/prompt-templates/:id/positions/:position/test.
 *
 * Gera UMA imagem isolada pra uma position específica de um template, sem
 * criar job/row em creative_images. Resultado vai pro Storage em prefixo
 * `tests/` com TTL (cron limpa).
 *
 * Usado pelo editor de template ("Testar slot") pra iterar visual sem
 * precisar gerar as 11 imagens toda vez.
 */
export interface TestTemplatePositionDto {
  /** Produto cujas variáveis preenchem o prompt. Obrigatório. */
  product_id:   string
  /** Briefing pra ambient_label, use_logo, etc. Se omitido, usa o ativo do produto. */
  briefing_id?: string
}

export interface TestTemplatePositionResult {
  test_image_url:   string                                  // signed URL TTL 1h
  test_image_path:  string                                  // storage path (debug)
  prompt_text:      string                                  // já interpolado + negativos anexados
  references_used:  Array<{ name: string; signed_url: string; source: string }>
  cost_usd:         number
  latency_ms:       number
  provider:         string
  model:            string
  fallback_used:    boolean
  warnings:         string[]
}
