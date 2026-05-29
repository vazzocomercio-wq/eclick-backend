import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'

/** F18 F3.1 — Gate de margem de campanha Shopee.
 *
 *  Calcula a margem LÍQUIDA de uma campanha proposta, descontando TODOS os
 *  custos da promoção: comissão Shopee + desconto + comissão de afiliado
 *  (se houver) + custo do produto + imposto. Bloqueia se < threshold da org
 *  (organizations.min_campaign_margin_pct, default 8%).
 *
 *  Reusa o motor canônico computeContributionMargin (common/margin.ts):
 *  a comissão Shopee + afiliado entram como `saleFee` agregado; o preço já
 *  vem com desconto aplicado. */
@Injectable()
export class CampaignMarginService {
  private readonly logger = new Logger(CampaignMarginService.name)

  /** Avalia margem. Inputs em R$ (não centavos) pro alinhamento com margin.ts.
   *  discount_pct/commission em escala 0-1; tax em 0-100. */
  async evaluate(orgId: string, input: MarginEvalInput): Promise<MarginEvalResult> {
    // Config da org: threshold + imposto default
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('min_campaign_margin_pct, default_tax_percentage, default_tax_on_freight')
      .eq('id', orgId)
      .maybeSingle()
    const o = org as {
      min_campaign_margin_pct: number | null
      default_tax_percentage:  number | null
      default_tax_on_freight:  boolean | null
    } | null

    const minMargin = o?.min_campaign_margin_pct ?? 8
    const taxPct    = input.tax_percentage ?? o?.default_tax_percentage ?? 0
    const taxOnFreight = o?.default_tax_on_freight ?? false

    const price        = Math.max(0, input.price)
    const discountPct  = clamp01(input.discount_pct ?? 0)
    const shopeeCom    = clamp01(input.shopee_commission_pct ?? 0.14) // Shopee BR ~14% default
    const affiliateCom = clamp01(input.affiliate_commission_pct ?? 0)
    const cost         = Math.max(0, input.cost ?? 0)
    const shipping     = Math.max(0, input.shipping ?? 0)

    // Preço efetivo após desconto da campanha
    const effectivePrice = round2(price * (1 - discountPct))

    // saleFee agregado = comissão Shopee + comissão afiliado (ambas sobre o
    // preço efetivo — é o que a Shopee/afiliado retêm da venda promocional)
    const shopeeFee    = round2(effectivePrice * shopeeCom)
    const affiliateFee = round2(effectivePrice * affiliateCom)
    const saleFee      = round2(shopeeFee + affiliateFee)

    const margin = computeContributionMargin({
      price:         effectivePrice,
      saleFee,
      shipping,
      cost,
      taxPercentage: taxPct,
      taxOnFreight,
    })

    const passes = margin.contributionMarginPct >= minMargin

    return {
      effective_price:        effectivePrice,
      breakdown: {
        gross_price:          round2(price),
        discount_amount:      round2(price - effectivePrice),
        shopee_commission:    shopeeFee,
        affiliate_commission: affiliateFee,
        product_cost:         round2(cost),
        tax_amount:           margin.taxAmount,
        shipping:             round2(shipping),
      },
      net_margin:             margin.contributionMargin,
      net_margin_pct:         margin.contributionMarginPct,
      min_margin_pct:         minMargin,
      passes_gate:            passes,
      verdict:                passes ? 'ok' : 'below_threshold',
      message: passes
        ? `Margem líquida ${margin.contributionMarginPct.toFixed(1)}% — acima do mínimo ${minMargin}%. Campanha saudável.`
        : `Margem líquida ${margin.contributionMarginPct.toFixed(1)}% ABAIXO do mínimo ${minMargin}%. Reduza desconto ou reveja custos antes de ativar.`,
    }
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export interface MarginEvalInput {
  /** Preço de tabela do item (R$). */
  price:                    number
  /** Desconto da campanha (0-1). */
  discount_pct?:            number
  /** Comissão Shopee (0-1). Default 0.14 (~14% BR). */
  shopee_commission_pct?:   number
  /** Comissão de afiliado se promovido via afiliado (0-1). */
  affiliate_commission_pct?: number
  /** Custo do produto (R$). */
  cost?:                    number
  /** Frete pago pelo vendedor (R$). */
  shipping?:                number
  /** Imposto (0-100). Default = org.default_tax_percentage. */
  tax_percentage?:          number
}

export interface MarginEvalResult {
  effective_price: number
  breakdown: {
    gross_price:          number
    discount_amount:      number
    shopee_commission:    number
    affiliate_commission: number
    product_cost:         number
    tax_amount:           number
    shipping:             number
  }
  net_margin:      number
  net_margin_pct:  number
  min_margin_pct:  number
  passes_gate:     boolean
  verdict:         'ok' | 'below_threshold'
  message:         string
}
