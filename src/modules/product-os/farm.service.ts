import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — Fase A: monitoramento da farm.
 * O agente local (na fábrica) lê o MQTT das impressoras e envia telemetria
 * pra cá autenticando por token. Guardamos o último estado por impressora.
 */

export interface TelemetryPrinter {
  serial: string
  online?: boolean
  state?: string
  job_name?: string
  progress_pct?: number
  layer_current?: number
  layer_total?: number
  nozzle_temp?: number
  bed_temp?: number
  remaining_minutes?: number
  ams?: unknown
  error_code?: string
  error_text?: string
  raw?: unknown
}

const STALE_MS = 90_000  // sem telemetria há 90s → considera offline/stale

@Injectable()
export class FarmService {
  private readonly logger = new Logger(FarmService.name)

  // ── agentes ───────────────────────────────────────────────────────
  async createAgent(orgId: string, name: string): Promise<{ id: string; name: string; token: string }> {
    if (!name?.trim()) throw new BadRequestException('Nome do agente é obrigatório')
    const token = randomBytes(24).toString('hex')
    const { data, error } = await supabaseAdmin.from('farm_agent')
      .insert({ organization_id: orgId, name: name.trim(), token })
      .select('id, name, token').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar agente: ${error?.message ?? 'sem dados'}`)
    return data as { id: string; name: string; token: string }
  }

  async listAgents(orgId: string) {
    const { data, error } = await supabaseAdmin.from('farm_agent')
      .select('id, name, status, version, last_seen_at, created_at')
      .eq('organization_id', orgId).order('created_at', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(a => ({ ...(a as Record<string, unknown>), online: this.isFresh((a as { last_seen_at: string | null }).last_seen_at) }))
  }

  async revokeAgent(orgId: string, id: string) {
    const { error } = await supabaseAdmin.from('farm_agent').update({ status: 'revogado' }).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── ingestão de telemetria (chamada PELO agente, auth por token) ──
  async ingest(token: string, body: { agent_version?: string; printers?: TelemetryPrinter[] }): Promise<{ ok: true; matched: number; unmatched: string[] }> {
    if (!token) throw new UnauthorizedException('token ausente')
    const { data: agent } = await supabaseAdmin.from('farm_agent')
      .select('id, organization_id, status').eq('token', token).maybeSingle()
    const a = agent as { id: string; organization_id: string; status: string } | null
    if (!a || a.status !== 'ativo') throw new UnauthorizedException('agente inválido ou revogado')

    await supabaseAdmin.from('farm_agent')
      .update({ last_seen_at: new Date().toISOString(), version: body.agent_version ?? null })
      .eq('id', a.id)

    const printers = body.printers ?? []
    if (!printers.length) return { ok: true, matched: 0, unmatched: [] }

    // casa por número de série dentro da org
    const serials = printers.map(p => p.serial).filter(Boolean)
    const { data: bound } = await supabaseAdmin.from('production_printer')
      .select('id, serial_number').eq('organization_id', a.organization_id).in('serial_number', serials)
    const idBySerial = new Map((bound ?? []).map(b => [(b as { serial_number: string }).serial_number, (b as { id: string }).id]))

    const unmatched: string[] = []
    let matched = 0
    const now = new Date().toISOString()
    for (const p of printers) {
      const printerId = idBySerial.get(p.serial)
      if (!printerId) { unmatched.push(p.serial); continue }
      await supabaseAdmin.from('printer_status').upsert({
        printer_id: printerId, organization_id: a.organization_id,
        online: p.online ?? true, state: p.state ?? null, job_name: p.job_name ?? null,
        progress_pct: p.progress_pct ?? null, layer_current: p.layer_current ?? null, layer_total: p.layer_total ?? null,
        nozzle_temp: p.nozzle_temp ?? null, bed_temp: p.bed_temp ?? null, remaining_minutes: p.remaining_minutes ?? null,
        ams: p.ams ?? null, error_code: p.error_code ?? null, error_text: p.error_text ?? null,
        raw: p.raw ?? null, updated_at: now,
      }, { onConflict: 'printer_id' })
      matched++
    }
    // bind o agente às impressoras casadas (1ª vez)
    if (matched > 0) {
      await supabaseAdmin.from('production_printer')
        .update({ agent_id: a.id }).eq('organization_id', a.organization_id).in('serial_number', serials).is('agent_id', null)
    }
    return { ok: true, matched, unmatched }
  }

  // ── estado ao vivo (lido pela tela) ───────────────────────────────
  async status(orgId: string) {
    const { data: printers } = await supabaseAdmin.from('production_printer')
      .select('id, name, brand, model, status, serial_number').eq('organization_id', orgId).order('name')
    const { data: statuses } = await supabaseAdmin.from('printer_status')
      .select('*').eq('organization_id', orgId)
    const byId = new Map((statuses ?? []).map(s => [(s as { printer_id: string }).printer_id, s as Record<string, unknown>]))

    return (printers ?? []).map(p => {
      const pr = p as { id: string; name: string; brand: string | null; model: string | null; status: string; serial_number: string | null }
      const st = byId.get(pr.id)
      const fresh = st ? this.isFresh(st.updated_at as string) : false
      return {
        id: pr.id, name: pr.name, brand: pr.brand, model: pr.model, config_status: pr.status,
        bound: !!pr.serial_number,
        online: fresh && (st?.online === true),
        state: !st ? 'sem_dados' : !fresh ? 'offline' : (st.state as string) ?? 'idle',
        job_name: st?.job_name ?? null,
        progress_pct: st?.progress_pct ?? null,
        layer_current: st?.layer_current ?? null, layer_total: st?.layer_total ?? null,
        nozzle_temp: st?.nozzle_temp ?? null, bed_temp: st?.bed_temp ?? null,
        remaining_minutes: st?.remaining_minutes ?? null,
        ams: st?.ams ?? null, error_code: st?.error_code ?? null, error_text: st?.error_text ?? null,
        last_update: st?.updated_at ?? null,
      }
    })
  }

  private isFresh(ts: string | null | undefined): boolean {
    if (!ts) return false
    return Date.now() - new Date(ts).getTime() < STALE_MS
  }
}
