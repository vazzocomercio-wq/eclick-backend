import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import {
  AlgoScoreInput, AlgoScoreBreakdown, AlgoScoreIssue, PillarResult,
  PILLAR_WEIGHTS,
} from './algo-score.types'

/** F18 F1.1 — Computa Shopee Algorithm Score (4 pilares + issues).
 *
 *  Pure (sem I/O) no compute() — testável determinístico. computeAndPersist()
 *  grava em shopee.algo_score_breakdown pra histórico/dashboard.
 *
 *  Cada sub-scorer é privado + isolado pra facilitar tuning futuro sem
 *  alterar callers. Heurísticas baseadas em docs Shopee + best-practices
 *  ML/marketplace BR — ajustes virão com primeiros dados reais. */
@Injectable()
export class ShopeeAlgoScoreService {
  private readonly logger = new Logger(ShopeeAlgoScoreService.name)

  /** Compute puro — sem I/O. Recebe input completo, devolve breakdown. */
  compute(input: AlgoScoreInput): AlgoScoreBreakdown {
    const relevance       = this.scoreRelevance(input)
    const performance     = this.scorePerformance(input)
    const seller_quality  = this.scoreSellerQuality(input)
    const price_marketing = this.scorePriceMarketing(input)

    const score = Math.round(
      PILLAR_WEIGHTS.relevance       * relevance.score +
      PILLAR_WEIGHTS.performance     * performance.score +
      PILLAR_WEIGHTS.seller_quality  * seller_quality.score +
      PILLAR_WEIGHTS.price_marketing * price_marketing.score,
    )

    return {
      score,
      pillars: {
        relevance:        relevance.score,
        performance:      performance.score,
        seller_quality:   seller_quality.score,
        price_marketing:  price_marketing.score,
      },
      issues: this.prioritize([
        ...relevance.issues,
        ...performance.issues,
        ...seller_quality.issues,
        ...price_marketing.issues,
      ]),
    }
  }

  /** Compute + persiste em shopee.algo_score_breakdown. Insert (não upsert)
   *  pra preservar histórico de scores por anúncio. Query recente = ORDER
   *  BY computed_at DESC LIMIT 1. */
  async computeAndPersist(
    input: AlgoScoreInput,
    orgId: string,
  ): Promise<AlgoScoreBreakdown> {
    const breakdown = this.compute(input)
    const { error } = await supabaseAdmin
      .schema('shopee')
      .from('algo_score_breakdown')
      .insert({
        organization_id:  orgId,
        shop_id:          input.shop_id,
        item_id:          input.item_id,
        product_id:       input.product_id ?? null,
        algo_score:       breakdown.score,
        relevance:        breakdown.pillars.relevance,
        performance:      breakdown.pillars.performance,
        seller_quality:   breakdown.pillars.seller_quality,
        price_marketing:  breakdown.pillars.price_marketing,
        issues:           breakdown.issues,
        input_snapshot:   input,
      })
    if (error) {
      this.logger.error(`[shopee.algo_score] persist falhou: ${error.message}`)
    }
    return breakdown
  }

  // ── PILLAR 1 — Relevância (40%) ──────────────────────────────────────────
  // title 30% + attrs 30% + images 20% + description 20%

