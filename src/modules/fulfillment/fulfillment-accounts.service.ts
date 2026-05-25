import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

export type CompanyRole = 'matriz' | 'revendedora' | 'unica'

export interface FulfillmentCompany {
  id: string
  organization_id: string
  name: string
  cnpj: string | null
  role: CompanyRole
  is_default: boolean
  is_active: boolean
}

export interface FulfillmentAccount {
  id: string
  organization_id: string
  company_id: string | null
  platform: string
  external_account_id: string
  label: string | null
  is_active: boolean
  invoice_sale_pct: number | null      // % de faturamento por conta (null = usa o padrão da empresa)
  invoice_purchase_pct: number | null
}

/** Timing real do envio na plataforma (ML lead_time). Tudo opcional/best-effort. */
export interface PlatformTiming {
  shipmentId: string | null
  logisticType: string | null
  handlingDeadline: string | null   // prazo de despacho/postagem
  deliveryDeadline: string | null   // prazo de entrega ao cliente
  scheduledFrom: string | null      // janela de coleta (Flex)
  scheduledTo: string | null
}

/**
 * F12 Onda A — empresas (CNPJ) + contas de canal + timing real das plataformas.
 *
 * Toda venda do CD pertence a UMA conta (ex.: conta ML "VAZZO_") que pertence a
 * UMA empresa (CNPJ). Isso organiza a fila por empresa/conta/plataforma e é a
 * base do faturador dropship triangular (futuro). O cadastro é AUTOMÁTICO: quando
 * chega pedido de uma conta nova, ela é criada sozinha e ligada a uma empresa
 * "padrão" — o operador depois ajusta CNPJ/papel nas Configurações.
 */
