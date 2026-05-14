import { Controller, Get, Post, Delete, Param, Body, UseGuards, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common'
import { IcarusIntegrationService, type ConnectInput } from './icarus-integration.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Sessão 2026-05-14 — Endpoints da integração Icarus por fornecedor.
 * Rotas vivem sob /suppliers/:supplierId/integrations/icarus pra agrupar
 * com o módulo de fornecedores. Service único pra todos os métodos.
 *
 * Sempre filtra por orgId (multi-tenant), nunca devolve access_token plain.
 */
@Controller('suppliers/:supplierId/integrations/icarus')
@UseGuards(SupabaseAuthGuard)
export class IcarusIntegrationController {
  constructor(private readonly service: IcarusIntegrationService) {}

  /** POST /suppliers/:supplierId/integrations/icarus
   *  Conecta (ou reconecta) Icarus pro fornecedor. Faz ping antes de persistir. */
  @Post()
  @HttpCode(HttpStatus.OK)
  connect(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Body() body: ConnectInput,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!supplierId) throw new BadRequestException('supplierId obrigatório')
    return this.service.connect(u.orgId, supplierId, u.id, body)
  }

  /** GET /suppliers/:supplierId/integrations/icarus — status atual */
  @Get()
  get(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.getBySupplier(u.orgId, supplierId)
  }

  /** POST /suppliers/:supplierId/integrations/icarus/test — smoke test */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.test(u.orgId, supplierId)
  }

  /** DELETE /suppliers/:supplierId/integrations/icarus — desconecta (soft) */
  @Delete()
  @HttpCode(HttpStatus.OK)
  disconnect(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.disconnect(u.orgId, supplierId)
  }
}

/** Listagem global de todas integrações Icarus da org — usado pelo cron de sync. */
@Controller('integrations/icarus')
@UseGuards(SupabaseAuthGuard)
export class IcarusIntegrationListController {
  constructor(private readonly service: IcarusIntegrationService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.list(u.orgId)
  }
}
