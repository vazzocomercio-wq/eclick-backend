import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Campanhas de promoção — agrupam N produtos com desconto comum +
 *  override individual + janela start/end + badge.
 *
 *  Fluxo:
 *   1. createCampaign(orgId, dto) — cria entidade
 *   2. addProducts(campaignId, productIds[]) — bulk
 *   3. setProductOverride(campaignId, productId, { pct? | sale_price? })
 *   4. applyCampaign(campaignId) — escreve sale_price em todos produtos
 *      respeitando override > default_discount_pct. Atualiza
 *      applied_at + applied_count.
 *   5. unapplyCampaign(campaignId) — limpa sale_price dos produtos atrelados.
 */

export interface PromotionCampaign {
  id:                   string
  organization_id:      string
  name:                 string
  description:          string | null
  default_discount_pct: number
  badge_text:           string | null
  starts_at:            string | null
  ends_at:              string | null
  active:               boolean
  applied_at:           string | null
  applied_count:        number
  created_at:           string
  updated_at:           string
}

export interface CampaignProduct {
  id:                       string
  campaign_id:              string
  product_id:               string
  discount_pct_override:    number | null
  sale_price_override:      number | null
  added_at:                 string
}

@Injectable()
export class PromotionCampaignsService {
  private readonly logger = new Logger(PromotionCampaignsService.name)

  // ── CRUD campanhas ────────────────────────────────────────────────

  async list(orgId: string): Promise<Array<PromotionCampaign & { product_count: number }>> {
    const { data, error } = await supabaseAdmin
      .from('promotion_campaigns')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const campaigns = (data ?? []) as unknown as PromotionCampaign[]
    if (campaigns.length === 0) return []

    // Contagem de produtos por campanha (1 query)
    const ids = campaigns.map(c => c.id)
    const { data: counts } = await supabaseAdmin
      .from('promotion_campaign_products')
      .select('campaign_id')
      .in('campaign_id', ids)
    const countMap = new Map<string, number>()
    for (const r of (counts ?? []) as Array<{ campaign_id: string }>) {
      countMap.set(r.campaign_id, (countMap.get(r.campaign_id) ?? 0) + 1)
    }
    return campaigns.map(c => ({ ...c, product_count: countMap.get(c.id) ?? 0 }))
  }

  async get(orgId: string, id: string): Promise<{ campaign: PromotionCampaign; products: Array<CampaignProduct & {
    product?: { id: string; name: string; sku: string | null; price: number; photo_urls: string[] | null }
  }> }> {
    const { data, error } = await supabaseAdmin
      .from('promotion_campaigns').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Campanha não encontrada')

    const { data: pcRows } = await supabaseAdmin
      .from('promotion_campaign_products')
      .select('*')
      .eq('campaign_id', id)
      .order('added_at', { ascending: false })

    const productIds = ((pcRows ?? []) as CampaignProduct[]).map(r => r.product_id)
    let productMap = new Map<string, { id: string; name: string; sku: string | null; price: number; photo_urls: string[] | null }>()
    if (productIds.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, name, sku, price, photo_urls')
        .in('id', productIds)
        .eq('organization_id', orgId)
      productMap = new Map(((prods ?? []) as Array<{ id: string; name: string; sku: string | null; price: number; photo_urls: string[] | null }>)
        .map(p => [p.id, p]))
    }
    const products = ((pcRows ?? []) as CampaignProduct[]).map(r => ({
      ...r,
      product: productMap.get(r.product_id),
    }))

    return { campaign: data as unknown as PromotionCampaign, products }
  }

