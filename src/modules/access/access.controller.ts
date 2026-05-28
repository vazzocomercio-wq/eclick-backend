import {
  Controller, Get, Post, Body, Query, Param, Req, BadRequestException, UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AccessService } from './access.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * F17-A · Endpoints do gate de cadastro.
 *
 * Públicos:
 *   GET  /access/plans                    — lista planos ativos
 *   POST /access/request                  — form público "solicitar acesso"
 *
 * Platform admin (vazzocomercio@gmail.com):
 *   GET  /access/admin/requests           — lista pedidos
 *   POST /access/admin/requests/:id/approve  — provisiona user+org+sub
 *   POST /access/admin/requests/:id/reject   — rejeita
 */
@Controller('access')
export class AccessPublicController {
  constructor(private readonly svc: AccessService) {}

  @Get('plans')
  @Public()
  async plans() {
    return this.svc.listPlans()
  }

  @Post('request')
  @Public()
  async submitRequest(
    @Body() body: {
      name?:     string
      email?:    string
      phone?:    string
      company?:  string
      message?:  string
      planKey?:  string
      source?:   string
    },
    @Req() req: Request,
  ) {
    if (!body?.name || !body?.email) {
      throw new BadRequestException('name e email obrigatórios.')
    }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                ?? req.socket?.remoteAddress ?? undefined
    const ua = (req.headers['user-agent'] as string) ?? undefined
    return this.svc.submitRequest({
      name:      body.name,
      email:     body.email,
      phone:     body.phone,
      company:   body.company,
      message:   body.message,
      planKey:   body.planKey,
      source:    body.source ?? 'web',
      ipAddress: ip,
      userAgent: ua,
    })
  }
}

@Controller('access/admin')
@UseGuards(SupabaseAuthGuard)
export class AccessAdminController {
  constructor(private readonly svc: AccessService) {}

  @Get('requests')
  async list(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?:  string,
  ) {
    await this.svc.assertPlatformAdmin(u.id)
    return this.svc.listRequests({
      status,
      limit: limit ? Math.min(500, Math.max(1, parseInt(limit, 10))) : 100,
    })
  }

  @Post('requests/:id/approve')
  async approve(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    await this.svc.assertPlatformAdmin(u.id)
    return this.svc.approve(id, u.id)
  }

  @Post('requests/:id/reject')
  async reject(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    await this.svc.assertPlatformAdmin(u.id)
    return this.svc.reject(id, u.id, body?.reason)
  }
}
