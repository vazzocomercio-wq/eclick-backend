import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { ProductsService } from '../products/products.service'
import { StockService } from '../stock/stock.service'
import { ProductionService } from './production.service'
import { ProductOsActiveService } from './product-os-active.service'

/**
 * Product OS — Fase 1.
 *
 * Central de criação de produtos físicos: ideia → briefing IA → versões
 * CAD/protótipo → custo de fabricação → (Fase 3) anúncio. Mora no SaaS e
 * reusa catálogo/estoque/IA; o Active entra só na Fase 3 (despacho).
 */

export type ProductDevStatus =
  | 'ideia' | 'briefing' | 'modelagem' | 'prototipo'
  | 'aprovado' | 'publicado' | 'monitorando' | 'arquivado'

export type ProductionProfile = 'impressao_3d' | 'marca_propria' | 'generico'

export interface ReferenceImage {
  url:        string
  source_url?: string | null
  notes?:      string | null
}

export interface ProductDev {
  id:                  string
  organization_id:     string
  name:                string
  category:            string | null
  description:         string | null
  status:              ProductDevStatus
  production_profile:  ProductionProfile
  reference_images:    ReferenceImage[]
  inspiration_url:     string | null
  briefing:            Record<string, unknown> | null
  briefing_text:       string | null
  target_marketplaces: string[]
  target_price:        number | null
  estimated_cost:      number | null
  product_id:          string | null
  active_deal_id:      string | null
  position:            number
  created_by:          string | null
  created_at:          string
  updated_at:          string
}

export interface ProductDevVersion {
  id:                   string
  organization_id:      string
  product_dev_id:       string
  version_number:       number
  changelog:            string | null
  file_url:             string | null
  file_type:            string | null
  material:             string | null
  weight_g:             number | null
  print_time_minutes:   number | null
  volume_cm3:           number | null
  prototype_photo_urls: string[]
  status:               'rascunho' | 'impressao' | 'aprovado' | 'reprovado'
  approved:             boolean
  notes:                string | null
  created_by:           string | null
  created_at:           string
}

export interface ProductionSettings {
  id:                   string
  organization_id:      string
  filament_cost_per_kg: Record<string, number>
  energy_cost_per_hour: number
  labor_cost_per_hour:  number
  packaging_cost:       number
  default_waste_pct:    number
  machines:             Array<{ name: string; model?: string; bed_mm?: number[] }>
  updated_at:           string
}

/** Taxa "all-in" estimada por canal (comissão + frete + taxas), com base na
 *  auditoria de faturas reais da Vazzo. É um DEFAULT — quando o módulo
 *  financeiro expõe a taxa real por org, trocar por aquela. Escala 0–100. */
const CHANNEL_ALLIN_FEE_PCT: Record<string, number> = {
  mercado_livre: 24.5,
  shopee:        31.6,
  tiktok:        8,
  loja:          0,
}

@Injectable()
export class ProductOsService {
  private readonly logger = new Logger(ProductOsService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly products: ProductsService,
    private readonly stock: StockService,
    private readonly production: ProductionService,
    private readonly active: ProductOsActiveService,
  ) {}

