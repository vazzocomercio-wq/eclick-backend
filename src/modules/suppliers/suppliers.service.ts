import { Injectable, NotFoundException, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface CreateSupplierDto {
  name: string
  supplier_type: 'nacional' | 'importado'
  country: string
  currency: string
  legal_name?: string | null
  tax_id?: string | null
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  contact_whatsapp?: string | null
  payment_terms?: string | null
  payment_method?: string | null
  default_lead_time_days?: number | null
  default_safety_days?: number | null
  shipping_terms?: string | null
  freight_included?: boolean
  customs_agent?: string | null
  port_of_origin?: string | null
  notes?: string | null
}

export interface UpdateSupplierDto extends Partial<CreateSupplierDto> {
  is_active?: boolean
}

export interface LinkProductDto {
  product_id: string
  lead_time_days?: number | null
  safety_days?: number | null
  unit_cost?: number | null
  currency?: string | null
  moq?: number | null
  is_preferred?: boolean
  supplier_sku?: string | null
  notes?: string | null
  price_tiers?: Array<{ min_qty: number; unit_price: number }> | null
}

export interface UpdateProductLinkDto extends Partial<Omit<LinkProductDto, 'product_id'>> {}

export interface AddDocumentDto {
  document_type?: string | null
  file_name: string
  file_url: string
  notes?: string | null
}

@Injectable()
export class SuppliersService {
  // ── Org resolution (mirrors BackfillService.resolveOrgId) ────────────────────

  private async resolveOrgId(orgId: string | null): Promise<string> {
    if (orgId) return orgId
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (org?.id) return org.id as string
    throw new HttpException('Organização não encontrada. Configure uma organização primeiro.', 400)
  }

  // ── Suppliers ────────────────────────────────────────────────────────────────

  async getAll(orgId: string | null, filters: { type?: string; country?: string; active?: string; q?: string }) {
    const oid = await this.resolveOrgId(orgId)
    let query = supabaseAdmin
      .from('suppliers')
      .select(`
        id, name, legal_name, supplier_type, country, currency, is_active,
        contact_name, contact_email, contact_phone, contact_whatsapp,
        default_lead_time_days, rating, total_orders_count,
        total_ordered_value_brl, on_time_delivery_rate, last_order_at,
        created_at,
        supplier_products(count)
      `)
      .eq('organization_id', oid)
      .order('name', { ascending: true })

    if (filters.type && filters.type !== 'all') {
      query = query.eq('supplier_type', filters.type)
    }
    if (filters.country) {
      query = query.ilike('country', `%${filters.country}%`)
    }
    if (filters.active === 'true') {
      query = query.eq('is_active', true)
    } else if (filters.active === 'false') {
      query = query.eq('is_active', false)
    }
    if (filters.q) {
      query = query.ilike('name', `%${filters.q}%`)
    }

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getById(orgId: string | null, id: string) {
    const oid = await this.resolveOrgId(orgId)
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .select(`
        *,
        supplier_products(
          id, product_id, lead_time_days, safety_days, unit_cost, currency,
          moq, is_preferred, supplier_sku, notes, price_tiers, created_at,
          products(id, name, sku, photo_urls, price)
        ),
        supplier_documents(id, document_type, file_name, file_url, notes, created_at)
      `)
      .eq('organization_id', oid)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Fornecedor não encontrado')
    return data
  }

  async create(orgId: string | null, dto: CreateSupplierDto) {
    const oid = await this.resolveOrgId(orgId)
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .insert({ ...dto, organization_id: oid, is_active: true })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async update(orgId: string | null, id: string, dto: UpdateSupplierDto) {
    const oid = await this.resolveOrgId(orgId)
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', oid)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Fornecedor não encontrado')
    return data
  }

  async deactivate(orgId: string | null, id: string) {
    const oid = await this.resolveOrgId(orgId)
    const { error } = await supabaseAdmin
      .from('suppliers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', oid)
    if (error) throw new HttpException(error.message, 500)
  }

  // ── Supplier Products ────────────────────────────────────────────────────────

  async getProducts(orgId: string | null, supplierId: string) {
    await this.assertOwnership(orgId, supplierId)
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .select(`
        id, product_id, lead_time_days, safety_days, unit_cost, currency,
        moq, is_preferred, supplier_sku, notes, price_tiers, created_at,
        products(id, name, sku, photo_urls, price, status)
      `)
      .eq('supplier_id', supplierId)
      .order('is_preferred', { ascending: false })

    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async linkProduct(orgId: string | null, supplierId: string, dto: LinkProductDto) {
    await this.assertOwnership(orgId, supplierId)
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .upsert(
        { supplier_id: supplierId, ...dto, updated_at: new Date().toISOString() },
        { onConflict: 'supplier_id,product_id', ignoreDuplicates: false },
      )
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async updateProductLink(orgId: string | null, supplierId: string, productId: string, dto: UpdateProductLinkDto) {
    await this.assertOwnership(orgId, supplierId)
    const { data, error } = await supabaseAdmin
      .from('supplier_products')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('supplier_id', supplierId)
      .eq('product_id', productId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Vínculo não encontrado')
    return data
  }

  async unlinkProduct(orgId: string | null, supplierId: string, productId: string) {
    await this.assertOwnership(orgId, supplierId)
    const { error } = await supabaseAdmin
      .from('supplier_products')
      .delete()
      .eq('supplier_id', supplierId)
      .eq('product_id', productId)
    if (error) throw new HttpException(error.message, 500)
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  async addDocument(orgId: string | null, supplierId: string, dto: AddDocumentDto) {
    await this.assertOwnership(orgId, supplierId)
    const { data, error } = await supabaseAdmin
      .from('supplier_documents')
      .insert({ supplier_id: supplierId, ...dto })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async removeDocument(orgId: string | null, supplierId: string, docId: string) {
    await this.assertOwnership(orgId, supplierId)
    const { error } = await supabaseAdmin
      .from('supplier_documents')
      .delete()
      .eq('id', docId)
      .eq('supplier_id', supplierId)
    if (error) throw new HttpException(error.message, 500)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async assertOwnership(orgId: string | null, supplierId: string) {
    const oid = await this.resolveOrgId(orgId)
    const { data } = await supabaseAdmin
      .from('suppliers')
      .select('id')
      .eq('id', supplierId)
      .eq('organization_id', oid)
      .maybeSingle()
    if (!data) throw new NotFoundException('Fornecedor não encontrado')
  }
}
