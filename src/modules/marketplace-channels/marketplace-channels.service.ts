import { Injectable, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface UpdateMarketplaceChannelDto {
  is_integrated?: boolean
  integration_status?: string | null
  api_status?: string
}

@Injectable()
export class MarketplaceChannelsService {
  async list() {
    const { data, error } = await supabaseAdmin
      .from('marketplace_channels')
      .select('id, name, logo_url, api_status, is_integrated, integration_status, last_token_check, created_at')
      .order('name', { ascending: true })

    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async update(id: string, dto: UpdateMarketplaceChannelDto) {
    const payload: Record<string, unknown> = {}
    if (dto.is_integrated !== undefined)      payload.is_integrated      = dto.is_integrated
    if (dto.integration_status !== undefined) payload.integration_status = dto.integration_status
    if (dto.api_status !== undefined)         payload.api_status         = dto.api_status
    payload.last_token_check = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('marketplace_channels')
      .update(payload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)
    if (!data)  throw new HttpException(`Canal ${id} não encontrado`, 404)
    return data
  }
}
