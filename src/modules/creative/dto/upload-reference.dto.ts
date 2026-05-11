/**
 * F6 Sprint 2 — body para POST /creative/references/upload-url.
 *
 * Backend gera um path determinístico (`<orgId>/<uuid>.<ext>`) e devolve
 * uma signed write URL (60s TTL) que o frontend usa pra fazer PUT do binário.
 * Depois do upload, frontend chama POST /creative/references com `storage_path`.
 *
 * Razão de separar do `CreateReferenceDto`:
 *   - Path naming controlado server-side (evita poluição do bucket)
 *   - Validação de mime_type/size antes do upload começar
 *   - Possibilita futuramente impor cotas por org
 */

export interface UploadReferenceDto {
  /** Nome do arquivo (só pra extrair extensão e dar nome reconhecível). */
  filename:    string
  /** image/jpeg | image/png | image/webp */
  mime_type:   string
  /** Tamanho em bytes (server valida limite 10MB). */
  size_bytes?: number
}

export interface UploadReferenceResponse {
  /** URL assinada (PUT) — 60s TTL. */
  upload_url:   string
  /** Path determinístico no bucket — passa de volta no POST /references depois. */
  storage_path: string
  /** Bucket usado (sempre 'creative-references' por enquanto). */
  bucket:       string
  /** Expira em (ISO 8601). */
  expires_at:   string
}
