import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * F17-C · Escopo por conta — "operador responsável por conta".
 *
 * Camada ortogonal ao RBAC de ação: `user_roles` diz O QUE o user pode fazer
 * (`orders.view`, `products.publish_ml`…); `user_account_scopes` diz EM QUAIS
 * CONTAS de marketplace ele enxerga/age.
 *
 * Semântica:
 *   • user SEM linhas → `getScope` retorna null = irrestrito (default
 *     retrocompatível — owners/admins não precisam de configuração).
 *   • user COM linhas → whitelist; queries de pedidos/dashboards restringem
 *     às contas listadas e pedidos explícitos fora do escopo dão 403.
 *
 * account_key por plataforma:
 *   mercadolivre → seller_id ('2290161131') · shopee/tiktok_shop → shop_id ·
 *   storefront → 'loja'.
 *
 * Cache LRU igual ao PermissionService (TTL 5min). Mutações via
 * `replaceForUser` invalidam na hora (no mesmo pod).
 */

export interface AccountScopeRow {
  platform:      string
  account_key:   string
  account_label: string | null
}

export interface AccountScope {
  rows:              AccountScopeRow[]
  /** seller_ids ML numéricos (platform=mercadolivre). */
  mlSellerIds:       number[]
  /** shop_ids Shopee/TikTok (casam com orders.channel_account_id). */
  channelAccountIds: string[]
  /** True se a Loja Própria está no escopo. */
  allowStorefront:   boolean
}

interface CacheEntry { scope: AccountScope | null; expiresAt: number }

const UUID_NIL = '00000000-0000-0000-0000-000000000000'

/** Aplica o escopo numa query da tabela `orders` (supabase-js builder).
 *  - scope null → sem restrição.
 *  - escopo com contas → OR de (ML: source+seller_id) e (canal: shop_id).
 *    A parte ML é amarrada em `source=mercadolivre` pra não vazar pedidos de
 *    outros canais que porventura tenham seller_id carimbado (backfills).
 *  - escopo sem nenhuma conta de marketplace (ex: só Loja Própria) → filtro
 *    impossível: a tabela `orders` não tem pedidos da loja. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOrdersScope<T extends { or(f: string): any; eq(c: string, v: unknown): any }>(
  q: T,
  scope: AccountScope | null | undefined,
): T {
  if (!scope) return q
  const parts: string[] = []
  if (scope.mlSellerIds.length > 0) {
    parts.push(`and(source.eq.mercadolivre,seller_id.in.(${scope.mlSellerIds.join(',')}))`)
  }
  if (scope.channelAccountIds.length > 0) {
    parts.push(`channel_account_id.in.(${scope.channelAccountIds.join(',')})`)
  }
  if (parts.length === 0) return q.eq('id', UUID_NIL) as T
  return q.or(parts.join(',')) as T
}

/** 403 se o user escopado pediu explicitamente um seller ML fora do escopo. */
export function assertScopeAllowsSeller(scope: AccountScope | null | undefined, sellerId?: number): void {
  if (!scope || sellerId == null) return
  if (!scope.mlSellerIds.includes(sellerId)) {
    throw new ForbiddenException('Esta conta não está sob sua responsabilidade.')
  }
}

/** 403 se o user escopado pediu explicitamente uma loja de canal fora do escopo. */
export function assertScopeAllowsAccount(scope: AccountScope | null | undefined, accountId?: string): void {
  if (!scope || !accountId) return
  if (!scope.channelAccountIds.includes(accountId)) {
    throw new ForbiddenException('Esta loja não está sob sua responsabilidade.')
  }
}

@Injectable()
export class AccountScopeService {
  private readonly logger = new Logger(AccountScopeService.name)
  private readonly cache  = new Map<string, CacheEntry>()
  private readonly TTL_MS = 5 * 60 * 1000
  private readonly MAX    = 1000

