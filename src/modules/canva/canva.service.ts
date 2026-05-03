import {
  Injectable, Logger, BadRequestException, NotFoundException,
  HttpException, HttpStatus,
} from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { CanvaOauthService } from '../canva-oauth/canva-oauth.service'

/** Sprint F5-2 / Batch 2.1 — Canva designs/exports/assets.
 *
 * Complementa CanvaOauthService (que cuida de OAuth/PKCE/refresh).
 * Esse service implementa o que A API PÚBLICA do Canva Connect oferece:
 *   ✓ Listar designs do seller (/v1/designs)
 *   ✓ Get design + pages
 *   ✓ Export design (/v1/exports) com poll do job
 *   ✓ Upload imagem do produto + criar design custom (delegated to CanvaOauthService)
 *   ✓ Mirror das exports pra Supabase Storage (URLs Canva expiram em ~24h)
 *
 * NÃO implementa (não há API pública):
 *   ✗ Buscar templates da galeria pública por categoria
 *   ✗ Magic Design (geração via IA do Canva)
 *   ✗ Brand kits (Enterprise plan only)
 *
 * Pra geração via IA, o produto usa LlmService.generateImage (gpt-image-1).
 */

const CANVA_API_BASE = 'https://api.canva.com/rest/v1'
const STORAGE_BUCKET = 'canva-exports'
const MAX_CONCURRENT_EXPORTS = 3
const EXPORT_POLL_INTERVAL_MS = 2_000
const EXPORT_TIMEOUT_MS = 30_000

export const MARKETPLACE_DIMS = {
  ml_produto:        { w: 1200, h: 1200, label: 'Mercado Livre — Produto' },
  ml_banner:         { w: 1200, h: 628,  label: 'Mercado Livre — Banner' },
  shopee_produto:    { w: 1080, h: 1080, label: 'Shopee — Produto' },
  amazon_produto:    { w: 2000, h: 2000, label: 'Amazon — Produto' },
  magalu_produto:    { w: 1000, h: 1000, label: 'Magalu — Produto' },
  instagram_feed:    { w: 1080, h: 1080, label: 'Instagram — Feed' },
  instagram_story:   { w: 1080, h: 1920, label: 'Instagram — Story' },
  facebook_post:     { w: 1200, h: 630,  label: 'Facebook — Post' },
  facebook_cover:    { w: 820,  h: 312,  label: 'Facebook — Capa' },
  youtube_thumbnail: { w: 1280, h: 720,  label: 'YouTube — Thumbnail' },
  whatsapp_status:   { w: 1080, h: 1920, label: 'WhatsApp — Status' },
} as const

export type MarketplaceKey = keyof typeof MARKETPLACE_DIMS
export type ExportFormat = 'png' | 'jpg' | 'pdf'

export interface CanvaDesignSummary {
  id: string
  title: string
  thumbnail_url: string | null
  edit_url: string
  page_count: number
  updated_at: string
}

export interface CanvaAssetRow {
  id: string
  organization_id: string
  user_id: string | null
  canva_design_id: string
  canva_export_job_id: string | null
  name: string
  format: ExportFormat
  width: number | null
  height: number | null
  marketplace: string | null
  thumbnail_url: string | null
  storage_path: string | null
  storage_url: string | null
  edit_url: string | null
  product_id: string | null
  campaign_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

@Injectable()
export class CanvaService {
  private readonly logger = new Logger(CanvaService.name)
  /** Semáforo in-memory: orgId → exports em andamento. Limite 3/org. */
  private readonly exportSemaphore = new Map<string, number>()

  constructor(private readonly canvaOauth: CanvaOauthService) {}

  // ── Helpers ────────────────────────────────────────────────────────────

  private async authedClient(orgId: string): Promise<{ token: string }> {
    const token = await this.canvaOauth.getValidAccessToken(orgId)
    if (!token) {
      throw new BadRequestException('Conecte sua conta Canva nas Integrações antes de continuar.')
    }
    return { token }
  }

