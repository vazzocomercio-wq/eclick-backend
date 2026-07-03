import {
  Controller, Get, Post, Body, Param, Query, Req, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { Request } from 'express'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard'
import { StorefrontLeadsService, hashIp } from './storefront-leads.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** Lojista: lista submissões + reenvia.
 *
 *   GET  /storefront-leads          ?status=&limit=&offset=
 *   POST /storefront-leads/:id/retry
 */
@Controller('storefront-leads')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StorefrontLeadsController {
  constructor(private readonly svc: StorefrontLeadsService) {}

  @Get()
  @RequirePermission('crm.view')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOwner(u.orgId, {
      status,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Post(':id/retry')
  @RequirePermission('crm.manage_pipeline')
  retry(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.retry(u.orgId, id)
  }
}

/** Público: vitrine envia o formulário aqui.
 *
 *   POST /public/store/by-slug/:slug/lead
 *     { sectionId?, formTitle?, pipelineId, stageId, assignedTo?, fields }
 */
@Controller('public/store/by-slug')
export class StorefrontLeadsPublicController {
  constructor(private readonly svc: StorefrontLeadsService) {}

  @Post(':slug/lead')
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, windowMs: 60_000, keyPrefix: 'sf-lead' })
  async submit(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Body() body: {
      sectionId?:  string
      formTitle?:  string
      pipelineId?: string
      stageId?:    string
      assignedTo?: string
      fields?: {
        name?: string; email?: string; phone?: string; message?: string
        custom?: Record<string, string>
      }
    },
  ) {
    if (!body?.pipelineId || !body?.stageId) {
      throw new BadRequestException('Formulário sem destino configurado (pipeline/etapa).')
    }
    const ip = String(
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      ?? req.socket?.remoteAddress ?? '',
    )
    return this.svc.submit({
      slug,
      sectionId:  body.sectionId,
      formTitle:  body.formTitle,
      pipelineId: body.pipelineId,
      stageId:    body.stageId,
      assignedTo: body.assignedTo,
      fields:     body.fields ?? {},
      ipHash:     ip ? hashIp(ip) : null,
    })
  }
}
