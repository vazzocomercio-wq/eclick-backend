/**
 * F6 Sprint 2 patch — CRUD de taxonomia customizável.
 *
 * Lista combina defaults globais (org_id=NULL) + opções da org.
 * Sort: is_default DESC (defaults primeiro) ? — opcional. Default aqui:
 *   sort_order ASC, label ASC (mistura defaults e custom — UI pode reordenar).
 *
 * Validação:
 *   - kind ∈ {'ambient', 'product_type'}
 *   - value: snake_case, 1..64 chars, [a-z0-9_]+
 *   - label: 1..80 chars, qualquer string
 *   - sort_order: int >= 0 (default 1000)
 *
 * Constraint DB: unique (org, kind, value) — service catch 23505 → 409.
 */

import {
  Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type {
  CreateTaxonomyDto, UpdateTaxonomyDto, TaxonomyKind, TaxonomyOption,
} from './dto/taxonomy.dto'

const VALID_KINDS: readonly TaxonomyKind[] = ['ambient', 'product_type'] as const
const VALUE_REGEX = /^[a-z0-9_]+$/

@Injectable()
export class CreativeTaxonomyService {
  private readonly logger = new Logger(CreativeTaxonomyService.name)

  // ── List ────────────────────────────────────────────────────────────────

  async list(orgId: string, kind: TaxonomyKind): Promise<TaxonomyOption[]> {
    this.assertKind(kind)
    const { data, error } = await supabaseAdmin
      .from('creative_taxonomy_options')
      .select('*')
      .eq('kind', kind)
      .or(`organization_id.is.null,organization_id.eq.${orgId}`)
      .order('sort_order', { ascending: true })
      .order('label',      { ascending: true })

    if (error) throw new BadRequestException(`list taxonomy: ${error.message}`)
    return (data ?? []) as TaxonomyOption[]
  }

  // ── Create ──────────────────────────────────────────────────────────────

  async create(orgId: string, userId: string, dto: CreateTaxonomyDto): Promise<TaxonomyOption> {
    this.assertCreateDto(dto)

    const { data, error } = await supabaseAdmin
      .from('creative_taxonomy_options')
      .insert({
        organization_id: orgId,
        kind:            dto.kind,
        value:           dto.value.trim(),
        label:           dto.label.trim(),
        sort_order:      dto.sort_order ?? 1000,
        is_default:      false,
        linked_position: dto.linked_position ?? null,
        created_by:      userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        // Pode ser (org,kind,value) duplicado OU (org,position) duplicado
        const msg = (error.message ?? '').toLowerCase()
        if (msg.includes('linked_position') || msg.includes('ux_taxonomy_position_per_org')) {
          throw new ConflictException(`posição ${dto.linked_position} já está linkada a outro ambiente`)
        }
        throw new ConflictException(`taxonomy "${dto.value}" já existe para kind=${dto.kind}`)
      }
      throw new BadRequestException(`create taxonomy: ${error.message}`)
    }
    return data as TaxonomyOption
  }

  // ── Get one ─────────────────────────────────────────────────────────────

  async getById(orgId: string, id: string): Promise<TaxonomyOption> {
    const { data, error } = await supabaseAdmin
      .from('creative_taxonomy_options')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new BadRequestException(`get taxonomy: ${error.message}`)
    if (!data) throw new NotFoundException('taxonomia não encontrada')

    const row = data as TaxonomyOption
    // Pode ver default global OU da sua org
    if (row.organization_id !== null && row.organization_id !== orgId) {
      throw new ForbiddenException('taxonomia pertence a outra organização')
    }
    return row
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async update(orgId: string, id: string, dto: UpdateTaxonomyDto): Promise<TaxonomyOption> {
    const existing = await this.getById(orgId, id)
    if (existing.is_default || existing.organization_id === null) {
      throw new ForbiddenException('opções padrão não podem ser editadas')
    }

    const patch: Record<string, unknown> = {}
    if (dto.value !== undefined) {
      if (typeof dto.value !== 'string' || !VALUE_REGEX.test(dto.value)) {
        throw new BadRequestException('value: snake_case [a-z0-9_]+')
      }
      patch.value = dto.value.trim()
    }
    if (dto.label !== undefined) {
      if (typeof dto.label !== 'string' || !dto.label.trim()) {
        throw new BadRequestException('label: string não-vazia')
      }
      if (dto.label.length > 80) throw new BadRequestException('label: máx 80 chars')
      patch.label = dto.label.trim()
    }
    if (dto.sort_order !== undefined) {
      if (typeof dto.sort_order !== 'number' || !Number.isInteger(dto.sort_order) || dto.sort_order < 0) {
        throw new BadRequestException('sort_order: int >= 0')
      }
      patch.sort_order = dto.sort_order
    }
    if (dto.linked_position !== undefined) {
      if (dto.linked_position !== null) {
        if (!Number.isInteger(dto.linked_position) || dto.linked_position < 1 || dto.linked_position > 11) {
          throw new BadRequestException('linked_position: int 1..11 ou null')
        }
        if (existing.kind !== 'ambient') {
          throw new BadRequestException('linked_position só é permitido em kind=ambient')
        }
      }
      patch.linked_position = dto.linked_position
    }

    if (Object.keys(patch).length === 0) return existing

    const { data, error } = await supabaseAdmin
      .from('creative_taxonomy_options')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        const msg = (error.message ?? '').toLowerCase()
        if (msg.includes('linked_position') || msg.includes('ux_taxonomy_position_per_org')) {
          throw new ConflictException(`posição ${dto.linked_position} já está linkada a outro ambiente`)
        }
        throw new ConflictException(`taxonomy value duplicado`)
      }
      throw new BadRequestException(`update taxonomy: ${error.message}`)
    }
    return data as TaxonomyOption
  }

  // ── Delete ──────────────────────────────────────────────────────────────

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const existing = await this.getById(orgId, id)
    if (existing.is_default || existing.organization_id === null) {
      throw new ForbiddenException('opções padrão não podem ser apagadas')
    }

    const { error } = await supabaseAdmin
      .from('creative_taxonomy_options')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)

    if (error) throw new BadRequestException(`delete taxonomy: ${error.message}`)
    return { ok: true }
  }

  // ── Validators ──────────────────────────────────────────────────────────

  private assertKind(kind: string): asserts kind is TaxonomyKind {
    if (!VALID_KINDS.includes(kind as TaxonomyKind)) {
      throw new BadRequestException(`kind inválido. Permitidos: ${VALID_KINDS.join(', ')}`)
    }
  }

  private assertCreateDto(dto: CreateTaxonomyDto): void {
    if (!dto || typeof dto !== 'object') throw new BadRequestException('body inválido')
    this.assertKind(dto.kind)
    if (typeof dto.value !== 'string' || !VALUE_REGEX.test(dto.value)) {
      throw new BadRequestException('value: snake_case obrigatório [a-z0-9_]+')
    }
    if (dto.value.length > 64) throw new BadRequestException('value: máx 64 chars')
    if (typeof dto.label !== 'string' || !dto.label.trim()) {
      throw new BadRequestException('label: string não-vazia obrigatória')
    }
    if (dto.label.length > 80) throw new BadRequestException('label: máx 80 chars')
    if (dto.sort_order !== undefined) {
      if (typeof dto.sort_order !== 'number' || !Number.isInteger(dto.sort_order) || dto.sort_order < 0) {
        throw new BadRequestException('sort_order: int >= 0')
      }
    }
    if (dto.linked_position !== undefined && dto.linked_position !== null) {
      if (!Number.isInteger(dto.linked_position) || dto.linked_position < 1 || dto.linked_position > 11) {
        throw new BadRequestException('linked_position: int 1..11 ou null')
      }
      if (dto.kind !== 'ambient') {
        throw new BadRequestException('linked_position só é permitido em kind=ambient')
      }
    }
  }
}
