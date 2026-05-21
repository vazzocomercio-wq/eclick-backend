import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import * as crypto from 'node:crypto'

/** Accounts de cliente da Loja Própria.
 *
 *  - Email único por organization_id (mesmo email pode comprar em
 *    lojas diferentes com contas separadas).
 *  - Senha hasheada com PBKDF2 (10k iterations + 32-byte salt).
 *  - JWT próprio (HMAC-SHA256) com claims { sub, org_id, email, exp }.
 *  - Secret: env STOREFRONT_JWT_SECRET (fallback: SUPABASE_SERVICE_ROLE_KEY).
 */

export interface StorefrontCustomer {
  id:                 string
  organization_id:    string
  email:              string
  name:               string
  phone:              string | null
  doc:                string | null
  addresses:          Address[]
  accepts_marketing:  boolean
  last_login_at:      string | null
  created_at:         string
  updated_at:         string
}

export interface Address {
  id:           string
  label:        string  // "Casa", "Trabalho"
  zip:          string
  street:       string
  number:       string
  complement?:  string
  neighborhood: string
  city:         string
  state:        string
  is_default:   boolean
}

const SECRET = process.env.STOREFRONT_JWT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'INSECURE-FALLBACK'
const JWT_TTL_SECONDS = 60 * 60 * 24 * 30  // 30 dias

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()

// ── Password hashing (PBKDF2) ─────────────────────────────────────────

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(32).toString('hex')
  const hash = crypto.pbkdf2Sync(plain, salt, 100_000, 64, 'sha512').toString('hex')
  return `pbkdf2$100000$${salt}$${hash}`
}

function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  const salt = parts[2]
  const hashHex = parts[3]
  const check = crypto.pbkdf2Sync(plain, salt, iterations, 64, 'sha512').toString('hex')
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hashHex, 'hex'))
}

// ── JWT (HMAC-SHA256, sem dep externa) ────────────────────────────────

interface JwtPayload {
  sub:    string
  org_id: string
  email:  string
  exp:    number  // unix seconds
}

const b64url = (input: Buffer | string): string => {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signJwt(payload: Omit<JwtPayload, 'exp'>): string {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body    = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS }))
  const data    = `${header}.${body}`
  const sig     = b64url(crypto.createHmac('sha256', SECRET).update(data).digest())
  return `${data}.${sig}`
}

export function verifyJwt(token: string): JwtPayload {
  const [h, b, sig] = token.split('.')
  if (!h || !b || !sig) throw new UnauthorizedException('Token inválido')
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest())
  if (sig !== expected) throw new UnauthorizedException('Assinatura inválida')
  const payload = JSON.parse(Buffer.from(b, 'base64').toString()) as JwtPayload
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Token expirado')
  return payload
}

@Injectable()
export class StorefrontCustomersService {
  private readonly logger = new Logger(StorefrontCustomersService.name)

