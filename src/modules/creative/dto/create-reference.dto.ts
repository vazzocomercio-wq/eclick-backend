/**
 * F6 Sprint 2 — body para POST /creative/references.
 *
 * Frontend já fez upload do binário pro bucket `creative-references` via
 * Supabase Storage (com JWT do user). Backend só registra a metadata.
 *
 * Pattern espelha `creative_products`: client faz upload, server registra path.
 */

export interface CreateReferenceDto {
  /** Path completo no bucket `creative-references` — ex: `<orgId>/<uuid>.jpg`. */
  storage_path:           string
  /** Nome curto humano. */
  name:                   string
  /** Descrição opcional. */
  description?:           string
  /** Tags livres (livre + GIN-indexado). */
  tags?:                  string[]
  /** Categorias ML que esta ref ajuda. Vazio = global. */
  category_ml_ids?:       string[]
  /** Posições padrão (ex: [2,4,6] = serve pra position 2/4/6 quando reference_match.by_position_default=true). */
  default_for_positions?: number[]
  /** Tipo de produto (lustre/abajur/...). */
  product_type?:          string
  /** Ambiente (sala/quarto/...). */
  ambient?:               string
  /** Metadata opcional do arquivo (apenas pra UI). */
  width?:                 number
  height?:                number
  size_bytes?:            number
  mime_type?:             string
}
