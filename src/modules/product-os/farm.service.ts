import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionService } from './production.service'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'

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
  light_on?: boolean
  /** sinal de detecção de falha vindo do agente (xcam/halt da Bambu) */
  detection?: { failure?: boolean; reason?: string; sensitivity?: string }
  raw?: unknown
}

export interface FarmCommandOut { id: string; serial: string; command_type: string; payload: Record<string, unknown> }

const STALE_MS = 90_000  // sem telemetria há 90s → considera offline/stale

@Injectable()
export class FarmService {
  private readonly logger = new Logger(FarmService.name)

  constructor(
    private readonly production: ProductionService,
    private readonly bridge: ActiveBridgeClient,
  ) {}

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
  async ingest(token: string, body: { agent_version?: string; printers?: TelemetryPrinter[]; command_results?: Array<{ id: string; ok: boolean; result?: string }> }): Promise<{ ok: true; matched: number; unmatched: string[]; commands: FarmCommandOut[]; detection_config: Record<string, { enabled: boolean; sensitivity: string }> }> {
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
    const finished: string[] = []
    const failures: Array<{ printerId: string; p: TelemetryPrinter }> = []
    const detection_config: Record<string, { enabled: boolean; sensitivity: string }> = {}
    if (printers.length) {
      const { data: bound } = await supabaseAdmin.from('production_printer')
        .select('id, serial_number, ai_detection_enabled, ai_sensitivity').eq('organization_id', a.organization_id).in('serial_number', serials)
      const idBySerial = new Map((bound ?? []).map(b => [(b as { serial_number: string }).serial_number, (b as { id: string }).id]))
      const cfgByPid = new Map((bound ?? []).map(b => {
        const r = b as { id: string; serial_number: string; ai_detection_enabled: boolean | null; ai_sensitivity: string | null }
        detection_config[r.serial_number] = { enabled: r.ai_detection_enabled !== false, sensitivity: r.ai_sensitivity || 'medium' }
        return [r.id, detection_config[r.serial_number]]
      }))
      const pids = [...idBySerial.values()]
      const { data: prev } = pids.length ? await supabaseAdmin.from('printer_status').select('printer_id, state').in('printer_id', pids) : { data: [] }
      const prevState = new Map((prev ?? []).map(s => [(s as { printer_id: string }).printer_id, (s as { state: string }).state]))
      const now = new Date().toISOString()
      for (const p of printers) {
        const printerId = idBySerial.get(p.serial)
        if (!printerId) { unmatched.push(p.serial); continue }
        const before = prevState.get(printerId)
        await supabaseAdmin.from('printer_status').upsert({
          printer_id: printerId, organization_id: a.organization_id,
          online: p.online ?? true, state: p.state ?? null, job_name: p.job_name ?? null,
          progress_pct: p.progress_pct ?? null, layer_current: p.layer_current ?? null, layer_total: p.layer_total ?? null,
          nozzle_temp: p.nozzle_temp ?? null, bed_temp: p.bed_temp ?? null, remaining_minutes: p.remaining_minutes ?? null,
          ams: p.ams ?? null, error_code: p.error_code ?? null, error_text: p.error_text ?? null,
          light_on: p.light_on ?? null,
          raw: p.raw ?? null, updated_at: now,
        }, { onConflict: 'printer_id' })
        matched++
        // sincroniza a OP com o estado da impressora (só quando muda)
        if (before !== p.state) {
          if (before === 'printing' && p.state === 'idle') finished.push(printerId) // terminou → auto-fecha
          else await this.syncOrderState(a.organization_id, printerId, p.state ?? '').catch(() => {})
        }
        // T1-A: vigilância de falha (só se ligada pra esta impressora)
        if (cfgByPid.get(printerId)?.enabled !== false && this.isFailureSignal(p)) failures.push({ printerId, p })
      }
      if (matched > 0) {
        await supabaseAdmin.from('production_printer')
          .update({ agent_id: a.id }).eq('organization_id', a.organization_id).in('serial_number', serials).is('agent_id', null)
      }
    }
    for (const pid of finished) await this.autoCloseFinished(a.organization_id, pid).catch(e => this.logger.warn(`[farm.autoclose] ${(e as Error).message}`))
    for (const f of failures) await this.handleFailure(a.organization_id, f.printerId, f.p).catch(e => this.logger.warn(`[farm.failure] ${(e as Error).message}`))
    // lights-out: impressora que terminou → inicia sozinha a próxima ordem (se auto_dispatch ligado)
    for (const pid of finished) await this.autoDispatch(a.organization_id, { printerId: pid }).catch(e => this.logger.warn(`[farm.autodispatch] ${(e as Error).message}`))

    // entrega comandos pendentes das impressoras desse agente
    const commands = await this.pullCommands(a.id, a.organization_id)
    return { ok: true, matched, unmatched, commands, detection_config }
  }

  /** Sinal de que a impressão foi interrompida por falha:
   *  detecção on-board da Bambu disparou (agente), OU a impressora reportou
   *  erro/pausa com código de erro (spaghetti/first-layer/HMS pausam a A1). */
  private isFailureSignal(p: TelemetryPrinter): boolean {
    if (p.detection?.failure === true) return true
    if (p.state === 'error' || p.state === 'failed') return true
    if (p.state === 'paused' && !!p.error_code) return true   // pausa com erro = halt automático, não pausa do usuário
    return false
  }