  async create(orgId: string, dto: Partial<PromotionCampaign>): Promise<PromotionCampaign> {
    if (!dto.name?.trim()) throw new BadRequestException('name obrigatório')
    if (!dto.default_discount_pct || dto.default_discount_pct <= 0 || dto.default_discount_pct >= 100) {
      throw new BadRequestException('default_discount_pct deve ser entre 1 e 99')
    }
    const { data, error } = await supabaseAdmin
      .from('promotion_campaigns')
      .insert({
        organization_id:      orgId,
        name:                 dto.name.trim(),
        description:          dto.description ?? null,
        default_discount_pct: dto.default_discount_pct,
        badge_text:           dto.badge_text ?? null,
        starts_at:            dto.starts_at ?? null,
        ends_at:              dto.ends_at ?? null,
        active:               dto.active ?? true,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return data as unknown as PromotionCampaign
  }

  async update(orgId: string, id: string, patch: Partial<PromotionCampaign>): Promise<PromotionCampaign> {
    const fields: Record<string, unknown> = {}
    const allowed: (keyof PromotionCampaign)[] = ['name', 'description', 'default_discount_pct',
      'badge_text', 'starts_at', 'ends_at', 'active']
    for (const k of allowed) if (k in patch) fields[k] = patch[k]
    if (Object.keys(fields).length === 0) throw new BadRequestException('Nada pra atualizar')

    const { data, error } = await supabaseAdmin
      .from('promotion_campaigns').update(fields)
      .eq('id', id).eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as unknown as PromotionCampaign
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    // Desaplica primeiro (limpa sale_price dos produtos) antes do CASCADE
    await this.unapply(orgId, id).catch(() => undefined)
    const { error } = await supabaseAdmin
      .from('promotion_campaigns').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── Produtos da campanha ──────────────────────────────────────────

  async addProducts(orgId: string, campaignId: string, productIds: string[]): Promise<{ added: number }> {
    // Garante que a campanha existe e pertence à org
    await this.assertOwned(orgId, campaignId)
    if (productIds.length === 0) return { added: 0 }

    // INSERT com ON CONFLICT DO NOTHING (UNIQUE no schema previne duplicados)
    const rows = productIds.map(pid => ({ campaign_id: campaignId, product_id: pid }))
    const { error, count } = await supabaseAdmin
      .from('promotion_campaign_products')
      .upsert(rows, { onConflict: 'campaign_id,product_id', ignoreDuplicates: true, count: 'exact' })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { added: count ?? 0 }
  }

  async removeProduct(orgId: string, campaignId: string, productId: string): Promise<{ ok: true }> {
    await this.assertOwned(orgId, campaignId)
    // Limpa sale_price do produto SE veio dessa campanha (best-effort:
    // limpa direto — se outro source setou, lojista re-aplica)
    await supabaseAdmin.from('products')
      .update({ sale_price: null, sale_start_at: null, sale_end_at: null, sale_badge_text: null })
      .eq('id', productId).eq('organization_id', orgId)
    const { error } = await supabaseAdmin
      .from('promotion_campaign_products').delete()
      .eq('campaign_id', campaignId).eq('product_id', productId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  async setProductOverride(orgId: string, campaignId: string, productId: string, patch: {
    discount_pct_override?:  number | null
    sale_price_override?:    number | null
  }): Promise<{ ok: true }> {
    await this.assertOwned(orgId, campaignId)
    const fields: Record<string, unknown> = {}
    if ('discount_pct_override' in patch) fields.discount_pct_override = patch.discount_pct_override
    if ('sale_price_override'   in patch) fields.sale_price_override   = patch.sale_price_override
    if (Object.keys(fields).length === 0) return { ok: true }
    const { error } = await supabaseAdmin
      .from('promotion_campaign_products').update(fields)
      .eq('campaign_id', campaignId).eq('product_id', productId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── Apply / Unapply ───────────────────────────────────────────────

  /** Escreve sale_price em cada produto da campanha. Override > default.
   *  Janela + badge vêm da própria campanha. Idempotente — pode rodar
   *  N vezes. */
  async apply(orgId: string, campaignId: string): Promise<{ updated: number; skipped: number }> {
    const { campaign, products } = await this.get(orgId, campaignId)
    if (!campaign.active) throw new BadRequestException('Campanha inativa — ative antes de aplicar')
    if (products.length === 0) return { updated: 0, skipped: 0 }

    let updated = 0, skipped = 0
    const batch = 20
    for (let i = 0; i < products.length; i += batch) {
      const slice = products.slice(i, i + batch)
      const results = await Promise.allSettled(slice.map(async r => {
        if (!r.product) return 'skip' as const
        const price = r.product.price
        let salePrice: number
        if (r.sale_price_override != null && r.sale_price_override > 0) {
          salePrice = r.sale_price_override
        } else {
          const pct = r.discount_pct_override ?? campaign.default_discount_pct
          salePrice = Math.round(price * (1 - pct / 100) * 100) / 100
        }
        if (salePrice <= 0 || salePrice >= price) return 'skip' as const
        const { error } = await supabaseAdmin
          .from('products').update({
            sale_price:       salePrice,
            sale_start_at:    campaign.starts_at,
            sale_end_at:      campaign.ends_at,
            sale_badge_text:  campaign.badge_text,
          })
          .eq('id', r.product_id).eq('organization_id', orgId)
        if (error) throw new Error(error.message)
        return 'ok' as const
      }))
      for (const x of results) {
        if (x.status === 'fulfilled' && x.value === 'ok') updated++
        else skipped++
      }
    }

    await supabaseAdmin.from('promotion_campaigns').update({
      applied_at: new Date().toISOString(),
      applied_count: updated,
    }).eq('id', campaignId).eq('organization_id', orgId)

    return { updated, skipped }
  }

  /** Remove sale_price dos produtos atrelados à campanha. */
  async unapply(orgId: string, campaignId: string): Promise<{ updated: number }> {
    await this.assertOwned(orgId, campaignId)
    const { data: pcRows } = await supabaseAdmin
      .from('promotion_campaign_products')
      .select('product_id')
      .eq('campaign_id', campaignId)
    const productIds = ((pcRows ?? []) as Array<{ product_id: string }>).map(r => r.product_id)
    if (productIds.length === 0) return { updated: 0 }

    const { error, count } = await supabaseAdmin
      .from('products')
      .update({ sale_price: null, sale_start_at: null, sale_end_at: null, sale_badge_text: null }, { count: 'exact' })
      .eq('organization_id', orgId)
      .in('id', productIds)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    await supabaseAdmin.from('promotion_campaigns').update({ applied_at: null, applied_count: 0 })
      .eq('id', campaignId).eq('organization_id', orgId)

    return { updated: count ?? 0 }
  }

  private async assertOwned(orgId: string, campaignId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('promotion_campaigns').select('id')
      .eq('id', campaignId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Campanha não encontrada')
  }
}
