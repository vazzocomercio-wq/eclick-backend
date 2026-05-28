import {
  Controller, Get, Put, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { StorefrontVariantsService } from './storefront-variants.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Variantes de cor/acabamento — gestão pelo lojista (no editor do catálogo).
 *
 *   GET /storefront-variants?baseProductId=...           → vínculos atuais
 *   GET /storefront-variants/suggest?baseProductId=...   → sugestões por SKU (não vincula)
 *   PUT /storefront-variants                             → { baseProductId, variants: [{variantProductId, label?}] }
 */
@Controller('storefront-variants')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StorefrontVariantsController {
  constructor(private readonly svc: StorefrontVariantsService) {}

  @Get()
  @RequirePermission('store.view')
  list(@ReqUser() u: ReqUserPayload, @Query('baseProductId') baseProductId?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!baseProductId) throw new BadRequestException('baseProductId obrigatório')
    return this.svc.listForBase(u.orgId, baseProductId)
  }

  @Get('suggest')
  @RequirePermission('store.view')
  suggest(@ReqUser() u: ReqUserPayload, @Query('baseProductId') baseProductId?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!baseProductId) throw new BadRequestException('baseProductId obrigatório')
    return this.svc.suggestForBase(u.orgId, baseProductId)
  }

  @Put()
  @RequirePermission('store.update')
  set(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { baseProductId?: string; variants?: Array<{ variantProductId: string; label?: string | null }> },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.baseProductId) throw new BadRequestException('baseProductId obrigatório')
    return this.svc.setForBase(u.orgId, body.baseProductId, body.variants ?? [])
  }
}

/** Variantes na vitrine (público). */
@Controller('public/store')
export class StorefrontVariantsPublicController {
  constructor(private readonly svc: StorefrontVariantsService) {}

  @Get('by-slug/:slug/products/:productId/variants')
  @Public()
  async publicList(@Param('slug') slug: string, @Param('productId') productId: string) {
    const orgId = await resolveOrgBySlug(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    return this.svc.publicListForBase(orgId, productId)
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