  private scoreRelevance(input: AlgoScoreInput): PillarResult {
    const issues: AlgoScoreIssue[] = []
    const subs: number[] = []

    // Title: 30-100 chars ideal, > 80 perfeito. Shopee max ≈ 120.
    const title = input.title ?? ''
    let titleScore: number
    if (!title) {
      titleScore = 0
      issues.push({
        pillar: 'relevance', code: 'missing_title', severity: 'high',
        description: 'Anúncio sem título — Shopee rejeita.',
        recommended_action: 'Cadastrar título com palavra-chave principal + atributos.',
      })
    } else if (title.length < 30) {
      titleScore = Math.round((title.length / 30) * 60)
      issues.push({
        pillar: 'relevance', code: 'short_title', severity: 'high',
        description: `Título muito curto (${title.length} chars). Shopee favorece títulos descritivos.`,
        recommended_action: 'Expandir pra 60-100 chars com keyword principal + cor/tamanho/material.',
        current_value: title.length, target_value: 80,
      })
    } else if (title.length < 60) {
      titleScore = 70
      issues.push({
        pillar: 'relevance', code: 'medium_title', severity: 'medium',
        description: `Título OK (${title.length}) mas pode ser mais descritivo.`,
        recommended_action: 'Adicionar atributos diferenciadores no título (modelo, voltagem, etc).',
        current_value: title.length, target_value: 80,
      })
    } else if (title.length <= 120) {
      titleScore = 100
    } else {
      titleScore = 60
      issues.push({
        pillar: 'relevance', code: 'long_title', severity: 'medium',
        description: `Título excede limite Shopee (${title.length} > 120). Pode ser truncado.`,
        recommended_action: 'Reduzir pra 80-100 chars mantendo palavras-chave principais.',
        current_value: title.length, target_value: 100,
      })
    }
    subs.push(titleScore * 0.30)

    // Attrs: % de mandatory preenchidos.
    const totalMandatory = input.attrs_mandatory_total ?? null
    const filled         = input.attrs_filled            ?? null
    let attrsScore: number
    if (totalMandatory == null || filled == null) {
      attrsScore = 50 // sem dado → meio termo (não pune nem premia)
    } else if (totalMandatory === 0) {
      attrsScore = 100 // categoria sem mandatory
    } else {
      const ratio = filled / totalMandatory
      attrsScore = Math.round(ratio * 100)
      if (ratio < 0.5) {
        issues.push({
          pillar: 'relevance', code: 'missing_mandatory_attrs', severity: 'high',
          description: `Atributos obrigatórios incompletos (${filled}/${totalMandatory}).`,
          recommended_action: 'Preencher TODOS os atributos obrigatórios da categoria — Shopee desranqueia.',
          current_value: filled, target_value: totalMandatory,
        })
      } else if (ratio < 1) {
        issues.push({
          pillar: 'relevance', code: 'incomplete_attrs', severity: 'medium',
          description: `Faltam ${totalMandatory - filled} atributos obrigatórios.`,
          recommended_action: 'Completar atributos restantes pra max relevância.',
          current_value: filled, target_value: totalMandatory,
        })
      }
    }
    subs.push(attrsScore * 0.30)

    // Images: count (50%) + min dimension (50%).
    const count = input.image_count        ?? 0
    const dim   = input.image_min_dimension ?? 0
    let countScore: number
    if (count === 0) {
      countScore = 0
      issues.push({
        pillar: 'relevance', code: 'no_images', severity: 'high',
        description: 'Anúncio sem foto.',
        recommended_action: 'Adicionar ≥5 fotos: capa neutra + ângulos + uso/aplicação.',
      })
    } else if (count < 3) {
      countScore = 30
      issues.push({
        pillar: 'relevance', code: 'few_images', severity: 'high',
        description: `Só ${count} foto(s). Shopee favorece anúncios com 5+.`,
        recommended_action: 'Adicionar fotos de ângulos, detalhes e contexto de uso.',
        current_value: count, target_value: 5,
      })
    } else if (count < 5) {
      countScore = 70
      issues.push({
        pillar: 'relevance', code: 'medium_images', severity: 'low',
        description: `${count} fotos — recomendado 5+.`,
        recommended_action: 'Adicionar 2-3 fotos extra (ângulo, escala, embalagem).',
        current_value: count, target_value: 5,
      })
    } else {
      countScore = 100
    }

    let dimScore: number
    if (dim === 0) {
      dimScore = 50 // sem dado → neutro
    } else if (dim < 500) {
      dimScore = 30
      issues.push({
        pillar: 'relevance', code: 'low_res_images', severity: 'medium',
        description: `Resolução baixa (menor lado ${dim}px). Shopee zoom requer ≥1000px.`,
        recommended_action: 'Re-upload em resolução ≥1000x1000.',
        current_value: dim, target_value: 1000,
      })
    } else if (dim < 1000) {
      dimScore = 70
    } else {
      dimScore = 100
    }

    const imagesScore = Math.round(countScore * 0.5 + dimScore * 0.5)
    subs.push(imagesScore * 0.20)

    // Description: tamanho mínimo + estrutura básica (newlines/bullets).
    const desc = input.description ?? ''
    let descScore: number
    if (!desc) {
      descScore = 0
      issues.push({
        pillar: 'relevance', code: 'no_description', severity: 'high',
        description: 'Anúncio sem descrição.',
        recommended_action: 'Escrever 500+ chars com features, dimensões, garantia, compatibilidade.',
      })
    } else if (desc.length < 200) {
      descScore = 30
      issues.push({
        pillar: 'relevance', code: 'short_description', severity: 'medium',
        description: `Descrição curta (${desc.length} chars).`,
        recommended_action: 'Expandir pra ≥500 chars com bullet points e detalhes técnicos.',
        current_value: desc.length, target_value: 500,
      })
    } else if (desc.length < 500) {
      descScore = 70
    } else {
      descScore = 100
      // Bonus check: tem estrutura?
      const hasBullets = /[•\-\*]\s/.test(desc) || /\n.*\n/.test(desc)
      if (!hasBullets && desc.length < 800) {
        issues.push({
          pillar: 'relevance', code: 'unstructured_description', severity: 'low',
          description: 'Descrição em bloco único — leitura difícil.',
          recommended_action: 'Adicionar bullet points por feature/benefício.',
        })
      }
    }
    subs.push(descScore * 0.20)

    return { score: clampScore(subs.reduce((a, b) => a + b, 0)), issues }
  }

