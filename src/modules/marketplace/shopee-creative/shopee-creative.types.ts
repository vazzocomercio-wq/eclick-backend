/** F18 F1.7 — Tipos do IA Criativo Shopee (guard de pré-publicação).
 *
 *  Antes de publicar um anúncio no Shopee, o rascunho passa pelo Algorithm
 *  Score (F1.1) em dry-run. Se o pilar Relevância < 70, o guard bloqueia
 *  (ou avisa) e sugere correções ANTES de gastar a chamada de publish.
 *
 *  publish() em si fica stub até creds Open Platform aprovarem (Sprint 2).
 *  O guard (evaluateDraft) funciona 100% agora — é compute puro.
 */

import { AlgoScoreBreakdown } from '../shopee-algo-score/algo-score.types'

/** Rascunho de anúncio Shopee — o que o usuário montou no IA Criativo
 *  antes de publicar. Subconjunto do AlgoScoreInput focado nos sinais que
 *  o autor CONTROLA na criação (relevância + preço). Performance/qualidade
 *  de loja não se aplicam a um rascunho não-publicado. */
export interface ShopeeDraftListing {
  shop_id:                number
  /** item_id só existe pós-publish; em rascunho é 0/placeholder. */
  item_id?:               number | null
  product_id?:            string | null

  title?:                 string | null
  description?:           string | null
  image_count?:           number | null
  image_min_dimension?:   number | null
  attrs_filled?:          number | null
  attrs_mandatory_total?: number | null

  /** Preço pretendido + mediana do mercado (do Radar F1.5) pra avaliar
   *  competitividade já no rascunho. */
  price?:                 number | null
  market_median_price?:   number | null
}

/** Resposta do guard. Espelha o PreviewResponse do ML publisher:
 *  ready + warnings + publish_enabled flag. */
export interface ShopeeEvaluateResponse {
  /** Score completo (4 pilares + issues). Performance/qualidade vêm
   *  neutros (50) num rascunho — só relevância+preço são acionáveis. */
  score:            AlgoScoreBreakdown
  /** Pode publicar? Regra: relevância >= RELEVANCE_GATE. */
  ready:            boolean
  /** Motivos de bloqueio (se ready=false) em PT-BR. */
  blockers:         string[]
  /** Avisos não-bloqueantes. */
  warnings:         string[]
  /** Backend permite publish de fato? false até creds Shopee (Sprint 2).
   *  Frontend usa pra mostrar "Publicar" vs "Em breve". */
  publish_enabled:  boolean
}

/** Gate mínimo de relevância pra liberar publish. Abaixo disso, o anúncio
 *  nasce mal-ranqueado — melhor corrigir antes. */
export const RELEVANCE_GATE = 70
