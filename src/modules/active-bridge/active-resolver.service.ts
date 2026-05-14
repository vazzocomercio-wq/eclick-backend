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
  member_id:    string  // active.org_members.id
  user_id:      string
  display_name: string | null
  role:         string
  status:       string  // 'active' | 'invited' | 'disabled'
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
      .select('id, user_id, display_name, role, status')
      .eq('org_id', org_id)
      .in('status', ['active', 'invited'])
      .order('display_name', { ascending: true, nullsFirst: false })
    if (error) throw new Error(`listAgents: ${error.message}`)
    return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
      member_id:    row.id as string,
      user_id:      row.user_id as string,
      display_name: (row.display_name as string | null) ?? null,
      role:         row.role as string,
      status:       row.status as string,
    }))
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
