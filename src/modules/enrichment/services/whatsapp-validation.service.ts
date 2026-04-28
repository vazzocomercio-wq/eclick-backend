import { Injectable, Logger } from '@nestjs/common'
import { DataStoneProvider } from '../providers/datastone.provider'
import { EnrichmentCostTrackerService } from './cost-tracker.service'

export interface WhatsAppValidationResult {
  isWhatsApp:  boolean
  validatedAt: Date
  provider:    'datastone'
}

/** Validação independente de número WhatsApp via DataStone /whatsapp/search/.
 *
 * IMPORTANTE: bypass do orchestrator (cascade + routing). Sempre DataStone,
 * porque é o único provider com endpoint dedicado de validação ativa de
 * sessão WA — outros (Direct Data, BigDataCorp, HubDev) só retornam o
 * flag is_whatsapp da base cadastral, que marca número fixo como WA.
 *
 * Conservador: qualquer erro/timeout/indisponibilidade → isWhatsApp=false.
 * Custo: ~10¢/validação (rastreado no monthly_spent_brl da DataStone). */
@Injectable()
export class WhatsAppValidationService {
  private readonly logger = new Logger(WhatsAppValidationService.name)
  private static readonly PROVIDER_CODE = 'datastone'

  constructor(
    private readonly datastone: DataStoneProvider,
    private readonly cost:      EnrichmentCostTrackerService,
  ) {}

  /** Aceita qualquer formato BR. Strip não-dígitos, remove 55 se vier com
   * country code (12-13 dígitos). DDD = primeiros 2 dígitos do número
   * local, número = restante (8 fixo / 9 celular). Phone < 10 dígitos
   * limpos → retorna false sem chamar API. */
  async validateNumber(phone: string, orgId: string): Promise<WhatsAppValidationResult> {
    const t0 = Date.now()
    const fail = (): WhatsAppValidationResult => ({
      isWhatsApp: false, validatedAt: new Date(), provider: 'datastone',
    })

    const clean = (phone ?? '').replace(/\D/g, '')
    if (clean.length < 10) {
      this.logger.warn(`[wa.validate] phone_invalido digitos=${clean.length}`)
      return fail()
    }
    // Remove country code 55 quando vier com 12-13 dígitos
    const local = (clean.length >= 12 && clean.startsWith('55')) ? clean.slice(2) : clean
    const ddd   = local.slice(0, 2)
    const num   = local.slice(2)
    const last4 = num.slice(-4) || num

    // Busca creds DataStone — se desabilitada/sem api_key/sem budget, fail
    const row = await this.cost.getProvider(orgId, WhatsAppValidationService.PROVIDER_CODE)
    if (!row || !row.is_enabled || !row.api_key) {
      this.logger.warn(`[wa.validate] datastone_indisponivel enabled=${!!row?.is_enabled} has_key=${!!row?.api_key}`)
      return fail()
    }
    const hasBudget = await this.cost.hasBudget(orgId, WhatsAppValidationService.PROVIDER_CODE)
    if (!hasBudget) {
      this.logger.warn(`[wa.validate] datastone_sem_budget`)
      return fail()
    }

    try {
      const r = await this.datastone.validateWhatsApp(local, {
        api_key:    row.api_key,
        api_secret: row.api_secret ?? null,
        base_url:   row.base_url   ?? null,
      })
      const isWhatsApp = r?.data?.phones?.[0]?.is_whatsapp === true
      // Tracka custo mesmo em validação negativa (chamada consumiu crédito)
      if (r.cost_cents > 0) {
        await this.cost.track(orgId, WhatsAppValidationService.PROVIDER_CODE, r.cost_cents)
      }
      this.logger.log(
        `[wa.validate] ddd=${ddd} phone_last4=${last4} result=${isWhatsApp} duration_ms=${Date.now() - t0}`,
      )
      return { isWhatsApp, validatedAt: new Date(), provider: 'datastone' }
    } catch (e: unknown) {
      const err = (e as Error)?.message ?? 'erro'
      this.logger.warn(
        `[wa.validate] ddd=${ddd} phone_last4=${last4} result=false duration_ms=${Date.now() - t0} err=${err}`,
      )
      return fail()
    }
  }
}
