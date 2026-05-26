import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ListingScraperService } from '../ai-visibility/geo-score/services/listing-scraper.service'
import { GeoScoreCalculatorService } from '../ai-visibility/geo-score/services/geo-score-calculator.service'
import { GeoRecommendationsService } from '../ai-visibility/geo-score/services/geo-recommendations.service'
import { RankSimulatorService } from '../ai-visibility/geo-optimizer/services/rank-simulator.service'
import { GeoSkipError } from '../ai-visibility/shared/skip-error'
import type {
  GeoDimensionName, GeoDimensionResult, GeoScoreResult, GeoRecommendation, ScrapedListing,
} from '../ai-visibility/shared/types'

const STALE_MS = 3 * 60_000
const MAX_ATTEMPTS = 3
const ORG_ID = () => process.env.PUBLIC_AUDIT_ORG_ID ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'

type Band = 'red' | 'yellow' | 'green'

/** Shape do result_json devolvido pelo GET /public/audits/:id (consumido pela tela de resultado). */
export interface PublicAuditResult {
  platform:  string
  score:     number               // 0-100
  band:      Band
  headline:  string
  dimensions: Array<{ key: GeoDimensionName; label: string; score: number; weight: number; status: Band }>
  topProblems: Array<{ rank: number; title: string; why: string; gain: string }>
  rankSimulation: { query: string; candidate_count: number; your_rank: number | null } | null
  science: { kdd: string; ego: string }
  skipped: { reason: string } | null
}

interface ClaimRow { id: string; url: string; attempts: number }

/**
 * Worker da Auditoria GEO pública (Sprint 2a). DB-como-fila igual ao
 * ScoreProcessorService do geo-score: @Cron(30s) reprocessa travadas +
 * kick() async no submit pra começar na hora. Claim via CAS em started_at.
 *
 * Reusa o motor existente: scrape → calculate → recommendations → simulateDraft.
 * Monta um result_json PÚBLICO: nota + 8 dimensões + 3 problemas (SEM a reescrita,
 * que é o produto pago) + mini simulação de ranking. Org fixa (plataforma) resolve
 * tokens ML + logging de custo — nunca vem do visitante.
 */
@Injectable()
export class PublicAuditProcessorService {
  private readonly logger = new Logger(PublicAuditProcessorService.name)
  private ticking = false

