import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionService } from './production.service'

/**
 * Product OS — T1-B: Make-to-order.
 *
 * Produto de impressão 3D (product_dev.product_id setado) configurado com
 * reposição automática: quando o estoque físico (product_stock, platform=null)
 * cai a/below o ponto de reposição, o sistema SUGERE (modo 'suggest', seguro) ou
 * CRIA (modo 'auto') uma ordem de produção. Fecha o loop "vendi → produzi → repus".
 *
 * O gatilho é a reconciliação (cron 15min) varrendo o NOSSO estoque — não é
 * polling de marketplace. Dedup: nunca empilha sugestão/OP enquanto já houver uma
 * sugestão pendente OU uma OP ativa do mesmo produto.
 */

/** Estados de OP que ainda vão repor estoque (não concluída nem cancelada). */
const ACTIVE_ORDER_STATES = ['fila', 'imprimindo', 'pausado', 'falhou', 'reimpressao', 'acabamento', 'qualidade', 'embalado']

export interface MtoConfig {
  mto_enabled: boolean
  mto_mode: 'suggest' | 'auto'
  mto_reorder_point: number
  mto_batch_qty: number
}

interface DevRow {
  id: string
  organization_id: string
  name: string
  product_id: string | null
  status: string
  mto_enabled: boolean
  mto_mode: string
  mto_reorder_point: number
  mto_batch_qty: number
}

@Injectable()
export class MakeToOrderService {
  private readonly logger = new Logger(MakeToOrderService.name)

  constructor(private readonly production: ProductionService) {}

  // ── leitura de estoque físico (product_stock, platform=null) ──────
  private async availableFor(productId: string): Promise<number> {
    const { data } = await supabaseAdmin.from('product_stock')
      .select('quantity, reserved_quantity').eq('product_id', productId).is('platform', null).maybeSingle()
    if (!data) return 0
    const r = data as { quantity: number | null; reserved_quantity: number | null }
    return Math.max(0, Number(r.quantity ?? 0) - Number(r.reserved_quantity ?? 0))
  }

  /** Há OP ativa (vai repor) deste produto? Então não sugere de novo. */
  private async hasActiveOrder(orgId: string, devId: string): Promise<boolean> {
    const { count } = await supabaseAdmin.from('production_order')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('product_dev_id', devId).is('part_id', null)
      .in('status', ACTIVE_ORDER_STATES)
    return (count ?? 0) > 0
  }

  /** Sugestão pendente já aberta deste produto? (o índice único também trava no insert) */
  private async hasPendingSuggestion(orgId: string, devId: string): Promise<{ id: string } | null> {
    const { data } = await supabaseAdmin.from('production_suggestion')
      .select('id').eq('organization_id', orgId).eq('product_dev_id', devId).eq('status', 'pending').maybeSingle()
    return (data as { id: string } | null) ?? null
  }

  /**
   * Avalia UM produto já carregado. Decide sugerir/criar/superseder.
   * Retorna o que aconteceu (p/ o digest e o retorno do reconcile).
   */
  private async evaluateDev(dev: DevRow, source: 'reconcile' | 'manual'):
    Promise<{ kind: 'suggested' | 'auto_created' | 'superseded' | 'skipped'; suggestion_id?: string; production_order_id?: string; available: number; name: string } | null> {
    if (!dev.mto_enabled || !dev.product_id) return null
    if (dev.status === 'arquivado') return null
    const reorder = Math.max(0, Number(dev.mto_reorder_point) || 0)
    const batch = Math.max(1, Number(dev.mto_batch_qty) || 0)
    const available = await this.availableFor(dev.product_id)

    const pending = await this.hasPendingSuggestion(dev.organization_id, dev.id)

    // estoque recuperou acima do ponto → fecha sugestão pendente como superada
    if (available > reorder) {
      if (pending) {
        await supabaseAdmin.from('production_suggestion')
          .update({ status: 'superseded', resolved_at: new Date().toISOString() }).eq('id', pending.id)
        return { kind: 'superseded', suggestion_id: pending.id, available, name: dev.name }
      }
      return null
    }

    // abaixo do ponto: só age se não houver nada em andamento
    if (pending) return { kind: 'skipped', available, name: dev.name }
    if (await this.hasActiveOrder(dev.organization_id, dev.id)) return { kind: 'skipped', available, name: dev.name }

    const mode = dev.mto_mode === 'auto' ? 'auto' : 'suggest'
    const reason = `Estoque ${available} ≤ ponto de reposição ${reorder} — repor ${batch} un.`

    if (mode === 'auto') {
      // cria a OP direto e registra a trilha (auto_created)
      let orderId: string | null = null
      try {
        const order = await this.production.createOrder(dev.organization_id, null, { product_dev_id: dev.id, quantity: batch })
        orderId = (order as { id: string }).id
      } catch (e) {
        this.logger.warn(`[mto] auto-create falhou ${dev.id.slice(0, 8)}: ${(e as Error).message}`)
        // cai pra sugestão pendente p/ não perder o gatilho
      }
      const { data } = await supabaseAdmin.from('production_suggestion').insert({
        organization_id: dev.organization_id, product_dev_id: dev.id, product_id: dev.product_id,
        reason, available_at_trigger: available, reorder_point: reorder, suggested_qty: batch,
        mode, status: orderId ? 'auto_created' : 'pending', source,
        production_order_id: orderId, resolved_at: orderId ? new Date().toISOString() : null,
      }).select('id').maybeSingle()
      return { kind: orderId ? 'auto_created' : 'suggested', suggestion_id: (data as { id: string } | null)?.id, production_order_id: orderId ?? undefined, available, name: dev.name }
    }

    // modo sugerir: enfileira pendente p/ o usuário revisar
    const { data } = await supabaseAdmin.from('production_suggestion').insert({
      organization_id: dev.organization_id, product_dev_id: dev.id, product_id: dev.product_id,
      reason, available_at_trigger: available, reorder_point: reorder, suggested_qty: batch,
      mode, status: 'pending', source,
    }).select('id').maybeSingle()
    return { kind: 'suggested', suggestion_id: (data as { id: string } | null)?.id, available, name: dev.name }
  }

