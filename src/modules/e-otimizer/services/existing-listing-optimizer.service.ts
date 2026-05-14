/**
 * e-Otimizer IA MVP 4 — orquestrador de otimização de anúncios EXISTENTES.
 *
 * Fluxo de `analyze(mlbId)`:
 *   1. Fetch item via ML API
 *   2. Detect permissões (zonas 🟢🟡🔴)
 *   3. Roda research da categoria
 *   4. Calcula seo_score atual
 *   5. LLM gera sugestões respeitando permissões:
 *      - se title=locked → gera "clone_title" (não tenta aplicar)
 *      - se title=free  → gera title novo aplicável
 *      - description sempre gerada (raramente travada)
 *      - attributes: lista os faltantes + sugere valores baseados nos top
 *   6. Salva tudo em listing_optimizations
 *   7. Retorna o report
 *
 * Fluxo de `apply(optimizationId, fields)`:
 *   1. Read optimization record
 *   2. Validate fields are not locked (defesa em profundidade)
 *   3. PUT /items/{mlb_id} pros campos solicitados
 *   4. Atualiza optimization com applied_at + after_snapshot + ml_response
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { LlmService } from '../../ai/llm.service'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import { CategoryResearchService } from './category-research.service'
import {
  MlEditPermissionsService,
  type ListingPermissions, type MlItemForPermissions,
} from './ml-edit-permissions.service'
import type { CategoryResearch } from '../e-otimizer.types'

const ML_BASE = 'https://api.mercadolibre.com'

// ── Types ──────────────────────────────────────────────────────────────────

export interface OptimizationAnalysis {
  optimization_id: string  // PK do registro em listing_optimizations
  mlb_id:          string

  current: {
    title:           string
    description:     string
    sold_quantity:   number
    listing_type_id: string
    catalog_listing: boolean
    price:           number
    pictures_count:  number
    attributes:      Array<{ id: string; name: string; value_name: string | null }>
  }
  permissions: ListingPermissions

  seo_score: {
    current:   number
    breakdown: {
      title:        { score: number; issues: string[] }
      description:  { score: number; issues: string[] }
      attributes:   { score: number; missing_required: string[]; missing_recommended: string[] }
      pictures:     { score: number; issues: string[] }
    }
  }

  suggestions: {
    /** Quando title é editável. */
    title?:         { value: string; rationale: string }
    /** Quando title é locked — não tenta aplicar, só sugere pra clone. */
    clone_title?:   { value: string; rationale: string }
    description?:   { value: string; rationale: string }
    attributes?:    {
      missing_to_fill: Array<{ id: string; name: string; suggested_value: string; required: boolean }>
    }
  }

  research_summary: {
    category_ml_id:   string
    category_name:    string
    competitors_count: number
    top_keywords_count: number
  }
}

@Injectable()
export class ExistingListingOptimizerService {
  private readonly logger = new Logger(ExistingListingOptimizerService.name)

  constructor(
    private readonly llm:          LlmService,
    private readonly mercadolivre: MercadolivreService,
    private readonly permissions:  MlEditPermissionsService,
    private readonly research:     CategoryResearchService,
  ) {}

  /**
   * Analisa um anúncio existente e gera sugestões de otimização.
   * NÃO aplica nada — só gera report + salva em listing_optimizations.
   */
  async analyze(orgId: string, mlbId: string): Promise<OptimizationAnalysis> {
    // 1. Fetch + permissions
    const { item, permissions } = await this.permissions.fetchAndCheck(orgId, mlbId)

    // 2. Research da categoria
    const queryKeywords = item.title
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .split(/\s+/).filter(t => t.length >= 3).slice(0, 5).join(' ')

    let researchData: CategoryResearch | null = null
    try {
      researchData = await this.research.research({
        orgId,
        categoryId: item.category_id,
        query:      queryKeywords,
        userKeywords: item.title.split(/\s+/).map(t => t.toLowerCase()).filter(Boolean),
      })
    } catch (e) {
      this.logger.warn(`[analyze] research falhou: ${(e as Error).message}`)
    }

    // 3. Calcula SEO score atual
    const seoScore = this.computeSeoScore(item, researchData)

    // 4. LLM gera sugestões respeitando permissões
    const suggestions = await this.generateSuggestions(orgId, item, permissions, researchData, seoScore)

    // 5. Salva em listing_optimizations
    const { data, error } = await supabaseAdmin
      .from('listing_optimizations')
      .insert({
        organization_id:  orgId,
        mlb_id:           item.id,
        category_ml_id:   item.category_id,
        before_snapshot: {
          title:           item.title,
          description:     item.description ?? '',
          sold_quantity:   item.sold_quantity,
          listing_type_id: item.listing_type_id,
          catalog_listing: item.catalog_listing,
          price:           item.price,
          pictures_count:  item.pictures.length,
          attributes:      item.attributes.map(a => ({ id: a.id, name: a.name, value_name: a.value_name ?? null })),
        },
        permissions,
        seo_score_before: seoScore.current,
        suggestions,
        research_payload: researchData
          ? {
              category_ml_id:    researchData.category_ml_id,
              category_name:     researchData.category_name,
              top_keywords:      researchData.top_keywords.slice(0, 20),
              competitors_count: researchData.candidates_used,
              avg_title_length:  researchData.title_pattern.avg_length,
              price_median:      researchData.price_stats.median,
            }
          : null,
      })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`analyze.insert: ${error.message}`)

