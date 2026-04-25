import { Injectable, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface CreateCompetitorDto {
  product_id: string
  platform: string
  url: string
  title?: string | null
  seller?: string | null
  current_price: number
  my_price?: number | null
  photo_url?: string | null
}

@Injectable()
export class CompetitorsService {

  async create(orgId: string, dto: CreateCompetitorDto) {
    const { data: competitor, error } = await supabaseAdmin
      .from('competitors')
      .insert({
        organization_id: orgId,
        product_id:      dto.product_id,
        platform:        dto.platform,
        url:             dto.url,
        title:           dto.title    ?? null,
        seller:          dto.seller   ?? null,
        current_price:   dto.current_price,
        my_price:        dto.my_price ?? null,
        photo_url:       dto.photo_url ?? null,
        status:          'active',
        last_checked:    new Date().toISOString(),
      })
      .select('id, product_id, platform, url, title, seller, current_price, my_price, photo_url, status, last_checked, created_at')
      .single()

    if (error || !competitor) {
      console.error('[competitors.create] erro:', error)
      throw new HttpException(error?.message ?? 'Erro ao criar concorrente', 400)
    }

    // Initial price_history record — non-fatal if it fails
    try {
      await supabaseAdmin
        .from('price_history')
        .insert({ competitor_id: competitor.id, price: dto.current_price })
    } catch (e: any) {
      console.warn('[competitors.create] price_history insert failed:', e.message)
    }

    return competitor
  }

  async list(orgId: string, productId?: string) {
    let q = supabaseAdmin
      .from('competitors')
      .select('id, product_id, platform, url, title, seller, current_price, my_price, photo_url, status, last_checked, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (productId) q = q.eq('product_id', productId)

    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async remove(orgId: string, id: string) {
    const { error } = await supabaseAdmin
      .from('competitors')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }
}
