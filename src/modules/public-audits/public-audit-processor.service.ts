import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ListingScraperService } from '../ai-visibility/geo-score/services/listing-scraper.service'
import { GeoScoreCalculatorService } from '../ai-visibility/geo-score/services/geo-score-calculator.service'
import { RankSimulatorService } from '../ai-visibility/geo-optimizer/services/rank-simulator.service'
import { GeoSkipError } from '../ai-visibility/shared/skip-error'
import type { GeoDimensionName, GeoDimensionResult, GeoScoreResult, ScrapedListing } from '../ai-visibility/shared/types'

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
  topProblems: Array<{ rank: number; key: GeoDimensionName; title: string; why: string; gain: string }>
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
 * Reusa o motor: scrape → calculate → simulateDraft. Monta um result_json
 * PÚBLICO: nota + 8 dimensões + top-3 problemas (derivados das dimensões mais
 * fracas, SEM a reescrita — que é o produto pago) + mini simulação de ranking.
 * Org fixa (plataforma) resolve tokens ML + logging de custo — nunca vem do visitante.
 */
@Injectable()
export class PublicAuditProcessorService {
  private readonly logger = new Logger(PublicAuditProcessorService.name)
  private ticking = false

  constructor(
    private readonly scraper: ListingScraperService,
    private readonly calc:    GeoScoreCalculatorService,
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

      // Mini rank sim best-effort — a NOTA é o must-have; o ranking degrada sem quebrar.
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

      const result = buildPublicResult(scraped, score, rank)
      await supabaseAdmin.from('public_audits').update({
        status: 'done', geo_score: result.score, result_json: result,
        completed_at: new Date().toISOString(), duration_ms: Date.now() - t0, error_message: null,
      }).eq('id', job.id)
      this.logger.log(`[public-audit-worker] audit ${job.id} OK score=${result.score} ${Date.now() - t0}ms`)
    } catch (e) {
      // Página inauditável (esgotada/403/404) → done com resultado "skipped" (sem retry).
      if (e instanceof GeoSkipError) {
        const skipped = emptyResult(e.skipReason)
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

/** Problema (sem a solução) por dimensão — texto humano, pra tela de resultado. */
const PROBLEM_INFO: Record<GeoDimensionName, { title: string; why: string }> = {
  title_geo: {
    title: 'Seu título não responde à intenção de compra',
    why: 'A IA prioriza títulos no formato "[Produto] para [uso/contexto]". O seu não deixa claro pra quem e em qual situação o produto serve.',
  },
  description_depth: {
    title: 'Sua descrição é rasa demais pra IA',
    why: 'Descrições com dados, medidas e contexto de uso são citadas muito mais. A IA precisa de profundidade — não de um texto curto e genérico.',
  },
  entity_coverage: {
    title: 'Faltam dados e atributos concretos',
    why: 'Especificações, medidas e materiais ajudam a IA a recomendar com confiança. Seu anúncio expõe poucos desses dados.',
  },
  semantic_density: {
    title: 'Conteúdo pouco focado (ou com excesso de palavra-chave)',
    why: 'A IA penaliza enchimento de palavra-chave e valoriza texto coeso e informativo sobre o produto. O equilíbrio do seu conteúdo está fraco.',
  },
  structured_data: {
    title: 'Faltam dados estruturados pra IA',
    why: 'Marcações (schema/JSON-LD) entregam preço, avaliações e specs prontos pra IA. As suas estão ausentes ou incompletas.',
  },
  review_architecture: {
    title: 'Sem avaliações e provas sociais visíveis',
    why: 'Avaliações são um dos sinais mais fortes pra IA recomendar um produto. O seu anúncio não as expõe de forma legível pra IA.',
  },
  faq_presence: {
    title: 'Seu anúncio não tem FAQ',
    why: 'A IA "pensa" em formato de pergunta. Sem um FAQ respondendo dúvidas reais, você não é citado quando o comprador pergunta.',
  },
  crawler_access: {
    title: 'Bots de IA podem estar bloqueados',
    why: 'Se o robots.txt bloqueia os crawlers de IA, seu conteúdo nem chega a ser lido — você fica invisível por padrão.',
  },
}

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

const SCIENCE = {
  kdd: 'Citar fontes, adicionar estatísticas e melhorar a fluência aumentam a visibilidade em IA em até +40% (KDD 2024, Princeton).',
  ego: 'Existe uma “receita universal” que faz a IA recomendar seu produto: intenção, diferenciais, avaliações e factualidade (E-GEO 2025, Columbia + MIT).',
}

function buildPublicResult(
  scraped: ScrapedListing,
  score: GeoScoreResult,
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

  // Top 3 problemas = dimensões mais fracas por IMPACTO (peso × distância do 10),
  // só as que estão realmente fracas (score < 7/10). Mostra o problema, NÃO a reescrita.
  const topProblems = score.dimensions
    .filter((d) => d.score < 7)
    .map((d) => ({ d, impact: (10 - d.score) * d.weight }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3)
    .map(({ d }, i) => ({
      rank: i + 1,
      key: d.name,
      title: PROBLEM_INFO[d.name].title,
      why: PROBLEM_INFO[d.name].why,
      gain: `+${Math.max(1, Math.round(((10 - d.score) * d.weight / 90) * 100))} pontos`,
    }))

  const band = bandOf(score.geoScore)
  return {
    platform: scraped.platform,
    score: score.geoScore,
    band,
    headline: headlineOf(band),
    dimensions,
    topProblems,
    rankSimulation: rank,
    science: SCIENCE,
    skipped: null,
  }
}

function emptyResult(reason: string): PublicAuditResult {
  return {
    platform: 'unknown', score: 0, band: 'red',
    headline: 'Não conseguimos ler essa página automaticamente.',
    dimensions: [], topProblems: [], rankSimulation: null,
    science: SCIENCE, skipped: { reason },
  }
}
