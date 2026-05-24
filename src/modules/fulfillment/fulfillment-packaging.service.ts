import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

export type PackagingKind = 'caixa' | 'envelope' | 'sacola' | 'outro'
export interface PackagingType {
  id: string; organization_id: string; name: string; kind: PackagingKind
  width_cm: number | null; height_cm: number | null; depth_cm: number | null
  weight_g: number | null; cost_cents: number | null; stock: number | null; is_active: boolean
}
export interface PackagingKitItem { packaging_type_id: string; qty: number }
export interface PackagingKit { id: string; organization_id: string; name: string; items: PackagingKitItem[]; is_active: boolean }

/**
 * F12 Onda E — controle de embalagens: tipos (caixa/envelope/sacola) + kits
 * (combo de materiais) + registro de qual embalagem foi usada no pacote +
 * sugestão da embalagem ideal (heurística por volume/itens + rationale IA best-effort).
 */
@Injectable()
export class FulfillmentPackagingService {
  private readonly logger = new Logger(FulfillmentPackagingService.name)

  constructor(private readonly llm: LlmService) {}

  // ── Tipos ──────────────────────────────────────────────────────────────────
  async listTypes(orgId: string): Promise<PackagingType[]> {
    const { data } = await supabaseAdmin.from('packaging_types').select('*').eq('organization_id', orgId).order('created_at', { ascending: true })
    return (data ?? []) as PackagingType[]
  }
  async createType(orgId: string, input: { name: string; kind?: PackagingKind; width_cm?: number | null; height_cm?: number | null; depth_cm?: number | null; weight_g?: number | null; cost_cents?: number | null; stock?: number | null }): Promise<{ ok: true; id: string }> {
    if (!input.name?.trim()) throw new BadRequestException('Informe o nome da embalagem.')
    const { data, error } = await supabaseAdmin.from('packaging_types').insert({
      organization_id: orgId, name: input.name.trim(), kind: input.kind ?? 'caixa',
      width_cm: input.width_cm ?? null, height_cm: input.height_cm ?? null, depth_cm: input.depth_cm ?? null,
      weight_g: input.weight_g ?? null, cost_cents: input.cost_cents ?? null, stock: input.stock ?? null,
    }).select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar embalagem: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }
  async updateType(orgId: string, id: string, patch: Partial<Pick<PackagingType, 'name' | 'kind' | 'width_cm' | 'height_cm' | 'depth_cm' | 'weight_g' | 'cost_cents' | 'stock' | 'is_active'>>): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    for (const k of ['name', 'kind', 'width_cm', 'height_cm', 'depth_cm', 'weight_g', 'cost_cents', 'stock', 'is_active'] as const) if (patch[k] !== undefined) row[k] = patch[k]
    if (Object.keys(row).length > 0) {
      const { error } = await supabaseAdmin.from('packaging_types').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar embalagem: ${error.message}`)
    }
    return { ok: true }
  }
  async removeType(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('packaging_types').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover embalagem: ${error.message}`)
    return { ok: true }
  }

  // ── Kits ─────────────────────────────────────────────────────────────────
  async listKits(orgId: string): Promise<PackagingKit[]> {
    const { data } = await supabaseAdmin.from('packaging_kits').select('*').eq('organization_id', orgId).order('created_at', { ascending: true })
    return (data ?? []) as PackagingKit[]
  }
  async createKit(orgId: string, input: { name: string; items?: PackagingKitItem[] }): Promise<{ ok: true; id: string }> {
    if (!input.name?.trim()) throw new BadRequestException('Informe o nome do kit.')
    const { data, error } = await supabaseAdmin.from('packaging_kits').insert({ organization_id: orgId, name: input.name.trim(), items: input.items ?? [] }).select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar kit: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }
  async updateKit(orgId: string, id: string, patch: { name?: string; items?: PackagingKitItem[]; is_active?: boolean }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (patch.name !== undefined) row.name = patch.name
    if (patch.items !== undefined) row.items = patch.items
    if (patch.is_active !== undefined) row.is_active = patch.is_active
    if (Object.keys(row).length > 0) {
      const { error } = await supabaseAdmin.from('packaging_kits').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar kit: ${error.message}`)
    }
    return { ok: true }
  }
  async removeKit(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('packaging_kits').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover kit: ${error.message}`)
    return { ok: true }
  }

  // ── Uso no pacote ──────────────────────────────────────────────────────────
  async setPackaging(orgId: string, packTaskId: string, input: { packagingTypeId?: string | null; packagingKitId?: string | null }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (input.packagingTypeId !== undefined) row.packaging_type_id = input.packagingTypeId
    if (input.packagingKitId !== undefined) row.packaging_kit_id = input.packagingKitId
    if (Object.keys(row).length === 0) return { ok: true }
    const { error } = await supabaseAdmin.from('pack_tasks').update(row).eq('id', packTaskId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao registrar embalagem: ${error.message}`)
    return { ok: true }
  }

  // ── Sugestão de embalagem ideal ──────────────────────────────────────────
  /** Heurística: pelo nº de itens do pedido escolhe a caixa (ordenadas por volume).
   *  Rationale curto via LLM (best-effort, não bloqueia). */
  async suggest(orgId: string, fulfillmentOrderId: string): Promise<{ suggested: PackagingType | null; alternatives: PackagingType[]; rationale: string | null }> {
    const { data: tasks } = await supabaseAdmin
      .from('pick_tasks').select('expected_qty, sku, title').eq('organization_id', orgId).eq('fulfillment_order_id', fulfillmentOrderId).neq('status', 'cancelled')
    const totalQty = ((tasks ?? []) as Array<{ expected_qty: number }>).reduce((s, t) => s + (Number(t.expected_qty) || 0), 0)

    const boxes = (await this.listTypes(orgId))
      .filter((p) => p.is_active && (p.kind === 'caixa' || p.kind === 'envelope' || p.kind === 'sacola'))
      .map((p) => ({ p, vol: (Number(p.width_cm) || 0) * (Number(p.height_cm) || 0) * (Number(p.depth_cm) || 0) }))
      .sort((a, b) => a.vol - b.vol)
    if (boxes.length === 0) return { suggested: null, alternatives: [], rationale: null }

    // bucket por quantidade de itens (sem dims confiáveis dos produtos no v1)
    const idx = totalQty <= 1 ? 0 : totalQty <= 3 ? Math.min(1, boxes.length - 1) : totalQty <= 6 ? Math.min(2, boxes.length - 1) : boxes.length - 1
    const suggested = boxes[idx].p
    const alternatives = boxes.filter((b) => b.p.id !== suggested.id).map((b) => b.p).slice(0, 3)

    let rationale: string | null = null
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'fulfillment_packaging_suggest', maxTokens: 120,
        systemPrompt: 'Você sugere a embalagem ideal num CD. Em 1 frase curta em pt-BR, justifique a escolha pela quantidade de itens e tamanho. Direto, sem listar.',
        userPrompt: `Pedido com ${totalQty} item(ns). Embalagem sugerida: "${suggested.name}" (${suggested.kind}). Opções: ${boxes.map((b) => b.p.name).join(', ')}.`,
      })
      rationale = out.text?.trim() || null
    } catch (e) { this.logger.warn(`[packaging] rationale LLM falhou: ${(e as Error).message}`) }

    return { suggested, alternatives, rationale }
  }
}
