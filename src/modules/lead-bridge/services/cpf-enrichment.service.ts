import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { LeadBridgeService } from '../lead-bridge.service'

const BIGDATA_URL = 'https://plataforma.bigdatacorp.com.br/pessoas'

@Injectable()
export class CpfEnrichmentService {
  private readonly logger = new Logger(CpfEnrichmentService.name)

  constructor(private readonly leadBridge: LeadBridgeService) {}

  /**
   * Fire-and-forget enrichment. Reads the org's CPF API config, calls the
   * configured provider, stamps enrichment_data + enriched on the conversion
   * row. Never throws — all errors are logged warnings.
   */
  async enrich(conversionId: string): Promise<void> {
    try {
      const { data: conv } = await supabaseAdmin
        .from('lead_bridge_conversions')
        .select('id, organization_id, cpf, consent_enrichment, enriched')
        .eq('id', conversionId)
        .maybeSingle()
      if (!conv || conv.enriched || !conv.consent_enrichment || !conv.cpf) return

      const config = await this.leadBridge.getConfig(conv.organization_id as string)
      if (!config.cpf_enrichment_enabled || !config.cpf_api_key) return

      const provider = (config.cpf_provider ?? 'bigdatacorp').toLowerCase()
      let result: Record<string, unknown> | null = null
      if (provider === 'bigdatacorp') {
        result = await this.callBigDataCorp(conv.cpf as string, config.cpf_api_key)
      } else {
        this.logger.warn(`[cpf.enrich] provider desconhecido: ${provider}`)
      }

      if (!result) return
      await supabaseAdmin
        .from('lead_bridge_conversions')
        .update({
          enriched: true,
          enriched_at: new Date().toISOString(),
          enrichment_data: result,
        })
        .eq('id', conversionId)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[cpf.enrich] ${conversionId}: ${err?.message}`)
    }
  }

  /** Big Data Corp /pessoas endpoint. Token can be either "AccessToken:TokenId"
   * (colon-separated, easy to store in one field) or just the AccessToken,
   * in which case TokenId is read from CPF_TOKEN_ID env. */
  private async callBigDataCorp(cpf: string, key: string): Promise<Record<string, unknown> | null> {
    let accessToken = key
    let tokenId     = process.env.BIGDATA_TOKEN_ID ?? ''
    if (key.includes(':')) {
      const [a, b] = key.split(':')
      accessToken = a
      tokenId     = b ?? tokenId
    }
    if (!accessToken || !tokenId) {
      this.logger.warn('[cpf.enrich] big data corp: AccessToken+TokenId não configurados')
      return null
    }

    try {
      const { data } = await axios.post(
        BIGDATA_URL,
        { Datasets: 'basic_data', q: `doc{${cpf.replace(/\D/g, '')}}` },
        { headers: { AccessToken: accessToken, TokenId: tokenId } },
      )
      return (data ?? null) as Record<string, unknown> | null
    } catch (e: any) {
      const status = e?.response?.status ?? '?'
      this.logger.warn(`[cpf.enrich] big data corp ${status}: ${e?.message}`)
      return null
    }
  }
}
