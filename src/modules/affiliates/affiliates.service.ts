import { Injectable, Logger, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import * as crypto from 'node:crypto'

/** Programa de Afiliados pra Loja Própria.
 *
 *  Modelos suportados:
 *   - Open: qualquer um se inscreve, lojista aprova
 *   - Invite-only: só convidados pelo lojista (criados via admin)
 *
 *  Tracking: visitante chega via `?ref=<code>` → cookie 30d (configurável).
 *  Compra dentro da janela → comissão pending criada.
 *  Após refund_window_days → comissão aprovada.
 *  Lojista paga manualmente (PIX/transferência) → marca como paid.
 *
 *  Anti-fraude:
 *   - Email do cliente == email do afiliado → bloqueia (default true).
 *     Lojista pode liberar via settings.allowSelfPurchase.
 *   - Dedup de clique: mesmo ip_hash + affiliate em 24h = 1 click.
 *
 *  Auth do afiliado: usa mesmo PBKDF2 + JWT do storefront_customers
 *  (token tem claim role='affiliate'). Reutilizamos a infra de senha.
 */

export interface AffiliateSettings {
  enabled:              boolean
  defaultCommissionPct: number     // 0..50 — % padrão sobre order_total
  cookieDays:           number     // janela de atribuição
  refundWindowDays:     number     // dias até comissão virar approved
  approvalMode:         'open' | 'invite_only'
  minWithdrawCents:     number     // saque mínimo
  allowSelfPurchase:    boolean    // permite afiliado comprar pelo próprio link
}

export const DEFAULT_AFFILIATE_SETTINGS: AffiliateSettings = {
  enabled:              false,
  defaultCommissionPct: 5,
  cookieDays:           30,
  refundWindowDays:     30,
  approvalMode:         'open',
  minWithdrawCents:     2000,
  allowSelfPurchase:    false,
}

export interface Affiliate {
  id:                     string
  organization_id:        string
  code:                   string
  name:                   string
  email:                  string
  phone:                  string | null
  doc:                    string | null
  custom_commission_pct:  number | null
  status:                 'pending' | 'approved' | 'rejected' | 'suspended'
  approved_at:            string | null
  rejected_reason:        string | null
  payout_method:          string | null
  payout_details:         Record<string, unknown> | null
  total_clicks:           number
  total_orders:           number
  total_earned_cents:     number
  total_paid_cents:       number
  last_login_at:          string | null
  last_activity_at:       string | null
  created_at:             string
  updated_at:             string
}

// Sem fallback inseguro (literal público / reuso da service-role key): permitia
// forjar sessão de qualquer afiliado. Em produção o segredo dedicado é obrigatório
// (derruba o boot com mensagem clara); fora de produção usa fallback de dev com aviso.
const SECRET = ((): string => {
  const s = process.env.STOREFRONT_JWT_SECRET
  if (s) return s
  if (process.env.NODE_ENV === 'production') {
    throw new Error('STOREFRONT_JWT_SECRET não configurado — obrigatório em produção (assina o token de afiliado da Loja Própria). Defina a variável de ambiente no Railway.')
  }
  Logger.warn('STOREFRONT_JWT_SECRET ausente — usando fallback de DEV (tokens de afiliado NÃO são seguros). Configure a env fora de produção também.', 'Affiliates')
  return 'eclick-storefront-dev-secret'
})()
const JWT_TTL_SECONDS = 60 * 60 * 24 * 30

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()
const normalizeCode  = (raw: string): string => raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')

// ── Password helpers (reuso do padrão storefront-customers) ─────────

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(32).toString('hex')
  const hash = crypto.pbkdf2Sync(plain, salt, 100_000, 64, 'sha512').toString('hex')
  return `pbkdf2$100000$${salt}$${hash}`
}

function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  const check = crypto.pbkdf2Sync(plain, parts[2], iterations, 64, 'sha512').toString('hex')
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(parts[3], 'hex'))
}

// ── JWT helpers ─────────────────────────────────────────────────────

