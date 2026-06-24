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

export interface FarmCommandOut { id: string; serial: string; command_type: string; payload: Record<string, unknown> }

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
  async ingest(token: string, body: { agent_version?: string; printers?: TelemetryPrinter[]; command_results?: Array<{ id: string; ok: boolean; result?: string }> }): Promise<{ ok: true; matched: number; unmatched: string[]; commands: FarmCommandOut[] }> {
    if (!token) throw new UnauthorizedException('token ausente')
    const { data: agent } = await supabaseAdmin.from('farm_agent')
      .select('id, organization_id, status').eq('token', token).maybeSingle()
    const a = agent as { id: string; organization_id: string; status: string } | null
    if (!a || a.status !== 'ativo') throw new UnauthorizedException('agente inválido ou revogado')

    await supabaseAdmin.from('farm_agent')
      .update({ last_seen_at: new Date().toISOString(), version: body.agent_version ?? null })
      .eq('id', a.id)

    // acks dos comandos que o agente executou
    for (const cr of body.command_results ?? []) {
      await supabaseAdmin.from('farm_command')
        .update({ status: cr.ok ? 'done' : 'failed', result: cr.result ?? null, done_at: new Date().toISOString() })
        .eq('id', cr.id).eq('organization_id', a.organization_id).eq('status', 'sent')
    }

    const printers = body.printers ?? []
    const serials = printers.map(p => p.serial).filter(Boolean)
    const unmatched: string[] = []
    let matched = 0
    if (printers.length) {
      const { data: bound } = await supabaseAdmin.from('production_printer')
        .select('id, serial_number').eq('organization_id', a.organization_id).in('serial_number', serials)
      const idBySerial = new Map((bound ?? []).map(b => [(b as { serial_number: string }).serial_number, (b as { id: string }).id]))
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
      if (matched > 0) {
        await supabaseAdmin.from('production_printer')
          .update({ agent_id: a.id }).eq('organization_id', a.organization_id).in('serial_number', serials).is('agent_id', null)
      }
    }

    // entrega comandos pendentes das impressoras desse agente
    const commands = await this.pullCommands(a.id, a.organization_id)
    return { ok: true, matched, unmatched, commands }
  }

  /** Comandos pendentes das impressoras ligadas a este agente; marca como enviados. */
  private async pullCommands(agentId: string, orgId: string): Promise<FarmCommandOut[]> {
    const { data: mine } = await supabaseAdmin.from('production_printer')
      .select('id, serial_number').eq('organization_id', orgId).eq('agent_id', agentId)
    const serialByPid = new Map((mine ?? []).map(p => [(p as { id: string }).id, (p as { serial_number: string }).serial_number]))
    const pids = [...serialByPid.keys()]
    if (!pids.length) return []
    const { data: pend } = await supabaseAdmin.from('farm_command')
      .select('id, printer_id, command_type, payload').eq('status', 'pending').in('printer_id', pids)
    const out: FarmCommandOut[] = (pend ?? []).map(c => {
      const cmd = c as { id: string; printer_id: string; command_type: string; payload: Record<string, unknown> | null }
      return { id: cmd.id, serial: serialByPid.get(cmd.printer_id) ?? '', command_type: cmd.command_type, payload: cmd.payload ?? {} }
    })
    if (out.length) await supabaseAdmin.from('farm_command').update({ status: 'sent', sent_at: new Date().toISOString() }).in('id', out.map(c => c.id))
    return out
  }

  // ── enfileirar comandos (chamado pela tela) ───────────────────────
  async enqueueCommand(orgId: string, printerId: string, type: string, payload: Record<string, unknown>, userId: string | null) {
    const { data: pr } = await supabaseAdmin.from('production_printer')
      .select('id, serial_number, agent_id').eq('id', printerId).eq('organization_id', orgId).maybeSingle()
    if (!pr) throw new BadRequestException('Impressora não encontrada')
    const p = pr as { serial_number: string | null; agent_id: string | null }
    if (!p.serial_number || !p.agent_id) throw new BadRequestException('Impressora não está conectada ao agente. Cadastre o nº de série e deixe o agente rodando.')
    const { data, error } = await supabaseAdmin.from('farm_command')
      .insert({ organization_id: orgId, printer_id: printerId, command_type: type, payload: payload ?? {}, created_by: userId })
      .select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao enfileirar: ${error?.message ?? 'sem dados'}`)
    return { ok: true, command_id: (data as { id: string }).id }
  }

  /** Despacha o arquivo de uma ordem de produção pra impressora dela. */
  async sendOrderToPrinter(orgId: string, orderId: string, userId: string | null) {
    const { data: order } = await supabaseAdmin.from('production_order')
      .select('id, printer_id, version_id').eq('id', orderId).eq('organization_id', orgId).maybeSingle()
    if (!order) throw new BadRequestException('Ordem não encontrada')
    const o = order as { printer_id: string | null; version_id: string | null }
    if (!o.printer_id) throw new BadRequestException('A ordem não tem impressora definida.')
    let fileUrl: string | null = null, fileName = 'job.3mf'
    if (o.version_id) {
      const { data: v } = await supabaseAdmin.from('product_dev_version').select('file_url, version_number').eq('id', o.version_id).maybeSingle()
      fileUrl = (v as { file_url: string | null } | null)?.file_url ?? null
      fileName = `v${(v as { version_number: number } | null)?.version_number ?? 1}.3mf`
    }
    if (!fileUrl) throw new BadRequestException('A versão não tem arquivo (.3mf) para enviar à impressora.')
    return this.enqueueCommand(orgId, o.printer_id, 'print', { file_url: fileUrl, file_name: fileName, order_id: orderId }, userId)
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
