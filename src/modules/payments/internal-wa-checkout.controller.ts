import {
  Controller, Post, Body, UseGuards, HttpCode, HttpStatus, HttpException, Logger,
  BadRequestException,
} from '@nestjs/common'
import { InternalKeyGuard } from '../internal/internal-key.guard'
import { PaymentsService } from './payments.service'

interface WaCheckoutBody {
  saas_org_id?:    string
  items?:          Array<{ name?: string; price?: number; qty?: number; image_url?: string }>
  customer_email?: string
  metadata?: {
    active_wa_order_id?:     string
    active_conversation_id?: string
    active_org_id?:          string
  }
}

/**
 * Endpoint interno consumido pelo e-Click Active (vendedora IA). Protegido
 * pelo InternalKeyGuard (X-Internal-Key === INTERNAL_API_KEY).
 *
 *   POST /internal/wa-checkout
 *       { saas_org_id, items[], customer_email?, metadata{active_*} }
 *       → 200 { url, session_id }
 *       → 400/500 { error }
 */
@Controller('internal')
@UseGuards(InternalKeyGuard)
export class InternalWaCheckoutController {
  private readonly logger = new Logger(InternalWaCheckoutController.name)

  constructor(private readonly svc: PaymentsService) {}

  @Post('wa-checkout')
  @HttpCode(HttpStatus.OK)
  async waCheckout(@Body() body: WaCheckoutBody): Promise<{ url: string; session_id: string }> {
    try {
      return await this.svc.createWaCheckout(body ?? {})
    } catch (e) {
      // Contrato com o Active: erro sempre volta como { error: string } (PT-BR).
      const isBadReq = e instanceof BadRequestException
      const status   = e instanceof HttpException ? e.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
      let message: string
      if (isBadReq) {
        const resp = e.getResponse()
        message = typeof resp === 'string'
          ? resp
          : String((resp as { message?: unknown }).message ?? e.message)
      } else {
        message = 'Erro ao criar a cobrança no Stripe.'
      }
      this.logger.warn(`[wa-checkout] falhou: ${(e as Error).message}`)
      throw new HttpException({ error: message }, status)
    }
  }
}
