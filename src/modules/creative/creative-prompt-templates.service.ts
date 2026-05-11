/**
 * F6 Sprint 2 — CRUD de templates de prompt por position.
 *
 * Pattern do módulo creative:
 *   - supabaseAdmin (service_role) + filtro manual `.eq('organization_id', orgId)`
 *   - BadRequest/NotFound/Forbidden via @nestjs/common exceptions
 *   - Validação manual (sem class-validator)
 *
 * Não toca em pipeline. Resolução de variáveis e refs fica em
 * `creative-template-resolution.service.ts`.
 */

import {
  Injectable, Logger, BadRequestException, NotFoundException, ConflictException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import {
  assertPositionsArray,
  type TemplatePositionDto,
} from './dto/template-position.dto'
import type { CreatePromptTemplateDto } from './dto/create-prompt-template.dto'
import type { UpdatePromptTemplateDto } from './dto/update-prompt-template.dto'

// ── Row type (espelha schema) ────────────────────────────────────────────────

export interface CreativeImagePromptTemplate {
  id:              string
  organization_id: string
  name:            string
  description:     string | null
  is_default:      boolean
  category_ml_ids: string[]
  brand_voice:     string | null
  positions:       TemplatePositionDto[]
  created_by:      string | null
  created_at:      string
  updated_at:      string
}

// ── Variáveis interpoláveis disponíveis (referência canônica) ───────────────

export const TEMPLATE_VARIABLES = [
  'product_name',
  'material',
  'primary_color',
  'secondary_color',
  'dimensions',
  'category_label',
  'brand_name',
  'detected_parts',
  'usage_contexts',
  'target_audience',
  'commercial_differentials',
  'ambient_label',
] as const

export type TemplateVariable = typeof TEMPLATE_VARIABLES[number]

@Injectable()
export class CreativePromptTemplatesService {
  private readonly logger = new Logger(CreativePromptTemplatesService.name)

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Valida DTO e arruma defaults. Lança BadRequest se inválido. */
  private parseCreateDto(dto: CreatePromptTemplateDto): {
    name:            string
    description:     string | null
    is_default:      boolean
    category_ml_ids: string[]
    brand_voice:     string | null
    positions:       TemplatePositionDto[]
  } {
    if (!dto || typeof dto !== 'object') throw new BadRequestException('body inválido')
    if (typeof dto.name !== 'string' || !dto.name.trim()) {
      throw new BadRequestException('name: string não-vazia obrigatória')
    }
    if (dto.name.length > 200) throw new BadRequestException('name: máx 200 chars')

    let positions: TemplatePositionDto[]
    try {
      positions = assertPositionsArray(dto.positions)
    } catch (e) {
      throw new BadRequestException((e as Error).message)
    }

    if (dto.category_ml_ids !== undefined) {
      if (!Array.isArray(dto.category_ml_ids) || dto.category_ml_ids.some(v => typeof v !== 'string')) {
        throw new BadRequestException('category_ml_ids: array de strings')
      }
    }

    return {
      name:            dto.name.trim(),
      description:     dto.description?.trim() ?? null,
      is_default:      dto.is_default ?? false,
      category_ml_ids: dto.category_ml_ids ?? [],
      brand_voice:     dto.brand_voice?.trim() ?? null,
      positions,
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(orgId: string, userId: string, dto: CreatePromptTemplateDto): Promise<CreativeImagePromptTemplate> {
    const parsed = this.parseCreateDto(dto)

    // Se is_default=true, desativa qualquer outro default da org (UNIQUE constraint
    // do DB falaria, mas tratamos antes pra UX melhor).
    if (parsed.is_default) {
      await this.clearOtherDefaults(orgId)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .insert({
        organization_id: orgId,
        name:            parsed.name,
        description:     parsed.description,
        is_default:      parsed.is_default,
        category_ml_ids: parsed.category_ml_ids,
        brand_voice:     parsed.brand_voice,
        positions:       parsed.positions,
        created_by:      userId,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`create template: ${error.message}`)
    return data as CreativeImagePromptTemplate
  }

  async list(orgId: string, opts: { search?: string; category_ml_id?: string } = {}): Promise<CreativeImagePromptTemplate[]> {
    let q = supabaseAdmin
      .from('creative_image_prompt_templates')
      .select('*')
      .eq('organization_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)

    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/[%,]/g, ' ')
      q = q.or(`name.ilike.%${s}%,description.ilike.%${s}%`)
    }
    if (opts.category_ml_id?.trim()) {
      q = q.contains('category_ml_ids', [opts.category_ml_id.trim()])
    }

    const { data, error } = await q
    if (error) throw new BadRequestException(`list templates: ${error.message}`)
    return (data ?? []) as CreativeImagePromptTemplate[]
  }

  async getById(orgId: string, id: string): Promise<CreativeImagePromptTemplate> {
    const { data, error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`get template: ${error.message}`)
    if (!data) throw new NotFoundException('template não encontrado')
    return data as CreativeImagePromptTemplate
  }

  async update(orgId: string, id: string, dto: UpdatePromptTemplateDto): Promise<CreativeImagePromptTemplate> {
    await this.getById(orgId, id) // tenant check

    const patch: Record<string, unknown> = {}

    if (dto.name !== undefined) {
      if (typeof dto.name !== 'string' || !dto.name.trim()) {
        throw new BadRequestException('name: string não-vazia ou omitido')
      }
      if (dto.name.length > 200) throw new BadRequestException('name: máx 200 chars')
      patch.name = dto.name.trim()
    }
    if (dto.description !== undefined) {
      patch.description = typeof dto.description === 'string' ? dto.description.trim() || null : null
    }
    if (dto.category_ml_ids !== undefined) {
      if (!Array.isArray(dto.category_ml_ids) || dto.category_ml_ids.some(v => typeof v !== 'string')) {
        throw new BadRequestException('category_ml_ids: array de strings')
      }
      patch.category_ml_ids = dto.category_ml_ids
    }
    if (dto.brand_voice !== undefined) {
      patch.brand_voice = typeof dto.brand_voice === 'string' ? dto.brand_voice.trim() || null : null
    }
    if (dto.positions !== undefined) {
      try {
        patch.positions = assertPositionsArray(dto.positions)
      } catch (e) {
        throw new BadRequestException((e as Error).message)
      }
    }
    if (dto.is_default !== undefined) {
      if (typeof dto.is_default !== 'boolean') throw new BadRequestException('is_default: boolean')
      if (dto.is_default) await this.clearOtherDefaults(orgId, id)
      patch.is_default = dto.is_default
    }

    if (Object.keys(patch).length === 0) {
      return this.getById(orgId, id)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`update template: ${error.message}`)
    return data as CreativeImagePromptTemplate
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const existing = await this.getById(orgId, id)
    // Não deixa apagar template default sem promover outro — UX simples
    if (existing.is_default) {
      throw new ConflictException('template default não pode ser apagado; promova outro template a default antes')
    }
    const { error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`delete template: ${error.message}`)
    return { ok: true }
  }

  /** Promove template a default (idempotente). */
  async setDefault(orgId: string, id: string): Promise<CreativeImagePromptTemplate> {
    await this.getById(orgId, id) // tenant check
    await this.clearOtherDefaults(orgId, id)
    const { data, error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .update({ is_default: true })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`setDefault: ${error.message}`)
    return data as CreativeImagePromptTemplate
  }

  /** Clona template existente — novo nome, mesmas positions, is_default=false. */
  async clone(orgId: string, userId: string, id: string, newName?: string): Promise<CreativeImagePromptTemplate> {
    const original = await this.getById(orgId, id)
    const { data, error } = await supabaseAdmin
      .from('creative_image_prompt_templates')
      .insert({
        organization_id: orgId,
        name:            newName?.trim() || `${original.name} (cópia)`,
        description:     original.description,
        is_default:      false,                  // cópias nunca herdam default
        category_ml_ids: original.category_ml_ids,
        brand_voice:     original.brand_voice,
        positions:       original.positions,
        created_by:      userId,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`clone template: ${error.message}`)
    return data as CreativeImagePromptTemplate
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async clearOtherDefaults(orgId: string, exceptId?: string): Promise<void> {
    let q = supabaseAdmin
      .from('creative_image_prompt_templates')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .eq('is_default', true)
    if (exceptId) q = q.neq('id', exceptId)
    const { error } = await q
    if (error) {
      this.logger.warn(`clearOtherDefaults: ${error.message}`)
      // não trava — UNIQUE partial index do DB ainda protege
    }
  }
}
