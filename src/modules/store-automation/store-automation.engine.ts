import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type {
  AutomationTrigger,
  AutomationSeverity,
  ProposedAction,
} from './store-automation.types'

/**
 * Onda 4 / A3 — Motor de detecção de situações.
 *
 * Roda a cada `analysis_frequency` (default daily). Pra cada trigger ativo
 * na config da org, executa uma query SQL e gera ações `pending` em
 * store_automation_actions. Lojista revisa no inbox `/dashboard/automation`.
 *
 * Cada detecção é PURAMENTE READ-only (não muda preço, não cria campanha) —
 * só PROPÕE. Execução acontece em store-automation.executor (Sprint 4).
 */

interface DetectedAction {
  trigger_type:    AutomationTrigger
  title:           string
  description:     string
  severity:        AutomationSeverity
  product_ids:     string[]
  affected_count:  number
  proposed_action: ProposedAction
}

interface SeasonalEvent {
  name:       string
  date:       Date
  days_until: number
  categories: string[]
  suggested_discount_pct: number
}

@Injectable()
export class StoreAutomationEngine {
  private readonly logger = new Logger(StoreAutomationEngine.name)

  /** Roda todas as detecções pra 1 org. Retorna ações encontradas (não
   *  persiste — quem persiste é o caller / service). */
  async detect(orgId: string, activeTriggers: AutomationTrigger[]): Promise<DetectedAction[]> {
    const out: DetectedAction[] = []

    if (activeTriggers.includes('low_stock'))
      out.push(...await this.detectLowStock(orgId))
    if (activeTriggers.includes('high_stock'))
      out.push(...await this.detectHighStock(orgId))
    if (activeTriggers.includes('low_score'))
      out.push(...await this.detectLowScore(orgId))
    if (activeTriggers.includes('no_content'))
      out.push(...await this.detectNoContent(orgId))
    if (activeTriggers.includes('no_ads'))
      out.push(...await this.detectNoAds(orgId))
    if (activeTriggers.includes('ads_underperforming'))
      out.push(...await this.detectAdsUnderperforming(orgId))
    if (activeTriggers.includes('seasonal_opportunity'))
      out.push(...this.detectSeasonalOpportunity(orgId))
    if (activeTriggers.includes('new_product_ready'))
      out.push(...await this.detectNewProductReady(orgId))
    if (activeTriggers.includes('abandoned_carts_spike'))
      out.push(...await this.detectAbandonedCartsSpike(orgId))

    return out
  }

  // ─────────────────────────────────────────────────────────────────
  // DETECTORS
  // ─────────────────────────────────────────────────────────────────

  private async detectLowStock(orgId: string): Promise<DetectedAction[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, stock, reorder_point')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gt('stock', 0)
      .lte('stock', 5)  // arbitrary threshold; refine com reorder_point
      .limit(50)

    return (data ?? []).map(p => {
      const stock         = (p as { stock: number }).stock
      const reorder       = (p as { reorder_point: number | null }).reorder_point ?? 5
      const severity: AutomationSeverity = stock <= 1 ? 'critical' : stock <= 3 ? 'high' : 'medium'
      return {
        trigger_type:    'low_stock' as const,
        severity,
        title:           `Estoque crítico: ${(p as { name: string }).name}`,
        description:     `Apenas ${stock} unidades restantes (reorder point: ${reorder}). Risco de ruptura.`,
        product_ids:     [(p as { id: string }).id],
        affected_count:  1,
        proposed_action: {
          type:                'restock_alert',
          product_id:          (p as { id: string }).id,
          current_stock:       stock,
          suggested_quantity:  Math.max(reorder * 4 - stock, 20),
        },
      }
    })
  }

  private async detectHighStock(orgId: string): Promise<DetectedAction[]> {
    // Produto com estoque > 30 unidades e sem vendas significativas
    // (heurística simples; orgs com tabela de orders rica fazem JOIN)
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, stock, price, cost_price')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gte('stock', 30)
      .limit(30)

    return (data ?? []).map(p => {
      const price    = (p as { price: number | null }).price ?? 0
      const cost     = (p as { cost_price: number | null }).cost_price ?? 0
      const newPrice = Math.max(price * 0.85, cost * 1.2)
      return {
        trigger_type:   'high_stock' as const,
        severity:       'medium' as const,
        title:          `Estoque parado: ${(p as { name: string }).name}`,
        description:    `${(p as { stock: number }).stock} unidades sem giro recente. Considere desconto pra acelerar.`,
        product_ids:    [(p as { id: string }).id],
        affected_count: 1,
        proposed_action: {
          type:        'adjust_price',
          product_id:  (p as { id: string }).id,
          new_price:   Math.round(newPrice * 100) / 100,
          reason:      'clearance_high_stock',
        },
      }
    })
  }

