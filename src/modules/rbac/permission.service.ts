import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

interface CacheEntry {
  permissions: Set<string>
  roles:       string[]
  expiresAt:   number
}

/**
 * F17-B · Serviço central de RBAC. Carrega permissions efetivas do user
 * dentro de uma org (somando todas as user_roles) e responde checagens por
 * key. Cache em memória LRU-ish simples (TTL 5min, max 1000 entries) — é
 * suficiente pra um single-pod backend; multi-pod precisaria invalidação
 * cross-instance (Redis pub/sub). Por enquanto cabe.
 *
 * IMPORTANTE: se você adicionar/remover role de um user, chame
 * `invalidate(userId, orgId)` no mesmo fluxo, senão o cache servirá
 * permissions antigas até 5min.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name)
  private readonly cache  = new Map<string, CacheEntry>()
  private readonly TTL_MS = 5 * 60 * 1000
  private readonly MAX    = 1000

  /** Retorna o Set de permission keys que o user tem na org (soma de todas as roles). */
  async getUserPermissions(userId: string, orgId: string): Promise<Set<string>> {
    const entry = await this.load(userId, orgId)
    return entry.permissions
  }

  /** Retorna as role keys do user na org. Útil pra UI ("este user é Admin + Operator"). */
  async getUserRoles(userId: string, orgId: string): Promise<string[]> {
    const entry = await this.load(userId, orgId)
    return entry.roles
  }

  /** Snapshot completo pra endpoint /me/permissions. */
  async snapshot(userId: string, orgId: string): Promise<{ permissions: string[]; roles: string[] }> {
    const entry = await this.load(userId, orgId)
    return {
      permissions: [...entry.permissions].sort(),
      roles:       entry.roles,
    }
  }

  /** True se o user tem essa permission key na org. */
  async check(userId: string, orgId: string, key: string): Promise<boolean> {
    const perms = await this.getUserPermissions(userId, orgId)
    return perms.has(key)
  }

  /** Checa múltiplas keys de uma vez. Retorna mapa key→bool. */
  async checkMany(userId: string, orgId: string, keys: string[]): Promise<Record<string, boolean>> {
    const perms = await this.getUserPermissions(userId, orgId)
    const out: Record<string, boolean> = {}
    for (const k of keys) out[k] = perms.has(k)
    return out
  }

  /** Invalida o cache pra um user+org. Chamar após mudar user_roles. */
  invalidate(userId: string, orgId: string): void {
    this.cache.delete(this.key(userId, orgId))
  }

  /** Invalida TODAS as entradas envolvendo essa role (todos os users). Use após
   *  editar role_permissions (mudou o que a role pode fazer). */
  invalidateByRole(roleKey: string): void {
    let dropped = 0
    for (const [k, v] of this.cache) {
      if (v.roles.includes(roleKey)) {
        this.cache.delete(k)
        dropped++
      }
    }
    if (dropped) this.logger.log(`[rbac.cache] invalidated ${dropped} entries for role=${roleKey}`)
  }

  // ─── interno ────────────────────────────────────────────────────────────

  private key(userId: string, orgId: string): string {
    return `${userId}::${orgId}`
  }

  private async load(userId: string, orgId: string): Promise<CacheEntry> {
    const cacheKey = this.key(userId, orgId)
    const now = Date.now()
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      // LRU touch: move pro final
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }

    // 1. Roles do user na org (templates + custom, somando)
    const { data: ur, error: urErr } = await supabaseAdmin
      .from('user_roles')
      .select('role_id, roles:role_id ( key )')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
    if (urErr) {
      this.logger.error(`[rbac.load] user_roles falhou: ${urErr.message}`)
      // Fail-closed: retorna vazio em vez de cachear erro
      return { permissions: new Set(), roles: [], expiresAt: 0 }
    }

    const roleIds  = (ur ?? []).map(r => r.role_id as string)
    const roleKeys = (ur ?? [])
      .map(r => (r.roles as { key?: string } | null)?.key)
      .filter((k): k is string => !!k)

    if (roleIds.length === 0) {
      const entry: CacheEntry = { permissions: new Set(), roles: [], expiresAt: now + this.TTL_MS }
      this.put(cacheKey, entry)
      return entry
    }

    // 2. Permissions agregadas (DISTINCT por key)
    const { data: rp, error: rpErr } = await supabaseAdmin
      .from('role_permissions')
      .select('permissions:permission_id ( key )')
      .in('role_id', roleIds)
    if (rpErr) {
      this.logger.error(`[rbac.load] role_permissions falhou: ${rpErr.message}`)
      return { permissions: new Set(), roles: [], expiresAt: 0 }
    }

    const perms = new Set<string>()
    for (const row of rp ?? []) {
      const k = (row.permissions as { key?: string } | null)?.key
      if (k) perms.add(k)
    }

    const entry: CacheEntry = {
      permissions: perms,
      roles:       roleKeys,
      expiresAt:   now + this.TTL_MS,
    }
    this.put(cacheKey, entry)
    return entry
  }

  private put(key: string, entry: CacheEntry): void {
    if (this.cache.size >= this.MAX) {
      // Drop oldest (insertion order)
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(key, entry)
  }
}
