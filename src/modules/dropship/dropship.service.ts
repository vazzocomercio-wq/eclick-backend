import { Injectable, HttpException, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { randomBytes } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { EmailSenderService } from '../messaging/email-sender.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { FinanceiroService } from '../financeiro/financeiro.service'

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
  marketplace: 'mercado_livre' | 'shopee' | 'amazon' | 'magalu' | 'others'
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
  ) {}

  // ── Partners (supplier + dropship_profile) ─────────────────────────────────

  async listPartners(orgId: string, filters: { status?: string; q?: string }) {
    let query = supabaseAdmin
      .from('supplier_dropship_profiles')
      .select(`
        id, dropship_status, integration_type,
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

    // Pelo menos 1 ID de marketplace
    if (!dto.seller_id && !dto.shopee_shop_id && !dto.amazon_seller_id) {
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
          lead_time_days: dto.lead_time_days ?? null,
          safety_days: dto.safety_days ?? null,
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
            lead_time_days: leadTime,
            moq,
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
          const r = await this.identifyDropshipOrders(org.id)
          if (r.identified > 0) {
            this.logger.log(`[identify] org=${org.id} processed=${r.processed} identified=${r.identified}`)
          }
        } catch (e) {
          this.logger.warn(`[identify] org=${org.id} erro: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      this.logger.error(`[identify] tick failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  async identifyDropshipOrders(orgId: string): Promise<{ processed: number; identified: number; skipped: number }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()

    // 1. Pega orders dos últimos 7 dias que ainda não tem identification
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select(`
        id, source, external_order_id, seller_id, product_id, sku,
        quantity, sale_price, status, shipping_status, payment_status,
        sold_at, created_at, raw_data
      `)
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .not('status', 'in', '(cancelled,refunded)')
      .limit(200)

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
      .select('supplier_id, marketplace, seller_id, shopee_shop_id, amazon_seller_id, is_default')
      .eq('organization_id', orgId)
      .is('active_until', null)
    const accSupMap = new Map<string, string>()  // key = marketplace:account → supplier_id
    for (const a of (accountSuppliers ?? [])) {
      const account = a.seller_id ?? a.shopee_shop_id ?? a.amazon_seller_id
      if (account == null) continue
      accSupMap.set(`${a.marketplace}:${account}`, a.supplier_id)
    }

    if (accSupMap.size === 0) {
      // Sem mapping = nada é dropship (ou todos pedidos vão pro estoque próprio)
      return { processed: orders.length, identified: 0, skipped: candidates.length }
    }

    let identified = 0
    let skipped = 0

    for (const order of candidates) {
      // 2. Mapear marketplace ao formato seller_account_suppliers
      const marketplace = this.normalizeMarketplaceName(order.source ?? '')
      const account = order.seller_id  // ML usa seller_id; outros marketplaces precisam expansão futura
      if (!marketplace || account == null) { skipped++; continue }

      // 3. Resolver supplier via account
      const supplierId = accSupMap.get(`${marketplace}:${account}`)
      if (!supplierId) { skipped++; continue }  // conta não vinculada a parceiro = não é dropship

      // 4. Resolver product (via product_id OR via SKU)
      let productId = order.product_id as string | null
      let productSupplyType: string | null = null
      if (productId) {
        const { data: p } = await supabaseAdmin
          .from('products')
          .select('id, supply_type, sku')
          .eq('id', productId)
          .maybeSingle()
        productSupplyType = p?.supply_type ?? null
      } else if (order.sku) {
        const { data: p } = await supabaseAdmin
          .from('products')
          .select('id, supply_type')
          .eq('organization_id', orgId)
          .eq('sku', order.sku)
          .maybeSingle()
        productId = p?.id ?? null
        productSupplyType = p?.supply_type ?? null
      }

      if (!productId) { skipped++; continue }
      if (productSupplyType !== 'dropship') { skipped++; continue }

      // 5. Buscar supplier_products
      const { data: pp } = await supabaseAdmin
        .from('supplier_products')
        .select('id, supplier_sku, master_sku, unit_cost, partner_packaging_cost, partner_handling_cost')
        .eq('supplier_id', supplierId)
        .eq('product_id', productId)
        .maybeSingle()

      const cost = pp
        ? Number(pp.unit_cost) + Number(pp.partner_packaging_cost ?? 0) + Number(pp.partner_handling_cost ?? 0)
        : 0
      const salePrice = Number(order.sale_price ?? 0)
      const margin = salePrice - cost

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
    if (s.includes('amazon')) return 'amazon'
    if (s.includes('magalu')) return 'magalu'
    return ''
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
  @Cron('0 22 * * *', { name: 'dropship-oc-generation' })
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
        cost_at_sale, sale_price, identified_at, shipped_at, order_id
      `)
      .eq('organization_id', orgId)
      .in('dropship_status', ['eligible_for_oc', 'shipped_confirmed'])
      .is('oc_id', null)
      .limit(1000)

    if (!idents || idents.length === 0) return []

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
      idents: typeof idents
    }
    const groups = new Map<string, Group>()
    for (const i of idents) {
      // Resolver conta via account-supplier mapping (procura match com marketplace)
      const acc = (accountSuppliers ?? []).find(a =>
        a.supplier_id === i.supplier_id &&
        a.marketplace === i.marketplace,
      )
      const sellerId = acc?.seller_id ?? null
      const shopeeShopId = acc?.shopee_shop_id ?? null
      const amazonSellerId = acc?.amazon_seller_id ?? null
      const accountLabel = acc?.account_label ?? null

      const key = [i.supplier_id, i.marketplace, sellerId ?? shopeeShopId ?? amazonSellerId ?? 'unknown'].join(':')
      if (!groups.has(key)) {
        groups.set(key, {
          supplier_id: i.supplier_id,
          marketplace: i.marketplace,
          account_label: accountLabel ?? `${i.marketplace}`,
          seller_id: sellerId,
          shopee_shop_id: shopeeShopId,
          amazon_seller_id: amazonSellerId,
          idents: [],
        })
      }
      groups.get(key)!.idents.push(i)
    }

    const created: Array<{ id: string; oc_number: string; gross_total: number }> = []
    const today = new Date()
    const todayDate = today.toISOString().slice(0, 10)
    const ocCounter: Record<string, number> = {}  // pra numeração sequencial

    for (const [, grp] of groups) {
      const supplier = supplierById.get(grp.supplier_id)
      if (!supplier) continue

      // Calcular due_date pelo payment_terms
      const dueDate = computeDueDate(today, supplier.payment_terms)

      // Numeração: DOC-YYYY-MM-DD-ORG-SUPPLIER-NNN
      const supplierSlug = String(supplier.name)
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20).replace(/^_|_$/g, '')
      const counterKey = `${todayDate}:${grp.supplier_id}`
      ocCounter[counterKey] = (ocCounter[counterKey] ?? 0) + 1
      const seq = String(ocCounter[counterKey]).padStart(3, '0')
      const ocNumber = `DOC-${todayDate}-${supplierSlug}-${seq}`

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
          sale_date: ident.identified_at,
          shipped_at: ident.shipped_at,
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
          reference_date: todayDate,
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
        sale_date, shipped_at, status,
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
    let waStatus = 'skipped (sem whatsapp configurado)'
    if (profile.notification_whatsapp) {
      const waMessage = `Nova OC ${ocNumber} — ${itemsCount} itens, R$ ${netTotal.toFixed(2)}. Aprove em ${portalUrl}`
      const waRes = await this.waSender.sendTextMessage({
        phone: profile.notification_whatsapp,
        message: waMessage,
      })
      await supabaseAdmin
        .from('dropship_oc_notifications')
        .insert({
          organization_id: orgId,
          oc_id: ocId,
          channel: 'whatsapp',
          recipient: profile.notification_whatsapp,
          notification_type: 'oc_generated',
          body: waMessage,
          status: waRes.success ? 'sent' : 'failed',
          sent_at: waRes.success ? new Date().toISOString() : null,
          error_message: waRes.error ?? null,
          provider_message_id: waRes.message_id ?? null,
        })
      waStatus = waRes.success ? 'sent' : `failed: ${waRes.error}`
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
        marketplace, ml_order_id, sale_date, status,
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
}

// ── Helpers (escopo de módulo) ───────────────────────────────────────────────

function generatePortalToken(): string {
  return randomBytes(32).toString('hex')  // 64 chars hex
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