  private async detectLowScore(orgId: string): Promise<DetectedAction[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, ai_score')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .lt('ai_score', 40)
      .not('ai_score', 'is', null)
      .limit(20)

    if (!data?.length) return []
    const ids = data.map(p => (p as { id: string }).id)
    return [{
      trigger_type:    'low_score',
      severity:        'medium',
      title:           `${data.length} produtos com score baixo`,
      description:     `Estes produtos têm score < 40. Enriqueça pra melhorar visibilidade e conversão.`,
      product_ids:     ids,
      affected_count:  ids.length,
      proposed_action: {
        type:        'enrich_products',
        product_ids: ids,
      },
    }]
  }

  private async detectNoContent(orgId: string): Promise<DetectedAction[]> {
    // Produtos com score >= 60 mas sem nenhum social_content
    const { data: candidates } = await supabaseAdmin
      .from('products')
      .select('id, name, ai_score')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gte('ai_score', 60)
      .limit(50)
    if (!candidates?.length) return []

    const ids = candidates.map(c => (c as { id: string }).id)
    const { data: hasContent } = await supabaseAdmin
      .from('social_content')
      .select('product_id')
      .in('product_id', ids)
      .neq('status', 'archived')
    const haveSet = new Set((hasContent ?? []).map(s => (s as { product_id: string }).product_id))
    const missing = candidates.filter(c => !haveSet.has((c as { id: string }).id)).slice(0, 10)
    if (missing.length === 0) return []

    return [{
      trigger_type:   'no_content',
      severity:       'opportunity',
      title:          `${missing.length} produtos prontos sem conteúdo social`,
      description:    `Score bom mas sem post/reels gerado. Imagine o alcance perdido.`,
      product_ids:    missing.map(p => (p as { id: string }).id),
      affected_count: missing.length,
      proposed_action: {
        type:        'generate_content',
        product_ids: missing.map(p => (p as { id: string }).id),
        channels:    ['instagram_post', 'instagram_reels'],
      },
    }]
  }

  private async detectNoAds(orgId: string): Promise<DetectedAction[]> {
    // Produtos com score alto sem campanha ativa
    const { data: candidates } = await supabaseAdmin
      .from('products')
      .select('id, name, ai_score')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gte('ai_score', 70)
      .limit(20)
    if (!candidates?.length) return []

    const ids = candidates.map(c => (c as { id: string }).id)
    const { data: hasAds } = await supabaseAdmin
      .from('ads_campaigns')
      .select('product_id')
      .in('product_id', ids)
      .in('status', ['active', 'publishing'])
    const haveSet = new Set((hasAds ?? []).map(a => (a as { product_id: string }).product_id))
    const missing = candidates.filter(c => !haveSet.has((c as { id: string }).id)).slice(0, 5)

    return missing.map(p => ({
      trigger_type:    'no_ads' as const,
      severity:        'opportunity' as const,
      title:           `Oportunidade: ${(p as { name: string }).name} sem ads`,
      description:     `Score ${(p as { ai_score: number }).ai_score}/100 — produto pronto pra escala. Considere campanha Meta.`,
      product_ids:     [(p as { id: string }).id],
      affected_count:  1,
      proposed_action: {
        type:       'create_campaign',
        product_id: (p as { id: string }).id,
        platform:   'meta',
        budget:     50,
        objective:  'conversions',
      },
    }))
  }

