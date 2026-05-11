/**
 * F6 Sprint 2 — body para POST /creative/prompt-templates/:id/preview.
 *
 * Recebe um product_id (e opcionalmente um briefing_id) e devolve os
 * prompts resolvidos por position (com variáveis interpoladas e refs
 * já selecionadas, com signed URLs prontas pra preview no frontend).
 *
 * Útil pra:
 *   (a) Editor de template: ver como os prompts vão renderizar pra um produto específico
 *   (b) QA interno: validar match de refs antes do gerador rodar
 */

export interface PreviewTemplateDto {
  product_id:   string
  /** Opcional — se ausente, usa briefing ativo do produto (se houver). */
  briefing_id?: string
  /** Limitar preview a posições específicas (default: todas). */
  positions?:   number[]
}

export interface ResolvedPositionPreview {
  position:           number
  name:               string
  prompt_resolved:    string                      // {vars} já substituídas
  prompt_template:    string                      // original c/ {vars}
  negative_prompt?:   string                      // já interpolado
  aspect_ratio:       '1:1' | '4:5' | '16:9' | '9:16'
  references: Array<{
    id:               string
    name:             string
    storage_path:     string
    signed_url:       string
    source:           'fixed_id' | 'tag_match' | 'category_match' | 'position_default' | 'product_main' | 'brand_logo'
  }>
  variables_resolved: Record<string, string>      // pra debug
  warnings:           string[]                    // ex: ref_id="abc" não encontrada
}
