import {
  Injectable, Logger, BadRequestException, NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import axios, { AxiosError } from 'axios'

/**
 * Proxy entre a API NestJS e o worker Baileys (process separado no Railway).
 *
 * Worker expõe HTTP em WORKER_INTERNAL_URL (ex: http://eclick-saas-workers.railway.internal:3030).
 * Auth via header X-Internal-Key compartilhado.
 *
 * Endpoints proxiados:
 *   POST /internal/baileys/send         — enviar mensagem
 *   POST /internal/baileys/check-number — verificar se número tem WhatsApp
 *
 * Códigos do worker traduzidos pra exceções NestJS:
 *   404 → NotFoundException (canal sem sessão)
 *   503 → ServiceUnavailableException (sessão não pronta)
 *   ECONNREFUSED → ServiceUnavailableException (worker offline)
 *   outros → BadRequestException
 */
@Injectable()
export class BaileysProvider {
  private readonly logger = new Logger(BaileysProvider.name)

  private requireConfig(): { url: string; key: string } {
    const url = process.env.WORKER_INTERNAL_URL
    const key = process.env.INTERNAL_API_KEY
    if (!url || !key) {
      throw new ServiceUnavailableException(
        'Worker WhatsApp não configurado (WORKER_INTERNAL_URL/INTERNAL_API_KEY ausentes).',
      )
    }
    return { url, key }
  }

  private isOffline(e: unknown): boolean {
    if (!axios.isAxiosError(e)) return false
    const ax = e as AxiosError
    return !ax.response || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(ax.code ?? '')
  }

  async sendMessage(
    channelId: string,
    to: string,
    contentType: 'text' | 'image' | 'audio' | 'video' | 'document',
    content: Record<string, unknown>,
  ): Promise<{ message_id: string }> {
    const { url, key } = this.requireConfig()
    try {
      const res = await axios.post(
        `${url}/internal/baileys/send`,
        { channel_id: channelId, to, content_type: contentType, content },
        { headers: { 'X-Internal-Key': key }, timeout: 20_000 },
      )
      return res.data as { message_id: string }
    } catch (e) {
      if (this.isOffline(e)) {
        throw new ServiceUnavailableException('Worker WhatsApp offline. Tente novamente em instantes.')
      }
      if (axios.isAxiosError(e)) {
        const status = e.response?.status
        const detail = e.response?.data?.detail ?? e.response?.data?.error ?? e.message
        if (status === 404) throw new NotFoundException(`channel_not_found: ${channelId}`)
        if (status === 503) throw new ServiceUnavailableException(`session_not_ready: ${detail}`)
      }
      const msg = axios.isAxiosError(e) ? (e.response?.data?.error ?? e.message) : (e as Error).message
      this.logger.error(`[sendMessage] channel=${channelId} falhou: ${msg}`)
      throw new BadRequestException(`Falha ao enviar mensagem: ${msg}`)
    }
  }

  async checkNumber(orgId: string, phone: string): Promise<{
    exists: boolean
    jid?: string
    profile_name?: string
    profile_pic_url?: string
  }> {
    const { url, key } = this.requireConfig()
    try {
      const res = await axios.post(
        `${url}/internal/baileys/check-number`,
        { org_id: orgId, phone },
        { headers: { 'X-Internal-Key': key }, timeout: 15_000 },
      )
      return res.data
    } catch (e) {
      if (this.isOffline(e)) {
        throw new ServiceUnavailableException('Worker WhatsApp offline.')
      }
      if (axios.isAxiosError(e) && e.response?.status === 503) {
        throw new ServiceUnavailableException('Nenhuma sessão WhatsApp ativa para essa organização.')
      }
      const msg = axios.isAxiosError(e) ? (e.response?.data?.error ?? e.message) : (e as Error).message
      throw new BadRequestException(`Falha ao verificar número: ${msg}`)
    }
  }
}