  private async detectAdsUnderperforming(orgId: string): Promise<DetectedAction[]> {
    const { data } = await supabaseAdmin
      .from('ads_campaigns')
      .select('id, name, platform, metrics, product_id')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(50)

    return (data ?? []).flatMap(c => {
      const m = (c as { metrics: { roas?: number; spend_brl?: number } }).metrics ?? {}
      if (m.roas == null || m.roas >= 1) return []
      if ((m.spend_brl ?? 0) < 30) return []  // dá tempo de aprender
      return [{
        trigger_type:    'ads_underperforming' as const,
        severity:        'high' as const,
        title:           `Campanha com ROAS ${m.roas.toFixed(2)}×: ${(c as { name: string }).name}`,
        description:     `ROAS abaixo de break-even após R$ ${(m.spend_brl ?? 0).toFixed(2)} gastos. Pause ou ajuste.`,
        product_ids:     (c as { product_id: string | null }).product_id ? [(c as { product_id: string }).product_id] : [],
        affected_count:  1,
        proposed_action: {
          type:        'pause_campaign',
          campaign_id: (c as { id: string }).id,
          reason:      `ROAS ${m.roas.toFixed(2)}× < 1 após gasto significativo`,
        },
      }]
    })
  }

  private detectSeasonalOpportunity(_orgId: string): DetectedAction[] {
    const events = this.upcomingSeasonalEvents()
    return events
      .filter(e => e.days_until > 0 && e.days_until <= 14)
      .map(e => ({
        trigger_type:    'seasonal_opportunity' as const,
        severity:        (e.days_until <= 3 ? 'high' : 'medium') as AutomationSeverity,
        title:           `${e.name} em ${e.days_until} dia${e.days_until !== 1 ? 's' : ''}`,
        description:     `Crie coleção temática + campanha + conteúdo social pra ${e.name}.`,
        product_ids:     [],
        affected_count:  0,
        proposed_action: {
          type:                    'create_collection',
          name:                    e.name,
          suggested_categories:    e.categories,
          suggested_discount_pct:  e.suggested_discount_pct,
        },
      }))
  }

  private async detectNewProductReady(orgId: string): Promise<DetectedAction[]> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, ai_score')
      .eq('organization_id', orgId)
      .eq('catalog_status', 'ready')
      .gte('updated_at', since)
      .limit(20)
    if (!data?.length) return []

    return [{
      trigger_type:    'new_product_ready',
      severity:        'opportunity',
      title:           `${data.length} produto${data.length > 1 ? 's' : ''} novo${data.length > 1 ? 's' : ''} prontos`,
      description:     `Acabaram de ficar prontos pra anunciar. Sugiro gerar conteúdo + campanha.`,
      product_ids:     data.map(p => (p as { id: string }).id),
      affected_count:  data.length,
      proposed_action: {
        type:        'generate_content',
        product_ids: data.map(p => (p as { id: string }).id),
        channels:    ['instagram_post', 'instagram_reels', 'facebook_ads'],
      },
    }]
  }

  private async detectAbandonedCartsSpike(orgId: string): Promise<DetectedAction[]> {
    // Stub — depende de dados de cart_events que vivem no Active.
    // Detecção full vai fazer sense quando bridge SaaS↔Active estiver
    // ativa (Sprint 4). Por ora retorna vazio.
    void orgId
    return []
  }

  // ─────────────────────────────────────────────────────────────────
  // SEASONAL CATALOG
  // ─────────────────────────────────────────────────────────────────

  private upcomingSeasonalEvents(): SeasonalEvent[] {
    const now = new Date()
    const seeds = [
      { name: 'Dia das Mães',         month: 5, day: 11, categories: ['casa','decoração','cozinha'],     discount: 10 },
      { name: 'Dia dos Namorados',    month: 6, day: 12, categories: ['presentes','decoração'],          discount: 15 },
      { name: 'Dia dos Pais',         month: 8, day: 10, categories: ['escritório','ferramentas'],       discount: 10 },
      { name: 'Black Friday',         month: 11, day: 28, categories: ['todos'],                          discount: 20 },
      { name: 'Natal',                month: 12, day: 25, categories: ['todos'],                          discount: 15 },
      { name: 'Volta às aulas',       month: 2, day: 1,  categories: ['escritório','organização'],       discount: 10 },
    ]

    return seeds.map(s => {
      const date = new Date(now.getFullYear(), s.month - 1, s.day)
      if (date < now) date.setFullYear(date.getFullYear() + 1)
      return {
        name:       s.name,
        date,
        days_until: Math.ceil((date.getTime() - now.getTime()) / 86400000),
        categories: s.categories,
        suggested_discount_pct: s.discount,
      }
    })
  }
}
