import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

/**
 * Cat-5 — Vínculos de categoria entre marketplaces.
 *
 * Mapeia a categoria canônica (ML) → categoria de destino (Meta/Shopee/...).
 * Vínculo por categoria; produtos herdam. NÃO toca em products/category_ml_id.
 *
 * Origem (ML) é resolvida em ml_categories; destino em marketplace_categories.
 */

export interface CategoryLink {
  id:                 string
  organization_id:    string
  source_marketplace: string
  source_category_id: string
  target_marketplace: string
  target_category_id: string
  target_path:        string | null
  status:             'confirmed' | 'suggested'
  created_at:         string
  updated_at:         string
}

export interface SourceCategory {
  id:        string                 // category_ml_id
  name:      string
  path:      string                 // breadcrumb
  products:  number
  links:     Record<string, { target_category_id: string; target_path: string | null; status: string }>
}

export interface TargetNode {
  id:        string
  name:      string
  full_path: string | null
  level:     number
  is_leaf:   boolean
}

function parseJsonLoose(text: string): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { return JSON.parse(fence[1]) } catch { /* continue */ } }
  const first = text.indexOf('{'); const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)) } catch { /* continue */ } }
  return null
}

const STOPWORDS = new Set(['e', 'de', 'da', 'do', 'das', 'dos', 'para', 'com', 'a', 'o', 'os', 'as', 'em', 'outros', 'outras', 'mais'])

@Injectable()
export class CategoryLinksService {
  private readonly logger = new Logger(CategoryLinksService.name)
  constructor(private readonly llm: LlmService) {}

  // ── Vínculos (CRUD) ──────────────────────────────────────────────────

