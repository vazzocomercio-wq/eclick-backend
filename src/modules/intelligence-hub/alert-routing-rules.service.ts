import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type {
  CreateRoutingRuleDto, UpdateRoutingRuleDto,
} from './dto/routing-rule.dto'

interface DefaultRule {
  department:   'compras' | 'comercial' | 'marketing' | 'logistica' | 'diretoria'
  analyzer:     'compras' | 'preco' | 'estoque' | 'margem' | 'ads' | '*'
  categories:   string[]
  min_score:    number
}

const DEFAULT_RULES: DefaultRule[] = [
  { department: 'compras',   analyzer: 'compras',  categories: [],                              min_score: 30 },
  { department: 'compras',   analyzer: 'estoque',  categories: [],                              min_score: 30 },
  { department: 'comercial', analyzer: 'preco',    categories: [],                              min_score: 30 },
  { department: 'comercial', analyzer: 'margem',   categories: [],                              min_score: 30 },
  { department: 'marketing', analyzer: 'ads',      categories: [],                              min_score: 30 },
  { department: 'logistica', analyzer: 'estoque',  categories: ['cobertura_baixa', 'ruptura'],  min_score: 50 },
  { department: 'diretoria', analyzer: '*',        categories: [],                              min_score: 80 },
]

/**
 * Regras de roteamento (departamento → analyzer/categorias).
 *
 * UNIQUE (org, dept, analyzer) garante que cada par dept/analyzer só tem 1
 * regra por org. Pra duas regras do mesmo analyzer no mesmo dept (ex: tiers
 * de score), modela com categories distintas.
 *
 * Defaults criados via createDefaults() quando hub é habilitado pela 1ª vez.
 */
@Injectable()
export class AlertRoutingRulesService {
  private readonly logger = new Logger(AlertRoutingRulesService.name)

  async list(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .select('*')
      .eq('organization_id', orgId)
      .order('department', { ascending: true })
      .order('analyzer', { ascending: true })
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  async findOne(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException(`Regra ${id} não encontrada`)
    return data
  }

  async create(orgId: string, dto: CreateRoutingRuleDto) {
    if (!dto.department) throw new BadRequestException('department obrigatório')
    if (!dto.analyzer)   throw new BadRequestException('analyzer obrigatório')

    const payload = {
      organization_id: orgId,
      department: dto.department,
      analyzer:   dto.analyzer,
      categories: dto.categories ?? [],
      min_score:  dto.min_score ?? 0,
      enabled:    dto.enabled ?? true,
    }

    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .insert(payload)
      .select()
      .single()
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('Já existe regra pra esse departamento + analyzer. Edite a existente.')
      }
      throw new BadRequestException(error.message)
    }
    return data
  }

  async update(orgId: string, id: string, dto: UpdateRoutingRuleDto) {
    await this.findOne(orgId, id)

    const payload: Record<string, unknown> = {}
    if (dto.department !== undefined) payload.department = dto.department
    if (dto.analyzer !== undefined)   payload.analyzer   = dto.analyzer
    if (dto.categories !== undefined) payload.categories = dto.categories
    if (dto.min_score !== undefined)  payload.min_score  = dto.min_score
    if (dto.enabled !== undefined)    payload.enabled    = dto.enabled

    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .update(payload)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data
  }

  async remove(orgId: string, id: string) {
    await this.findOne(orgId, id)
    const { error } = await supabaseAdmin
      .from('alert_routing_rules')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  async createDefaults(orgId: string) {
    const rows = DEFAULT_RULES.map(r => ({ organization_id: orgId, ...r, enabled: true }))
    // upsert evita erro 23505 se algumas regras já existirem (idempotente)
    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .upsert(rows, { onConflict: 'organization_id,department,analyzer', ignoreDuplicates: true })
      .select()
    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[routing] org=${orgId} defaults: ${data?.length ?? 0} regras`)
    return data ?? []
  }
}
