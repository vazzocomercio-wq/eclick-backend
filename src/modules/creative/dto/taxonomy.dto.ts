/**
 * F6 Sprint 2 patch — DTOs pra taxonomia customizável.
 *
 * Endpoints:
 *   GET    /creative/taxonomy?kind=ambient|product_type   → list (defaults + org's)
 *   POST   /creative/taxonomy                              → create (org only)
 *   PATCH  /creative/taxonomy/:id                          → update (org only, non-default)
 *   DELETE /creative/taxonomy/:id                          → delete (org only, non-default)
 *
 * Sem class-validator — TypeScript interfaces + validação manual no service.
 */

export type TaxonomyKind = 'ambient' | 'product_type'

export interface CreateTaxonomyDto {
  kind:             TaxonomyKind
  value:            string         // snake_case key, único por (org, kind)
  label:            string         // display name
  sort_order?:      number         // default 1000 (final da lista user)
  linked_position?: number | null  // 1..11 — só kind='ambient' (constraint DB)
}

export interface UpdateTaxonomyDto {
  value?:           string
  label?:           string
  sort_order?:      number
  linked_position?: number | null  // explicit null = desliga link
}

/** Row do DB devolvido pra cliente. */
export interface TaxonomyOption {
  id:               string
  organization_id:  string | null   // null = default global
  kind:             TaxonomyKind
  value:            string
  label:            string
  sort_order:       number
  is_default:       boolean
  linked_position:  number | null   // 1..11 ou null
  created_at:       string
  updated_at:       string
}
