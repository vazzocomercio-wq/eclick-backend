import { Injectable, HttpException, NotFoundException, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

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

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class DropshipService {

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
}
