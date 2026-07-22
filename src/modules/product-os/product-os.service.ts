import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { unzipSync, strFromU8 } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { ProductsService } from '../products/products.service'
import { StockService } from '../stock/stock.service'
import { ProductionService } from './production.service'
import { ProductOsActiveService } from './product-os-active.service'
import { MakerworldService } from './makerworld.service'
import { SkuService } from './sku.service'
import { variationAttributes, variationType, variationValue } from './sku.pure'
import { ModelSourceRegistry } from './model-sources/model-source.registry'
import { type SourceModel, type LicenseVerdict } from './model-sources/source.types'

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
  code:                string | null
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
  // proveniência de importação (Peça 1) + liberação de licença (Peça 2)
  source_platform:         string | null
  source_external_id:      string | null
  source_license:          string | null
  source_allow_recreation: boolean | null
  source_metadata:         Record<string, unknown>
  license_cleared:         boolean
  license_clearance_note:  string | null
  license_cleared_by:      string | null
  license_cleared_at:      string | null
  // classificação de SKU (linha de produtos etc.) — colunas gravadas pelo SkuService
  sku_marca_id?:           string | null
  sku_categoria_id?:       string | null
  sku_sub_id?:             string | null
  sku_linha_id?:           string | null
  sku_caracteristica_id?:  string | null
  sku_base?:               string | null
  ean?:                    string | null
  // ficha de catálogo (transição projeto → produto pronto p/ IA Criativo)
  catalog_title?:          string | null
  catalog_description?:    string | null
  catalog_brand?:          string | null
  catalog_bullets?:        string[]
  catalog_attributes?:     Record<string, string>
  catalog_tags?:           string[]
  catalog_ready?:          boolean
  enrichment?:             Record<string, unknown> | null
  // categoria da árvore do Mercado Livre (espelho ml_categories) → products.category_ml_id
  category_ml_id?:         string | null
  category_ml_path?:       Array<{ id: string; name: string }> | null
  // medidas do produto FINAL (montado) — para envio no anúncio
  final_weight_g?:         number | null
  final_width_mm?:         number | null
  final_depth_mm?:         number | null
  final_height_mm?:        number | null
  cost_breakdown?:         Record<string, unknown> | null
  created_by:          string | null
  created_at:          string
  updated_at:          string
}

/** Status do porteiro de licença (Peça 2) — devolvido junto do produto. */
export interface LicenseStatus {
  imported:     boolean                              // veio de uma plataforma externa?
  platform:     string | null
  source_url:   string | null
  license:      string | null
  verdict:      LicenseVerdict | null
  cleared:      boolean
  cleared_note: string | null
  cleared_at:   string | null
  blocked:      boolean                              // trava a publicação?
  can_publish:  boolean
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
  /** composição do prato: o que sai de UMA impressão deste arquivo
   *  (cópias da mesma peça e/ou peças diferentes juntas). Quando presente,
   *  peso/tempo da versão valem POR PRATO e a OP conta PRATOS. */
  plate_composition:    Array<{ part_id: string; units: number }> | null
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
    private readonly makerworld: MakerworldService,
    private readonly sku: SkuService,
    private readonly sources: ModelSourceRegistry,
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

  /** Lê dados de dentro de um .3mf (projeto do Bambu Studio). O 3mf é um ZIP:
   *  `Metadata/slice_info.config` traz peso/tempo/filamento (SÓ se foi fatiado),
   *  e `Metadata/plate_*.json` traz o bounding box (largura/profundidade) mesmo
   *  SEM fatiar. STL não tem nada disso (só geometria). */
  async parse3mf(url: string): Promise<{ weight_g: number | null; print_time_minutes: number | null; material: string | null; width_mm: number | null; depth_mm: number | null; height_mm: number | null; filaments: Array<{ index: number; material: string | null; color: string | null; weight_g: number }>; found: boolean }> {
    const none = { weight_g: null, print_time_minutes: null, material: null, width_mm: null, depth_mm: null, height_mm: null, filaments: [], found: false }
    if (!url?.trim()) throw new BadRequestException('URL do arquivo ausente.')
    if (!/\.3mf($|\?)/i.test(url)) return none   // STL/STEP/etc não têm metadados
    let buf: Uint8Array
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      buf = new Uint8Array(await res.arrayBuffer())
    } catch { throw new BadRequestException('Não consegui baixar o arquivo do storage.') }

    let files: Record<string, Uint8Array>
    try { files = unzipSync(buf) } catch { return none }   // não é um zip/3mf válido

    // ── peso/tempo/material + cores (só se fatiado) — Metadata/slice_info.config ──
    let grams = 0, seconds = 0; const mats: string[] = []
    // por filamento (cor): índice → {material, cor, gramas} — soma entre placas
    const filByIdx = new Map<number, { index: number; material: string | null; color: string | null; weight_g: number }>()
    const sliceKey = Object.keys(files).find(k => /slice_info\.config$/i.test(k))
    if (sliceKey) {
      try {
        const j = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(strFromU8(files[sliceKey])) as { config?: { plate?: unknown } }
        const pRaw = j?.config?.plate
        const plates: Array<Record<string, unknown>> = Array.isArray(pRaw) ? pRaw as Array<Record<string, unknown>> : (pRaw ? [pRaw as Record<string, unknown>] : [])
        for (const pl of plates) {
          const mdRaw = pl.metadata
          const md: Array<Record<string, string>> = Array.isArray(mdRaw) ? mdRaw as Array<Record<string, string>> : (mdRaw ? [mdRaw as Record<string, string>] : [])
          const getMd = (k: string): string | undefined => md.find(m => m['@_key'] === k)?.['@_value']
          const plateW = Number(getMd('weight'))
          if (Number.isFinite(plateW) && plateW > 0) grams += plateW
          const pr = Number(getMd('prediction'))
          if (Number.isFinite(pr) && pr > 0) seconds += pr
          const fRaw = pl.filament
          const fils: Array<Record<string, string>> = Array.isArray(fRaw) ? fRaw as Array<Record<string, string>> : (fRaw ? [fRaw as Record<string, string>] : [])
          fils.forEach((f, i) => {
            const mat = f['@_type'] ? String(f['@_type']).toUpperCase() : null
            if (mat) mats.push(mat)
            const idx = Number(f['@_id']) || (i + 1)
            const ug = Number(f['@_used_g'])
            const cur = filByIdx.get(idx) ?? { index: idx, material: mat, color: f['@_color'] ? String(f['@_color']) : null, weight_g: 0 }
            if (Number.isFinite(ug) && ug > 0) cur.weight_g += ug
            if (!cur.material && mat) cur.material = mat
            filByIdx.set(idx, cur)
            // sem peso por placa? soma do filamento vira o total
            if (!(Number.isFinite(plateW) && plateW > 0)) { if (Number.isFinite(ug) && ug > 0) grams += ug }
          })
        }
      } catch { /* ignora slice info corrompida */ }
    }
    // só conta como "cor" o filamento que realmente foi usado (used_g > 0)
    const filaments = [...filByIdx.values()]
      .filter(f => f.weight_g > 0)
      .map(f => ({ ...f, weight_g: Math.round(f.weight_g * 100) / 100 }))
      .sort((a, b) => a.index - b.index)

    // ── footprint (largura/profundidade) — Metadata/plate_*.json bbox_all ──
    let width: number | null = null, depth: number | null = null
    const plateJsonKey = Object.keys(files).find(k => /plate_\d+\.json$/i.test(k))
    if (plateJsonKey) {
      try {
        const pj = JSON.parse(strFromU8(files[plateJsonKey])) as { bbox_all?: number[]; bbox_objects?: Array<{ bbox?: number[] }> }
        const bb = pj.bbox_all ?? pj.bbox_objects?.[0]?.bbox   // [minX, minY, maxX, maxY]
        if (Array.isArray(bb) && bb.length >= 4) {
          const w = Math.round((bb[2] - bb[0]) * 10) / 10, d = Math.round((bb[3] - bb[1]) * 10) / 10
          if (w > 0) width = w
          if (d > 0) depth = d
        }
      } catch { /* ignora plate json corrompido */ }
    }

    // ── altura (Z) — header do gcode fatiado: "; max_z_height: NN" ──
    let height: number | null = null
    const gcodeKey = Object.keys(files).find(k => /plate_\d+\.gcode$/i.test(k))
    if (gcodeKey) {
      try {
        const head = strFromU8(files[gcodeKey].slice(0, 20000))   // só o cabeçalho
        const m = head.match(/;\s*max_z_height:\s*([\d.]+)/i)
        if (m) { const h = Math.round(parseFloat(m[1]) * 10) / 10; if (h > 0) height = h }
      } catch { /* ignora gcode corrompido */ }
    }

