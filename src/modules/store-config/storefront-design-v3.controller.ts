import {
  Controller, Get, Put, Post, Body, Param, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { StorefrontDesignV3Service } from './storefront-design-v3.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Store Builder v3 — endpoints do design v3.
 *
 *   GET  /store/config/design-v3                   → retorna design_v3 (ou DEFAULT_DESIGN_V3)
 *   PUT  /store/config/design-v3                   { design } → valida + salva
 *   POST /store/config/design-v3/apply-template    { templateKey } → clona template (uuid novo) + salva
 *
 * Geracao por IA (prompt/imagem/url/canva) entra na Fase C.7 — vai
 * estender o StorefrontDesignService existente pra emitir v3 (via flag).
 */
@Controller('store/config/design-v3')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StorefrontDesignV3Controller {
  constructor(private readonly svc: StorefrontDesignV3Service) {}

  @Get()
  @RequirePermission('store.view')
  get(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDesign(u.orgId).then(design => ({ design }))
  }

  @Put()
  @RequirePermission('store.update')
  save(@ReqUser() u: ReqUserPayload, @Body() body: { design?: unknown }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.saveDesign(u.orgId, body?.design).then(design => ({ design }))
  }

  @Post('apply-template')
  @RequirePermission('store.update')
  applyTemplate(@ReqUser() u: ReqUserPayload, @Body() body: { templateKey?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.templateKey) throw new BadRequestException('templateKey obrigatório')
    return this.svc.applyTemplate(u.orgId, body.templateKey).then(design => ({ design }))
  }

  @Post('generate')
  @RequirePermission('store.update')
  generate(@ReqUser() u: ReqUserPayload, @Body() body: { prompt?: string; templateKey?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateDesign(u.orgId, {
      prompt:      body?.prompt ?? '',
      templateKey: body?.templateKey,
    }).then(design => ({ design }))
  }

  // ─ Versionamento (Fase E) ────────────────────────────────────

  @Get('versions')
  @RequirePermission('store.view')
  listVersions(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listVersions(u.orgId).then(versions => ({ versions }))
  }

  @Post('publish')
  @RequirePermission('store.update')
  publish(@ReqUser() u: ReqUserPayload, @Body() body: { label?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.publish(u.orgId, body?.label).then(design => ({ design }))
  }

  @Post('revert/:versionId')
  @RequirePermission('store.update')
  revert(@ReqUser() u: ReqUserPayload, @Param('versionId') versionId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!versionId) throw new BadRequestException('versionId obrigatório')
    return this.svc.revert(u.orgId, versionId).then(design => ({ design }))
  }
}