@Injectable()
export class FulfillmentAccountsService {
  private readonly logger = new Logger(FulfillmentAccountsService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  // ── Empresas (CNPJ) ───────────────────────────────────────────────────────
  async listCompanies(orgId: string): Promise<FulfillmentCompany[]> {
    const { data } = await supabaseAdmin
      .from('fulfillment_companies').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: true })
    return (data ?? []) as FulfillmentCompany[]
  }

  async createCompany(orgId: string, input: { name: string; cnpj?: string | null; role?: CompanyRole }): Promise<{ ok: true; id: string }> {
    const name = (input.name ?? '').trim()
    if (!name) throw new BadRequestException('Informe o nome da empresa.')
    const cnpj = normalizeCnpj(input.cnpj)
    const { data, error } = await supabaseAdmin
      .from('fulfillment_companies')
      .insert({ organization_id: orgId, name, cnpj, role: input.role ?? 'unica' })
      .select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar empresa: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }

  async updateCompany(orgId: string, id: string, patch: { name?: string; cnpj?: string | null; role?: CompanyRole; is_active?: boolean }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (patch.name !== undefined) row.name = String(patch.name).trim()
    if (patch.cnpj !== undefined) row.cnpj = normalizeCnpj(patch.cnpj)
    if (patch.role !== undefined) row.role = patch.role
    if (patch.is_active !== undefined) row.is_active = patch.is_active
    if (Object.keys(row).length > 0) {
      const { error } = await supabaseAdmin.from('fulfillment_companies').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar empresa: ${error.message}`)
    }
    return { ok: true }
  }

  /** Garante 1 empresa "padrão" na org (cria se não houver). Devolve o id. */
  async ensureDefaultCompany(orgId: string): Promise<string> {
    const { data: def } = await supabaseAdmin
      .from('fulfillment_companies').select('id')
      .eq('organization_id', orgId).eq('is_default', true).maybeSingle()
    if (def) return (def as { id: string }).id
    const { data: any } = await supabaseAdmin
      .from('fulfillment_companies').select('id')
      .eq('organization_id', orgId).order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (any) return (any as { id: string }).id
    const { data: created, error } = await supabaseAdmin
      .from('fulfillment_companies')
      .insert({ organization_id: orgId, name: 'Minha empresa', role: 'unica', is_default: true })
      .select('id').maybeSingle()
    if (error || !created) throw new BadRequestException(`Erro ao criar empresa padrão: ${error?.message ?? '?'}`)
    return (created as { id: string }).id
  }

  // ── Contas de canal ───────────────────────────────────────────────────────
  async listAccounts(orgId: string): Promise<FulfillmentAccount[]> {
    const { data } = await supabaseAdmin
      .from('fulfillment_accounts').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: true })
    return (data ?? []) as FulfillmentAccount[]
  }

  async updateAccount(orgId: string, id: string, patch: { company_id?: string | null; label?: string; is_active?: boolean; invoice_sale_pct?: number | null; invoice_purchase_pct?: number | null }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (patch.company_id !== undefined) row.company_id = patch.company_id
    if (patch.label !== undefined) row.label = patch.label
    if (patch.is_active !== undefined) row.is_active = patch.is_active
    if (patch.invoice_sale_pct !== undefined) row.invoice_sale_pct = patch.invoice_sale_pct === null ? null : clampPct(patch.invoice_sale_pct)
    if (patch.invoice_purchase_pct !== undefined) row.invoice_purchase_pct = patch.invoice_purchase_pct === null ? null : clampPct(patch.invoice_purchase_pct)
    if (Object.keys(row).length > 0) {
      const { error } = await supabaseAdmin.from('fulfillment_accounts').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar conta: ${error.message}`)
    }
    return { ok: true }
  }

  /** Acha ou cria a conta de canal e devolve {accountId, companyId}. Auto-cadastro:
   *  conta nova é ligada à empresa padrão (o user reatribui depois). Best-effort —
   *  se algo falhar, devolve nulls (não trava a ingestão do pedido). */
  async resolveAccount(orgId: string, input: { platform: string; externalAccountId: string | null; label?: string | null }): Promise<{ accountId: string | null; companyId: string | null }> {
    try {
      const platform = (input.platform || 'desconhecido').toLowerCase()
      const key = (input.externalAccountId && String(input.externalAccountId).trim()) || platform // b2b/loja sem conta → usa a própria plataforma
      const { data: found } = await supabaseAdmin
        .from('fulfillment_accounts').select('id, company_id')
        .eq('organization_id', orgId).eq('platform', platform).eq('external_account_id', key).maybeSingle()
      if (found) {
        const f = found as { id: string; company_id: string | null }
        if (f.company_id) return { accountId: f.id, companyId: f.company_id }
        // conta órfã (empresa foi removida → company_id null) → religa à empresa padrão
        const defId = await this.ensureDefaultCompany(orgId)
        await supabaseAdmin.from('fulfillment_accounts').update({ company_id: defId }).eq('id', f.id).eq('organization_id', orgId)
        return { accountId: f.id, companyId: defId }
      }
      const companyId = await this.ensureDefaultCompany(orgId)
      const { data: created, error } = await supabaseAdmin
        .from('fulfillment_accounts')
        .insert({ organization_id: orgId, company_id: companyId, platform, external_account_id: key, label: input.label ?? null })
        .select('id').maybeSingle()
      if (error || !created) {
        // corrida: outra ingestão criou ao mesmo tempo → re-seleciona
        const { data: again } = await supabaseAdmin
          .from('fulfillment_accounts').select('id, company_id')
          .eq('organization_id', orgId).eq('platform', platform).eq('external_account_id', key).maybeSingle()
        if (again) { const a = again as { id: string; company_id: string | null }; return { accountId: a.id, companyId: a.company_id } }
        return { accountId: null, companyId: null }
      }
      return { accountId: (created as { id: string }).id, companyId }
    } catch (e) {
      this.logger.warn(`[accounts] resolveAccount falhou (best-effort): ${(e as Error).message}`)
      return { accountId: null, companyId: null }
    }
  }

  /** Apelido (nickname) da conta ML pelo seller_id, pra rotular a conta. */
  async mlNicknameForSeller(orgId: string, sellerId: number | string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('ml_connections').select('nickname')
      .eq('organization_id', orgId).eq('seller_id', sellerId).maybeSingle()
    return (data as { nickname: string | null } | null)?.nickname ?? null
  }

  // ── Timing real do ML (lead_time do shipment) ───────────────────────────────
  /** Busca prazo de despacho/entrega + logistic_type do shipment do pedido ML.
   *  Best-effort: NUNCA lança — devolve null se faltar token/shipment/etc. */
  async fetchMlTiming(orgId: string, externalOrderId: string, sellerId?: number): Promise<PlatformTiming | null> {
    try {
      const { token } = await this.mercadolivre.getTokenForOrg(orgId, sellerId)
      const orderRes = await axios.get(`https://api.mercadolibre.com/orders/${externalOrderId}`, { headers: { Authorization: `Bearer ${token}` } })
      const shipmentId = orderRes.data?.shipping?.id
      if (!shipmentId) return null
      const shipRes = await axios.get(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
        headers: { Authorization: `Bearer ${token}`, 'x-format-new': 'true' },
      })
      const d = shipRes.data ?? {}
      const lt = d.lead_time ?? {}
      const pick = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
      return {
        shipmentId: String(shipmentId),
        logisticType: pick(d.logistic_type),
        handlingDeadline: pick(lt?.estimated_handling_limit?.date),
        deliveryDeadline: pick(lt?.estimated_delivery_limit?.date) ?? pick(lt?.estimated_delivery_final?.date),
        scheduledFrom: pick(lt?.pickup_promise?.from) ?? pick(lt?.estimated_schedule_limit?.date),
        scheduledTo: pick(lt?.pickup_promise?.to),
      }
    } catch (e) {
      this.logger.warn(`[accounts] fetchMlTiming ${externalOrderId} falhou (best-effort): ${(e as Error).message}`)
      return null
    }
  }
}

function normalizeCnpj(cnpj: string | null | undefined): string | null {
  if (!cnpj) return null
  const digits = String(cnpj).replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

function clampPct(v: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 100
  return Math.min(Math.max(n, 0), 100)
}
