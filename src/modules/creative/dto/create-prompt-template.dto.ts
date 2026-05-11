/**
 * F6 Sprint 2 — body para POST /creative/prompt-templates.
 *
 * `positions` é um array de TemplatePositionDto (validação detalhada
 * em template-position.dto.ts).
 */

import type { TemplatePositionDto } from './template-position.dto'

export interface CreatePromptTemplateDto {
  /** Nome curto humano-legível. */
  name:             string
  /** Descrição opcional (livre). */
  description?:     string
  /** Marcar como default da org. Constraint DB garante 1 default/org. */
  is_default?:      boolean
  /** Match por categoria ML. Vazio = template global. */
  category_ml_ids?: string[]
  /** Brand voice transversal — "Premium, refinado, minimalista". */
  brand_voice?:     string
  /** Array obrigatório de positions. */
  positions:        TemplatePositionDto[]
}
