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
  city: string | null
  state: string | null
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
      .eq('is_deleted', false)
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
      .eq('is_deleted', false)
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
      .eq('is_deleted', false)
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
      .eq('is_deleted', false)
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
   * Merge two profiles via RPC `merge_customers` (Postgres function transacional
   * com soft delete + audit trail + migração de FK em 5 tabelas). Substitui o
   * antigo hard-delete + 1 UPDATE em ai_conversations que deixava 4 outras
   * tabelas com customer_id apontando pra UUID inexistente.
   * Ver migration: src/migrations/2026_04_29_merge_customers_soft_delete.sql
   */
  async mergeProfiles(orgId: string, keepId: string, discardId: string): Promise<UnifiedCustomer | null> {
    if (!orgId)            throw new HttpException('orgId obrigatório', 400)
    if (!keepId)           throw new HttpException('keep_id obrigatório', 400)
    if (!discardId)        throw new HttpException('discard_id obrigatório', 400)
    if (keepId === discardId) return null

    const { error } = await supabaseAdmin.rpc('merge_customers', {
      p_org_id:     orgId,
      p_keep_id:    keepId,
      p_discard_id: discardId,
    })
    if (error) {
      this.logger.warn(`[merge] falhou: ${error.message}`)
      throw new HttpException(error.message, 400)
    }

    const { data } = await supabaseAdmin
      .from('unified_customers')
      .select('*')
      .eq('id', keepId)
      .eq('is_deleted', false)
      .single()
    return data as UnifiedCustomer
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
      .eq('is_deleted', false)
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
      .eq('is_deleted', false)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new HttpException('Cliente não encontrado', 404)
    const history = await this.getCustomerHistory(id)
    return { ...data, history }
  }

  /** Stats agregados — counts e somas sobre TODA a base da org, não só
   * a página atual. Sem PostgREST aggregate (não suporta COUNT FILTER em
   * 1 call), usa N COUNT(head=true) em paralelo. Mais lento que SQL puro
   * mas evita criar function/view custom. */
  async getStats(orgId: string): Promise<{
    total:         number
    with_cpf:      number
    with_phone:    number
    with_whatsapp: number
    with_email:    number
    with_address:  number
    vip:           number
    blocked:       number
    pending:       number
    gmv_total:     number
    ltv_average:   number
  }> {
    const base = () => supabaseAdmin
      .from('unified_customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('is_deleted', false)

    const [
      total, withCpf, withPhone, withWa, withEmail, withAddress,
      vip, blocked, pending,
    ] = await Promise.all([
      base(),
      base().not('cpf', 'is', null),
      base().not('phone', 'is', null),
      base().eq('validated_whatsapp', true),
      base().not('email', 'is', null),
      base().not('city', 'is', null),
      base().contains('tags', ['vip']),
      base().contains('tags', ['blocked']),
      base().eq('enrichment_status', 'pending'),
    ])

    // Soma de total_purchases — separado porque PostgREST não suporta SUM
    // direto. Pega a coluna numérica e soma no Node. Limit 50k pra org de
    // 8k clientes basta; se ultrapassar, depois migra pra view materializada.
    const { data: rev } = await supabaseAdmin
      .from('unified_customers')
      .select('total_purchases')
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .limit(50_000)
    const gmvTotal = (rev ?? []).reduce(
      (s, r) => s + Number((r as { total_purchases?: number | null }).total_purchases ?? 0),
      0,
    )
    const totalCount = total.count ?? 0
    const ltvAverage = totalCount > 0 ? gmvTotal / totalCount : 0

    return {
      total:         totalCount,
      with_cpf:      withCpf.count   ?? 0,
      with_phone:    withPhone.count ?? 0,
      with_whatsapp: withWa.count    ?? 0,
      with_email:    withEmail.count ?? 0,
      with_address:  withAddress.count ?? 0,
      vip:           vip.count       ?? 0,
      blocked:       blocked.count   ?? 0,
      pending:       pending.count   ?? 0,
      gmv_total:     Math.round(gmvTotal * 100) / 100,
      ltv_average:   Math.round(ltvAverage * 100) / 100,
    }
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
      .eq('is_deleted', false)
      .maybeSingle()
    const tags = new Set<string>((cur?.tags as string[] | null) ?? [])
    if (on) tags.add(tag); else tags.delete(tag)
    return this.update(id, { tags: [...tags] })
  }

  /** Bulk update VIP/Bloqueado em N clientes via tags. Aceita
   * { is_vip?, is_blocked? } e aplica add/remove com SET deduplicado.
   * Retorna { updated: N }. Usado pela barra de bulk actions. */
  async bulkUpdateFlags(
    orgId: string,
    customerIds: string[],
    flags: { is_vip?: boolean; is_blocked?: boolean },
  ): Promise<{ updated: number }> {
    if (!customerIds?.length) return { updated: 0 }
    if (flags.is_vip === undefined && flags.is_blocked === undefined) {
      return { updated: 0 }
    }

    const { data: rows } = await supabaseAdmin
      .from('unified_customers')
      .select('id, tags')
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .in('id', customerIds)
    if (!rows?.length) return { updated: 0 }

    let updated = 0
    for (const r of rows) {
      const set = new Set<string>((r.tags as string[] | null) ?? [])
      if (flags.is_vip     === true)  set.add('vip')
      if (flags.is_vip     === false) set.delete('vip')
      if (flags.is_blocked === true)  set.add('blocked')
      if (flags.is_blocked === false) set.delete('blocked')
      const { error } = await supabaseAdmin
        .from('unified_customers')
        .update({ tags: [...set], updated_at: new Date().toISOString() })
        .eq('id', r.id)
      if (!error) updated++
    }
    return { updated }
  }

  /** Exporta CSV com nome,cpf,telefone,email,cidade,uf,status,compras.
   * Quando ids é não-vazio, filtra por esses IDs; caso contrário, exporta
   * a org inteira (cap 50k pra proteger memória). Aspas duplas escapadas
   * via "" (RFC 4180). */
  async exportCsv(orgId: string, ids?: string[]): Promise<string> {
    let q = supabaseAdmin
      .from('unified_customers')
      .select('display_name, cpf, phone, email, city, state, enrichment_status, total_purchases')
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .order('display_name', { ascending: true })
      .limit(50_000)
    if (ids?.length) q = q.in('id', ids)

    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)

    const header = ['nome', 'cpf', 'telefone', 'email', 'cidade', 'uf', 'status', 'compras']
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines: string[] = [header.join(',')]
    for (const r of data ?? []) {
      lines.push([
        esc((r as { display_name?: string }).display_name),
        esc((r as { cpf?: string }).cpf),
        esc((r as { phone?: string }).phone),
        esc((r as { email?: string }).email),
        esc((r as { city?: string }).city),
        esc((r as { state?: string }).state),
        esc((r as { enrichment_status?: string }).enrichment_status),
        esc((r as { total_purchases?: number }).total_purchases ?? 0),
      ].join(','))
    }
    return lines.join('\n')
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
