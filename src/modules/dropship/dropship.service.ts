import { Injectable, HttpException, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { randomBytes } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { EmailSenderService } from '../messaging/email-sender.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { FinanceiroService } from '../financeiro/financeiro.service'
import { LlmService } from '../ai/llm.service'
import { BaileysProvider } from '../channels/providers/baileys.provider'
// pdfkit é CommonJS e exporta o construtor direto (module.exports = PDFDocument).
// Sem esModuleInterop no tsconfig, `import X from 'pdfkit'` compila pra
// `pdfkit_1.default` (undefined) → "is not a constructor" em runtime.
// import=require pega o export real.
import PDFDocument = require('pdfkit')

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreateDropshipPartnerDto {
  // Dados do supplier
  name: string
  legal_name?: string | null
  cnpj?: string | null
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  contact_whatsapp?: string | null
  payment_terms?: string | null    // ex: '15', '30', '45'
  payment_method?: string | null   // ex: 'pix', 'boleto'

  // Dados do profile dropship
  notification_email: string       // obrigatório
  notification_whatsapp?: string | null
  operations_contact?: string | null
  operations_phone?: string | null
  warehouse_address?: Record<string, unknown> | null

  integration_type?:
    | 'manual' | 'spreadsheet' | 'api' | 'csv_email'
    | 'sftp' | 'erp_bling' | 'erp_tiny' | 'erp_omie'
  integration_config?: Record<string, unknown>

  // Janela operacional (HH:MM:SS)
  cutoff_time?: string
  ship_lead_days?: number
  oc_generation_time?: string
  oc_preview_open_time?: string
  oc_review_cutoff_time?: string

  // Estratégia comercial
  cost_strategy?: 'current_table' | 'at_sale_date' | 'at_ship_date' | 'fixed_per_period' | 'per_campaign'
  return_credit_strategy?: 'same_oc' | 'next_oc' | 'separate_invoice'
  cost_divergence_tolerance_pct?: number
  stock_divergence_tolerance_units?: number
  marketplaces_supported?: string[]

  notes?: string | null
}

export interface UpdateDropshipPartnerDto extends Partial<CreateDropshipPartnerDto> {
  dropship_status?: 'active' | 'paused' | 'inactive' | 'pending_setup'
  paused_reason?: string | null
}

export interface CreateAccountSupplierDto {
  supplier_id: string
  marketplace: 'mercado_livre' | 'shopee' | 'amazon' | 'magalu' | 'tiktok_shop' | 'storefront' | 'others'
  seller_id?: number | null         // ML
  shopee_shop_id?: string | null
  amazon_seller_id?: string | null
  account_label?: string | null
  is_default?: boolean
  notes?: string | null
}

export interface UpdateAccountSupplierDto extends Partial<Omit<CreateAccountSupplierDto, 'supplier_id'>> {
  active_until?: string | null
}

export interface CreatePartnerProductDto {
  supplier_id: string
  product_id: string         // produto já existente no catálogo do seller
  supplier_sku: string       // SKU no parceiro
  master_sku?: string | null // identidade independente do parceiro
  unit_cost: number
  partner_packaging_cost?: number
  partner_handling_cost?: number
  partner_stock?: number
  partner_reserved?: number
  lead_time_days?: number | null
  safety_days?: number | null
  moq?: number | null
  is_preferred?: boolean
  notes?: string | null
  dropship_status?: 'active' | 'paused' | 'unavailable' | 'discontinued' | 'pending_validation'
}

export interface UpdatePartnerProductDto extends Partial<Omit<CreatePartnerProductDto, 'supplier_id' | 'product_id'>> {
  change_reason?: string  // se mudar custo, registra no history
}

export interface BulkImportRow {
  supplier_sku: string
  master_sku?: string | null
  product_sku?: string | null    // SKU no catálogo do seller (pra match)
  product_id?: string | null     // se já souber o UUID
  product_name?: string | null   // informativo
  unit_cost: number
  packaging_cost?: number
  handling_cost?: number
  stock?: number
  lead_time_days?: number | null
  moq?: number | null
}

export interface BulkImportDto {
  supplier_id: string
  source_file_name?: string | null
  rows: BulkImportRow[]
}

export interface BulkImportResult {
  sync_log_id: string
  processed: number
  created: number
  updated: number
  failed: number
  cost_changes: number
  validation_errors: Array<{ row: number; supplier_sku: string; error: string }>
}

export type ReturnType =
  | 'cancellation' | 'return_buyer_regret' | 'return_defective'
  | 'return_wrong_item' | 'return_damaged' | 'return_not_delivered'
  | 'return_incomplete' | 'warranty_claim' | 'reclamation_refund'
  | 'chargeback' | 'partner_negotiated'

export type Responsibility = 'partner' | 'seller' | 'shared' | 'buyer' | 'undefined'

export interface CreateReturnDto {
  supplier_id: string
  identification_id?: string | null
  marketplace: string
  return_type: ReturnType
  return_amount: number
  return_quantity: number
  responsibility?: Responsibility
  ml_pack_id?: string | null
  ml_order_id?: string | null
  shopee_order_id?: string | null
  buyer_complaint?: string | null
  internal_notes?: string | null
  evidence_urls?: string[]
  source?: 'manual' | 'sac_module' | 'partner_request'
  external_id?: string | null
}

export interface UpdateReturnDto {
  status?: 'opened' | 'in_transit_back' | 'received' | 'analyzed' | 'closed'
  responsibility?: Responsibility
  internal_notes?: string | null
  partner_response?: string | null
  resolution_notes?: string | null
  evidence_urls?: string[]
  marketplace_return_status?: string | null
  marketplace_refund_amount?: number | null
}

export interface ApproveReturnDto {
  responsibility?: Responsibility
  resolution_notes?: string | null
}

export type CreditScenario =
  | 'same_oc_unpaid'
  | 'same_oc_approved_unpaid'
  | 'next_oc_credit'
  | 'pending_dispute'

export type DisputeType =
  | 'cost_divergence' | 'responsibility' | 'amount'
  | 'product_returned' | 'item_inclusion' | 'other'

export type DisputeStatus =
  | 'open' | 'in_review' | 'mediation'
  | 'resolved_partner' | 'resolved_seller' | 'resolved_compromise'
  | 'escalated' | 'closed'

export interface CreateDisputeDto {
  supplier_id: string
  return_id?: string | null
  oc_item_id?: string | null
  oc_id?: string | null
  dispute_type: DisputeType
  claimed_by: 'seller' | 'partner'
  claimed_by_name?: string | null
  reason: string
  description?: string | null
  amount_claimed?: number | null
  amount_partner_accepts?: number | null
  amount_seller_proposes?: number | null
  evidence_urls?: string[]
}

export interface UpdateDisputeDto {
  status?: 'open' | 'in_review' | 'mediation' | 'escalated'
  description?: string | null
  amount_partner_accepts?: number | null
  amount_seller_proposes?: number | null
  evidence_urls?: string[]
}

export interface ResolveDisputeDto {
  resolution_type: 'resolved_partner' | 'resolved_seller' | 'resolved_compromise'
  final_resolved_amount?: number | null
  resolution: string
}

// ── Service ──────────────────────────────────────────────────────────────────

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
const PORTAL_TTL_HOURS = 72

@Injectable()
export class DropshipService {
  private readonly logger = new Logger('DropshipService')

  constructor(
    private readonly emailSender: EmailSenderService,
    private readonly waSender: WhatsAppSender,
    private readonly financeiro: FinanceiroService,
    private readonly llm: LlmService,
    private readonly baileys: BaileysProvider,
  ) {
    if (!process.env.FRONTEND_URL) {
      this.logger.warn(
        `[config] FRONTEND_URL não definida — usando fallback ${FRONTEND_URL}. ` +
        `Configure no Railway env se for diferente (afeta links do portal do parceiro).`,
      )
    }
  }

  // ── Partners (supplier + dropship_profile) ─────────────────────────────────

  async listPartners(orgId: string, filters: { status?: string; q?: string }) {
    let query = supabaseAdmin
      .from('supplier_dropship_profiles')
      .select(`
        id, supplier_id, dropship_status, integration_type,
        cutoff_time, ship_lead_days,
        notification_email, notification_whatsapp,
        oc_generation_time, oc_preview_open_time, oc_review_cutoff_time,
        cost_strategy, return_credit_strategy,
        active_dropship_skus, orders_30d, revenue_30d, cmv_30d, pending_payable,
        partner_score, score_breakdown,
        created_at, updated_at,
        suppliers!inner(
          id, name, legal_name, tax_id,
          contact_name, contact_email, contact_phone, contact_whatsapp,
          payment_terms, payment_method,
          is_active
        )
      `)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (filters.status) query = query.eq('dropship_status', filters.status)
    if (filters.q) query = query.ilike('suppliers.name', `%${filters.q}%`)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getPartner(orgId: string, profileId: string) {
    const { data, error } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select(`*, suppliers(*)`)
      .eq('organization_id', orgId)
      .eq('id', profileId)
      .maybeSingle()

    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Parceiro dropship não encontrado')
    return data
  }

  async createPartner(orgId: string, dto: CreateDropshipPartnerDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome do parceiro é obrigatório')
    }
    if (!dto.notification_email?.trim()) {
      throw new BadRequestException('E-mail de notificação é obrigatório')
    }

    // 1. Cria supplier (cadastro genérico — também usado em importação)
    const { data: supplier, error: supErr } = await supabaseAdmin
      .from('suppliers')
      .insert({
        organization_id: orgId,
        name: dto.name.trim(),
        legal_name: dto.legal_name ?? null,
        tax_id: dto.cnpj ?? null,
        contact_name: dto.contact_name ?? null,
        contact_email: dto.contact_email ?? null,
        contact_phone: dto.contact_phone ?? null,
        contact_whatsapp: dto.contact_whatsapp ?? null,
        payment_terms: dto.payment_terms ?? '15',
        payment_method: dto.payment_method ?? 'pix',
        supplier_type: 'nacional',  // dropship é sempre nacional na v1
        country: 'Brasil',
        currency: 'BRL',
        is_active: true,
      })
      .select()
      .single()

    if (supErr || !supplier) {
      throw new HttpException(supErr?.message ?? 'Erro ao criar fornecedor', 500)
    }

    // 2. Cria profile dropship — rollback do supplier se falhar
    const { data: profile, error: profErr } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .insert({
        organization_id: orgId,
        supplier_id: supplier.id,
        notification_email: dto.notification_email.trim(),
        notification_whatsapp: dto.notification_whatsapp ?? null,
        operations_contact: dto.operations_contact ?? null,
        operations_phone: dto.operations_phone ?? null,
        warehouse_address: dto.warehouse_address ?? null,
        integration_type: dto.integration_type ?? 'manual',
        integration_config: dto.integration_config ?? {},
        cutoff_time: dto.cutoff_time ?? '14:00',
        ship_lead_days: dto.ship_lead_days ?? 1,
        oc_generation_time: dto.oc_generation_time ?? '22:00',
        oc_preview_open_time: dto.oc_preview_open_time ?? '12:00',
        oc_review_cutoff_time: dto.oc_review_cutoff_time ?? '21:00',
        cost_strategy: dto.cost_strategy ?? 'current_table',
        return_credit_strategy: dto.return_credit_strategy ?? 'next_oc',
        cost_divergence_tolerance_pct: dto.cost_divergence_tolerance_pct ?? 5,
        stock_divergence_tolerance_units: dto.stock_divergence_tolerance_units ?? 2,
        marketplaces_supported: dto.marketplaces_supported ?? [],
        dropship_status: 'active',
        notes: dto.notes ?? null,
      })
      .select()
      .single()

    if (profErr || !profile) {
      // Rollback manual: supabase-js v2 não tem transação client-side
      await supabaseAdmin.from('suppliers').delete().eq('id', supplier.id)
      throw new HttpException(profErr?.message ?? 'Erro ao criar perfil dropship (supplier revertido)', 500)
    }

    return { supplier, profile }
  }

  async updatePartner(orgId: string, profileId: string, dto: UpdateDropshipPartnerDto) {
    const profile = await this.getPartner(orgId, profileId)
    const supplierId = (profile as { supplier_id: string }).supplier_id

    // Campos do supplier
    const supplierUpdate: Record<string, unknown> = {}
    if (dto.name !== undefined) supplierUpdate.name = dto.name
    if (dto.legal_name !== undefined) supplierUpdate.legal_name = dto.legal_name
    if (dto.cnpj !== undefined) supplierUpdate.tax_id = dto.cnpj
    if (dto.contact_name !== undefined) supplierUpdate.contact_name = dto.contact_name
    if (dto.contact_email !== undefined) supplierUpdate.contact_email = dto.contact_email
    if (dto.contact_phone !== undefined) supplierUpdate.contact_phone = dto.contact_phone
    if (dto.contact_whatsapp !== undefined) supplierUpdate.contact_whatsapp = dto.contact_whatsapp
    if (dto.payment_terms !== undefined) supplierUpdate.payment_terms = dto.payment_terms
    if (dto.payment_method !== undefined) supplierUpdate.payment_method = dto.payment_method

    if (Object.keys(supplierUpdate).length > 0) {
      supplierUpdate.updated_at = new Date().toISOString()
      const { error } = await supabaseAdmin
        .from('suppliers')
        .update(supplierUpdate)
        .eq('id', supplierId)
        .eq('organization_id', orgId)
      if (error) throw new HttpException(error.message, 500)
    }

    // Campos do profile dropship
    const profileKeys = [
      'notification_email', 'notification_whatsapp', 'operations_contact', 'operations_phone',
      'warehouse_address',
      'integration_type', 'integration_config',
      'cutoff_time', 'ship_lead_days',
      'oc_generation_time', 'oc_preview_open_time', 'oc_review_cutoff_time',
      'cost_strategy', 'return_credit_strategy',
      'cost_divergence_tolerance_pct', 'stock_divergence_tolerance_units',
      'marketplaces_supported',
      'dropship_status', 'paused_reason', 'notes',
    ] as const

    const profileUpdate: Record<string, unknown> = {}
    const dtoRec = dto as Record<string, unknown>
    for (const k of profileKeys) {
      if (dtoRec[k] !== undefined) profileUpdate[k] = dtoRec[k]
    }

    if (Object.keys(profileUpdate).length > 0) {
      profileUpdate.updated_at = new Date().toISOString()
      const { error } = await supabaseAdmin
        .from('supplier_dropship_profiles')
        .update(profileUpdate)
        .eq('id', profileId)
        .eq('organization_id', orgId)
      if (error) throw new HttpException(error.message, 500)
    }

    return this.getPartner(orgId, profileId)
  }

  async archivePartner(orgId: string, profileId: string) {
    const { error } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .update({ dropship_status: 'inactive', updated_at: new Date().toISOString() })
      .eq('id', profileId)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Account-Supplier mapping ──────────────────────────────────────────────

  /** Lista contas de marketplace JÁ CONECTADAS na plataforma (via OAuth)
   *  pra UI de "Novo Vínculo" oferecer dropdown em vez de input livre.
   *  - mercado_livre → ml_connections (canônica)
   *  - shopee/amazon/magalu/others → marketplace_connections (status=active) */
  async listConnectedAccounts(orgId: string, marketplace: string): Promise<{
    marketplace: string
    accounts: Array<{
      id_field: 'seller_id' | 'shopee_shop_id' | 'amazon_seller_id'
      id_value: string
      nickname: string | null
      already_linked: boolean
    }>
  }> {
    if (!marketplace) throw new BadRequestException('marketplace obrigatório')

    type Acc = {
      id_field: 'seller_id' | 'shopee_shop_id' | 'amazon_seller_id'
      id_value: string
      nickname: string | null
    }
    let raw: Acc[] = []

    if (marketplace === 'mercado_livre') {
      const { data } = await supabaseAdmin
        .from('ml_connections')
        .select('seller_id, nickname')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
      raw = (data ?? []).map(r => ({
        id_field: 'seller_id' as const,
        id_value: String(r.seller_id),
        nickname: r.nickname ?? null,
      }))
    } else if (['shopee', 'amazon', 'magalu', 'others'].includes(marketplace)) {
      const platformMap: Record<string, string> = {
        shopee: 'shopee', amazon: 'amazon', magalu: 'magalu', others: 'others',
      }
      const { data } = await supabaseAdmin
        .from('marketplace_connections')
        .select('platform, seller_id, shop_id, external_id, nickname, status')
        .eq('organization_id', orgId)
        .eq('platform', platformMap[marketplace])
        // OAuth grava status 'connected'; aceitamos 'active' tb por retrocompat.
        // Sem isso a conta Shopee/Amazon conectada não aparecia no vínculo.
        .in('status', ['connected', 'active'])
        .order('created_at', { ascending: false })
      raw = (data ?? []).map(r => {
        if (marketplace === 'shopee') {
          return {
            id_field: 'shopee_shop_id' as const,
            id_value: String(r.shop_id ?? r.external_id ?? r.seller_id ?? ''),
            nickname: r.nickname ?? null,
          }
        }
        if (marketplace === 'amazon') {
          return {
            id_field: 'amazon_seller_id' as const,
            id_value: String(r.seller_id ?? r.external_id ?? ''),
            nickname: r.nickname ?? null,
          }
        }
        // magalu/others: usa seller_id como fallback
        return {
          id_field: 'seller_id' as const,
          id_value: String(r.seller_id ?? r.external_id ?? ''),
          nickname: r.nickname ?? null,
        }
      }).filter(a => a.id_value)
    }

    // Marca as que já têm vínculo ativo (pra UX)
    const { data: existing } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('seller_id, shopee_shop_id, amazon_seller_id')
      .eq('organization_id', orgId)
      .eq('marketplace', marketplace)
      .is('active_until', null)
    const linkedSet = new Set<string>()
    for (const e of (existing ?? [])) {
      const key = e.seller_id != null ? `seller_id:${e.seller_id}`
        : e.shopee_shop_id ? `shopee_shop_id:${e.shopee_shop_id}`
        : e.amazon_seller_id ? `amazon_seller_id:${e.amazon_seller_id}`
        : null
      if (key) linkedSet.add(key)
    }

    return {
      marketplace,
      accounts: raw.map(a => ({
        ...a,
        already_linked: linkedSet.has(`${a.id_field}:${a.id_value}`),
      })),
    }
  }

  async listAccountSuppliers(orgId: string, filters: { supplier_id?: string; marketplace?: string }) {
    let query = supabaseAdmin
      .from('seller_account_suppliers')
      .select(`
        id, marketplace, seller_id, shopee_shop_id, amazon_seller_id,
        account_label, is_default, active_since, active_until, notes,
        created_at, updated_at,
        suppliers!inner(id, name)
      `)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.marketplace) query = query.eq('marketplace', filters.marketplace)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async createAccountSupplier(orgId: string, dto: CreateAccountSupplierDto) {
    // Valida que supplier existe e pertence à org
    const { data: supplier } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('id', dto.supplier_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!supplier) throw new NotFoundException('Fornecedor não encontrado')

    // Canais com granularidade de conta (OAuth multi-conta) exigem o ID da
    // conta. Canais de loja única (TikTok Shop, loja própria, Magalu, Outros)
    // podem ser vinculados como "conta-única": sem ID, o identify resolve o
    // fornecedor pelo único parceiro ativo do canal.
    const CONTA_UNICA = ['tiktok_shop', 'storefront', 'magalu', 'others']
    if (
      !dto.seller_id && !dto.shopee_shop_id && !dto.amazon_seller_id &&
      !CONTA_UNICA.includes(dto.marketplace)
    ) {
      throw new BadRequestException(
        'Informe pelo menos um ID da conta no marketplace (seller_id, shopee_shop_id ou amazon_seller_id)',
      )
    }

    const { data, error } = await supabaseAdmin
      .from('seller_account_suppliers')
      .insert({
        organization_id: orgId,
        supplier_id: dto.supplier_id,
        marketplace: dto.marketplace,
        seller_id: dto.seller_id ?? null,
        shopee_shop_id: dto.shopee_shop_id ?? null,
        amazon_seller_id: dto.amazon_seller_id ?? null,
        account_label: dto.account_label ?? null,
        is_default: dto.is_default ?? true,
        notes: dto.notes ?? null,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async updateAccountSupplier(orgId: string, id: string, dto: UpdateAccountSupplierDto) {
    const { data, error } = await supabaseAdmin
      .from('seller_account_suppliers')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Vínculo não encontrado')
    return data
  }

  async unlinkAccountSupplier(orgId: string, id: string) {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabaseAdmin
      .from('seller_account_suppliers')
      .update({ active_until: today, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Partner Products (catálogo dropship) ──────────────────────────────────

  async listPartnerProducts(orgId: string, filters: {
    supplier_id?: string; status?: string; q?: string; master_sku?: string
  }) {
    let query = supabaseAdmin
      .from('supplier_products')
      .select(`
        id, supplier_id, product_id, supplier_sku, master_sku,
        unit_cost, currency,
        partner_stock, partner_reserved, partner_available,
        partner_packaging_cost, partner_handling_cost,
        lead_time_days, safety_days, moq, is_preferred,
        dropship_status,
        last_sync_at, last_cost_change_at, last_stock_change_at,
        notes, created_at, updated_at,
        suppliers!inner(id, name, organization_id),
        products(id, name, sku, photo_urls, price)
      `)
      .eq('suppliers.organization_id', orgId)
      .order('created_at', { ascending: false })

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) query = query.eq('dropship_status', filters.status)
    if (filters.master_sku) query = query.eq('master_sku', filters.master_sku)
    if (filters.q) query = query.ilike('supplier_sku', `%${filters.q}%`)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getPartnerProduct(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .select(`
        *,
        suppliers!inner(id, name, organization_id),
        products(id, name, sku, photo_urls, price)
      `)
      .eq('id', id)
      .eq('suppliers.organization_id', orgId)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Produto dropship não encontrado')
    return data
  }

  async createPartnerProduct(orgId: string, dto: CreatePartnerProductDto) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id é obrigatório')
    if (!dto.product_id) throw new BadRequestException('product_id é obrigatório')
    if (!dto.supplier_sku?.trim()) throw new BadRequestException('SKU do parceiro é obrigatório')
    if (typeof dto.unit_cost !== 'number' || dto.unit_cost < 0) {
      throw new BadRequestException('Custo deve ser número >= 0')
    }

    // Valida supplier pertence à org
    const { data: sup } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('id', dto.supplier_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!sup) throw new NotFoundException('Fornecedor não encontrado')

    // Valida produto pertence à org
    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('id, sku')
      .eq('id', dto.product_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!prod) throw new NotFoundException('Produto não encontrado')

    const now = new Date().toISOString()

    // Upsert pra suportar re-link (mesmo supplier+product já existe)
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .upsert(
        {
          organization_id: orgId,
          supplier_id: dto.supplier_id,
          product_id: dto.product_id,
          supplier_sku: dto.supplier_sku.trim(),
          master_sku: dto.master_sku ?? prod.sku ?? null,
          unit_cost: dto.unit_cost,
          currency: 'BRL',
          partner_stock: dto.partner_stock ?? 0,
          partner_reserved: dto.partner_reserved ?? 0,
          partner_packaging_cost: dto.partner_packaging_cost ?? 0,
          partner_handling_cost: dto.partner_handling_cost ?? 0,
          lead_time_days: dto.lead_time_days ?? 1,
          safety_days: dto.safety_days ?? 0,
          moq: dto.moq ?? 1,
          is_preferred: dto.is_preferred ?? false,
          dropship_status: dto.dropship_status ?? 'active',
          notes: dto.notes ?? null,
          last_sync_at: now,
          last_cost_change_at: now,
          last_stock_change_at: now,
          updated_at: now,
        },
        { onConflict: 'supplier_id,product_id', ignoreDuplicates: false },
      )
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    // Registra histórico de custo (primeiro snapshot)
    await supabaseAdmin
      .from('supplier_cost_history')
      .insert({
        organization_id: orgId,
        supplier_product_id: data.id,
        cost_value: dto.unit_cost,
        cost_packaging: dto.partner_packaging_cost ?? 0,
        cost_handling: dto.partner_handling_cost ?? 0,
        cost_total: (dto.unit_cost) + (dto.partner_packaging_cost ?? 0) + (dto.partner_handling_cost ?? 0),
        effective_from: now,
        change_reason: 'Cadastro inicial',
        change_source: 'manual',
      })

    return data
  }

  async updatePartnerProduct(orgId: string, id: string, dto: UpdatePartnerProductDto) {
    const existing = await this.getPartnerProduct(orgId, id) as Record<string, unknown>
    const supplierProductId = existing.id as string

    const patch: Record<string, unknown> = {}
    const allowedFields = [
      'supplier_sku', 'master_sku', 'unit_cost',
      'partner_stock', 'partner_reserved',
      'partner_packaging_cost', 'partner_handling_cost',
      'lead_time_days', 'safety_days', 'moq', 'is_preferred',
      'dropship_status', 'notes',
    ] as const
    const dtoRec = dto as Record<string, unknown>
    for (const k of allowedFields) {
      if (dtoRec[k] !== undefined) patch[k] = dtoRec[k]
    }

    const now = new Date().toISOString()

    // Detecta mudança de custo pra logar histórico
    const oldCost = Number(existing.unit_cost ?? 0)
    const oldPack = Number(existing.partner_packaging_cost ?? 0)
    const oldHand = Number(existing.partner_handling_cost ?? 0)
    const newCost = (dto.unit_cost ?? oldCost)
    const newPack = (dto.partner_packaging_cost ?? oldPack)
    const newHand = (dto.partner_handling_cost ?? oldHand)
    const costChanged =
      Math.abs(newCost - oldCost) > 0.001 ||
      Math.abs(newPack - oldPack) > 0.001 ||
      Math.abs(newHand - oldHand) > 0.001

    if (costChanged) {
      patch.last_cost_change_at = now
      // Fecha snapshot anterior
      await supabaseAdmin
        .from('supplier_cost_history')
        .update({ effective_until: now })
        .eq('supplier_product_id', supplierProductId)
        .is('effective_until', null)
      // Cria snapshot novo
      await supabaseAdmin
        .from('supplier_cost_history')
        .insert({
          organization_id: orgId,
          supplier_product_id: supplierProductId,
          cost_value: newCost,
          cost_packaging: newPack,
          cost_handling: newHand,
          cost_total: newCost + newPack + newHand,
          effective_from: now,
          change_reason: dto.change_reason ?? 'Edição manual',
          change_source: 'manual',
        })
    }

    const stockChanged =
      dto.partner_stock !== undefined && Number(dto.partner_stock) !== Number(existing.partner_stock ?? 0)
    if (stockChanged) patch.last_stock_change_at = now

    if (Object.keys(patch).length === 0) return existing

    patch.updated_at = now
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .update(patch)
      .eq('id', supplierProductId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async archivePartnerProduct(orgId: string, id: string) {
    await this.getPartnerProduct(orgId, id) // valida ownership via JOIN
    const { error } = await supabaseAdmin
      .from('supplier_products')
      .update({
        dropship_status: 'discontinued',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Cost history ──────────────────────────────────────────────────────────

  async listCostHistory(orgId: string, supplierProductId: string) {
    // Valida ownership
    await this.getPartnerProduct(orgId, supplierProductId)

    const { data, error } = await supabaseAdmin
      .from('supplier_cost_history')
      .select('*')
      .eq('supplier_product_id', supplierProductId)
      .order('effective_from', { ascending: false })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  // ── Sync logs ──────────────────────────────────────────────────────────────

  async listSyncLogs(orgId: string, filters: { supplier_id?: string; status?: string }) {
    let query = supabaseAdmin
      .from('dropship_sync_logs')
      .select(`
        id, sync_type, source, source_file_name,
        products_processed, products_created, products_updated, products_failed,
        cost_changes_count, stock_changes_count,
        out_of_stock_skus, status, error_message, duration_seconds,
        triggered_by, started_at, completed_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('started_at', { ascending: false })
      .limit(50)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) query = query.eq('status', filters.status)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getSyncLog(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_sync_logs')
      .select(`*, suppliers(id, name)`)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Sync log não encontrado')
    return data
  }

  // ── Bulk import (planilha pré-parseada no client) ─────────────────────────

  async bulkImportPartnerProducts(
    orgId: string,
    dto: BulkImportDto,
    userId: string | null,
  ): Promise<BulkImportResult> {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id é obrigatório')
    if (!Array.isArray(dto.rows) || dto.rows.length === 0) {
      throw new BadRequestException('Nenhuma linha para importar')
    }

    // Valida supplier
    const { data: sup } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('id', dto.supplier_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!sup) throw new NotFoundException('Fornecedor não encontrado')

    // 1. Cria sync_log status=running
    const startedAt = new Date()
    const { data: syncLog, error: logErr } = await supabaseAdmin
      .from('dropship_sync_logs')
      .insert({
        organization_id: orgId,
        supplier_id: dto.supplier_id,
        sync_type: 'spreadsheet_import',
        source: 'spreadsheet',
        source_file_name: dto.source_file_name ?? null,
        status: 'running',
        triggered_by: userId,
        started_at: startedAt.toISOString(),
      })
      .select()
      .single()
    if (logErr || !syncLog) throw new HttpException(logErr?.message ?? 'Erro ao criar sync log', 500)

    const result: BulkImportResult = {
      sync_log_id: syncLog.id,
      processed: 0,
      created: 0,
      updated: 0,
      failed: 0,
      cost_changes: 0,
      validation_errors: [],
    }
    const significantCostChanges: Array<{ supplier_sku: string; old: number; new: number; pct_change: number }> = []
    const outOfStockSkus: string[] = []

    // Pré-busca produtos do org (1x query) pra match por SKU eficiente
    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, sku')
      .eq('organization_id', orgId)
    const productBySku = new Map<string, string>()
    const productById = new Set<string>()
    for (const p of (products ?? [])) {
      if (p.sku) productBySku.set(String(p.sku).trim().toUpperCase(), p.id)
      productById.add(p.id)
    }

    // Pré-busca supplier_products desse supplier (pra detectar update vs create + diff de custo)
    const { data: existing } = await supabaseAdmin
      .from('supplier_products')
      .select('id, product_id, supplier_sku, unit_cost, partner_packaging_cost, partner_handling_cost, partner_stock')
      .eq('supplier_id', dto.supplier_id)
    const existingBySku = new Map<string, typeof existing[number]>()
    for (const e of (existing ?? [])) {
      existingBySku.set(String(e.supplier_sku).trim().toUpperCase(), e)
    }

    const now = new Date().toISOString()

    // 2. Loop pelas linhas
    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i]
      result.processed++

      // Validações básicas
      if (!row.supplier_sku?.trim()) {
        result.failed++
        result.validation_errors.push({ row: i + 1, supplier_sku: '', error: 'SKU do parceiro vazio' })
        continue
      }
      if (typeof row.unit_cost !== 'number' || !isFinite(row.unit_cost) || row.unit_cost < 0) {
        result.failed++
        result.validation_errors.push({ row: i + 1, supplier_sku: row.supplier_sku, error: 'Custo inválido' })
        continue
      }

      // Resolver product_id
      let productId: string | null = null
      if (row.product_id && productById.has(row.product_id)) {
        productId = row.product_id
      } else if (row.product_sku) {
        productId = productBySku.get(row.product_sku.trim().toUpperCase()) ?? null
      } else if (row.master_sku) {
        productId = productBySku.get(row.master_sku.trim().toUpperCase()) ?? null
      }

      if (!productId) {
        result.failed++
        result.validation_errors.push({
          row: i + 1,
          supplier_sku: row.supplier_sku,
          error: `Produto não encontrado no catálogo (procurou: ${row.product_sku ?? row.master_sku ?? '(vazio)'})`,
        })
        continue
      }

      const supplierSkuKey = row.supplier_sku.trim().toUpperCase()
      const existingRow = existingBySku.get(supplierSkuKey)

      const unitCost = row.unit_cost
      const packagingCost = Number(row.packaging_cost ?? 0) || 0
      const handlingCost = Number(row.handling_cost ?? 0) || 0
      const stock = Number(row.stock ?? 0) || 0
      const leadTime = row.lead_time_days != null ? Number(row.lead_time_days) : null
      const moq = row.moq != null ? Number(row.moq) : 1

      // Detecta mudança de custo (vs registro existente)
      let costChanged = false
      if (existingRow) {
        costChanged =
          Math.abs(unitCost - Number(existingRow.unit_cost ?? 0)) > 0.001 ||
          Math.abs(packagingCost - Number(existingRow.partner_packaging_cost ?? 0)) > 0.001 ||
          Math.abs(handlingCost - Number(existingRow.partner_handling_cost ?? 0)) > 0.001
        if (costChanged) {
          const oldTotal = Number(existingRow.unit_cost ?? 0)
            + Number(existingRow.partner_packaging_cost ?? 0)
            + Number(existingRow.partner_handling_cost ?? 0)
          const newTotal = unitCost + packagingCost + handlingCost
          const pct = oldTotal > 0 ? ((newTotal - oldTotal) / oldTotal) * 100 : 0
          if (Math.abs(pct) >= 5) {
            significantCostChanges.push({
              supplier_sku: row.supplier_sku,
              old: oldTotal,
              new: newTotal,
              pct_change: Math.round(pct * 100) / 100,
            })
          }
        }
      }

      // Upsert
      const { data: upserted, error: upErr } = await supabaseAdmin
        .from('supplier_products')
        .upsert(
          {
            organization_id: orgId,
            supplier_id: dto.supplier_id,
            product_id: productId,
            supplier_sku: row.supplier_sku.trim(),
            master_sku: row.master_sku ?? null,
            unit_cost: unitCost,
            currency: 'BRL',
            partner_stock: stock,
            partner_reserved: 0,
            partner_packaging_cost: packagingCost,
            partner_handling_cost: handlingCost,
            lead_time_days: leadTime ?? 1,
            moq: moq || 1,
            dropship_status: 'active',
            last_sync_at: now,
            ...(costChanged && { last_cost_change_at: now }),
            ...(existingRow && stock !== Number(existingRow.partner_stock ?? 0) && { last_stock_change_at: now }),
            updated_at: now,
          },
          { onConflict: 'supplier_id,product_id', ignoreDuplicates: false },
        )
        .select('id')
        .single()
      if (upErr || !upserted) {
        result.failed++
        result.validation_errors.push({
          row: i + 1,
          supplier_sku: row.supplier_sku,
          error: upErr?.message ?? 'Erro ao salvar',
        })
        continue
      }

      if (existingRow) result.updated++
      else result.created++

      // Cost history se mudou (ou primeiro cadastro)
      if (costChanged || !existingRow) {
        if (existingRow && costChanged) {
          // fecha snapshot anterior
          await supabaseAdmin
            .from('supplier_cost_history')
            .update({ effective_until: now })
            .eq('supplier_product_id', upserted.id)
            .is('effective_until', null)
        }
        await supabaseAdmin
          .from('supplier_cost_history')
          .insert({
            organization_id: orgId,
            supplier_product_id: upserted.id,
            cost_value: unitCost,
            cost_packaging: packagingCost,
            cost_handling: handlingCost,
            cost_total: unitCost + packagingCost + handlingCost,
            effective_from: now,
            change_reason: existingRow ? 'Sync via planilha' : 'Cadastro via planilha',
            change_source: 'spreadsheet_import',
          })
        if (costChanged) result.cost_changes++
      }

      if (stock <= 0) outOfStockSkus.push(row.supplier_sku)
    }

    // 3. Atualiza sync_log com counters
    const completedAt = new Date()
    const duration = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000)
    const finalStatus: 'completed' | 'partial' | 'failed' =
      result.failed === 0 ? 'completed' :
      result.created + result.updated > 0 ? 'partial' :
      'failed'

    await supabaseAdmin
      .from('dropship_sync_logs')
      .update({
        products_processed: result.processed,
        products_created: result.created,
        products_updated: result.updated,
        products_failed: result.failed,
        cost_changes_count: result.cost_changes,
        out_of_stock_skus: outOfStockSkus,
        significant_cost_changes: significantCostChanges,
        validation_errors: result.validation_errors,
        status: finalStatus,
        duration_seconds: duration,
        completed_at: completedAt.toISOString(),
      })
      .eq('id', syncLog.id)

    return result
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 3 — IDENTIFICAÇÃO DE PEDIDOS DROPSHIP
  // ══════════════════════════════════════════════════════════════════════════

  /** Cron: a cada 5min identifica pedidos novos como dropship */
  @Cron('*/5 * * * *', { name: 'dropship-identify-orders' })
  async identifyOrdersTick() {
    try {
      const { data: orgs } = await supabaseAdmin
        .from('organizations')
        .select('id')
      for (const org of orgs ?? []) {
        try {
          // Passo 1 — identifica pedidos novos como dropship
          const r = await this.identifyDropshipOrders(org.id)
          if (r.identified > 0) {
            this.logger.log(`[identify] org=${org.id} processed=${r.processed} identified=${r.identified}`)
          }
          // Passo 2 — avança status dos já identificados pra eligible_for_oc
          // (ou cancelled, conforme o estado do pedido no marketplace)
          const p = await this.promoteIdentifications(org.id)
          if (p.promoted > 0 || p.cancelled > 0) {
            this.logger.log(`[promote] org=${org.id} promoted=${p.promoted} cancelled=${p.cancelled}`)
          }
        } catch (e) {
          this.logger.warn(`[identify] org=${org.id} erro: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      this.logger.error(`[identify] tick failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  /**
   * Funil de validação de expedição. Promove identifications pelas camadas:
   *  - Cancelado no marketplace → `cancelled`
   *  - `ready_to_ship` (etiqueta liberada, NÃO despachado) → Camada 1:
   *    `awaiting_shipment` + grava `label_ready_at`. NÃO entra em OC ainda.
   *  - `shipped`/`delivered`/`in_transit` (canal confirma despacho) → Camada 2a:
   *    grava `shipped_at` (= data de expedição p/ a coorte da OC). Vira
   *    `eligible_for_oc` se o toggle de confirmação do parceiro estiver OFF
   *    ou já houver `partner_confirmed_at` (Camada 2b); senão fica em `shipped`
   *    aguardando o parceiro confirmar.
   *  - handling/pending → `awaiting_shipment`.
   *
   * A regra de ouro: a OC fecha por DATA DE EXPEDIÇÃO, não de venda. Itens não
   * confirmados ficam fora da OC e entram no dia em que forem confirmados
   * (carry-forward implícito — só `eligible_for_oc`/`shipped_confirmed` entram).
   */
  async promoteIdentifications(orgId: string): Promise<{
    checked: number
    promoted: number
    awaiting: number
    cancelled: number
  }> {
    // Pega identifications em estado intermediário (identified ou awaiting_shipment)
    const { data: idents } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('id, order_id, supplier_id, marketplace_status, shipping_status, dropship_status, shipped_at, label_ready_at, partner_confirmed_at, logistic_type')
      .eq('organization_id', orgId)
      .in('dropship_status', ['identified', 'awaiting_shipment', 'shipped'])
      .limit(500)

    if (!idents || idents.length === 0) {
      return { checked: 0, promoted: 0, awaiting: 0, cancelled: 0 }
    }

    // Re-fetch status atualizado dos orders (pode ter mudado desde a identificação)
    const orderIds = idents.map(i => i.order_id).filter(Boolean) as string[]
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, status, shipping_status, shipped_at')
      .in('id', orderIds)
    const orderMap = new Map<string, { status: string | null; shipping_status: string | null; shipped_at: string | null }>(
      (orders ?? []).map(o => [o.id, {
        status: o.status as string | null,
        shipping_status: o.shipping_status as string | null,
        shipped_at: o.shipped_at as string | null,
      }]),
    )

    // Toggle de confirmação obrigatória do parceiro (Camada 2b), por fornecedor.
    const supplierIds = [...new Set(idents.map(i => i.supplier_id).filter(Boolean) as string[])]
    const { data: profiles } = supplierIds.length > 0
      ? await supabaseAdmin
          .from('supplier_dropship_profiles')
          .select('supplier_id, require_partner_shipment_confirmation')
          .eq('organization_id', orgId)
          .in('supplier_id', supplierIds)
      : { data: [] as Array<{ supplier_id: string; require_partner_shipment_confirmation: boolean }> }
    const requireConfirm = new Map(
      (profiles ?? []).map(p => [p.supplier_id, !!p.require_partner_shipment_confirmation]),
    )

    const now = new Date().toISOString()
    let promoted = 0, awaiting = 0, cancelled = 0
    // PromiseLike (não Promise): o query builder do Supabase é um thenable,
    // .then() retorna PromiseLike — Promise.all aceita PromiseLike normalmente.
    const updates: Array<PromiseLike<unknown>> = []
    const patch = (id: string, p: Record<string, unknown>): void => {
      updates.push(
        supabaseAdmin
          .from('dropship_order_identifications')
          .update({ ...p, updated_at: now })
          .eq('id', id)
          .then(() => undefined),
      )
    }

    for (const i of idents) {
      const cur = orderMap.get(i.order_id) ?? { status: i.marketplace_status, shipping_status: i.shipping_status, shipped_at: i.shipped_at }
      const orderStatus = cur.status ?? i.marketplace_status
      const shipping    = cur.shipping_status ?? i.shipping_status

      // Cancelado no marketplace → encerra
      if (orderStatus === 'cancelled' || orderStatus === 'invalid') {
        if (i.dropship_status !== 'cancelled') {
          patch(i.id, { dropship_status: 'cancelled', hold_reason: 'Pedido cancelado no marketplace' })
          cancelled++
        }
        continue
      }

      // Full (fulfillment): estoque já no CD do ML → o parceiro foi pago no
      // abastecimento, não por venda. Fora da OC por venda (acerto separado).
      // Parqueia em on_hold uma vez; sai da fila de promoção.
      if (i.logistic_type === 'fulfillment') {
        if (i.dropship_status !== 'on_hold') {
          patch(i.id, { dropship_status: 'on_hold', hold_reason: 'Full (fulfillment) — acerto separado, fora da OC por venda' })
        }
        continue
      }

      const channelShipped = shipping === 'shipped' || shipping === 'delivered' || shipping === 'in_transit'
      const labelReady     = shipping === 'ready_to_ship'

      if (channelShipped) {
        // Camada 2a: canal confirma despacho. shipped_at = data de expedição (coorte da OC).
        // Vira elegível só se o parceiro não precisa confirmar (toggle OFF) ou já confirmou (2b).
        const needsPartner = requireConfirm.get(i.supplier_id ?? '') === true
        const confirmed    = !needsPartner || !!i.partner_confirmed_at
        const target       = confirmed ? 'eligible_for_oc' : 'shipped'
        // Data de expedição = data REAL de postagem do canal (orders.shipped_at,
        // capturada da ML), não a hora do cron. Só cai pra `now` se o canal ainda
        // não devolveu a data. Isso torna a coorte da OC precisa.
        const realShippedAt = i.shipped_at ?? cur.shipped_at ?? now
        if (i.dropship_status !== target || !i.shipped_at) {
          patch(i.id, { dropship_status: target, shipped_at: realShippedAt })
          if (confirmed) promoted++
          else awaiting++
        }
      } else if (labelReady) {
        // Camada 1: etiqueta liberada, mas AINDA NÃO despachado → não entra em OC.
        if (i.dropship_status !== 'awaiting_shipment' || !i.label_ready_at) {
          patch(i.id, { dropship_status: 'awaiting_shipment', label_ready_at: i.label_ready_at ?? now })
          awaiting++
        }
      } else if (i.dropship_status === 'identified') {
        // handling/pending → aguardando expedição
        patch(i.id, { dropship_status: 'awaiting_shipment' })
        awaiting++
      }
    }

    await Promise.all(updates)
    return { checked: idents.length, promoted, awaiting, cancelled }
  }

  async identifyDropshipOrders(orgId: string): Promise<{ processed: number; identified: number; skipped: number }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()

    // 1. Pega orders dos últimos 7 dias que ainda não tem identification
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select(`
        id, source, external_order_id, seller_id, channel_account_id, product_id, sku,
        quantity, sale_price, status, shipping_status, payment_status,
        sold_at, created_at, raw_data
      `)
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .not('status', 'in', '(cancelled,refunded)')
      .order('created_at', { ascending: false })
      .limit(1000)  // cobre a janela de 7d multicanal (ML+Shopee+TikTok); recentes 1º

    if (!orders || orders.length === 0) return { processed: 0, identified: 0, skipped: 0 }

    // Filtra orders que ainda não tem identification (1x query)
    const orderIds = orders.map(o => o.id)
    const { data: existing } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('order_id')
      .in('order_id', orderIds)
    const identifiedIds = new Set((existing ?? []).map(e => e.order_id))
    const candidates = orders.filter(o => !identifiedIds.has(o.id))

    if (candidates.length === 0) return { processed: orders.length, identified: 0, skipped: 0 }

    // Pré-busca account-supplier mappings ativos do org
    const { data: accountSuppliers } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('supplier_id, marketplace, seller_id, shopee_shop_id, amazon_seller_id, is_default, dedicated')
      .eq('organization_id', orgId)
      .is('active_until', null)
    // Modelo "produto manda": a CONTA habilita dropship (pode ter VÁRIOS
    // parceiros); o PRODUTO escolhe qual parceiro (via catálogo, passo 5).
    // Por isso guardamos o CONJUNTO de parceiros por conta/canal, não um só.
    type AccSup = { supplier_id: string; is_default: boolean; dedicated: boolean }
    const accSupByAccount = new Map<string, AccSup[]>()     // marketplace:account → parceiros (ML traz a conta na linha)
    const accSupByMarketplace = new Map<string, AccSup[]>() // marketplace → parceiros (canais sem conta na linha)
    for (const a of (accountSuppliers ?? [])) {
      // dedicated=true (default): conta dedicada ao(s) parceiro(s) → produto fora
      // do catálogo vira on_hold (lista de cadastro). dedicated=false (mista):
      // conta vende também estoque próprio → produto fora do catálogo é ignorado.
      const entry: AccSup = { supplier_id: a.supplier_id, is_default: !!a.is_default, dedicated: (a as { dedicated?: boolean }).dedicated !== false }
      const mkt = accSupByMarketplace.get(a.marketplace) ?? []
      mkt.push(entry)
      accSupByMarketplace.set(a.marketplace, mkt)
      const account = a.seller_id ?? a.shopee_shop_id ?? a.amazon_seller_id
      if (account == null) continue
      const key = `${a.marketplace}:${account}`
      const list = accSupByAccount.get(key) ?? []
      list.push(entry)
      accSupByAccount.set(key, list)
    }

    if ((accountSuppliers ?? []).length === 0) {
      // Nenhum vínculo conta→fornecedor = nada é dropship
      return { processed: orders.length, identified: 0, skipped: candidates.length }
    }

    let identified = 0
    let skipped = 0

    for (const order of candidates) {
      // 2. Mapear marketplace ao formato seller_account_suppliers
      const marketplace = this.normalizeMarketplaceName(order.source ?? '')
      if (!marketplace) { skipped++; continue }

      // 3. Parceiros CANDIDATOS: a CONTA habilita o dropship (pode ter vários
      //    parceiros); quem escolhe é o produto (passo 5). ML traz a conta na
      //    linha (order.seller_id) → candidatos daquela conta. Canais sem conta
      //    na linha → usam o shop_id carimbado na ingestão (channel_account_id);
      //    sem isso, caem em todos os parceiros do canal.
      const account = order.seller_id ?? order.channel_account_id ?? null
      const candidatesSup = account != null
        ? (accSupByAccount.get(`${marketplace}:${account}`) ?? [])
        : (accSupByMarketplace.get(marketplace) ?? [])
      if (candidatesSup.length === 0) { skipped++; continue }  // conta/canal sem parceiro = não é dropship

      // 4. Resolver product. Cascata: a) product_id (ingestão) b) listing_id em
      //    raw_data → product_listings c) sku literal. Para no 1º hit.
      const resolved = await this.resolveProductForOrder(orgId, order)
      const productId = resolved.productId
      if (!productId) { skipped++; continue }

      // 5. O PRODUTO escolhe o parceiro: dentre os candidatos da conta, em qual
      //    catálogo (supplier_products) esse produto está? Desempate quando o
      //    produto está em 2+ parceiros: is_preferred → parceiro default da
      //    conta → primeiro. supplier_products é a fonte da verdade do vínculo.
      const candidateIds = candidatesSup.map(c => c.supplier_id)
      const { data: ppsRaw } = await supabaseAdmin
        .from('supplier_products')
        .select('id, supplier_id, supplier_sku, master_sku, unit_cost, partner_packaging_cost, partner_handling_cost, is_preferred')
        .in('supplier_id', candidateIds)
        .eq('product_id', productId)
      const ppList = (ppsRaw ?? []) as Array<{
        id: string; supplier_id: string; supplier_sku: string | null; master_sku: string | null
        unit_cost: number; partner_packaging_cost: number | null; partner_handling_cost: number | null
        is_preferred: boolean | null
      }>
      let pp: (typeof ppList)[number] | null = null
      if (ppList.length === 1) pp = ppList[0]
      else if (ppList.length > 1) {
        pp = ppList.find(p => p.is_preferred)
          ?? ppList.find(p => candidatesSup.some(c => c.supplier_id === p.supplier_id && c.is_default))
          ?? ppList[0]
      }
      // 5b. Fallback por SKU: produto duplicado em `products` faz o product_id
      //     do pedido divergir do catálogo mesmo com o MESMO SKU. Quando o match
      //     por product_id falha, casa o SKU do pedido com supplier_sku no
      //     catálogo dos candidatos. Conservador: só aceita se inequívoco (1 hit
      //     ou desempate claro por is_preferred/default); ambíguo → mantém
      //     on_hold (não chuta custo de OC). Produto próprio (SKU fora de
      //     qualquer catálogo) continua on_hold normalmente.
      if (!pp && order.sku) {
        const { data: bySkuRaw } = await supabaseAdmin
          .from('supplier_products')
          .select('id, supplier_id, supplier_sku, master_sku, unit_cost, partner_packaging_cost, partner_handling_cost, is_preferred')
          .in('supplier_id', candidateIds)
          .eq('supplier_sku', order.sku)
        const skuList = (bySkuRaw ?? []) as typeof ppList
        if (skuList.length === 1) pp = skuList[0]
        else if (skuList.length > 1) {
          pp = skuList.find(p => p.is_preferred)
            ?? skuList.find(p => candidatesSup.some(c => c.supplier_id === p.supplier_id && c.is_default))
            ?? null  // ambíguo demais → on_hold
        }
      }

      // Parceiro vem do PRODUTO. Se o produto não está no catálogo de NENHUM
      // candidato, on_hold atribuído ao parceiro default da conta (não some do
      // radar; alimenta a divergência missing_partner_product).
      const supplierId = pp?.supplier_id
        ?? (candidatesSup.find(c => c.is_default) ?? candidatesSup[0]).supplier_id

      // Conta MISTA (dedicated=false): produto fora do catálogo de qualquer
      // parceiro = estoque próprio da loja → ignora (não vira on_hold). Conta
      // DEDICADA mantém o on_hold abaixo (lista de cadastro).
      if (!pp && !candidatesSup.some(c => c.dedicated)) { skipped++; continue }

      // Produto não vinculado a esse fornecedor: NÃO pula calado. A venda é de
      // uma conta-fornecedor, então registra em `on_hold` (com hold_reason de
      // mapeamento) pra (a) não sumir do radar e (b) alimentar a divergência
      // `missing_partner_product` (Camada 4). on_hold não entra em OC.
      const cost = pp
        ? Number(pp.unit_cost) + Number(pp.partner_packaging_cost ?? 0) + Number(pp.partner_handling_cost ?? 0)
        : 0
      const salePrice = Number(order.sale_price ?? 0)
      const margin = salePrice - cost

      // Modal de envio (self_service=Flex, cross_docking=Coletas,
      // drop_off/xd_drop_off=Agência/Correios, fulfillment=Full). Mora no
      // raw_data.shipping (capturado na ingestão). Usado pra exibir o modal na
      // OC e pra excluir Full do fluxo de OC por venda (acerto separado).
      const logisticType = (((order.raw_data as Record<string, unknown> | null)
        ?.shipping as Record<string, unknown> | undefined)?.logistic_type as string | null) ?? null

      // 6. Criar identification (idempotente via UNIQUE order_id)
      const { error } = await supabaseAdmin
        .from('dropship_order_identifications')
        .insert({
          organization_id: orgId,
          order_id: order.id,
          marketplace,
          ml_order_id: marketplace === 'mercado_livre' ? order.external_order_id : null,
          shopee_order_id: marketplace === 'shopee' ? order.external_order_id : null,
          amazon_order_id: marketplace === 'amazon' ? order.external_order_id : null,
          supplier_id: supplierId,
          supplier_product_id: pp?.id ?? null,
          product_id: productId,
          partner_sku: pp?.supplier_sku ?? order.sku ?? '',
          master_sku: pp?.master_sku ?? null,
          quantity: order.quantity ?? 1,
          cost_at_sale: cost,
          sale_price: salePrice,
          estimated_cost_at_oc: cost,
          estimated_margin: margin,
          marketplace_status: order.status,
          shipping_status: order.shipping_status,
          payment_status: order.payment_status,
          logistic_type: logisticType,
          dropship_status: pp ? 'identified' : 'on_hold',
          hold_reason: pp ? null : 'Sem mapeamento supplier_product (rever catálogo)',
          identified_at: new Date().toISOString(),
        })

      if (!error) identified++
      else { skipped++; this.logger.warn(`[identify] order ${order.id}: ${error.message}`) }
    }

    return { processed: orders.length, identified, skipped }
  }

  private normalizeMarketplaceName(source: string): string {
    const s = source.toLowerCase()
    if (s.includes('mercadolivre') || s.includes('mercado_livre') || s === 'ml') return 'mercado_livre'
    if (s.includes('shopee')) return 'shopee'
    if (s.includes('tiktok')) return 'tiktok_shop'   // requer migration F1b no CHECK de seller_account_suppliers.marketplace
    if (s.includes('amazon')) return 'amazon'
    if (s.includes('magalu')) return 'magalu'
    if (s.includes('storefront') || s.includes('loja')) return 'storefront'  // idem F1b + espelhamento storefront→orders (F7)
    return ''
  }

  /** Resolve catálogo do pedido: product_id explícito > vínculo via
   *  listing_id em product_listings > master_sku literal. Retorna o
   *  primeiro hit. Sem hit = produto não está no catálogo da org. */
  private async resolveProductForOrder(
    orgId: string,
    order: { product_id?: string | null; sku?: string | null; raw_data?: unknown },
  ): Promise<{ productId: string | null; supplyType: string | null }> {
    // a) product_id já resolvido pela ingestão
    if (order.product_id) {
      const { data: p } = await supabaseAdmin
        .from('products')
        .select('id, supply_type')
        .eq('id', order.product_id)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (p?.id) return { productId: p.id as string, supplyType: (p.supply_type as string | null) ?? null }
    }

    // b) listing_id (MLB ID) em raw_data → product_listings → products
    const listingIds = this.extractListingIdsFromRawData(order.raw_data)
    if (listingIds.length > 0) {
      const { data: pls } = await supabaseAdmin
        .from('product_listings')
        .select('product_id')
        .in('listing_id', listingIds)
        .eq('is_active', true)
      const candidates = (pls ?? [])
        .map(r => (r as { product_id?: string | null }).product_id)
        .filter((x): x is string => !!x)
      if (candidates.length > 0) {
        const { data: ps } = await supabaseAdmin
          .from('products')
          .select('id, supply_type')
          .in('id', [...new Set(candidates)])
          .eq('organization_id', orgId)
          .limit(1)
        const p = ps?.[0]
        if (p?.id) return { productId: p.id as string, supplyType: (p.supply_type as string | null) ?? null }
      }
    }

    // c) master_sku literal (último recurso)
    if (order.sku) {
      const { data: p } = await supabaseAdmin
        .from('products')
        .select('id, supply_type')
        .eq('organization_id', orgId)
        .eq('sku', order.sku)
        .maybeSingle()
      if (p?.id) return { productId: p.id as string, supplyType: (p.supply_type as string | null) ?? null }
    }

    return { productId: null, supplyType: null }
  }

  /** Extrai MLB IDs (= listing_id) de raw_data.order_items[*].
   *  ML coloca o id em order_items[i].item.id ou order_items[i].item_id. */
  private extractListingIdsFromRawData(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object') return []
    const items = (raw as { order_items?: unknown[] }).order_items
    if (!Array.isArray(items)) return []
    const ids = new Set<string>()
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const o = it as { item_id?: unknown; item?: { id?: unknown } }
      if (typeof o.item_id === 'string' && o.item_id) ids.add(o.item_id)
      const inner = o.item?.id
      if (inner != null) {
        const s = String(inner)
        if (s) ids.add(s)
      }
    }
    return [...ids]
  }

  // ── Orders endpoints ──────────────────────────────────────────────────────

  async listDropshipOrders(orgId: string, filters: {
    supplier_id?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
    q?: string;
  }) {
    let query = supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        id, marketplace, ml_order_id, shopee_order_id, amazon_order_id,
        partner_sku, master_sku, quantity,
        cost_at_sale, sale_price, estimated_cost_at_oc, estimated_margin,
        marketplace_status, shipping_status, payment_status,
        dropship_status, hold_reason,
        identified_at, shipped_at, shipment_confirmed_at, delivered_at,
        oc_id,
        suppliers(id, name),
        products(id, name, sku, photo_urls),
        orders(id, external_order_id, buyer_name, sold_at)
      `)
      .eq('organization_id', orgId)
      .order('identified_at', { ascending: false })
      .limit(200)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) query = query.eq('dropship_status', filters.status)
    if (filters.date_from) query = query.gte('identified_at', filters.date_from)
    if (filters.date_to) query = query.lte('identified_at', filters.date_to)
    if (filters.q) query = query.ilike('partner_sku', `%${filters.q}%`)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getDropshipOrder(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        *,
        suppliers(id, name),
        products(id, name, sku, photo_urls),
        orders(*)
      `)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Pedido dropship não encontrado')
    return data
  }

  async holdDropshipOrder(orgId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo obrigatório')
    const { error } = await supabaseAdmin
      .from('dropship_order_identifications')
      .update({
        dropship_status: 'on_hold',
        hold_reason: reason.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  async releaseDropshipOrder(orgId: string, id: string) {
    const { error } = await supabaseAdmin
      .from('dropship_order_identifications')
      .update({
        dropship_status: 'identified',
        hold_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('dropship_status', 'on_hold')
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async getDashboard(orgId: string) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayIso = today.toISOString()

    // Conta partners ativos
    const { count: activePartnersCount } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('dropship_status', 'active')

    // SKUs ativos
    const { count: activeSkusCount } = await supabaseAdmin
      .from('supplier_products')
      .select('id', { count: 'exact', head: true })
      .eq('dropship_status', 'active')

    // Vendas dropship do dia
    const { data: todayOrders } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('sale_price, quantity, dropship_status, estimated_cost_at_oc')
      .eq('organization_id', orgId)
      .gte('identified_at', todayIso)

    const shippedToday = (todayOrders ?? []).filter(o =>
      ['shipped', 'shipped_confirmed', 'eligible_for_oc'].includes(o.dropship_status as string),
    ).length
    const todayValue = (todayOrders ?? []).reduce((s, o) =>
      s + (Number(o.sale_price ?? 0) * Number(o.quantity ?? 0)), 0,
    )
    const todayCmv = (todayOrders ?? []).reduce((s, o) =>
      s + (Number(o.estimated_cost_at_oc ?? 0) * Number(o.quantity ?? 0)), 0,
    )

    // Pendências on_hold
    const { count: onHoldCount } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('dropship_status', 'on_hold')

    // Out-of-stock
    const { count: outOfStockCount } = await supabaseAdmin
      .from('supplier_products')
      .select('id, suppliers!inner(organization_id)', { count: 'exact', head: true })
      .eq('suppliers.organization_id', orgId)
      .eq('dropship_status', 'active')
      .lte('partner_stock', 0)

    // Recent identifications (últimas 10)
    const { data: recent } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        id, marketplace, partner_sku, quantity, sale_price, estimated_margin,
        dropship_status, identified_at,
        suppliers(name),
        products(name)
      `)
      .eq('organization_id', orgId)
      .order('identified_at', { ascending: false })
      .limit(10)

    return {
      kpis: {
        active_partners: activePartnersCount ?? 0,
        active_skus: activeSkusCount ?? 0,
        shipped_today: shippedToday,
        today_value: todayValue,
        today_cmv: todayCmv,
        today_margin: todayValue - todayCmv,
        on_hold_count: onHoldCount ?? 0,
        out_of_stock_skus: outOfStockCount ?? 0,
      },
      recent_orders: recent ?? [],
    }
  }

  // ── PDF Generation (Sprint 6.5) ──────────────────────────────────────────

  /** Gera PDF da OC. Layout simples: header + dados parceiro + tabela items
   *  + totais + footer. Retorna Buffer pronto pra response binária. */
  async generateOCPdf(orgId: string, ocId: string): Promise<Buffer> {
    const oc = await this.getOC(orgId, ocId) as Record<string, unknown> & {
      items: Array<{
        partner_sku: string; product_name: string; quantity: number;
        unit_cost: number; line_total: number; ml_order_id: string | null;
      }>
    }
    const supRaw = oc.suppliers as unknown
    const sup = (Array.isArray(supRaw) ? supRaw[0] : supRaw) as {
      name: string; legal_name: string | null; tax_id: string | null;
      contact_email: string | null; contact_phone: string | null;
      payment_terms: string | null; payment_method: string | null;
    } | null

    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })
        const chunks: Buffer[] = []
        doc.on('data', (c: Buffer) => chunks.push(c))
        doc.on('end', () => resolve(Buffer.concat(chunks)))
        doc.on('error', reject)

        // ── Header ─────────────────────────────────────────────────────────
        doc.fillColor('#0a0a0e').rect(0, 0, doc.page.width, 80).fill()
        doc.fillColor('#00E5FF').fontSize(18).font('Helvetica-Bold')
          .text('e-Click', 50, 30)
        doc.fillColor('#ffffff').fontSize(10).font('Helvetica')
          .text('Ordem de Compra Dropship', 50, 52)
        doc.fillColor('#a1a1aa').fontSize(9)
          .text(`Gerada em ${new Date().toLocaleString('pt-BR')}`, doc.page.width - 200, 30, { width: 150, align: 'right' })

        // ── Número OC + status ──────────────────────────────────────────────
        doc.fillColor('#000000').fontSize(20).font('Helvetica-Bold')
          .text(`${oc.oc_number}`, 50, 100)
        doc.fillColor('#71717a').fontSize(10).font('Helvetica')
          .text(`Status: ${oc.status}`, 50, 125)
          .text(`Marketplace: ${oc.marketplace_account_label ?? oc.marketplace}`, 50, 140)

        // ── Datas (lado direito) ────────────────────────────────────────────
        doc.fontSize(9)
          .text('Data de referência:', 380, 100, { width: 150, align: 'left' })
          .font('Helvetica-Bold').fillColor('#000000')
          .text(fmtDate(String(oc.reference_date)), 380, 113, { width: 150, align: 'left' })
          .font('Helvetica').fillColor('#71717a')
          .text('Vencimento:', 380, 130, { width: 150, align: 'left' })
          .font('Helvetica-Bold').fillColor('#000000')
          .text(fmtDate(String(oc.due_date)), 380, 143, { width: 150, align: 'left' })

        // ── Dados parceiro ──────────────────────────────────────────────────
        let y = 175
        doc.moveTo(50, y).lineTo(545, y).strokeColor('#e4e4e7').stroke()
        y += 10
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
          .text('PARCEIRO', 50, y)
        y += 18
        doc.fontSize(10).font('Helvetica').fillColor('#000000')
          .text(sup?.name ?? '—', 50, y)
        y += 14
        doc.fontSize(9).fillColor('#71717a')
          .text(`Razão Social: ${sup?.legal_name ?? '—'}    CNPJ: ${sup?.tax_id ?? '—'}`, 50, y)
        y += 12
        doc.text(`Contato: ${sup?.contact_email ?? '—'}    ${sup?.contact_phone ?? ''}`, 50, y)
        y += 12
        doc.text(`Pagamento: ${sup?.payment_terms ?? '—'} dias · ${(sup?.payment_method ?? '—').toUpperCase()}`, 50, y)
        y += 18

        // ── Tabela de items ─────────────────────────────────────────────────
        doc.moveTo(50, y).lineTo(545, y).strokeColor('#e4e4e7').stroke()
        y += 10
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
          .text('ITENS', 50, y)
        y += 20

        // Cabeçalho da tabela
        doc.fillColor('#f4f4f5').rect(50, y, 495, 20).fill()
        doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
          .text('SKU PARCEIRO', 55, y + 6, { width: 90 })
          .text('PRODUTO',      150, y + 6, { width: 200 })
          .text('PEDIDO ML',    355, y + 6, { width: 80 })
          .text('QTD',          440, y + 6, { width: 30, align: 'right' })
          .text('CUSTO',        475, y + 6, { width: 65, align: 'right' })
        y += 22

        // Rows
        doc.fontSize(8).font('Helvetica').fillColor('#000000')
        for (const item of oc.items.slice(0, 30)) {
          if (y > 720) {
            doc.addPage()
            y = 50
          }
          doc.text(item.partner_sku ?? '—', 55, y, { width: 90, ellipsis: true })
          doc.text(item.product_name ?? '—', 150, y, { width: 200, ellipsis: true })
          doc.fillColor('#71717a').text(item.ml_order_id ?? '—', 355, y, { width: 80, ellipsis: true })
          doc.fillColor('#000000').text(String(item.quantity), 440, y, { width: 30, align: 'right' })
          doc.text(fmtBrl(Number(item.line_total)), 475, y, { width: 65, align: 'right' })
          y += 14
        }
        if (oc.items.length > 30) {
          doc.fillColor('#71717a').fontSize(8).font('Helvetica-Oblique')
            .text(`...mais ${oc.items.length - 30} itens não listados (ver Excel completo)`, 55, y)
          y += 14
        }

        // ── Totais ──────────────────────────────────────────────────────────
        y += 10
        doc.moveTo(350, y).lineTo(545, y).strokeColor('#e4e4e7').stroke()
        y += 10
        doc.fontSize(9).font('Helvetica').fillColor('#71717a')
          .text(`${oc.items_count} itens · ${oc.units_count} unidades`, 50, y)

        const drawTotal = (label: string, val: number, bold = false, color = '#000000') => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color)
            .fontSize(bold ? 11 : 9)
            .text(label, 350, y, { width: 130, align: 'right' })
            .text(fmtBrl(val), 480, y, { width: 60, align: 'right' })
          y += bold ? 18 : 14
        }
        drawTotal('Bruto:', Number(oc.gross_total))
        if (Number(oc.total_credits) > 0) {
          drawTotal('Devoluções:', -Number(oc.return_credits))
          if (Number(oc.cancellation_credits) > 0) drawTotal('Cancelamentos:', -Number(oc.cancellation_credits))
          if (Number(oc.warranty_credits) > 0) drawTotal('Garantias:', -Number(oc.warranty_credits))
          if (Number(oc.divergence_credits) > 0) drawTotal('Divergências:', -Number(oc.divergence_credits))
          if (Number(oc.other_credits) > 0) drawTotal('Outros:', -Number(oc.other_credits))
          drawTotal('Total créditos:', -Number(oc.total_credits), false, '#fcd34d')
        }
        y += 4
        doc.moveTo(350, y).lineTo(545, y).strokeColor('#000000').stroke()
        y += 10
        drawTotal('LÍQUIDO A PAGAR:', Number(oc.net_total), true, '#0a0a0e')

        // ── Footer ──────────────────────────────────────────────────────────
        const range = doc.bufferedPageRange()
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(range.start + i)
          doc.fontSize(8).fillColor('#71717a').font('Helvetica')
            .text(
              `Página ${i + 1} de ${range.count}  ·  Documento gerado por e-Click  ·  ${oc.oc_number}`,
              50, doc.page.height - 40,
              { width: doc.page.width - 100, align: 'center' },
            )
        }

        doc.end()
      } catch (e) { reject(e) }
    })
  }

  async generateOCPdfByToken(token: string): Promise<{ buffer: Buffer; ocNumber: string }> {
    const session = await this.validatePortalToken(token)
    const buffer = await this.generateOCPdf(session.organization_id, session.oc_id)
    const { data: oc } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select('oc_number')
      .eq('id', session.oc_id)
      .maybeSingle()
    return { buffer, ocNumber: oc?.oc_number ?? 'oc' }
  }

  /** Status de configuração da org pra UI mostrar avisos (banner amber)
   *  quando algo crítico não está configurado. */
  async getSetupStatus(orgId: string): Promise<{
    has_partners: boolean
    has_active_partners: boolean
    has_email_config: boolean
    has_whatsapp_config: boolean
    has_account_links: boolean
    blockers: string[]
  }> {
    // Email config (procura row em email_settings)
    const { data: emailCfg } = await supabaseAdmin
      .from('email_settings')
      .select('id, is_verified')
      .eq('organization_id', orgId)
      .maybeSingle()
    const hasEmail = !!emailCfg

    // WhatsApp config — 3 fontes possíveis (em ordem de preferência):
    //   1. Canal whatsapp_free ativo (Baileys — gratuito)
    //   2. Env vars Z-API
    //   3. Row em whatsapp_configs (Meta Cloud)
    const { data: freeCh } = await supabaseAdmin
      .from('channels')
      .select('id')
      .eq('organization_id', orgId)
      .eq('channel_type', 'whatsapp_free')
      .eq('status', 'active')
      .maybeSingle()
    const hasBaileys = !!freeCh
    const hasZapi = !!process.env.ZAPI_INSTANCE_ID && !!process.env.ZAPI_TOKEN
    let hasMetaCfg = false
    if (!hasBaileys && !hasZapi) {
      const { data: waCfg } = await supabaseAdmin
        .from('whatsapp_configs')
        .select('id')
        .eq('organization_id', orgId)
        .maybeSingle()
      hasMetaCfg = !!waCfg
    }
    const hasWaCfg = hasBaileys || hasZapi || hasMetaCfg

    // Partners
    const { count: partnersCount } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
    const { count: activePartnersCount } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('dropship_status', 'active')

    // Vínculos conta-supplier
    const { count: linksCount } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('active_until', null)

    const blockers: string[] = []
    if (!partnersCount) blockers.push('no_partners')
    else if (!activePartnersCount) blockers.push('no_active_partners')
    if (!linksCount) blockers.push('no_account_links')
    if (!hasEmail) blockers.push('no_email_config')
    if (!hasWaCfg) blockers.push('no_whatsapp_config')

    return {
      has_partners: !!partnersCount,
      has_active_partners: !!activePartnersCount,
      has_email_config: hasEmail,
      has_whatsapp_config: hasWaCfg,
      has_account_links: !!linksCount,
      blockers,
    }
  }

  async getTodayOrders(orgId: string) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayIso = today.toISOString()

    const { data, error } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        id, marketplace, partner_sku, quantity,
        sale_price, estimated_cost_at_oc, estimated_margin,
        dropship_status, identified_at, shipped_at,
        suppliers(id, name),
        products(id, name, photo_urls)
      `)
      .eq('organization_id', orgId)
      .gte('identified_at', todayIso)
      .order('identified_at', { ascending: false })
    if (error) throw new HttpException(error.message, 500)

    // Agregação por supplier
    const bySupplier = new Map<string, {
      supplier_id: string;
      supplier_name: string;
      orders_count: number;
      units: number;
      gross_total: number;
      cmv: number;
      margin: number;
    }>()
    for (const o of (data ?? [])) {
      const supRaw = o.suppliers as unknown
      const sup = (Array.isArray(supRaw) ? supRaw[0] : supRaw) as { id: string; name: string } | null
        ?? { id: 'unknown', name: '—' }
      const key = sup.id
      if (!bySupplier.has(key)) {
        bySupplier.set(key, {
          supplier_id: sup.id,
          supplier_name: sup.name,
          orders_count: 0,
          units: 0,
          gross_total: 0,
          cmv: 0,
          margin: 0,
        })
      }
      const agg = bySupplier.get(key)!
      agg.orders_count++
      agg.units += Number(o.quantity ?? 0)
      agg.gross_total += Number(o.sale_price ?? 0) * Number(o.quantity ?? 0)
      agg.cmv += Number(o.estimated_cost_at_oc ?? 0) * Number(o.quantity ?? 0)
      agg.margin += Number(o.estimated_margin ?? 0) * Number(o.quantity ?? 0)
    }

    return {
      orders: data ?? [],
      by_supplier: Array.from(bySupplier.values()).sort((a, b) => b.gross_total - a.gross_total),
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 4 — ORDEM DE COMPRA (OC) DROPSHIP
  // ══════════════════════════════════════════════════════════════════════════

  /** Cron: 22h todo dia gera OCs de cada org */
  @Cron('0 22 * * *', { name: 'dropship-oc-generation', timeZone: 'America/Sao_Paulo' })
  async generateOCsTick() {
    try {
      const { data: orgs } = await supabaseAdmin
        .from('organizations')
        .select('id')
      for (const org of orgs ?? []) {
        try {
          const r = await this.generateDailyOCs(org.id)
          if (r.length > 0) {
            this.logger.log(`[oc-gen] org=${org.id} criou ${r.length} OC(s)`)
          }
        } catch (e) {
          this.logger.warn(`[oc-gen] org=${org.id} erro: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      this.logger.error(`[oc-gen] tick failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Gera OCs do dia agrupando identifications elegíveis por (supplier, marketplace, conta) */
  async generateDailyOCs(orgId: string): Promise<Array<{ id: string; oc_number: string; gross_total: number }>> {
    // 1. Pega identifications elegíveis pra OC
    const { data: idents } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        id, supplier_id, supplier_product_id, product_id,
        marketplace, ml_pack_id, ml_order_id, ml_shipment_id,
        partner_sku, master_sku, quantity,
        cost_at_sale, sale_price, identified_at, shipped_at, order_id,
        logistic_type
      `)
      .eq('organization_id', orgId)
      .in('dropship_status', ['eligible_for_oc', 'shipped_confirmed'])
      .is('oc_id', null)
      .limit(1000)

    if (!idents || idents.length === 0) return []

    // Pré-busca a data REAL da compra (orders.sold_at) p/ cada pedido — o item
    // da OC mostra a data da venda de verdade, não a hora em que o cron rodou.
    const ocOrderIds = [...new Set(idents.map(i => i.order_id).filter(Boolean) as string[])]
    const { data: ocOrders } = ocOrderIds.length > 0
      ? await supabaseAdmin.from('orders').select('id, sold_at, seller_id, channel_account_id').in('id', ocOrderIds)
      : { data: [] as Array<{ id: string; sold_at: string | null; seller_id: number | null; channel_account_id: string | null }> }
    const soldAtByOrder = new Map((ocOrders ?? []).map(o => [o.id, o.sold_at as string | null]))
    // Conta REAL do pedido: ML traz seller_id na linha; Shopee/TikTok carimbam
    // o shop_id em channel_account_id. Pra OC agrupar/rotular pela conta de
    // verdade quando há multi-conta/multi-loja no mesmo fornecedor.
    const acctByOrder = new Map((ocOrders ?? []).map(o =>
      [o.id, String((o.seller_id as number | null) ?? (o.channel_account_id as string | null) ?? '') || null]))

    // Pré-busca seller_account_suppliers pra resolver labels
    const supplierIds = [...new Set(idents.map(i => i.supplier_id))]
    const { data: accountSuppliers } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('supplier_id, marketplace, seller_id, shopee_shop_id, amazon_seller_id, account_label')
      .eq('organization_id', orgId)
      .in('supplier_id', supplierIds)
      .is('active_until', null)

    // Pré-busca suppliers (payment_terms pra calcular due_date)
    const { data: suppliers } = await supabaseAdmin
      .from('suppliers')
      .select('id, name, payment_terms')
      .in('id', supplierIds)
    const supplierById = new Map((suppliers ?? []).map(s => [s.id, s]))

    // Pré-busca supplier_products pros snapshots de custo (current_table strategy)
    const supProductIds = [...new Set(idents.map(i => i.supplier_product_id).filter(Boolean) as string[])]
    const { data: supProducts } = supProductIds.length > 0
      ? await supabaseAdmin
          .from('supplier_products')
          .select(`
            id, supplier_sku, master_sku, unit_cost,
            partner_packaging_cost, partner_handling_cost,
            products(id, name)
          `)
          .in('id', supProductIds)
      : { data: [] }
    const ppById = new Map((supProducts ?? []).map(p => [p.id, p]))

    // 2. Agrupa por (supplier, marketplace, conta)
    type Group = {
      supplier_id: string
      marketplace: string
      account_label: string
      seller_id: number | null
      shopee_shop_id: string | null
      amazon_seller_id: string | null
      reference_date: string   // dia de EXPEDIÇÃO da coorte (não data de venda)
      idents: typeof idents
    }
    const today = new Date()  // usado na coorte de expedição (fallback) e no due_date
    const groups = new Map<string, Group>()
    for (const i of idents) {
      // Resolver conta pela CONTA REAL do pedido (ML traz seller_id na linha),
      // não pelo 1º mapeamento — senão com multi-conta no mesmo fornecedor a OC
      // mistura contas e rotula errado. Casa exata pelo seller_id real; canais
      // sem conta na linha (Shopee/TikTok/storefront) caem no mapeamento do canal.
      const realAcct = acctByOrder.get(i.order_id) ?? null
      const acc = (realAcct != null
        ? (accountSuppliers ?? []).find(a =>
            a.supplier_id === i.supplier_id && a.marketplace === i.marketplace &&
            String(a.seller_id ?? a.shopee_shop_id ?? a.amazon_seller_id ?? '') === String(realAcct))
        : undefined)
        ?? (accountSuppliers ?? []).find(a =>
            a.supplier_id === i.supplier_id && a.marketplace === i.marketplace)
      const sellerId = acc?.seller_id ?? null
      const shopeeShopId = acc?.shopee_shop_id ?? null
      const amazonSellerId = acc?.amazon_seller_id ?? null
      const accountLabel = acc?.account_label ?? null

      // Coorte por DATA DE EXPEDIÇÃO (shipped_at): a OC agrupa o que foi
      // despachado no mesmo dia. Despachos em dias diferentes geram OCs
      // separadas (carry-forward natural). Fallback defensivo: data de
      // identificação, senão hoje.
      const shippedDate = String(i.shipped_at ?? i.identified_at ?? today.toISOString()).slice(0, 10)
      // Chave de agrupamento pela conta REAL (split correto multi-conta/multi-loja).
      const acct = realAcct ?? sellerId ?? shopeeShopId ?? amazonSellerId ?? 'unknown'
      const key = [i.supplier_id, i.marketplace, acct, shippedDate].join(':')
      if (!groups.has(key)) {
        groups.set(key, {
          supplier_id: i.supplier_id,
          marketplace: i.marketplace,
          account_label: accountLabel ?? `${i.marketplace}`,
          seller_id: sellerId,
          shopee_shop_id: shopeeShopId,
          amazon_seller_id: amazonSellerId,
          reference_date: shippedDate,
          idents: [],
        })
      }
      groups.get(key)!.idents.push(i)
    }

    const created: Array<{ id: string; oc_number: string; gross_total: number }> = []
    const ocCounter: Record<string, number> = {}  // numeração sequencial (por data de expedição + fornecedor)

    // Semeia o contador com o maior sequencial JÁ usado por (data_exp,
    // fornecedor) — evita colisão de oc_number quando generateDailyOCs roda mais
    // de uma vez no mesmo dia (re-run manual + cron). Sem isso o 2º run gera
    // DOC-…-001 de novo → viola UNIQUE → itens não entram em OC.
    const refDates = [...new Set([...groups.values()].map(g => g.reference_date))]
    if (refDates.length > 0) {
      const { data: existingOcs } = await supabaseAdmin
        .from('dropship_purchase_orders')
        .select('oc_number, reference_date, supplier_id')
        .eq('organization_id', orgId)
        .in('supplier_id', supplierIds)
        .in('reference_date', refDates)
      for (const o of (existingOcs ?? [])) {
        const m = String(o.oc_number).match(/-(\d+)$/)
        const seq = m ? parseInt(m[1], 10) : 0
        const key = `${o.reference_date}:${o.supplier_id}`
        ocCounter[key] = Math.max(ocCounter[key] ?? 0, seq)
      }
    }

    for (const [, grp] of groups) {
      const supplier = supplierById.get(grp.supplier_id)
      if (!supplier) continue

      // Calcular due_date pelo payment_terms
      const dueDate = computeDueDate(today, supplier.payment_terms)

      // Numeração: DOC-YYYY-MM-DD-ORG-SUPPLIER-NNN
      const supplierSlug = String(supplier.name)
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20).replace(/^_|_$/g, '')
      const counterKey = `${grp.reference_date}:${grp.supplier_id}`
      ocCounter[counterKey] = (ocCounter[counterKey] ?? 0) + 1
      const seq = String(ocCounter[counterKey]).padStart(3, '0')
      const ocNumber = `DOC-${grp.reference_date}-${supplierSlug}-${seq}`

      // 3. Calcula totais
      let grossTotal = 0
      let unitsCount = 0
      const itemsToInsert: Array<Record<string, unknown>> = []

      for (const ident of grp.idents) {
        const pp = ident.supplier_product_id ? ppById.get(ident.supplier_product_id) : null
        const unitCost = Number(pp?.unit_cost ?? ident.cost_at_sale ?? 0)
        const packagingCost = Number(pp?.partner_packaging_cost ?? 0)
        const handlingCost = Number(pp?.partner_handling_cost ?? 0)
        const lineTotal = (unitCost + packagingCost + handlingCost) * Number(ident.quantity ?? 0)

        grossTotal += lineTotal
        unitsCount += Number(ident.quantity ?? 0)

        const productRaw = pp?.products as unknown
        const productData = (Array.isArray(productRaw) ? productRaw[0] : productRaw) as { id: string; name: string } | null

        itemsToInsert.push({
          organization_id: orgId,
          identification_id: ident.id,
          order_id: ident.order_id,
          ml_pack_id: ident.ml_pack_id,
          ml_order_id: ident.ml_order_id,
          ml_shipment_id: ident.ml_shipment_id,
          marketplace: ident.marketplace,
          product_id: ident.product_id,
          supplier_product_id: ident.supplier_product_id,
          partner_sku: ident.partner_sku,
          master_sku: ident.master_sku,
          product_name: productData?.name ?? ident.partner_sku,
          quantity: ident.quantity,
          unit_cost: unitCost,
          packaging_cost: packagingCost,
          handling_cost: handlingCost,
          sale_date: soldAtByOrder.get(ident.order_id) ?? ident.identified_at,
          shipped_at: ident.shipped_at,
          logistic_type: ident.logistic_type ?? null,
          status: 'included',
        })
      }

      // 4. Insert OC
      const { data: oc, error: ocErr } = await supabaseAdmin
        .from('dropship_purchase_orders')
        .insert({
          organization_id: orgId,
          supplier_id: grp.supplier_id,
          oc_number: ocNumber,
          marketplace: grp.marketplace,
          marketplace_account_label: grp.account_label,
          seller_id: grp.seller_id,
          shopee_shop_id: grp.shopee_shop_id,
          amazon_seller_id: grp.amazon_seller_id,
          reference_date: grp.reference_date,
          generation_date: new Date().toISOString(),
          due_date: dueDate,
          items_count: itemsToInsert.length,
          units_count: unitsCount,
          gross_total: grossTotal,
          net_total: grossTotal,  // créditos aplicados em sprints futuras
          status: 'generated',
        })
        .select('id, oc_number, gross_total')
        .single()
      if (ocErr || !oc) {
        this.logger.warn(`[oc-gen] erro criar OC ${ocNumber}: ${ocErr?.message}`)
        continue
      }

      // 5. Insert items
      const itemsWithOcId = itemsToInsert.map(it => ({ ...it, oc_id: oc.id }))
      const { error: itemsErr } = await supabaseAdmin
        .from('dropship_purchase_order_items')
        .insert(itemsWithOcId)
      if (itemsErr) {
        this.logger.error(`[oc-gen] OC ${ocNumber} criada mas items falharam: ${itemsErr.message}`)
        // Não rollback — OC existe, items podem ser refeitos manualmente
      }

      // 6. Update identifications com oc_id + status=in_oc_generated
      const identIds = grp.idents.map(i => i.id)
      await supabaseAdmin
        .from('dropship_order_identifications')
        .update({
          oc_id: oc.id,
          dropship_status: 'in_oc_generated',
          updated_at: new Date().toISOString(),
        })
        .in('id', identIds)

      // 7. Aplica créditos pendentes do parceiro nessa OC (Sprint 9)
      try {
        await this.applyPendingCreditsToOC(orgId, oc.id, grp.supplier_id, Number(oc.gross_total))
      } catch (e) {
        this.logger.warn(`[oc-gen] aplicar créditos falhou em ${oc.oc_number}: ${e instanceof Error ? e.message : e}`)
      }

      created.push({ id: oc.id, oc_number: oc.oc_number, gross_total: Number(oc.gross_total) })
    }

    return created
  }

  // ── OC endpoints ──────────────────────────────────────────────────────────

  async listOCs(orgId: string, filters: {
    supplier_id?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
  }) {
    let query = supabaseAdmin
      .from('dropship_purchase_orders')
      .select(`
        id, oc_number, marketplace, marketplace_account_label,
        reference_date, generation_date, due_date,
        items_count, units_count, gross_total, total_credits, net_total,
        status, sent_to_partner_at, partner_approved_at, paid_at,
        created_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('reference_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.date_from) query = query.gte('reference_date', filters.date_from)
    if (filters.date_to) query = query.lte('reference_date', filters.date_to)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getOC(orgId: string, id: string) {
    const { data: oc, error } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select(`
        *,
        suppliers(id, name, legal_name, tax_id, contact_email, contact_phone, payment_terms, payment_method)
      `)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!oc) throw new NotFoundException('OC não encontrada')

    const { data: items } = await supabaseAdmin
      .from('dropship_purchase_order_items')
      .select(`
        id, partner_sku, master_sku, product_name, variation_label,
        quantity, unit_cost, packaging_cost, handling_cost,
        unit_total_cost, line_total,
        marketplace, ml_order_id, ml_pack_id,
        sale_date, shipped_at, logistic_type, status,
        products(id, name, photo_urls)
      `)
      .eq('oc_id', id)
      .order('sale_date', { ascending: true })

    return { ...oc, items: items ?? [] }
  }

  async cancelOC(orgId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo obrigatório')
    // Reverte status das identifications associadas
    const { data: items } = await supabaseAdmin
      .from('dropship_purchase_order_items')
      .select('identification_id')
      .eq('oc_id', id)
    const identIds = (items ?? []).map(i => i.identification_id).filter(Boolean) as string[]
    if (identIds.length > 0) {
      await supabaseAdmin
        .from('dropship_order_identifications')
        .update({
          oc_id: null,
          dropship_status: 'eligible_for_oc',
          updated_at: new Date().toISOString(),
        })
        .in('id', identIds)
    }
    const { error } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        status: 'cancelled',
        notes: reason.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 6 — PORTAL DO PARCEIRO + ENVIO DE NOTIFICAÇÕES
  // ══════════════════════════════════════════════════════════════════════════

  /** Cria portal session + envia notificação ao parceiro (e-mail + WhatsApp) */
  async sendOCToPartner(orgId: string, ocId: string): Promise<{
    session_id: string
    portal_url: string
    email_status: string
    whatsapp_status: string
  }> {
    // 1. Busca OC com supplier+profile
    const oc = await this.getOC(orgId, ocId) as Record<string, unknown>
    if (!['generated', 'sent', 'viewed'].includes(oc.status as string)) {
      throw new BadRequestException(`OC com status "${oc.status}" não pode ser enviada`)
    }
    const supplierId = oc.supplier_id as string

    // 2. Busca profile pra notification_email/whatsapp
    const { data: profile } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select('notification_email, notification_whatsapp')
      .eq('supplier_id', supplierId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!profile?.notification_email) {
      throw new BadRequestException('Parceiro sem e-mail de notificação configurado')
    }

    // 3. Cria portal session
    const accessToken = generatePortalToken()
    const expiresAt = new Date(Date.now() + PORTAL_TTL_HOURS * 3600_000).toISOString()
    const { data: session, error: sessErr } = await supabaseAdmin
      .from('dropship_partner_portal_sessions')
      .insert({
        organization_id: orgId,
        supplier_id: supplierId,
        oc_id: ocId,
        access_token: accessToken,
        expires_at: expiresAt,
        can_approve: true,
        can_dispute: true,
        status: 'active',
      })
      .select('id')
      .single()
    if (sessErr || !session) {
      throw new HttpException(sessErr?.message ?? 'Erro ao criar sessão', 500)
    }

    const portalUrl = `${FRONTEND_URL}/portal/oc/${accessToken}`
    const ocNumber = oc.oc_number as string
    const supplierRaw = oc.suppliers as unknown
    const supplier = (Array.isArray(supplierRaw) ? supplierRaw[0] : supplierRaw) as { name: string } | null
    const supplierName = supplier?.name ?? 'Parceiro'
    const grossTotal = Number(oc.gross_total ?? 0)
    const netTotal = Number(oc.net_total ?? 0)
    const itemsCount = Number(oc.items_count ?? 0)
    const dueDate = oc.due_date as string

    // 4. Envia e-mail
    const subject = `Nova OC ${ocNumber} — ${itemsCount} itens · R$ ${netTotal.toFixed(2)}`
    const body = `
<p>Olá <strong>${supplierName}</strong>,</p>
<p>Foi gerada uma nova Ordem de Compra dropship pra revisão e aprovação:</p>
<ul>
  <li><strong>OC:</strong> ${ocNumber}</li>
  <li><strong>Itens:</strong> ${itemsCount}</li>
  <li><strong>Total bruto:</strong> R$ ${grossTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</li>
  <li><strong>Total líquido:</strong> R$ ${netTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</li>
  <li><strong>Vencimento:</strong> ${new Date(dueDate).toLocaleDateString('pt-BR')}</li>
</ul>
<p>Acesse o portal abaixo pra revisar itens, aprovar ou contestar (link válido por ${PORTAL_TTL_HOURS}h):</p>
<p><a href="${portalUrl}" style="background:#00E5FF;color:#09090b;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:600;">Abrir OC no portal</a></p>
<p style="font-size:12px;color:#71717a;margin-top:24px;">Link direto: <a href="${portalUrl}">${portalUrl}</a></p>
`
    const emailRes = await this.emailSender.sendEmail({
      orgId,
      to: profile.notification_email,
      subject,
      body,
    })
    await supabaseAdmin
      .from('dropship_oc_notifications')
      .insert({
        organization_id: orgId,
        oc_id: ocId,
        channel: 'email',
        recipient: profile.notification_email,
        notification_type: 'oc_generated',
        subject,
        body,
        status: emailRes.success ? 'sent' : 'failed',
        sent_at: emailRes.success ? new Date().toISOString() : null,
        error_message: emailRes.error ?? null,
        provider_message_id: emailRes.messageId ?? null,
      })

    // 5. Envia WhatsApp se configurado
    //    Preferência: Baileys (gratuito) → Z-API → Meta Cloud
    let waStatus = 'skipped (sem whatsapp configurado)'
    if (profile.notification_whatsapp) {
      const waMessage = `Nova OC ${ocNumber} — ${itemsCount} itens, R$ ${netTotal.toFixed(2)}. Aprove em ${portalUrl}`
      let success = false
      let messageId: string | null = null
      let errMsg: string | null = null
      let provider = 'unknown'

      // Tentativa 1: canal whatsapp_free (Baileys) ativo na org
      const { data: freeChannel } = await supabaseAdmin
        .from('channels')
        .select('id')
        .eq('organization_id', orgId)
        .eq('channel_type', 'whatsapp_free')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (freeChannel) {
        try {
          const r = await this.baileys.sendMessage(
            freeChannel.id,
            profile.notification_whatsapp.replace(/\D/g, ''),  // só dígitos
            'text',
            { body: waMessage },
          )
          success = true
          messageId = r.message_id
          provider = 'baileys'
        } catch (e) {
          errMsg = e instanceof Error ? e.message : 'erro Baileys'
          this.logger.warn(`[oc-send] Baileys falhou, tentando Z-API/Meta: ${errMsg}`)
        }
      }

      // Tentativa 2 (fallback): WhatsAppSender (Z-API ou Meta Cloud)
      if (!success) {
        const waRes = await this.waSender.sendTextMessage({
          phone: profile.notification_whatsapp,
          message: waMessage,
        })
        success = waRes.success
        messageId = waRes.message_id ?? null
        if (!success && !errMsg) errMsg = waRes.error ?? null
        provider = success ? 'zapi-or-meta' : provider
      }

      await supabaseAdmin
        .from('dropship_oc_notifications')
        .insert({
          organization_id: orgId,
          oc_id: ocId,
          channel: 'whatsapp',
          recipient: profile.notification_whatsapp,
          notification_type: 'oc_generated',
          body: waMessage,
          status: success ? 'sent' : 'failed',
          sent_at: success ? new Date().toISOString() : null,
          error_message: errMsg,
          provider,
          provider_message_id: messageId,
        })
      waStatus = success ? `sent (${provider})` : `failed: ${errMsg}`
    }

    // 6. Atualiza status OC pra 'sent'
    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        status: 'sent',
        sent_to_partner_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', ocId)
      .eq('organization_id', orgId)

    return {
      session_id: session.id,
      portal_url: portalUrl,
      email_status: emailRes.success ? 'sent' : `failed: ${emailRes.error}`,
      whatsapp_status: waStatus,
    }
  }

  /** Histórico de notificações enviadas pra uma OC */
  async listNotifications(orgId: string, ocId: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_oc_notifications')
      .select('*')
      .eq('organization_id', orgId)
      .eq('oc_id', ocId)
      .order('created_at', { ascending: false })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  // ── Portal público (sem auth — token é o secret) ──────────────────────────

  /** Valida token + retorna session ativa */
  async validatePortalToken(token: string) {
    if (!token || token.length < 32) throw new ForbiddenException('Token inválido')
    const { data: session } = await supabaseAdmin
      .from('dropship_partner_portal_sessions')
      .select('*')
      .eq('access_token', token)
      .eq('status', 'active')
      .maybeSingle()
    if (!session) throw new ForbiddenException('Token inválido ou expirado')
    if (new Date(session.expires_at) < new Date()) {
      // Marca como expired
      await supabaseAdmin
        .from('dropship_partner_portal_sessions')
        .update({ status: 'expired' })
        .eq('id', session.id)
      throw new ForbiddenException('Sessão expirada — solicite novo link ao seller')
    }
    return session
  }

  /** Visualiza OC via token (registra IP+user_agent) */
  async viewOCByToken(token: string, ip: string | null, userAgent: string | null) {
    const session = await this.validatePortalToken(token)

    // Update activity (idempotente, só array_append)
    const ips = Array.from(new Set([...(session.ip_addresses ?? []), ip].filter(Boolean) as string[]))
    const uas = Array.from(new Set([...(session.user_agents ?? []), userAgent].filter(Boolean) as string[]))
    await supabaseAdmin
      .from('dropship_partner_portal_sessions')
      .update({
        first_accessed_at: session.first_accessed_at ?? new Date().toISOString(),
        last_accessed_at: new Date().toISOString(),
        access_count: (session.access_count ?? 0) + 1,
        ip_addresses: ips,
        user_agents: uas,
      })
      .eq('id', session.id)

    // Marca OC como 'viewed' se ainda não estava
    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        status: 'viewed',
        partner_viewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.oc_id)
      .in('status', ['sent'])  // só transition de sent → viewed

    // Busca OC + items
    const { data: oc } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select(`
        id, oc_number, marketplace, marketplace_account_label,
        reference_date, generation_date, due_date,
        items_count, units_count, gross_total, total_credits,
        return_credits, cancellation_credits, warranty_credits,
        divergence_credits, other_credits, net_total, status,
        partner_viewed_at, partner_approved_at,
        notes,
        suppliers(name, legal_name, tax_id, payment_terms, payment_method)
      `)
      .eq('id', session.oc_id)
      .maybeSingle()
    if (!oc) throw new NotFoundException('OC não encontrada')

    const { data: items } = await supabaseAdmin
      .from('dropship_purchase_order_items')
      .select(`
        id, partner_sku, master_sku, product_name, variation_label,
        quantity, unit_cost, packaging_cost, handling_cost, line_total,
        marketplace, ml_order_id, sale_date, logistic_type, status,
        products(name, photo_urls)
      `)
      .eq('oc_id', session.oc_id)
      .order('sale_date', { ascending: true })

    return {
      oc,
      items: items ?? [],
      session: {
        can_approve: session.can_approve,
        can_dispute: session.can_dispute,
        expires_at: session.expires_at,
        approved_at: session.approved_at,
        rejected_at: session.rejected_at,
      },
    }
  }

  /** Aprovar OC via portal (parceiro) */
  async approveOCByToken(token: string, body: {
    approver_name: string;
    approver_email: string;
    notes?: string;
  }) {
    const session = await this.validatePortalToken(token)
    if (!session.can_approve) throw new ForbiddenException('Sem permissão pra aprovar')
    if (session.approved_at || session.rejected_at) {
      throw new BadRequestException('OC já foi processada')
    }
    if (!body.approver_name?.trim() || !body.approver_email?.trim()) {
      throw new BadRequestException('Nome e e-mail do aprovador são obrigatórios')
    }

    const now = new Date().toISOString()
    const newStatus = body.notes?.trim() ? 'approved_with_notes' : 'approved'

    await supabaseAdmin
      .from('dropship_partner_portal_sessions')
      .update({
        approved_at: now,
        approver_name: body.approver_name.trim(),
        approver_email: body.approver_email.trim(),
        status: 'used',
      })
      .eq('id', session.id)

    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        status: newStatus,
        partner_approved_at: now,
        partner_approved_by_name: body.approver_name.trim(),
        partner_approved_by_email: body.approver_email.trim(),
        partner_approval_notes: body.notes?.trim() ?? null,
        updated_at: now,
      })
      .eq('id', session.oc_id)

    // Side-effect: cria conta a pagar automaticamente (idempotente)
    try {
      await this.createPayableForOC(session.organization_id, session.oc_id)
    } catch (e) {
      this.logger.warn(`[approve] criar payable falhou: ${e instanceof Error ? e.message : e}`)
      // Não falha a aprovação — admin pode criar payable manualmente
    }

    return { ok: true, message: 'OC aprovada com sucesso' }
  }

  /** Cria payable a partir de OC aprovada (idempotente) */
  private async createPayableForOC(orgId: string, ocId: string) {
    const { data: oc } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select(`
        id, oc_number, supplier_id, marketplace, marketplace_account_label,
        net_total, due_date, payable_id,
        suppliers(name, tax_id)
      `)
      .eq('id', ocId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!oc) return
    if (oc.payable_id) return  // já tem payable vinculado

    const supRaw = oc.suppliers as unknown
    const sup = (Array.isArray(supRaw) ? supRaw[0] : supRaw) as { name: string; tax_id: string | null } | null
    if (!sup) return

    const payable = await this.financeiro.createPayableFromSource({
      organization_id: orgId,
      source_type: 'dropship_oc',
      source_id: ocId,
      description: `OC ${oc.oc_number} · ${oc.marketplace_account_label ?? oc.marketplace}`,
      amount: Number(oc.net_total),
      due_date: oc.due_date as string,
      beneficiary_name: sup.name,
      supplier_id: oc.supplier_id as string,
      beneficiary_doc: sup.tax_id ?? null,
      category: 'CMV Dropship',
      metadata: { oc_id: ocId, oc_number: oc.oc_number },
    })

    // Atualiza oc.payable_id + status='in_payable'
    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        payable_id: payable.id,
        status: 'in_payable',
        updated_at: new Date().toISOString(),
      })
      .eq('id', ocId)
  }

  /** Rejeitar OC via portal */
  async rejectOCByToken(token: string, body: {
    approver_name: string;
    approver_email: string;
    reason: string;
  }) {
    const session = await this.validatePortalToken(token)
    if (session.approved_at || session.rejected_at) {
      throw new BadRequestException('OC já foi processada')
    }
    if (!body.reason?.trim()) throw new BadRequestException('Motivo da rejeição é obrigatório')

    const now = new Date().toISOString()
    await supabaseAdmin
      .from('dropship_partner_portal_sessions')
      .update({
        rejected_at: now,
        approver_name: body.approver_name?.trim() ?? null,
        approver_email: body.approver_email?.trim() ?? null,
        status: 'used',
      })
      .eq('id', session.id)

    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        status: 'rejected',
        partner_rejection_reason: body.reason.trim(),
        updated_at: now,
      })
      .eq('id', session.oc_id)

    return { ok: true, message: 'OC rejeitada — seller será notificado' }
  }

  /** Prévia: quais OCs SERIAM geradas se o cron rodasse agora */
  async previewOCs(orgId: string) {
    const { data: idents } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select(`
        id, supplier_id, supplier_product_id, marketplace,
        partner_sku, master_sku, quantity, sale_price, identified_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .in('dropship_status', ['eligible_for_oc', 'shipped_confirmed'])
      .is('oc_id', null)
      .limit(500)

    if (!idents || idents.length === 0) return { groups: [], total_idents: 0 }

    // Pré-busca supplier_products pra cost preview
    const supProductIds = [...new Set(idents.map(i => i.supplier_product_id).filter(Boolean) as string[])]
    const { data: supProducts } = supProductIds.length > 0
      ? await supabaseAdmin
          .from('supplier_products')
          .select('id, unit_cost, partner_packaging_cost, partner_handling_cost')
          .in('id', supProductIds)
      : { data: [] }
    const ppById = new Map((supProducts ?? []).map(p => [p.id, p]))

    // Agrupa por (supplier, marketplace)
    type Group = {
      supplier_id: string;
      supplier_name: string;
      marketplace: string;
      items_count: number;
      units_count: number;
      gross_total: number;
    }
    const groups = new Map<string, Group>()
    for (const i of idents) {
      const supRaw = i.suppliers as unknown
      const sup = (Array.isArray(supRaw) ? supRaw[0] : supRaw) as { id: string; name: string } | null
      const supplierName = sup?.name ?? '—'
      const key = `${i.supplier_id}:${i.marketplace}`
      const pp = i.supplier_product_id ? ppById.get(i.supplier_product_id) : null
      const unit = Number(pp?.unit_cost ?? 0)
        + Number(pp?.partner_packaging_cost ?? 0)
        + Number(pp?.partner_handling_cost ?? 0)
      const lineTotal = unit * Number(i.quantity ?? 0)

      if (!groups.has(key)) {
        groups.set(key, {
          supplier_id: i.supplier_id,
          supplier_name: supplierName,
          marketplace: i.marketplace,
          items_count: 0,
          units_count: 0,
          gross_total: 0,
        })
      }
      const agg = groups.get(key)!
      agg.items_count++
      agg.units_count += Number(i.quantity ?? 0)
      agg.gross_total += lineTotal
    }

    return {
      groups: Array.from(groups.values()).sort((a, b) => b.gross_total - a.gross_total),
      total_idents: idents.length,
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 8 — DEVOLUÇÕES E CANCELAMENTOS (CRUD + classificação)
  // ══════════════════════════════════════════════════════════════════════════

  async createReturn(orgId: string, dto: CreateReturnDto) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id é obrigatório')
    if (!dto.marketplace) throw new BadRequestException('marketplace é obrigatório')
    if (!dto.return_type) throw new BadRequestException('return_type é obrigatório')
    if (typeof dto.return_amount !== 'number' || dto.return_amount < 0) {
      throw new BadRequestException('return_amount inválido')
    }
    if (typeof dto.return_quantity !== 'number' || dto.return_quantity <= 0) {
      throw new BadRequestException('return_quantity deve ser > 0')
    }

    // Resolve identification + OC original se fornecido
    let originalOcId: string | null = null
    let originalOcItemId: string | null = null
    let mlPackId = dto.ml_pack_id ?? null
    let mlOrderId = dto.ml_order_id ?? null

    if (dto.identification_id) {
      const { data: ident } = await supabaseAdmin
        .from('dropship_order_identifications')
        .select('oc_id, ml_pack_id, ml_order_id, ml_shipment_id, supplier_id')
        .eq('id', dto.identification_id)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (!ident) throw new NotFoundException('Identification não encontrada')
      originalOcId = ident.oc_id ?? null
      mlPackId = mlPackId ?? ident.ml_pack_id
      mlOrderId = mlOrderId ?? ident.ml_order_id

      // Resolve oc_item_id se OC existe
      if (originalOcId) {
        const { data: ocItem } = await supabaseAdmin
          .from('dropship_purchase_order_items')
          .select('id')
          .eq('oc_id', originalOcId)
          .eq('identification_id', dto.identification_id)
          .maybeSingle()
        originalOcItemId = ocItem?.id ?? null
      }
    }

    // Default responsibility: partner (padrão dropship — parceiro absorve a menos
    // que seja arrependimento do comprador, em que vai pra buyer)
    const defaultResp: Responsibility =
      dto.return_type === 'return_buyer_regret' ? 'buyer' :
      'partner'
    const responsibility = dto.responsibility ?? defaultResp

    const { data, error } = await supabaseAdmin
      .from('dropship_returns')
      .insert({
        organization_id: orgId,
        supplier_id: dto.supplier_id,
        identification_id: dto.identification_id ?? null,
        ml_pack_id: mlPackId,
        ml_order_id: mlOrderId,
        shopee_order_id: dto.shopee_order_id ?? null,
        marketplace: dto.marketplace,
        original_oc_id: originalOcId,
        original_oc_item_id: originalOcItemId,
        return_type: dto.return_type,
        source: dto.source ?? 'manual',
        external_id: dto.external_id ?? null,
        return_amount: dto.return_amount,
        return_quantity: dto.return_quantity,
        responsibility,
        status: 'opened',
        buyer_complaint: dto.buyer_complaint ?? null,
        internal_notes: dto.internal_notes ?? null,
        evidence_urls: dto.evidence_urls ?? [],
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async listReturns(orgId: string, filters: {
    supplier_id?: string;
    status?: string;
    marketplace?: string;
    return_type?: string;
    q?: string;
  }) {
    let query = supabaseAdmin
      .from('dropship_returns')
      .select(`
        id, marketplace, ml_order_id, shopee_order_id,
        return_type, source, return_amount, return_quantity,
        responsibility, status, credit_strategy, credit_amount,
        credit_applied_oc_id, credit_applied_at,
        buyer_complaint, opened_at, resolved_at,
        original_oc_id, identification_id,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('opened_at', { ascending: false })
      .limit(200)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) {
      const arr = filters.status.split(',')
      query = arr.length > 1 ? query.in('status', arr) : query.eq('status', filters.status)
    }
    if (filters.marketplace) query = query.eq('marketplace', filters.marketplace)
    if (filters.return_type) query = query.eq('return_type', filters.return_type)
    if (filters.q) query = query.or(`ml_order_id.ilike.%${filters.q}%,shopee_order_id.ilike.%${filters.q}%`)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getReturn(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_returns')
      .select(`
        *,
        suppliers(id, name, legal_name, tax_id),
        original_oc:dropship_purchase_orders!original_oc_id(id, oc_number, status, net_total)
      `)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Devolução não encontrada')
    return data
  }

  async updateReturn(orgId: string, id: string, dto: UpdateReturnDto) {
    const existing = await this.getReturn(orgId, id) as Record<string, unknown>
    if (existing.status === 'credit_applied' || existing.status === 'closed' || existing.status === 'rejected') {
      throw new BadRequestException(`Não pode editar devolução já ${existing.status}`)
    }
    const patch: Record<string, unknown> = {}
    const fields = [
      'status', 'responsibility', 'internal_notes', 'partner_response',
      'resolution_notes', 'evidence_urls',
      'marketplace_return_status', 'marketplace_refund_amount',
    ] as const
    const dtoRec = dto as Record<string, unknown>
    for (const k of fields) if (dtoRec[k] !== undefined) patch[k] = dtoRec[k]
    if (Object.keys(patch).length === 0) return existing

    patch.updated_at = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('dropship_returns')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async rejectReturn(orgId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo obrigatório')
    const existing = await this.getReturn(orgId, id) as Record<string, unknown>
    if (existing.status === 'credit_applied') {
      throw new BadRequestException('Crédito já foi aplicado, não pode rejeitar')
    }
    const { error } = await supabaseAdmin
      .from('dropship_returns')
      .update({
        status: 'rejected',
        resolution_notes: reason.trim(),
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 9 — RÉGUA DE CRÉDITO (4 CENÁRIOS)
  // ══════════════════════════════════════════════════════════════════════════

  /** Aprova devolução: identifica cenário + dispara aplicação de crédito */
  async approveReturn(orgId: string, id: string, dto: ApproveReturnDto) {
    const ret = await this.getReturn(orgId, id) as Record<string, unknown>
    if (ret.status === 'credit_applied' || ret.status === 'closed') {
      throw new BadRequestException('Devolução já processada')
    }

    // Atualiza responsibility se passado
    const patch: Record<string, unknown> = {
      status: 'approved',
      updated_at: new Date().toISOString(),
    }
    if (dto.responsibility) patch.responsibility = dto.responsibility
    if (dto.resolution_notes) patch.resolution_notes = dto.resolution_notes
    await supabaseAdmin
      .from('dropship_returns')
      .update(patch)
      .eq('id', id)

    // Re-busca pra ter responsibility atualizada
    const updated = await this.getReturn(orgId, id) as Record<string, unknown>

    // Identifica cenário
    const scenario = await this.identifyCreditScenario(updated)

    // Aplica conforme cenário
    return await this.applyReturnCredit(orgId, updated, scenario)
  }

  /** Identifica em qual dos 4 cenários a devolução se encaixa */
  private async identifyCreditScenario(ret: Record<string, unknown>): Promise<CreditScenario> {
    if (ret.responsibility !== 'partner' && ret.responsibility !== 'shared') {
      // Se responsabilidade não é do parceiro, não gera crédito
      return 'pending_dispute'
    }

    const ocId = ret.original_oc_id as string | null
    if (!ocId) {
      // Sem OC = item ainda não foi pra OC → trata como same_oc_unpaid (remove direto)
      return 'same_oc_unpaid'
    }

    const { data: oc } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select('status')
      .eq('id', ocId)
      .maybeSingle()
    if (!oc) return 'pending_dispute'

    if (['draft', 'preview_locked'].includes(oc.status as string)) return 'same_oc_unpaid'
    if (['generated', 'sent', 'viewed', 'approved', 'approved_with_notes', 'rejected', 'on_hold'].includes(oc.status as string)) {
      return 'same_oc_approved_unpaid'
    }
    if (['in_payable', 'paid', 'partially_paid'].includes(oc.status as string)) {
      return 'next_oc_credit'
    }
    return 'pending_dispute'
  }

  /** Aplica crédito conforme cenário */
  private async applyReturnCredit(
    orgId: string,
    ret: Record<string, unknown>,
    scenario: CreditScenario,
  ): Promise<{ scenario: CreditScenario; credit_id?: string; oc_id?: string; amount: number }> {
    const now = new Date().toISOString()
    const returnAmount = Number(ret.return_amount ?? 0)
    const supplierId = ret.supplier_id as string

    // Aplica responsibility split se shared (50/50 default)
    let creditAmount = returnAmount
    if (ret.responsibility === 'shared') {
      const split = ret.responsibility_split as { partner_pct?: number } | null
      const pct = split?.partner_pct ?? 50
      creditAmount = (returnAmount * pct) / 100
    }

    if (scenario === 'pending_dispute') {
      await supabaseAdmin
        .from('dropship_returns')
        .update({
          status: 'disputed',
          credit_strategy: 'pending_dispute',
          credit_amount: 0,
          updated_at: now,
        })
        .eq('id', ret.id as string)
      return { scenario, amount: 0 }
    }

    if (scenario === 'same_oc_unpaid') {
      // Item ainda em OC draft/preview_locked OU sem OC — só remove
      const ocItemId = ret.original_oc_item_id as string | null
      if (ocItemId) {
        await supabaseAdmin
          .from('dropship_purchase_order_items')
          .update({ status: 'excluded' })
          .eq('id', ocItemId)
        // Recalcula totais da OC
        await this.recalculateOCTotals(ret.original_oc_id as string)
      }
      // Marca identification como returned
      if (ret.identification_id) {
        await supabaseAdmin
          .from('dropship_order_identifications')
          .update({ dropship_status: 'returned', updated_at: now })
          .eq('id', ret.identification_id as string)
      }
      await supabaseAdmin
        .from('dropship_returns')
        .update({
          status: 'closed',
          credit_strategy: 'same_oc_unpaid',
          credit_amount: 0,
          resolved_at: now,
          updated_at: now,
        })
        .eq('id', ret.id as string)
      return { scenario, amount: 0 }
    }

    if (scenario === 'same_oc_approved_unpaid') {
      // OC já está em status sent/viewed/approved (não paga) — gera crédito DENTRO da OC
      const ocItemId = ret.original_oc_item_id as string | null
      const ocId = ret.original_oc_id as string
      if (ocItemId) {
        await supabaseAdmin
          .from('dropship_purchase_order_items')
          .update({ status: 'credited' })
          .eq('id', ocItemId)
      }
      // Atualiza credits da OC
      const creditField = this.mapReturnTypeToCreditField(ret.return_type as string)
      const { data: oc } = await supabaseAdmin
        .from('dropship_purchase_orders')
        .select(`gross_total, return_credits, cancellation_credits, warranty_credits, divergence_credits, other_credits`)
        .eq('id', ocId)
        .maybeSingle()
      if (oc) {
        const updates: Record<string, unknown> = {
          [creditField]: Number((oc as Record<string, unknown>)[creditField] ?? 0) + creditAmount,
          updated_at: now,
        }
        // Recalcula net_total
        const totalCredits =
          Number(oc.return_credits ?? 0) + Number(oc.cancellation_credits ?? 0) +
          Number(oc.warranty_credits ?? 0) + Number(oc.divergence_credits ?? 0) +
          Number(oc.other_credits ?? 0)
        // Adiciona o novo crédito ao total
        const newTotalCredits = totalCredits + creditAmount
        updates.net_total = Number(oc.gross_total ?? 0) - newTotalCredits
        await supabaseAdmin
          .from('dropship_purchase_orders')
          .update(updates)
          .eq('id', ocId)
      }
      // Marca identification como returned
      if (ret.identification_id) {
        await supabaseAdmin
          .from('dropship_order_identifications')
          .update({ dropship_status: 'returned', updated_at: now })
          .eq('id', ret.identification_id as string)
      }
      await supabaseAdmin
        .from('dropship_returns')
        .update({
          status: 'credit_applied',
          credit_strategy: 'same_oc_approved_unpaid',
          credit_amount: creditAmount,
          credit_applied_oc_id: ocId,
          credit_applied_at: now,
          resolved_at: now,
          updated_at: now,
        })
        .eq('id', ret.id as string)
      return { scenario, oc_id: ocId, amount: creditAmount }
    }

    // next_oc_credit: cria saldo de crédito pra próxima OC
    const { data: credit, error: cErr } = await supabaseAdmin
      .from('dropship_partner_credits')
      .insert({
        organization_id: orgId,
        supplier_id: supplierId,
        return_id: ret.id,
        source_oc_id: ret.original_oc_id,
        credit_amount: creditAmount,
        credit_type: this.mapReturnTypeToCreditType(ret.return_type as string),
        status: 'pending',
        notes: `Crédito gerado por devolução em OC ${ret.original_oc_id}`,
      })
      .select('id')
      .single()
    if (cErr) throw new HttpException(cErr.message, 500)

    // Marca identification como returned
    if (ret.identification_id) {
      await supabaseAdmin
        .from('dropship_order_identifications')
        .update({ dropship_status: 'returned', updated_at: now })
        .eq('id', ret.identification_id as string)
    }
    await supabaseAdmin
      .from('dropship_returns')
      .update({
        status: 'credit_pending',
        credit_strategy: 'next_oc_credit',
        credit_amount: creditAmount,
        updated_at: now,
      })
      .eq('id', ret.id as string)

    return { scenario, credit_id: credit.id, amount: creditAmount }
  }

  /** Recalcula items_count, units_count, gross_total, net_total da OC.
   *  Chamado após excluir/creditar item. */
  private async recalculateOCTotals(ocId: string) {
    const { data: items } = await supabaseAdmin
      .from('dropship_purchase_order_items')
      .select('quantity, line_total, status')
      .eq('oc_id', ocId)
    const validItems = (items ?? []).filter(i => ['included', 'pending_credit'].includes(i.status as string))
    const itemsCount = validItems.length
    const unitsCount = validItems.reduce((s, i) => s + Number(i.quantity ?? 0), 0)
    const grossTotal = validItems.reduce((s, i) => s + Number(i.line_total ?? 0), 0)

    const { data: oc } = await supabaseAdmin
      .from('dropship_purchase_orders')
      .select(`return_credits, cancellation_credits, warranty_credits, divergence_credits, other_credits`)
      .eq('id', ocId)
      .maybeSingle()
    const totalCredits = oc
      ? Number(oc.return_credits ?? 0) + Number(oc.cancellation_credits ?? 0) +
        Number(oc.warranty_credits ?? 0) + Number(oc.divergence_credits ?? 0) +
        Number(oc.other_credits ?? 0)
      : 0
    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        items_count: itemsCount,
        units_count: unitsCount,
        gross_total: grossTotal,
        net_total: grossTotal - totalCredits,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ocId)
  }

  private mapReturnTypeToCreditField(returnType: string): string {
    switch (returnType) {
      case 'cancellation':
        return 'cancellation_credits'
      case 'warranty_claim':
        return 'warranty_credits'
      case 'partner_negotiated':
        return 'other_credits'
      default:
        return 'return_credits'
    }
  }

  private mapReturnTypeToCreditType(returnType: string): string {
    switch (returnType) {
      case 'cancellation':
        return 'cancellation'
      case 'warranty_claim':
        return 'warranty'
      case 'partner_negotiated':
        return 'negotiated_discount'
      default:
        return 'return'
    }
  }

  // ── Credits queries ───────────────────────────────────────────────────────

  async listCredits(orgId: string, filters: { supplier_id?: string; status?: string }) {
    let query = supabaseAdmin
      .from('dropship_partner_credits')
      .select(`
        id, credit_amount, credit_type, status,
        applied_to_oc_id, applied_amount, remaining_amount, applied_at,
        return_id, source_oc_id, manual_adjustment,
        notes, expires_at, created_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) query = query.eq('status', filters.status)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getPendingCreditsBalance(orgId: string, supplierId: string): Promise<number> {
    const { data } = await supabaseAdmin
      .from('dropship_partner_credits')
      .select('remaining_amount')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .eq('status', 'pending')
    return (data ?? []).reduce((s, c) => s + Number(c.remaining_amount ?? 0), 0)
  }

  /** Aplica créditos pendentes do parceiro numa OC (chamado em generateDailyOCs).
   *  Usa créditos até zerar gross_total ou esgotar saldo. */
  private async applyPendingCreditsToOC(orgId: string, ocId: string, supplierId: string, ocGross: number) {
    if (ocGross <= 0) return
    const { data: pendingCredits } = await supabaseAdmin
      .from('dropship_partner_credits')
      .select('id, credit_amount, applied_amount, credit_type')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })  // FIFO

    if (!pendingCredits || pendingCredits.length === 0) return

    let remaining = ocGross
    let totalApplied = 0
    const byType: Record<string, number> = {
      return_credits: 0, cancellation_credits: 0, warranty_credits: 0,
      divergence_credits: 0, other_credits: 0,
    }
    const now = new Date().toISOString()

    for (const credit of pendingCredits) {
      if (remaining <= 0) break
      const creditRemaining = Number(credit.credit_amount) - Number(credit.applied_amount ?? 0)
      const apply = Math.min(creditRemaining, remaining)
      if (apply <= 0) continue

      // Atualiza credit
      const newApplied = Number(credit.applied_amount ?? 0) + apply
      const isFullyUsed = Math.abs(Number(credit.credit_amount) - newApplied) < 0.01
      await supabaseAdmin
        .from('dropship_partner_credits')
        .update({
          status: isFullyUsed ? 'applied' : 'partially_applied',
          applied_to_oc_id: ocId,
          applied_amount: newApplied,
          applied_at: now,
          updated_at: now,
        })
        .eq('id', credit.id)

      const field = this.creditTypeToOCField(credit.credit_type as string)
      byType[field] += apply
      totalApplied += apply
      remaining -= apply
    }

    if (totalApplied === 0) return

    // Atualiza OC
    await supabaseAdmin
      .from('dropship_purchase_orders')
      .update({
        return_credits: byType.return_credits,
        cancellation_credits: byType.cancellation_credits,
        warranty_credits: byType.warranty_credits,
        divergence_credits: byType.divergence_credits,
        other_credits: byType.other_credits,
        net_total: ocGross - totalApplied,
        updated_at: now,
      })
      .eq('id', ocId)
  }

  private creditTypeToOCField(creditType: string): string {
    switch (creditType) {
      case 'cancellation':
        return 'cancellation_credits'
      case 'warranty':
        return 'warranty_credits'
      case 'divergence':
        return 'divergence_credits'
      case 'negotiated_discount':
      case 'manual_adjustment':
      case 'previous_payment':
        return 'other_credits'
      default:
        return 'return_credits'
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 10 — DISPUTAS
  // ══════════════════════════════════════════════════════════════════════════

  async createDispute(orgId: string, userId: string | null, dto: CreateDisputeDto) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id obrigatório')
    if (!dto.dispute_type) throw new BadRequestException('Tipo obrigatório')
    if (!dto.claimed_by) throw new BadRequestException('claimed_by obrigatório')
    if (!dto.reason?.trim()) throw new BadRequestException('Motivo obrigatório')

    // Resolve oc_id via oc_item_id se não fornecido
    let ocId = dto.oc_id ?? null
    if (!ocId && dto.oc_item_id) {
      const { data: item } = await supabaseAdmin
        .from('dropship_purchase_order_items')
        .select('oc_id')
        .eq('id', dto.oc_item_id)
        .maybeSingle()
      ocId = item?.oc_id ?? null
    }
    // Resolve oc_id via return_id
    if (!ocId && dto.return_id) {
      const { data: ret } = await supabaseAdmin
        .from('dropship_returns')
        .select('original_oc_id')
        .eq('id', dto.return_id)
        .maybeSingle()
      ocId = ret?.original_oc_id ?? null
    }

    const { data, error } = await supabaseAdmin
      .from('dropship_disputes')
      .insert({
        organization_id: orgId,
        supplier_id: dto.supplier_id,
        return_id: dto.return_id ?? null,
        oc_item_id: dto.oc_item_id ?? null,
        oc_id: ocId,
        dispute_type: dto.dispute_type,
        claimed_by: dto.claimed_by,
        claimed_by_name: dto.claimed_by_name ?? null,
        reason: dto.reason.trim(),
        description: dto.description ?? null,
        amount_claimed: dto.amount_claimed ?? null,
        amount_partner_accepts: dto.amount_partner_accepts ?? null,
        amount_seller_proposes: dto.amount_seller_proposes ?? null,
        evidence_urls: dto.evidence_urls ?? [],
        status: 'open',
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    // Side-effect: se dispute vincula a uma return, atualiza return.status='disputed'
    if (dto.return_id) {
      await supabaseAdmin
        .from('dropship_returns')
        .update({ status: 'disputed', updated_at: new Date().toISOString() })
        .eq('id', dto.return_id)
        .eq('organization_id', orgId)
    }

    return data
  }

  async listDisputes(orgId: string, filters: {
    supplier_id?: string;
    status?: string;
    dispute_type?: string;
    claimed_by?: string;
  }) {
    let query = supabaseAdmin
      .from('dropship_disputes')
      .select(`
        id, dispute_type, claimed_by, claimed_by_name, claimed_at,
        amount_claimed, amount_partner_accepts, amount_seller_proposes,
        final_resolved_amount, reason, status,
        return_id, oc_item_id, oc_id,
        resolution, resolved_at,
        created_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('claimed_at', { ascending: false })
      .limit(200)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) {
      const arr = filters.status.split(',')
      query = arr.length > 1 ? query.in('status', arr) : query.eq('status', filters.status)
    }
    if (filters.dispute_type) query = query.eq('dispute_type', filters.dispute_type)
    if (filters.claimed_by) query = query.eq('claimed_by', filters.claimed_by)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getDispute(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_disputes')
      .select(`
        *,
        suppliers(id, name, legal_name, tax_id)
      `)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Disputa não encontrada')
    return data
  }

  async updateDispute(orgId: string, id: string, dto: UpdateDisputeDto) {
    const existing = await this.getDispute(orgId, id) as Record<string, unknown>
    const status = existing.status as string
    if (['resolved_partner', 'resolved_seller', 'resolved_compromise', 'closed'].includes(status)) {
      throw new BadRequestException(`Disputa já ${status}`)
    }
    const patch: Record<string, unknown> = {}
    const fields = [
      'status', 'description', 'amount_partner_accepts',
      'amount_seller_proposes', 'evidence_urls',
    ] as const
    const dtoRec = dto as Record<string, unknown>
    for (const k of fields) if (dtoRec[k] !== undefined) patch[k] = dtoRec[k]
    if (Object.keys(patch).length === 0) return existing
    patch.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('dropship_disputes')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async resolveDispute(orgId: string, userId: string | null, id: string, dto: ResolveDisputeDto) {
    const existing = await this.getDispute(orgId, id) as Record<string, unknown>
    const status = existing.status as string
    if (['resolved_partner', 'resolved_seller', 'resolved_compromise', 'closed'].includes(status)) {
      throw new BadRequestException(`Disputa já ${status}`)
    }
    if (!dto.resolution?.trim()) throw new BadRequestException('Texto de resolução obrigatório')
    const valid = ['resolved_partner', 'resolved_seller', 'resolved_compromise']
    if (!valid.includes(dto.resolution_type)) {
      throw new BadRequestException(`resolution_type inválido (use ${valid.join('/')})`)
    }

    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('dropship_disputes')
      .update({
        status: dto.resolution_type,
        final_resolved_amount: dto.final_resolved_amount ?? null,
        resolution: dto.resolution.trim(),
        resolved_by: userId,
        resolved_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    // Side-effect: se disputa vinculada a return, retorna o return ao status apropriado
    if (existing.return_id) {
      const newReturnStatus =
        dto.resolution_type === 'resolved_partner' ? 'approved' :
        dto.resolution_type === 'resolved_seller' ? 'rejected' :
        'analyzed'  // compromise — operador decide depois
      await supabaseAdmin
        .from('dropship_returns')
        .update({ status: newReturnStatus, updated_at: now })
        .eq('id', existing.return_id as string)
    }

    return data
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 11 — SCORE DO PARCEIRO v1 (5 dimensões × 20 = 100 pts)
  // ══════════════════════════════════════════════════════════════════════════

  /** Cron @00:30 dia 1 do mês: calcula score do mês anterior pra todas orgs */
  @Cron('30 0 1 * *', { name: 'dropship-monthly-scores', timeZone: 'America/Sao_Paulo' })
  async monthlyScoresTick() {
    try {
      const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
      for (const org of orgs ?? []) {
        try {
          const r = await this.recalculateAllScores(org.id)
          if (r.calculated > 0) {
            this.logger.log(`[scores] org=${org.id} calculados=${r.calculated}`)
          }
        } catch (e) {
          this.logger.warn(`[scores] org=${org.id}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      this.logger.error(`[scores] tick: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Recalcula scores de todos parceiros ativos da org */
  async recalculateAllScores(orgId: string): Promise<{ calculated: number }> {
    const { data: profiles } = await supabaseAdmin
      .from('supplier_dropship_profiles')
      .select('supplier_id')
      .eq('organization_id', orgId)
      .eq('dropship_status', 'active')
    if (!profiles || profiles.length === 0) return { calculated: 0 }

    const today = new Date()
    const periodEnd = new Date(today.getFullYear(), today.getMonth(), 1)  // 1º do mês atual
    const periodStart = new Date(periodEnd)
    periodStart.setMonth(periodStart.getMonth() - 1)  // 1º do mês anterior

    let calculated = 0
    for (const p of profiles) {
      try {
        await this.calculatePartnerScore(orgId, p.supplier_id, periodStart, periodEnd)
        calculated++
      } catch (e) {
        this.logger.warn(`[scores] supplier ${p.supplier_id}: ${e instanceof Error ? e.message : e}`)
      }
    }
    return { calculated }
  }

  async calculatePartnerScore(
    orgId: string,
    supplierId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Record<string, unknown>> {
    const startIso = periodStart.toISOString()
    const endIso = periodEnd.toISOString()

    // 1. Métricas brutas
    const [
      { count: skusCount },
      { count: oosCount },
      { data: orders },
      { data: returns },
      { data: ocs },
    ] = await Promise.all([
      supabaseAdmin
        .from('supplier_products')
        .select('id', { count: 'exact', head: true })
        .eq('supplier_id', supplierId)
        .eq('dropship_status', 'active'),
      supabaseAdmin
        .from('supplier_products')
        .select('id', { count: 'exact', head: true })
        .eq('supplier_id', supplierId)
        .eq('dropship_status', 'active')
        .lte('partner_stock', 0),
      supabaseAdmin
        .from('dropship_order_identifications')
        .select('id, dropship_status, identified_at, shipped_at')
        .eq('organization_id', orgId)
        .eq('supplier_id', supplierId)
        .gte('identified_at', startIso)
        .lt('identified_at', endIso),
      supabaseAdmin
        .from('dropship_returns')
        .select('id')
        .eq('organization_id', orgId)
        .eq('supplier_id', supplierId)
        .eq('status', 'credit_applied')
        .gte('opened_at', startIso)
        .lt('opened_at', endIso),
      supabaseAdmin
        .from('dropship_purchase_orders')
        .select('id, sent_to_partner_at, partner_approved_at')
        .eq('organization_id', orgId)
        .eq('supplier_id', supplierId)
        .not('sent_to_partner_at', 'is', null)
        .gte('reference_date', periodStart.toISOString().slice(0, 10))
        .lt('reference_date', periodEnd.toISOString().slice(0, 10)),
    ])

    // Divergences é Sprint 12 — pode não existir ainda; default 0
    let divergencesCnt = 0
    try {
      const { count } = await supabaseAdmin
        .from('dropship_divergences')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('supplier_id', supplierId)
        .gte('detected_at', startIso)
        .lt('detected_at', endIso)
      divergencesCnt = count ?? 0
    } catch { divergencesCnt = 0 }

    const activeSkus = skusCount ?? 0
    const oos = oosCount ?? 0
    const ordersTotal = (orders ?? []).length
    const ordersDelayed = (orders ?? []).filter(o => {
      // shipped_at > 2 dias após identified_at conta como atraso
      if (!o.shipped_at || !o.identified_at) return false
      const diffH = (new Date(o.shipped_at).getTime() - new Date(o.identified_at).getTime()) / 3600000
      return diffH > 48
    }).length
    const returnsCount = (returns ?? []).length

    // Avg approval hours
    let avgApprovalHours = 0
    let approvedCount = 0
    for (const oc of (ocs ?? [])) {
      if (oc.sent_to_partner_at && oc.partner_approved_at) {
        const h = (new Date(oc.partner_approved_at).getTime() - new Date(oc.sent_to_partner_at).getTime()) / 3600000
        avgApprovalHours += h
        approvedCount++
      }
    }
    avgApprovalHours = approvedCount > 0 ? avgApprovalHours / approvedCount : 0

    // 2. Score por dimensão (0-20 cada)
    const stockAccuracy = activeSkus === 0 ? 16
      : Math.round(20 * Math.max(0, (activeSkus - oos) / activeSkus))
    const shipLeadCompliance = ordersTotal === 0 ? 16
      : Math.round(20 * Math.max(0, (ordersTotal - ordersDelayed) / ordersTotal))
    const divergenceRate = ordersTotal === 0 ? 18
      : Math.round(20 * Math.max(0, 1 - (divergencesCnt / ordersTotal)))
    const returnRate = ordersTotal === 0 ? 18
      : Math.round(20 * Math.max(0, 1 - (returnsCount / ordersTotal)))
    const approvalSpeed = approvedCount === 0 ? 16
      : Math.round(Math.max(0, 20 - (avgApprovalHours / 24) * 5))  // 24h=15pts, 48h=10pts, etc.

    const breakdown = {
      stock_accuracy: stockAccuracy,
      ship_lead_compliance: shipLeadCompliance,
      divergence_rate: divergenceRate,
      return_rate: returnRate,
      approval_speed: approvalSpeed,
    }
    const totalScore = Math.min(100, Math.max(0,
      stockAccuracy + shipLeadCompliance + divergenceRate + returnRate + approvalSpeed,
    ))

    const rawMetrics = {
      active_skus: activeSkus,
      out_of_stock_skus: oos,
      orders_processed: ordersTotal,
      orders_delayed: ordersDelayed,
      delay_rate_pct: ordersTotal > 0 ? Math.round((ordersDelayed / ordersTotal) * 10000) / 100 : 0,
      returns_count: returnsCount,
      return_rate_pct: ordersTotal > 0 ? Math.round((returnsCount / ordersTotal) * 10000) / 100 : 0,
      divergences_count: divergencesCnt,
      ocs_sent: (ocs ?? []).length,
      ocs_approved: approvedCount,
      avg_approval_hours: Math.round(avgApprovalHours * 10) / 10,
    }

    // 3. Score anterior pra delta
    const { data: prev } = await supabaseAdmin
      .from('dropship_partner_scores')
      .select('total_score')
      .eq('supplier_id', supplierId)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle()

    // 4. Insights básicos (Sprint 12 melhora isso com IA)
    const insights = this.generateBasicInsights(breakdown, rawMetrics, prev?.total_score)

    // 5. Upsert (idempotente)
    const { data: score, error } = await supabaseAdmin
      .from('dropship_partner_scores')
      .upsert(
        {
          organization_id: orgId,
          supplier_id: supplierId,
          period_start: periodStart.toISOString().slice(0, 10),
          period_end: periodEnd.toISOString().slice(0, 10),
          total_score: totalScore,
          score_breakdown: breakdown,
          raw_metrics: rawMetrics,
          insights,
          prev_score: prev?.total_score ?? null,
          score_change: prev?.total_score != null ? totalScore - prev.total_score : null,
        },
        { onConflict: 'supplier_id,period_start,period_end', ignoreDuplicates: false },
      )
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    // 6. Atualiza profile com score atual
    await supabaseAdmin
      .from('supplier_dropship_profiles')
      .update({
        partner_score: totalScore,
        score_breakdown: breakdown,
        updated_at: new Date().toISOString(),
      })
      .eq('supplier_id', supplierId)

    return score
  }

  private generateBasicInsights(
    breakdown: Record<string, number>,
    metrics: Record<string, number>,
    prevScore: number | undefined,
  ): Array<{ type: string; message: string }> {
    const insights: Array<{ type: string; message: string }> = []

    if (breakdown.stock_accuracy < 14) {
      insights.push({
        type: 'warning',
        message: `Estoque baixo: ${metrics.out_of_stock_skus}/${metrics.active_skus} SKUs sem estoque`,
      })
    }
    if (breakdown.ship_lead_compliance < 14) {
      insights.push({
        type: 'warning',
        message: `${metrics.delay_rate_pct}% pedidos atrasaram (>48h pra despachar)`,
      })
    }
    if (breakdown.return_rate < 14) {
      insights.push({
        type: 'warning',
        message: `Taxa de devolução: ${metrics.return_rate_pct}%`,
      })
    }
    if (breakdown.approval_speed < 14 && metrics.ocs_approved > 0) {
      insights.push({
        type: 'warning',
        message: `Aprovação lenta: ${metrics.avg_approval_hours}h em média`,
      })
    }
    if (prevScore != null) {
      const total = Object.values(breakdown).reduce((s, v) => s + v, 0)
      const delta = total - prevScore
      if (delta >= 5) insights.push({ type: 'improvement', message: `Score subiu ${delta} pontos vs mês anterior` })
      if (delta <= -5) insights.push({ type: 'warning', message: `Score caiu ${Math.abs(delta)} pontos vs mês anterior` })
    }
    return insights
  }

  async listPartnerScores(orgId: string) {
    // Latest score por supplier
    const { data, error } = await supabaseAdmin
      .from('dropship_partner_scores')
      .select(`
        id, supplier_id, period_start, period_end,
        total_score, score_breakdown, prev_score, score_change,
        insights, calculated_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('calculated_at', { ascending: false })
      .limit(100)
    if (error) throw new HttpException(error.message, 500)

    // Filtra só o mais recente por supplier
    const seen = new Set<string>()
    const latest = (data ?? []).filter(s => {
      if (seen.has(s.supplier_id)) return false
      seen.add(s.supplier_id)
      return true
    })
    return latest.sort((a, b) => b.total_score - a.total_score)
  }

  async getPartnerScoreHistory(orgId: string, supplierId: string) {
    const { data, error } = await supabaseAdmin
      .from('dropship_partner_scores')
      .select('*')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .order('period_end', { ascending: false })
      .limit(24)  // últimos 2 anos mensais
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POLISH #8 — WEBHOOKS ML/SHOPEE DE DEVOLUÇÃO
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Recebe webhook do ML pra topic="claims". ML envia notificação leve
   * (só user_id + resource), backend deve fetchar detalhes via API com
   * o token do seller.
   *
   * Fluxo v1 (parcial):
   *   1. Resolve org via seller_id em ml_connections
   *   2. Cria registro em dropship_returns com status='opened',
   *      source='marketplace_webhook', external_id=resource ID
   *   3. raw_marketplace_data armazena o payload pra análise posterior
   *
   * TODO v2:
   *   - Validar IP de origem do ML (lista oficial de IPs)
   *   - Fetch detalhes do claim via /post-purchase/v1/claims/{id}
   *     (precisa MercadolivreService.getTokenForOrg)
   *   - Mapear claim.reason_id → return_type (ML tem ~50 codes)
   *   - Resolver responsibility do contrato em supplier_dropship_profiles
   *     .return_responsibility
   *   - Auto-aprovar e disparar applyReturnCredit se contrato permitir
   */
  async handleMLClaimWebhook(payload: {
    resource: string;     // ex: "/claims/12345"
    topic: string;        // ex: "claims"
    user_id: number;      // = seller_id ML
    application_id?: number;
    sent?: string;
  }): Promise<{ ok: boolean; reason?: string; return_id?: string }> {
    if (payload.topic !== 'claims') return { ok: true, reason: 'topic ignorado' }
    if (!payload.user_id || !payload.resource) return { ok: false, reason: 'payload incompleto' }

    // Extract claim ID
    const claimMatch = payload.resource.match(/\/claims\/(\d+)/)
    const claimId = claimMatch?.[1]
    if (!claimId) return { ok: false, reason: 'claim ID não extraído' }

    // 1. Resolve org via seller_id
    const { data: mlConn } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id, seller_id')
      .eq('seller_id', payload.user_id)
      .maybeSingle()
    if (!mlConn) return { ok: false, reason: 'seller_id não vinculado a nenhuma org' }
    const orgId = mlConn.organization_id as string

    // 2. Resolve supplier via seller_account_suppliers (account → supplier)
    const { data: accSup } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('supplier_id')
      .eq('organization_id', orgId)
      .eq('marketplace', 'mercado_livre')
      .eq('seller_id', payload.user_id)
      .is('active_until', null)
      .maybeSingle()
    if (!accSup) return { ok: true, reason: 'conta não vinculada a supplier dropship' }

    // 3. Idempotência: já existe return com mesmo external_id?
    const { data: existing } = await supabaseAdmin
      .from('dropship_returns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('marketplace', 'mercado_livre')
      .eq('external_id', claimId)
      .maybeSingle()
    if (existing) return { ok: true, reason: 'return já criado', return_id: existing.id }

    // 4. Cria return em rascunho. v1 sem fetch ML — operador completa
    //    return_type / return_amount manualmente até webhook v2 fetchar
    //    detalhes.
    const { data: ret, error } = await supabaseAdmin
      .from('dropship_returns')
      .insert({
        organization_id: orgId,
        supplier_id: accSup.supplier_id,
        marketplace: 'mercado_livre',
        return_type: 'reclamation_refund',  // default — operador ajusta
        source: 'marketplace_webhook',
        external_id: claimId,
        return_amount: 0,                   // operador preenche
        return_quantity: 1,
        responsibility: 'undefined',
        status: 'opened',
        marketplace_return_status: 'open',
        marketplace_opened_at: new Date().toISOString(),
        opened_at: new Date().toISOString(),
        internal_notes: `Webhook ML claim ${claimId} — preencher detalhes`,
      })
      .select('id')
      .single()
    if (error) {
      this.logger.error(`[webhook-ml] erro criar return: ${error.message}`)
      return { ok: false, reason: error.message }
    }

    this.logger.log(`[webhook-ml] org=${orgId} claim=${claimId} return=${ret.id} criado`)
    return { ok: true, return_id: ret.id }
  }

  /**
   * Webhook Shopee Return Push (escopo reduzido v1).
   * Shopee envia notification.return_status com partner_id + shop_id +
   * data interna do return.
   *
   * TODO v2:
   *   - Validar HMAC com partner_key (header X-Sign)
   *   - Fetch /api/v2/returns/get_return_detail pra dados completos
   */
  async handleShopeeReturnWebhook(payload: {
    code?: number;
    shop_id?: number;
    timestamp?: number;
    data?: { ordersn?: string; return_sn?: string; status?: string };
  }): Promise<{ ok: boolean; reason?: string; return_id?: string }> {
    const shopId = payload.shop_id
    const returnSn = payload.data?.return_sn
    if (!shopId || !returnSn) return { ok: false, reason: 'payload incompleto' }

    const { data: conn } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('shop_id', String(shopId))
      .eq('status', 'active')
      .maybeSingle()
    if (!conn) return { ok: false, reason: 'shop_id não vinculado' }
    const orgId = conn.organization_id as string

    const { data: accSup } = await supabaseAdmin
      .from('seller_account_suppliers')
      .select('supplier_id')
      .eq('organization_id', orgId)
      .eq('marketplace', 'shopee')
      .eq('shopee_shop_id', String(shopId))
      .is('active_until', null)
      .maybeSingle()
    if (!accSup) return { ok: true, reason: 'conta não vinculada a supplier dropship' }

    const { data: existing } = await supabaseAdmin
      .from('dropship_returns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('marketplace', 'shopee')
      .eq('external_id', returnSn)
      .maybeSingle()
    if (existing) return { ok: true, reason: 'return já criado', return_id: existing.id }

    const { data: ret, error } = await supabaseAdmin
      .from('dropship_returns')
      .insert({
        organization_id: orgId,
        supplier_id: accSup.supplier_id,
        marketplace: 'shopee',
        return_type: 'reclamation_refund',
        source: 'marketplace_webhook',
        external_id: returnSn,
        shopee_order_id: payload.data?.ordersn ?? null,
        return_amount: 0,
        return_quantity: 1,
        responsibility: 'undefined',
        status: 'opened',
        marketplace_return_status: payload.data?.status ?? 'open',
        marketplace_opened_at: new Date().toISOString(),
        opened_at: new Date().toISOString(),
        internal_notes: `Webhook Shopee return ${returnSn} — preencher detalhes`,
      })
      .select('id')
      .single()
    if (error) return { ok: false, reason: error.message }

    this.logger.log(`[webhook-shopee] org=${orgId} return_sn=${returnSn} return=${ret.id} criado`)
    return { ok: true, return_id: ret.id }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPRINT 12 — DETECÇÃO DE DIVERGÊNCIAS (REGRAS) + COPILOTO IA
  // ══════════════════════════════════════════════════════════════════════════

  /** Cron @02h diário: scan de divergências por org */
  @Cron('0 2 * * *', { name: 'dropship-divergence-scan', timeZone: 'America/Sao_Paulo' })
  async divergenceScanTick() {
    try {
      const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
      for (const org of orgs ?? []) {
        try {
          const r = await this.scanDivergences(org.id)
          if (r.detected > 0) {
            this.logger.log(`[divergences] org=${org.id} detectadas=${r.detected}`)
          }
        } catch (e) {
          this.logger.warn(`[divergences] org=${org.id}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      this.logger.error(`[divergences] tick: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Detecta divergências aplicando regras: shipment_delay, missing_partner_product,
   *  price_below_cost. Idempotente via UNIQUE constraint. */
  async scanDivergences(orgId: string): Promise<{ detected: number; rules: Record<string, number> }> {
    const counts: Record<string, number> = {
      shipment_delay: 0,
      missing_partner_product: 0,
      price_below_cost: 0,
    }
    let detected = 0

    // ── Regra 1: shipment_delay (>48h sem envio confirmado) ────────────────
    const cutoff48h = new Date(Date.now() - 48 * 3600_000).toISOString()
    const { data: delayed } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('id, supplier_id, identified_at, shipped_at, partner_sku')
      .eq('organization_id', orgId)
      .lt('identified_at', cutoff48h)
      .is('shipped_at', null)
      .in('dropship_status', ['identified', 'awaiting_shipment'])
      .limit(200)

    for (const ident of (delayed ?? [])) {
      const hours = Math.round((Date.now() - new Date(ident.identified_at).getTime()) / 3600_000)
      const created = await this.upsertDivergence({
        organization_id: orgId,
        supplier_id: ident.supplier_id,
        divergence_type: 'shipment_delay',
        severity: hours > 96 ? 'critical' : hours > 72 ? 'high' : 'medium',
        identification_id: ident.id,
        expected_value: 48,
        actual_value: hours,
        difference_amount: hours - 48,
        description: `Pedido ${ident.partner_sku} sem envio há ${hours}h (limite 48h)`,
        recommended_action: 'Contate o parceiro pra confirmar status do pedido',
      })
      if (created) { counts.shipment_delay++; detected++ }
    }

    // ── Regra 2: missing_partner_product (on_hold por mapeamento) ──────────
    const { data: unmapped } = await supabaseAdmin
      .from('dropship_order_identifications')
      .select('id, supplier_id, partner_sku, hold_reason')
      .eq('organization_id', orgId)
      .eq('dropship_status', 'on_hold')
      .ilike('hold_reason', '%mapeamento%')
      .limit(100)

    for (const ident of (unmapped ?? [])) {
      const created = await this.upsertDivergence({
        organization_id: orgId,
        supplier_id: ident.supplier_id,
        divergence_type: 'missing_partner_product',
        severity: 'high',
        identification_id: ident.id,
        description: `SKU ${ident.partner_sku} sem mapeamento no catálogo do parceiro`,
        recommended_action: 'Cadastre o produto no catálogo do parceiro ou pause o anúncio',
      })
      if (created) { counts.missing_partner_product++; detected++ }
    }

    // ── Regra 3: price_below_cost ────────────────────────────────────────
    const { data: products } = await supabaseAdmin
      .from('supplier_products')
      .select(`
        id, supplier_id, supplier_sku, unit_cost, partner_packaging_cost, partner_handling_cost,
        products!inner(id, price, organization_id)
      `)
      .eq('dropship_status', 'active')
      .limit(500)

    for (const sp of (products ?? [])) {
      const productRaw = sp.products as unknown
      const product = (Array.isArray(productRaw) ? productRaw[0] : productRaw) as {
        id: string; price: number | null; organization_id: string;
      } | null
      if (!product || product.organization_id !== orgId) continue
      if (!product.price || product.price <= 0) continue
      const totalCost = Number(sp.unit_cost) + Number(sp.partner_packaging_cost ?? 0) + Number(sp.partner_handling_cost ?? 0)
      if (Number(product.price) >= totalCost) continue
      // Vendendo abaixo do custo
      const diffAmount = totalCost - Number(product.price)
      const created = await this.upsertDivergence({
        organization_id: orgId,
        supplier_id: sp.supplier_id,
        divergence_type: 'price_below_cost',
        severity: 'critical',
        supplier_product_id: sp.id,
        expected_value: totalCost,
        actual_value: Number(product.price),
        difference_amount: diffAmount,
        difference_pct: Math.round((diffAmount / totalCost) * 100),
        description: `SKU ${sp.supplier_sku} vendendo a R$ ${product.price.toFixed(2)} (custo R$ ${totalCost.toFixed(2)})`,
        recommended_action: 'Reajuste o preço pro mínimo viável ou pause o anúncio',
      })
      if (created) { counts.price_below_cost++; detected++ }
    }

    return { detected, rules: counts }
  }

  /** Cria divergência se ainda não existe aberta pra mesma referência (idempotente).
   *  Retorna true se criou nova, false se já existia. */
  private async upsertDivergence(input: {
    organization_id: string
    supplier_id: string
    divergence_type: string
    severity: string
    identification_id?: string
    supplier_product_id?: string
    oc_id?: string
    oc_item_id?: string
    expected_value?: number
    actual_value?: number
    difference_amount?: number
    difference_pct?: number
    description: string
    recommended_action?: string
  }): Promise<boolean> {
    // Check duplicate
    let q = supabaseAdmin
      .from('dropship_divergences')
      .select('id')
      .eq('organization_id', input.organization_id)
      .eq('divergence_type', input.divergence_type)
      .in('status', ['open', 'acknowledged', 'investigating'])
    if (input.identification_id) q = q.eq('identification_id', input.identification_id)
    if (input.supplier_product_id) q = q.eq('supplier_product_id', input.supplier_product_id)
    if (input.oc_item_id) q = q.eq('oc_item_id', input.oc_item_id)

    const { data: existing } = await q.maybeSingle()
    if (existing) return false

    const { error } = await supabaseAdmin
      .from('dropship_divergences')
      .insert({
        organization_id: input.organization_id,
        supplier_id: input.supplier_id,
        divergence_type: input.divergence_type,
        severity: input.severity,
        identification_id: input.identification_id ?? null,
        supplier_product_id: input.supplier_product_id ?? null,
        oc_id: input.oc_id ?? null,
        oc_item_id: input.oc_item_id ?? null,
        expected_value: input.expected_value ?? null,
        actual_value: input.actual_value ?? null,
        difference_amount: input.difference_amount ?? null,
        difference_pct: input.difference_pct ?? null,
        description: input.description,
        recommended_action: input.recommended_action ?? null,
        status: 'open',
      })
    return !error
  }

  async listDivergences(orgId: string, filters: {
    supplier_id?: string;
    status?: string;
    severity?: string;
    divergence_type?: string;
  }) {
    let query = supabaseAdmin
      .from('dropship_divergences')
      .select(`
        id, divergence_type, severity, status,
        expected_value, actual_value, difference_amount, difference_pct,
        description, recommended_action,
        identification_id, supplier_product_id, oc_id,
        acknowledged_at, resolved_at, resolution_notes,
        detected_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('detected_at', { ascending: false })
      .limit(200)

    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.status) {
      const arr = filters.status.split(',')
      query = arr.length > 1 ? query.in('status', arr) : query.eq('status', filters.status)
    }
    if (filters.severity) query = query.eq('severity', filters.severity)
    if (filters.divergence_type) query = query.eq('divergence_type', filters.divergence_type)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async acknowledgeDivergence(orgId: string, userId: string | null, id: string) {
    const { error } = await supabaseAdmin
      .from('dropship_divergences')
      .update({
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: userId,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('status', 'open')
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  async resolveDivergence(orgId: string, userId: string | null, id: string, notes: string) {
    if (!notes?.trim()) throw new BadRequestException('Notas de resolução obrigatórias')
    const { error } = await supabaseAdmin
      .from('dropship_divergences')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by: userId,
        resolution_notes: notes.trim(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  async ignoreDivergence(orgId: string, userId: string | null, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo obrigatório')
    const { error } = await supabaseAdmin
      .from('dropship_divergences')
      .update({
        status: 'ignored',
        resolved_at: new Date().toISOString(),
        resolved_by: userId,
        resolution_notes: `[IGNORADO] ${reason.trim()}`,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Copiloto Dropship (IA) ────────────────────────────────────────────────

  /** Recebe pergunta do operador, busca contexto agregado do dashboard +
   *  parceiros + KPIs, manda pro LLM com system prompt focado. v1 sem
   *  tool calling — só resposta textual. */
  async copilotMessage(orgId: string, message: string): Promise<{ response: string; tokens: number }> {
    if (!message?.trim()) throw new BadRequestException('Mensagem vazia')

    // 1. Coleta contexto do dashboard
    const dashboard = await this.getDashboard(orgId)

    // 2. Top parceiros + scores
    const scores = await this.listPartnerScores(orgId)

    // 3. Devoluções abertas
    const { data: openReturns } = await supabaseAdmin
      .from('dropship_returns')
      .select('id, return_type, return_amount, suppliers(name)')
      .eq('organization_id', orgId)
      .in('status', ['opened', 'in_transit_back', 'received', 'analyzed', 'approved', 'credit_pending'])
      .limit(20)

    // 4. Divergências críticas
    const { data: criticalDivs } = await supabaseAdmin
      .from('dropship_divergences')
      .select('divergence_type, severity, description, suppliers(name)')
      .eq('organization_id', orgId)
      .eq('status', 'open')
      .in('severity', ['critical', 'high'])
      .limit(20)

    // 5. Monta context
    const context = {
      kpis: dashboard.kpis,
      partners_with_scores: scores.slice(0, 10).map(s => ({
        name: (s.suppliers as { name?: string } | null)?.name ?? '?',
        score: s.total_score,
        change: s.score_change,
      })),
      partners_at_risk: scores.filter(s => s.total_score < 60).map(s =>
        (s.suppliers as { name?: string } | null)?.name ?? '?'
      ),
      open_returns_count: (openReturns ?? []).length,
      critical_divergences: (criticalDivs ?? []).slice(0, 10).map(d => ({
        type: d.divergence_type,
        severity: d.severity,
        partner: (d.suppliers as { name?: string } | null)?.name ?? '?',
        desc: d.description,
      })),
    }

    const systemPrompt = `Você é o copiloto Dropship do e-Click. Ajuda o lojista a controlar a operação de dropship.

Você TEM ACESSO AOS DADOS REAIS desta org (passados como JSON no userPrompt).
Use APENAS os dados fornecidos — não invente números.

CAPACIDADES:
- Listar parceiros em risco (score < 60) ou top performers
- Mostrar pagamentos pendentes (a pagar)
- Identificar divergências críticas com sugestão de ação
- Comparar parceiros, evolução de score
- Sugerir ações proativas baseado nos KPIs

REGRAS:
- Sempre PT-BR
- Direto, sem jargão
- Use números reais do contexto
- Quando sugerir ação, indique qual tela acessar (ex: "vá em /dashboard/dropship/divergences pra revisar")
- Se não tem dado pra responder, diga claramente "não tenho essa informação"
- Máximo 4 parágrafos curtos

Você NÃO executa ações — só sugere. Operador clica nas telas.`

    const userPromptText = `CONTEXTO ATUAL (JSON):
${JSON.stringify(context, null, 2)}

PERGUNTA DO OPERADOR:
${message.trim()}`

    try {
      const result = await this.llm.generateText({
        orgId,
        feature: 'copilot_help',
        systemPrompt,
        userPrompt: userPromptText,
        maxTokens: 600,
      })
      return {
        response: result.text,
        tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
      }
    } catch (e) {
      throw new HttpException(
        `Copiloto indisponível: ${e instanceof Error ? e.message : 'erro desconhecido'}`,
        500,
      )
    }
  }
}

// ── Helpers (escopo de módulo) ───────────────────────────────────────────────

function generatePortalToken(): string {
  return randomBytes(32).toString('hex')  // 64 chars hex
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fmtBrl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function computeDueDate(today: Date, paymentTerms: string | null): string {
  // payment_terms pode vir como "15", "30", "45" (dias) ou label tipo "D+15"
  let days = 30  // default conservador
  if (paymentTerms) {
    const match = paymentTerms.replace(/\D/g, '')
    if (match) days = parseInt(match, 10)
  }
  const due = new Date(today)
  due.setDate(due.getDate() + days)
  return due.toISOString().slice(0, 10)
}