  // ── PILLAR 2 — Performance (30%) ─────────────────────────────────────────
  // sales_velocity 35% + ctr 25% + conversion 30% + new_boost 10%

  private scorePerformance(input: AlgoScoreInput): PillarResult {
    const issues: AlgoScoreIssue[] = []
    const subs: number[] = []

    // Sales velocity (vendas 7d). Baseline: 5+/semana = 100, 0 = 0.
    const sales7d = input.sales_7d ?? null
    let salesScore: number
    if (sales7d == null) {
      salesScore = 50 // sem dado
    } else if (sales7d >= 10) {
      salesScore = 100
    } else if (sales7d >= 5) {
      salesScore = 80
    } else if (sales7d >= 1) {
      salesScore = 40 + sales7d * 8
      issues.push({
        pillar: 'performance', code: 'low_velocity', severity: 'medium',
        description: `Velocidade baixa (${sales7d} vendas/7d). Mínimo saudável: 5.`,
        recommended_action: 'Avaliar voucher de boas-vindas + boost Shopee Ads inicial.',
        current_value: sales7d, target_value: 5,
      })
    } else {
      salesScore = 10
      issues.push({
        pillar: 'performance', code: 'no_sales', severity: 'high',
        description: 'Anúncio sem vendas em 7d.',
        recommended_action: 'Investigar preço, qualidade da listagem e visibilidade (CTR).',
      })
    }
    subs.push(salesScore * 0.35)

    // CTR: > 3% = 100, < 0.5% = 0, linear.
    const ctr = input.ctr ?? null
    let ctrScore: number
    if (ctr == null) {
      ctrScore = 50
    } else if (ctr >= 0.03) {
      ctrScore = 100
    } else if (ctr >= 0.01) {
      ctrScore = Math.round(50 + ((ctr - 0.01) / 0.02) * 50)
    } else if (ctr >= 0.005) {
      ctrScore = Math.round(((ctr - 0.005) / 0.005) * 50)
      issues.push({
        pillar: 'performance', code: 'low_ctr', severity: 'medium',
        description: `CTR baixo (${(ctr * 100).toFixed(2)}%). Esperado >1%.`,
        recommended_action: 'Reforçar capa (primeira foto), título e preço — sinais de busca.',
        current_value: `${(ctr * 100).toFixed(2)}%`, target_value: '>1%',
      })
    } else {
      ctrScore = 0
      issues.push({
        pillar: 'performance', code: 'very_low_ctr', severity: 'high',
        description: `CTR crítico (${(ctr * 100).toFixed(2)}%).`,
        recommended_action: 'Revisar IMEDIATAMENTE: capa, título e preço comparado a top concorrente.',
        current_value: `${(ctr * 100).toFixed(2)}%`, target_value: '>1%',
      })
    }
    subs.push(ctrScore * 0.25)

    // Conversion: > 5% = 100, < 0.5% = 0.
    const conv = input.conversion ?? null
    let convScore: number
    if (conv == null) {
      convScore = 50
    } else if (conv >= 0.05) {
      convScore = 100
    } else if (conv >= 0.02) {
      convScore = Math.round(60 + ((conv - 0.02) / 0.03) * 40)
    } else if (conv >= 0.005) {
      convScore = Math.round(((conv - 0.005) / 0.015) * 60)
      issues.push({
        pillar: 'performance', code: 'low_conversion', severity: 'medium',
        description: `Conversão baixa (${(conv * 100).toFixed(2)}%). Esperado >2%.`,
        recommended_action: 'Checar avaliações negativas, preço final e estoque visível.',
        current_value: `${(conv * 100).toFixed(2)}%`, target_value: '>2%',
      })
    } else {
      convScore = 0
      issues.push({
        pillar: 'performance', code: 'very_low_conversion', severity: 'high',
        description: `Conversão crítica (${(conv * 100).toFixed(2)}%). Cliques entram mas não compram.`,
        recommended_action: 'Comparar preço final (com frete) ao líder. Avaliar avaliações <3 estrelas.',
        current_value: `${(conv * 100).toFixed(2)}%`, target_value: '>2%',
      })
    }
    subs.push(convScore * 0.30)

    // New-product boost: < 30d = 100, 30-90d = 60, 90-180d = 30, > 180d = 0.
    const createdAt = input.created_at ? new Date(input.created_at) : null
    let newScore: number
    if (!createdAt) {
      newScore = 50
    } else {
      const ageDays = (Date.now() - createdAt.getTime()) / 86400_000
      if (ageDays < 30)       newScore = 100
      else if (ageDays < 90)  newScore = 60
      else if (ageDays < 180) newScore = 30
      else                    newScore = 0
    }
    subs.push(newScore * 0.10)

    return { score: clampScore(subs.reduce((a, b) => a + b, 0)), issues }
  }

