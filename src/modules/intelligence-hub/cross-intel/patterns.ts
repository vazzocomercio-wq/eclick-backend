import type { AlertSignal, AlertSeverity } from '../analyzers/analyzers.types'

/**
 * Padrões de cross-intelligence — combinações de signals que, juntos, revelam
 * uma situação mais rica do que cada signal isolado.
 *
 * Cada pattern recebe N signals da mesma entity (entity_id = product) e
 * decide se a combinação aplica. Se sim, retorna um cross-insight com
 * summary/suggestion específicos.
 *
 * Padrões implementáveis com analyzers atuais (estoque, compras, preço,
 * margem). AdsAnalyzer ainda não disponível.
 */

export interface CrossInsight {
  category:       string
  severity:       AlertSeverity
  score:          number
  summary_pt:     string
  suggestion_pt:  string
  source_signals: AlertSignal[]
}

type Match = (signals: AlertSignal[]) => CrossInsight | null

interface NamedPattern {
  name:  string
  match: Match
}

const findCat = (signals: AlertSignal[], analyzer: string, ...categories: string[]) =>
  signals.find(s => s.analyzer === analyzer && categories.includes(s.category))

// ── Padrão 1: ruptura iminente + PO atrasada ─────────────────────────────────
// "Produto vai acabar e a compra de reposição está atrasada — risco crítico"
const PATTERN_RUPTURA_PO_ATRASADA: NamedPattern = {
  name: 'ruptura_e_po_atrasada',
  match(signals) {
    const ruptura = findCat(signals, 'estoque', 'ruptura_iminente')
    const poAtraso = findCat(signals, 'compras', 'po_atrasada', 'po_atrasada_critica')
    if (!ruptura || !poAtraso) return null

    const productName = ruptura.entity_name ?? 'Produto'
    return {
      category:  'ruptura_e_po_atrasada',
      severity:  'critical',
      score:     Math.min(99, Math.max(ruptura.score, poAtraso.score) + 5),
      summary_pt:
        `${productName}: estoque acaba em poucos dias E a PO de reposição ` +
        `está atrasada. Sem ação imediata o produto vai ficar fora.`,
      suggestion_pt:
        'Contatar fornecedor da PO atrasada hoje + considerar PO emergencial ' +
        'em fornecedor alternativo se possível.',
      source_signals: [ruptura, poAtraso],
    }
  },
}

// ── Padrão 2: estoque baixo + preço acima do mercado ─────────────────────────
// "Vai acabar e está caro — oportunidade de baixar pra escoar mais rápido"
const PATTERN_ESTOQUE_BAIXO_PRECO_ACIMA: NamedPattern = {
  name: 'oportunidade_escoamento',
  match(signals) {
    const estBaixo  = findCat(signals, 'estoque', 'estoque_baixo')
    const precoCaro = findCat(signals, 'preco', 'preco_acima')
    if (!estBaixo || !precoCaro) return null

    const productName = estBaixo.entity_name ?? 'Produto'
    return {
      category:  'oportunidade_escoamento',
      severity:  'warning',
      score:     65,
      summary_pt:
        `${productName}: estoque baixo + preço acima do mercado. ` +
        `Ajuste pode acelerar venda e melhorar giro antes da reposição.`,
      suggestion_pt:
        'Considerar pequena baixa de preço pra escoar estoque atual em vez de comprar mais.',
      source_signals: [estBaixo, precoCaro],
    }
  },
}

// ── Padrão 3: margem alta + estoque alto/parado ──────────────────────────────
// "Margem boa mas vende pouco — investir em mídia ou promoção pra escalar"
const PATTERN_MARGEM_ALTA_ESTOQUE_PARADO: NamedPattern = {
  name: 'margem_boa_sem_volume',
  match(signals) {
    const margem  = findCat(signals, 'margem',  'margem_alta')
    const estoque = findCat(signals, 'estoque', 'estoque_alto', 'sem_movimento')
    if (!margem || !estoque) return null

    const productName = margem.entity_name ?? 'Produto'
    return {
      category:  'margem_boa_sem_volume',
      severity:  'info',
      score:     50,
      summary_pt:
        `${productName}: margem alta (${(margem.data?.avg_margin_pct ?? '?')}%) ` +
        `mas com estoque ${estoque.category === 'sem_movimento' ? 'parado' : 'em excesso'}. ` +
        `Oportunidade pra escalar volume.`,
      suggestion_pt:
        'Investir em ads ou destaque no marketplace — a margem cobre o custo de aquisição.',
      source_signals: [margem, estoque],
    }
  },
}

// ── Padrão 4: preço competitivo + estoque alto ───────────────────────────────
// "Tá barato no mercado e tem estoque — bom momento pra promoção agressiva"
const PATTERN_PROMO_AGRESSIVA: NamedPattern = {
  name: 'promo_agressiva_viavel',
  match(signals) {
    const precoOk = findCat(signals, 'preco',   'preco_competitivo')
    const estoque = findCat(signals, 'estoque', 'estoque_alto')
    if (!precoOk || !estoque) return null

    const productName = precoOk.entity_name ?? 'Produto'
    return {
      category:  'promo_agressiva_viavel',
      severity:  'info',
      score:     45,
      summary_pt:
        `${productName}: preço já abaixo do mercado + estoque alto. ` +
        `Cenário ideal pra campanha de impulso.`,
      suggestion_pt:
        'Promo + boost em ads pode escoar estoque rápido sem sacrificar margem extra.',
      source_signals: [precoOk, estoque],
    }
  },
}

export const CROSS_INTEL_PATTERNS: NamedPattern[] = [
  PATTERN_RUPTURA_PO_ATRASADA,
  PATTERN_ESTOQUE_BAIXO_PRECO_ACIMA,
  PATTERN_MARGEM_ALTA_ESTOQUE_PARADO,
  PATTERN_PROMO_AGRESSIVA,
]
