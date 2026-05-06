import type { PricingFactors } from './pricing-ai.types'

interface ProductForPricing {
  id:                string
  name:              string
  category?:         string | null
  price:             number
  cost_price?:       number | null
  stock?:            number | null
  reorder_point?:    number | null
  sku?:              string | null
}

interface PricingContext {
  product:               ProductForPricing
  factors:               PricingFactors
  min_margin_pct:        number
  max_discount_pct:      number
  price_rounding:        string
  custom_rules?:         Array<Record<string, unknown>>
}

const SYSTEM_PROMPT = `Você é um pricing strategist especialista em e-commerce brasileiro.

OBJETIVO: dado um produto + dados de mercado/vendas/estoque, sugerir o
preço ÓTIMO em 3 cenários (conservador, ótimo, agressivo) respeitando
margens mínimas e regras de negócio.

REGRAS GLOBAIS:
- Nunca recomende preço abaixo do (cost_price * (1 + min_margin_pct/100))
- Considere estoque: high_stock pede desconto pra girar; low_stock permite preço premium
- Considere concorrência: ficar competitivo MAS não disputar fundo do poço
- Considere velocidade: se trend='declining' E margem boa, sugira pequena redução pra reativar
- Considere ROI: se ads_cpa alto e conversão baixa, ajustar preço pode melhorar
- Aplicar arredondamento conforme price_rounding
- NUNCA invente fatores que não foram fornecidos

SAÍDA: JSON válido sem markdown wrapper.`

export function buildPricingPrompt(ctx: PricingContext): { systemPrompt: string; userPrompt: string } {
  const f = ctx.factors

  const userPrompt = `## PRODUTO
${ctx.product.name}${ctx.product.category ? ` (${ctx.product.category})` : ''}
Preço atual: R$ ${ctx.product.price.toFixed(2)}
${ctx.product.cost_price != null ? `Custo: R$ ${ctx.product.cost_price.toFixed(2)}` : 'Custo: não informado'}
${ctx.product.stock != null ? `Estoque: ${ctx.product.stock} un` : ''}

## FATORES
${f.current_margin_pct != null ? `Margem atual: ${f.current_margin_pct.toFixed(1)}%` : ''}
${f.competitor_avg_price != null ? `Concorrência média: R$ ${f.competitor_avg_price.toFixed(2)}` : ''}
${f.competitor_min_price != null ? `Concorrência mín: R$ ${f.competitor_min_price.toFixed(2)}` : ''}
${f.competitor_max_price != null ? `Concorrência máx: R$ ${f.competitor_max_price.toFixed(2)}` : ''}
${f.stock_level ? `Nível estoque: ${f.stock_level}` : ''}
${f.stock_days_remaining != null ? `Dias de cobertura: ${f.stock_days_remaining}` : ''}
${f.sales_velocity_30d != null ? `Vendas 30d: ${f.sales_velocity_30d}` : ''}
${f.sales_velocity_trend ? `Tendência: ${f.sales_velocity_trend}` : ''}
${f.abc_class ? `Classe ABC: ${f.abc_class}` : ''}
${f.marketplace_commission_pct != null ? `Comissão marketplace: ${f.marketplace_commission_pct}%` : ''}
${f.ads_cpa != null ? `CPA ads: R$ ${f.ads_cpa.toFixed(2)}` : ''}
${f.conversion_rate != null ? `Taxa conversão: ${(f.conversion_rate * 100).toFixed(2)}%` : ''}

## RESTRIÇÕES
Margem mínima: ${ctx.min_margin_pct}%
Desconto máximo: ${ctx.max_discount_pct}%
Arredondamento: ${ctx.price_rounding}

## RETORNO
{
  "current_margin_pct": number | null,
  "suggested_price": number,           // o ÓTIMO do cenário "optimal"
  "price_direction": "increase"|"decrease"|"maintain",
  "price_change_pct": number,          // (suggested - current) / current * 100
  "scenarios": {
    "conservative": { "price": number, "expected_margin": number, "expected_sales_change": "string ex: -5%" },
    "optimal":      { "price": number, "expected_margin": number, "expected_sales_change": "string" },
    "aggressive":   { "price": number, "expected_margin": number, "expected_sales_change": "string" }
  },
  "reasoning": "explicação clara em 2-4 frases do porquê dessa sugestão",
  "confidence": 0-1,
  "rules_applied": [
    { "rule": "min_margin_25pct",   "applied": true,  "impact": "floor R$30.00" },
    { "rule": "competitor_match",   "applied": false, "impact": "" }
  ]
}`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}