  // ── PILLAR 3 — Qualidade de loja (20%) — shop-level ──────────────────────
  // chat 20% + shipping 25% + returns 20% + rating 20% + penalty 15%

  private scoreSellerQuality(input: AlgoScoreInput): PillarResult {
    const issues: AlgoScoreIssue[] = []
    const m = input.shop_metrics
    if (!m) {
      // Sem dados de loja → score neutro 50, sem issues (não pune até ter dado).
      return { score: 50, issues }
    }

    const subs: number[] = []

    // Chat: rate (60%) + time decay (40%).
    let chatScore: number
    const rate = m.chat_response_rate ?? null
    const time = m.chat_response_time_min ?? null
    if (rate == null && time == null) {
      chatScore = 50
    } else {
      const rateSub = rate == null ? 50 : Math.round(rate * 100)
      let timeSub: number
      if (time == null)         timeSub = 50
      else if (time <= 5)       timeSub = 100
      else if (time <= 15)      timeSub = 80
      else if (time <= 60)      timeSub = 50
      else if (time <= 240)     timeSub = 25
      else                      timeSub = 0
      chatScore = Math.round(rateSub * 0.6 + timeSub * 0.4)
      if (rate != null && rate < 0.85) {
        issues.push({
          pillar: 'seller_quality', code: 'low_chat_response', severity: rate < 0.7 ? 'high' : 'medium',
          description: `Taxa de resposta no chat ${(rate * 100).toFixed(0)}% (mínimo Shopee: 85%).`,
          recommended_action: 'Ligar notificações + plantão diário. Abaixo de 70% gera penalty.',
          current_value: `${(rate * 100).toFixed(0)}%`, target_value: '≥85%',
        })
      }
    }
    subs.push(chatScore * 0.20)

    // Shipping: prep_time (50%) + late_ship (50%).
    let shipScore: number
    const prep = m.prep_time_days ?? null
    const late = m.late_ship_rate ?? null
    if (prep == null && late == null) {
      shipScore = 50
    } else {
      let prepSub: number
      if (prep == null)      prepSub = 50
      else if (prep <= 1)    prepSub = 100
      else if (prep <= 2)    prepSub = 70
      else if (prep <= 3)    prepSub = 40
      else                   prepSub = 10
      let lateSub: number
      if (late == null)      lateSub = 50
      else if (late <= 0.01) lateSub = 100
      else if (late <= 0.05) lateSub = 70
      else if (late <= 0.10) lateSub = 40
      else                   lateSub = 0
      shipScore = Math.round(prepSub * 0.5 + lateSub * 0.5)
      if (prep != null && prep > 2) {
        issues.push({
          pillar: 'seller_quality', code: 'slow_prep', severity: prep > 3 ? 'high' : 'medium',
          description: `Tempo de preparação ${prep.toFixed(1)} dias (ideal ≤2).`,
          recommended_action: 'Reduzir prep time — Shopee desranqueia anúncios de lojas lentas.',
          current_value: `${prep.toFixed(1)}d`, target_value: '≤2d',
        })
      }
      if (late != null && late > 0.05) {
        issues.push({
          pillar: 'seller_quality', code: 'high_late_ship', severity: late > 0.10 ? 'high' : 'medium',
          description: `Atrasos ${(late * 100).toFixed(1)}% (limite Shopee: 5%).`,
          recommended_action: 'Revisar processo logístico — atraso é peso pesado no ranking.',
          current_value: `${(late * 100).toFixed(1)}%`, target_value: '≤5%',
        })
      }
    }
    subs.push(shipScore * 0.25)

    // Returns: < 2% = 100, > 10% = 0.
    let retScore: number
    const ret = m.return_refund_rate ?? null
    if (ret == null) {
      retScore = 50
    } else if (ret <= 0.02) {
      retScore = 100
    } else if (ret <= 0.05) {
      retScore = 70
    } else if (ret <= 0.10) {
      retScore = 30
      issues.push({
        pillar: 'seller_quality', code: 'high_returns', severity: 'medium',
        description: `Devoluções ${(ret * 100).toFixed(1)}% (alvo ≤5%).`,
        recommended_action: 'Auditar descrição vs produto recebido. Revisar embalagem.',
        current_value: `${(ret * 100).toFixed(1)}%`, target_value: '≤5%',
      })
    } else {
      retScore = 0
      issues.push({
        pillar: 'seller_quality', code: 'critical_returns', severity: 'high',
        description: `Devoluções críticas (${(ret * 100).toFixed(1)}%).`,
        recommended_action: 'Investigar URGENTE: produto, embalagem ou descrição enganosa.',
        current_value: `${(ret * 100).toFixed(1)}%`, target_value: '≤5%',
      })
    }
    subs.push(retScore * 0.20)

    // Rating: ≥4.8 = 100, <4.0 = 0.
    let ratingScore: number
    const r = m.rating ?? null
    if (r == null) {
      ratingScore = 50
    } else if (r >= 4.8) {
      ratingScore = 100
    } else if (r >= 4.5) {
      ratingScore = 80
    } else if (r >= 4.0) {
      ratingScore = 50
      issues.push({
        pillar: 'seller_quality', code: 'medium_rating', severity: 'medium',
        description: `Rating ${r.toFixed(2)} — ideal ≥4.5.`,
        recommended_action: 'Pedir review pós-entrega + resolver avaliações <3 estrelas em <24h.',
        current_value: r.toFixed(2), target_value: '≥4.5',
      })
    } else {
      ratingScore = 0
      issues.push({
        pillar: 'seller_quality', code: 'low_rating', severity: 'high',
        description: `Rating crítico ${r.toFixed(2)}.`,
        recommended_action: 'Plano de recuperação: contato pessoal com clientes <3 estrelas + troca/reembolso.',
        current_value: r.toFixed(2), target_value: '≥4.5',
      })
    }
    subs.push(ratingScore * 0.20)

    // Penalty: 0 = 100; cada ponto reduz ~17. 6+ pontos = ameaça grave (0).
    let penaltyScore: number
    const pen = m.penalty_points ?? null
    if (pen == null) {
      penaltyScore = 100 // sem dado → assume limpo (otimista)
    } else if (pen === 0) {
      penaltyScore = 100
    } else if (pen <= 2) {
      penaltyScore = 70
      issues.push({
        pillar: 'seller_quality', code: 'low_penalty', severity: 'medium',
        description: `${pen} ponto(s) de punição acumulado(s).`,
        recommended_action: 'Identificar causa raiz (atraso/violação) — 6+ pontos é ameaça grave.',
        current_value: pen, target_value: 0,
      })
    } else if (pen <= 5) {
      penaltyScore = 30
      issues.push({
        pillar: 'seller_quality', code: 'high_penalty', severity: 'high',
        description: `${pen} pontos de punição — proximidade do limite (6).`,
        recommended_action: 'AÇÃO IMEDIATA pra zerar — Shopee suspende loja a partir de 6 pontos.',
        current_value: pen, target_value: 0,
      })
    } else {
      penaltyScore = 0
      issues.push({
        pillar: 'seller_quality', code: 'critical_penalty', severity: 'high',
        description: `${pen} pontos de punição — risco de suspensão.`,
        recommended_action: 'EMERGÊNCIA: contatar Shopee + corrigir violações + recurso.',
        current_value: pen, target_value: 0,
      })
    }
    subs.push(penaltyScore * 0.15)

    return { score: clampScore(subs.reduce((a, b) => a + b, 0)), issues }
  }

