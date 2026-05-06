import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'

/** Onda 4 / A5 — Kits e Combos IA. */

export type KitType =
  | 'kit' | 'combo' | 'cross_sell' | 'upsell'
  | 'buy_together' | 'by_room' | 'by_occasion' | 'clearance'

export type KitStatus = 'suggested' | 'approved' | 'active' | 'paused' | 'archived'

export interface KitItem {
  product_id: string
  quantity:   number
  role:       'principal' | 'complementar' | 'acessório'
}

export interface ProductKit {
  id:                  string
  organization_id:     string
  name:                string
  slug:                string | null
  description:         string | null
  cover_image_url:     string | null
  kit_type:            KitType
  items:               KitItem[]
  original_total:      number
  kit_price:           number
  discount_pct:        number | null
  savings_amount:      number | null
  margin_pct:          number | null
  ai_generated:        boolean
  ai_reasoning:        string | null
  ai_confidence:       number | null
  generation_metadata: Record<string, unknown>
  status:              KitStatus
  views:               number
  sales:               number
  revenue:             number
  created_at:          string
  updated_at:          string
}

interface ProductForKitGen {
  id:         string
  name:       string
  category:   string | null
  price:      number
  cost_price: number | null
  stock:      number
  ai_score:   number | null
}

const SYSTEM_PROMPT = `Você é um especialista em merchandising para e-commerce brasileiro.

OBJETIVO: dado um catálogo de produtos, sugerir kits/combos comerciais
que maximizem ticket médio E margem combinada SEM canibalizar vendas
individuais.

REGRAS:
- Margem mínima do kit: 25%
- Desconto máximo: 20% do soma_individual
- Cada kit deve ter 2-5 produtos
- Priorizar complementaridade real (mesmo ambiente, mesmo uso)
- Kits "clearance" podem ter desconto até 30%
- Considerar estoque: preferir produtos com estoque alto
- Naming comercial atrativo (ex: "Kit Cozinha Organizada", não "Kit 3 produtos")
- NUNCA invente product_ids — use só os fornecidos
- Saída JSON puro sem markdown wrapper`

@Injectable()
export class KitsService {
  private readonly logger = new Logger(KitsService.name)

  constructor(private readonly llm: LlmService) {}

  // ─────────────────────────────────────────────────────────────────
  // GENERATE
  // ─────────────────────────────────────────────────────────────────

