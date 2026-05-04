import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { BaileysProvider } from '../../channels/providers/baileys.provider'
import { formatSignalMessage } from './message-formatter'
import type { AlertSignal } from '../analyzers/analyzers.types'

const TICK_BATCH_SIZE = 25

interface DeliveryWithJoins {
  id:               string
  organization_id:  string
  signal_id:        string
  manager_id:       string
  channel:          string
  status:           string
  alert_signals:    AlertSignal | null
  alert_managers:   {
    id:         string
    name:       string
    phone:      string
    channel_id: string | null
    status:     string
    verified:   boolean
  } | null
}

/**
 * Cron processor que pega alert_deliveries com status=pending +
 * delivery_type=immediate, formata mensagem e envia via Baileys.
 *
 * Falha em 1 entrega não bloqueia outras — cada uma é tratada
 * isoladamente. Erros de envio gravam em error_message + status=failed.
 *
 * Diferenças vs DigestService (PARTE B): aqui é 1-msg-por-signal, lá é
 * compilação periódica de várias.
 */
@Injectable()
export class WhatsAppDeliveryService {
  private readonly logger = new Logger(WhatsAppDeliveryService.name)
  private isRunning = false

  constructor(private readonly baileys: BaileysProvider) {}

  @Cron('*/30 * * * * *', { name: 'alertHubImmediateDelivery' })
  async tick(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.processBatch()
    } catch (e) {
      this.logger.error(`[tick] erro inesperado: ${(e as Error).message}`)
    } finally {
      this.isRunning = false
    }
  }

  private async processBatch(): Promise<void> {
    // Pega deliveries pending immediate. Join com signal e manager pra
    // não fazer N+1 queries — embed via PostgREST.
    const { data, error } = await supabaseAdmin
      .from('alert_deliveries')
      .select(`
        id, organization_id, signal_id, manager_id, channel, status,
        alert_signals!inner ( id, organization_id, analyzer, category, severity, score,
                              entity_type, entity_id, entity_name, data,
                              summary_pt, suggestion_pt, status, created_at,
                              related_signals, cross_insight, expires_at ),
        alert_managers!inner ( id, name, phone, channel_id, status, verified )
      `)
      .eq('status', 'pending')
      .eq('delivery_type', 'immediate')
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: true })
      .limit(TICK_BATCH_SIZE)

    if (error) {
      this.logger.error(`[batch] query falhou: ${error.message}`)
      return
    }

    const rows = (data ?? []) as unknown as DeliveryWithJoins[]
    if (rows.length === 0) return

    this.logger.log(`[batch] processando ${rows.length} deliveries`)

    for (const row of rows) {
      await this.dispatchOne(row)
    }
  }

  private async dispatchOne(row: DeliveryWithJoins): Promise<void> {
    const { id, manager_id, signal_id } = row
    const signal  = row.alert_signals
    const manager = row.alert_managers

    // Marca queued imediatamente pra evitar duplo envio se cron disparar de novo
    // antes da resposta do worker (o filtro do batch usa status='pending').
    const { error: queueErr } = await supabaseAdmin
      .from('alert_deliveries')
      .update({ status: 'queued' })
      .eq('id', id)
      .eq('status', 'pending')   // optimistic: só queue se ainda pending
    if (queueErr) {
      this.logger.error(`[dispatch] delivery=${id} queue failed: ${queueErr.message}`)
      return
    }

    if (!signal || !manager) {
      await this.markFailed(id, 'signal ou manager ausente após join')
      return
    }
    if (!manager.verified || manager.status !== 'active') {
      await this.markFailed(id, `manager ${manager_id} não está active+verified`)
      return
    }
    if (!manager.channel_id) {
      await this.markFailed(id, `manager ${manager_id} sem channel_id`)
      return
    }

    const body = formatSignalMessage(signal, manager.name)

    try {
      const result = await this.baileys.sendMessage(
        manager.channel_id,
        manager.phone,
        'text',
        { body },
      )

      const { error: upErr } = await supabaseAdmin
        .from('alert_deliveries')
        .update({
          status:         'sent',
          sent_at:        new Date().toISOString(),
          wa_message_id:  result.message_id ?? null,
          error_message:  null,
        })
        .eq('id', id)
      if (upErr) this.logger.error(`[dispatch] delivery=${id} update sent falhou: ${upErr.message}`)
      else       this.logger.log(`[dispatch] delivery=${id} signal=${signal_id} → manager=${manager_id} sent`)

      // Sinal já está dispatched (do AlertEngine), só atualiza pra delivered no signals
      // depois que o gestor abrir (status delivered/read vem por webhook/worker — IH-3 PARTE C).
    } catch (e) {
      const msg = (e as Error).message ?? 'unknown'
      await this.markFailed(id, msg)
    }
  }

  private async markFailed(deliveryId: string, error: string): Promise<void> {
    const { error: upErr } = await supabaseAdmin
      .from('alert_deliveries')
      .update({
        status:         'failed',
        error_message:  error.slice(0, 500),
      })
      .eq('id', deliveryId)
    if (upErr) this.logger.error(`[fail] delivery=${deliveryId} mark failed: ${upErr.message}`)
    else       this.logger.warn(`[fail] delivery=${deliveryId} ${error}`)
  }

  // ── Manual trigger pra teste (sem esperar 30s do cron) ──────────────────────
  async runOnce(): Promise<{ processed: number }> {
    if (this.isRunning) return { processed: 0 }
    this.isRunning = true
    try {
      const before = Date.now()
      await this.processBatch()
      const elapsed = Date.now() - before
      this.logger.log(`[runOnce] elapsed=${elapsed}ms`)
      return { processed: 1 }
    } finally {
      this.isRunning = false
    }
  }
}
