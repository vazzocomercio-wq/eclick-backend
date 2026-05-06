import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Onda 3 / S6 — Analytics Social/Ads do produto.
 *
 * Cruza dados de social_content + ads_campaigns + social_commerce_products
 * pra dar uma visão consolidada de performance "fora do marketplace".
 *
 * Não modifica o ai_score original (mantém 0-100). Acrescenta 2 componentes
 * novos como bônus exibido no card de analytics:
 *   - social_presence (0-5):  +1 por canal com social_content publicado, max 5
 *   - ads_performance (0-5):  +5 se ROAS médio > 2, +3 se > 1, +0 sem campanha
 */

export interface ProductSocialAnalytics {
  product_id: string

  // Conteúdo social
  social: {
    total_pieces:        number
    by_channel:          Record<string, number>
    by_status:           Record<string, number>
    published_count:     number
    last_generated_at:   string | null
  }

  // Sync social commerce
  commerce: {
    synced_in_channels:  string[]
    last_sync_at:        string | null
    sync_errors:         number
  }

  // Ads
  ads: {
    total_campaigns:      number
    active_campaigns:     number
    by_platform:          Record<string, number>
    total_impressions:    number
    total_clicks:         number
    total_spend_brl:      number
    total_conversions:    number
    total_revenue_brl:    number
    roas_avg:             number | null
  }

  // Bonus components (não somados ao ai_score original)
  bonus: {
    social_presence: { points: number; max: number; rationale: string }
    ads_performance: { points: number; max: number; rationale: string }
  }
}

export interface TopAnalyticsRow {
  product_id:      string
  product_name:    string | null
  social_pieces:   number
  ads_campaigns:   number
  total_spend_brl: number
  roas_avg:        number | null
}

@Injectable()
export class ProductsAnalyticsService {
  private readonly logger = new Logger(ProductsAnalyticsService.name)

