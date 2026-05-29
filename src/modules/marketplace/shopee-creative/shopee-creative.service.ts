import { Injectable, Logger, NotImplementedException } from '@nestjs/common'
import { ShopeeAlgoScoreService } from '../shopee-algo-score/shopee-algo-score.service'
import { AlgoScoreInput } from '../shopee-algo-score/algo-score.types'
import {
  ShopeeDraftListing, ShopeeEvaluateResponse, RELEVANCE_GATE,
} from './shopee-creative.types'

/** F18 F1.7 — IA Criativo Shopee: guard de pré-publicação.
 *
 *  evaluateDraft() — funciona 100% agora. Roda o Algorithm Score (F1.1)
 *  no rascunho e decide se libera publish (relevância >= gate). Compute
 *  puro, sem I/O externo.
 *
 *  publish() — stub. Precisa de creds Open Platform (Sprint 2). Quando
 *  ativar, vai: upload imagens (image_id, não URL) → /api/v2/product/
 *  add_item → grava em product_listings platform=shopee. */
@Injectable()
export class ShopeeCreativePublisherService {
  private readonly logger = new Logger(ShopeeCreativePublisherService.name)

  constructor(private readonly algoScore: ShopeeAlgoScoreService) {}

  /** Avalia rascunho em dry-run. Performance/qualidade de loja entram
   *  neutros (rascunho não tem vendas nem é shop-level), então só
   *  relevância + preço/marketing são acionáveis. */
  evaluateDraft(draft: ShopeeDraftListing): ShopeeEvaluateResponse {
    const input: AlgoScoreInput = {
      shop_id:               draft.shop_id,
      item_id:               draft.item_id ?? 0,
      product_id:            draft.product_id ?? null,
      title:                 draft.title,
      description:           draft.description,
      image_count:           draft.image_count,
      image_min_dimension:   draft.image_min_dimension,
      attrs_filled:          draft.attrs_filled,
      attrs_mandatory_total: draft.attrs_mandatory_total,
      price:                 draft.price,
      market_median_price:   draft.market_median_price,
      // Performance + shop quality ausentes de propósito — rascunho.
      // O algo score trata null como neutro (não pune).
    }

    const score = this.algoScore.compute(input)

    const blockers: string[] = []
    const warnings: string[] = []

    // Gate principal: relevância.
    if (score.pillars.relevance < RELEVANCE_GATE) {
      blockers.push(
        `Relevância ${score.pillars.relevance}/100 abaixo do mínimo (${RELEVANCE_GATE}). ` +
        `Corrija título/atributos/imagens/descrição antes de publicar — ` +
        `Shopee ranqueia anúncios completos muito melhor.`,
      )
    }

    // Warnings não-bloqueantes: issues de severity alta dos outros pilares.
    for (const iss of score.issues) {
      if (iss.severity === 'high' && iss.pillar !== 'relevance') {
        warnings.push(`${iss.description} → ${iss.recommended_action}`)
      }
    }

    const ready = blockers.length === 0

    return {
      score,
      ready,
      blockers,
      warnings,
      publish_enabled: this.isPublishEnabled(),
    }
  }

  /** Publica de fato no Shopee. STUB — precisa de creds (Sprint 2). */
  async publish(_draft: ShopeeDraftListing): Promise<never> {
    throw new NotImplementedException(
      'Publish no Shopee ainda não disponível — aguardando aprovação das ' +
      'credenciais Open Platform (F0.1). Use evaluateDraft pra pré-avaliar ' +
      'o rascunho enquanto isso.',
    )
  }

  /** Feature flag: só libera publish quando creds Shopee estiverem setadas.
   *  Por ora SHOPEE_PARTNER_ID/KEY de prod ainda não existem (só TEST). */
  private isPublishEnabled(): boolean {
    return Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY)
  }
}