  async generate(orgId: string, opts: { count?: number; types?: KitType[]; product_ids?: string[] } = {}): Promise<{
    kits:     ProductKit[]
    cost_usd: number
  }> {
    const targetCount = Math.min(opts.count ?? 5, 10)

    // Pega produtos do catálogo (ai_score >= 50, stock > 0)
    let q = supabaseAdmin
      .from('products')
      .select('id, name, category, price, cost_price, stock, ai_score')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gte('ai_score', 50)
      .gt('stock', 0)
      .order('ai_score', { ascending: false })
      .limit(60)
    if (opts.product_ids?.length) q = q.in('id', opts.product_ids)

    const { data: products, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!products?.length) {
      throw new BadRequestException('Nenhum produto qualificado pra gerar kits (ai_score>=50 + stock>0)')
    }

    const userPrompt = `## CATÁLOGO DISPONÍVEL (${products.length} produtos)
${products.map(p => {
  const r = p as ProductForKitGen
  const margin = r.cost_price ? ((r.price - r.cost_price) / r.price * 100).toFixed(0) : '?'
  return `- ${r.id} | ${r.name} | R$${r.price} | margem ${margin}% | estoque ${r.stock} | score ${r.ai_score} | ${r.category ?? '-'}`
}).join('\n')}

## TIPOS SOLICITADOS
${(opts.types ?? ['kit','combo','by_room','by_occasion']).join(', ')}

## QUANTIDADE
Sugira ${targetCount} kits variados.

## SAÍDA — JSON PURO
{
  "kits": [
    {
      "name": "string comercial atrativo",
      "kit_type": "kit"|"combo"|"cross_sell"|"upsell"|"buy_together"|"by_room"|"by_occasion"|"clearance",
      "items": [
        { "product_id": "uuid_real_do_catalogo", "quantity": 1, "role": "principal"|"complementar"|"acessório" }
      ],
      "suggested_discount_pct": number_0_to_30,
      "reasoning": "porque esses produtos combinam (1-2 frases)",
      "target_audience": "para quem é esse kit",
      "confidence": 0.0_to_1.0
    }
  ]
}`

    const out = await this.llm.generateText({
      orgId,
      feature:     'kits_generate',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens:    2500,
      temperature:  0.5,
      jsonMode:     true,
    })

    let parsed: { kits?: Array<{
      name:                   string
      kit_type:               KitType
      items:                  KitItem[]
      suggested_discount_pct: number
      reasoning:              string
      target_audience?:       string
      confidence:             number
    }> }
    try { parsed = JSON.parse(out.text) }
    catch { throw new BadRequestException('IA retornou JSON inválido') }

    if (!parsed.kits?.length) {
      throw new BadRequestException('IA não retornou nenhum kit')
    }

    const productMap = new Map(products.map(p => [(p as ProductForKitGen).id, p as ProductForKitGen]))
    const inserted: ProductKit[] = []

    for (const k of parsed.kits) {
      // Valida items
      const validItems = (k.items ?? []).filter(i => productMap.has(i.product_id))
      if (validItems.length < 2) continue  // skip kit malformado

      const originalTotal = validItems.reduce((sum, i) => {
        const p = productMap.get(i.product_id)!
        return sum + (p.price * i.quantity)
      }, 0)
      const discountPct  = Math.min(Math.max(k.suggested_discount_pct ?? 10, 0), 30)
      const kitPrice     = Math.round(originalTotal * (1 - discountPct / 100) * 100) / 100
      const totalCost    = validItems.reduce((sum, i) => {
        const p = productMap.get(i.product_id)!
        return sum + ((p.cost_price ?? 0) * i.quantity)
      }, 0)
      const margin = kitPrice > 0 && totalCost > 0
        ? Math.round(((kitPrice - totalCost) / kitPrice) * 1000) / 10
        : null

      const { data, error } = await supabaseAdmin
        .from('product_kits')
        .insert({
          organization_id:  orgId,
          name:             k.name,
          slug:             k.name.toLowerCase()
                              .normalize('NFD').replace(/[̀-ͯ]/g, '')
                              .replace(/[^a-z0-9]+/g, '-')
                              .slice(0, 80),
          kit_type:         k.kit_type,
          items:            validItems,
          original_total:   Math.round(originalTotal * 100) / 100,
          kit_price:        kitPrice,
          discount_pct:     discountPct,
          savings_amount:   Math.round((originalTotal - kitPrice) * 100) / 100,
          margin_pct:       margin,
          ai_generated:     true,
          ai_reasoning:     k.reasoning,
          ai_confidence:    Math.min(Math.max(k.confidence ?? 0.7, 0), 1),
          generation_metadata: {
            target_audience: k.target_audience ?? null,
            cost_usd:        out.costUsd,
          },
          status: 'suggested',
        })
        .select('*')
        .maybeSingle()
      if (error) {
        this.logger.warn(`[kits] insert falhou: ${error.message}`)
        continue
      }
      if (data) inserted.push(data as ProductKit)
    }

    return { kits: inserted, cost_usd: out.costUsd }
  }

  // ─────────────────────────────────────────────────────────────────
  // CRUD + lifecycle
  // ─────────────────────────────────────────────────────────────────

  async list(orgId: string, opts: { status?: KitStatus; kit_type?: KitType; limit?: number } = {}): Promise<ProductKit[]> {
    const limit = Math.min(opts.limit ?? 100, 200)
    let q = supabaseAdmin
      .from('product_kits')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (opts.status)   q = q.eq('status',   opts.status)
    if (opts.kit_type) q = q.eq('kit_type', opts.kit_type)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as ProductKit[]
  }

  async get(id: string, orgId: string): Promise<ProductKit> {
    const { data, error } = await supabaseAdmin
      .from('product_kits')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Kit não encontrado')
    return data as ProductKit
  }

  async update(id: string, orgId: string, patch: Partial<ProductKit>): Promise<ProductKit> {
    const allowed: (keyof ProductKit)[] = [
      'name','description','cover_image_url','kit_type','items',
      'kit_price','discount_pct',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('nada pra atualizar')

    const { data, error } = await supabaseAdmin
      .from('product_kits').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as ProductKit
  }

  async approve(id: string, orgId: string): Promise<ProductKit> {
    return this.transition(id, orgId, 'approved', ['suggested'])
  }

  async activate(id: string, orgId: string): Promise<ProductKit> {
    return this.transition(id, orgId, 'active', ['suggested', 'approved', 'paused'])
  }

  async pause(id: string, orgId: string): Promise<ProductKit> {
    return this.transition(id, orgId, 'paused', ['active'])
  }

  async archive(id: string, orgId: string): Promise<ProductKit> {
    const { data, error } = await supabaseAdmin
      .from('product_kits').update({ status: 'archived' })
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as ProductKit
  }

  private async transition(id: string, orgId: string, to: KitStatus, fromAllowed: KitStatus[]): Promise<ProductKit> {
    const { data, error } = await supabaseAdmin
      .from('product_kits')
      .update({ status: to })
      .eq('id', id).eq('organization_id', orgId)
      .in('status', fromAllowed).select('*').maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new BadRequestException(`Transição inválida: '${to}' só de [${fromAllowed.join(',')}]`)
    return data as ProductKit
  }
}