  async getProductAnalytics(orgId: string, productId: string): Promise<ProductSocialAnalytics> {
    // Sanity check no produto
    const { data: prod, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (prodErr) throw new BadRequestException(`Erro: ${prodErr.message}`)
    if (!prod)   throw new NotFoundException('Produto não encontrado')

    // 1. Social content
    const { data: socials } = await supabaseAdmin
      .from('social_content')
      .select('id, channel, status, published_at, created_at')
      .eq('product_id', productId)
      .eq('organization_id', orgId)

    const socialList = socials ?? []
    const socialByChannel: Record<string, number> = {}
    const socialByStatus:  Record<string, number> = {}
    let lastGen: string | null = null
    let publishedCount = 0
    for (const s of socialList) {
      socialByChannel[s.channel] = (socialByChannel[s.channel] ?? 0) + 1
      socialByStatus[s.status]   = (socialByStatus[s.status]   ?? 0) + 1
      if (s.status === 'published') publishedCount++
      if (!lastGen || s.created_at > lastGen) lastGen = s.created_at
    }

    // 2. Social commerce sync
    const { data: scProds } = await supabaseAdmin
      .from('social_commerce_products')
      .select(`
        sync_status, last_synced_at,
        channel:social_commerce_channels!inner(channel, status, sync_errors)
      `)
      .eq('product_id', productId)
      .eq('organization_id', orgId)

    type ScRow = {
      sync_status: string
      last_synced_at: string | null
      channel: { channel: string; status: string; sync_errors: number }
              | { channel: string; status: string; sync_errors: number }[]
    }
    const synced = new Set<string>()
    let lastSync: string | null = null
    let syncErrors = 0
    for (const r of (scProds ?? []) as ScRow[]) {
      const ch = Array.isArray(r.channel) ? r.channel[0] : r.channel
      if (r.sync_status === 'synced') synced.add(ch.channel)
      if (r.last_synced_at && (!lastSync || r.last_synced_at > lastSync)) lastSync = r.last_synced_at
      syncErrors += ch.sync_errors ?? 0
    }

    // 3. Ads campaigns
    const { data: ads } = await supabaseAdmin
      .from('ads_campaigns')
      .select('id, platform, status, metrics')
      .eq('product_id', productId)
      .eq('organization_id', orgId)
      .neq('status', 'archived')

    const adsList = ads ?? []
    const adsByPlatform: Record<string, number> = {}
    let activeCount = 0
    let totalImp = 0, totalClicks = 0, totalSpend = 0, totalConv = 0, totalRev = 0
    let roasSum = 0, roasN = 0
    for (const a of adsList) {
      adsByPlatform[a.platform] = (adsByPlatform[a.platform] ?? 0) + 1
      if (a.status === 'active' || a.status === 'publishing') activeCount++
      const m = (a.metrics ?? {}) as {
        impressions?: number; clicks?: number; spend_brl?: number;
        conversions?: number; conversion_value_brl?: number; roas?: number
      }
      totalImp    += m.impressions          ?? 0
      totalClicks += m.clicks               ?? 0
      totalSpend  += m.spend_brl            ?? 0
      totalConv   += m.conversions          ?? 0
      totalRev    += m.conversion_value_brl ?? 0
      if (m.roas != null) {
        roasSum += m.roas
        roasN++
      }
    }
    const roasAvg = roasN > 0 ? roasSum / roasN : null

    // 4. Bonus components
    const socialChannelsWithPublished = Object.keys(socialByChannel).filter(ch =>
      socialList.some(s => s.channel === ch && s.status === 'published')
    ).length
    const socialPresence = Math.min(5, socialChannelsWithPublished)

    let adsPerformance = 0
    let adsRationale = 'Sem campanhas'
    if (roasAvg != null) {
      if (roasAvg > 2)      { adsPerformance = 5; adsRationale = `ROAS médio ${roasAvg.toFixed(2)}× — excelente` }
      else if (roasAvg > 1) { adsPerformance = 3; adsRationale = `ROAS médio ${roasAvg.toFixed(2)}× — positivo` }
      else                  { adsPerformance = 0; adsRationale = `ROAS médio ${roasAvg.toFixed(2)}× — abaixo do break-even` }
    }

    return {
      product_id: productId,
      social: {
        total_pieces:      socialList.length,
        by_channel:        socialByChannel,
        by_status:         socialByStatus,
        published_count:   publishedCount,
        last_generated_at: lastGen,
      },
      commerce: {
        synced_in_channels: Array.from(synced),
        last_sync_at:       lastSync,
        sync_errors:        syncErrors,
      },
      ads: {
        total_campaigns:    adsList.length,
        active_campaigns:   activeCount,
        by_platform:        adsByPlatform,
        total_impressions:  totalImp,
        total_clicks:       totalClicks,
        total_spend_brl:    totalSpend,
        total_conversions:  totalConv,
        total_revenue_brl:  totalRev,
        roas_avg:           roasAvg,
      },
      bonus: {
        social_presence: {
          points:    socialPresence,
          max:       5,
          rationale: `Presente em ${socialPresence} canal${socialPresence !== 1 ? 'is' : ''} com conteúdo publicado`,
        },
        ads_performance: {
          points:    adsPerformance,
          max:       5,
          rationale: adsRationale,
        },
      },
    }
  }

  /** Top produtos por performance social/ads (rankeia por revenue_brl, fallback ROAS). */
  async topAnalytics(orgId: string, limit = 10): Promise<TopAnalyticsRow[]> {
    // Pega aggregate via produtos que têm pelo menos 1 ads_campaign ativa OU social_content
    // Simples: lista produtos com IDs distintos cruzando 2 tabelas.
    const { data: campaigns } = await supabaseAdmin
      .from('ads_campaigns')
      .select('product_id, metrics')
      .eq('organization_id', orgId)
      .not('product_id', 'is', null)
      .neq('status', 'archived')

    const aggByProduct: Record<string, { ads: number; spend: number; revenue: number; roas_n: number; roas_sum: number }> = {}
    for (const c of (campaigns ?? [])) {
      if (!c.product_id) continue
      const k = c.product_id
      if (!aggByProduct[k]) aggByProduct[k] = { ads: 0, spend: 0, revenue: 0, roas_n: 0, roas_sum: 0 }
      const m = (c.metrics ?? {}) as { spend_brl?: number; conversion_value_brl?: number; roas?: number }
      aggByProduct[k].ads++
      aggByProduct[k].spend   += m.spend_brl            ?? 0
      aggByProduct[k].revenue += m.conversion_value_brl ?? 0
      if (m.roas != null) {
        aggByProduct[k].roas_sum += m.roas
        aggByProduct[k].roas_n++
      }
    }

    // Conta social_content por produto
    const { data: socials } = await supabaseAdmin
      .from('social_content')
      .select('product_id')
      .eq('organization_id', orgId)
    const socialCountByProduct: Record<string, number> = {}
    for (const s of (socials ?? [])) {
      socialCountByProduct[s.product_id] = (socialCountByProduct[s.product_id] ?? 0) + 1
    }

    // Junta produtos
    const allProductIds = Array.from(new Set([
      ...Object.keys(aggByProduct),
      ...Object.keys(socialCountByProduct),
    ]))
    if (allProductIds.length === 0) return []

    const { data: prods } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .in('id', allProductIds)
    const namesByid: Record<string, string | null> = {}
    for (const p of (prods ?? [])) {
      namesByid[p.id] = p.name
    }

    const rows: TopAnalyticsRow[] = allProductIds.map(pid => {
      const a = aggByProduct[pid]
      return {
        product_id:      pid,
        product_name:    namesByid[pid] ?? null,
        social_pieces:   socialCountByProduct[pid] ?? 0,
        ads_campaigns:   a?.ads ?? 0,
        total_spend_brl: a?.spend ?? 0,
        roas_avg:        a?.roas_n ? a.roas_sum / a.roas_n : null,
      }
    })

    // Ordena por revenue desc, depois ads desc, depois social desc
    rows.sort((x, y) => {
      const xRev = (aggByProduct[x.product_id]?.revenue ?? 0)
      const yRev = (aggByProduct[y.product_id]?.revenue ?? 0)
      if (yRev !== xRev) return yRev - xRev
      if (y.ads_campaigns !== x.ads_campaigns) return y.ads_campaigns - x.ads_campaigns
      return y.social_pieces - x.social_pieces
    })

    return rows.slice(0, limit)
  }
}