  async list(orgId: string, targetMarketplace?: string): Promise<CategoryLink[]> {
    let q = supabaseAdmin.from('category_links').select('*').eq('organization_id', orgId)
    if (targetMarketplace) q = q.eq('target_marketplace', targetMarketplace)
    const { data, error } = await q.order('updated_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as unknown as CategoryLink[]
  }

  async upsert(orgId: string, input: {
    sourceCategoryId:   string
    sourceMarketplace?: string
    targetMarketplace:  string
    targetCategoryId:   string
    status?:            'confirmed' | 'suggested'
    createdBy?:         string
  }): Promise<CategoryLink> {
    const sourceMarketplace = input.sourceMarketplace ?? 'mercadolivre'
    if (!input.sourceCategoryId || !input.targetMarketplace || !input.targetCategoryId) {
      throw new BadRequestException('sourceCategoryId, targetMarketplace e targetCategoryId obrigatórios')
    }
    // resolve o caminho do destino pra exibição
    const target = await this.getTargetNode(input.targetMarketplace, input.targetCategoryId)
    const { data, error } = await supabaseAdmin
      .from('category_links')
      .upsert({
        organization_id:    orgId,
        source_marketplace: sourceMarketplace,
        source_category_id: input.sourceCategoryId,
        target_marketplace: input.targetMarketplace,
        target_category_id: input.targetCategoryId,
        target_path:        target?.full_path ?? null,
        status:             input.status ?? 'confirmed',
        created_by:         input.createdBy ?? null,
      }, { onConflict: 'organization_id,source_marketplace,source_category_id,target_marketplace' })
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar vínculo: ${error?.message ?? '?'}`)
    return data as unknown as CategoryLink
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('category_links').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Resolve a categoria de destino p/ a categoria de origem de um produto.
   *  Usado pelo publish de cada marketplace. NULL = sem vínculo ainda. */
  async resolveForProduct(orgId: string, sourceCategoryId: string, targetMarketplace: string, sourceMarketplace = 'mercadolivre'): Promise<CategoryLink | null> {
    if (!sourceCategoryId) return null
    const { data } = await supabaseAdmin.from('category_links').select('*')
      .eq('organization_id', orgId)
      .eq('source_marketplace', sourceMarketplace)
      .eq('source_category_id', sourceCategoryId)
      .eq('target_marketplace', targetMarketplace)
      .maybeSingle()
    return (data ?? null) as CategoryLink | null
  }

  // ── Origem: categorias ML que a org usa (pra mapear) ─────────────────

  /** Lista as categorias ML dos produtos da org (com contagem + nome/caminho
   *  resolvidos) e, pra cada uma, os vínculos já criados por marketplace. */
  async listSourceCategories(orgId: string): Promise<SourceCategory[]> {
    const { data: prods } = await supabaseAdmin
      .from('products')
      .select('category_ml_id')
      .eq('organization_id', orgId)
      .not('category_ml_id', 'is', null)
      .limit(20000)
    const counts = new Map<string, number>()
    for (const r of (prods ?? []) as Array<{ category_ml_id: string | null }>) {
      const id = (r.category_ml_id ?? '').trim()
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    if (counts.size === 0) return []
    const ids = [...counts.keys()]

    const { data: cats } = await supabaseAdmin
      .from('ml_categories').select('id, name, path_from_root').in('id', ids)
    const catMap = new Map<string, { name: string; path: string }>()
    for (const c of (cats ?? []) as Array<{ id: string; name: string; path_from_root: Array<{ name: string }> | null }>) {
      catMap.set(c.id, { name: c.name, path: (c.path_from_root ?? []).map(p => p.name).join(' > ') })
    }

    const { data: links } = await supabaseAdmin
      .from('category_links').select('source_category_id, target_marketplace, target_category_id, target_path, status')
      .eq('organization_id', orgId).eq('source_marketplace', 'mercadolivre')
    const linkMap = new Map<string, SourceCategory['links']>()
    for (const l of (links ?? []) as Array<{ source_category_id: string; target_marketplace: string; target_category_id: string; target_path: string | null; status: string }>) {
      const m = linkMap.get(l.source_category_id) ?? {}
      m[l.target_marketplace] = { target_category_id: l.target_category_id, target_path: l.target_path, status: l.status }
      linkMap.set(l.source_category_id, m)
    }

    return ids
      .map(id => ({
        id,
        name:     catMap.get(id)?.name ?? id,
        path:     catMap.get(id)?.path ?? '',
        products: counts.get(id) ?? 0,
        links:    linkMap.get(id) ?? {},
      }))
      .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name, 'pt-BR'))
  }

  // ── Destino: navegar/buscar a árvore do marketplace alvo ─────────────

  private async getTargetNode(marketplace: string, externalId: string): Promise<TargetNode | null> {
    const { data } = await supabaseAdmin
      .from('marketplace_categories')
      .select('external_id, name, full_path, level, is_leaf')
      .eq('marketplace', marketplace).eq('external_id', externalId).maybeSingle()
    if (!data) return null
    const d = data as { external_id: string; name: string; full_path: string | null; level: number; is_leaf: boolean }
    return { id: d.external_id, name: d.name, full_path: d.full_path, level: d.level, is_leaf: d.is_leaf }
  }

  /** Navega a árvore do marketplace alvo por nível (filhos de parentId; raízes se null). */
  async browseTarget(marketplace: string, parentId?: string | null): Promise<TargetNode[]> {
    let q = supabaseAdmin
      .from('marketplace_categories')
      .select('external_id, name, full_path, level, is_leaf')
      .eq('marketplace', marketplace)
    q = parentId ? q.eq('parent_id', parentId) : q.is('parent_id', null)
    const { data } = await q.order('name', { ascending: true }).limit(500)
    return ((data ?? []) as Array<{ external_id: string; name: string; full_path: string | null; level: number; is_leaf: boolean }>)
      .map(d => ({ id: d.external_id, name: d.name, full_path: d.full_path, level: d.level, is_leaf: d.is_leaf }))
  }

  /** Busca categorias do alvo por texto (nome/caminho). */
  async searchTarget(marketplace: string, query: string): Promise<TargetNode[]> {
    const q = (query ?? '').trim()
    if (q.length < 2) return []
    const { data } = await supabaseAdmin
      .from('marketplace_categories')
      .select('external_id, name, full_path, level, is_leaf')
      .eq('marketplace', marketplace)
      .ilike('full_path', `%${q}%`)
      .order('level', { ascending: true })
      .limit(40)
    return ((data ?? []) as Array<{ external_id: string; name: string; full_path: string | null; level: number; is_leaf: boolean }>)
      .map(d => ({ id: d.external_id, name: d.name, full_path: d.full_path, level: d.level, is_leaf: d.is_leaf }))
  }

  // ── Sugestão IA ──────────────────────────────────────────────────────

  /** Sugere a categoria do alvo que melhor casa com a categoria de origem (ML).
   *  Pré-filtra candidatos por palavras-chave (pra caber no prompt) e deixa o
   *  LLM escolher a melhor. Retorna null se não houver candidato. */
  async suggest(orgId: string, sourceCategoryId: string, targetMarketplace: string): Promise<{
    target_category_id: string
    target_path:        string | null
    confidence:         number
    reason:             string
  } | null> {
    // 1. origem (ML)
    const { data: src } = await supabaseAdmin
      .from('ml_categories').select('name, path_from_root').eq('id', sourceCategoryId).maybeSingle()
    if (!src) throw new BadRequestException('Categoria de origem não encontrada no espelho ML.')
    const s = src as { name: string; path_from_root: Array<{ name: string }> | null }
    const sourcePath = (s.path_from_root ?? []).map(p => p.name).join(' > ')

    // 2. candidatos do alvo por palavras-chave (nome + últimos 2 níveis do caminho)
    const tokens = [s.name, ...(s.path_from_root ?? []).slice(-2).map(p => p.name)]
      .join(' ')
      .toLowerCase()
      .split(/[^a-zà-ú0-9]+/i)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
    const uniqTokens = [...new Set(tokens)].slice(0, 6)

    const candidatesMap = new Map<string, TargetNode>()
    for (const tk of uniqTokens) {
      const { data } = await supabaseAdmin
        .from('marketplace_categories')
        .select('external_id, name, full_path, level, is_leaf')
        .eq('marketplace', targetMarketplace)
        .ilike('full_path', `%${tk}%`)
        .limit(25)
      for (const d of (data ?? []) as Array<{ external_id: string; name: string; full_path: string | null; level: number; is_leaf: boolean }>) {
        if (!candidatesMap.has(d.external_id)) {
          candidatesMap.set(d.external_id, { id: d.external_id, name: d.name, full_path: d.full_path, level: d.level, is_leaf: d.is_leaf })
        }
      }
    }
    const candidates = [...candidatesMap.values()].slice(0, 60)
    if (candidates.length === 0) return null

    // 3. LLM escolhe
    const systemPrompt = 'Você mapeia categorias de marketplace. Dada a categoria de ORIGEM e uma lista de categorias CANDIDATAS do marketplace de destino, escolha a que melhor representa o mesmo tipo de produto. Prefira a categoria mais específica (folha) que ainda seja correta. Responda só JSON: {"target_category_id":"<id>","confidence":0..1,"reason":"<curto>"}. Se nenhuma servir, {"target_category_id":null,...}.'
    const userPrompt = `ORIGEM (Mercado Livre): ${sourcePath || s.name}\n\nCANDIDATAS (${targetMarketplace}):\n${candidates.map(c => `- id=${c.id} ${c.is_leaf ? '[folha]' : ''} ${c.full_path ?? c.name}`).join('\n')}`

    let chosenId: string | null = null
    let confidence = 0
    let reason = ''
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'category_link_suggest',
        systemPrompt, userPrompt, maxTokens: 300, temperature: 0.2, jsonMode: true,
      })
      const parsed = parseJsonLoose(out.text) as { target_category_id?: string | null; confidence?: number; reason?: string } | null
      chosenId   = parsed?.target_category_id ?? null
      confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0
      reason     = parsed?.reason ?? ''
    } catch (e) {
      this.logger.warn(`[cat-link.suggest] LLM falhou: ${(e as Error).message}`)
    }
    if (!chosenId || !candidatesMap.has(chosenId)) {
      // fallback: melhor candidato folha por sobreposição de tokens
      const fallback = candidates.find(c => c.is_leaf) ?? candidates[0]
      if (!fallback) return null
      return { target_category_id: fallback.id, target_path: fallback.full_path, confidence: 0.3, reason: 'Heurística (LLM indisponível ou sem escolha válida)' }
    }
    const chosen = candidatesMap.get(chosenId)!
    return { target_category_id: chosen.id, target_path: chosen.full_path, confidence, reason }
  }
}
