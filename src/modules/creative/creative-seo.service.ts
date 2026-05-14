import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { CreativeService, type CreativeListing, type CreativeProduct } from './creative.service'

/**
 * Análise SEO de um CreativeListing ANTES de publicar no ML.
 *
 * Diferente do `listing-seo-scanner.service.ts` (que opera em anúncios JÁ
 * publicados via `quality_snapshots`), esse serviço analisa o listing em
 * memória — todos os inputs vêm do `CreativeListing` + `CreativeProduct` +
 * count de imagens aprovadas (opcional, vindo do contexto da publish).
 *
 * Pesos seguem a mesma convenção do scanner: 40% título + 40% atributos +
 * 20% pictures. Description fora do scoring v1 (igual scanner).
 */

export type SeoIssueArea     = 'title' | 'attributes' | 'pictures' | 'description' | 'general'
export type SeoIssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface SeoIssue {
  code:        string
  area:        SeoIssueArea
  severity:    SeoIssueSeverity
  message:     string
  /** Hint curta sobre como corrigir. Frontend pode usar como tooltip ou tooltip. */
  fixHint?:    string
  /** Campo do listing que o user precisa editar. Frontend usa pra scroll/focus. */
  fixesField?: 'title' | 'subtitle' | 'description' | 'bullets' | 'attributes' | 'pictures'
}

export interface SeoScoreBreakdown {
  title:      number  // 0-100
  attributes: number  // 0-100
  pictures:   number  // 0-100
  /** Ponderado: 40/40/20. */
  structural: number  // 0-100
}

export interface CreativeListingSeoResult {
  listing_id:    string
  scores:        SeoScoreBreakdown
  issues:        SeoIssue[]
  /** Resumo curto pra UI compacta (badge no /publish/ml). */
  summary:       {
    score_label: 'excelente' | 'bom' | 'regular' | 'baixo' | 'crítico'
    critical_count: number
    high_count:     number
  }
  /** Snapshot dos inputs (útil pra UI mostrar contexto). */
  context: {
    title_length:           number
    has_brand_in_title:     boolean
    has_keyword_in_title:   boolean
    attributes_total:       number
    attributes_filled:      number
    attributes_missing:     string[]
    pictures_count:         number
  }
}

const CRITICAL_ATTR_IDS = new Set(['BRAND', 'MODEL', 'MATERIAL'])

@Injectable()
export class CreativeSeoService {
  private readonly logger = new Logger(CreativeSeoService.name)

  constructor(private readonly svc: CreativeService) {}

  /**
   * Computa o score SEO de um listing. Endpoint correspondente:
   * GET /creative/listings/:id/seo-score?images=N
   */
  async scoreListing(orgId: string, listingId: string, picturesCount: number | null): Promise<CreativeListingSeoResult> {
    const listing = await this.svc.getListing(orgId, listingId)
    const product = await this.svc.getProduct(orgId, listing.product_id)
    return this.compute(listing, product, picturesCount)
  }