  /** Escopo efetivo do user na org. null = irrestrito (sem linhas). */
  async getScope(userId: string, orgId: string): Promise<AccountScope | null> {
    const cacheKey = `${userId}::${orgId}`
    const now = Date.now()
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached) // LRU touch
      return cached.scope
    }

    const { data, error } = await supabaseAdmin
      .from('user_account_scopes')
      .select('platform, account_key, account_label')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
    if (error) {
      // Fail-open consciente: escopo é REFINAMENTO de visibilidade; a barreira
      // de segurança primária continua sendo org + RBAC de ação. Falha de
      // leitura aqui não pode derrubar a tela de pedidos da org inteira.
      this.logger.error(`[account-scope] load falhou (seguindo irrestrito): ${error.message}`)
      return null
    }

    const rows = (data ?? []) as AccountScopeRow[]
    const scope: AccountScope | null = rows.length === 0 ? null : {
      rows,
      mlSellerIds: rows
        .filter(r => r.platform === 'mercadolivre')
        .map(r => Number(r.account_key))
        .filter(n => Number.isFinite(n)),
      channelAccountIds: rows
        .filter(r => r.platform === 'shopee' || r.platform === 'tiktok_shop')
        .map(r => r.account_key),
      allowStorefront: rows.some(r => r.platform === 'storefront'),
    }

    if (this.cache.size >= this.MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, { scope, expiresAt: now + this.TTL_MS })
    return scope
  }

  invalidate(userId: string, orgId: string): void {
    this.cache.delete(`${userId}::${orgId}`)
  }

  /** Linhas cruas de escopo de um user (pra UI de gestão da equipe). */
  async listForUser(orgId: string, userId: string): Promise<AccountScopeRow[]> {
    const { data, error } = await supabaseAdmin
      .from('user_account_scopes')
      .select('platform, account_key, account_label')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .order('platform')
    if (error) throw new Error(error.message)
    return (data ?? []) as AccountScopeRow[]
  }

  /** Substitui o escopo inteiro do user (replace-all) e invalida o cache.
   *  Lista vazia = volta a irrestrito. */
  async replaceForUser(
    orgId: string,
    userId: string,
    scopes: AccountScopeRow[],
    grantedBy: string,
  ): Promise<{ count: number }> {
    const { error: delErr } = await supabaseAdmin
      .from('user_account_scopes')
      .delete()
      .eq('organization_id', orgId)
      .eq('user_id', userId)
    if (delErr) throw new Error(delErr.message)

    if (scopes.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('user_account_scopes')
        .insert(scopes.map(s => ({
          organization_id: orgId,
          user_id:         userId,
          platform:        s.platform,
          account_key:     s.account_key,
          account_label:   s.account_label ?? null,
          granted_by:      grantedBy,
        })))
      if (insErr) throw new Error(insErr.message)
    }

    this.invalidate(userId, orgId)
    this.logger.log(`[account-scope] user=${userId} org=${orgId} → ${scopes.length} conta(s)`)
    return { count: scopes.length }
  }

  /** Contas disponíveis da org pro picker da UI (conexões reais, com nome). */
  async listOrgAccountOptions(orgId: string): Promise<AccountScopeRow[]> {
    const [ml, shopee, tiktok] = await Promise.all([
      supabaseAdmin
        .from('ml_connections')
        .select('seller_id, nickname')
        .eq('organization_id', orgId),
      supabaseAdmin
        .from('marketplace_connections')
        .select('shop_id, nickname')
        .eq('organization_id', orgId)
        .eq('platform', 'shopee'),
      supabaseAdmin
        .from('tiktok_shop_credentials')
        .select('shop_id, seller_name')
        .eq('organization_id', orgId),
    ])

    const options: AccountScopeRow[] = []
    for (const c of (ml.data ?? []) as Array<{ seller_id: number; nickname: string | null }>) {
      options.push({
        platform:      'mercadolivre',
        account_key:   String(c.seller_id),
        account_label: c.nickname ?? `ML #${c.seller_id}`,
      })
    }
    for (const c of (shopee.data ?? []) as Array<{ shop_id: number | string | null; nickname: string | null }>) {
      if (c.shop_id == null) continue
      options.push({
        platform:      'shopee',
        account_key:   String(c.shop_id),
        account_label: c.nickname ?? `Shopee #${c.shop_id}`,
      })
    }
    for (const c of (tiktok.data ?? []) as Array<{ shop_id: string | number | null; seller_name: string | null }>) {
      if (c.shop_id == null) continue
      options.push({
        platform:      'tiktok_shop',
        account_key:   String(c.shop_id),
        account_label: c.seller_name ?? 'TikTok Shop',
      })
    }
    options.push({ platform: 'storefront', account_key: 'loja', account_label: 'Loja Própria' })
    return options
  }
}
