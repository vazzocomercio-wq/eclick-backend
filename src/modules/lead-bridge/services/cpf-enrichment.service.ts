import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { LeadBridgeService } from '../lead-bridge.service'
import { getProvider } from './cpf-providers'

@Injectable()
export class CpfEnrichmentService {
  private readonly logger = new Logger(CpfEnrichmentService.name)

  constructor(private readonly leadBridge: LeadBridgeService) {}

  /**
   * Fire-and-forget enrichment dispatched through the provider registry.
   * Reads org config (provider id + api_key), runs the matching adapter,
   * stamps enrichment_data + normalized fields back on the conversion.
   * Never throws — all errors logged warns.
   */
  async enrich(conversionId: string): Promise<void> {
    try {
      const { data: conv } = await supabaseAdmin
        .from('lead_bridge_conversions')
        .select('id, organization_id, cpf, consent_enrichment, enriched, full_name, phone, email')
        .eq('id', conversionId)
        .maybeSingle()
      if (!conv || conv.enriched || !conv.consent_enrichment || !conv.cpf) return

      const config = await this.leadBridge.getConfig(conv.organization_id as string)
      if (!config.cpf_enrichment_enabled || !config.cpf_api_key) return

      const provider = getProvider(config.cpf_provider ?? 'bigdatacorp')
      if (!provider) {
        this.logger.warn(`[cpf.enrich] provider desconhecido: ${config.cpf_provider}`)
        return
      }

      const result = await provider.enrich(conv.cpf as string, config.cpf_api_key)
      if (!result.success) {
        this.logger.warn(`[cpf.enrich] ${provider.id} falhou: ${result.error}`)
        return
      }

      // Backfill conversion fields when the provider returned them AND the
      // conversion didn't already have them filled by the user.
      const patch: Record<string, unknown> = {
        enriched: true,
        enriched_at: new Date().toISOString(),
        enrichment_data: result.raw_response ?? {},
      }
      if (!conv.full_name && result.name)  patch.full_name = result.name
      if (!conv.phone     && result.phone) patch.phone     = result.phone
      if (!conv.email     && result.email) patch.email     = result.email

      await supabaseAdmin
        .from('lead_bridge_conversions')
        .update(patch)
        .eq('id', conversionId)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[cpf.enrich] ${conversionId}: ${err?.message}`)
    }
  }
}
