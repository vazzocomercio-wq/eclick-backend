/**
 * F6 Sprint 2 — CRUD da galeria de imagens de referência.
 *
 * Padrão de upload (idêntico ao `creative_products`): frontend faz upload
 * direto pro bucket via Supabase Storage com o JWT do user; backend só
 * registra metadata em `creative_reference_images`.
 *
 * Endpoint `/upload-url` é uma facilidade adicional: backend gera o path
 * determinístico e devolve uma signed write URL pra controlar naming.
 *
 * Curated references (is_curated=true, organization_id=NULL): visíveis
 * a todas as orgs (SELECT), mas só editáveis via service_role (seed).
 */

import {
  Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '../../common/supabase'
import type { CreateReferenceDto } from './dto/create-reference.dto'
import type { UpdateReferenceDto } from './dto/update-reference.dto'
import type {
  UploadReferenceDto, UploadReferenceResponse,
} from './dto/upload-reference.dto'

const REFERENCES_BUCKET = 'creative-references'
const MAX_SIZE_BYTES    = 10 * 1024 * 1024 // 10MB (espelha config do bucket)
const ALLOWED_MIME      = ['image/jpeg', 'image/png', 'image/webp'] as const
const UPLOAD_URL_TTL_S  = 60 // 60s — frontend deve fazer PUT logo após receber

export interface CreativeReferenceImage {
  id:                    string
  organization_id:       string | null   // null = curated
  is_curated:            boolean
  name:                  string
  description:           string | null
  storage_bucket:        string
  storage_path:          string
  tags:                  string[]
  category_ml_ids:       string[]
  default_for_positions: number[]
  product_type:          string | null
  ambient:               string | null
  is_active:             boolean
  width:                 number | null
  height:                number | null
  size_bytes:            number | null
  mime_type:             string | null
  uploaded_by:           string | null
  created_at:            string
  updated_at:            string
}

export interface CreativeReferenceImageWithUrl extends CreativeReferenceImage {
  signed_url: string | null
}

@Injectable()
export class CreativeReferencesService {
  private readonly logger = new Logger(CreativeReferencesService.name)

  /** Cache de signed URLs em memória — TTL 50min (signature dura 60min). */
  private readonly signedUrlCache = new Map<string, { url: string; expiresAt: number }>()
  private readonly SIGNED_URL_TTL_MS = 50 * 60 * 1000

  // ── Upload URL issuance ──────────────────────────────────────────────────

  async issueUploadUrl(orgId: string, dto: UploadReferenceDto): Promise<UploadReferenceResponse> {
    if (!dto?.filename || typeof dto.filename !== 'string') {
      throw new BadRequestException('filename obrigatório')
    }
    if (!dto.mime_type || !ALLOWED_MIME.includes(dto.mime_type as typeof ALLOWED_MIME[number])) {
      throw new BadRequestException(`mime_type inválido. Permitidos: ${ALLOWED_MIME.join(', ')}`)
    }
    if (dto.size_bytes !== undefined) {
      if (typeof dto.size_bytes !== 'number' || dto.size_bytes <= 0) {
        throw new BadRequestException('size_bytes: número positivo')
      }
      if (dto.size_bytes > MAX_SIZE_BYTES) {
        throw new BadRequestException(`size_bytes máx ${MAX_SIZE_BYTES} (10MB)`)
      }
    }

    const ext = this.extractExtension(dto.filename, dto.mime_type)
    const uuid = randomUUID()
    const path = `${orgId}/${uuid}.${ext}`

    const { data, error } = await supabaseAdmin
      .storage
      .from(REFERENCES_BUCKET)
      .createSignedUploadUrl(path)
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`createSignedUploadUrl: ${error?.message ?? 'falhou'}`)
    }

    return {
      upload_url:   data.signedUrl,
      storage_path: path,
      bucket:       REFERENCES_BUCKET,
      expires_at:   new Date(Date.now() + UPLOAD_URL_TTL_S * 1000).toISOString(),
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(orgId: string, userId: string, dto: CreateReferenceDto): Promise<CreativeReferenceImageWithUrl> {
    this.assertCreateDto(dto)

    // Confirma que o objeto realmente existe no bucket (evita rows órfãs)
    await this.assertObjectExists(dto.storage_path)

    const { data, error } = await supabaseAdmin
      .from('creative_reference_images')
      .insert({
        organization_id:       orgId,
        is_curated:            false,
        name:                  dto.name.trim(),
        description:           dto.description?.trim() ?? null,
        storage_bucket:        REFERENCES_BUCKET,
        storage_path:          dto.storage_path,
        tags:                  dto.tags                  ?? [],
        category_ml_ids:       dto.category_ml_ids       ?? [],
        default_for_positions: dto.default_for_positions ?? [],
        product_type:          dto.product_type ?? null,
        ambient:               dto.ambient      ?? null,
        is_active:             true,
        width:                 dto.width      ?? null,
        height:                dto.height     ?? null,
        size_bytes:            dto.size_bytes ?? null,
        mime_type:             dto.mime_type  ?? null,
        uploaded_by:           userId,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`create reference: ${error.message}`)

    const row = data as CreativeReferenceImage
    return { ...row, signed_url: await this.signRead(row.storage_path).catch(() => null) }
  }

  async list(orgId: string, opts: {
    search?:           string
    tags?:             string[]
    category_ml_id?:   string
    product_type?:     string
    ambient?:          string
    position?:         number
    include_inactive?: boolean
    include_curated?:  boolean
    only_curated?:     boolean
    limit?:            number
  } = {}): Promise<CreativeReferenceImageWithUrl[]> {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100))

    let q = supabaseAdmin
      .from('creative_reference_images')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (opts.only_curated) {
      q = q.eq('is_curated', true)
    } else if (opts.include_curated) {
      q = q.or(`organization_id.eq.${orgId},is_curated.eq.true`)
    } else {
      q = q.eq('organization_id', orgId).eq('is_curated', false)
    }
    if (!opts.include_inactive) q = q.eq('is_active', true)
    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/[%,]/g, ' ')
      q = q.or(`name.ilike.%${s}%,description.ilike.%${s}%`)
    }
    if (opts.tags?.length)         q = q.overlaps('tags', opts.tags)
    if (opts.category_ml_id)       q = q.contains('category_ml_ids', [opts.category_ml_id])
    if (opts.product_type?.trim()) q = q.eq('product_type', opts.product_type.trim())
    if (opts.ambient?.trim())      q = q.eq('ambient',      opts.ambient.trim())
    if (opts.position !== undefined && Number.isInteger(opts.position)) {
      q = q.contains('default_for_positions', [opts.position])
    }

    const { data, error } = await q
    if (error) throw new BadRequestException(`list references: ${error.message}`)

    const rows = (data ?? []) as CreativeReferenceImage[]
    return Promise.all(rows.map(async r => ({
      ...r,
      signed_url: await this.signRead(r.storage_path).catch(() => null),
    })))
  }

  async getById(orgId: string, id: string, opts: { allowCurated?: boolean } = {}): Promise<CreativeReferenceImageWithUrl> {
    const { data, error } = await supabaseAdmin
      .from('creative_reference_images')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`get reference: ${error.message}`)
    if (!data) throw new NotFoundException('reference não encontrada')

    const row = data as CreativeReferenceImage
    const canAccess =
      (row.is_curated && (opts.allowCurated !== false)) ||
      row.organization_id === orgId
    if (!canAccess) throw new ForbiddenException('reference pertence a outra organização')

    return { ...row, signed_url: await this.signRead(row.storage_path).catch(() => null) }
  }

  async update(orgId: string, id: string, dto: UpdateReferenceDto): Promise<CreativeReferenceImageWithUrl> {
    const existing = await this.getById(orgId, id, { allowCurated: false })
    if (existing.is_curated) {
      throw new ForbiddenException('references curated só podem ser editadas via service_role')
    }

    const patch: Record<string, unknown> = {}
    if (dto.name !== undefined) {
      if (typeof dto.name !== 'string' || !dto.name.trim()) {
        throw new BadRequestException('name: string não-vazia ou omitido')
      }
      patch.name = dto.name.trim()
    }
    if (dto.description !== undefined) {
      patch.description = typeof dto.description === 'string' ? dto.description.trim() || null : null
    }
    if (dto.tags !== undefined) {
      if (!Array.isArray(dto.tags) || dto.tags.some(t => typeof t !== 'string')) {
        throw new BadRequestException('tags: array de strings')
      }
      patch.tags = dto.tags
    }
    if (dto.category_ml_ids !== undefined) {
      if (!Array.isArray(dto.category_ml_ids) || dto.category_ml_ids.some(c => typeof c !== 'string')) {
        throw new BadRequestException('category_ml_ids: array de strings')
      }
      patch.category_ml_ids = dto.category_ml_ids
    }
    if (dto.default_for_positions !== undefined) {
      if (!Array.isArray(dto.default_for_positions) || dto.default_for_positions.some(p => !Number.isInteger(p))) {
        throw new BadRequestException('default_for_positions: array de inteiros')
      }
      patch.default_for_positions = dto.default_for_positions
    }
    if (dto.product_type !== undefined) {
      patch.product_type = typeof dto.product_type === 'string' ? dto.product_type.trim() || null : null
    }
    if (dto.ambient !== undefined) {
      patch.ambient = typeof dto.ambient === 'string' ? dto.ambient.trim() || null : null
    }
    if (dto.is_active !== undefined) {
      if (typeof dto.is_active !== 'boolean') throw new BadRequestException('is_active: boolean')
      patch.is_active = dto.is_active
    }
    if (dto.width !== undefined)      patch.width      = dto.width
    if (dto.height !== undefined)     patch.height     = dto.height
    if (dto.size_bytes !== undefined) patch.size_bytes = dto.size_bytes
    if (dto.mime_type !== undefined)  patch.mime_type  = dto.mime_type

    if (Object.keys(patch).length === 0) {
      return existing
    }

    const { data, error } = await supabaseAdmin
      .from('creative_reference_images')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`update reference: ${error.message}`)

    const row = data as CreativeReferenceImage
    return { ...row, signed_url: await this.signRead(row.storage_path).catch(() => null) }
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const existing = await this.getById(orgId, id, { allowCurated: false })
    if (existing.is_curated) {
      throw new ForbiddenException('references curated só podem ser apagadas via service_role')
    }

    const { error } = await supabaseAdmin
      .from('creative_reference_images')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`delete reference: ${error.message}`)

    // Best-effort: limpa o objeto no Storage também (não falha se já sumiu)
    try {
      await supabaseAdmin.storage.from(REFERENCES_BUCKET).remove([existing.storage_path])
    } catch (e) {
      this.logger.warn(`storage cleanup falhou pra ${existing.storage_path}: ${(e as Error).message}`)
    }

    // Invalida cache
    this.signedUrlCache.delete(existing.storage_path)
    return { ok: true }
  }

  async toggleActive(orgId: string, id: string): Promise<CreativeReferenceImageWithUrl> {
    const existing = await this.getById(orgId, id, { allowCurated: false })
    if (existing.is_curated) {
      throw new ForbiddenException('references curated só podem ser editadas via service_role')
    }
    return this.update(orgId, id, { is_active: !existing.is_active })
  }

  // ── Signed URL with in-memory cache ──────────────────────────────────────

  /**
   * Devolve signed read URL com cache de 50min em memória.
   * Exposto também pra `template-resolution.service` evitar duplicação.
   */
  async signRead(storagePath: string): Promise<string> {
    const cached = this.signedUrlCache.get(storagePath)
    const now = Date.now()
    if (cached && cached.expiresAt > now) {
      return cached.url
    }

    const { data, error } = await supabaseAdmin
      .storage
      .from(REFERENCES_BUCKET)
      .createSignedUrl(storagePath, 60 * 60) // 1h
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`signRead: ${error?.message ?? 'falhou'}`)
    }
    this.signedUrlCache.set(storagePath, {
      url:       data.signedUrl,
      expiresAt: now + this.SIGNED_URL_TTL_MS,
    })
    return data.signedUrl
  }

  /** Limpa cache (útil pra testes / regenerar URL forçadamente). */
  clearSignedUrlCache(): void {
    this.signedUrlCache.clear()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private assertCreateDto(dto: CreateReferenceDto): void {
    if (!dto || typeof dto !== 'object') throw new BadRequestException('body inválido')
    if (typeof dto.storage_path !== 'string' || !dto.storage_path.trim()) {
      throw new BadRequestException('storage_path: string obrigatória')
    }
    if (typeof dto.name !== 'string' || !dto.name.trim()) {
      throw new BadRequestException('name: string obrigatória')
    }
    if (dto.tags !== undefined && (!Array.isArray(dto.tags) || dto.tags.some(t => typeof t !== 'string'))) {
      throw new BadRequestException('tags: array de strings')
    }
    if (dto.category_ml_ids !== undefined && (!Array.isArray(dto.category_ml_ids) || dto.category_ml_ids.some(c => typeof c !== 'string'))) {
      throw new BadRequestException('category_ml_ids: array de strings')
    }
    if (dto.default_for_positions !== undefined && (!Array.isArray(dto.default_for_positions) || dto.default_for_positions.some(p => !Number.isInteger(p)))) {
      throw new BadRequestException('default_for_positions: array de inteiros')
    }
    if (dto.mime_type !== undefined && !ALLOWED_MIME.includes(dto.mime_type as typeof ALLOWED_MIME[number])) {
      throw new BadRequestException(`mime_type inválido. Permitidos: ${ALLOWED_MIME.join(', ')}`)
    }
    if (dto.size_bytes !== undefined && (typeof dto.size_bytes !== 'number' || dto.size_bytes <= 0 || dto.size_bytes > MAX_SIZE_BYTES)) {
      throw new BadRequestException(`size_bytes: 1..${MAX_SIZE_BYTES} (10MB)`)
    }
  }

  private async assertObjectExists(storagePath: string): Promise<void> {
    // Lista o folder e verifica se o nome bate. createSignedUrl falharia tarde
    // se path não existir, então checamos antes.
    const slash = storagePath.lastIndexOf('/')
    const folder = slash >= 0 ? storagePath.slice(0, slash) : ''
    const filename = slash >= 0 ? storagePath.slice(slash + 1) : storagePath

    const { data, error } = await supabaseAdmin
      .storage
      .from(REFERENCES_BUCKET)
      .list(folder, { search: filename, limit: 1 })
    if (error) {
      this.logger.warn(`assertObjectExists falhou pra ${storagePath}: ${error.message}`)
      return // não trava — pode ser config local
    }
    if (!data || data.length === 0) {
      throw new BadRequestException(`storage_path ${storagePath} não existe no bucket ${REFERENCES_BUCKET}`)
    }
  }

  private extractExtension(filename: string, mimeType: string): string {
    const fromName = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
    if (['jpg', 'jpeg', 'png', 'webp'].includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
    if (mimeType === 'image/jpeg') return 'jpg'
    if (mimeType === 'image/png')  return 'png'
    if (mimeType === 'image/webp') return 'webp'
    return 'jpg'
  }
}