    return {
      optimization_id: (data as { id: string }).id,
      mlb_id:          item.id,
      current: {
        title:           item.title,
        description:     item.description ?? '',
        sold_quantity:   item.sold_quantity,
        listing_type_id: item.listing_type_id,
        catalog_listing: item.catalog_listing,
        price:           item.price,
        pictures_count:  item.pictures.length,
        attributes:      item.attributes.map(a => ({ id: a.id, name: a.name, value_name: a.value_name ?? null })),
      },
      permissions,
      seo_score: seoScore,
      suggestions,
      research_summary: researchData
        ? {
            category_ml_id:     researchData.category_ml_id,
            category_name:      researchData.category_name,
            competitors_count:  researchData.candidates_used,
            top_keywords_count: researchData.top_keywords.length,
          }
        : { category_ml_id: item.category_id, category_name: '', competitors_count: 0, top_keywords_count: 0 },
    }
  }

  /**
   * Aplica as sugestões selecionadas no anúncio via PUT /items/{id}.
   * Defesa em profundidade: valida permissões antes do PUT mesmo o frontend
   * tendo bloqueado.
   */
  async apply(orgId: string, optimizationId: string, args: {
    apply_title?:       boolean
    apply_description?: boolean
    apply_attributes?:  boolean
    /** Permite user editar a sugestão antes de aplicar. */
    custom_title?:       string
    custom_description?: string
    custom_attributes?:  Array<{ id: string; value_name: string }>
  }): Promise<{
    success:        boolean
    applied_fields: string[]
    after_snapshot: Record<string, unknown>
    ml_response:    Record<string, unknown>
  }> {
    // 1. Read optimization
    const { data: opt, error } = await supabaseAdmin
      .from('listing_optimizations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', optimizationId)
      .maybeSingle()
    if (error || !opt) throw new NotFoundException('Otimização não encontrada')
    const o = opt as Record<string, unknown>
    const permissions = o.permissions as ListingPermissions
    const mlbId = o.mlb_id as string

    // 2. Valida permissões (defesa em profundidade)
    const updateBody: Record<string, unknown> = {}
    const appliedFields: string[] = []

    const suggestions = o.suggestions as OptimizationAnalysis['suggestions']

    if (args.apply_title) {
      if (permissions.title === 'locked') {
        throw new BadRequestException('Título travado pelo ML — não pode ser aplicado. Use a sugestão de clone pra criar anúncio novo.')
      }
      const newTitle = args.custom_title ?? suggestions.title?.value
      if (newTitle) {
        updateBody.title = newTitle
        appliedFields.push('title')
      }
    }

    if (args.apply_description) {
      if (permissions.description === 'locked') {
        throw new BadRequestException('Descrição travada (anúncio de catálogo).')
      }
      // Description é endpoint separado no ML — ver passo 4
    }

    if (args.apply_attributes) {
      const attrsToApply = args.custom_attributes ?? suggestions.attributes?.missing_to_fill
        .filter(a => !permissions.attributes_locked_keys.includes(a.id))
        .map(a => ({ id: a.id, value_name: a.suggested_value })) ?? []
      if (attrsToApply.length > 0) {
        updateBody.attributes = attrsToApply.map(a => ({ id: a.id, value_name: a.value_name }))
        appliedFields.push('attributes')
      }
    }

    // 3. PUT /items/{mlbId} (title + attributes)
    const { token } = await this.mercadolivre.getTokenForOrg(orgId)
    let mlResponse: Record<string, unknown> = {}

    if (Object.keys(updateBody).length > 0) {
      try {
        const { data } = await axios.put<Record<string, unknown>>(
          `${ML_BASE}/items/${mlbId}`, updateBody,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20_000 },
        )
        mlResponse.item_update = data
      } catch (e: unknown) {
        if (axios.isAxiosError(e)) {
          const errData = e.response?.data ?? { message: e.message }
          throw new BadRequestException(`ML rejeitou update: ${JSON.stringify(errData)}`)
        }
        throw e
      }
    }

    // 4. PUT description em endpoint separado
    if (args.apply_description) {
      const newDesc = args.custom_description ?? suggestions.description?.value
      if (newDesc) {
        try {
          const { data } = await axios.put<Record<string, unknown>>(
            `${ML_BASE}/items/${mlbId}/description`,
            { plain_text: newDesc },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20_000 },
          )
          mlResponse.description_update = data
          appliedFields.push('description')
        } catch (e: unknown) {
          if (axios.isAxiosError(e)) {
            const errData = e.response?.data ?? { message: e.message }
            mlResponse.description_error = errData
            // Não throw — permite que outros campos sigam aplicados
            this.logger.warn(`[apply] description falhou: ${JSON.stringify(errData)}`)
          }
        }
      }
    }

    // 5. Re-fetch pra after_snapshot
    const { item: itemAfter } = await this.permissions.fetchAndCheck(orgId, mlbId)
    const afterSnapshot = {
      title:           itemAfter.title,
      description:     itemAfter.description ?? '',
      attributes:      itemAfter.attributes.map(a => ({ id: a.id, name: a.name, value_name: a.value_name ?? null })),
    }

    // 6. Update optimization record
    await supabaseAdmin
      .from('listing_optimizations')
      .update({
        applied_at:     new Date().toISOString(),
        applied_fields: appliedFields,
        after_snapshot: afterSnapshot,
        ml_response:    mlResponse,
        updated_at:     new Date().toISOString(),
        // métricas T0 (visits/sold do momento de aplicar — feedback loop futuro)
        metrics_t0: {
          sold_quantity: itemAfter.sold_quantity,
          captured_at:   new Date().toISOString(),
        },
      })
      .eq('id', optimizationId)

    this.logger.log(`[apply] mlb=${mlbId} fields=[${appliedFields.join(',')}]`)

    return {
      success: true,
      applied_fields: appliedFields,
      after_snapshot: afterSnapshot,
      ml_response: mlResponse,
    }
  }

  /**
   * Lista histórico de otimizações da org (pra UI de tracking).
   */
  async listHistory(orgId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { data } = await supabaseAdmin
      .from('listing_optimizations')
      .select('id, mlb_id, seo_score_before, seo_score_after, applied_at, applied_fields, before_snapshot, after_snapshot, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    return (data ?? []) as Array<Record<string, unknown>>
  }

  // ── SEO Score ──────────────────────────────────────────────────────────

  private computeSeoScore(
    item: MlItemForPermissions,
    research: CategoryResearch | null,
  ): OptimizationAnalysis['seo_score'] {
    const breakdown = {
      title:       this.scoreTitle(item, research),
      description: this.scoreDescription(item),
      attributes:  this.scoreAttributes(item, research),
      pictures:    this.scorePictures(item),
    }
    // Pesos: title 30%, desc 25%, attrs 25%, pics 20%
    const current = Math.round(
      0.30 * breakdown.title.score
    + 0.25 * breakdown.description.score
    + 0.25 * breakdown.attributes.score
    + 0.20 * breakdown.pictures.score,
    )
    return { current, breakdown }
  }

  private scoreTitle(item: MlItemForPermissions, research: CategoryResearch | null): { score: number; issues: string[] } {
    const issues: string[] = []
    let score = 50
    const len = item.title.length

    if (len < 30) { issues.push(`Título muito curto (${len}/60 chars)`); score -= 20 }
    else if (len > 60) { issues.push(`Título excede 60 chars (${len})`); score -= 30 }
    else if (len >= 50 && len <= 60) { score += 20 }
    else if (len >= 40) { score += 10 }

    if (research?.top_keywords) {
      const titleLower = item.title.toLowerCase()
      const importantKws = research.top_keywords
        .filter(k => k.recommend === 'use')
        .slice(0, 5)
      const present = importantKws.filter(k => titleLower.includes(k.keyword.toLowerCase()))
      const missing = importantKws.filter(k => !titleLower.includes(k.keyword.toLowerCase()))
      score += (present.length / Math.max(importantKws.length, 1)) * 30
      if (missing.length > 0) {
        issues.push(`Faltam keywords fortes: ${missing.map(k => k.keyword).join(', ')}`)
      }
    }
    return { score: Math.max(0, Math.min(100, Math.round(score))), issues }
  }

  private scoreDescription(item: MlItemForPermissions): { score: number; issues: string[] } {
    const issues: string[] = []
    let score = 50
    const len = (item.description ?? '').length
    if (len < 200) { issues.push(`Descrição muito curta (${len} chars)`); score -= 30 }
    else if (len >= 500 && len <= 2000) { score += 30 }
    else if (len > 2000) { issues.push(`Descrição muito longa (${len} chars) — corte`); score -= 10 }

    // Estrutura: bullets, parágrafos, listas
    const hasLineBreaks = (item.description ?? '').split('\n').length >= 4
    if (hasLineBreaks) score += 15
    else issues.push('Descrição sem estrutura — adicione quebras de linha e bullets')

    return { score: Math.max(0, Math.min(100, Math.round(score))), issues }
  }

  private scoreAttributes(item: MlItemForPermissions, research: CategoryResearch | null): {
    score: number; missing_required: string[]; missing_recommended: string[]
  } {
    const filled = new Set(
      item.attributes.filter(a => a.value_name && a.value_name.trim() && a.value_name !== 'Não especificado').map(a => a.id),
    )
    const requiredAttrs = research?.attributes_stats.filter(a => a.is_required) ?? []
    const recommendedAttrs = research?.attributes_stats.filter(a => !a.is_required && a.fill_rate >= 0.5) ?? []

    const missingRequired = requiredAttrs.filter(a => !filled.has(a.attribute_id)).map(a => a.attribute_name)
    const missingRecommended = recommendedAttrs.filter(a => !filled.has(a.attribute_id)).map(a => a.attribute_name)

    let score = 50
    if (requiredAttrs.length > 0) {
      const requiredFilled = requiredAttrs.filter(a => filled.has(a.attribute_id)).length
      score += (requiredFilled / requiredAttrs.length) * 30
    } else {
      score += 20  // sem requirement = neutro
    }
    if (recommendedAttrs.length > 0) {
      const recommendedFilled = recommendedAttrs.filter(a => filled.has(a.attribute_id)).length
      score += (recommendedFilled / recommendedAttrs.length) * 20
    } else {
      score += 10
    }
    return { score: Math.max(0, Math.min(100, Math.round(score))), missing_required: missingRequired, missing_recommended: missingRecommended }
  }

  private scorePictures(item: MlItemForPermissions): { score: number; issues: string[] } {
    const issues: string[] = []
    const n = item.pictures.length
    let score = 50
    if (n === 0)      { issues.push('Sem imagens'); score = 0 }
    else if (n < 3)   { issues.push(`Poucas imagens (${n}/10 ideal: 6+)`); score = 30 }
    else if (n < 6)   { issues.push(`Pode adicionar mais (${n}/10 ideal: 6+)`); score = 60 }
    else              { score = 100 }
    return { score, issues }
  }

  // ── LLM suggestions ────────────────────────────────────────────────────

  private async generateSuggestions(
    orgId: string,
    item: MlItemForPermissions,
    permissions: ListingPermissions,
    research: CategoryResearch | null,
    seoScore: OptimizationAnalysis['seo_score'],
  ): Promise<OptimizationAnalysis['suggestions']> {
    const suggestions: OptimizationAnalysis['suggestions'] = {}

    // Atributos faltantes não precisam de LLM — usa top_values do research
    if (research && (seoScore.breakdown.attributes.missing_required.length > 0 || seoScore.breakdown.attributes.missing_recommended.length > 0)) {
      const filledIds = new Set(item.attributes.filter(a => a.value_name).map(a => a.id))
      const missing = research.attributes_stats
        .filter(a => !filledIds.has(a.attribute_id))
        .filter(a => a.is_required || a.fill_rate >= 0.5)
        .slice(0, 10)
      suggestions.attributes = {
        missing_to_fill: missing.map(a => ({
          id:              a.attribute_id,
          name:            a.attribute_name,
          suggested_value: a.top_values[0]?.value ?? '',
          required:        a.is_required,
        })),
      }
    }

    // Title + description via LLM
    const prompt = this.buildOptimizerPrompt(item, permissions, research, seoScore)
    try {
      const out = await this.llm.generateText({
        orgId,
        feature:    'creative_listing',
        userPrompt: prompt,
        jsonMode:   true,
        maxTokens:  2000,
      })
      const parsed = this.parseLlmJson(out.text)
      if (parsed) {
        if (permissions.title === 'locked' && parsed.clone_title) {
          suggestions.clone_title = {
            value:     parsed.clone_title,
            rationale: parsed.title_rationale ?? 'Sugestão pra criar anúncio novo (atual está travado pelo ML).',
          }
        } else if (permissions.title !== 'locked' && parsed.title) {
          suggestions.title = {
            value:     parsed.title,
            rationale: parsed.title_rationale ?? 'Otimizado seguindo padrão dos top concorrentes.',
          }
        }
        if (parsed.description && permissions.description !== 'locked') {
          suggestions.description = {
            value:     parsed.description,
            rationale: parsed.description_rationale ?? 'Descrição estruturada com keywords de mercado.',
          }
        }
      }
    } catch (e) {
      this.logger.warn(`[suggestions] LLM falhou: ${(e as Error).message}`)
    }

    return suggestions
  }

  private buildOptimizerPrompt(
    item: MlItemForPermissions,
    permissions: ListingPermissions,
    research: CategoryResearch | null,
    seoScore: OptimizationAnalysis['seo_score'],
  ): string {
    const topKw = research?.top_keywords.slice(0, 15) ?? []
    const top5 = research?.competitors_analyzed.slice(0, 5) ?? []

    return `Você é um copywriter especialista em otimização SEO de anúncios Mercado Livre.

## ANÚNCIO ATUAL
Título:      "${item.title}" (${item.title.length} chars)
Preço:       R$ ${item.price.toFixed(2)}
Vendas:      ${item.sold_quantity}
Tipo:        ${item.listing_type_id}
Catálogo:    ${item.catalog_listing ? 'sim' : 'não'}
Descrição:   ${(item.description ?? '').slice(0, 500)}${(item.description ?? '').length > 500 ? '...' : ''}

## SCORE SEO ATUAL: ${seoScore.current}/100
- Título: ${seoScore.breakdown.title.score}/100 — Issues: ${seoScore.breakdown.title.issues.join('; ') || 'OK'}
- Descrição: ${seoScore.breakdown.description.score}/100 — Issues: ${seoScore.breakdown.description.issues.join('; ') || 'OK'}

## PERMISSÕES DE EDIÇÃO (ML)
- Título: ${permissions.title}${permissions.title === 'locked' ? ' → vou gerar "clone_title" pra clonar em anúncio novo' : ''}
- Descrição: ${permissions.description}
${permissions.rationale.map(r => `- ${r}`).join('\n')}
${research ? `
## ANÁLISE DE MERCADO — TOP 20 CONCORRENTES

Top 5 títulos:
${top5.map((c, i) => `${i + 1}. "${c.title}" — R$ ${c.price.toFixed(2)} · ${c.sold_quantity} vendas`).join('\n')}

Keywords frequentes (use as marcadas "use" se forem verdadeiras pro produto):
${topKw.map(k => `- "${k.keyword}" — ${k.frequency}/20 → ${k.recommend.toUpperCase()}`).join('\n')}

Tamanho médio título: ${research.title_pattern.avg_length} chars
Preço mediano: R$ ${research.price_stats.median.toFixed(2)}
` : ''}

## REGRAS DURAS (NÃO NEGOCIÁVEIS)
1. NUNCA inventar potência, voltagem, watts, dimensões, cor ou material que não estão no anúncio
2. NUNCA mudar marca, modelo
3. NUNCA prometer recursos inexistentes
4. NUNCA copiar título exato de concorrente
5. Mantenha identidade do produto

## SUA TAREFA
${permissions.title === 'locked'
  ? `Título travado pelo ML. Gere um "clone_title" que o user vai usar pra CRIAR UM NOVO anúncio igual mas otimizado. Esse clone_title pode mudar livremente.`
  : `Título é editável. Gere um título otimizado de 50-60 chars usando as keywords frequentes do top que façam sentido pro produto.`}
${permissions.description !== 'locked' ? `\nGere também uma descrição nova, estruturada (parágrafos curtos + bullets), 500-2000 chars, usando keywords de mercado.` : ''}

Retorne APENAS um JSON válido:
{
  ${permissions.title === 'locked' ? '"clone_title": "novo título pra clone",' : '"title": "título otimizado",'}
  "title_rationale": "1 frase explicando por que esse título funciona",
  ${permissions.description !== 'locked' ? '"description": "descrição completa otimizada",\n  "description_rationale": "1 frase explicando a estrutura"' : ''}
}`
  }

  private parseLlmJson(text: string): Record<string, string> | null {
    try {
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
      return JSON.parse(cleaned)
    } catch {
      return null
    }
  }
}