  /** Registra a falha (KPI), garante a pausa e avisa o lojista (WhatsApp + câmera).
   *  Dedupe: 1 alerta aberto por (impressora, job) — não repete a cada ciclo de 5s. */
  private async handleFailure(orgId: string, printerId: string, p: TelemetryPrinter) {
    const jobName = p.job_name ?? null
    // já existe alerta aberto pra este job? → não duplica
    const { data: open } = await supabaseAdmin.from('printer_failure_event')
      .select('id, job_name').eq('printer_id', printerId).is('acknowledged_at', null).limit(5)
    if ((open ?? []).some(o => (o as { job_name: string | null }).job_name === jobName)) return

    // OP ativa desta impressora (pra linkar + saber o produto)
    const { data: order } = await supabaseAdmin.from('production_order')
      .select('id, product_dev_id').eq('organization_id', orgId).eq('printer_id', printerId)
      .in('status', ['imprimindo', 'pausado']).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    const o = order as { id: string; product_dev_id: string } | null

    const reason = p.detection?.reason || p.error_text || (p.error_code ? `erro ${p.error_code}` : 'interrupção inesperada')
    const cameraUrl = this.camUrl(printerId)

    // garante pausa: se a impressora ainda não está pausada, manda pausar
    let autoPaused = false
    if (p.state !== 'paused') {
      await this.enqueueCommand(orgId, printerId, 'pause', {}, null).then(() => { autoPaused = true }).catch(() => {})
    }

    const { error: insErr } = await supabaseAdmin.from('printer_failure_event').insert({
      organization_id: orgId, printer_id: printerId, production_order_id: o?.id ?? null,
      job_name: jobName, source: 'bambu_native', reason, error_code: p.error_code ?? null, state: p.state ?? null,
      camera_url: cameraUrl, auto_paused: autoPaused,
    })
    if (insErr) { this.logger.warn(`[farm.failure] insert: ${insErr.message}`); return }  // corrida → outro ciclo já gravou

    if (o) await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: o.product_dev_id, event_type: 'failure_detected',
      payload: { production_order_id: o.id, printer_id: printerId, reason, error_code: p.error_code ?? null, auto_paused: autoPaused }, is_auto: true,
    }).then(() => {}, () => {})

    // nome da impressora pro alerta
    const { data: pr } = await supabaseAdmin.from('production_printer').select('name').eq('id', printerId).maybeSingle()
    const pname = (pr as { name: string } | null)?.name ?? 'impressora'
    const msg = `🛑 *Falha na impressão detectada* (Product OS)\n\n` +
      `*${pname}* interrompeu ${jobName ? `*${jobName}*` : 'a impressão'} — ${reason}.\n` +
      `${autoPaused ? 'A produção foi *pausada automaticamente*.' : 'A impressora *parou*.'}\n\n` +
      `Confira a câmera ao vivo e *retome* ou *cancele* no painel da Fábrica.`
    await this.bridge.notifyLojista({ organization_id: orgId, message: msg, severity: 'high', deeplink: 'producao/product-os' }).catch(() => {})
    this.logger.warn(`[farm] FALHA detectada na impressora ${printerId.slice(0, 8)} (${reason}) — alerta enviado`)
  }

  private camUrl(printerId: string): string | null {
    const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
    return base ? `${base}/storage/v1/object/public/product-os/cam/${printerId}.jpg` : null
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
      .select('id, status, printer_id, version_id, part_id, reservation_id, filament_map').eq('id', orderId).eq('organization_id', orgId).maybeSingle()
    if (!order) throw new BadRequestException('Ordem não encontrada')
    const o = order as { status: string; printer_id: string | null; version_id: string | null; part_id: string | null; reservation_id: string | null; filament_map: Array<{ index: number; input_id: string }> | null }
    // só manda job pra máquina a partir da fila/reimpressão — fora disso seria imprimir DE NOVO uma ordem em andamento/pronta
    if (!['fila', 'reimpressao'].includes(o.status)) throw new BadRequestException(`Esta OP está em '${o.status}' — enviar agora imprimiria o job de novo. Só ordens na Fila ou em Reimpressão podem ser enviadas.`)
    if (!o.printer_id) throw new BadRequestException('A ordem não tem impressora definida.')
    let fileUrl: string | null = null, fileName = 'job.3mf'
    if (o.version_id) {
      const { data: v } = await supabaseAdmin.from('product_dev_version').select('file_url, version_number').eq('id', o.version_id).maybeSingle()
      fileUrl = (v as { file_url: string | null } | null)?.file_url ?? null
      fileName = `v${(v as { version_number: number } | null)?.version_number ?? 1}.3mf`
    }
    // fallback: OP de peça sem version_id → pega a versão mais recente da peça que tenha arquivo
    if (!fileUrl && o.part_id) {
      const { data: v } = await supabaseAdmin.from('product_dev_version').select('file_url, version_number')
        .eq('part_id', o.part_id).not('file_url', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
      fileUrl = (v as { file_url: string | null } | null)?.file_url ?? null
      fileName = `peca-v${(v as { version_number: number } | null)?.version_number ?? 1}.3mf`
    }
    if (!fileUrl) throw new BadRequestException('A versão não tem arquivo (.3mf) para enviar à impressora. Suba o .3mf fatiado na peça.')
    // só .3mf imprime via FTP — STL não serve pra impressora
    if (!/\.3mf/i.test(fileUrl)) throw new BadRequestException('O arquivo da versão não é .3mf fatiado — a impressora só aceita .3mf. Suba o arquivo fatiado do Bambu.')
    // descobre o slot do AMS de cada cor → manda imprimir no(s) rolo(s) certo(s)
    let amsMapping: number[] | undefined
    const { data: loaded } = await supabaseAdmin.from('printer_loaded_filament')
      .select('slot, input_id').eq('printer_id', o.printer_id).is('unloaded_at', null)
    const slotOf = new Map((loaded ?? []).map(r => [(r as { input_id: string }).input_id, (r as { slot: number }).slot]))
    if (Array.isArray(o.filament_map) && o.filament_map.length > 1) {
      // MULTICOR: ams_mapping é POSICIONAL pelo índice do filamento do .3mf
      // (modelo pode usar filamentos 1 e 3 → [slot1, -1, slot3]). Lacunas = -1.
      const maxIdx = Math.max(...o.filament_map.map(f => Number(f.index) || 0))
      const arr = new Array(maxIdx).fill(-1) as number[]
      let ok = maxIdx > 0
      for (const f of o.filament_map) { const s = slotOf.get(f.input_id); if (s == null) { ok = false; break } arr[Number(f.index) - 1] = s }
      if (ok) amsMapping = arr
    } else if (o.reservation_id && slotOf.has(o.reservation_id)) {
      amsMapping = [slotOf.get(o.reservation_id) as number]
    }
    // AVISO no ato da impressão: sem filamento resolvido não imprime (evita consumo não rastreado / cor errada)
    if (!amsMapping) {
      const temRolo = await supabaseAdmin.from('printer_loaded_filament').select('id').eq('printer_id', o.printer_id).is('unloaded_at', null).limit(1).maybeSingle()
      if (!o.reservation_id) throw new BadRequestException('Nenhum filamento escolhido para esta ordem. Abra a OP, escolha o rolo (cor) e tente de novo — sem isso a impressora não sabe qual filamento usar e o consumo não fica rastreado.')
      if (!temRolo.data) throw new BadRequestException('Nenhum rolo montado nesta impressora. Carregue o filamento no AMS (aba Impressoras → Filamento na impressora) antes de imprimir.')
      throw new BadRequestException('O filamento reservado para esta OP não está montado nesta impressora. Monte o rolo certo no AMS ou troque o rolo da OP antes de imprimir.')
    }
    const cmd = await this.enqueueCommand(orgId, o.printer_id, 'print', { file_url: fileUrl, file_name: fileName, order_id: orderId, ams_mapping: amsMapping }, userId)
    // enviado → marca a OP como imprimindo (a telemetria refina depois: pausado/falhou/acabamento).
    // auto-dispatch chama sem userId → origem 'auto' (badge ⚡ no quadro)
    await supabaseAdmin.from('production_order')
      .update({ status: 'imprimindo', started_at: new Date().toISOString(), last_transition_source: userId ? 'manual' : 'auto', status_changed_at: new Date().toISOString() })
      .eq('id', orderId).eq('organization_id', orgId).in('status', ['fila', 'reimpressao'])
    return cmd
  }

  // ── Fase C: auto-fechamento da produção pela telemetria ───────────
  /** A impressora terminou (imprimindo→ocioso): fecha os jobs da ordem ativa
   *  com o tempo REAL decorrido e avança a ordem p/ acabamento. */
  private async autoCloseFinished(orgId: string, printerId: string) {
    const { data: order } = await supabaseAdmin.from('production_order')
      .select('id, started_at, estimated_time_minutes, product_dev_id')
      .eq('organization_id', orgId).eq('printer_id', printerId).eq('status', 'imprimindo')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!order) return
    const o = order as { id: string; started_at: string | null; estimated_time_minutes: number | null; product_dev_id: string }
    const elapsed = o.started_at ? Math.max(1, Math.round((Date.now() - new Date(o.started_at).getTime()) / 60000)) : (o.estimated_time_minutes ?? null)
    await supabaseAdmin.from('print_job')
      .update({ status: 'concluido', finished_at: new Date().toISOString(), print_time_minutes: elapsed })
      .eq('production_order_id', o.id).in('status', ['imprimindo', 'fila'])
    await supabaseAdmin.from('production_order')
      .update({ status: 'acabamento', actual_time_minutes: elapsed, last_transition_source: 'auto', status_changed_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'imprimindo')
    // peças físicas existem → marca as unidades planejadas como produzidas
    await supabaseAdmin.from('production_unit').update({ status: 'produzida' })
      .eq('organization_id', orgId).eq('production_order_id', o.id).eq('status', 'planejada').then(() => {}, () => {})
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: o.product_dev_id, event_type: 'production_completed',
      payload: { production_order_id: o.id, auto: true, print_minutes: elapsed }, is_auto: true,
    }).then(() => {}, () => {})
    this.logger.log(`[farm] auto-fechou produção da impressora ${printerId.slice(0, 8)} (${elapsed}min reais)`)
  }

  /** Sincroniza a OP ativa da impressora com o estado da telemetria:
   *  pausou→pausado, retomou→imprimindo, erro→falhou. (Terminar é o autoClose.) */
  private async syncOrderState(orgId: string, printerId: string, state: string) {
    const MAP: Record<string, { to: string; from: string[] }> = {
      printing: { to: 'imprimindo', from: ['pausado'] },          // retomou
      paused:   { to: 'pausado',    from: ['imprimindo'] },        // pausou
      error:    { to: 'falhou',     from: ['imprimindo', 'pausado'] },
      failed:   { to: 'falhou',     from: ['imprimindo', 'pausado'] },
    }
    const m = MAP[state]
    if (!m) return
    const { data } = await supabaseAdmin.from('production_order')
      .select('id, status, product_dev_id').eq('organization_id', orgId).eq('printer_id', printerId)
      .in('status', ['imprimindo', 'pausado']).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    if (!data) return
    const o = data as { id: string; status: string; product_dev_id: string }
    if (!m.from.includes(o.status)) return
    const patch: Record<string, unknown> = { status: m.to, last_transition_source: 'auto', status_changed_at: new Date().toISOString() }
    if (m.to === 'falhou') patch.notes = `Falha reportada pela impressora (${state})`
    await supabaseAdmin.from('production_order').update(patch).eq('id', o.id).eq('status', o.status)
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: o.product_dev_id, event_type: 'status_changed',
      payload: { production_order_id: o.id, to: m.to, from_printer: state, auto: true }, is_auto: true,
    }).then(() => {}, () => {})
    this.logger.log(`[farm] OP ${o.id.slice(0, 8)} ${o.status}→${m.to} (impressora ${state})`)
  }

  // ── Fase C: scheduler (qual produto em qual impressora ociosa) ────
  async schedulerSuggest(orgId: string) {
    const [statuses, prof, ordersR] = await Promise.all([
      this.status(orgId),
      this.production.profitability(orgId),
      supabaseAdmin.from('production_order').select('id, order_number, product_dev_id, quantity, printer_id').eq('organization_id', orgId).eq('status', 'fila'),
    ])
    const idle = statuses.filter(s => s.online && s.state === 'idle')
    const profById = new Map(prof.map(p => [p.product_dev_id, p]))
    const orders = ((ordersR.data ?? []) as Array<{ id: string; order_number: number; product_dev_id: string; quantity: number; printer_id: string | null }>)
      .map(o => ({ ...o, pph: profById.get(o.product_dev_id)?.profit_per_hour ?? 0, name: profById.get(o.product_dev_id)?.name ?? '—' }))
      .sort((a, b) => b.pph - a.pph)

    const used = new Set<string>()
    const assignments = []
    for (const o of orders) {
      // se a ordem já tem impressora, respeita; senão pega a ociosa de maior valor livre
      let printer = o.printer_id ? idle.find(p => p.id === o.printer_id && !used.has(p.id)) : undefined
      if (!printer) printer = idle.find(p => !used.has(p.id))
      if (!printer) break
      used.add(printer.id)
      assignments.push({ order_id: o.id, order_number: o.order_number, product_dev_id: o.product_dev_id, name: o.name, quantity: o.quantity, printer_id: printer.id, printer_name: printer.name, profit_per_hour: o.pph })
    }
    return { idle_printers: idle.length, queued_orders: orders.length, assignments }
  }

  async schedulerApply(orgId: string, assignments: Array<{ order_id: string; printer_id: string }>) {
    let assigned = 0
    for (const a of assignments ?? []) {
      const { error } = await supabaseAdmin.from('production_order')
        .update({ printer_id: a.printer_id }).eq('id', a.order_id).eq('organization_id', orgId).eq('status', 'fila')
      if (!error) assigned++
    }
    return { ok: true, assigned }
  }

  // ── T1-C: auto-dispatch (lights-out) ──────────────────────────────
  /** Liga/desliga o auto-dispatch de uma impressora (opt-in — ação real na máquina). */
  async setAutoDispatch(orgId: string, printerId: string, enabled: boolean) {
    const { error } = await supabaseAdmin.from('production_printer').update({ auto_dispatch: !!enabled }).eq('id', printerId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true, auto_dispatch: !!enabled }
  }

  /** Orgs com alguma impressora em auto_dispatch (p/ o cron). */
  async orgsWithAutoDispatch(): Promise<string[]> {
    const { data } = await supabaseAdmin.from('production_printer').select('organization_id').eq('auto_dispatch', true)
    return [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
  }

  /**
   * Auto-dispatch: numa impressora OCIOSA+online com auto_dispatch ligado, INICIA
   * sozinho a próxima ordem que ela consegue rodar. Reusa o schedulePlan (matching
   * de filamento + prioridade R$/h) e o sendOrderToPrinter (valida .3mf + rolo).
   * 1 ordem por impressora por passada. Opt-in por impressora.
   */
  async autoDispatch(orgId: string, opts: { printerId?: string } = {}) {
    const [statuses, plan, prs] = await Promise.all([
      this.status(orgId), this.schedulePlan(orgId),
      supabaseAdmin.from('production_printer').select('id').eq('organization_id', orgId).eq('auto_dispatch', true),
    ])
    const autoOn = new Set(((prs.data ?? []) as Array<{ id: string }>).map(r => r.id))
    const idleOnline = new Set(statuses.filter(s => s.online && s.state === 'idle').map(s => s.id))
    type Asg = { order_id: string; order_number: number; name: string; printer_id: string; fit: string; start_at: string }
    const assignments = (plan.assignments as unknown as Asg[])
    // 1ª ordem (start mais cedo) de cada impressora
    const firstByPrinter = new Map<string, Asg>()
    for (const a of assignments) {
      const cur = firstByPrinter.get(a.printer_id)
      if (!cur || new Date(a.start_at).getTime() < new Date(cur.start_at).getTime()) firstByPrinter.set(a.printer_id, a)
    }
    const dispatched: Array<{ printer_id: string; order_id: string; order_number: number; name: string }> = []
    for (const [pid, a] of firstByPrinter) {
      if (opts.printerId && pid !== opts.printerId) continue
      if (!autoOn.has(pid) || !idleOnline.has(pid) || a.fit === 'none') continue
      const { count } = await supabaseAdmin.from('production_order').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).eq('printer_id', pid).eq('status', 'imprimindo')
      if ((count ?? 0) > 0) continue   // já está imprimindo
      try {
        await supabaseAdmin.from('production_order').update({ printer_id: pid }).eq('id', a.order_id).eq('organization_id', orgId).eq('status', 'fila')
        await this.sendOrderToPrinter(orgId, a.order_id, null)
        dispatched.push({ printer_id: pid, order_id: a.order_id, order_number: a.order_number, name: a.name })
        this.logger.log(`[farm.autodispatch] iniciou OP-${String(a.order_number).padStart(4, '0')} em ${pid.slice(0, 8)}`)
      } catch (e) { this.logger.warn(`[farm.autodispatch] ${pid.slice(0, 8)}: ${(e as Error).message}`) }
    }
    return { dispatched }
  }

  // ── T1-C: scheduler de capacidade finita (Gantt + prazo + matching) ──
  /** Distância RGB entre dois hex (#rrggbb); null se algum não for hex. */
  private hexDist(a: string | null | undefined, b: string | null | undefined): number | null {
    const rgb = (s?: string | null) => { const m = /^#?([0-9a-f]{6})$/i.exec((s ?? '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
    const x = rgb(a), y = rgb(b)
    if (!x || !y) return null
    return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2)
  }
  /** A cor requerida (hex ou nome) casa com um rolo montado (cor/hex)? */
  private colorMatches(req: string | null | undefined, rollColor: string | null | undefined, rollHex: string | null | undefined): boolean {
    if (!req) return true                                  // cor não especificada → material basta
    const d = this.hexDist(req, rollHex) ?? this.hexDist(req, rollColor)
    if (d != null) return d < 80                           // perto o bastante no RGB
    const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
    return !!norm(req) && (norm(req) === norm(rollColor) || norm(req) === norm(rollHex))
  }

  /**
   * Plano de capacidade finita: trata cada impressora como recurso que roda 1
   * job por vez, encaixa a fila respeitando o filamento montado (material+cor) e
   * devolve o ETA (início→fim) de cada ordem, o "tudo pronto até", as atrasadas
   * (vs prazo) e as que NÃO têm impressora capaz (com o motivo).
   */
  async schedulePlan(orgId: string) {
    const now = Date.now()
    const [statuses, prof, ordersR] = await Promise.all([
      this.status(orgId),
      this.production.profitability(orgId),
      supabaseAdmin.from('production_order')
        .select('id, order_number, product_dev_id, part_id, version_id, quantity, estimated_time_minutes, printer_id, due_at')
        .eq('organization_id', orgId).eq('status', 'fila'),
    ])
    const profById = new Map(prof.map(p => [p.product_dev_id, p]))
    const orders = (ordersR.data ?? []) as Array<{ id: string; order_number: number; product_dev_id: string; part_id: string | null; version_id: string | null; quantity: number; estimated_time_minutes: number | null; printer_id: string | null; due_at: string | null }>

    // versões → material + cores requeridas por ordem
    const vIds = [...new Set(orders.map(o => o.version_id).filter(Boolean))] as string[]
    const { data: vData } = vIds.length
      ? await supabaseAdmin.from('product_dev_version').select('id, material, filaments').in('id', vIds)
      : { data: [] as Array<{ id: string; material: string | null; filaments: Array<{ material: string | null; color: string | null; weight_g: number }> | null }> }
    const verById = new Map((vData ?? []).map(v => [(v as { id: string }).id, v as { id: string; material: string | null; filaments: Array<{ material: string | null; color: string | null; weight_g: number }> | null }]))
    const requiredFor = (o: typeof orders[number]): Array<{ material: string | null; color: string | null }> => {
      const v = o.version_id ? verById.get(o.version_id) : null
      const fils = (v?.filaments ?? []).filter(f => Number(f.weight_g) > 0)
      if (fils.length) return fils.map(f => ({ material: f.material ?? v?.material ?? null, color: f.color ?? null }))
      if (v?.material) return [{ material: v.material, color: null }]
      return []   // material desconhecido
    }

    // impressoras online (idle ou imprimindo) com relógio de disponibilidade
    type Slot = { available_at: number; name: string }
    const printerIds = statuses.map(s => s.id)
    const { data: loadedRows } = printerIds.length
      ? await supabaseAdmin.from('printer_loaded_filament')
          .select('printer_id, input:input_id(material, color, color_hex)').in('printer_id', printerIds).is('unloaded_at', null)
      : { data: [] as Array<{ printer_id: string; input: { material: string | null; color: string | null; color_hex: string | null } | Array<{ material: string | null; color: string | null; color_hex: string | null }> }> }
    const rollsBy = new Map<string, Array<{ material: string | null; color: string | null; color_hex: string | null }>>()
    for (const r of (loadedRows ?? []) as Array<{ printer_id: string; input: unknown }>) {
      const inp = Array.isArray(r.input) ? r.input[0] : r.input as { material: string | null; color: string | null; color_hex: string | null } | null
      if (!inp) continue
      const list = rollsBy.get(r.printer_id) ?? []; list.push(inp); rollsBy.set(r.printer_id, list)
    }
    const eligible = statuses.filter(s => s.online && (s.state === 'idle' || s.state === 'printing'))
    const offline = statuses.length - eligible.length
    const clock = new Map<string, Slot>()
    for (const s of eligible) {
      const busyMs = s.state === 'printing' && s.remaining_minutes != null ? Number(s.remaining_minutes) * 60000 : 0
      clock.set(s.id, { available_at: now + busyMs, name: s.name })
    }

    /** A impressora consegue rodar a ordem? fit: exact (cor bate) | material (só material) | none. */
    const capability = (printerId: string, req: Array<{ material: string | null; color: string | null }>): { fit: 'exact' | 'material' | 'unknown' | 'none'; missing?: string } => {
      const rolls = rollsBy.get(printerId) ?? []
      if (!req.length) return rolls.length ? { fit: 'unknown' } : { fit: 'none', missing: 'sem rolo montado' }
      let allColors = true
      for (const need of req) {
        const mat = (need.material ?? '').toUpperCase()
        const sameMat = rolls.filter(r => (r.material ?? '').toUpperCase() === mat || !mat)
        if (!sameMat.length) return { fit: 'none', missing: `${need.material ?? 'material'}${need.color ? ' ' + need.color : ''}` }
        if (!sameMat.some(r => this.colorMatches(need.color, r.color, r.color_hex))) allColors = false
      }
      return { fit: allColors ? 'exact' : 'material' }
    }

    // prioridade: prazo mais cedo primeiro (sem prazo por último), depois R$/hora
    const enriched = orders.map(o => {
      const p = profById.get(o.product_dev_id)
      const dur = o.estimated_time_minutes ?? (p?.print_minutes_unit ? Math.round(p.print_minutes_unit * o.quantity) : null)
      return { ...o, dur, pph: p?.profit_per_hour ?? 0, name: p?.name ?? '—', required: requiredFor(o) }
    }).sort((a, b) => {
      const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
      const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
      if (da !== db) return da - db
      return b.pph - a.pph
    })

    const assignments: Array<Record<string, unknown>> = []
    const unscheduled: Array<Record<string, unknown>> = []
    for (const o of enriched) {
      // impressora pinada pelo usuário tem prioridade, se estiver elegível
      let chosen: string | null = o.printer_id && clock.has(o.printer_id) ? o.printer_id : null
      let cap = chosen ? capability(chosen, o.required) : { fit: 'none' as const }
      if (!chosen) {
        // escolhe a capaz com relógio mais cedo (prefere fit exato a parcial)
        let best: { id: string; at: number; rank: number } | null = null
        for (const [id, slot] of clock) {
          const c = capability(id, o.required)
          if (c.fit === 'none') continue
          const rank = c.fit === 'exact' ? 0 : c.fit === 'unknown' ? 1 : 2
          if (!best || rank < best.rank || (rank === best.rank && slot.available_at < best.at)) best = { id, at: slot.available_at, rank }
        }
        if (best) { chosen = best.id; cap = capability(best.id, o.required) }
      }
      if (!chosen) {
        // motivo: nenhuma capaz (material não montado em lugar nenhum) ou parque offline
        let missing = ''
        for (const id of clock.keys()) { const c = capability(id, o.required); if (c.missing) { missing = c.missing; break } }
        unscheduled.push({ order_id: o.id, order_number: o.order_number, name: o.name, quantity: o.quantity, reason: eligible.length ? `filamento não montado (${missing || 'incompatível'})` : 'nenhuma impressora online', required: o.required })
        continue
      }
      const slot = clock.get(chosen)!
      const startMs = slot.available_at
      const durMin = o.dur ?? 0
      const finishMs = startMs + durMin * 60000
      slot.available_at = finishMs
      const late = !!(o.due_at && finishMs > new Date(o.due_at).getTime())
      assignments.push({
        order_id: o.id, order_number: o.order_number, product_dev_id: o.product_dev_id, name: o.name, quantity: o.quantity,
        printer_id: chosen, printer_name: slot.name, profit_per_hour: o.pph,
        fit: cap.fit, duration_minutes: o.dur, needs_time: o.dur == null,
        start_at: new Date(startMs).toISOString(), finish_at: o.dur != null ? new Date(finishMs).toISOString() : null,
        due_at: o.due_at, late,
      })
    }
    const allDone = assignments.filter(a => a.finish_at).map(a => new Date(a.finish_at as string).getTime())
    return {
      now: new Date(now).toISOString(),
      eligible_printers: eligible.length, offline_printers: offline, queued_orders: orders.length,
      scheduled: assignments.length, unscheduled_count: unscheduled.length,
      late_count: assignments.filter(a => a.late).length,
      all_done_at: allDone.length ? new Date(Math.max(...allDone)).toISOString() : null,
      assignments, unscheduled,
    }
  }

  // ── T1-A: vigilância de falha por IA ──────────────────────────────
  /** Liga/desliga a detecção de falha da impressora e ajusta a sensibilidade.
   *  O agente lê isso na resposta da telemetria e aplica via MQTT (xcam). */
  async setAiDetection(orgId: string, printerId: string, enabled: boolean, sensitivity?: string) {
    const sens = ['low', 'medium', 'high'].includes(String(sensitivity)) ? sensitivity : undefined
    const patch: Record<string, unknown> = { ai_detection_enabled: !!enabled }
    if (sens) patch.ai_sensitivity = sens
    const { error } = await supabaseAdmin.from('production_printer')
      .update(patch).eq('id', printerId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true, ai_detection_enabled: !!enabled, ...(sens ? { ai_sensitivity: sens } : {}) }
  }

  /** Falhas recentes (abertas primeiro) — alimenta o card de alerta e o histórico. */
  async listFailures(orgId: string, limit = 30) {
    const { data, error } = await supabaseAdmin.from('printer_failure_event')
      .select('id, printer_id, production_order_id, job_name, source, reason, error_code, state, camera_url, auto_paused, acknowledged_at, false_positive, detected_at')
      .eq('organization_id', orgId).order('detected_at', { ascending: false }).limit(Math.min(limit, 100))
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const rows = (data ?? []) as Array<Record<string, unknown>>
    const pids = [...new Set(rows.map(r => r.printer_id as string))]
    const { data: prs } = pids.length ? await supabaseAdmin.from('production_printer').select('id, name').in('id', pids) : { data: [] }
    const nameById = new Map((prs ?? []).map(p => [(p as { id: string }).id, (p as { name: string }).name]))
    return rows.map(r => ({ ...r, printer_name: nameById.get(r.printer_id as string) ?? '—', open: !r.acknowledged_at }))
  }

  /** Reconhece (fecha) um alerta de falha; marca falso-positivo se for o caso. */
  async ackFailure(orgId: string, id: string, falsePositive: boolean, userId: string | null) {
    const { error } = await supabaseAdmin.from('printer_failure_event')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId, false_positive: !!falsePositive })
      .eq('id', id).eq('organization_id', orgId).is('acknowledged_at', null)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** KPI de confiabilidade: taxa de falha por impressora nos últimos N dias.
   *  Denominador = impressões iniciadas (production_order com started_at na janela);
   *  falsos-positivos NÃO contam como falha real, mas são reportados à parte. */
  async failureStats(orgId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const [printersR, failsR, ordersR] = await Promise.all([
      supabaseAdmin.from('production_printer').select('id, name').eq('organization_id', orgId).order('name'),
      supabaseAdmin.from('printer_failure_event').select('printer_id, false_positive, reason, detected_at').eq('organization_id', orgId).gte('detected_at', since),
      supabaseAdmin.from('production_order').select('printer_id, started_at').eq('organization_id', orgId).gte('started_at', since),
    ])
    const fails = (failsR.data ?? []) as Array<{ printer_id: string; false_positive: boolean; reason: string | null; detected_at: string }>
    const orders = (ordersR.data ?? []) as Array<{ printer_id: string | null; started_at: string | null }>
    const attemptsBy = new Map<string, number>()
    for (const o of orders) if (o.printer_id) attemptsBy.set(o.printer_id, (attemptsBy.get(o.printer_id) ?? 0) + 1)
    const realBy = new Map<string, number>(), fpBy = new Map<string, number>(), lastBy = new Map<string, { reason: string | null; detected_at: string }>()
    for (const f of fails) {
      if (f.false_positive) fpBy.set(f.printer_id, (fpBy.get(f.printer_id) ?? 0) + 1)
      else realBy.set(f.printer_id, (realBy.get(f.printer_id) ?? 0) + 1)
      const prev = lastBy.get(f.printer_id)
      if (!prev || f.detected_at > prev.detected_at) lastBy.set(f.printer_id, { reason: f.reason, detected_at: f.detected_at })
    }
    const printers = ((printersR.data ?? []) as Array<{ id: string; name: string }>).map(p => {
      const attempts = attemptsBy.get(p.id) ?? 0
      const failures = realBy.get(p.id) ?? 0
      return {
        printer_id: p.id, name: p.name, attempts, failures,
        false_positives: fpBy.get(p.id) ?? 0,
        rate: attempts > 0 ? Math.round((failures / attempts) * 1000) / 10 : null,  // %
        last_failure: lastBy.get(p.id) ?? null,
      }
    })
    const totAttempts = printers.reduce((s, p) => s + p.attempts, 0)
    const totFailures = printers.reduce((s, p) => s + p.failures, 0)
    return {
      window_days: days, printers,
      total: { attempts: totAttempts, failures: totFailures, rate: totAttempts > 0 ? Math.round((totFailures / totAttempts) * 1000) / 10 : null },
    }
  }

  // ── estado ao vivo (lido pela tela) ───────────────────────────────
  /** Recebe um frame JPEG da câmera (agente) e guarda como o snapshot atual da
   *  impressora no storage (cam/{printerId}.jpg, sobrescreve). Auth por token. */
  async ingestCamera(token: string, serial: string, imageBase64: string): Promise<{ ok: boolean; reason?: string }> {
    if (!token) throw new UnauthorizedException('token ausente')
    const { data: agent } = await supabaseAdmin.from('farm_agent').select('id, organization_id, status').eq('token', token).maybeSingle()
    const a = agent as { id: string; organization_id: string; status: string } | null
    if (!a || a.status !== 'ativo') throw new UnauthorizedException('agente inválido ou revogado')
    if (!serial || !imageBase64) return { ok: false, reason: 'sem imagem' }
    const { data: pr } = await supabaseAdmin.from('production_printer')
      .select('id').eq('organization_id', a.organization_id).eq('serial_number', serial).maybeSingle()
    const printerId = (pr as { id: string } | null)?.id
    if (!printerId) return { ok: false, reason: 'impressora não casada' }
    const buf = Buffer.from(imageBase64, 'base64')
    if (buf.length < 100) return { ok: false, reason: 'imagem vazia' }
    const { error } = await supabaseAdmin.storage.from('product-os')
      .upload(`cam/${printerId}.jpg`, buf, { contentType: 'image/jpeg', upsert: true })
    if (error) { this.logger.warn(`[farm.camera] upload falhou: ${error.message}`); return { ok: false, reason: error.message } }
    await supabaseAdmin.from('printer_status').update({ camera_at: new Date().toISOString() }).eq('printer_id', printerId)
    return { ok: true }
  }

  async status(orgId: string) {
    const { data: printers } = await supabaseAdmin.from('production_printer')
      .select('id, name, brand, model, status, serial_number, ai_detection_enabled, ai_sensitivity, auto_dispatch').eq('organization_id', orgId).order('name')
    const { data: statuses } = await supabaseAdmin.from('printer_status')
      .select('*').eq('organization_id', orgId)
    const byId = new Map((statuses ?? []).map(s => [(s as { printer_id: string }).printer_id, s as Record<string, unknown>]))
    // falhas abertas (não reconhecidas) por impressora
    const { data: openFails } = await supabaseAdmin.from('printer_failure_event')
      .select('id, printer_id, reason, detected_at').eq('organization_id', orgId).is('acknowledged_at', null)
    const failByPid = new Map((openFails ?? []).map(f => [(f as { printer_id: string }).printer_id, f as Record<string, unknown>]))

    return (printers ?? []).map(p => {
      const pr = p as { id: string; name: string; brand: string | null; model: string | null; status: string; serial_number: string | null; ai_detection_enabled: boolean | null; ai_sensitivity: string | null; auto_dispatch: boolean | null }
      const st = byId.get(pr.id)
      const fresh = st ? this.isFresh(st.updated_at as string) : false
      const fail = failByPid.get(pr.id)
      return {
        id: pr.id, name: pr.name, brand: pr.brand, model: pr.model, config_status: pr.status,
        bound: !!pr.serial_number,
        ai_detection_enabled: pr.ai_detection_enabled !== false,
        ai_sensitivity: pr.ai_sensitivity || 'medium',
        auto_dispatch: pr.auto_dispatch === true,
        open_failure: fail ? { id: fail.id, reason: fail.reason, detected_at: fail.detected_at } : null,
        online: fresh && (st?.online === true),
        state: !st ? 'sem_dados' : !fresh ? 'offline' : (st.state as string) ?? 'idle',
        job_name: st?.job_name ?? null,
        progress_pct: st?.progress_pct ?? null,
        layer_current: st?.layer_current ?? null, layer_total: st?.layer_total ?? null,
        nozzle_temp: st?.nozzle_temp ?? null, bed_temp: st?.bed_temp ?? null,
        remaining_minutes: st?.remaining_minutes ?? null,
        ams: st?.ams ?? null, error_code: st?.error_code ?? null, error_text: st?.error_text ?? null,
        light_on: (st?.light_on as boolean | null) ?? null,
        last_update: st?.updated_at ?? null,
        camera_at: (st?.camera_at as string) ?? null,
        camera_url: st?.camera_at ? `${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/object/public/product-os/cam/${pr.id}.jpg` : null,
      }
    })
  }

  private isFresh(ts: string | null | undefined): boolean {
    if (!ts) return false
    return Date.now() - new Date(ts).getTime() < STALE_MS
  }
}
