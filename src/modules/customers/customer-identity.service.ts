import { Injectable, Logger, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface UnifiedCustomer {
  id: string
  display_name: string | null
  ml_nickname: string | null
  phone: string | null
  email: string | null
  whatsapp_id: string | null
  ml_buyer_id: string | null
  shopee_buyer_id: string | null
  avatar_url: string | null
  tags: string[]
  total_conversations: number
  total_purchases: number
  first_contact_at: string
  last_contact_at: string
  last_channel: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

@Injectable()
export class CustomerIdentityService {
  private readonly logger = new Logger(CustomerIdentityService.name)

  /**
   * Strip everything that's not a digit. WhatsApp IDs come in as
   * "5511999999999" already; user-entered phones may have +/spaces/parens.
   */
  static normalizePhone(phone: string | null | undefined): string | null {
    if (!phone) return null
    const digits = phone.replace(/\D/g, '')
    return digits.length >= 10 ? digits : null
  }

  async resolveByPhone(phone: string, name?: string, channel?: string): Promise<UnifiedCustomer | null> {
    const norm = CustomerIdentityService.normalizePhone(phone)
    if (!norm) return null

    const { data: existing } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('phone', norm)
      .maybeSingle()

    if (existing) {
      await this.touch(existing.id, channel)
      return existing as UnifiedCustomer
    }

    const { data: created, error } = await supabaseAdmin
      .from('unified_customers')
      .insert({ phone: norm, display_name: name ?? null, last_channel: channel ?? null })
      .select()
      .single()
    if (error) {
      this.logger.error(`[resolveByPhone] insert failed: ${error.message}`)
      return null
    }
    return created as UnifiedCustomer
  }

  async resolveByWhatsAppId(waId: string, name?: string): Promise<UnifiedCustomer | null> {
    const norm = CustomerIdentityService.normalizePhone(waId) ?? waId

    const { data: byWa } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('whatsapp_id', norm)
      .maybeSingle()
    if (byWa) {
      await this.touch(byWa.id, 'whatsapp')
      return byWa as UnifiedCustomer
    }

    // WA ID is usually the phone — try to find by phone and link
    const { data: byPhone } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('phone', norm)
      .maybeSingle()
    if (byPhone) {
      await supabaseAdmin
        .from('unified_customers')
        .update({ whatsapp_id: norm, last_channel: 'whatsapp', last_contact_at: new Date().toISOString() })
        .eq('id', byPhone.id)
      return { ...byPhone, whatsapp_id: norm } as UnifiedCustomer
    }

    const { data: created, error } = await supabaseAdmin
      .from('unified_customers')
      .insert({
        whatsapp_id: norm,
        phone: norm,
        display_name: name ?? null,
        last_channel: 'whatsapp',
      })
      .select()
      .single()
    if (error) {
      this.logger.error(`[resolveByWhatsAppId] insert failed: ${error.message}`)
      return null
    }
    return created as UnifiedCustomer
  }

  async resolveByMlBuyerId(mlId: string, name?: string): Promise<UnifiedCustomer | null> {
    const { data: existing } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('ml_buyer_id', mlId)
      .maybeSingle()
    if (existing) {
      await this.touch(existing.id, 'mercadolivre')
      return existing as UnifiedCustomer
    }

    const { data: created, error } = await supabaseAdmin
      .from('unified_customers')
      .insert({ ml_buyer_id: mlId, display_name: name ?? null, last_channel: 'mercadolivre' })
      .select()
      .single()
    if (error) {
      this.logger.error(`[resolveByMlBuyerId] insert failed: ${error.message}`)
      return null
    }
    return created as UnifiedCustomer
  }

  /**
   * Merge two profiles when the same person has separate rows. Keeps the
   * older one (target) and copies any non-null fields from the newer one.
   * Re-points ai_conversations.unified_customer_id from old → target.
   */
  async mergeProfiles(targetId: string, sourceId: string): Promise<UnifiedCustomer | null> {
    if (targetId === sourceId) return null

    const { data: target } = await supabaseAdmin.from('unified_customers').select('*').eq('id', targetId).maybeSingle()
    const { data: source } = await supabaseAdmin.from('unified_customers').select('*').eq('id', sourceId).maybeSingle()
    if (!target || !source) throw new HttpException('Profile not found for merge', 404)

    const fillIfNull = (a: unknown, b: unknown) => (a == null || a === '' ? b : a)
    const merged: Partial<UnifiedCustomer> = {
      display_name:    fillIfNull(target.display_name,    source.display_name)    as string | null,
      phone:           fillIfNull(target.phone,           source.phone)           as string | null,
      email:           fillIfNull(target.email,           source.email)           as string | null,
      whatsapp_id:     fillIfNull(target.whatsapp_id,     source.whatsapp_id)     as string | null,
      ml_buyer_id:     fillIfNull(target.ml_buyer_id,     source.ml_buyer_id)     as string | null,
      shopee_buyer_id: fillIfNull(target.shopee_buyer_id, source.shopee_buyer_id) as string | null,
      avatar_url:      fillIfNull(target.avatar_url,      source.avatar_url)      as string | null,
      tags:            Array.from(new Set([...(target.tags ?? []), ...(source.tags ?? [])])),
      notes:           [target.notes, source.notes].filter(Boolean).join('\n---\n') || null,
      total_conversations: (target.total_conversations ?? 0) + (source.total_conversations ?? 0),
      total_purchases:     Number(target.total_purchases ?? 0) + Number(source.total_purchases ?? 0),
    }

    await supabaseAdmin.from('ai_conversations').update({ unified_customer_id: targetId }).eq('unified_customer_id', sourceId)
    await supabaseAdmin.from('unified_customers').update(merged).eq('id', targetId)
    await supabaseAdmin.from('unified_customers').delete().eq('id', sourceId)

    const { data: result } = await supabaseAdmin.from('unified_customers').select('*').eq('id', targetId).single()
    return result as UnifiedCustomer
  }

  /** Last 10 conversations across channels for a customer. */
  async getCustomerHistory(customerId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .select('id, channel, status, total_messages, listing_title, customer_phone, customer_whatsapp_id, created_at, updated_at')
      .eq('unified_customer_id', customerId)
      .order('updated_at', { ascending: false })
      .limit(10)
    if (error) {
      this.logger.warn(`[getCustomerHistory] ${error.message}`)
      return []
    }
    return data ?? []
  }

  async list(filters: {
    search?:            string
    channel?:           string
    limit?:             number
    page?:              number
    per_page?:          number
    sort_by?:           string
    sort_dir?:          'asc' | 'desc'
    enrichment_status?: string                  // 'pending' | 'partial' | 'full' | 'failed'
    has_cpf?:           boolean
    has_phone?:         boolean
    has_whatsapp?:      boolean
    has_email?:         boolean
    is_vip?:            boolean                 // tags @> ['vip']
    is_blocked?:        boolean                 // tags @> ['blocked']
    /** When true, returns array shape (legacy callers). When false, returns
     * paginated envelope { data, total, page, per_page }. */
    legacy?:            boolean
  } = {}) {
    const sortBy  = filters.sort_by  ?? 'last_contact_at'
    const sortDir = filters.sort_dir === 'asc'

    const isLegacy = filters.legacy === true || (!filters.page && !filters.per_page)
    const perPage  = isLegacy
      ? Math.min(Math.max(filters.limit ?? 200, 1), 1000)
      : Math.min(Math.max(filters.per_page ?? 25, 1), 200)
    const page = isLegacy ? 1 : Math.max(filters.page ?? 1, 1)
    const offset = (page - 1) * perPage

    let q = supabaseAdmin
      .from('unified_customers')
      .select('*', { count: isLegacy ? undefined : 'exact' })
      .order(sortBy, { ascending: sortDir })
      .range(offset, offset + perPage - 1)

    if (filters.search) {
      const s = filters.search.replace(/%/g, '')
      q = q.or(`display_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%,cpf.ilike.%${s}%`)
    }
    if (filters.channel)            q = q.eq('last_channel', filters.channel)
    if (filters.enrichment_status)  q = q.eq('enrichment_status', filters.enrichment_status)
    if (filters.has_cpf)            q = q.not('cpf', 'is', null)
    if (filters.has_phone)          q = q.not('phone', 'is', null)
    if (filters.has_whatsapp)       q = q.not('whatsapp_id', 'is', null)
    if (filters.has_email)          q = q.not('email', 'is', null)
    if (filters.is_vip)             q = q.contains('tags', ['vip'])
    if (filters.is_blocked)         q = q.contains('tags', ['blocked'])

    const { data, error, count } = await q
    if (error) throw new HttpException(error.message, 500)

    if (isLegacy) return data ?? []
    return { data: data ?? [], total: count ?? 0, page, per_page: perPage }
  }

  async get(id: string) {
    const { data, error } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new HttpException('Cliente não encontrado', 404)
    const history = await this.getCustomerHistory(id)
    return { ...data, history }
  }

  async update(id: string, body: Partial<Pick<UnifiedCustomer, 'display_name' | 'tags' | 'notes' | 'email' | 'phone'>>) {
    const { data, error } = await supabaseAdmin
      .from('unified_customers')
      .update(body)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data
  }

  /** Toggle a tag on/off — used by VIP / Blocked toggles in /clientes. */
  async setTag(id: string, tag: string, on: boolean) {
    const { data: cur } = await supabaseAdmin
      .from('unified_customers')
      .select('tags')
      .eq('id', id)
      .maybeSingle()
    const tags = new Set<string>((cur?.tags as string[] | null) ?? [])
    if (on) tags.add(tag); else tags.delete(tag)
    return this.update(id, { tags: [...tags] })
  }

  /** Hard delete — used by /clientes row "Excluir" action. */
  async remove(id: string) {
    const { error } = await supabaseAdmin
      .from('unified_customers')
      .delete()
      .eq('id', id)
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async touch(id: string, channel?: string): Promise<void> {
    const updates: Record<string, unknown> = {
      last_contact_at: new Date().toISOString(),
    }
    if (channel) updates.last_channel = channel
    await supabaseAdmin.from('unified_customers').update(updates).eq('id', id)
  }
}