interface AffiliateJwtPayload {
  sub:    string
  org_id: string
  email:  string
  role:   'affiliate'
  exp:    number
}

const b64url = (input: Buffer | string): string => {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signAffiliateJwt(payload: Omit<AffiliateJwtPayload, 'exp'>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body   = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS }))
  const data   = `${header}.${body}`
  const sig    = b64url(crypto.createHmac('sha256', SECRET).update(data).digest())
  return `${data}.${sig}`
}

export function verifyAffiliateJwt(token: string): AffiliateJwtPayload {
  const [h, b, sig] = token.split('.')
  if (!h || !b || !sig) throw new UnauthorizedException('Token inválido')
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest())
  if (sig !== expected) throw new UnauthorizedException('Assinatura inválida')
  const payload = JSON.parse(Buffer.from(b, 'base64').toString()) as AffiliateJwtPayload
  if (payload.role !== 'affiliate') throw new UnauthorizedException('Token não é de afiliado')
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Token expirado')
  return payload
}

/** Gera código único curto pra usar no ?ref= (8 chars alfanuméricos). */
function generateAffiliateCode(): string {
  return crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8).toLowerCase()
}

@Injectable()
export class AffiliatesService {
  private readonly logger = new Logger(AffiliatesService.name)

  // ── Settings ──────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<AffiliateSettings> {
    const { data } = await supabaseAdmin
      .from('store_config').select('affiliate_settings')
      .eq('organization_id', orgId).maybeSingle()
    const raw = (data?.affiliate_settings as Partial<AffiliateSettings> | null) ?? {}
    return { ...DEFAULT_AFFILIATE_SETTINGS, ...raw }
  }

  async updateSettings(orgId: string, patch: Partial<AffiliateSettings>): Promise<AffiliateSettings> {
    const current = await this.getSettings(orgId)
    const next: AffiliateSettings = {
      enabled:              patch.enabled ?? current.enabled,
      defaultCommissionPct: clamp(patch.defaultCommissionPct ?? current.defaultCommissionPct, 0, 50),
      cookieDays:           clamp(patch.cookieDays           ?? current.cookieDays,           1, 90),
      refundWindowDays:     clamp(patch.refundWindowDays     ?? current.refundWindowDays,     0, 90),
      approvalMode:         (patch.approvalMode === 'invite_only' || patch.approvalMode === 'open')
                              ? patch.approvalMode : current.approvalMode,
      minWithdrawCents:     Math.max(0, patch.minWithdrawCents ?? current.minWithdrawCents),
      allowSelfPurchase:    patch.allowSelfPurchase ?? current.allowSelfPurchase,
    }
    const { error } = await supabaseAdmin
      .from('store_config').update({ affiliate_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return next
  }

  // ── Signup / Login / Auth ─────────────────────────────────────────

  /** Auto-signup quando approvalMode='open'. Em invite_only, lojista
   *  usa createByAdmin diretamente. */
  async signup(orgId: string, dto: {
    name:     string
    email:    string
    password: string
    phone?:   string
    doc?:     string
    code?:    string
  }): Promise<{ affiliate: Omit<Affiliate, 'password_hash'>; token: string }> {
    const settings = await this.getSettings(orgId)
    if (!settings.enabled) throw new BadRequestException('Programa de afiliados desativado')
    if (settings.approvalMode === 'invite_only') {
      throw new BadRequestException('Esta loja aceita afiliados apenas por convite')
    }

    if (!dto.name?.trim()) throw new BadRequestException('name obrigatório')
    if (!dto.password || dto.password.length < 6) throw new BadRequestException('Senha mínima 6 caracteres')
    const email = normalizeEmail(dto.email)
    if (!email) throw new BadRequestException('email obrigatório')

    // Email único
    const { data: existing } = await supabaseAdmin
      .from('affiliates').select('id')
      .eq('organization_id', orgId).eq('email', email).maybeSingle()
    if (existing) throw new BadRequestException('Email já cadastrado como afiliado')

    // Code: usuário pode escolher, ou geramos
    const code = dto.code ? normalizeCode(dto.code) : generateAffiliateCode()
    if (!code || code.length < 3) throw new BadRequestException('code inválido (min 3 chars, a-z 0-9 _ -)')

    const { data: codeTaken } = await supabaseAdmin
      .from('affiliates').select('id')
      .eq('organization_id', orgId).eq('code', code).maybeSingle()
    if (codeTaken) throw new BadRequestException(`Code "${code}" já em uso — escolha outro`)

    const status = settings.approvalMode === 'open' ? 'pending' : 'pending'

    const { data, error } = await supabaseAdmin
      .from('affiliates').insert({
        organization_id: orgId,
        code,
        name:            dto.name.trim(),
        email,
        phone:           dto.phone?.trim() || null,
        doc:             dto.doc?.trim() || null,
        password_hash:   hashPassword(dto.password),
        status,
        last_login_at:   new Date().toISOString(),
      }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)

    const aff = stripHash(data as Record<string, unknown>)
    const token = signAffiliateJwt({ sub: aff.id, org_id: aff.organization_id, email: aff.email, role: 'affiliate' })
    return { affiliate: aff, token }
  }

  async login(orgId: string, dto: { email: string; password: string }): Promise<{
    affiliate: Omit<Affiliate, 'password_hash'>; token: string
  }> {
    const email = normalizeEmail(dto.email ?? '')
    if (!email || !dto.password) throw new BadRequestException('email e password obrigatórios')

    const { data } = await supabaseAdmin
      .from('affiliates').select('*')
      .eq('organization_id', orgId).eq('email', email).maybeSingle()
    if (!data) throw new UnauthorizedException('Email ou senha inválidos')

    const row = data as Record<string, unknown>
    const hash = row.password_hash as string | null
    if (!hash || !verifyPassword(dto.password, hash)) {
      throw new UnauthorizedException('Email ou senha inválidos')
    }

    if ((row.status as string) === 'rejected') throw new UnauthorizedException('Cadastro rejeitado')
    if ((row.status as string) === 'suspended') throw new UnauthorizedException('Cadastro suspenso')

    await supabaseAdmin.from('affiliates')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', row.id as string)

    const aff = stripHash(row)
    const token = signAffiliateJwt({ sub: aff.id, org_id: aff.organization_id, email: aff.email, role: 'affiliate' })
    return { affiliate: aff, token }
  }

  async getByToken(token: string): Promise<Omit<Affiliate, 'password_hash'>> {
    const payload = verifyAffiliateJwt(token)
    const { data } = await supabaseAdmin
      .from('affiliates').select('*')
      .eq('id', payload.sub).eq('organization_id', payload.org_id).maybeSingle()
    if (!data) throw new UnauthorizedException('Afiliado não encontrado')
    return stripHash(data as Record<string, unknown>)
  }

  // ── Admin: list, approve, reject, create ──────────────────────────

  async list(orgId: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    affiliates: Array<Omit<Affiliate, 'password_hash'>>
    total: number
  }> {
    const limit  = Math.min(opts.limit ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('affiliates').select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return {
      affiliates: ((data ?? []) as Record<string, unknown>[]).map(stripHash),
      total: count ?? 0,
    }
  }

  async getById(orgId: string, id: string): Promise<Omit<Affiliate, 'password_hash'>> {
    const { data } = await supabaseAdmin
      .from('affiliates').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Afiliado não encontrado')
    return stripHash(data as Record<string, unknown>)
  }

  async approve(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('affiliates').update({ status: 'approved', approved_at: new Date().toISOString(), rejected_reason: null })
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  async reject(orgId: string, id: string, reason?: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('affiliates').update({
        status: 'rejected', rejected_reason: reason?.trim() ?? null, approved_at: null,
      }).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  async suspend(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('affiliates').update({ status: 'suspended' })
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  async updateCustomCommission(orgId: string, id: string, pct: number | null): Promise<{ ok: true }> {
    if (pct != null && (pct <= 0 || pct > 50)) throw new BadRequestException('% inválido (1-50)')
    const { error } = await supabaseAdmin
      .from('affiliates').update({ custom_commission_pct: pct })
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── Self-update (afiliado edita os próprios dados) ────────────────

  async updateSelf(affiliateId: string, patch: {
    name?:           string
    phone?:          string | null
    doc?:            string | null
    payout_method?:  string | null
    payout_details?: Record<string, unknown> | null
  }): Promise<Omit<Affiliate, 'password_hash'>> {
    const fields: Record<string, unknown> = {}
    if (patch.name !== undefined)           fields.name           = patch.name.trim()
    if (patch.phone !== undefined)          fields.phone          = patch.phone?.trim() || null
    if (patch.doc !== undefined)            fields.doc            = patch.doc?.trim() || null
    if (patch.payout_method !== undefined)  fields.payout_method  = patch.payout_method
    if (patch.payout_details !== undefined) fields.payout_details = patch.payout_details
    if (Object.keys(fields).length === 0) throw new BadRequestException('nada pra atualizar')
    const { data, error } = await supabaseAdmin
      .from('affiliates').update(fields).eq('id', affiliateId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return stripHash(data as Record<string, unknown>)
  }

  // ── Stats ─────────────────────────────────────────────────────────

  async getStats(affiliateId: string): Promise<{
    clicks_today:    number
    clicks_7d:       number
    clicks_30d:      number
    orders_total:    number
    pending_cents:   number
    approved_cents:  number
    paid_cents:      number
  }> {
    const now = Date.now()
    const today = new Date(now - 86400_000).toISOString()
    const last7  = new Date(now - 7  * 86400_000).toISOString()
    const last30 = new Date(now - 30 * 86400_000).toISOString()

    const [c24, c7, c30, commissions] = await Promise.all([
      supabaseAdmin.from('affiliate_clicks').select('*', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId).gte('created_at', today).then(r => r.count ?? 0),
      supabaseAdmin.from('affiliate_clicks').select('*', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId).gte('created_at', last7).then(r => r.count ?? 0),
      supabaseAdmin.from('affiliate_clicks').select('*', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId).gte('created_at', last30).then(r => r.count ?? 0),
      supabaseAdmin.from('affiliate_commissions').select('status, amount_cents')
        .eq('affiliate_id', affiliateId).then(r => r.data ?? []),
    ])

    let pending = 0, approved = 0, paid = 0, orders = 0
    for (const c of commissions as Array<{ status: string; amount_cents: number }>) {
      orders++
      const amt = Number(c.amount_cents ?? 0)
      if (c.status === 'pending')  pending  += amt
      if (c.status === 'approved') approved += amt
      if (c.status === 'paid')     paid     += amt
    }

    return {
      clicks_today:   c24,
      clicks_7d:      c7,
      clicks_30d:     c30,
      orders_total:   orders,
      pending_cents:  pending,
      approved_cents: approved,
      paid_cents:     paid,
    }
  }

  async listAffiliateCommissions(affiliateId: string, opts: { limit?: number; offset?: number } = {}): Promise<Array<{
    id: string; order_id: string; order_total_cents: number; commission_pct: number;
    amount_cents: number; status: string; approved_at: string | null; paid_at: string | null;
    created_at: string;
  }>> {
    const limit  = Math.min(opts.limit ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    const { data } = await supabaseAdmin
      .from('affiliate_commissions')
      .select('id, order_id, order_total_cents, commission_pct, amount_cents, status, approved_at, paid_at, created_at')
      .eq('affiliate_id', affiliateId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    return (data ?? []) as Array<{
      id: string; order_id: string; order_total_cents: number; commission_pct: number;
      amount_cents: number; status: string; approved_at: string | null; paid_at: string | null;
      created_at: string;
    }>
  }

  // ── Admin: comissões + payouts ────────────────────────────────────

  async listOrgCommissions(orgId: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    commissions: Array<{
      id: string; affiliate_id: string; affiliate_name?: string; affiliate_code?: string;
      order_id: string; order_total_cents: number; commission_pct: number;
      amount_cents: number; status: string; approved_at: string | null; paid_at: string | null;
      created_at: string;
    }>
    total: number
  }> {
    const limit  = Math.min(opts.limit ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('affiliate_commissions')
      .select('*, affiliate:affiliate_id(name, code)', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map(r => {
      const aff = (r.affiliate as { name?: string; code?: string } | Array<{ name?: string; code?: string }> | null)
      const a = Array.isArray(aff) ? aff[0] : aff
      return {
        id:                r.id as string,
        affiliate_id:      r.affiliate_id as string,
        affiliate_name:    a?.name,
        affiliate_code:    a?.code,
        order_id:          r.order_id as string,
        order_total_cents: Number(r.order_total_cents),
        commission_pct:    Number(r.commission_pct),
        amount_cents:      Number(r.amount_cents),
        status:            r.status as string,
        approved_at:       r.approved_at as string | null,
        paid_at:           r.paid_at as string | null,
        created_at:        r.created_at as string,
      }
    })
    return { commissions: rows, total: count ?? 0 }
  }

  /** Marca uma comissão como pago manualmente (lojista informou
   *  comprovante). Pra payout em massa, usar createPayout. */
  async markCommissionPaid(orgId: string, commissionId: string, notes?: string): Promise<{ ok: true }> {
    const { data } = await supabaseAdmin
      .from('affiliate_commissions').select('affiliate_id, amount_cents, status')
      .eq('id', commissionId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Comissão não encontrada')
    if ((data as { status: string }).status !== 'approved') {
      throw new BadRequestException('Só comissões approved podem ser marcadas como paid')
    }

    const { error } = await supabaseAdmin
      .from('affiliate_commissions').update({
        status: 'paid', paid_at: new Date().toISOString(), notes: notes ?? null,
      }).eq('id', commissionId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    // Incrementa total_paid_cents do afiliado
    const affId = (data as { affiliate_id: string }).affiliate_id
    const amt   = Number((data as { amount_cents: number }).amount_cents)
    const { data: aff } = await supabaseAdmin
      .from('affiliates').select('total_paid_cents').eq('id', affId).maybeSingle()
    if (aff) {
      await supabaseAdmin.from('affiliates')
        .update({ total_paid_cents: Number((aff as { total_paid_cents: number }).total_paid_cents) + amt })
        .eq('id', affId)
    }
    return { ok: true }
  }

  async rejectCommission(orgId: string, commissionId: string, reason: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('affiliate_commissions').update({
        status: 'rejected', rejected_reason: reason,
      }).eq('id', commissionId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }
}

function stripHash(row: Record<string, unknown>): Omit<Affiliate, 'password_hash'> {
  return {
    id:                    row.id as string,
    organization_id:       row.organization_id as string,
    code:                  row.code as string,
    name:                  row.name as string,
    email:                 row.email as string,
    phone:                 (row.phone as string | null) ?? null,
    doc:                   (row.doc as string | null) ?? null,
    custom_commission_pct: (row.custom_commission_pct as number | null) ?? null,
    status:                row.status as 'pending' | 'approved' | 'rejected' | 'suspended',
    approved_at:           (row.approved_at as string | null) ?? null,
    rejected_reason:       (row.rejected_reason as string | null) ?? null,
    payout_method:         (row.payout_method as string | null) ?? null,
    payout_details:        (row.payout_details as Record<string, unknown> | null) ?? null,
    total_clicks:          Number(row.total_clicks ?? 0),
    total_orders:          Number(row.total_orders ?? 0),
    total_earned_cents:    Number(row.total_earned_cents ?? 0),
    total_paid_cents:      Number(row.total_paid_cents ?? 0),
    last_login_at:         (row.last_login_at as string | null) ?? null,
    last_activity_at:      (row.last_activity_at as string | null) ?? null,
    created_at:            row.created_at as string,
    updated_at:            row.updated_at as string,
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
