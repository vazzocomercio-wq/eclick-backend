import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { EnrichmentConsentService } from '../../enrichment/services/consent.service'

export interface OrderTriggerSnapshot {
  buyer_doc_number?:   string | null  // CPF/CNPJ raw ou formatado
  buyer_name?:         string | null
  buyer_phone?:        string | null
  buyer_email?:        string | null
  external_order_id?:  string | null
  // ... outros campos do snapshot
}

/** Resolve unified_customers a partir do snapshot do pedido. Race-safe via
 * upsert com onConflict (organization_id, cpf). Mantém snapshot.buyer_name
 * apenas se a row for criada nova (não sobrescreve display_name existente). */
@Injectable()
export class CustomerResolverService {
  private readonly logger = new Logger(CustomerResolverService.name)

  constructor(private readonly consent: EnrichmentConsentService) {}

  /** @returns id do unified_customer */
  async upsertByCpf(orgId: string, cpf: string, snapshot: OrderTriggerSnapshot): Promise<string> {
    const cleaned = (cpf ?? '').replace(/\D/g, '')
    if (!cleaned) throw new Error('CPF vazio — não dá pra resolver customer')

    // 1. Busca rápida por org+cpf (ignora soft-deleted/merged — se retornar
    // hit aí, seria uma row morta da merge_customers)
    const { data: existing } = await supabaseAdmin
      .from('unified_customers')
      .select('id')
      .eq('organization_id', orgId)
      .eq('cpf', cleaned)
      .eq('is_deleted', false)
      .limit(1)
      .maybeSingle()
    if (existing?.id) return existing.id as string

    // 2. INSERT com upsert race-safe (onConflict assume unique index em
    // organization_id+cpf — se não existe, fallback abaixo)
    const insertRow = {
      organization_id: orgId,
      cpf:             cleaned,
      display_name:    snapshot.buyer_name ?? null,
      source:          'order_ingestion',
    }

    const { data: created, error: insertErr } = await supabaseAdmin
      .from('unified_customers')
      .insert(insertRow)
      .select('id')
      .single()

    if (created?.id) {
      // FIX-ENRICH-1: registra consent automático na criação. Base legal:
      // execução de contrato (LGPD art.7º V) — cliente comprou pelo
      // marketplace e o enrichment é necessário pra entrega/atendimento.
      // Best-effort: falhas aqui não devem travar a ingestion do pedido —
      // customer pode ter consent backfilled depois.
      try {
        await this.consent.record({
          organization_id:    orgId,
          customer_id:        created.id as string,
          identifier:         cleaned,
          identifier_type:    'cpf',
          consent_enrichment: true,
          source:             'order_purchase_contract_art7v',
        })
      } catch (e) {
        this.logger.warn(`[CC-1.resolver] consent.record falhou pra customer=${created.id}: ${(e as Error).message}`)
      }
      return created.id as string
    }

    // 3. Fallback: se falhou (ex: race conduzindo a violation, ou sem unique
    // index), re-busca. unique violation aceita 1 retry.
    if (insertErr) {
      this.logger.warn(`[CC-1.resolver] insert falhou, retry SELECT: ${insertErr.message}`)
      const { data: retry } = await supabaseAdmin
        .from('unified_customers')
        .select('id')
        .eq('organization_id', orgId)
        .eq('cpf', cleaned)
        .eq('is_deleted', false)
        .limit(1)
        .maybeSingle()
      if (retry?.id) return retry.id as string
      throw new Error(`upsertByCpf falhou: ${insertErr.message}`)
    }

    throw new Error('upsertByCpf retornou sem id (estado inesperado)')
  }
}
