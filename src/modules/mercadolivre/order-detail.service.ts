import { Injectable, NotFoundException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

interface JourneyStepShape {
  step?:          number
  template_name?: string
  template_kind?: string
  trigger?:       string
}

interface OrderRow {
  id:                string
  external_order_id: string
  buyer_name:        string | null
  buyer_doc_number:  string | null
  buyer_doc_type:    string | null
  buyer_email:       string | null
  buyer_phone:       string | null
  product_title:     string | null
  sale_price:        number | null
  sold_at:           string | null
  shipping_status:   string | null
  shipping_id:       string | null
  status:            string | null
  payment_status:    string | null
}

export interface OrderFullDetail {
  order: {
    id:                string
    external_order_id: string
    buyer_name:        string | null
    buyer_doc_number:  string | null
    buyer_doc_type:    string | null
    buyer_email:       string | null
    buyer_phone:       string | null
    product_title:     string | null
    sale_price:        number | null
    sold_at:           string | null
    shipping_status:   string | null
    shipping_id:       string | null
    payment_status:    string | null
  }
  customer: {
    id:                  string
    display_name:        string | null
    cpf:                 string | null
    phone:               string | null
    email:               string | null
    validated_whatsapp:  boolean | null
    city:                string | null
    state:               string | null
    enrichment_status:   string | null
    enrichment_quality:  string | null
    enriched_at:         string | null
    enrichment_provider: string | null
  } | null
  communication: {
    journey_id:         string
    journey_name:       string | null
    ocj_state:          string
    ocj_stopped_reason: string | null
    ocj_last_error:     string | null
    current_step:       number | null
    total_steps:        number | null
    steps_summary: Array<{
      step:          number
      template_name: string | null
      trigger:       string | null
    }>
    messages: Array<{
      step:            number | null
      template_name:   string | null
      template_kind:   string | null
      channel:         string
      status:          string
      sent_at:         string | null
      delivered_at:    string | null
      read_at:         string | null
      error:           string | null
      message_preview: string
    }>
  } | null
}

/** Agregador read-only de order + unified_customer + comunicação pra
 * widget de detalhe do pedido em /dashboard/pedidos. Single chamada,
 * batch lookups via `.in()` — sem N+1. Org-scoped via orgId obrigatório. */
@Injectable()
export class OrderDetailService {
  private readonly logger = new Logger(OrderDetailService.name)

  async getFullDetail(orgId: string, externalOrderId: string): Promise<OrderFullDetail> {
    if (!orgId)            throw new NotFoundException('orgId ausente')
    if (!externalOrderId)  throw new NotFoundException('external_order_id ausente')

    // ── 1. Order ────────────────────────────────────────────────────────
    const { data: orderRow, error: oErr } = await supabaseAdmin
      .from('orders')
      .select(
        'id, external_order_id, buyer_name, buyer_doc_number, buyer_doc_type, ' +
        'buyer_email, buyer_phone, product_title, sale_price, sold_at, ' +
        'shipping_status, shipping_id, status, payment_status',
      )
      .eq('organization_id', orgId)
      .eq('external_order_id', externalOrderId)
      .maybeSingle()
    if (oErr) {
      this.logger.warn(`[order.full-detail] order query falhou: ${oErr.message}`)
    }
    if (!orderRow) throw new NotFoundException('Pedido não encontrado')
    const order = orderRow as unknown as OrderRow

    // ── 2. Customer (por CPF, caso disponível) ──────────────────────────
    let customer: OrderFullDetail['customer'] = null
    let enrichmentProvider: string | null = null

    if (order.buyer_doc_number) {
      const cpfClean = order.buyer_doc_number.replace(/\D/g, '')
      const { data: cRaw } = await supabaseAdmin
        .from('unified_customers')
        .select(
          'id, display_name, cpf, phone, email, validated_whatsapp, city, state, ' +
          'enrichment_status, enrichment_quality, enriched_at',
        )
        .eq('organization_id', orgId)
        .eq('cpf', cpfClean)
        .maybeSingle()
      const c = cRaw as unknown as {
        id:                  string
        display_name:        string | null
        cpf:                 string | null
        phone:               string | null
        email:               string | null
        validated_whatsapp:  boolean | null
        city:                string | null
        state:               string | null
        enrichment_status:   string | null
        enrichment_quality:  string | null
        enriched_at:         string | null
      } | null

      if (c) {
        // Último provider que sucedeu — não temos coluna em unified_customers,
        // então puxamos de enrichment_log (ordenado DESC).
        const { data: lastAudit } = await supabaseAdmin
          .from('enrichment_log')
          .select('final_provider')
          .eq('organization_id', orgId)
          .eq('customer_id', c.id)
          .eq('final_status', 'success')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        enrichmentProvider = ((lastAudit as { final_provider?: string } | null)?.final_provider) ?? null

        customer = {
          id:                  c.id,
          display_name:        c.display_name,
          cpf:                 c.cpf,
          phone:               c.phone,
          email:               c.email,
          validated_whatsapp:  c.validated_whatsapp ?? null,
          city:                c.city,
          state:               c.state,
          enrichment_status:   c.enrichment_status,
          enrichment_quality:  c.enrichment_quality,
          enriched_at:         c.enriched_at,
          enrichment_provider: enrichmentProvider,
        }
      }
    }

    // ── 3. Communication (apenas se há customer + ocj) ──────────────────
    let communication: OrderFullDetail['communication'] = null

    if (customer) {
      const { data: ocjRaw } = await supabaseAdmin
        .from('order_communication_journeys')
        .select('id, journey_id, state, stopped_reason, last_error')
        .eq('organization_id', orgId)
        .eq('order_id', order.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const ocj = ocjRaw as unknown as {
        id:              string
        journey_id:      string
        state:           string
        stopped_reason:  string | null
        last_error:      string | null
      } | null

      if (ocj) {
        // Journey + steps (pra mapear template_name → step number).
        // org-filter mesmo já tendo passado pela OCJ — defesa em profundidade.
        const { data: journeyRaw } = await supabaseAdmin
          .from('messaging_journeys')
          .select('name, steps')
          .eq('organization_id', orgId)
          .eq('id', ocj.journey_id)
          .maybeSingle()
        const journey = journeyRaw as unknown as { name: string | null; steps: unknown } | null
        const journeySteps = Array.isArray(journey?.steps)
          ? (journey!.steps as JourneyStepShape[])
          : []
        const totalSteps = journeySteps.length || null

        // Runs deste OCJ (filter por context.ocj_id) — pega a mais recente
        // pra current_step. Sem ordenação, Postgres devolve em ordem
        // indefinida e runs[0] vira aleatório.
        const { data: runsRaw } = await supabaseAdmin
          .from('messaging_journey_runs')
          .select('id, current_step')
          .eq('organization_id', orgId)
          .eq('context->>ocj_id', ocj.id)
          .order('created_at', { ascending: false })
        const runs = (runsRaw ?? []) as unknown as Array<{ id: string; current_step: number | null }>
        const runIds      = runs.map(r => r.id)
        const currentStep = runs[0]?.current_step ?? null

        // Sends das runs (batch via .in + org filter)
        let sends: Array<Record<string, unknown>> = []
        if (runIds.length > 0) {
          const { data } = await supabaseAdmin
            .from('messaging_sends')
            .select(
              'id, journey_run_id, template_id, channel, status, ' +
              'sent_at, delivered_at, read_at, error, message_body, created_at',
            )
            .eq('organization_id', orgId)
            .in('journey_run_id', runIds)
            .order('created_at', { ascending: true })
          sends = (data ?? []) as unknown as Array<Record<string, unknown>>
        }

        // Templates lookup (batch via .in + org filter) pra name + kind
        const tplIds = [...new Set(sends.map(s => s.template_id as string).filter(Boolean))]
        const tplMap = new Map<string, { name: string; kind: string }>()
        if (tplIds.length > 0) {
          const { data: tpls } = await supabaseAdmin
            .from('messaging_templates')
            .select('id, name, template_kind')
            .eq('organization_id', orgId)
            .in('id', tplIds)
          for (const t of tpls ?? []) {
            tplMap.set(t.id as string, {
              name: (t.name as string) ?? '',
              kind: (t.template_kind as string) ?? 'custom',
            })
          }
        }

        // Mapping template_name → step number (via journey.steps)
        const stepByTplName = new Map<string, number>()
        journeySteps.forEach((st, idx) => {
          if (st.template_name) stepByTplName.set(st.template_name, st.step ?? idx + 1)
        })

        const messages = sends.map(s => {
          const tpl     = tplMap.get(s.template_id as string)
          const stepNum = tpl ? stepByTplName.get(tpl.name) ?? null : null
          const body    = (s.message_body as string | null) ?? ''
          return {
            step:            stepNum,
            template_name:   tpl?.name ?? null,
            template_kind:   tpl?.kind ?? null,
            channel:         (s.channel as string) ?? '',
            status:          (s.status as string) ?? '',
            sent_at:         (s.sent_at as string | null) ?? null,
            delivered_at:    (s.delivered_at as string | null) ?? null,
            read_at:         (s.read_at as string | null) ?? null,
            error:           (s.error as string | null) ?? null,
            message_preview: body.slice(0, 100),
          }
        })

        const stepsSummary = journeySteps.map((st, idx) => ({
          step:          st.step ?? idx + 1,
          template_name: st.template_name ?? null,
          trigger:       st.trigger ?? null,
        }))

        communication = {
          journey_id:         ocj.journey_id,
          journey_name:       journey?.name ?? null,
          ocj_state:          ocj.state,
          ocj_stopped_reason: ocj.stopped_reason,
          ocj_last_error:     ocj.last_error,
          current_step:       currentStep,
          total_steps:        totalSteps,
          steps_summary:      stepsSummary,
          messages,
        }
      }
    }

    return {
      order: {
        id:                order.id,
        external_order_id: order.external_order_id,
        buyer_name:        order.buyer_name,
        buyer_doc_number:  order.buyer_doc_number,
        buyer_doc_type:    order.buyer_doc_type,
        buyer_email:       order.buyer_email,
        buyer_phone:       order.buyer_phone,
        product_title:     order.product_title,
        sale_price:        order.sale_price,
        sold_at:           order.sold_at,
        shipping_status:   order.shipping_status,
        shipping_id:       order.shipping_id,
        // payment_status legado pode estar em status — fallback
        payment_status:    order.payment_status ?? order.status,
      },
      customer,
      communication,
    }
  }
}