    return {
      weight_g: grams > 0 ? Math.round(grams * 100) / 100 : null,
      print_time_minutes: seconds > 0 ? Math.round(seconds / 60) : null,
      material: mats[0] ?? null,
      width_mm: width, depth_mm: depth, height_mm: height,
      filaments,
      found: !!(grams > 0 || seconds > 0 || width || depth || height),
    }
  }

  /** Gera uma URL assinada pro navegador subir o arquivo DIRETO ao storage
   *  (não passa pela API). Bucket público 'product-os', escopo por org. */
  async createUploadUrl(orgId: string, filename: string): Promise<{ path: string; token: string; public_url: string }> {
    const safe = (filename || 'arquivo').normalize('NFD').replace(/[^\w.\-]/g, '_').slice(-80)
    const path = `${orgId}/${Date.now()}-${safe}`
    const { data, error } = await supabaseAdmin.storage.from('product-os').createSignedUploadUrl(path)
    if (error || !data) throw new BadRequestException(`Erro ao gerar upload: ${error?.message ?? 'sem dados'}`)
    const pub = supabaseAdmin.storage.from('product-os').getPublicUrl(data.path)
    return { path: data.path, token: data.token, public_url: pub.data.publicUrl }
  }

  /** Exclui um arquivo do storage (libera espaço). Só apaga arquivo desta org
   *  (o path começa com `${orgId}/`) — trava de segurança multi-tenant. */
  async deleteFile(orgId: string, url: string): Promise<{ removed: boolean; path: string }> {
    if (!url?.trim()) throw new BadRequestException('Informe o arquivo a excluir.')
    const m = url.match(/\/product-os\/(.+)$/)
    const path = m ? decodeURIComponent(m[1].split('?')[0]) : null
    if (!path) throw new BadRequestException('URL de arquivo inválida.')
    if (!path.startsWith(`${orgId}/`)) throw new BadRequestException('Este arquivo não pertence à sua organização.')
    const { error } = await supabaseAdmin.storage.from('product-os').remove([path])
    if (error) throw new BadRequestException(`Erro ao excluir o arquivo: ${error.message}`)
    return { removed: true, path }
  }

  /** Remove o arquivo CAD de uma versão: apaga do storage + limpa file_url. */
  async removeVersionFile(versionId: string, orgId: string): Promise<ProductDevVersion> {
    const { data, error } = await supabaseAdmin.from('product_dev_version')
      .select('id, file_url').eq('id', versionId).eq('organization_id', orgId).maybeSingle()
    if (error || !data) throw new NotFoundException('Versão não encontrada')
    const v = data as { id: string; file_url: string | null }
    if (v.file_url) await this.deleteFile(orgId, v.file_url).catch(() => { /* arquivo já sumiu — segue limpando o vínculo */ })
    return this.updateVersion(versionId, orgId, { file_url: null, file_type: null })
  }

  // ─────────────────────────────────────────────────────────────────
  // product_dev — CRUD + kanban
  // ─────────────────────────────────────────────────────────────────

  async list(orgId: string, opts: { status?: ProductDevStatus } = {}): Promise<(ProductDev & { license_status: LicenseStatus })[]> {
    let q = supabaseAdmin
      .from('product_dev')
      .select('*')
      .eq('organization_id', orgId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro ao listar: ${error.message}`)
    return (data ?? []).map(d => ({ ...(d as ProductDev), license_status: this.licenseStatus(d as ProductDev) }))
  }

  async get(id: string, orgId: string): Promise<ProductDev & { versions: ProductDevVersion[]; license_status: LicenseStatus }> {
    const { data, error } = await supabaseAdmin
      .from('product_dev').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    const pd = data as ProductDev
    const versions = await this.listVersions(id, orgId)
    return { ...pd, versions, license_status: this.licenseStatus(pd) }
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

  // ══ Importar do MakerWorld (Peça 1) ════════════════════════════════
  /** Lê o design no MakerWorld SEM gravar. Mostra o selo de licença e avisa
   *  se já foi importado nesta org. */
  async importPreview(orgId: string, url: string): Promise<SourceModel & { already_imported_id: string | null }> {
    const d = await this.sources.fetchByUrl(url)
    const { data: existing } = await supabaseAdmin
      .from('product_dev').select('id')
      .eq('organization_id', orgId)
      .eq('source_platform', d.platform)
      .eq('source_external_id', d.external_id)
      .limit(1).maybeSingle()
    return { ...d, already_imported_id: existing?.id ?? null }
  }

  /** Importa o design → cria product_dev (status 'ideia') + 1ª versão com
   *  peso/tempo/material, guardando proveniência e licença. Não bloqueia por
   *  licença (isso é a Peça 2); só registra o veredito na timeline. */
  async importFromMakerworld(orgId: string, userId: string | null, url: string, opts: { create_version?: boolean } = {}): Promise<{
    product_dev: ProductDev; version_id: string | null; verdict: LicenseVerdict; design: SourceModel
  }> {
    const d = await this.sources.fetchByUrl(url)
    const platformLabel = this.sources.byPlatform(d.platform).label

    const refImg: ReferenceImage[] = d.cover_url
      ? [{ url: d.cover_url, source_url: d.source_url, notes: `Capa ${platformLabel} — ${d.creator ?? 'criador desconhecido'}` }]
      : []
    const descParts = [
      d.creator ? `Criador: ${d.creator}` : null,
      d.license ? `Licença: ${d.license}${d.license_title ? ` (${d.license_title})` : ''}` : null,
      d.is_remix ? 'Remix (tem linhagem de origem).' : null,
      `Origem: ${d.source_url}`,
      `Veredito: ${d.verdict.label} — ${d.verdict.reason}`,
    ].filter(Boolean)

    const { data, error } = await supabaseAdmin
      .from('product_dev')
      .insert({
        organization_id:         orgId,
        name:                    d.title || `${platformLabel} ${d.external_id}`,
        category:                d.categories[0] ?? null,
        description:             descParts.join('\n'),
        production_profile:      'impressao_3d',
        inspiration_url:         d.source_url,
        reference_images:        refImg,
        target_marketplaces:     [],
        status:                  'ideia',
        source_platform:         d.platform,
        source_external_id:      d.external_id,
        source_license:          d.license,
        source_allow_recreation: d.allow_recreation,
        source_metadata:         { ...d.raw, verdict: d.verdict, tags: d.tags, source_url: d.source_url, price: d.price },
        created_by:              userId,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao importar: ${error?.message ?? 'sem dados'}`)
    const created = data as ProductDev

    await this.emitEvent(orgId, created.id, 'imported', {
      platform: d.platform, external_id: d.external_id, license: d.license,
      allow_recreation: d.allow_recreation, verdict: d.verdict.level, source_url: d.source_url,
    }, userId)

    // 1ª versão com as métricas de fabricação, se a API trouxe perfil de impressão
    let versionId: string | null = null
    if (opts.create_version !== false && (d.weight_g != null || d.print_time_minutes != null)) {
      try {
        const v = await this.addVersion(created.id, orgId, userId, {
          changelog:          `Importado do ${platformLabel} (perfil de impressão da origem)`,
          material:           d.material_count && d.material_count > 1 ? 'multicor' : null,
          weight_g:           d.weight_g ?? undefined,
          print_time_minutes: d.print_time_minutes ?? undefined,
          notes:              d.need_ams ? 'Requer AMS (multicor).' : null,
        })
        versionId = v.id
      } catch (e) {
        this.logger.warn(`[makerworld] produto ${created.id} criado mas falhou a 1ª versão: ${(e as Error).message}`)
      }
    }

    return { product_dev: created, version_id: versionId, verdict: d.verdict, design: d }
  }

  // ══ Porteiro de licença (Peça 2) ═══════════════════════════════════
  /** Calcula o status do porteiro a partir das colunas de proveniência +
   *  liberação. Produto próprio (sem origem) nunca é bloqueado. */
  licenseStatus(pd: Pick<ProductDev,
    'source_platform' | 'source_license' | 'source_allow_recreation' | 'inspiration_url' | 'source_metadata' |
    'license_cleared' | 'license_clearance_note' | 'license_cleared_at'>): LicenseStatus {
    if (!pd.source_platform) {
      return { imported: false, platform: null, source_url: null, license: null, verdict: null, cleared: false, cleared_note: null, cleared_at: null, blocked: false, can_publish: true }
    }
    // confia no veredito gravado no import (platform-agnostic). Fallback p/ linhas
    // legadas sem veredito = recomputa pela regra do MakerWorld (origem histórica).
    const stored = (pd.source_metadata as { verdict?: LicenseVerdict } | null)?.verdict
    const verdict: LicenseVerdict = stored ?? this.makerworld.licenseVerdict(pd.source_license, pd.source_allow_recreation === true)
    const cleared = pd.license_cleared === true
    // pra vender uma peça remodelada preciso de direito comercial E de derivados = verde
    const blocked = verdict.level !== 'green' && !cleared
    return {
      imported: true, platform: pd.source_platform, source_url: pd.inspiration_url,
      license: pd.source_license, verdict, cleared,
      cleared_note: pd.license_clearance_note, cleared_at: pd.license_cleared_at,
      blocked, can_publish: !blocked,
    }
  }

  /** Override do porteiro: lojista declara que adquiriu licença comercial ou foi
   *  autorizado pelo criador. Liberar destrava a publicação; remover re-bloqueia. */
  async setLicenseClearance(id: string, orgId: string, userId: string | null, body: { cleared: boolean; note?: string }): Promise<ProductDev & { versions: ProductDevVersion[]; license_status: LicenseStatus }> {
    const pd = await this.get(id, orgId)
    if (!pd.source_platform) throw new BadRequestException('Este produto não veio de uma importação — não há licença externa para liberar.')
    const cleared = body.cleared === true
    const { error } = await supabaseAdmin.from('product_dev').update({
      license_cleared:        cleared,
      license_clearance_note: cleared ? (body.note?.trim() || null) : null,
      license_cleared_by:     cleared ? userId : null,
      license_cleared_at:     cleared ? new Date().toISOString() : null,
    }).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    await this.emitEvent(orgId, id, cleared ? 'license_cleared' : 'license_clearance_removed', { note: body.note?.trim() || null }, userId)
    return this.get(id, orgId)
  }

  async update(id: string, orgId: string, patch: Partial<ProductDev>): Promise<ProductDev> {
    const allowed: (keyof ProductDev)[] = [
      'name', 'category', 'description', 'production_profile',
      'inspiration_url', 'reference_images', 'target_marketplaces',
      'target_price', 'estimated_cost',
      'final_weight_g', 'final_width_mm', 'final_depth_mm', 'final_height_mm',
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

  /** Move o card no kanban: muda status e/ou reordena dentro da coluna.
   *  O arrasto é livre entre as etapas de desenvolvimento, mas as etapas com
   *  CONSEQUÊNCIA têm porteiro: 'aprovado' exige versão aprovada, 'publicado'
   *  exige produto no catálogo, e produto publicado não volta pro funil. */
  async move(id: string, orgId: string, body: { status?: ProductDevStatus; position?: number }): Promise<ProductDev> {
    const safe: Record<string, unknown> = {}
    if (body.status)              safe.status   = body.status
    if (typeof body.position === 'number') safe.position = body.position
    if (Object.keys(safe).length === 0) throw new BadRequestException('Informe status ou position')
    if (body.status) {
      const { data: cur } = await supabaseAdmin.from('product_dev').select('status, product_id')
        .eq('id', id).eq('organization_id', orgId).maybeSingle()
      const c = cur as { status: string; product_id: string | null } | null
      if (!c) throw new BadRequestException('Produto não encontrado')
      const POST_PUBLISH = ['publicado', 'monitorando']
      if (POST_PUBLISH.includes(c.status) && !POST_PUBLISH.includes(body.status) && body.status !== 'arquivado') {
        throw new BadRequestException('Produto já publicado no catálogo — ele não volta pro funil de desenvolvimento (só entre Publicado ↔ Monitorando ou Arquivado).')
      }
      if (body.status === 'publicado' && !c.product_id) {
        throw new BadRequestException('Esse produto ainda não virou anúncio — use o botão "Virar anúncio" (a coluna Publicado é consequência, não atalho).')
      }
      if (body.status === 'aprovado') {
        const { count } = await supabaseAdmin.from('product_dev_version').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).eq('product_dev_id', id).is('part_id', null).eq('approved', true)
        if ((count ?? 0) === 0) throw new BadRequestException('Aprove uma versão do modelo antes de mover pra Aprovado (aba Versões).')
      }
    }
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

  // ══ Categoria do Mercado Livre (árvore clonada em ml_categories) ══════════
  /** Prevê a categoria do ML a partir de um título. Usa o espelho local: busca as
   *  palavras-chave do título na árvore clonada e pega a mais específica. (A API
   *  pública domain_discovery não é alcançável de dentro do datacenter.) */
  private async mlPredictCategory(title: string): Promise<{ id: string; name: string } | null> {
    const t = (title ?? '').trim()
    if (!t) return null
    // termos relevantes do título (ignora conectores/curtos), do mais distintivo p/ o menos
    const stop = new Set(['de', 'da', 'do', 'para', 'com', 'e', 'em', 'o', 'a', 'os', 'as', 'kit', 'un', 'cm'])
    const terms = t.toLowerCase().normalize('NFD').replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !stop.has(w))
    for (const term of terms) {
      const hits = await this.searchMlCategories(term, 1)
      if (hits.length) return { id: hits[0].id, name: hits[0].name }
    }
    return null
  }

  /** Busca categorias na ÁRVORE CLONADA do ML (espelho local `ml_categories`,
   *  ~12k categorias) por nome. Não depende da API pública do ML (que o servidor
   *  não alcança de dentro do datacenter). Ordena por relevância + especificidade. */
  async searchMlCategories(query: string, limit = 15): Promise<Array<{ id: string; name: string; path: string }>> {
    const ql = (query ?? '').trim().toLowerCase()
    if (!ql) return []
    // casa por PALAVRA (não pela frase inteira): "suporte maquiagem" → nomes com
    // "suporte" OU "maquiagem". Ignora conectores curtos.
    const stop = new Set(['de', 'da', 'do', 'para', 'com', 'e', 'em', 'os', 'as', 'kit', 'un', 'cm'])
    const words = ql.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length >= 3 && !stop.has(w))
    const terms = words.length ? words : [ql]
    // peso IDF: palavra RARA (ex: "maquiagem") vale muito mais que comum ("suporte"),
    // pra a palavra distintiva mandar no ranking em vez da genérica.
    const counts = await Promise.all(terms.map(w =>
      supabaseAdmin.from('ml_categories').select('id', { count: 'exact', head: true }).ilike('name', `%${w}%`).then(r => r.count ?? 1),
    ))
    const weight = new Map(terms.map((w, i) => [w, 1 / Math.log2((counts[i] || 1) + 2)]))
    const rarest = terms.slice().sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0]
    const orFilter = terms.map(w => `name.ilike.%${w}%`).join(',')
    const { data } = await supabaseAdmin.from('ml_categories')
      .select('id, name, path_from_root').or(orFilter).limit(300)

    const scored = ((data ?? []) as Array<{ id: string; name: string; path_from_root: Array<{ id: string; name: string }> | null }>)
      .map(r => {
        const path = Array.isArray(r.path_from_root) ? r.path_from_root : []
        const nl = (r.name ?? '').toLowerCase()
        const pathHay = path.map(p => (p.name ?? '').toLowerCase()).join(' ')
        let score = 0
        for (const w of terms) { const wt = weight.get(w) ?? 0.2; if (nl.includes(w)) score += 40 * wt; else if (pathHay.includes(w)) score += 10 * wt }
        if (nl === ql) score += 40
        else if (rarest && nl.startsWith(rarest)) score += 12
        const nameWords = nl.split(/\s+/).length
        if (nameWords <= 2) score += 8; else if (nameWords === 3) score += 3   // nome curto = categoria "cabeça"
        return { id: r.id, name: r.name, path: path.map(p => p.name).join(' › '), depth: path.length, score }
      })
      .filter(r => r.depth >= 2 && r.score > 0)   // precisa ter pai (Categoria) + folha (Sub)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return scored.slice(0, Math.max(1, Math.min(30, limit))).map(({ id, name, path }) => ({ id, name, path }))
  }

  /** Caminho da categoria (path_from_root) — espelho local ml_categories primeiro,
   *  cai na API pública só se não estiver espelhada. */
  private async mlCategoryPath(id: string): Promise<Array<{ id: string; name: string }>> {
    if (!id) return []
    try {
      const { data } = await supabaseAdmin.from('ml_categories').select('id, name, path_from_root').eq('id', id).maybeSingle()
      const p = (data as { path_from_root?: Array<{ id: string; name: string }> } | null)?.path_from_root
      if (Array.isArray(p) && p.length) return p
    } catch { /* fallback */ }
    try {
      const res = await fetch(`https://api.mercadolibre.com/categories/${encodeURIComponent(id)}`)
      if (!res.ok) return []
      const d = (await res.json()) as { path_from_root?: Array<{ id: string; name: string }> }
      return Array.isArray(d.path_from_root) ? d.path_from_root : []
    } catch { return [] }
  }

  /** Define a categoria do ML no projeto (resolve o caminho e grava id+path) E
   *  deriva a Categoria+Sub INTERNAS (do SKU) a partir do caminho do ML — é o que
   *  faz a árvore clonada do ML alimentar o SKU. Recomputa sku_base. */
  async setMlCategory(orgId: string, devId: string, userId: string | null, categoryId: string | null): Promise<{ category_ml_id: string | null; path: Array<{ id: string; name: string }> }> {
    await this.get(devId, orgId)
    if (!categoryId) {
      await supabaseAdmin.from('product_dev').update({ category_ml_id: null, category_ml_path: null }).eq('id', devId).eq('organization_id', orgId)
      return { category_ml_id: null, path: [] }
    }
    const path = await this.mlCategoryPath(categoryId)
    const leaf = path[path.length - 1]
    await supabaseAdmin.from('product_dev').update({
      category_ml_id: categoryId, category_ml_path: path.length ? path : null,
      // espelha o nome da categoria no campo livre (exibição/coerência)
      ...(leaf?.name ? { category: leaf.name } : {}),
    }).eq('id', devId).eq('organization_id', orgId)
    // deriva Categoria (nível pai) + Sub (folha) internas do caminho do ML → SKU
    const categoria = path.length >= 2 ? path[path.length - 2]?.name ?? null : (path[0]?.name ?? null)
    const sub = path.length >= 1 ? path[path.length - 1]?.name ?? null : null
    if (categoria && sub) await this.sku.setCategorySub(orgId, userId, devId, categoria, sub).catch(() => {})
    return { category_ml_id: categoryId, path }
  }

  // ══ Ficha de catálogo (transição projeto → produto pronto p/ IA Criativo) ═══
  /** Vocabulário de taxonomia da org (rótulos por nível) — dado à IA para que ela
   *  REAPROVEITE nós existentes em vez de inventar sinônimos. */
  private async taxonomyVocab(orgId: string): Promise<Record<string, string[]>> {
    const { data } = await supabaseAdmin.from('sku_taxonomy').select('kind, label').eq('organization_id', orgId).order('code')
    const by: Record<string, string[]> = { marca: [], categoria: [], sub: [], linha: [], caracteristica: [] }
    for (const r of (data ?? []) as Array<{ kind: string; label: string }>) if (by[r.kind]) by[r.kind].push(r.label)
    return by
  }

  /**
   * IA preenche a FICHA de catálogo a partir da fonte (MakerWorld/Thingiverse/…),
   * imagens, briefing e métricas de fabricação: título de marketplace, descrição
   * rica, marca, bullets, atributos e tags — e SUGERE a classificação
   * (Marca/Categoria/Sub/Linha/Característica), reaproveitando a taxonomia
   * existente. Recurso PRÓPRIO do Product OS (feature `product_os_catalog`); não
   * toca na IA Criativo. Grava em catalog_* + enrichment; não sobrescreve uma
   * ficha já validada (catalog_ready) a menos que `force`.
   */
  async enrichForCatalog(orgId: string, devId: string, userId: string | null, opts: { force?: boolean } = {}): Promise<{
    ficha: { title: string; description: string; brand: string; bullets: string[]; attributes: Record<string, string>; tags: string[] }
    suggestion: { marca: string | null; marca_code: string | null; categoria: string | null; sub: string | null; linha: string | null; caracteristica: string | null }
    ml_category: { id: string | null; name: string | null; path: string | null }
    already_ready: boolean
  }> {
    const pd = await this.get(devId, orgId)
    if (pd.catalog_ready && !opts.force) {
      // já validada — devolve o que está gravado sem gastar IA
      const p = pd.category_ml_path ?? []
      return {
        ficha: { title: pd.catalog_title ?? pd.name, description: pd.catalog_description ?? pd.description ?? '', brand: pd.catalog_brand ?? '', bullets: pd.catalog_bullets ?? [], attributes: pd.catalog_attributes ?? {}, tags: pd.catalog_tags ?? [] },
        suggestion: this.readSuggestion(pd),
        ml_category: { id: pd.category_ml_id ?? null, name: p[p.length - 1]?.name ?? null, path: p.length ? p.map(x => x.name).join(' › ') : null },
        already_ready: true,
      }
    }

    const meta = (pd.source_metadata ?? {}) as Record<string, unknown>
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]).slice(0, 20) : []
    const approvedV = (pd.versions ?? []).find(v => v.approved) ?? (pd.versions ?? [])[0]
    const dims = (pd.briefing as { dimensoes_mm?: { largura?: number; profundidade?: number; altura?: number } } | null)?.dimensoes_mm
    const vocab = await this.taxonomyVocab(orgId)
    const refs = (pd.reference_images ?? []).map(r => r.url).filter(Boolean).slice(0, 3)
    const marketplaces = (pd.target_marketplaces ?? []).join(', ') || 'Mercado Livre, Shopee, loja própria'

    const userPrompt = `## PRODUTO (projeto do Product OS — impressão 3D)
Nome interno: ${pd.name}
Categoria livre atual: ${pd.category ?? '—'}
Descrição/ideia atual: ${(pd.briefing_text || pd.description || '—').slice(0, 800)}
Origem: ${pd.source_platform ? `${pd.source_platform} — ${pd.inspiration_url ?? ''}` : 'produto próprio'}
Título na origem: ${typeof meta.title === 'string' ? meta.title : (pd.name)}
Criador na origem: ${typeof meta.creator === 'string' ? meta.creator : '—'}
Tags da origem: ${tags.length ? tags.join(', ') : '—'}
Material: ${approvedV?.material ?? 'PLA'}
Peso aprox.: ${approvedV?.weight_g ?? '—'} g
Dimensões aprox. (mm): ${dims ? `${dims.largura ?? '?'}×${dims.profundidade ?? '?'}×${dims.altura ?? '?'}` : '—'}
Imagens de referência: ${refs.length ? refs.join(' , ') : '—'}
Canais-alvo: ${marketplaces}

## TAXONOMIA JÁ EXISTENTE (REAPROVEITE quando fizer sentido — não invente sinônimos)
Marcas: ${vocab.marca.join(' | ') || '—'}
Categorias: ${vocab.categoria.join(' | ') || '—'}
Sub-categorias: ${vocab.sub.join(' | ') || '—'}
Linhas: ${vocab.linha.join(' | ') || '—'}
Características: ${vocab.caracteristica.join(' | ') || '—'}

## SAÍDA — JSON PURO
{
  "ml_title": "título de marketplace, PT-BR, ATÉ 60 caracteres, começa pelo produto + atributo forte, sem CAIXA ALTA gritante, sem emoji",
  "description": "descrição comercial PT-BR, 400-900 caracteres, benefícios + uso + material (impresso em 3D) + dimensões se houver; parágrafos curtos",
  "brand": "marca comercial (ex: Vazzo). Se a origem não define, use a marca da taxonomia existente",
  "bullets": ["4 a 6 bullets curtos de benefício/atributo"],
  "attributes": { "Material": "PLA", "Cor": "…", "Tipo de produto": "…", "Público": "…", "…": "…" },
  "tags": ["8-15 palavras-chave de busca, minúsculas, sem #"],
  "categoria": "categoria (reaproveite da lista se possível)",
  "sub": "sub-categoria",
  "linha": "LINHA de produtos (família do modelo)",
  "caracteristica": "o que diferencia ESTE modelo dentro da linha (curto)",
  "marca_code": "código curto da marca em MAIÚSCULAS (ex: VZ) — só se for marca nova"
}`

    const out = await this.llm.generateText({
      orgId, feature: 'product_os_catalog', systemPrompt: CATALOG_SYSTEM_PROMPT,
      userPrompt, maxTokens: 1800, temperature: 0.5, jsonMode: true,
    })
    const parsed = (parseJsonLoose(out.text) ?? {}) as Record<string, unknown>
    const str = (v: unknown, fb = ''): string => typeof v === 'string' ? v.trim() : fb
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 20) : []
    const attrs: Record<string, string> = {}
    if (parsed.attributes && typeof parsed.attributes === 'object') for (const [k, v] of Object.entries(parsed.attributes as Record<string, unknown>)) { const kk = k.trim(); const vv = String(v ?? '').trim(); if (kk && vv) attrs[kk] = vv }

    const ficha = {
      title: str(parsed.ml_title, pd.name).slice(0, 60),
      description: str(parsed.description, pd.description ?? ''),
      brand: str(parsed.brand),
      bullets: arr(parsed.bullets),
      attributes: attrs,
      tags: arr(parsed.tags),
    }

    // Categoria do MERCADO LIVRE (árvore real): mantém a já escolhida ou prevê pelo
    // título. O caminho path_from_root vira a sugestão de Categoria/Sub do SKU —
    // alinhando a taxonomia interna com a do ML (pedido do lojista).
    let mlId = pd.category_ml_id ?? null
    let mlPath = pd.category_ml_path ?? []
    if (!mlId) {
      const pred = await this.mlPredictCategory(ficha.title || pd.name)
      if (pred) { mlId = pred.id; mlPath = await this.mlCategoryPath(pred.id) }
    }
    const mlLeaf = mlPath[mlPath.length - 1]?.name ?? null
    const mlParent = mlPath.length >= 2 ? mlPath[mlPath.length - 2]?.name ?? null : null

    const suggestion = {
      marca: str(parsed.brand) || null,
      marca_code: str(parsed.marca_code) || null,
      // Categoria/Sub vêm da árvore do ML quando disponíveis; senão, do texto da IA
      categoria: mlParent || str(parsed.categoria) || (pd.category ?? null),
      sub: mlLeaf || str(parsed.sub) || null,
      linha: str(parsed.linha) || null,
      caracteristica: str(parsed.caracteristica) || null,
    }

    await supabaseAdmin.from('product_dev').update({
      catalog_title: ficha.title, catalog_description: ficha.description, catalog_brand: ficha.brand,
      catalog_bullets: ficha.bullets, catalog_attributes: ficha.attributes, catalog_tags: ficha.tags,
      ...(mlId ? { category_ml_id: mlId, category_ml_path: mlPath.length ? mlPath : null } : {}),
      enrichment: { ...parsed, suggestion, ml_category_id: mlId, generated_at: new Date().toISOString() },
    }).eq('id', devId).eq('organization_id', orgId)
    await this.emitEvent(orgId, devId, 'catalog_enriched', { cost_usd: out.costUsd, title: ficha.title, ml_category: mlId }, userId)
    return { ficha, suggestion, ml_category: { id: mlId, name: mlLeaf, path: mlPath.length ? mlPath.map(x => x.name).join(' › ') : null }, already_ready: false }
  }

  private readSuggestion(pd: ProductDev) {
    const s = (pd.enrichment as { suggestion?: Record<string, string | null> } | null)?.suggestion ?? {}
    return {
      marca: s.marca ?? pd.catalog_brand ?? null, marca_code: s.marca_code ?? null,
      categoria: s.categoria ?? pd.category ?? null, sub: s.sub ?? null,
      linha: s.linha ?? null, caracteristica: s.caracteristica ?? null,
    }
  }

  /** Salva a ficha editada pelo operador e (opcional) marca "pronto p/ IA Criativo". */
  async saveFicha(orgId: string, devId: string, userId: string | null, body: {
    title?: string; description?: string; brand?: string; bullets?: string[]; attributes?: Record<string, string>; tags?: string[]; ready?: boolean
  }): Promise<ProductDev> {
    await this.get(devId, orgId) // garante escopo
    const safe: Record<string, unknown> = {}
    if (body.title != null) safe.catalog_title = String(body.title).slice(0, 120)
    if (body.description != null) safe.catalog_description = String(body.description)
    if (body.brand != null) safe.catalog_brand = String(body.brand).trim() || null
    if (Array.isArray(body.bullets)) safe.catalog_bullets = body.bullets.map(b => String(b).trim()).filter(Boolean).slice(0, 12)
    if (body.attributes && typeof body.attributes === 'object') {
      const a: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.attributes)) { const kk = k.trim(); const vv = String(v ?? '').trim(); if (kk && vv) a[kk] = vv }
      safe.catalog_attributes = a
    }
    if (Array.isArray(body.tags)) safe.catalog_tags = body.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30)
    if (typeof body.ready === 'boolean') safe.catalog_ready = body.ready
    if (!Object.keys(safe).length) throw new BadRequestException('Nada para salvar na ficha')
    const { data, error } = await supabaseAdmin.from('product_dev').update(safe).eq('id', devId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar ficha: ${error?.message ?? 'sem dados'}`)
    if (typeof body.ready === 'boolean') await this.emitEvent(orgId, devId, body.ready ? 'catalog_ready' : 'catalog_ready_removed', {}, userId)
    return data as ProductDev
  }

  /**
   * Atribui a LINHA (coleção transversal, ex: "Ella") ao projeto — escolhida ou
   * criada pelo nome. Aproveita para completar Marca (da marca da ficha) e
   * Categoria/Sub (do caminho da categoria do ML) para o SKU já fechar. É o campo
   * "definir linha" da Ficha / início do projeto.
   */
  async assignLine(orgId: string, devId: string, userId: string | null, body: { line_id?: string | null; line_name?: string | null }) {
    const pd = await this.get(devId, orgId)
    const path = pd.category_ml_path ?? []
    const categoria = path.length >= 2 ? path[path.length - 2]?.name ?? null : (path[0]?.name ?? null)
    const sub = path.length >= 1 ? path[path.length - 1]?.name ?? null : null
    const marca = (pd.catalog_brand ?? '').trim() || 'Vazzo'
    const res = await this.sku.assignLineAndClassify(orgId, userId, devId, {
      lineId: body.line_id ?? null, lineName: body.line_name ?? null, marca, categoria, sub,
    })
    await this.emitEvent(orgId, devId, 'line_assigned', { line: body.line_name ?? body.line_id ?? null }, userId)
    return res
  }

  /** Aplica a classificação sugerida (rótulos → nós, criando o que faltar) e grava
   *  a linha/SKU. Delega ao SkuService. */
  async applyClassificationFromLabels(orgId: string, devId: string, userId: string | null, labels: {
    marca?: string | null; marca_code?: string | null; categoria?: string | null; sub?: string | null; linha?: string | null; caracteristica?: string | null
  }) {
    await this.get(devId, orgId)
    const res = await this.sku.resolveOrCreateClassification(orgId, userId, devId, labels)
    await this.emitEvent(orgId, devId, 'classified', { linha: labels.linha ?? null, caracteristica: labels.caracteristica ?? null }, userId)
    return res
  }

  /**
   * Medidas do PRODUTO FINAL (montado) p/ o anúncio. Peso e dimensões são do
   * produto inteiro — nunca das peças isoladas:
   *  - Peso: correção manual (final_weight_g) > SOMA das peças (peso da versão da
   *    peça × qtd) > peso da versão do produto (que já é o corrigido/puxado).
   *  - Dimensões: informadas (final_*) > bounding das peças (larg/prof = maior,
   *    altura = soma, aproximação p/ montagem empilhada) > dimensões do briefing.
   */
  async computeMeasures(orgId: string, pd: ProductDev & { versions?: ProductDevVersion[] }): Promise<{
    weight_g: number | null; width_mm: number | null; depth_mm: number | null; height_mm: number | null
    weight_source: 'manual' | 'pecas' | 'versao' | 'none'; dims_source: 'manual' | 'pecas' | 'briefing' | 'parcial' | 'none'
    parts: number
  }> {
    const { data: partsData } = await supabaseAdmin.from('product_dev_part')
      .select('id, qty_per_product, width_mm, depth_mm, height_mm').eq('product_dev_id', pd.id).eq('organization_id', orgId)
    const parts = (partsData ?? []) as Array<{ id: string; qty_per_product: number; width_mm: number | null; depth_mm: number | null; height_mm: number | null }>

    // ── peso ──
    let weight: number | null = pd.final_weight_g != null ? Number(pd.final_weight_g) : null
    let wSource: 'manual' | 'pecas' | 'versao' | 'none' = weight != null ? 'manual' : 'none'
    if (weight == null && parts.length) {
      let sum = 0, any = false
      for (const p of parts) {
        const { data: vs } = await supabaseAdmin.from('product_dev_version')
          .select('weight_g, approved, version_number').eq('part_id', p.id).eq('organization_id', orgId)
          .order('version_number', { ascending: false })
        const list = (vs ?? []) as Array<{ weight_g: number | null; approved: boolean }>
        const ref = list.find(v => v.approved) ?? list[0]
        if (ref?.weight_g != null) { sum += Number(ref.weight_g) * Math.max(1, Number(p.qty_per_product) || 1); any = true }
      }
      if (any) { weight = Math.round(sum * 100) / 100; wSource = 'pecas' }
    }
    if (weight == null) {
      const approvedV = (pd.versions ?? []).find(v => v.approved) ?? (pd.versions ?? [])[0]
      if (approvedV?.weight_g != null) { weight = Number(approvedV.weight_g); wSource = 'versao' }
    }

    // ── dimensões ──
    let width = pd.final_width_mm != null ? Number(pd.final_width_mm) : null
    let depth = pd.final_depth_mm != null ? Number(pd.final_depth_mm) : null
    let height = pd.final_height_mm != null ? Number(pd.final_height_mm) : null
    const allManual = width != null && depth != null && height != null
    let dSource: 'manual' | 'pecas' | 'briefing' | 'parcial' | 'none' = allManual ? 'manual' : 'none'
    if (!allManual) {
      if (parts.length) {
        const ws = parts.map(p => Number(p.width_mm) || 0), ds = parts.map(p => Number(p.depth_mm) || 0), hs = parts.map(p => Number(p.height_mm) || 0)
        if (width == null && ws.some(x => x > 0)) width = Math.max(...ws)
        if (depth == null && ds.some(x => x > 0)) depth = Math.max(...ds)
        if (height == null && hs.some(x => x > 0)) height = Math.round(hs.reduce((a, b) => a + b, 0) * 10) / 10
        if (width != null || depth != null || height != null) dSource = 'pecas'
      }
      const bd = (pd.briefing as { dimensoes_mm?: { largura?: number; profundidade?: number; altura?: number } } | null)?.dimensoes_mm
      if (bd) {
        if (width == null && bd.largura) { width = Number(bd.largura) }
        if (depth == null && bd.profundidade) { depth = Number(bd.profundidade) }
        if (height == null && bd.altura) { height = Number(bd.altura) }
        if (dSource === 'none' && (width != null || depth != null || height != null)) dSource = 'briefing'
      }
      if (dSource !== 'none' && !(width != null && depth != null && height != null)) dSource = dSource === 'manual' ? 'manual' : 'parcial'
    }

    return { weight_g: weight, width_mm: width, depth_mm: depth, height_mm: height, weight_source: wSource, dims_source: dSource, parts: parts.length }
  }

  /** Medidas calculadas do produto final + overrides atuais (p/ a tela de ficha). */
  async getMeasures(orgId: string, devId: string) {
    const pd = await this.get(devId, orgId)
    const computed = await this.computeMeasures(orgId, pd)
    return { ...computed, override: { weight_g: pd.final_weight_g ?? null, width_mm: pd.final_width_mm ?? null, depth_mm: pd.final_depth_mm ?? null, height_mm: pd.final_height_mm ?? null } }
  }

  /**
   * Fase 3 — "aprovado → virar anúncio". Cria um SKU real em `products` a
   * partir do product_dev, vincula, semeia estoque das unidades produzidas e
   * (opcional) publica na loja. Reusa ProductsService p/ taxa+vitrine e
   * StockService p/ o estoque. Idempotente (se já tem product_id, no-op).
   */
  async publishToCatalog(id: string, orgId: string, userId: string | null, body: {
    produced_quantity?: number; target_margin_pct?: number
    variation_mode?: 'single' | 'variable'
    variants?: Array<{ id: string; price?: number | null; stock?: number | null }>
    photo_urls?: string[]
  } = {}): Promise<{
    product_id: string; price: number | null; cost_price: number | null; photos: number; stock_seeded: number; storefront: boolean; sku: string | null; mode: 'single' | 'variable'; variants: number; already?: boolean
  }> {
    const pd = await this.get(id, orgId)
    if (pd.product_id) return { product_id: pd.product_id, price: null, cost_price: pd.estimated_cost, photos: 0, stock_seeded: 0, storefront: false, sku: null, mode: 'single', variants: 0, already: true }
    if (pd.status !== 'aprovado') throw new BadRequestException('Só produtos aprovados podem virar anúncio. Aprove uma versão primeiro.')

    // porteiro de licença (Peça 2): importados não-verdes só publicam com liberação
    const lic = pd.license_status
    if (lic.blocked) {
      throw new BadRequestException(
        `Licença bloqueia a publicação: ${lic.verdict?.reason ?? 'modelo importado sem direito comercial/derivado.'} ` +
        `Se você adquiriu licença comercial ou foi autorizado pelo criador, registre a liberação em "Licença & origem".`,
      )
    }

    // gate de qualidade
    const qualityOk = await this.production.isQualityPassed(orgId, id, pd.production_profile)
    if (!qualityOk) throw new BadRequestException('Conclua o checklist de qualidade (aprovado) antes de publicar.')

    // LINHA obrigatória: todo produto precisa pertencer a uma linha de produtos
    // (família). Sem ela, o SKU não fecha e o catálogo fica sem "tipo de produto".
    if (!pd.sku_linha_id) throw new BadRequestException('Defina a LINHA de produtos deste modelo antes de publicar (aba Ficha ou SKU). Se ainda não existe uma linha, crie uma.')
    // CLASSIFICAÇÃO COMPLETA obrigatória: produto não entra no catálogo sem SKU
    // (era o buraco que deixava products.sku = null em produto publicado).
    if (!pd.sku_base) throw new BadRequestException('Complete a classificação do SKU (Marca, Categoria, Sub-categoria, Linha e Característica) na aba SKU antes de publicar.')
    // EAN: gera o que faltar com 1 clique automático (idempotente — não sobrescreve)
    await this.sku.generateEans(orgId, id).catch(() => {})

    // fotos: protótipo aprovado > referências
    // fotos do anúncio: lista escolhida pelo usuário (capa = 1ª) OU, por padrão,
    // combina fotos do protótipo aprovado + reference_images (que inclui as
    // IMAGENS GERADAS pela IA e as importadas do MakerWorld), dedupada.
    const approvedV = pd.versions.find(v => v.approved)
    const defaultPhotos = [...(approvedV?.prototype_photo_urls ?? []), ...(pd.reference_images ?? []).map(r => r.url)].filter(Boolean)
    const photos = (body.photo_urls && body.photo_urls.length ? body.photo_urls : [...new Set(defaultPhotos)]).filter(Boolean)

    // preço: target_price > sugerido do canal primário
    // custo: usa o calculado no projeto (estimated_cost). Se ainda não calcularam,
    // calcula agora (best-effort) — o total alimenta o campo de custo do produto.
    let costPrice: number | null = pd.estimated_cost ?? null
    let price = pd.target_price ?? null
    if (price == null || costPrice == null) {
      const primary = (pd.target_marketplaces ?? [])[0] ?? 'mercado_livre'
      try {
        const c = await this.computeCost(id, orgId, { target_margin_pct: body.target_margin_pct })
        if (costPrice == null) costPrice = c.cost.total
        if (price == null) price = c.suggested_prices.find(s => s.channel === primary)?.price ?? c.suggested_prices[0]?.price ?? null
      } catch { /* segue sem preço/custo */ }
    }

    const tax = await this.products.getTaxConfig(orgId).catch(() => ({ default_tax_percentage: null, default_tax_on_freight: false }))

    // SKU + EAN gerados (Product OS) → fluem pro catálogo. Variantes de cor = unidades vendáveis.
    const { data: skuRow } = await supabaseAdmin.from('product_dev').select('sku_base, ean').eq('id', id).eq('organization_id', orgId).maybeSingle()
    const skuBase = (skuRow as { sku_base: string | null } | null)?.sku_base ?? null
    const baseEan = (skuRow as { ean: string | null } | null)?.ean ?? null
    const { data: varRows } = await supabaseAdmin.from('product_dev_sku_variant')
      .select('id, sku, ean, weight_g, cor:cor_id(label), tamanho:tamanho_id(label)').eq('product_dev_id', id).order('sku')
    const variants = (varRows ?? []).map(v => {
      const r = v as { id: string; sku: string; ean: string | null; weight_g: number | null; cor: { label?: string } | Array<{ label?: string }> | null; tamanho: { label?: string } | Array<{ label?: string }> | null }
      const cor = Array.isArray(r.cor) ? r.cor[0] : r.cor
      const tamanho = Array.isArray(r.tamanho) ? r.tamanho[0] : r.tamanho
      const axes = { corLabel: cor?.label ?? '', tamanhoLabel: tamanho?.label ?? null }
      return { id: r.id, sku: r.sku, ean: r.ean, axes, label: variationValue(axes), hasOwnWeight: r.weight_g != null }
    })
    // modo: só é VARIÁVEL com 2+ combinações vendáveis. Publicar "único" com
    // várias cores criadas perdia as variações (produto nascia só com o SKU
    // base) — mas o inverso também quebra: a aba SKU EXIGE uma cor pra fechar o
    // código, então todo produto chega aqui com ≥1 variante e o limiar em 1
    // fazia produto de cor única nascer `has_variations=true` com uma "variação"
    // só. No ML isso vira anúncio variável inválido (`variations` conflita com
    // `family_name` e o estoque some do nível do item) e o EAN fica preso dentro
    // do array, com `products.ean` nulo. Uma cor = produto único.
    const mode: 'single' | 'variable' = variants.length >= 2 ? 'variable' : 'single'
    // Cor única: o SKU/EAN daquela variante SÃO os do produto (não há outro).
    const soleVariant = mode === 'single' && variants.length === 1 ? variants[0] : null
    const singleQty = Math.max(0, Math.floor(Number(body.produced_quantity) || 0))
    if (variants.length > 1 && body.variation_mode === 'single' && singleQty > 0) {
      throw new BadRequestException('Este produto tem mais de uma variante — informe o estoque por variante (modo variações) em vez de uma quantidade única.')
    }

    // produto variável = 1 produto com variations[] jsonb (1 linha por combinação
    // cor × tamanho), como a aba "Variações" do catálogo (System 1, consumido pelo ML).
    //
    // `type`/`value` são o contrato ANTIGO (string opaca que a UI exibe e a Shopee
    // usa de tier). Com 1 eixo eles saem IDÊNTICOS ao que sempre saíram — é o que
    // garante zero regressão em tudo que já está publicado.
    // `attributes` é aditivo e é a fonte de verdade ESTRUTURADA: "Creme / G" não
    // decompõe, {Cor:'Creme',Tamanho:'G'} sim — é o que um publish futuro no ML vai
    // precisar pra montar attribute_combinations.
    // preço POR VARIANTE: quem tem peso próprio (tamanho) custa diferente e tem
    // que ser precificado no próprio peso. Sem isto o Gota G (321g) e o M (97g)
    // sairiam com o mesmo preço, num produto onde o custo varia ~3x.
    // Precedência: preço digitado pelo usuário > calculado do peso próprio > preço do projeto.
    const priceByVariant = new Map<string, number>()
    if (mode === 'variable' && variants.some(v => v.hasOwnWeight)) {
      try {
        const vc = await this.variantCosts(orgId, id, { target_margin_pct: body.target_margin_pct })
        for (const v of vc.variants) if (!v.fallback && v.price != null) priceByVariant.set(v.id, v.price)
      } catch { /* sem preço por variante → cai no preço do projeto */ }
    }

    const ovById = new Map((body.variants ?? []).map(v => [v.id, v]))
    const axisType = variationType(variants.map(v => v.axes))
    const variationsJson = mode === 'variable' ? variants.map(v => {
      const ov = ovById.get(v.id)
      return {
        id: v.id, type: axisType, value: v.label,
        attributes: variationAttributes(v.axes),
        price: ov?.price != null ? Number(ov.price) : (priceByVariant.get(v.id) ?? price ?? 0),
        stock: ov?.stock != null ? Math.max(0, Math.floor(Number(ov.stock))) : 0,
        sku: v.sku, ean: v.ean,
      }
    }) : []
    const variableStock = variationsJson.reduce((s, r) => s + (Number(r.stock) || 0), 0)

    // Cor única: a tela continua mostrando a linha da variante, então preço e
    // estoque podem ter sido digitados LÁ em vez de no campo único. Aproveita os
    // dois em vez de perder o que o usuário preencheu.
    const soleOv = soleVariant ? ovById.get(soleVariant.id) : undefined
    if (soleOv?.price != null) price = Number(soleOv.price)
    const singleStock = soleOv?.stock != null
      ? Math.max(0, Math.floor(Number(soleOv.stock)))
      : singleQty

    // FICHA de catálogo (transição pronta p/ IA Criativo): usa os campos validados
    // quando existem, senão cai no nome/descrição crus. Preenche as colunas que o
    // checklist de completude (products-completeness) e a IA Criativo/ML consomem:
    // ml_title, brand, description(≥80), attributes, tags, gtin, peso e dimensões.
    const fichaTitle = (pd.catalog_title ?? '').trim() || pd.name
    const fichaDesc = (pd.catalog_description ?? '').trim() || (pd.description ?? '')
    const fichaBrand = (pd.catalog_brand ?? '').trim() || null
    const attrs: Record<string, string> = { ...(pd.catalog_attributes ?? {}) }
    const tags = Array.isArray(pd.catalog_tags) ? pd.catalog_tags : []
    // BULLETS/benefícios da ficha → gravados em DUAS colunas, de propósito:
    //   products.bullets       — campo oficial do catálogo (a vitrine da Loja tem
    //                            seção própria e o ML os junta na descrição via
    //                            composeListingDescription).
    //   products.differentials — é o que a IA CRIATIVO lê. O prefill do catálogo
    //                            (creative.service.getCatalogPrefill) devolve
    //                            `differentials`, e a tela de novo criativo faz
    //                            `cat.differentials.length ? cat.differentials : …`
    //                            → viram `commercial_differentials` nos prompts e
    //                            a linha "- Diferenciais:" no publisher do ML.
    // Sem isto os bullets digitados na ficha MORRIAM no product_dev: o insert
    // gravava attributes/tags/description e simplesmente ignorava os bullets.
    const fichaBullets = (Array.isArray(pd.catalog_bullets) ? pd.catalog_bullets : [])
      .map(b => String(b).trim()).filter(Boolean)
    // peso/dimensões do PRODUTO FINAL (montado, soma das peças) → cadastro logístico do ML
    const meas = await this.computeMeasures(orgId, pd)
    const weightKg = meas.weight_g != null ? Math.round((meas.weight_g / 1000) * 1000) / 1000 : null
    const cm = (mm?: number | null): number | null => (mm != null && mm > 0 ? Math.round((mm / 10) * 10) / 10 : null)

    // categoria: nome-folha da árvore do ML (se escolhida) + o id oficial p/ o ML
    const mlPath = pd.category_ml_path ?? []
    const categoryName = mlPath[mlPath.length - 1]?.name ?? pd.category

    const { data: created, error } = await supabaseAdmin.from('products').insert({
      organization_id: orgId,
      name: fichaTitle,          // Nome do produto = mesmo do Título ML (ficha)
      ml_title: fichaTitle,
      brand: fichaBrand,
      category: categoryName,
      category_ml_id: pd.category_ml_id ?? null,
      description: fichaDesc,
      photo_urls: photos,
      cost_price: costPrice,
      price,
      sku: skuBase,
      // cor única: o EAN vendável é o da variante — sem isto ele ficava só
      // dentro de variations[] e o produto ia pro ML sem código de barras.
      ean: soleVariant?.ean ?? baseEan,
      gtin: soleVariant?.ean ?? baseEan,
      attributes: attrs,
      tags,
      bullets: fichaBullets,
      differentials: fichaBullets,
      weight_kg: weightKg,
      width_cm: cm(meas.width_mm),
      length_cm: cm(meas.depth_mm),
      height_cm: cm(meas.height_mm),
      has_variations: mode === 'variable',
      variations: variationsJson,
      tax_percentage: tax.default_tax_percentage,
      tax_on_freight: tax.default_tax_on_freight,
      status: 'draft',
      condition: 'new',
    }).select('id').maybeSingle()
    if (error || !created) throw new BadRequestException(`Erro ao criar produto no catálogo: ${error?.message ?? 'sem dados'}`)
    const productId = (created as { id: string }).id

    // compare-and-swap no vínculo: se outro publish ganhou a corrida, desfaz o
    // produto recém-criado (senão nasceriam 2 produtos duplicados no catálogo)
    const { data: linked } = await supabaseAdmin.from('product_dev').update({ product_id: productId, status: 'publicado' })
      .eq('id', id).eq('organization_id', orgId).is('product_id', null).select('id')
    if (!linked?.length) {
      await supabaseAdmin.from('products').delete().eq('id', productId).eq('organization_id', orgId)
      const cur = await this.get(id, orgId)
      return { product_id: cur.product_id as string, price: null, cost_price: cur.estimated_cost, photos: 0, stock_seeded: 0, storefront: false, sku: null, mode: 'single', variants: 0, already: true }
    }
    // back-link: cada variante de cor aponta pro produto publicado (acende o selo "publicado")
    if (variants.length) await supabaseAdmin.from('product_dev_sku_variant').update({ product_id: productId }).eq('product_dev_id', id).eq('organization_id', orgId)

    // estoque inicial no LEDGER UNIFICADO: garante a linha mestre (sem ela o
    // Make-to-Order e o crédito de produção viravam no-op silencioso) e lança o
    // estoque semeado como movimento idempotente, propagando products.stock/canais.
    let stockSeeded = 0
    const qty = mode === 'variable' ? variableStock : singleStock
    const { data: master } = await supabaseAdmin.from('product_stock').select('id').eq('product_id', productId).is('platform', null).maybeSingle()
    if (!master) await supabaseAdmin.from('product_stock').insert({ product_id: productId, platform: null, quantity: 0 })
    if (qty > 0) {
      await this.stock.applyProductionRestock({
        productId, quantity: qty, refId: `publish:${id}`,
        note: 'Estoque inicial — publicação Product OS',
      })
      stockSeeded = qty
    }

    // publica na loja se for um canal-alvo
    let storefront = false
    if ((pd.target_marketplaces ?? []).includes('loja')) {
      const res = await this.products.setStorefrontVisibility(orgId, [productId], true).catch(() => ({ updated: 0, skipped: 0 }))
      storefront = res.updated > 0
    }

    await this.emitEvent(orgId, id, 'published', { product_id: productId, sku: skuBase, mode, variants: variants.length }, userId)
    return { product_id: productId, price, cost_price: costPrice, photos: photos.length, stock_seeded: stockSeeded, storefront, sku: skuBase, mode, variants: variants.length }
  }

  /**
   * Gera uma imagem de catálogo do produto aplicando a PALETA de cor escolhida.
   * Recurso PRÓPRIO do Product OS (feature `product_os_image`) — NÃO usa o IA
   * Criativo. Usa o LlmService compartilhado (Nano Banana / gpt-image-1), sobe a
   * imagem no bucket product-os e devolve a URL pública. Se `save`, anexa às
   * imagens de referência do produto.
   */
  async generateImageWithPalette(orgId: string, id: string, body: { palette_id?: string; extra?: string; format?: 'square' | 'story' | 'wide'; save?: boolean; use_reference?: boolean; reference_url?: string; reference_urls?: string[] } = {}) {
    const pd = await this.get(id, orgId)
    // resolve a paleta: explícita > primária da categoria do SKU do produto
    let palette: { name: string; colors: Array<{ hex: string; label?: string }> } | null = null
    if (body.palette_id) {
      const { data } = await supabaseAdmin.from('product_os_palette').select('name, colors').eq('id', body.palette_id).eq('organization_id', orgId).maybeSingle()
      palette = (data as typeof palette) ?? null
    }
    if (!palette) {
      const catId = (pd as { sku_categoria_id?: string | null }).sku_categoria_id
      if (catId) {
        const { data } = await supabaseAdmin.from('product_os_palette').select('name, colors').eq('organization_id', orgId).eq('category_id', catId).eq('is_primary', true).maybeSingle()
        palette = (data as typeof palette) ?? null
      }
    }
    const colors = (palette?.colors ?? []).filter(c => /^#[0-9a-fA-F]{6}$/.test(String(c.hex)))
    const paletteStr = colors.map(c => `${c.label ? c.label + ' ' : ''}${c.hex}`).join(', ')

    const product = `${pd.name}${pd.category ? `, ${pd.category}` : ''}`
    const desc = (pd.briefing_text || pd.description || '').slice(0, 300)

    // imagens de referência disponíveis (prioridade: foto do protótipo aprovado >
    // qualquer protótipo > reference_images — que inclui as fotos/renders do
    // MakerWorld e outros bancos importados). Usadas no modo image-to-image.
    const photos: string[] = []
    const approvedV = (pd.versions ?? []).find(v => v.approved)
    for (const u of approvedV?.prototype_photo_urls ?? []) if (u && !photos.includes(u)) photos.push(u)
    for (const v of pd.versions ?? []) for (const u of v.prototype_photo_urls ?? []) if (u && !photos.includes(u)) photos.push(u)
    for (const r of pd.reference_images ?? []) if (r.url && !photos.includes(r.url)) photos.push(r.url)
    // múltiplas referências: usa o que o usuário escolheu (vários ângulos do MESMO
    // produto, ex. do MakerWorld) ou cai na melhor foto automática. Cap em 4.
    const requested = (body.reference_urls && body.reference_urls.length) ? body.reference_urls : (body.reference_url ? [body.reference_url] : photos.slice(0, 1))
    const refUrls = [...new Set(requested.filter(u => /^https?:\/\//i.test(String(u))))].slice(0, 4)
    const useRef = body.use_reference !== false && refUrls.length > 0
    const multi = refUrls.length > 1

    const prompt = useRef
      ? `A partir d${multi ? 'as fotos' : 'a foto'} de referência do produto${multi ? ` (${refUrls.length} ângulos do MESMO produto)` : ''}, gere UMA foto de catálogo de e-commerce profissional MANTENDO a forma, as proporções e os detalhes reais do produto (impresso em 3D). ` +
        `Fundo branco neutro limpo, iluminação de estúdio suave com sombra sutil, vista em três quartos, alta nitidez, estilo premium comercial. ` +
        (paletteStr ? `Aplique EXATAMENTE esta paleta de cores no produto: ${paletteStr}. ` : 'Mantenha as cores do produto. ') +
        (body.extra ? `${body.extra}. ` : '') + `Sem texto, sem marca d'água, sem pessoas.`
      : `Fotografia de catálogo de e-commerce de ${product}, produto impresso em 3D (FDM), em fundo branco neutro limpo, ` +
        `iluminação de estúdio suave com sombra sutil, vista em três quartos, alta nitidez, estilo premium comercial. ` +
        (desc ? `Detalhes do produto: ${desc}. ` : '') +
        (paletteStr ? `Use EXATAMENTE esta paleta de cores no produto: ${paletteStr}. ` : '') +
        (body.extra ? `${body.extra}. ` : '') + `Sem texto, sem marca d'água, sem pessoas.`

    const out = await this.llm.generateImage({ orgId, feature: 'product_os_image', prompt, format: body.format ?? 'square', n: 1, ...(useRef ? { sourceImageUrls: refUrls } : {}) })
    const img = out.images?.[0]
    if (!img) throw new BadRequestException('A IA não retornou imagem. Tente de novo.')

    let url: string
    if (img.url && img.url.startsWith('http')) {
      url = img.url
    } else if (img.b64) {
      const buffer = Buffer.from(img.b64, 'base64')
      const path = `gen/${id}-${Date.now()}.png`
      const { error } = await supabaseAdmin.storage.from('product-os').upload(path, buffer, { contentType: 'image/png', upsert: true })
      if (error) throw new BadRequestException(`Erro ao salvar imagem: ${error.message}`)
      url = supabaseAdmin.storage.from('product-os').getPublicUrl(path).data.publicUrl
    } else {
      throw new BadRequestException('Imagem vazia')
    }

    if (body.save) {
      const imgs = [...(pd.reference_images ?? []), { url, notes: `IA · paleta ${palette?.name ?? '—'}` }]
      await supabaseAdmin.from('product_dev').update({ reference_images: imgs }).eq('id', id).eq('organization_id', orgId)
    }
    return { url, palette: palette?.name ?? null, colors, provider: out.provider, model: out.model, saved: !!body.save, used_reference: useRef, reference_url: useRef ? refUrls[0] : null, reference_urls: useRef ? refUrls : [], candidates: photos }
  }

  // ─────────────────────────────────────────────────────────────────
  // versões CAD / protótipo
  // ─────────────────────────────────────────────────────────────────

  /** Extrai a IMAGEM DE PREVIEW embutida no .3mf (o Bambu Studio salva o render
   *  do prato em Metadata/plate_*.png) e grava como thumbnail da versão — é a
   *  foto do card de produção. Best-effort: arquivo sem imagem não é erro. */
  async extractVersionThumbnail(orgId: string, versionId: string): Promise<{ thumbnail_url: string | null }> {
    const { data: v } = await supabaseAdmin.from('product_dev_version')
      .select('id, file_url, thumbnail_url').eq('id', versionId).eq('organization_id', orgId).maybeSingle()
    if (!v) throw new BadRequestException('Versão não encontrada')
    const fileUrl = (v as { file_url: string | null }).file_url
    if (!fileUrl || !/\.3mf($|\?)/i.test(fileUrl)) return { thumbnail_url: (v as { thumbnail_url: string | null }).thumbnail_url ?? null }
    let buf: Uint8Array
    try { const res = await fetch(fileUrl); if (!res.ok) throw new Error(`HTTP ${res.status}`); buf = new Uint8Array(await res.arrayBuffer()) } catch { return { thumbnail_url: null } }
    let files: Record<string, Uint8Array>
    try { files = unzipSync(buf) } catch { return { thumbnail_url: null } }
    // preferência: render do prato > sem luz > pequeno > topo > thumbnail genérica do 3MF
    const keys = Object.keys(files)
    const pick = keys.find(k => /Metadata\/plate_\d+\.png$/i.test(k))
      ?? keys.find(k => /Metadata\/plate_no_light_\d+\.png$/i.test(k))
      ?? keys.find(k => /Metadata\/plate_\d+_small\.png$/i.test(k))
      ?? keys.find(k => /Metadata\/top_\d+\.png$/i.test(k))
      ?? keys.find(k => /thumbnail\.png$/i.test(k))
    if (!pick || !files[pick]?.length) return { thumbnail_url: null }
    const path = `thumbs/${orgId}/${versionId}.png`
    const { error: upErr } = await supabaseAdmin.storage.from('product-os').upload(path, Buffer.from(files[pick]), { contentType: 'image/png', upsert: true })
    if (upErr) { this.logger.warn(`[thumb] upload falhou v=${versionId.slice(0, 8)}: ${upErr.message}`); return { thumbnail_url: null } }
    const url = supabaseAdmin.storage.from('product-os').getPublicUrl(path).data.publicUrl
    await supabaseAdmin.from('product_dev_version').update({ thumbnail_url: url }).eq('id', versionId).eq('organization_id', orgId)
    return { thumbnail_url: url }
  }

  /** Gera thumbnail pra TODAS as versões .3mf da org que ainda não têm (1 vez). */
  async backfillThumbnails(orgId: string): Promise<{ processed: number; ok: number }> {
    const { data } = await supabaseAdmin.from('product_dev_version')
      .select('id').eq('organization_id', orgId).ilike('file_url', '%.3mf%').is('thumbnail_url', null).limit(100)
    const rows = (data ?? []) as Array<{ id: string }>
    let ok = 0
    for (const r of rows) { try { const t = await this.extractVersionThumbnail(orgId, r.id); if (t.thumbnail_url) ok++ } catch { /* segue */ } }
    return { processed: rows.length, ok }
  }

  async listVersions(productDevId: string, orgId: string): Promise<ProductDevVersion[]> {
    const { data, error } = await supabaseAdmin
      .from('product_dev_version').select('*')
      .eq('product_dev_id', productDevId).eq('organization_id', orgId)
      .is('part_id', null)   // só versões do PRODUTO INTEIRO; versões de peça vivem no módulo de peças
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
    // .3mf tem o render do prato embutido → vira a foto do card de produção (best-effort)
    if (v.file_url && /\.3mf($|\?)/i.test(v.file_url)) void this.extractVersionThumbnail(orgId, v.id).catch(() => {})
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

  async updateVersion(versionId: string, orgId: string, patch: Partial<ProductDevVersion>): Promise<ProductDevVersion> {
    const allowed: (keyof ProductDevVersion)[] = ['changelog', 'file_url', 'file_type', 'material', 'weight_g', 'print_time_minutes', 'volume_cm3', 'prototype_photo_urls', 'notes', 'plate_composition']
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('product_dev_version').update(safe)
      .eq('id', versionId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    // trocou o arquivo por um .3mf novo → re-extrai o preview do prato
    if (typeof safe.file_url === 'string' && /\.3mf($|\?)/i.test(safe.file_url)) void this.extractVersionThumbnail(orgId, versionId).catch(() => {})
    return data as ProductDevVersion
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
    const result = await this.costFor(orgId, settings, {
      weight_g: weight, print_time_minutes: minutes, material, target_margin_pct: body.target_margin_pct,
    })
    // cacheia o custo (total) + o detalhamento completo no projeto (persiste na tela)
    await supabaseAdmin.from('product_dev')
      .update({ estimated_cost: result.cost.total, cost_breakdown: { ...result, computed_at: new Date().toISOString() } })
      .eq('id', productDevId).eq('organization_id', orgId)

    return result
  }

  /**
   * Custo de UM conjunto peso/tempo/material — SEM persistir nada.
   *
   * Existe separado do `computeCost` porque ele grava `estimated_cost` no
   * product_dev: chamá-lo por variante deixaria o custo do PROJETO valendo o da
   * última variante calculada, em silêncio. Aqui é cálculo puro, seguro de
   * rodar N vezes (1 por tamanho).
   */
  private async costFor(orgId: string, settings: Awaited<ReturnType<ProductOsService['getSettings']>>, body: {
    weight_g?: number | null; print_time_minutes?: number | null; material?: string | null; target_margin_pct?: number
  }): Promise<{
    cost: { filament: number; energy: number; labor: number; packaging: number; waste: number; total: number }
    inputs: { weight_g: number; print_time_minutes: number; material: string; cost_per_kg: number }
    target_margin_pct: number
    suggested_prices: Array<{ channel: string; fee_pct: number; price: number; margin_pct: number }>
  }> {
    const w = Math.max(0, Number(body.weight_g) || 0)
    const min = Math.max(0, Number(body.print_time_minutes) || 0)
    const mat = (body.material || 'PLA').toUpperCase()
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

    return {
      cost: { filament, energy, labor, packaging, waste, total },
      inputs: { weight_g: w, print_time_minutes: min, material: mat, cost_per_kg: costPerKg },
      target_margin_pct: targetMargin,
      suggested_prices: suggested,
    }
  }

  /**
   * Custo e preço sugerido de CADA variante, usando o peso/tempo próprios dela.
   *
   * É o que faz o eixo de tamanho valer: Pendente Gota G (321g/25h) e M
   * (97g/8,4h) custam ~3x diferente. Sem isto, os dois sairiam com o MESMO
   * preço — o do projeto.
   *
   * Variante sem peso próprio cai no peso da versão de referência do projeto
   * (`fallback: true`), que é o comportamento de antes.
   */
  async variantCosts(orgId: string, devId: string, body: { target_margin_pct?: number } = {}): Promise<{
    channel: string
    variants: Array<{
      id: string; sku: string; cor: string | null; tamanho: string | null
      weight_g: number | null; print_time_minutes: number | null
      fallback: boolean; cost_total: number; price: number | null
    }>
  }> {
    const pd = await this.get(devId, orgId)
    const settings = await this.getSettings(orgId)
    const channel = (pd.target_marketplaces ?? [])[0] ?? 'mercado_livre'

    // peso/tempo do projeto (versão aprovada > última) = fallback de quem não tem o próprio
    const versions = await this.listVersions(devId, orgId)
    const ref = versions.find(v => v.approved) ?? versions[0]

    const { data: rows } = await supabaseAdmin.from('product_dev_sku_variant')
      .select('id, sku, weight_g, print_time_minutes, cor:cor_id(label), tamanho:tamanho_id(label)')
      .eq('product_dev_id', devId).eq('organization_id', orgId).order('sku')

    const out = []
    for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
      const cor = Array.isArray(r.cor) ? r.cor[0] : r.cor
      const tam = Array.isArray(r.tamanho) ? r.tamanho[0] : r.tamanho
      const ownW = r.weight_g != null ? Number(r.weight_g) : null
      const ownT = r.print_time_minutes != null ? Number(r.print_time_minutes) : null
      const fallback = ownW == null
      const c = await this.costFor(orgId, settings, {
        weight_g: ownW ?? ref?.weight_g ?? null,
        print_time_minutes: ownT ?? ref?.print_time_minutes ?? null,
        material: ref?.material ?? null,
        target_margin_pct: body.target_margin_pct,
      })
      out.push({
        id: String(r.id), sku: String(r.sku),
        cor: (cor as { label?: string } | null)?.label ?? null,
        tamanho: (tam as { label?: string } | null)?.label ?? null,
        weight_g: ownW, print_time_minutes: ownT, fallback,
        cost_total: c.cost.total,
        price: c.suggested_prices.find(s => s.channel === channel)?.price ?? c.suggested_prices[0]?.price ?? null,
      })
    }
    return { channel, variants: out }
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

const CATALOG_SYSTEM_PROMPT = `Você é um especialista em cadastro de produtos para marketplaces brasileiros
(Mercado Livre, Shopee) e loja própria, focado em produtos DECORATIVOS e
UTILITÁRIOS impressos em 3D (decoração, organização, suportes de maquiagem,
utensílios). Escreve em PT-BR, comercial, honesto e otimizado para busca.

REGRAS:
- Título: até 60 caracteres, começa pelo tipo do produto + atributo forte; sem CAIXA ALTA gritante, sem emoji, sem "frete grátis".
- Descrição: benefícios concretos + uso + material (impresso em 3D, PLA por padrão) + dimensões quando houver; parágrafos curtos; sem promessas falsas.
- Reaproveite a taxonomia existente informada (não crie sinônimos novos se já existe um nível equivalente).
- Atributos: só o que dá pra inferir com segurança (Material, Cor, Tipo de produto, Público, Ambiente). Não invente medidas exatas.
- Saída JSON puro, sem markdown wrapper.`

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