  /** Pure function — exposta pra testes / reuso direto. */
  compute(
    listing:       CreativeListing,
    product:       CreativeProduct,
    picturesCount: number | null,
  ): CreativeListingSeoResult {
    const issues: SeoIssue[] = []

    // ── Title (40%) ─────────────────────────────────────────────────────────
    const title = (listing.title ?? '').trim()
    const titleLen = title.length

    let titleScore = 0
    if (titleLen >= 60) titleScore = 100
    else if (titleLen >= 40) titleScore = 70
    else if (titleLen >= 20) titleScore = 40
    else titleScore = 0

    if (titleLen < 20) {
      issues.push({
        code:       'TITLE_TOO_SHORT',
        area:       'title',
        severity:   'critical',
        message:    `Título muito curto (${titleLen} chars) — ML recomenda 60+`,
        fixHint:    'Inclua marca, modelo, principais características e diferenciais',
        fixesField: 'title',
      })
    } else if (titleLen < 40) {
      issues.push({
        code:       'TITLE_SHORT',
        area:       'title',
        severity:   'high',
        message:    `Título curto (${titleLen} chars) — ideal 60+ pra aproveitar limite do ML`,
        fixHint:    'Adicione mais palavras-chave relevantes',
        fixesField: 'title',
      })
    } else if (titleLen < 60) {
      issues.push({
        code:       'TITLE_OK_BUT_CAN_GROW',
        area:       'title',
        severity:   'low',
        message:    `Título com ${titleLen} chars — pode usar até 60`,
        fixesField: 'title',
      })
    }

    const brand = (product.brand ?? '').trim()
    const hasBrandInTitle = !!brand && title.toLowerCase().includes(brand.toLowerCase())
    if (brand && !hasBrandInTitle) {
      titleScore = Math.max(0, titleScore - 10)
      issues.push({
        code:       'TITLE_NO_BRAND',
        area:       'title',
        severity:   'high',
        message:    `A marca "${brand}" não aparece no título`,
        fixHint:    `Marcas ranqueiam: inclua "${brand}" no título`,
        fixesField: 'title',
      })
    } else if (hasBrandInTitle) {
      titleScore = Math.min(100, titleScore + 10)
    }

    // Pelo menos 1 keyword no título?
    const keywords = (listing.keywords ?? []).filter(k => k && k.length >= 3)
    const titleLower = title.toLowerCase()
    const hasKeywordInTitle = keywords.some(k => titleLower.includes(k.toLowerCase()))
    if (keywords.length > 0 && !hasKeywordInTitle) {
      titleScore = Math.max(0, titleScore - 5)
      issues.push({
        code:       'TITLE_NO_KEYWORD',
        area:       'title',
        severity:   'medium',
        message:    'Nenhuma keyword sugerida aparece no título',
        fixHint:    `Considere incluir: ${keywords.slice(0, 3).join(', ')}`,
        fixesField: 'title',
      })
    } else if (hasKeywordInTitle) {
      titleScore = Math.min(100, titleScore + 5)
    }

    // ── Attributes (40%) ────────────────────────────────────────────────────
    const suggested = listing.attributes_ml_suggested ?? []
    const filled = suggested.filter(a => !!(a.value_id || a.value_name))
    const total = suggested.length

    let attrScore = 50  // default neutro quando não temos sugestões
    let missingNames: string[] = []
    if (total > 0) {
      attrScore = Math.round((filled.length / total) * 100)
      missingNames = suggested
        .filter(a => !(a.value_id || a.value_name))
        .map(a => a.name)

      const missingCritical = suggested
        .filter(a => CRITICAL_ATTR_IDS.has(a.id))
        .filter(a => !(a.value_id || a.value_name))

      if (missingCritical.length > 0) {
        attrScore = Math.min(attrScore, 40)
        issues.push({
          code:       'ATTRS_MISSING_CRITICAL',
          area:       'attributes',
          severity:   'critical',
          message:    `Atributos críticos faltando: ${missingCritical.map(a => a.name).join(', ')}`,
          fixHint:    'ML penaliza exposure quando Marca/Modelo/Material faltam',
          fixesField: 'attributes',
        })
      }

      const otherMissing = missingNames.length - missingCritical.length
      if (otherMissing > 0) {
        issues.push({
          code:       'ATTRS_INCOMPLETE',
          area:       'attributes',
          severity:   otherMissing >= 3 ? 'high' : 'medium',
          message:    `${otherMissing} atributo${otherMissing > 1 ? 's' : ''} sugerido${otherMissing > 1 ? 's' : ''} sem valor`,
          fixHint:    'Cada atributo preenchido melhora ranqueamento e exposição',
          fixesField: 'attributes',
        })
      }
    } else {
      issues.push({
        code:       'ATTRS_NO_PREDICTION',
        area:       'attributes',
        severity:   'info',
        message:    'Categoria ML ainda não foi detectada — atributos sugeridos não disponíveis',
        fixHint:    'Refresh da categoria ML pode buscar os atributos automaticamente',
      })
    }

    // ── Pictures (20%) ──────────────────────────────────────────────────────
    let picsScore = 50  // default neutro se não passou count
    if (picturesCount !== null) {
      if (picturesCount === 0) {
        picsScore = 0
        issues.push({
          code:       'PICS_NONE',
          area:       'pictures',
          severity:   'critical',
          message:    'Nenhuma imagem aprovada — anúncio não pode ser publicado',
          fixesField: 'pictures',
        })
      } else if (picturesCount < 3) {
        picsScore = 30
        issues.push({
          code:       'PICS_FEW',
          area:       'pictures',
          severity:   'high',
          message:    `Poucas imagens (${picturesCount}/10) — ideal 6+ pra conversão`,
          fixHint:    'Gere mais imagens aprovadas no editor',
          fixesField: 'pictures',
        })
      } else if (picturesCount < 6) {
        picsScore = 65
        issues.push({
          code:       'PICS_OK',
          area:       'pictures',
          severity:   'low',
          message:    `${picturesCount}/10 imagens — pode adicionar mais até 10`,
          fixesField: 'pictures',
        })
      } else {
        picsScore = 100
      }
    }

    // ── Description (não scoreio, mas alerta se vazia) ──────────────────────
    const desc = (listing.description ?? '').trim()
    if (desc.length < 100) {
      issues.push({
        code:       'DESCRIPTION_TOO_SHORT',
        area:       'description',
        severity:   'medium',
        message:    `Descrição com ${desc.length} chars — recomendado 200+ pra conversão`,
        fixHint:    'Descrições ricas reduzem dúvidas e perguntas no ML',
        fixesField: 'description',
      })
    }

    // Bullets check (não entra no score mas alerta)
    const bullets = listing.bullets ?? []
    if (bullets.length < 3) {
      issues.push({
        code:       'BULLETS_FEW',
        area:       'description',
        severity:   'low',
        message:    `${bullets.length} bullet${bullets.length === 1 ? '' : 's'} — recomendado 5+`,
        fixHint:    'Bullets aparecem destacados no ML e ajudam scan rápido',
        fixesField: 'bullets',
      })
    }

    // ── Weighted: title 40% + attrs 40% + pics 20% ──────────────────────────
    const structural = Math.round(0.40 * titleScore + 0.40 * attrScore + 0.20 * picsScore)

    // ── Summary ─────────────────────────────────────────────────────────────
    const scoreLabel =
      structural >= 85 ? 'excelente' as const :
      structural >= 70 ? 'bom'       as const :
      structural >= 50 ? 'regular'   as const :
      structural >= 30 ? 'baixo'     as const :
                         'crítico'   as const
    const criticalCount = issues.filter(i => i.severity === 'critical').length
    const highCount     = issues.filter(i => i.severity === 'high').length

    return {
      listing_id: listing.id,
      scores: {
        title:      titleScore,
        attributes: attrScore,
        pictures:   picsScore,
        structural,
      },
      issues,
      summary: {
        score_label:    scoreLabel,
        critical_count: criticalCount,
        high_count:     highCount,
      },
      context: {
        title_length:         titleLen,
        has_brand_in_title:   hasBrandInTitle,
        has_keyword_in_title: hasKeywordInTitle,
        attributes_total:     total,
        attributes_filled:    filled.length,
        attributes_missing:   missingNames,
        pictures_count:       picturesCount ?? 0,
      },
    }
  }
}
