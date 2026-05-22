import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'

/**
 * AG2 — Leads de formulários editáveis da Loja Própria.
 *
 * A vitrine (seção `leadForm` do Store Builder v3) tem um formulário cujo
 * destino (funil + etapa + responsável) o lojista configura no editor.
 * Quando alguém envia:
 *   1. grava em storefront_leads (status 'received')
 *   2. empurra pro Active CRM via bridge.createLead → contato + deal no funil
 *   3. atualiza status ('pushed' + ids OU 'failed' + error)
 *
 * Se o bridge não estiver configurado, o lead fica 'received' (na fila) e o
 * lojista pode reenviar pelo dashboard quando o Active estiver disponível.
 */

interface LeadFields {
  name?:    string
  email?:   string
  phone?:   string
  message?: string
  custom?:  Record<string, string>
}

export interface StorefrontLead {
  id:                string
  organization_id:   string
  store_slug:        string
  section_id:        string | null
  form_title:        string | null
  pipeline_id:       string
  stage_id:          string
  assigned_to:       string | null
  fields:            LeadFields
  status:            'received' | 'pushed' | 'failed'
  active_deal_id:    string | null
  active_contact_id: string | null
  push_error:        string | null
  pushed_at:         string | null
  created_at:        string
  updated_at:        string
}

@Injectable()
export class StorefrontLeadsService {
  private readonly logger = new Logger(StorefrontLeadsService.name)

  constructor(private readonly bridge: ActiveBridgeClient) {}

  /** Recebe submissão pública da vitrine: grava + tenta push pro Active. */
  async submit(input: {
    slug:        string
    sectionId?:  string
    formTitle?:  string
    pipelineId:  string
    stageId:     string
    assignedTo?: string
    fields:      LeadFields
    ipHash?:     string | null
  }): Promise<{ ok: true; leadId: string; pushed: boolean }> {
    const name  = (input.fields.name ?? '').trim()
    const email = (input.fields.email ?? '').trim().toLowerCase()
    const phone = (input.fields.phone ?? '').replace(/\D/g, '')
    if (!name && !email && !phone) {
      throw new BadRequestException('Preencha pelo menos nome, email ou telefone.')
    }
    if (!input.pipelineId || !input.stageId) {
      throw new BadRequestException('Formulário sem funil de destino configurado.')
    }

    // Resolve org via slug
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', input.slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!store) throw new NotFoundException('Loja não encontrada.')
    const orgId = (store as { organization_id: string }).organization_id

    const cleanFields: LeadFields = {
      ...(name  ? { name }  : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(input.fields.message?.trim() ? { message: input.fields.message.trim() } : {}),
      ...(input.fields.custom && Object.keys(input.fields.custom).length > 0 ? { custom: input.fields.custom } : {}),
    }

    // 1. Grava o lead (status received)
    const { data: lead, error } = await supabaseAdmin
      .from('storefront_leads')
      .insert({
        organization_id: orgId,
        store_slug:      input.slug,
        section_id:      input.sectionId ?? null,
        form_title:      input.formTitle ?? null,
        pipeline_id:     input.pipelineId,
        stage_id:        input.stageId,
        assigned_to:     input.assignedTo ?? null,
        fields:          cleanFields,
        client_ip_hash:  input.ipHash ?? null,
      })
      .select('id')
      .maybeSingle()
    if (error || !lead) throw new BadRequestException(`Erro ao salvar: ${error?.message ?? '?'}`)
    const leadId = (lead as { id: string }).id

    // 2. Empurra pro Active (best-effort)
    const pushed = await this.pushToActive(orgId, leadId)
    return { ok: true, leadId, pushed }
  }

  /** Empurra um lead pro Active e atualiza o status. Retorna se foi pushed. */
  private async pushToActive(orgId: string, leadId: string): Promise<boolean> {
    const { data: leadRaw } = await supabaseAdmin
      .from('storefront_leads')
      .select('*')
      .eq('id', leadId).eq('organization_id', orgId)
      .maybeSingle()
    if (!leadRaw) return false
    const lead = leadRaw as unknown as StorefrontLead

    try {
      const result = await this.bridge.createLead({
        organization_id: orgId,
        pipeline_id:     lead.pipeline_id,
        stage_id:        lead.stage_id,
        assigned_to:     lead.assigned_to ?? undefined,
        contact: {
          name:  lead.fields.name,
          email: lead.fields.email,
          phone: lead.fields.phone,
        },
        title:         lead.form_title ? `${lead.fields.name ?? 'Lead'} — ${lead.form_title}` : undefined,
        message:       lead.fields.message,
        custom_fields: lead.fields.custom,
        tags:          ['lead', 'loja-propria'],
        dedup_key:     `storefront_lead:${leadId}`,
      })

      if (result.skipped_no_bridge) {
        // Bridge indisponível — mantém 'received' pra retry manual
        return false
      }
      await supabaseAdmin
        .from('storefront_leads')
        .update({
          status:            'pushed',
          active_deal_id:    result.deal_id ?? null,
          active_contact_id: result.contact_id ?? null,
          push_error:        null,
          pushed_at:         new Date().toISOString(),
        })
        .eq('id', leadId)
      return true
    } catch (e) {
      await supabaseAdmin
        .from('storefront_leads')
        .update({ status: 'failed', push_error: (e as Error).message.slice(0, 500) })
        .eq('id', leadId)
      this.logger.warn(`[leads] push falhou lead=${leadId}: ${(e as Error).message}`)
      return false
    }
  }

  /** Lojista reenvia um lead que falhou / ficou na fila. */
  async retry(orgId: string, leadId: string): Promise<{ ok: true; pushed: boolean }> {
    const { data } = await supabaseAdmin
      .from('storefront_leads')
      .select('id').eq('id', leadId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Lead não encontrado.')
    const pushed = await this.pushToActive(orgId, leadId)
    return { ok: true, pushed }
  }

  /** Lista pro dashboard do lojista + stats. */
  async listForOwner(orgId: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    items: StorefrontLead[]
    total: number
    stats: { received: number; pushed: number; failed: number }
  }> {
    const limit  = clamp(opts.limit  ?? 50, 1, 200)
    const offset = clamp(opts.offset ?? 0, 0, 9999)
    let q = supabaseAdmin
      .from('storefront_leads')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    q = q.range(offset, offset + limit - 1)
    const { data, count } = await q

    const { data: statRows } = await supabaseAdmin
      .from('storefront_leads')
      .select('status')
      .eq('organization_id', orgId)
    const stats = { received: 0, pushed: 0, failed: 0 }
    for (const r of (statRows ?? []) as Array<{ status: string }>) {
      if (r.status in stats) (stats as unknown as Record<string, number>)[r.status]++
    }

    return { items: (data ?? []) as unknown as StorefrontLead[], total: count ?? 0, stats }
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}
