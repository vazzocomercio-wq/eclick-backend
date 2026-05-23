import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common'
import { KitsService, type KitType } from './kits.service'
import { Public } from '../../common/decorators/public.decorator'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Endpoints públicos de kits pra vitrine — "Monte o ambiente".
 *
 *   GET /public/store/by-slug/:slug/kits                      → kits ativos da loja
 *       ?types=by_room,cross_sell&limit=12
 *   GET /public/store/by-slug/:slug/kits/by-product/:productId → kits que contêm o produto
 *
 * Sem auth (vitrine pública). Retorna só kits status='active' e 100%
 * disponíveis (todos os itens visíveis + com estoque).
 */
@Controller('public/store')
export class KitsPublicController {
  constructor(private readonly svc: KitsService) {}

  @Get('by-slug/:slug/kits')
  @Public()
  async listForStore(
    @Param('slug') slug: string,
    @Query('types') types?: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = await resolveOrgBySlug(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    const kitTypes = types
      ? (types.split(',').map(s => s.trim()).filter(Boolean) as KitType[])
      : undefined
    return this.svc.listPublicForStore(orgId, {
      kitTypes,
      limit: limit ? Number(limit) : undefined,
    })
  }

  @Get('by-slug/:slug/kits/by-product/:productId')
  @Public()
  async listForProduct(
    @Param('slug') slug: string,
    @Param('productId') productId: string,
  ) {
    const orgId = await resolveOrgBySlug(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    return this.svc.listPublicForProduct(orgId, productId)
  }
}

async function resolveOrgBySlug(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('store_config')
    .select('organization_id')
    .eq('store_slug', slug)
    .eq('status', 'active')
    .maybeSingle()
  return (data?.organization_id as string) ?? null
}
