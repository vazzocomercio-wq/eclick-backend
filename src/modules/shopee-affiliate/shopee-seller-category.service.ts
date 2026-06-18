import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { createHmac } from 'crypto'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const HOST = 'https://partner.shopeemobile.com'

interface ShopeeCat {
  category_id: number
  parent_category_id: number
  display_category_name: string
  original_category_name?: string
  has_children: boolean
}

/** Árvore de categorias da Shopee via API de VENDEDOR (get_category) — a
 *  Affiliate API não expõe categorias. Os IDs batem com o productCatId do
 *  afiliado. Popula public.marketplace_categories (marketplace='shopee') e
 *  serve o seletor drill-down da tela. Assinatura igual ao ShopeeAdapter. */
@Injectable()
export class ShopeeSellerCategoryService {
  private readonly logger = new Logger(ShopeeSellerCategoryService.name)

  /** Sincroniza a árvore completa do get_category → marketplace_categories. */
  async sync(orgId: string): Promise<{ synced: number }> {
    const conn = await this.shopeeConn(orgId)
    if (!conn) throw new BadRequestException('Nenhuma loja Shopee conectada nesta organização.')

    const partnerId  = process.env.SHOPEE_PARTNER_ID
    const partnerKey = process.env.SHOPEE_PARTNER_KEY
    if (!partnerId || !partnerKey) throw new BadRequestException('SHOPEE_PARTNER_ID/KEY não configuradas.')

    const path = '/api/v2/product/get_category'
    const ts = Math.floor(Date.now() / 1000)
    const sign = createHmac('sha256', partnerKey)
      .update(`${partnerId}${path}${ts}${conn.access_token}${conn.shop_id}`).digest('hex')
    const url = `${HOST}${path}?partner_id=${partnerId}&timestamp=${ts}&access_token=${conn.access_token}&shop_id=${conn.shop_id}&sign=${sign}&language=pt-br`

    let list: ShopeeCat[]
    try {
      const res = await axios.get(url, { timeout: 20000 })
      if (res.data?.error) throw new Error(`${res.data.error}: ${res.data.message ?? ''}`)
      list = (res.data?.response?.category_list ?? []) as ShopeeCat[]
    } catch (e) {
      const msg = axios.isAxiosError(e) ? JSON.stringify(e.response?.data ?? e.message) : (e instanceof Error ? e.message : String(e))
      throw new BadRequestException(`Falha no get_category: ${String(msg).slice(0, 200)}`)
    }
    if (!list.length) return { synced: 0 }

    const rows = list.map(c => ({
      marketplace:  'shopee',
      external_id:  String(c.category_id),
      parent_id:    c.parent_category_id && c.parent_category_id !== 0 ? String(c.parent_category_id) : null,
      name:         c.display_category_name || c.original_category_name || String(c.category_id),
      is_leaf:      !c.has_children,
      fetched_at:   new Date().toISOString(),
    }))

    // full refresh da árvore Shopee
    await supabaseAdmin.from('marketplace_categories').delete().eq('marketplace', 'shopee')
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('marketplace_categories').insert(rows.slice(i, i + 500))
      if (error) this.logger.warn(`[shopee.cat] insert chunk falhou: ${error.message}`)
    }
    this.logger.log(`[shopee.cat] org=${orgId} sincronizou ${rows.length} categorias`)
    return { synced: rows.length }
  }

  /** Lista categorias pro seletor: sem parent = raízes; com parent = filhas. */
  async list(parentId?: string | null): Promise<{ id: string; name: string; isLeaf: boolean }[]> {
    let q = supabaseAdmin.from('marketplace_categories')
      .select('external_id, name, is_leaf').eq('marketplace', 'shopee').order('name')
    q = parentId ? q.eq('parent_id', parentId) : q.is('parent_id', null)
    const { data } = await q
    return ((data ?? []) as { external_id: string; name: string; is_leaf: boolean }[])
      .map(c => ({ id: c.external_id, name: c.name, isLeaf: c.is_leaf }))
  }

  async hasCategories(): Promise<boolean> {
    const { count } = await supabaseAdmin.from('marketplace_categories')
      .select('external_id', { count: 'exact', head: true }).eq('marketplace', 'shopee')
    return (count ?? 0) > 0
  }

  private async shopeeConn(orgId: string): Promise<{ access_token: string; shop_id: number } | null> {
    const { data } = await supabaseAdmin.from('marketplace_connections')
      .select('access_token, shop_id, status')
      .eq('organization_id', orgId).eq('platform', 'shopee')
      .not('access_token', 'is', null).order('status', { ascending: true })
    const rows = (data ?? []) as { access_token: string | null; shop_id: number | null; status: string | null }[]
    const conn = rows.find(r => r.status === 'active') ?? rows[0]
    if (!conn?.access_token || !conn?.shop_id) return null
    return { access_token: conn.access_token, shop_id: conn.shop_id }
  }
}