  // ── PILLAR 4 — Preço + marketing (10%) ───────────────────────────────────
  // price 60% + marketing_active 40%

  private scorePriceMarketing(input: AlgoScoreInput): PillarResult {
    const issues: AlgoScoreIssue[] = []
    const subs: number[] = []

    // Price: ratio nosso/mediana mercado. < 0.95 = 100; > 1.10 = 0.
    const price  = input.price                ?? null
    const median = input.market_median_price  ?? null
    let priceScore: number
    if (price == null || median == null || median <= 0) {
      priceScore = 50
    } else {
      const ratio = price / median
      if (ratio <= 0.90) {
        priceScore = 100
      } else if (ratio <= 1.05) {
        priceScore = 80
      } else if (ratio <= 1.10) {
        priceScore = 50
        issues.push({
          pillar: 'price_marketing', code: 'high_price', severity: 'medium',
          description: `Preço ${((ratio - 1) * 100).toFixed(0)}% acima do líder do mercado.`,
          recommended_action: 'Reavaliar margem ou justificar com diferencial (frete grátis, bônus).',
          current_value: ratio.toFixed(2), target_value: '≤1.05',
        })
      } else {
        priceScore = 10
        issues.push({
          pillar: 'price_marketing', code: 'uncompetitive_price', severity: 'high',
          description: `Preço ${((ratio - 1) * 100).toFixed(0)}% acima do líder — não-competitivo.`,
          recommended_action: 'Ajustar preço OU criar voucher exclusivo pra balancear.',
          current_value: ratio.toFixed(2), target_value: '≤1.05',
        })
      }
    }
    subs.push(priceScore * 0.60)

    // Marketing: 33% por slot ativo (voucher + flash + ads).
    let mktSlots = 0
    if (input.has_voucher)    mktSlots++
    if (input.has_flash_sale) mktSlots++
    if (input.has_ads)        mktSlots++
    const mktScore = mktSlots === 0 ? 20 : Math.round((mktSlots / 3) * 100)
    if (mktSlots === 0) {
      issues.push({
        pillar: 'price_marketing', code: 'no_marketing', severity: 'low',
        description: 'Sem voucher / flash sale / ads ativos.',
        recommended_action: 'Testar 1 voucher exclusivo (-5%) + boost de R$30 em ads.',
      })
    }
    subs.push(mktScore * 0.40)

    return { score: clampScore(subs.reduce((a, b) => a + b, 0)), issues }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Ordena issues por severidade (high > med > low) + peso do pilar. */
  private prioritize(all: AlgoScoreIssue[]): AlgoScoreIssue[] {
    const sev   = { high: 3, medium: 2, low: 1 } as const
    const pilar = PILLAR_WEIGHTS
    return [...all].sort((a, b) => {
      const ds = sev[b.severity] - sev[a.severity]
      if (ds !== 0) return ds
      return pilar[b.pillar] - pilar[a.pillar]
    })
  }
}

/** Garante valor 0-100 inteiro (defensivo contra rounding overshoot). */
function clampScore(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)))
}
