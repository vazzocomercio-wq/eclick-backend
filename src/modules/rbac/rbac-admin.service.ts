import {
  Injectable, Logger, BadRequestException, NotFoundException, ConflictException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { PermissionService } from './permission.service'

export interface PermissionRow {
  id:            string
  key:           string
  name:          string
  description:   string | null
  module:        string
  action_type:   string
  display_order: number
}

export interface RoleRow {
  id:              string
  organization_id: string | null
  key:             string
  name:            string
  description:     string | null
  is_template:     boolean
  is_system:       boolean
  display_order:   number
}

export interface UserWithRoles {
  user_id:    string
  email:      string | null
  full_name:  string | null
  legacy_role: string | null  // organization_members.role (owner|admin|member)
  roles:      Array<{ id: string; key: string; name: string; is_template: boolean }>
}

/**
 * F17-B6 · Camada de administração do RBAC.
 *
 * Convenções:
 *  - Templates (`is_template=true`, `org_id=NULL`) são imutáveis (is_system=true).
 *    Admin pode atribuir mas NÃO editar/deletar.
 *  - Custom roles vivem dentro de uma org. Admin pode criar, editar, deletar.
 *  - Mutações invalidam cache do PermissionService pros users afetados.
 */
@Injectable()
export class RbacAdminService {
  private readonly logger = new Logger(RbacAdminService.name)

  constructor(private readonly perms: PermissionService) {}

  // ─── Catálogo ───────────────────────────────────────────────────────────

  /** Lista TODAS as permissions (catálogo é global), ordenado por module/order/key. */
  async listPermissions(): Promise<PermissionRow[]> {
    const { data, error } = await supabaseAdmin
      .from('permissions')
      .select('id, key, name, description, module, action_type, display_order')
      .order('module', { ascending: true })
      .order('display_order', { ascending: true })
      .order('key', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as PermissionRow[]
  }

  /** Lista roles disponíveis pra uma org (templates + custom da org). */
  async listRoles(orgId: string): Promise<Array<RoleRow & { permission_count: number }>> {
    const { data: roles, error } = await supabaseAdmin
      .from('roles')
      .select('id, organization_id, key, name, description, is_template, is_system, display_order')
      .or(`is_template.eq.true,organization_id.eq.${orgId}`)
      .order('is_template', { ascending: false })
      .order('display_order', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    const rs = (roles ?? []) as RoleRow[]
    if (rs.length === 0) return []

    // Conta perms por role
    const ids = rs.map(r => r.id)
    const { data: counts } = await supabaseAdmin
      .from('role_permissions')
      .select('role_id')
      .in('role_id', ids)
    const countMap = new Map<string, number>()
    for (const row of (counts ?? []) as Array<{ role_id: string }>) {
      countMap.set(row.role_id, (countMap.get(row.role_id) ?? 0) + 1)
    }

    return rs.map(r => ({ ...r, permission_count: countMap.get(r.id) ?? 0 }))
  }

  /** Retorna a role com a lista completa de permission keys. */
  async getRoleDetail(roleId: string): Promise<RoleRow & { permission_keys: string[] }> {
    const { data: role, error } = await supabaseAdmin
      .from('roles')
      .select('id, organization_id, key, name, description, is_template, is_system, display_order')
      .eq('id', roleId)
      .maybeSingle()
    if (error)  throw new BadRequestException(`Erro: ${error.message}`)
    if (!role)  throw new NotFoundException('Role não encontrada.')

    const { data: rp } = await supabaseAdmin
      .from('role_permissions')
      .select('permissions:permission_id ( key )')
      .eq('role_id', roleId)
    const keys = ((rp ?? []) as Array<{ permissions: { key?: string } | null }>)
      .map(r => r.permissions?.key)
      .filter((k): k is string => !!k)
      .sort()

    return { ...(role as RoleRow), permission_keys: keys }
  }

  // ─── Usuários da org com roles atuais ───────────────────────────────────

  async listUsersWithRoles(orgId: string): Promise<UserWithRoles[]> {
    // 1. Members da org
    const { data: members, error: mErr } = await supabaseAdmin
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', orgId)
    if (mErr) throw new BadRequestException(`Erro: ${mErr.message}`)
    const ms = (members ?? []) as Array<{ user_id: string; role: string }>
    if (ms.length === 0) return []

    const userIds = ms.map(m => m.user_id)

    // 2. user_roles na org
    const { data: ur } = await supabaseAdmin
      .from('user_roles')
      .select('user_id, role_id, roles:role_id ( id, key, name, is_template )')
      .eq('organization_id', orgId)
      .in('user_id', userIds)
    const rolesByUser = new Map<string, UserWithRoles['roles']>()
    for (const row of (ur ?? []) as Array<{
      user_id: string
      roles: { id?: string; key?: string; name?: string; is_template?: boolean } | null
    }>) {
      const r = row.roles
      if (!r?.id || !r.key || !r.name) continue
      const arr = rolesByUser.get(row.user_id) ?? []
      arr.push({ id: r.id, key: r.key, name: r.name, is_template: !!r.is_template })
      rolesByUser.set(row.user_id, arr)
    }

    // 3. Emails e nomes (paginar em auth.users só os necessários)
    const profile = new Map<string, { email: string | null; full_name: string | null }>()
    for (let page = 1; page <= 20; page++) {
      const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
      const users = (data?.users ?? []) as Array<{ id: string; email?: string; user_metadata?: { full_name?: string } }>
      for (const u of users) {
        if (userIds.includes(u.id)) {
          profile.set(u.id, {
            email:     u.email ?? null,
            full_name: u.user_metadata?.full_name ?? null,
          })
        }
      }
      if (profile.size >= userIds.length || users.length < 200) break
    }

    return ms.map(m => ({
      user_id:    m.user_id,
      email:      profile.get(m.user_id)?.email     ?? null,
      full_name:  profile.get(m.user_id)?.full_name ?? null,
      legacy_role: m.role ?? null,
      roles:      rolesByUser.get(m.user_id) ?? [],
    }))
  }

  // ─── Roles (CRUD) ───────────────────────────────────────────────────────

  /** Cria custom role na org. Se baseTemplateKey vier, copia perms do template. */
  async createCustomRole(input: {
    orgId:            string
    key:              string
    name:             string
    description?:     string
    baseTemplateKey?: string
  }): Promise<{ id: string }> {
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    if (key.length < 2) throw new BadRequestException('Key inválida.')
    if (!input.name?.trim()) throw new BadRequestException('Name obrigatório.')

    const { data: role, error } = await supabaseAdmin
      .from('roles')
      .insert({
        organization_id: input.orgId,
        key,
        name:            input.name.trim(),
        description:     input.description?.trim() || null,
        is_template:     false,
        is_system:       false,
      })
      .select('id')
      .single()
    if (error) {
      if (error.code === '23505') throw new ConflictException('Já existe uma role com essa key nesta org.')
      throw new BadRequestException(`Erro ao criar role: ${error.message}`)
    }

    // Copia perms do template base (se informado)
    if (input.baseTemplateKey) {
      const { data: tpl } = await supabaseAdmin
        .from('roles')
        .select('id')
        .eq('key', input.baseTemplateKey)
        .eq('is_template', true)
        .maybeSingle()
      if (tpl?.id) {
        const { data: tplPerms } = await supabaseAdmin
          .from('role_permissions')
          .select('permission_id')
          .eq('role_id', tpl.id)
        const rows = ((tplPerms ?? []) as Array<{ permission_id: string }>).map(p => ({
          role_id:       role.id as string,
          permission_id: p.permission_id,
        }))
        if (rows.length > 0) {
          await supabaseAdmin.from('role_permissions').insert(rows)
        }
      }
    }

    this.logger.log(`[rbac.admin] custom role criada id=${role.id} key=${key} org=${input.orgId}`)
    return { id: role.id as string }
  }

  /** Atualiza role (não-template). Body: name?, description?, permissionKeys?. */
  async updateRole(roleId: string, input: {
    name?:           string
    description?:    string
    permissionKeys?: string[]
  }): Promise<{ ok: true }> {
    const role = await this.requireMutableRole(roleId)

    // 1. Atualiza metadata
    if (input.name !== undefined || input.description !== undefined) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (input.name !== undefined)        patch.name        = input.name.trim()
      if (input.description !== undefined) patch.description = input.description.trim() || null
      const { error } = await supabaseAdmin.from('roles').update(patch).eq('id', roleId)
      if (error) throw new BadRequestException(`Erro ao atualizar role: ${error.message}`)
    }

    // 2. Set permissions (replace-all se permissionKeys vier)
    if (input.permissionKeys !== undefined) {
      const wanted = [...new Set(input.permissionKeys.map(k => k.trim()).filter(Boolean))]

      // Resolve keys → ids
      const { data: perms } = await supabaseAdmin
        .from('permissions')
        .select('id, key')
        .in('key', wanted)
      const valid = (perms ?? []) as Array<{ id: string; key: string }>
      const unknownKeys = wanted.filter(k => !valid.find(p => p.key === k))
      if (unknownKeys.length > 0) {
        throw new BadRequestException(`Permission keys desconhecidas: ${unknownKeys.join(', ')}`)
      }

      // Replace-all transactionally é caro sem rpc — fazemos best-effort:
      // 1. Apaga as ausentes; 2. Insere as novas. Idempotente por PK composto.
      const wantedIds = new Set(valid.map(p => p.id))
      const { data: current } = await supabaseAdmin
        .from('role_permissions')
        .select('permission_id')
        .eq('role_id', roleId)
      const currentIds = new Set(((current ?? []) as Array<{ permission_id: string }>).map(r => r.permission_id))

      const toRemove = [...currentIds].filter(id => !wantedIds.has(id))
      const toAdd    = [...wantedIds].filter(id => !currentIds.has(id))

      if (toRemove.length > 0) {
        await supabaseAdmin.from('role_permissions')
          .delete()
          .eq('role_id', roleId)
          .in('permission_id', toRemove)
      }
      if (toAdd.length > 0) {
        await supabaseAdmin.from('role_permissions').insert(
          toAdd.map(pid => ({ role_id: roleId, permission_id: pid })),
        )
      }
    }

    // Invalida cache pra todos os users que carregam essa role
    this.perms.invalidateByRole(role.key)

    this.logger.log(`[rbac.admin] role atualizada id=${roleId} key=${role.key}`)
    return { ok: true }
  }

  /** Deleta custom role. Templates protegidos pelo Guard de requireMutableRole. */
  async deleteRole(roleId: string): Promise<{ ok: true }> {
    const role = await this.requireMutableRole(roleId)
    const { error } = await supabaseAdmin.from('roles').delete().eq('id', roleId)
    if (error) throw new BadRequestException(`Erro ao deletar role: ${error.message}`)
    this.perms.invalidateByRole(role.key)
    this.logger.log(`[rbac.admin] role deletada id=${roleId} key=${role.key}`)
    return { ok: true }
  }

  // ─── Atribuição user↔role ───────────────────────────────────────────────

  async assignRoleToUser(input: {
    userId:    string
    orgId:     string
    roleKey:   string
    grantedBy: string
  }): Promise<{ ok: true; alreadyHad?: boolean }> {
    // Valida user é member da org
    const { data: member } = await supabaseAdmin
      .from('organization_members')
      .select('user_id')
      .eq('user_id', input.userId)
      .eq('organization_id', input.orgId)
      .maybeSingle()
    if (!member) throw new BadRequestException('Usuário não é membro desta organização.')

    // Resolve role (template OR custom da org)
    const { data: role } = await supabaseAdmin
      .from('roles')
      .select('id, organization_id, is_template')
      .eq('key', input.roleKey)
      .or(`is_template.eq.true,organization_id.eq.${input.orgId}`)
      .maybeSingle()
    if (!role) throw new NotFoundException(`Role ${input.roleKey} não disponível pra esta org.`)

    const { error } = await supabaseAdmin
      .from('user_roles')
      .insert({
        user_id:         input.userId,
        organization_id: input.orgId,
        role_id:         role.id as string,
        granted_by:      input.grantedBy,
      })
    if (error) {
      if (error.code === '23505') {
        this.logger.log(`[rbac.admin] assign noop (já tinha) user=${input.userId} role=${input.roleKey}`)
        return { ok: true, alreadyHad: true }
      }
      throw new BadRequestException(`Erro ao atribuir role: ${error.message}`)
    }

    this.perms.invalidate(input.userId, input.orgId)
    this.logger.log(`[rbac.admin] assign ok user=${input.userId} role=${input.roleKey} org=${input.orgId}`)
    return { ok: true }
  }

  async revokeRoleFromUser(input: {
    userId: string
    orgId:  string
    roleId: string
  }): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('user_roles')
      .delete()
      .eq('user_id', input.userId)
      .eq('organization_id', input.orgId)
      .eq('role_id', input.roleId)
    if (error) throw new BadRequestException(`Erro ao revogar role: ${error.message}`)
    this.perms.invalidate(input.userId, input.orgId)
    this.logger.log(`[rbac.admin] revoke ok user=${input.userId} role=${input.roleId} org=${input.orgId}`)
    return { ok: true }
  }

  // ─── interno ────────────────────────────────────────────────────────────

  /** Busca role e garante que NÃO é template/system (templates são read-only). */
  private async requireMutableRole(roleId: string): Promise<{ id: string; key: string }> {
    const { data: role, error } = await supabaseAdmin
      .from('roles')
      .select('id, key, is_template, is_system')
      .eq('id', roleId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!role) throw new NotFoundException('Role não encontrada.')
    if (role.is_template || role.is_system) {
      throw new BadRequestException('Templates fixos não podem ser editados. Crie uma role customizada copiando este template.')
    }
    return { id: role.id as string, key: role.key as string }
  }
}