  constructor(
    private readonly scraper: ListingScraperService,
    private readonly calc:    GeoScoreCalculatorService,
    private readonly recs:    GeoRecommendationsService,
    private readonly rankSim: RankSimulatorService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'public-audit-processor' })
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const staleIso = new Date(Date.now() - STALE_MS).toISOString()
      const { data } = await supabaseAdmin
        .from('public_audits')
        .select('id')
        .eq('status', 'running')
        .lt('attempts', MAX_ATTEMPTS)
        .or(`started_at.is.null,started_at.lte.${staleIso}`)
        .order('created_at', { ascending: true })
        .limit(3)
      const ids = (data ?? []).map((r: { id: string }) => r.id)
      if (ids.length === 0) return
      await Promise.all(ids.map((id) => this.claimAndProcess(id)))
    } catch (e) {
      this.logger.warn(`[public-audit-worker] tick falhou: ${(e as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  /** Disparado pelo POST /start pra começar na hora. Fire-and-forget. */
  kick(id: string): void {
    void this.claimAndProcess(id).catch((e) =>
      this.logger.warn(`[public-audit-worker] kick ${id} falhou: ${(e as Error).message}`),
    )
  }

  /** CAS: só processa se conseguir marcar started_at (status running + não-reclamado/stale). */
  private async claimAndProcess(id: string): Promise<void> {
    const staleIso = new Date(Date.now() - STALE_MS).toISOString()
    const { data: claimed } = await supabaseAdmin
      .from('public_audits')
      .update({ started_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'running')
      .or(`started_at.is.null,started_at.lte.${staleIso}`)
      .select('id, url, attempts')
      .maybeSingle()
    if (!claimed) return // outro tick/kick já pegou
    await this.process(claimed as ClaimRow)
  }

  private async process(job: ClaimRow): Promise<void> {
    const orgId = ORG_ID()
    const t0 = Date.now()
    try {
      const scraped = await this.scraper.scrape(job.url, orgId)
      const score = await this.calc.calculate(orgId, scraped)

      // Enhancements best-effort — a NOTA é o must-have; recs/rank degradam sem quebrar.
      let recommendations: GeoRecommendation[] = []
      try {
        recommendations = (await this.recs.generate(orgId, scraped, score.dimensions)).recommendations
      } catch (e) {
        this.logger.warn(`[public-audit-worker] recs falhou audit=${job.id}: ${(e as Error).message}`)
      }
      let rank: PublicAuditResult['rankSimulation'] = null
      try {
        const sim = await this.rankSim.simulateDraft(orgId, {
          productId: null, category: scraped.category,
          title: scraped.title ?? '', description: scraped.description ?? '',
        })
        if (sim.candidate_count >= 1 && sim.queries.length > 0) {
          rank = {
            query: sim.queries[0].query,
            candidate_count: sim.candidate_count,
            your_rank: sim.avg_rank != null ? Math.round(sim.avg_rank) : null,
          }
        }
      } catch (e) {
        this.logger.warn(`[public-audit-worker] rankSim falhou audit=${job.id}: ${(e as Error).message}`)
      }

      const result = buildPublicResult(scraped, score, recommendations, rank)
      await supabaseAdmin.from('public_audits').update({
        status: 'done', geo_score: result.score, result_json: result,
        completed_at: new Date().toISOString(), duration_ms: Date.now() - t0, error_message: null,
      }).eq('id', job.id)
      this.logger.log(`[public-audit-worker] audit ${job.id} OK score=${result.score} ${Date.now() - t0}ms`)
    } catch (e) {
      // Página inauditável (esgotada/403/404) → done com resultado "skipped" (sem retry).
      if (e instanceof GeoSkipError) {
        const skipped = emptyResult(job.url, e.skipReason)
        await supabaseAdmin.from('public_audits').update({
          status: 'done', geo_score: null, result_json: skipped,
          completed_at: new Date().toISOString(), duration_ms: Date.now() - t0,
        }).eq('id', job.id)
        this.logger.log(`[public-audit-worker] audit ${job.id} PULADO (${e.skipReason})`)
        return
      }
      await this.handleFailure(job, (e as Error).message)
    }
  }

  private async handleFailure(job: ClaimRow, errMsg: string): Promise<void> {
    const attempts = job.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await supabaseAdmin.from('public_audits').update({
        status: 'failed', attempts, error_message: errMsg.slice(0, 500),
      }).eq('id', job.id)
      this.logger.error(`[public-audit-worker] audit ${job.id} FALHOU após ${attempts}: ${errMsg}`)
    } else {
      // Solta o claim (started_at=null) + incrementa attempts → tick reprocessa.
      await supabaseAdmin.from('public_audits').update({
        started_at: null, attempts, error_message: errMsg.slice(0, 500),
      }).eq('id', job.id)
      this.logger.warn(`[public-audit-worker] audit ${job.id} falhou (tentativa ${attempts}), retry: ${errMsg}`)
    }
  }
}

// ── mapeamento pro resultado público ───────────────────────────────────

const DIM_LABELS: Record<GeoDimensionName, string> = {
  title_geo:           'Título responde à intenção do comprador',
  description_depth:   'Profundidade da descrição',
  entity_coverage:     'Dados e atributos concretos',
  semantic_density:    'Densidade semântica (sem encher de palavra-chave)',
  structured_data:     'Dados estruturados para IA',
  review_architecture: 'Avaliações e provas sociais',
  faq_presence:        'FAQ respondendo dúvidas reais',
  crawler_access:      'Acesso de bots de IA',
}

const DIM_ORDER: GeoDimensionName[] = [
  'title_geo', 'description_depth', 'entity_coverage', 'semantic_density',
  'structured_data', 'review_architecture', 'faq_presence', 'crawler_access',
]

const SEVERITY_RANK: Record<GeoRecommendation['severity'], number> = { high: 0, medium: 1, low: 2 }

function bandOf(score100: number): Band {
  if (score100 < 40) return 'red'
  if (score100 < 70) return 'yellow'
  return 'green'
}

function headlineOf(band: Band): string {
  if (band === 'red')    return 'Sua marca está praticamente invisível pra IA hoje.'
  if (band === 'yellow') return 'Sua marca aparece, mas raramente no topo das respostas da IA.'
  return 'Sua marca está entre as mais bem posicionadas pra IA.'
}

function buildPublicResult(
  scraped: ScrapedListing,
  score: GeoScoreResult,
  recs: GeoRecommendation[],
  rank: PublicAuditResult['rankSimulation'],
): PublicAuditResult {
  const byName = new Map<GeoDimensionName, GeoDimensionResult>()
  for (const d of score.dimensions) byName.set(d.name, d)

  const dimensions = DIM_ORDER
    .map((key) => {
      const d = byName.get(key)
      if (!d) return null
      const s100 = Math.round(d.score * 10)
      return { key, label: DIM_LABELS[key], score: s100, weight: d.weight, status: bandOf(s100) }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  // Top 3 problemas: das recomendações (dimensões fracas), por severidade.
  // Mostra só o PROBLEMA (title + why) — a reescrita (example_after) fica pro produto pago.
  const topProblems = [...recs]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 3)
    .map((r, i) => ({ rank: i + 1, title: r.title, why: r.description, gain: r.estimated_impact }))

  const band = bandOf(score.geoScore)
  return {
    platform: scraped.platform,
    score: score.geoScore,
    band,
    headline: headlineOf(band),
    dimensions,
    topProblems,
    rankSimulation: rank,
    science: {
      kdd: 'Citar fontes, adicionar estatísticas e melhorar a fluência aumentam a visibilidade em IA em até +40% (KDD 2024, Princeton).',
      ego: 'Existe uma “receita universal” que faz a IA recomendar seu produto: intenção, diferenciais, avaliações e factualidade (E-GEO 2025, Columbia + MIT).',
    },
    skipped: null,
  }
}

function emptyResult(_url: string, reason: string): PublicAuditResult {
  return {
    platform: 'unknown', score: 0, band: 'red',
    headline: 'Não conseguimos ler essa página automaticamente.',
    dimensions: [], topProblems: [], rankSimulation: null,
    science: {
      kdd: 'Citar fontes, adicionar estatísticas e melhorar a fluência aumentam a visibilidade em IA em até +40% (KDD 2024, Princeton).',
      ego: 'Existe uma “receita universal” que faz a IA recomendar seu produto: intenção, diferenciais, avaliações e factualidade (E-GEO 2025, Columbia + MIT).',
    },
    skipped: { reason },
  }
}
