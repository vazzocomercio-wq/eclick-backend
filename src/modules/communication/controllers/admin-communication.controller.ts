import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { AdminSecretGuard } from '../../admin/admin-secret.guard'
import { JourneyProcessorService } from '../services/journey-processor.service'

@Controller('admin/communication')
@UseGuards(AdminSecretGuard)
export class AdminCommunicationController {
  constructor(private readonly processor: JourneyProcessorService) {}

  /** POST /admin/communication/process-pending — dispara processPending()
   * sem esperar cron. Auth via header `x-admin-secret` (env ADMIN_SECRET).
   * Útil pra testes manuais e GitHub Actions.
   *
   * Body opcional: { org_id?, limit? }. Sem org_id processa todas as orgs
   * com OCJs pending, igual o cron faz. Com org_id processa só aquela. */
  @Post('process-pending')
  @HttpCode(HttpStatus.OK)
  processPending(@Body() body?: { org_id?: string; limit?: number }) {
    return this.processor.processPending({
      orgId: body?.org_id,
      limit: body?.limit ?? 10,
    })
  }
}