  /** Reconcilia TODOS os produtos com reposição ligada de uma org. */
  async reconcile(orgId: string, source: 'reconcile' | 'manual' = 'reconcile') {
    const { data, error } = await supabaseAdmin.from('product_dev')
      .select('id, organization_id, name, product_id, status, mto_enabled, mto_mode, mto_reorder_point, mto_batch_qty')
      .eq('organization_id', orgId).eq('mto_enabled', true)
    if (error) throw new BadRequestException(`Erro ao reconciliar: ${error.message}`)
    const devs = (data ?? []) as DevRow[]
    const suggested: Array<{ name: string; available: number; qty: number; suggestion_id?: string }> = []
    const auto_created: Array<{ name: string; available: number; qty: number; production_order_id?: string }> = []
    for (const dev of devs) {
      try {
        const r = await this.evaluateDev(dev, source)
        if (!r) continue
        if (r.kind === 'suggested') suggested.push({ name: r.name, available: r.available, qty: Math.max(1, Number(dev.mto_batch_qty) || 1), suggestion_id: r.suggestion_id })
        else if (r.kind === 'auto_created') auto_created.push({ name: r.name, available: r.available, qty: Math.max(1, Number(dev.mto_batch_qty) || 1), production_order_id: r.production_order_id })
      } catch (e) {
        this.logger.warn(`[mto] reconcile ${dev.id.slice(0, 8)}: ${(e as Error).message}`)
      }
    }
    return { evaluated: devs.length, suggested, auto_created }
  }

  /** Orgs distintas com reposição ligada (p/ o cron). */
  async orgsWithMto(): Promise<string[]> {
    const { data } = await supabaseAdmin.from('product_dev').select('organization_id').eq('mto_enabled', true)
    return [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
  }

  // ── API da tela ───────────────────────────────────────────────────
  async listSuggestions(orgId: string, status = 'pending') {
    let q = supabaseAdmin.from('production_suggestion')
      .select('*, product_dev:product_dev_id(name, code)')
      .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100)
    if (status && status !== 'all') q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(row => {
      const r = row as Record<string, unknown> & { product_dev?: { name?: string; code?: string } | Array<{ name?: string; code?: string }> }
      const dev = Array.isArray(r.product_dev) ? r.product_dev[0] : r.product_dev
      return { ...r, product_name: dev?.name ?? null, product_code: dev?.code ?? null }
    })
  }

  /** Aceita a sugestão → cria a OP e marca como aceita. */
  async acceptSuggestion(orgId: string, id: string, userId: string | null, opts?: { quantity?: number; printer_id?: string }) {
    const { data } = await supabaseAdmin.from('production_suggestion').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle()
    const sug = data as { id: string; product_dev_id: string; suggested_qty: number; status: string } | null
    if (!sug) throw new BadRequestException('Sugestão não encontrada')
    if (sug.status !== 'pending') throw new BadRequestException(`Sugestão já resolvida (${sug.status})`)
    const qty = Math.max(1, Math.floor(Number(opts?.quantity) || sug.suggested_qty || 1))
    const order = await this.production.createOrder(orgId, userId, { product_dev_id: sug.product_dev_id, quantity: qty, printer_id: opts?.printer_id })
    const orderId = (order as { id: string }).id
    await supabaseAdmin.from('production_suggestion').update({
      status: 'accepted', production_order_id: orderId, resolved_at: new Date().toISOString(), resolved_by: userId,
    }).eq('id', id)
    return { ok: true, production_order_id: orderId, order }
  }

  async dismissSuggestion(orgId: string, id: string, userId: string | null) {
    const { error } = await supabaseAdmin.from('production_suggestion').update({
      status: 'dismissed', resolved_at: new Date().toISOString(), resolved_by: userId,
    }).eq('id', id).eq('organization_id', orgId).eq('status', 'pending')
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Lê/grava a config de reposição de um produto. */
  async setConfig(orgId: string, devId: string, patch: Partial<MtoConfig>) {
    const safe: Record<string, unknown> = {}
    if ('mto_enabled' in patch) safe.mto_enabled = !!patch.mto_enabled
    if ('mto_mode' in patch) safe.mto_mode = patch.mto_mode === 'auto' ? 'auto' : 'suggest'
    if ('mto_reorder_point' in patch) safe.mto_reorder_point = Math.max(0, Math.floor(Number(patch.mto_reorder_point) || 0))
    if ('mto_batch_qty' in patch) safe.mto_batch_qty = Math.max(0, Math.floor(Number(patch.mto_batch_qty) || 0))
    if (!Object.keys(safe).length) throw new BadRequestException('Nada a atualizar')
    const { data, error } = await supabaseAdmin.from('product_dev').update(safe)
      .eq('id', devId).eq('organization_id', orgId)
      .select('id, mto_enabled, mto_mode, mto_reorder_point, mto_batch_qty').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar config: ${error?.message ?? 'sem dados'}`)
    return data
  }
}