  private logCanvaError(endpoint: string, e: unknown): void {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status ?? 'no-status'
      const body = JSON.stringify(e.response?.data ?? {}).slice(0, 500)
      this.logger.error(`[canva.${endpoint}] status=${status} body=${body}`)
    } else {
      this.logger.error(`[canva.${endpoint}] erro: ${(e as Error).message}`)
    }
  }

  private canvaErrorToHttp(endpoint: string, e: unknown): HttpException {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status
      const data = e.response?.data as { message?: string; error?: string; code?: string } | undefined
      const msg = data?.message || data?.error || data?.code || 'erro desconhecido'
      if (status === 404) return new NotFoundException(`Canva ${endpoint}: ${msg}`)
      return new BadRequestException(`Canva ${endpoint} ${status ?? '?'}: ${msg}`)
    }
    return new BadRequestException(`Canva ${endpoint}: ${(e as Error).message}`)
  }

  private acquireExportSlot(orgId: string): void {
    const current = this.exportSemaphore.get(orgId) ?? 0
    if (current >= MAX_CONCURRENT_EXPORTS) {
      throw new HttpException(
        `Já há ${MAX_CONCURRENT_EXPORTS} exports em andamento. Aguarde alguns segundos.`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    this.exportSemaphore.set(orgId, current + 1)
  }

  private releaseExportSlot(orgId: string): void {
    const current = this.exportSemaphore.get(orgId) ?? 0
    if (current <= 1) this.exportSemaphore.delete(orgId)
    else this.exportSemaphore.set(orgId, current - 1)
  }

  // ── Marketplace dims (pro frontend renderizar select) ──────────────────

  listMarketplaceDims(): Array<{ key: MarketplaceKey; w: number; h: number; label: string }> {
    return (Object.entries(MARKETPLACE_DIMS) as Array<[MarketplaceKey, typeof MARKETPLACE_DIMS[MarketplaceKey]]>)
      .map(([key, v]) => ({ key, w: v.w, h: v.h, label: v.label }))
  }

  // ── Designs do seller ──────────────────────────────────────────────────

  async listDesigns(
    orgId: string,
    opts: { query?: string; continuation?: string } = {},
  ): Promise<{ items: CanvaDesignSummary[]; continuation: string | null }> {
    const { token } = await this.authedClient(orgId)
    const params: Record<string, string> = {}
    if (opts.query)        params.query = opts.query
    if (opts.continuation) params.continuation = opts.continuation

    try {
      const res = await axios.get<{
        items: Array<{
          id: string
          title?: string
          thumbnail?: { url?: string }
          urls: { edit_url: string; view_url?: string }
          page_count?: number
          updated_at?: string
        }>
        continuation?: string
      }>(`${CANVA_API_BASE}/designs`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
        timeout: 15_000,
      })

      const items: CanvaDesignSummary[] = (res.data.items ?? []).map(d => ({
        id: d.id,
        title: d.title ?? 'Sem título',
        thumbnail_url: d.thumbnail?.url ?? null,
        edit_url: d.urls.edit_url,
        page_count: d.page_count ?? 1,
        updated_at: d.updated_at ?? new Date().toISOString(),
      }))
      return { items, continuation: res.data.continuation ?? null }
    } catch (e) {
      this.logCanvaError('designs.list', e)
      throw this.canvaErrorToHttp('designs.list', e)
    }
  }

  async getDesign(orgId: string, designId: string): Promise<CanvaDesignSummary & { view_url: string | null }> {
    const { token } = await this.authedClient(orgId)
    try {
      const res = await axios.get<{
        design: {
          id: string
          title?: string
          thumbnail?: { url?: string }
          urls: { edit_url: string; view_url?: string }
          page_count?: number
          updated_at?: string
        }
      }>(`${CANVA_API_BASE}/designs/${encodeURIComponent(designId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      })
      const d = res.data.design
      return {
        id: d.id,
        title: d.title ?? 'Sem título',
        thumbnail_url: d.thumbnail?.url ?? null,
        edit_url: d.urls.edit_url,
        view_url: d.urls.view_url ?? null,
        page_count: d.page_count ?? 1,
        updated_at: d.updated_at ?? new Date().toISOString(),
      }
    } catch (e) {
      this.logCanvaError(`designs.get`, e)
      throw this.canvaErrorToHttp(`designs.get`, e)
    }
  }

  async getDesignPages(
    orgId: string,
    designId: string,
  ): Promise<Array<{ index: number; thumbnail_url: string | null }>> {
    const { token } = await this.authedClient(orgId)
    try {
      const res = await axios.get<{
        items: Array<{ index: number; thumbnail?: { url?: string } }>
      }>(`${CANVA_API_BASE}/designs/${encodeURIComponent(designId)}/pages`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      })
      return (res.data.items ?? []).map(p => ({
        index: p.index,
        thumbnail_url: p.thumbnail?.url ?? null,
      }))
    } catch (e) {
      this.logCanvaError(`designs.pages`, e)
      throw this.canvaErrorToHttp(`designs.pages`, e)
    }
  }

  // ── Export (com mirror pro Storage) ────────────────────────────────────

  async exportDesign(
    orgId: string,
    userId: string | null,
    params: {
      designId: string
      format: ExportFormat
      productId?: string
      campaignId?: string
      marketplace?: MarketplaceKey
      name?: string
    },
  ): Promise<CanvaAssetRow> {
    const { designId, format, productId, campaignId, marketplace } = params

    if (!['png', 'jpg', 'pdf'].includes(format)) {
      throw new BadRequestException(`Formato inválido: ${format}. Use png, jpg ou pdf.`)
    }
    if (marketplace && !(marketplace in MARKETPLACE_DIMS)) {
      throw new BadRequestException(
        `Marketplace inválido. Válidos: ${Object.keys(MARKETPLACE_DIMS).join(', ')}`,
      )
    }

    this.acquireExportSlot(orgId)
    try {
      const { token } = await this.authedClient(orgId)

      // 1. Get design (pra título + thumbnail)
      const design = await this.getDesign(orgId, designId)
      const assetName = params.name ?? design.title

      // 2. Cria export job
      let exportJobId: string
      try {
        const jobRes = await axios.post<{
          job: { id: string; status: 'in_progress' | 'success' | 'failed'; urls?: string[]; error?: { message?: string } }
        }>(
          `${CANVA_API_BASE}/exports`,
          {
            design_id: designId,
            format: { type: format, quality: format === 'pdf' ? 'standard' : undefined },
          },
          {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 30_000,
          },
        )
        exportJobId = jobRes.data.job.id
        // Edge case: se já voltou success no primeiro shot
        if (jobRes.data.job.status === 'success' && jobRes.data.job.urls?.[0]) {
          return await this.persistExport(orgId, userId, {
            designId, exportJobId, format, marketplace, assetName,
            sourceUrl: jobRes.data.job.urls[0],
            thumbnailUrl: design.thumbnail_url,
            editUrl: design.edit_url,
            productId, campaignId,
          })
        }
      } catch (e) {
        this.logCanvaError('exports.create', e)
        throw this.canvaErrorToHttp('exports.create', e)
      }

      // 3. Poll
      const start = Date.now()
      let resultUrl: string | null = null
      while (Date.now() - start < EXPORT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, EXPORT_POLL_INTERVAL_MS))
        try {
          const pollRes = await axios.get<{
            job: { id: string; status: 'in_progress' | 'success' | 'failed'; urls?: string[]; error?: { message?: string } }
          }>(`${CANVA_API_BASE}/exports/${encodeURIComponent(exportJobId)}`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
          })
          const j = pollRes.data.job
          if (j.status === 'success') {
            resultUrl = j.urls?.[0] ?? null
            break
          }
          if (j.status === 'failed') {
            throw new BadRequestException(`Export falhou: ${j.error?.message ?? 'erro desconhecido'}`)
          }
          // in_progress → continua
        } catch (e) {
          if (e instanceof BadRequestException) throw e
          this.logCanvaError(`exports.poll`, e)
          // erro transient — tenta de novo até timeout
        }
      }
      if (!resultUrl) {
        throw new HttpException(
          'Export demorou mais que 30s. Tente novamente em alguns instantes.',
          HttpStatus.GATEWAY_TIMEOUT,
        )
      }

      // 4. Persist (download + Storage + DB)
      return await this.persistExport(orgId, userId, {
        designId, exportJobId, format, marketplace, assetName,
        sourceUrl: resultUrl,
        thumbnailUrl: design.thumbnail_url,
        editUrl: design.edit_url,
        productId, campaignId,
      })
    } finally {
      this.releaseExportSlot(orgId)
    }
  }

  /** Baixa o arquivo do Canva, sobe pro Storage, INSERTa em canva_assets. */
  private async persistExport(
    orgId: string,
    userId: string | null,
    p: {
      designId: string
      exportJobId: string
      format: ExportFormat
      marketplace?: MarketplaceKey
      assetName: string
      sourceUrl: string
      thumbnailUrl: string | null
      editUrl: string
      productId?: string
      campaignId?: string
    },
  ): Promise<CanvaAssetRow> {
    // 1. Download
    let buf: Buffer
    let contentType: string
    try {
      const dl = await axios.get<ArrayBuffer>(p.sourceUrl, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })
      buf = Buffer.from(dl.data)
      contentType = (dl.headers['content-type'] as string) ?? `image/${p.format}`
    } catch (e) {
      this.logger.error(`[canva.download] falhou jobId=${p.exportJobId} url=${p.sourceUrl.slice(0, 80)}`)
      throw new BadRequestException(`Não foi possível baixar o export: ${(e as Error).message}`)
    }

    // 2. Validate marketplace ownership
    if (p.productId) await this.assertProductInOrg(orgId, p.productId)
    if (p.campaignId) await this.assertCampaignInOrg(orgId, p.campaignId)

    // 3. Upload Storage
    const ext = p.format === 'jpg' ? 'jpg' : p.format
    const storagePath = `${orgId}/${p.designId}-${Date.now()}.${ext}`
    const { error: upErr } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buf, { contentType, upsert: true })
    if (upErr) {
      this.logger.error(`[canva.storage.upload] falhou: ${upErr.message}`)
      throw new HttpException(`Falha ao salvar export no Storage: ${upErr.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    }
    const { data: pub } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
    const storageUrl = pub.publicUrl

    // 4. Insert DB
    const dims = p.marketplace ? MARKETPLACE_DIMS[p.marketplace] : null
    const { data: row, error: insErr } = await supabaseAdmin
      .from('canva_assets')
      .insert({
        organization_id: orgId,
        user_id: userId,
        canva_design_id: p.designId,
        canva_export_job_id: p.exportJobId,
        name: p.assetName,
        format: p.format,
        width: dims?.w ?? null,
        height: dims?.h ?? null,
        marketplace: p.marketplace ?? null,
        thumbnail_url: p.thumbnailUrl,
        storage_path: storagePath,
        storage_url: storageUrl,
        edit_url: p.editUrl,
        product_id: p.productId ?? null,
        campaign_id: p.campaignId ?? null,
      })
      .select('*')
      .single()
    if (insErr || !row) {
      this.logger.error(`[canva.db.insert] falhou: ${insErr?.message}`)
      // Cleanup do Storage pra não deixar lixo
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => undefined)
      throw new HttpException(`Falha ao registrar asset: ${insErr?.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    }
    this.logger.log(`[canva.export] org=${orgId} design=${p.designId} → asset=${row.id}`)
    return row as CanvaAssetRow
  }

  // ── Criar capa de produto (sobe imagem + abre editor) ──────────────────

  async createProductImageDesign(
    orgId: string,
    productId: string,
    params: { marketplace: MarketplaceKey; sourceImageUrl?: string },
  ): Promise<{ edit_url: string; design_id: string; asset_id: string }> {
    if (!(params.marketplace in MARKETPLACE_DIMS)) {
      throw new BadRequestException(
        `Marketplace inválido. Válidos: ${Object.keys(MARKETPLACE_DIMS).join(', ')}`,
      )
    }
    const dims = MARKETPLACE_DIMS[params.marketplace]

    // Lookup product (org-scoped)
    const { data: product, error } = await supabaseAdmin
      .from('products')
      .select('id, name, ml_title, photo_urls')
      .eq('organization_id', orgId)
      .eq('id', productId)
      .maybeSingle()
    if (error) throw new HttpException(`Erro ao buscar produto: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    if (!product) throw new NotFoundException('Produto não encontrado')

    const sourceImageUrl =
      params.sourceImageUrl ??
      ((product.photo_urls as string[] | null)?.[0])
    if (!sourceImageUrl) {
      throw new BadRequestException('Produto sem imagem. Adicione uma foto antes ou informe sourceImageUrl.')
    }

    const title = (product.ml_title as string) || (product.name as string) || 'Produto e-Click'

    return this.canvaOauth.uploadAndOpenDesign(orgId, {
      imageUrl: sourceImageUrl,
      imageName: `${productId}.png`,
      width: dims.w,
      height: dims.h,
      title: `${title} — ${dims.label}`,
    })
  }

  // ── Galeria local de canva_assets ──────────────────────────────────────

  async listAssets(
    orgId: string,
    filters: {
      productId?: string
      campaignId?: string
      marketplace?: string
      limit?: number
      offset?: number
    } = {},
  ): Promise<{ items: CanvaAssetRow[]; total: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
    const offset = Math.max(filters.offset ?? 0, 0)

    let query = supabaseAdmin
      .from('canva_assets')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (filters.productId)   query = query.eq('product_id', filters.productId)
    if (filters.campaignId)  query = query.eq('campaign_id', filters.campaignId)
    if (filters.marketplace) query = query.eq('marketplace', filters.marketplace)

    const { data, count, error } = await query
    if (error) throw new HttpException(`Erro ao listar assets: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    return { items: (data ?? []) as CanvaAssetRow[], total: count ?? 0 }
  }

  async getAsset(orgId: string, assetId: string): Promise<CanvaAssetRow> {
    const { data, error } = await supabaseAdmin
      .from('canva_assets')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', assetId)
      .maybeSingle()
    if (error) throw new HttpException(`Erro ao buscar asset: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    if (!data)  throw new NotFoundException('Asset não encontrado')
    return data as CanvaAssetRow
  }

  async deleteAsset(orgId: string, assetId: string): Promise<void> {
    const asset = await this.getAsset(orgId, assetId)
    if (asset.storage_path) {
      const { error: rmErr } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove([asset.storage_path])
      if (rmErr) this.logger.warn(`[canva.delete] storage remove falhou: ${rmErr.message}`)
    }
    const { error } = await supabaseAdmin
      .from('canva_assets')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', assetId)
    if (error) throw new HttpException(`Erro ao remover asset: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    this.logger.log(`[canva.delete] org=${orgId} asset=${assetId}`)
  }

  // ── Disconnect ─────────────────────────────────────────────────────────

  async disconnect(orgId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('api_credentials')
      .delete()
      .eq('organization_id', orgId)
      .eq('provider', 'canva')
      .eq('key_name', 'CANVA_OAUTH_TOKEN')
    if (error) throw new HttpException(`Erro ao desconectar: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR)
    this.logger.log(`[canva.disconnect] org=${orgId}`)
    return { ok: true }
  }

  // ── Validações de ownership ────────────────────────────────────────────

  private async assertProductInOrg(orgId: string, productId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', productId)
      .maybeSingle()
    if (error) throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR)
    if (!data)  throw new NotFoundException('Produto não pertence à sua organização')
  }

  private async assertCampaignInOrg(orgId: string, campaignId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle()
    if (error) throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR)
    if (!data)  throw new NotFoundException('Campanha não pertence à sua organização')
  }
}
