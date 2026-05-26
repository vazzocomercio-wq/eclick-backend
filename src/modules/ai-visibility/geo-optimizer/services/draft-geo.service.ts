import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../../common/supabase'
import { GeoScoreCalculatorService } from '../../geo-score/services/geo-score-calculator.service'
import { GeoScoreResult, ScrapedListing } from '../../shared/types'
import { RankSimulatorService, DraftSimReport } from './rank-simulator.service'

/**
 * Ponte GEO × Criador de anúncios (Creative). Pontua e simula o ranking de um
 * RASCUNHO de anúncio (creative_listings) — ANTES de publicar — sem tocar no
 * caminho de atributos/publicação do ML. 100% leitura do rascunho.
 */
interface DraftRow {
  id: string
  product_id: string | null
  title: string | null
  subtitle: string | null
  description: string | null
  bullets: unknown
  faq: unknown
  ml_attributes: unknown
  category_ml_id: string | null
  suggested_category: string | null
}

@Injectable()
export class DraftGeoService {
  private readonly logger = new Logger(DraftGeoService.name)

  constructor(
    private readonly geoScore:  GeoScoreCalculatorService,
    private readonly simulator: RankSimulatorService,
  ) {}

  /** GEO Score do rascunho (como a IA enxergaria o conteúdo atual). */
  async score(orgId: string, listingId: string): Promise<GeoScoreResult> {
    const d = await this.loadDraft(orgId, listingId)
    return this.geoScore.calculate(orgId, this.buildListing(d))
  }

  /** Posição do rascunho num motor de IA vs concorrentes (atual). */
  async simulate(orgId: string, listingId: string, userId?: string): Promise<DraftSimReport> {
    const d = await this.loadDraft(orgId, listingId)
    return this.simulator.simulateDraft(orgId, {
      productId: d.product_id, category: d.suggested_category ?? d.category_ml_id,
      title: d.title ?? '', description: this.contentText(d),
    }, userId)
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async loadDraft(orgId: string, listingId: string): Promise<DraftRow> {
    const { data } = await supabaseAdmin
      .from('creative_listings')
      .select('id, product_id, title, subtitle, description, bullets, faq, ml_attributes, category_ml_id, suggested_category')
      .eq('organization_id', orgId).eq('id', listingId).maybeSingle()
    if (!data) throw new BadRequestException('Rascunho de anúncio não encontrado.')
    return data as DraftRow
  }

  /** Texto completo do rascunho (descrição + bullets + FAQ) — o que a IA leria. */
  private contentText(d: DraftRow): string {
    const bullets = Array.isArray(d.bullets) ? (d.bullets as string[]) : []
    const faq = Array.isArray(d.faq) ? (d.faq as Array<{ q?: string; a?: string }>) : []
    const parts = [
      d.subtitle ?? '',
      d.description ?? '',
      bullets.length ? `Destaques:\n- ${bullets.join('\n- ')}` : '',
      faq.length ? `Perguntas frequentes:\n${faq.map(f => `P: ${f.q}\nR: ${f.a}`).join('\n')}` : '',
    ].filter(s => s && String(s).trim())
    return parts.join('\n\n').slice(0, 6000)
  }

  private buildListing(d: DraftRow): ScrapedListing {
    const attrs = Array.isArray(d.ml_attributes)
      ? (d.ml_attributes as Array<Record<string, unknown>>)
          .map(a => ({ name: String(a.id ?? ''), value: String(a.value_name ?? a.value_id ?? '') }))
          .filter(a => a.name && a.value && a.value !== '-1')
      : []
    return {
      url: '', platform: 'mercadolivre', listingId: d.id,
      title: d.title, description: this.contentText(d) || null,
      attributes: attrs, price: null, images: [],
      reviews_count: null, rating: null,
      category: d.suggested_category ?? d.category_ml_id ?? null,
    }
  }
}