  /** Cria conta nova. Retorna customer + token. */
  async signup(orgId: string, dto: {
    email:    string
    password: string
    name:     string
    phone?:   string
    doc?:     string
  }): Promise<{ customer: Omit<StorefrontCustomer, 'password_hash'>; token: string }> {
    if (!dto.email || !dto.password || !dto.name) {
      throw new BadRequestException('email, password e name obrigatórios')
    }
    if (dto.password.length < 6) {
      throw new BadRequestException('Senha deve ter pelo menos 6 caracteres')
    }
    const email = normalizeEmail(dto.email)

    const { data: existing } = await supabaseAdmin
      .from('storefront_customers')
      .select('id').eq('organization_id', orgId).eq('email', email).maybeSingle()
    if (existing) throw new BadRequestException('Email já cadastrado nesta loja')

    const passwordHash = hashPassword(dto.password)

    const { data, error } = await supabaseAdmin
      .from('storefront_customers')
      .insert({
        organization_id:  orgId,
        email,
        password_hash:    passwordHash,
        name:             dto.name.trim(),
        phone:            dto.phone?.trim() || null,
        doc:              dto.doc?.trim() || null,
        last_login_at:    new Date().toISOString(),
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar conta: ${error?.message ?? '?'}`)

    const customer = stripPasswordHash(data as Record<string, unknown>)
    const token = signJwt({ sub: customer.id, org_id: customer.organization_id, email: customer.email })
    return { customer, token }
  }

  /** Login. Retorna customer + token. */
  async login(orgId: string, dto: { email: string; password: string }): Promise<{
    customer: Omit<StorefrontCustomer, 'password_hash'>; token: string
  }> {
    const email = normalizeEmail(dto.email ?? '')
    if (!email || !dto.password) throw new BadRequestException('email e password obrigatórios')

    const { data } = await supabaseAdmin
      .from('storefront_customers')
      .select('*')
      .eq('organization_id', orgId)
      .eq('email', email)
      .maybeSingle()

    if (!data) throw new UnauthorizedException('Email ou senha inválidos')

    const row = data as Record<string, unknown>
    if (!verifyPassword(dto.password, row.password_hash as string)) {
      throw new UnauthorizedException('Email ou senha inválidos')
    }

    // Atualiza last_login_at
    await supabaseAdmin
      .from('storefront_customers')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', row.id as string)

    const customer = stripPasswordHash(row)
    const token = signJwt({ sub: customer.id, org_id: customer.organization_id, email: customer.email })
    return { customer, token }
  }

  /** Decodifica token + busca customer atualizado. */
  async getCurrentByToken(token: string): Promise<Omit<StorefrontCustomer, 'password_hash'>> {
    const payload = verifyJwt(token)
    const { data } = await supabaseAdmin
      .from('storefront_customers')
      .select('*')
      .eq('id', payload.sub)
      .eq('organization_id', payload.org_id)
      .maybeSingle()
    if (!data) throw new UnauthorizedException('Cliente não encontrado')
    return stripPasswordHash(data as Record<string, unknown>)
  }

  /** Atualiza dados do cliente (nome, telefone, addresses, doc). */
  async update(customerId: string, patch: {
    name?:              string
    phone?:             string | null
    doc?:               string | null
    addresses?:         Address[]
    accepts_marketing?: boolean
  }): Promise<Omit<StorefrontCustomer, 'password_hash'>> {
    const fields: Record<string, unknown> = {}
    if (patch.name !== undefined)              fields.name              = patch.name.trim()
    if (patch.phone !== undefined)             fields.phone             = patch.phone?.trim() || null
    if (patch.doc !== undefined)               fields.doc               = patch.doc?.trim() || null
    if (patch.addresses !== undefined)         fields.addresses         = patch.addresses
    if (patch.accepts_marketing !== undefined) fields.accepts_marketing = patch.accepts_marketing
    if (Object.keys(fields).length === 0) throw new BadRequestException('Nada pra atualizar')

    const { data, error } = await supabaseAdmin
      .from('storefront_customers')
      .update(fields)
      .eq('id', customerId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return stripPasswordHash(data as Record<string, unknown>)
  }

  // ── Wishlist (favoritos) ────────────────────────────────────────

  /** Lista produtos favoritos do cliente. Retorna shape compatível
   *  com StorefrontProduct do renderer. */
  async listWishlist(orgId: string, customerId: string): Promise<Array<Record<string, unknown>>> {
    const { data: items } = await supabaseAdmin
      .from('customer_wishlists')
      .select('product_id, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(200)
    const ids = ((items ?? []) as Array<{ product_id: string }>).map(r => r.product_id)
    if (ids.length === 0) return []

    // Busca produtos com mesmos campos do public storefront
    const { data: products } = await supabaseAdmin
      .from('products')
      .select([
        'id', 'name', 'sku', 'model',
        'price', 'my_price',
        'sale_price', 'sale_start_at', 'sale_end_at', 'sale_badge_text',
        'photo_urls', 'category', 'brand', 'stock',
        'ai_short_description', 'created_at',
      ].join(','))
      .in('id', ids)
      .eq('organization_id', orgId)
      .eq('storefront_visible', true)
    return (products ?? []) as unknown as Array<Record<string, unknown>>
  }

  async addToWishlist(customerId: string, productId: string): Promise<{ ok: true; alreadyExists: boolean }> {
    const { error } = await supabaseAdmin
      .from('customer_wishlists')
      .insert({ customer_id: customerId, product_id: productId })
    if (error) {
      const code = (error as { code?: string }).code
      if (code === '23505') return { ok: true, alreadyExists: true } // UNIQUE
      throw new BadRequestException(`Erro: ${error.message}`)
    }
    return { ok: true, alreadyExists: false }
  }

  async removeFromWishlist(customerId: string, productId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('customer_wishlists')
      .delete()
      .eq('customer_id', customerId)
      .eq('product_id', productId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Checa quais productIds o cliente já tem favoritados. Frontend
   *  usa pra pintar o coração preenchido no ProductGrid. */
  async checkWishlist(customerId: string, productIds: string[]): Promise<{ favorited: string[] }> {
    if (productIds.length === 0) return { favorited: [] }
    const { data } = await supabaseAdmin
      .from('customer_wishlists')
      .select('product_id')
      .eq('customer_id', customerId)
      .in('product_id', productIds)
    return {
      favorited: ((data ?? []) as Array<{ product_id: string }>).map(r => r.product_id),
    }
  }

  /** Histórico de pedidos do cliente (pelo email ou customer_id). */
  async listOrders(orgId: string, customerId: string, email: string): Promise<Array<{
    id:               string
    total:            number
    status:           string
    shipping_status:  string | null
    tracking_code:    string | null
    created_at:       string
    items_count:      number
  }>> {
    // Busca por customer_id OU por email (pedidos antigos sem FK)
    const { data } = await supabaseAdmin
      .from('storefront_orders')
      .select('id, total, status, shipping_status, tracking_code, created_at, customer, items, customer_id')
      .eq('organization_id', orgId)
      .or(`customer_id.eq.${customerId},customer->>email.eq.${email}`)
      .order('created_at', { ascending: false })
      .limit(100)

    return ((data ?? []) as Array<{
      id: string; total: number; status: string; shipping_status: string | null;
      tracking_code: string | null; created_at: string; items: unknown[];
    }>).map(o => ({
      id:              o.id,
      total:           Number(o.total ?? 0),
      status:          o.status,
      shipping_status: o.shipping_status,
      tracking_code:   o.tracking_code,
      created_at:      o.created_at,
      items_count:     Array.isArray(o.items) ? o.items.length : 0,
    }))
  }
}

function stripPasswordHash(row: Record<string, unknown>): Omit<StorefrontCustomer, 'password_hash'> {
  return {
    id:                 row.id as string,
    organization_id:    row.organization_id as string,
    email:              row.email as string,
    name:               row.name as string,
    phone:              (row.phone as string | null) ?? null,
    doc:                (row.doc as string | null) ?? null,
    addresses:          (row.addresses as Address[]) ?? [],
    accepts_marketing:  Boolean(row.accepts_marketing),
    last_login_at:      (row.last_login_at as string | null) ?? null,
    created_at:         row.created_at as string,
    updated_at:         row.updated_at as string,
  }
}