  /** Insere um evento na timeline do produto (best-effort, nunca lança). */
  private async emitEvent(orgId: string, devId: string, type: string, payload: Record<string, unknown> = {}, userId?: string | null, isAuto = false): Promise<void> {
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: devId, event_type: type, payload, actor_id: userId ?? null, is_auto: isAuto,
    }).then(() => {}, () => {})
  }

  async listEvents(devId: string, orgId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_event').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId)
      .order('created_at', { ascending: false }).limit(100)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Extrai peso(g), tempo(min) e material do resumo/G-code do slicer
   *  (Bambu Studio, OrcaSlicer, PrusaSlicer, Cura). Parser tolerante. */
  parseSlicer(text: string): { weight_g: number | null; print_time_minutes: number | null; material: string | null } {
    const t = (text ?? '').slice(0, 20000)
    // normaliza número aceitando decimal US (145.2) e BR (145,2 / 1.234,56)
    const num = (raw: string): number => {
      const s = raw.trim()
      const hasDot = s.includes('.'), hasComma = s.includes(',')
      let norm: string
      if (hasDot && hasComma) norm = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
      else if (hasComma) norm = s.replace(',', '.')
      else norm = s
      const n = Number(norm)
      return Number.isFinite(n) ? n : 0
    }

    // ── tempo ──
    let minutes: number | null = null
    // HH:MM:SS
    const hms = t.match(/(\d{1,2}):(\d{2}):(\d{2})/)
    if (hms) minutes = Number(hms[1]) * 60 + Number(hms[2]) + Math.round(Number(hms[3]) / 60)
    if (minutes == null) {
      // procura uma linha que fale de "time" e tenha h/m
      const timeLine = t.split(/\r?\n/).find(l => /time/i.test(l) && /\d+\s*[hm]/i.test(l)) ?? t
      const h = timeLine.match(/(\d+)\s*h/i); const m = timeLine.match(/(\d+)\s*m(?:in)?/i); const sec = timeLine.match(/(\d+)\s*s\b/i)
      if (h || m) minutes = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) + (sec ? Math.round(Number(sec[1]) / 60) : 0)
    }
    if (minutes == null) { const mn = t.match(/([\d.]+)\s*min\b/i); if (mn) minutes = Math.round(Number(mn[1])) }

    // ── peso (g) ──
    let grams: number | null = null
    const wPatterns = [
      /filament[^=:\n]*weight[^=:\n]*[=:]\s*([\d.,]+)/i,
      /(?:total\s+)?filament\s+used\s*\[g\]\s*[=:]\s*([\d.,]+)/i,
      /(?:total\s+)?filament[^=:\n]*[=:]\s*([\d.,]+)\s*g\b/i,
      /total\s+filament\s*[:=]\s*([\d.,]+)\s*g/i,
      /([\d.,]+)\s*g\b(?=[^\n]*filament)/i,
    ]
    for (const re of wPatterns) { const mm = t.match(re); if (mm) { grams = num(mm[1]); break } }
    if (grams == null) { const g = t.match(/([\d.,]+)\s*g(?:rams?)?\b/i); if (g) grams = num(g[1]) }

    // ── material ──
    const mat = t.match(/\b(PLA|PETG|ABS|TPU|ASA|PC|Nylon|PA)\b/i)

    return {
      weight_g: grams != null && grams > 0 ? Math.round(grams * 100) / 100 : null,
      print_time_minutes: minutes != null && minutes > 0 ? minutes : null,
      material: mat ? mat[1].toUpperCase() : null,
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // product_dev — CRUD + kanban
  // ─────────────────────────────────────────────────────────────────

  async list(orgId: string, opts: { status?: ProductDevStatus } = {}): Promise<ProductDev[]> {
    let q = supabaseAdmin
      .from('product_dev')
      .select('*')
      .eq('organization_id', orgId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro ao listar: ${error.message}`)
    return (data ?? []) as ProductDev[]
  }

  async get(id: string, orgId: string): Promise<ProductDev & { versions: ProductDevVersion[] }> {
    const { data, error } = await supabaseAdmin
      .from('product_dev').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    const versions = await this.listVersions(id, orgId)
    return { ...(data as ProductDev), versions }
  }

  async create(orgId: string, userId: string | null, body: {
    name: string
    category?: string
    description?: string
    production_profile?: ProductionProfile
    inspiration_url?: string
    reference_images?: ReferenceImage[]
    target_marketplaces?: string[]
    target_price?: number
  }): Promise<ProductDev> {
    if (!body.name?.trim()) throw new BadRequestException('Nome é obrigatório')
    const { data, error } = await supabaseAdmin
      .from('product_dev')
      .insert({
        organization_id:     orgId,
        name:                body.name.trim(),
        category:            body.category ?? null,
        description:         body.description ?? null,
        production_profile:  body.production_profile ?? 'impressao_3d',
        inspiration_url:     body.inspiration_url ?? null,
        reference_images:    body.reference_images ?? [],
        target_marketplaces: body.target_marketplaces ?? [],
        target_price:        body.target_price ?? null,
        status:              'ideia',
        created_by:          userId,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar: ${error?.message ?? 'sem dados'}`)
    const created = data as ProductDev
    await this.emitEvent(orgId, created.id, 'created', { name: created.name, production_profile: created.production_profile }, userId)
    return created
  }

  async update(id: string, orgId: string, patch: Partial<ProductDev>): Promise<ProductDev> {
    const allowed: (keyof ProductDev)[] = [
      'name', 'category', 'description', 'production_profile',
      'inspiration_url', 'reference_images', 'target_marketplaces',
      'target_price', 'estimated_cost',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin
      .from('product_dev').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as ProductDev
  }

  /** Move o card no kanban: muda status e/ou reordena dentro da coluna. */
  async move(id: string, orgId: string, body: { status?: ProductDevStatus; position?: number }): Promise<ProductDev> {
    const safe: Record<string, unknown> = {}
    if (body.status)              safe.status   = body.status
    if (typeof body.position === 'number') safe.position = body.position
    if (Object.keys(safe).length === 0) throw new BadRequestException('Informe status ou position')
    const { data, error } = await supabaseAdmin
      .from('product_dev').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    const moved = data as ProductDev
    if (body.status) {
      await this.emitEvent(orgId, id, 'status_changed', { to: body.status })
      // reflete no card do Active (best-effort, não bloqueia)
      void this.active.reflectStatus(orgId, id).catch(() => {})
    }
    return moved
  }

  async archive(id: string, orgId: string): Promise<ProductDev> {
    const { data, error } = await supabaseAdmin
      .from('product_dev').update({ status: 'arquivado' })
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    await this.emitEvent(orgId, id, 'archived')
    return data as ProductDev
  }

  /**
   * Fase 3 — "aprovado → virar anúncio". Cria um SKU real em `products` a
   * partir do product_dev, vincula, semeia estoque das unidades produzidas e
   * (opcional) publica na loja. Reusa ProductsService p/ taxa+vitrine e
   * StockService p/ o estoque. Idempotente (se já tem product_id, no-op).
   */
  async publishToCatalog(id: string, orgId: string, userId: string | null, body: { produced_quantity?: number; target_margin_pct?: number } = {}): Promise<{
    product_id: string; price: number | null; cost_price: number | null; photos: number; stock_seeded: number; storefront: boolean; already?: boolean
  }> {
    const pd = await this.get(id, orgId)
    if (pd.product_id) return { product_id: pd.product_id, price: null, cost_price: pd.estimated_cost, photos: 0, stock_seeded: 0, storefront: false, already: true }
    if (pd.status !== 'aprovado') throw new BadRequestException('Só produtos aprovados podem virar anúncio. Aprove uma versão primeiro.')

    // gate de qualidade
    const qualityOk = await this.production.isQualityPassed(orgId, id, pd.production_profile)
    if (!qualityOk) throw new BadRequestException('Conclua o checklist de qualidade (aprovado) antes de publicar.')

    // fotos: protótipo aprovado > referências
    const approvedV = pd.versions.find(v => v.approved)
    const photos = (approvedV?.prototype_photo_urls?.length ? approvedV.prototype_photo_urls : (pd.reference_images ?? []).map(r => r.url)).filter(Boolean)

    // preço: target_price > sugerido do canal primário
    let price = pd.target_price ?? null
    if (price == null) {
      const primary = (pd.target_marketplaces ?? [])[0] ?? 'mercado_livre'
      try {
        const c = await this.computeCost(id, orgId, { target_margin_pct: body.target_margin_pct })
        price = c.suggested_prices.find(s => s.channel === primary)?.price ?? c.suggested_prices[0]?.price ?? null
      } catch { /* segue sem preço */ }
    }

    const tax = await this.products.getTaxConfig(orgId).catch(() => ({ default_tax_percentage: null, default_tax_on_freight: false }))

    const { data: created, error } = await supabaseAdmin.from('products').insert({
      organization_id: orgId,
      name: pd.name,
      category: pd.category,
      description: pd.description,
      photo_urls: photos,
      cost_price: pd.estimated_cost,
      price,
      tax_percentage: tax.default_tax_percentage,
      tax_on_freight: tax.default_tax_on_freight,
      status: 'draft',
      condition: 'new',
    }).select('id').maybeSingle()
    if (error || !created) throw new BadRequestException(`Erro ao criar produto no catálogo: ${error?.message ?? 'sem dados'}`)
    const productId = (created as { id: string }).id

    await supabaseAdmin.from('product_dev').update({ product_id: productId, status: 'publicado' }).eq('id', id).eq('organization_id', orgId)

    // semeia estoque das unidades já produzidas
    let stockSeeded = 0
    const qty = Math.max(0, Math.floor(Number(body.produced_quantity) || 0))
    if (qty > 0) {
      const r = await this.stock.applyProductionRestock({ productId, quantity: qty, refId: `publish:${id}`, note: `Estoque inicial — Product OS ${pd.name}` }).catch(() => 'noop' as const)
      if (r === 'restocked') stockSeeded = qty
    }

    // publica na loja se for um canal-alvo
    let storefront = false
    if ((pd.target_marketplaces ?? []).includes('loja')) {
      const res = await this.products.setStorefrontVisibility(orgId, [productId], true).catch(() => ({ updated: 0, skipped: 0 }))
      storefront = res.updated > 0
    }

    await this.emitEvent(orgId, id, 'published', { product_id: productId }, userId)
    return { product_id: productId, price, cost_price: pd.estimated_cost, photos: photos.length, stock_seeded: stockSeeded, storefront }
  }

  // ─────────────────────────────────────────────────────────────────
  // versões CAD / protótipo
  // ─────────────────────────────────────────────────────────────────

  async listVersions(productDevId: string, orgId: string): Promise<ProductDevVersion[]> {
    const { data, error } = await supabaseAdmin
      .from('product_dev_version').select('*')
      .eq('product_dev_id', productDevId).eq('organization_id', orgId)
      .order('version_number', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as ProductDevVersion[]
  }

  async addVersion(productDevId: string, orgId: string, userId: string | null, body: {
    changelog?: string
    file_url?: string
    file_type?: string
    material?: string
    weight_g?: number
    print_time_minutes?: number
    volume_cm3?: number
    prototype_photo_urls?: string[]
    notes?: string
  }): Promise<ProductDevVersion> {
    // garante que o produto existe na org
    await this.get(productDevId, orgId)
    // próximo número de versão
    const existing = await this.listVersions(productDevId, orgId)
    const nextNumber = existing.length ? existing[0].version_number + 1 : 1

    const { data, error } = await supabaseAdmin
      .from('product_dev_version')
      .insert({
        organization_id:      orgId,
        product_dev_id:       productDevId,
        version_number:       nextNumber,
        changelog:            body.changelog ?? null,
        file_url:             body.file_url ?? null,
        file_type:            body.file_type ?? null,
        material:             body.material ?? null,
        weight_g:             body.weight_g ?? null,
        print_time_minutes:   body.print_time_minutes ?? null,
        volume_cm3:           body.volume_cm3 ?? null,
        prototype_photo_urls: body.prototype_photo_urls ?? [],
        status:               'rascunho',
        notes:                body.notes ?? null,
        created_by:           userId,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar versão: ${error?.message ?? 'sem dados'}`)

    // adicionar a 1ª versão move o produto de 'ideia'/'briefing' p/ 'modelagem'
    await supabaseAdmin.from('product_dev')
      .update({ status: 'modelagem' })
      .eq('id', productDevId).eq('organization_id', orgId)
      .in('status', ['ideia', 'briefing'])

    const v = data as ProductDevVersion
    await this.emitEvent(orgId, productDevId, 'version_added', { version_id: v.id, version_number: v.version_number }, userId)
    void this.active.reflectStatus(orgId, productDevId).catch(() => {})
    return v
  }

  /** Aprova ou reprova uma versão. Aprovar move o produto p/ 'aprovado'. */
  async setVersionApproval(versionId: string, orgId: string, approved: boolean): Promise<ProductDevVersion> {
    const { data, error } = await supabaseAdmin
      .from('product_dev_version')
      .update({ approved, status: approved ? 'aprovado' : 'reprovado' })
      .eq('id', versionId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    const v = data as ProductDevVersion
    if (approved) {
      await supabaseAdmin.from('product_dev')
        .update({ status: 'aprovado' })
        .eq('id', v.product_dev_id).eq('organization_id', orgId)
        .in('status', ['modelagem', 'prototipo'])
    }
    await this.emitEvent(orgId, v.product_dev_id, approved ? 'version_approved' : 'version_rejected', { version_id: v.id, version_number: v.version_number })
    void this.active.reflectStatus(orgId, v.product_dev_id).catch(() => {})
    return v
  }

  // ─────────────────────────────────────────────────────────────────
  // production_settings — constantes de fabricação por org
  // ─────────────────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<ProductionSettings> {
    const { data, error } = await supabaseAdmin
      .from('production_settings').select('*')
      .eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (data) return data as ProductionSettings
    // cria default vazio na 1ª leitura (idempotente)
    const { data: created, error: cErr } = await supabaseAdmin
      .from('production_settings')
      .insert({ organization_id: orgId })
      .select('*').maybeSingle()
    if (cErr || !created) throw new BadRequestException(`Erro ao criar settings: ${cErr?.message ?? 'sem dados'}`)
    return created as ProductionSettings
  }

  async updateSettings(orgId: string, patch: {
    filament_cost_per_kg?: Record<string, number>
    energy_cost_per_hour?: number
    labor_cost_per_hour?: number
    packaging_cost?: number
    default_waste_pct?: number
    machines?: Array<{ name: string; model?: string; bed_mm?: number[] }>
  }): Promise<ProductionSettings> {
    await this.getSettings(orgId)  // garante linha
    const safe: Record<string, unknown> = {}
    for (const k of ['filament_cost_per_kg', 'energy_cost_per_hour', 'labor_cost_per_hour', 'packaging_cost', 'default_waste_pct', 'machines'] as const) {
      if (k in patch) safe[k] = patch[k]
    }
    const { data, error } = await supabaseAdmin
      .from('production_settings').update(safe)
      .eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as ProductionSettings
  }

  // ─────────────────────────────────────────────────────────────────
  // custo de fabricação + preço sugerido por canal
  // ─────────────────────────────────────────────────────────────────

  /** Calcula o custo de fabricação de uma versão (ou de inputs avulsos) e
   *  sugere preço por canal para uma margem-alvo. Cacheia em estimated_cost. */
  async computeCost(productDevId: string, orgId: string, body: {
    version_id?: string
    weight_g?: number
    print_time_minutes?: number
    material?: string
    target_margin_pct?: number
  } = {}): Promise<{
    cost: { filament: number; energy: number; labor: number; packaging: number; waste: number; total: number }
    inputs: { weight_g: number; print_time_minutes: number; material: string; cost_per_kg: number }
    target_margin_pct: number
    suggested_prices: Array<{ channel: string; fee_pct: number; price: number; margin_pct: number }>
  }> {
    const settings = await this.getSettings(orgId)

    // resolve a versão de referência: explícita > aprovada > última
    let weight = body.weight_g
    let minutes = body.print_time_minutes
    let material = body.material
    if (weight == null || minutes == null || !material) {
      const versions = await this.listVersions(productDevId, orgId)
      const ref = body.version_id
        ? versions.find(v => v.id === body.version_id)
        : (versions.find(v => v.approved) ?? versions[0])
      if (ref) {
        weight   = weight   ?? (ref.weight_g ?? undefined)
        minutes  = minutes  ?? (ref.print_time_minutes ?? undefined)
        material = material ?? (ref.material ?? undefined)
      }
    }
    const w = Math.max(0, Number(weight) || 0)
    const min = Math.max(0, Number(minutes) || 0)
    const mat = (material || 'PLA').toUpperCase()
    let costPerKg = Number(settings.filament_cost_per_kg?.[mat] ?? settings.filament_cost_per_kg?.PLA ?? 0)
    // prefere o custo médio ponderado (WAC) do insumo de filamento, se cadastrado
    const { data: inp } = await supabaseAdmin.from('production_input')
      .select('cost_per_unit, unit').eq('organization_id', orgId).eq('kind', 'filamento')
      .eq('material', mat).eq('is_active', true).gt('cost_per_unit', 0)
      .order('quantity', { ascending: false }).limit(1).maybeSingle()
    if (inp) {
      const c = Number((inp as { cost_per_unit: number }).cost_per_unit) || 0
      const u = (inp as { unit: string }).unit
      if (c > 0) costPerKg = u === 'g' ? c * 1000 : u === 'kg' ? c : costPerKg
    }

    const filament  = round2((w / 1000) * costPerKg)
    const energy    = round2((min / 60) * Number(settings.energy_cost_per_hour || 0))
    const labor     = round2((min / 60) * Number(settings.labor_cost_per_hour || 0))
    const packaging = round2(Number(settings.packaging_cost || 0))
    const subtotal  = filament + energy + labor + packaging
    const waste     = round2(subtotal * (Number(settings.default_waste_pct || 0) / 100))
    const total     = round2(subtotal + waste)

    const targetMargin = Math.min(Math.max(Number(body.target_margin_pct ?? 30), 0), 90)

    const suggested = Object.entries(CHANNEL_ALLIN_FEE_PCT).map(([channel, fee]) => {
      const denom = 1 - fee / 100 - targetMargin / 100
      const price = denom > 0 ? round2(total / denom) : 0
      // margem realizada nesse preço (confere o alvo)
      const marginPct = price > 0 ? round2(((price - price * fee / 100 - total) / price) * 100) : 0
      return { channel, fee_pct: fee, price, margin_pct: marginPct }
    })

    // cacheia o custo no produto
    await supabaseAdmin.from('product_dev')
      .update({ estimated_cost: total })
      .eq('id', productDevId).eq('organization_id', orgId)

    return {
      cost: { filament, energy, labor, packaging, waste, total },
      inputs: { weight_g: w, print_time_minutes: min, material: mat, cost_per_kg: costPerKg },
      target_margin_pct: targetMargin,
      suggested_prices: suggested,
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Briefing IA — gera o briefing técnico que alimenta o CAD
  // ─────────────────────────────────────────────────────────────────

  async generateBriefing(productDevId: string, orgId: string, body: {
    dimensions?: { width_mm?: number; depth_mm?: number; height_mm?: number }
    material?: string
    wall_thickness_mm?: number
    notes?: string
  } = {}): Promise<{ briefing: Record<string, unknown>; briefing_text: string; cost_usd: number }> {
    const product = await this.get(productDevId, orgId)

    const refs = (product.reference_images ?? []).map(r => r.url).filter(Boolean)
    const userPrompt = `## PRODUTO A DESENVOLVER
Nome: ${product.name}
Categoria: ${product.category ?? '—'}
Descrição/ideia: ${product.description ?? '—'}
Inspiração (link): ${product.inspiration_url ?? '—'}
Imagens de referência: ${refs.length ? refs.join(', ') : '—'}
Perfil de produção: ${product.production_profile}

## PARÂMETROS INFORMADOS
Dimensões desejadas (mm): ${JSON.stringify(body.dimensions ?? {})}
Material: ${body.material ?? 'PLA (sugerir se não informado)'}
Espessura de parede (mm): ${body.wall_thickness_mm ?? '—'}
Observações: ${body.notes ?? '—'}

## SAÍDA — JSON PURO
{
  "resumo": "1-2 frases do que é o produto e pra quem serve",
  "material_sugerido": "PLA|PETG|ABS",
  "dimensoes_mm": { "largura": number, "profundidade": number, "altura": number },
  "espessura_parede_mm": number,
  "raio_cantos_mm": number,
  "orientacao_impressao": "ex: deitar na traseira (sem suporte)",
  "precisa_suporte": boolean,
  "modulos": [
    {
      "nome": "ex: torre, gaveta, frente, puxador, logo",
      "tipo": "open_box|shell|solid|tray|drawer|knob|logo_relief",
      "quantidade": number,
      "cor": "ex: branco, preto, 2a-cor",
      "solido": boolean,
      "params": { "largura_mm": number, "profundidade_mm": number, "altura_mm": number }
    }
  ],
  "encaixes": "descrição dos encaixes/folgas (ex: 0.45mm/lado p/ gaveta)",
  "diferenciacao_originalidade": "o que mudar vs a inspiração p/ ser original e não infringir",
  "riscos_impressao": ["lista curta de riscos (overhang, base instável, etc)"],
  "briefing_markdown": "o briefing COMPLETO em markdown legível, pronto pra colar num modelador 3D (Claude Code/Fusion). Deve ser autossuficiente."
}`

    const out = await this.llm.generateText({
      orgId,
      feature:      'product_os_briefing',
      systemPrompt: BRIEFING_SYSTEM_PROMPT,
      userPrompt,
      maxTokens:    2800,
      temperature:  0.4,
      jsonMode:     true,
    })

    const parsed = parseJsonLoose(out.text) as Record<string, unknown> | null
    if (!parsed) throw new BadRequestException('IA retornou JSON inválido')
    const briefingText = typeof parsed.briefing_markdown === 'string' ? parsed.briefing_markdown : ''

    await supabaseAdmin.from('product_dev')
      .update({
        briefing:      parsed,
        briefing_text: briefingText || null,
        status:        product.status === 'ideia' ? 'briefing' : product.status,
      })
      .eq('id', productDevId).eq('organization_id', orgId)

    await this.emitEvent(orgId, productDevId, 'briefing_generated', { cost_usd: out.costUsd })
    return { briefing: parsed, briefing_text: briefingText, cost_usd: out.costUsd }
  }
}

const BRIEFING_SYSTEM_PROMPT = `Você é um engenheiro de produto especialista em design para manufatura
(DFM) e impressão 3D FDM (Bambu Lab A1 + AMS, mesa 256×256 mm).

OBJETIVO: transformar uma ideia de produto + referência num briefing técnico
PRECISO e FABRICÁVEL, que sirva de instrução direta pra um modelador 3D.

REGRAS:
- Unidades sempre em milímetros.
- Pensar em peças que cabem na mesa (≤ ~250 mm por eixo); se maior, dividir em módulos encaixáveis.
- Parede típica FDM: 2,6–3,2 mm. Cantos arredondados pra estética e resistência.
- Preferir orientação SEM suporte quando possível.
- PLA padrão; PETG quando precisa de tenacidade; ABS só se necessário.
- ORIGINALIDADE: nunca copiar a referência 1:1 — sempre propor diferenças concretas pra evitar infração.
- Ser concreto: dar números, não generalidades.
- Saída JSON puro, sem markdown wrapper (exceto dentro do campo "briefing_markdown").`

/** Arredonda pra 2 casas (centavos). */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Parse tolerante de JSON vindo de LLM (Claude embrulha em markdown/preâmbulo
 *  mesmo com jsonMode). Tenta direto → bloco ```json``` → primeiro{..último}. */
function parseJsonLoose(text: string): unknown {
  const trimmed = (text ?? '').trim()
  try { return JSON.parse(trimmed) } catch { /* continua */ }
  const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (m) { try { return JSON.parse(m[1]) } catch { /* continua */ } }
  const open = trimmed.indexOf('{')
  const close = trimmed.lastIndexOf('}')
  if (open >= 0 && close > open) {
    try { return JSON.parse(trimmed.slice(open, close + 1)) } catch { /* continua */ }
  }
  return null
}
