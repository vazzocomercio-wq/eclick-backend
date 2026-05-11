/**
 * F6 Sprint 2 — Fase 2.2
 *
 * Schema do item `positions[i]` em `creative_image_prompt_templates.positions` (jsonb).
 * Validação manual em service (codebase não usa class-validator).
 *
 * Variáveis interpoláveis aceitas em `prompt_template` e `negative_prompt`:
 *   {product_name} {material} {primary_color} {secondary_color} {dimensions}
 *   {category_label} {brand_name} {detected_parts} {usage_contexts}
 *   {target_audience} {commercial_differentials} {ambient_label}
 */

export type AspectRatio = '1:1' | '4:5' | '16:9' | '9:16'

export interface ReferenceMatchDto {
  /** Match dinâmico por tags — refs que contenham QUALQUER uma das tags listadas. */
  by_tags?:              string[]
  /** Se true, filtra refs por `category_ml_ids` que cubram a categoria do produto. */
  by_category?:          boolean
  /** Se true, filtra refs que tenham essa `position` em `default_for_positions`. */
  by_position_default?:  boolean
  /** Máx de refs a anexar (default 3, hard cap 6). */
  limit?:                number
}

export interface TemplatePositionDto {
  /** 1..11 (pode ir além se template tiver 20 imgs). */
  position:               number
  /** Nome curto p/ UI: "Capa pura", "Lifestyle cozinha"… */
  name:                   string
  /** Prompt com {vars} interpoláveis. */
  prompt_template:        string
  /** Negative prompt (gpt-image-1 ignora; Gemini aceita). */
  negative_prompt?:       string
  /** Anexa a imagem principal do produto que user subiu. */
  use_product_reference:  boolean
  /** Anexa logo da marca (se briefing.use_logo + logo_url presentes). */
  use_brand_logo:         boolean
  /** IDs fixos de creative_reference_images a anexar. */
  use_reference_ids:      string[]
  /** Match dinâmico (alternativa ou complemento aos fixos). */
  reference_match?:       ReferenceMatchDto
  /** Hint textual de ambiente — interpolado em `{ambient_label}`. */
  ambient_hint?:          string
  /** Aspect ratio. Default '1:1'. */
  aspect_ratio?:          AspectRatio
}

/** Validação manual — usar no service antes de persistir. */
export function assertTemplatePosition(p: unknown, idx: number): TemplatePositionDto {
  if (!p || typeof p !== 'object') {
    throw new Error(`positions[${idx}]: deve ser objeto`)
  }
  const x = p as Record<string, unknown>

  if (typeof x.position !== 'number' || !Number.isInteger(x.position) || x.position < 1 || x.position > 50) {
    throw new Error(`positions[${idx}].position: inteiro entre 1 e 50`)
  }
  if (typeof x.name !== 'string' || !x.name.trim()) {
    throw new Error(`positions[${idx}].name: string não-vazia`)
  }
  if (typeof x.prompt_template !== 'string' || !x.prompt_template.trim()) {
    throw new Error(`positions[${idx}].prompt_template: string não-vazia`)
  }
  if (typeof x.use_product_reference !== 'boolean') {
    throw new Error(`positions[${idx}].use_product_reference: boolean obrigatório`)
  }
  if (typeof x.use_brand_logo !== 'boolean') {
    throw new Error(`positions[${idx}].use_brand_logo: boolean obrigatório`)
  }
  if (!Array.isArray(x.use_reference_ids) || x.use_reference_ids.some(v => typeof v !== 'string')) {
    throw new Error(`positions[${idx}].use_reference_ids: array de strings (uuid)`)
  }
  if (x.negative_prompt !== undefined && typeof x.negative_prompt !== 'string') {
    throw new Error(`positions[${idx}].negative_prompt: string ou omitido`)
  }
  if (x.ambient_hint !== undefined && typeof x.ambient_hint !== 'string') {
    throw new Error(`positions[${idx}].ambient_hint: string ou omitido`)
  }
  if (x.aspect_ratio !== undefined && !['1:1', '4:5', '16:9', '9:16'].includes(x.aspect_ratio as string)) {
    throw new Error(`positions[${idx}].aspect_ratio: um de [1:1,4:5,16:9,9:16] ou omitido`)
  }
  if (x.reference_match !== undefined) {
    const m = x.reference_match as Record<string, unknown>
    if (typeof m !== 'object' || m === null) {
      throw new Error(`positions[${idx}].reference_match: objeto ou omitido`)
    }
    if (m.by_tags !== undefined && (!Array.isArray(m.by_tags) || m.by_tags.some(t => typeof t !== 'string'))) {
      throw new Error(`positions[${idx}].reference_match.by_tags: array de strings`)
    }
    if (m.by_category !== undefined && typeof m.by_category !== 'boolean') {
      throw new Error(`positions[${idx}].reference_match.by_category: boolean`)
    }
    if (m.by_position_default !== undefined && typeof m.by_position_default !== 'boolean') {
      throw new Error(`positions[${idx}].reference_match.by_position_default: boolean`)
    }
    if (m.limit !== undefined && (typeof m.limit !== 'number' || !Number.isInteger(m.limit) || m.limit < 1 || m.limit > 6)) {
      throw new Error(`positions[${idx}].reference_match.limit: inteiro 1..6`)
    }
  }

  return {
    position:              x.position,
    name:                  (x.name as string).trim(),
    prompt_template:       (x.prompt_template as string).trim(),
    negative_prompt:       x.negative_prompt as string | undefined,
    use_product_reference: x.use_product_reference,
    use_brand_logo:        x.use_brand_logo,
    use_reference_ids:     x.use_reference_ids as string[],
    reference_match:       x.reference_match as ReferenceMatchDto | undefined,
    ambient_hint:          x.ambient_hint as string | undefined,
    aspect_ratio:          x.aspect_ratio as AspectRatio | undefined,
  }
}

export function assertPositionsArray(raw: unknown): TemplatePositionDto[] {
  if (!Array.isArray(raw)) throw new Error('positions: deve ser array')
  if (raw.length === 0) throw new Error('positions: array vazio')
  if (raw.length > 50) throw new Error('positions: máx 50 itens')

  const parsed = raw.map((p, i) => assertTemplatePosition(p, i))

  // Dedup por position (não pode ter 2 com mesma position)
  const seen = new Set<number>()
  for (const p of parsed) {
    if (seen.has(p.position)) throw new Error(`positions: position=${p.position} duplicada`)
    seen.add(p.position)
  }

  return parsed
}
