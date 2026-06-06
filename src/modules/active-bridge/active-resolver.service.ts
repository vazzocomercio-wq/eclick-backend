/**
 * ActiveResolverService — lê schema `active.*` direto via Supabase pra
 * popular dropdowns no SaaS (agentes, pipelines, stages).
 *
 * Resolução: SaaS user_id (do JWT) → busca org Active onde ele é member
 * → retorna dados dessa org.
 *
 * Hoje cobre: org_members, pipelines, pipeline_stages.
 *
 * Pré-requisito: SaaS e Active compartilham o mesmo projeto Supabase
 * (confirmado em 2026-05-14 — schemas `public` e `active` no mesmo DB).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface ActiveAgent {
  member_id:      string  // active.org_members.id
  user_id:        string
  display_name:   string | null
  role:           string
  status:         string  // 'active' | 'invited' | 'disabled'
  whatsapp_phone: string | null  // p/ alerta de tarefa urgente (null = sem alerta)
}

export interface ActiveMemberContact {
  display_name:   string | null
  whatsapp_phone: string | null
}

export interface ActivePipeline {
  id:            string
  name:          string
  is_default:    boolean
  description:   string | null
  template_key:  string | null
}

export interface ActiveStage {
  id:           string
  pipeline_id:  string
  name:         string
  position:     number
  color:        string | null
  is_won:       boolean
  is_lost:      boolean
}

@Injectable()
export class ActiveResolverService {
  private readonly log = new Logger(ActiveResolverService.name)

  /**
   * Resolve org Active a partir de um user SaaS. Assume que o user SaaS
   * é também membro de uma org Active (relação 1:1 hoje).
   */
  async resolveActiveOrgForUser(saasUserId: string): Promise<{ org_id: string; member_id: string }> {
    const { data, error } = await supabaseAdmin
      .schema('active')
      .from('org_members')
      .select('id, org_id')
      .eq('user_id', saasUserId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) {
      this.log.warn(`[resolveActiveOrg] erro: ${error.message}`)
      throw new NotFoundException('Usuário não é membro de nenhuma org no Active CRM')
    }
    if (!data) {
      throw new NotFoundException('Usuário não tem org no Active CRM (verificar org_members)')
    }
    return { org_id: data.org_id as string, member_id: data.id as string }
  }

  /** Lista agentes (todos members ativos + convidados) de uma org Active. */
  async listAgents(saasUserId: string): Promise<ActiveAgent[]> {
    const { org_id } = await this.resolveActiveOrgForUser(saasUserId)
    const { data, error } = await supabaseAdmin
      .schema('active')
      .from('org_members')
      .select('id, user_id, display_name, role, status, whatsapp_phone')
      .eq('org_id', org_id)
      .in('status', ['active', 'invited'])
      .order('display_name', { ascending: true, nullsFirst: false })
    if (error) throw new Error(`listAgents: ${error.message}`)
    return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
      member_id:      row.id as string,
      user_id:        row.user_id as string,
      display_name:   (row.display_name as string | null) ?? null,
      role:           row.role as string,
      status:         row.status as string,
      whatsapp_phone: (row.whatsapp_phone as string | null) ?? null,
    }))
  }

  /**
   * Contato (nome + WhatsApp) de um membro Active por user_id dentro de uma
   * org Active. Usado pra disparar alerta de tarefa URGENTE no WhatsApp do
   * operador. Retorna null se não achar membro. whatsapp_phone null = operador
   * sem número cadastrado (sem alerta).
   */
  async getMemberContact(activeOrgId: string, userId: string): Promise<ActiveMemberContact | null> {
    const { data, error } = await supabaseAdmin
      .schema('active')
      .from('org_members')
      .select('display_name, whatsapp_phone')
      .eq('org_id', activeOrgId)
      .eq('user_id', userId)
      .in('status', ['active', 'invited'])
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) {
      this.log.warn(`[getMemberContact] erro: ${error.message}`)
      return null
    }
    if (!data) return null
    return {
      display_name:   (data.display_name as string | null) ?? null,
      whatsapp_phone: (data.whatsapp_phone as string | null) ?? null,
    }
  }

  // ── Fonte SaaS: Equipe do SaaS como operadores ──────────────────────────────

  /**
   * Lista operadores = membros da Equipe do SaaS (public.organization_members)
   * da org, QUANDO a org tem o módulo 'active' ligado (enabled_modules contém
   * 'active', ou é NULL = tudo liberado). Nome vem do auth.users; WhatsApp da
   * própria organization_members (fonte da verdade). Shape compatível com
   * ActiveAgent — o dropdown da Operação de Cadastro consome igual.
   */
  async listSaasOperators(saasOrgId: string): Promise<ActiveAgent[]> {
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('enabled_modules')
      .eq('id', saasOrgId)
      .maybeSingle()
    const enabled = (org as { enabled_modules?: string[] | null } | null)?.enabled_modules
    if (enabled != null && !enabled.includes('active')) return []  // módulo Active desligado p/ a org

    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('user_id, role, whatsapp_phone, created_at')
      .eq('organization_id', saasOrgId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`listSaasOperators: ${error.message}`)
    const rows = (data ?? []) as Array<{ user_id: string; role: string | null; whatsapp_phone: string | null }>
    if (rows.length === 0) return []

    const profiles = await this.fetchUserProfiles(rows.map(r => r.user_id))
    return rows.map(r => {
      const p = profiles.get(r.user_id)
      return {
        member_id:      r.user_id,
        user_id:        r.user_id,
        display_name:   p?.name ?? p?.email ?? null,
        role:           r.role ?? 'member',
        status:         'active',
        whatsapp_phone: r.whatsapp_phone ?? null,
      }
    })
  }

  /**
   * Contato (nome + WhatsApp) do operador na Equipe do SaaS. Fonte da verdade
   * do WhatsApp pro alerta de tarefa URGENTE. Nome vem do auth.users.
   */
  async getSaasMemberContact(saasOrgId: string, userId: string): Promise<ActiveMemberContact | null> {
    const { data } = await supabaseAdmin
      .from('organization_members')
      .select('whatsapp_phone')
      .eq('organization_id', saasOrgId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!data) return null
    const profiles = await this.fetchUserProfiles([userId])
    const p = profiles.get(userId)
    return {
      display_name:   p?.name ?? p?.email ?? null,
      whatsapp_phone: (data as { whatsapp_phone: string | null }).whatsapp_phone ?? null,
    }
  }

  /**
   * Garante (idempotente) que o operador (user do SaaS) é membro do Active na
   * org Active do gestor — pré-requisito pra receber/ver o card da Operação de
   * Cadastro. Cria como 'agent'/'active' se não existir; se já existe, só
   * espelha o WhatsApp quando o do Active está vazio (não sobrescreve
   * role/nome/whatsapp já preenchidos). Best-effort (nunca lança).
   */
  async ensureActiveMembership(
    activeOrgId: string,
    userId: string,
    displayName: string | null,
    whatsappPhone: string | null,
  ): Promise<void> {
    try {
      const { data: existing } = await supabaseAdmin
        .schema('active')
        .from('org_members')
        .select('id, whatsapp_phone')
        .eq('org_id', activeOrgId)
        .eq('user_id', userId)
        .maybeSingle()

      if (!existing) {
        const { error } = await supabaseAdmin
          .schema('active')
          .from('org_members')
          .insert({
            org_id:         activeOrgId,
            user_id:        userId,
            role:           'agent',
            status:         'active',
            display_name:   displayName,
            whatsapp_phone: whatsappPhone,
          })
        if (error) this.log.warn(`[ensureActiveMembership] insert falhou: ${error.message}`)
        else this.log.log(`[ensureActiveMembership] operador ${userId} provisionado na org Active ${activeOrgId}`)
        return
      }

      const cur = (existing as { id: string; whatsapp_phone: string | null }).whatsapp_phone
      if (!cur && whatsappPhone) {
        await supabaseAdmin
          .schema('active')
          .from('org_members')
          .update({ whatsapp_phone: whatsappPhone })
          .eq('id', (existing as { id: string }).id)
      }
    } catch (e) {
      this.log.warn(`[ensureActiveMembership] falhou: ${(e as Error).message}`)
    }
  }

  /** Map user_id → {name,email} via auth admin (getUserById em paralelo).
   *  Best-effort: devolve vazio se admin auth indisponível. */
  private async fetchUserProfiles(
    userIds: string[],
  ): Promise<Map<string, { name: string | null; email: string | null }>> {
    const map = new Map<string, { name: string | null; email: string | null }>()
    if (userIds.length === 0) return map
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (supabaseAdmin as any).auth?.admin
    if (!auth?.getUserById) return map
    await Promise.all([...new Set(userIds)].map(async (id) => {
      try {
        const { data } = await auth.getUserById(id)
        const u = data?.user
        if (!u) return
        const meta = (u.user_metadata ?? {}) as Record<string, unknown>
        const name = (meta.full_name as string | undefined) ?? (meta.name as string | undefined) ?? null
        map.set(id, { name: name ?? null, email: (u.email as string | null) ?? null })
      } catch {
        /* ignora user inacessível */
      }
    }))
    return map
  }

  /** Lista pipelines não-arquivados de uma org Active. */
  async listPipelines(saasUserId: string): Promise<ActivePipeline[]> {
    const { org_id } = await this.resolveActiveOrgForUser(saasUserId)
    const { data, error } = await supabaseAdmin
      .schema('active')
      .from('pipelines')
      .select('id, name, is_default, description, settings')
      .eq('org_id', org_id)
      .is('archived_at', null)
      .order('is_default', { ascending: false })
      .order('name', { ascending: true })
    if (error) throw new Error(`listPipelines: ${error.message}`)
    return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
      id:           row.id as string,
      name:         row.name as string,
      is_default:   Boolean(row.is_default),
      description:  (row.description as string | null) ?? null,
      template_key: ((row.settings as Record<string, unknown> | null)?.template_key as string | undefined) ?? null,
    }))
  }

  /**
   * Acha o deal Active vinculado a um produto do catálogo SaaS.
   *
   * O vínculo vem de `product_operator_assignments` — a row criada quando
   * o gestor despacha o produto pra Operação de Cadastro (cria 1 card no
   * funil "Anúncios ML" do Active). Retorna o `active_deal_id` da
   * assignment mais recente (o card vivo), ou null se o produto nunca foi
   * despachado.
   *
   * Não filtra por status da assignment de propósito: o que importa é o
   * deal, e o move-card do bridge já é forward-only + idempotente.
   */
  async findCardDealForProduct(
    orgId:            string,
    catalogProductId: string,
  ): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('product_operator_assignments')
      .select('active_deal_id')
      .eq('organization_id', orgId)
      .eq('product_id', catalogProductId)
      .not('active_deal_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { active_deal_id: string | null } | null)?.active_deal_id ?? null
  }

  /** Lista stages de um pipeline ordenados por position. */
  async listStages(saasUserId: string, pipelineId: string): Promise<ActiveStage[]> {
    // Resolve org pra defender contra IDs de outra org
    const { org_id } = await this.resolveActiveOrgForUser(saasUserId)

    // Confirma que o pipeline pertence à org do user
    const { data: pipe } = await supabaseAdmin
      .schema('active')
      .from('pipelines')
      .select('id, org_id')
      .eq('id', pipelineId)
      .maybeSingle()
    if (!pipe || (pipe as { org_id: string }).org_id !== org_id) {
      throw new NotFoundException('Pipeline não pertence à org do usuário')
    }

    const { data, error } = await supabaseAdmin
      .schema('active')
      .from('pipeline_stages')
      .select('id, pipeline_id, name, position, color, is_won, is_lost')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true })
    if (error) throw new Error(`listStages: ${error.message}`)
    return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
      id:          row.id as string,
      pipeline_id: row.pipeline_id as string,
      name:        row.name as string,
      position:    Number(row.position ?? 0),
      color:       (row.color as string | null) ?? null,
      is_won:      Boolean(row.is_won),
      is_lost:     Boolean(row.is_lost),
    }))
  }
}
