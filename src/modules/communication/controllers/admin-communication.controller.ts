import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { AdminSecretGuard } from '../../admin/admin-secret.guard'
import { JourneyProcessorService } from '../services/journey-processor.service'

@Controller('admin/communication')
@UseGuards(AdminSecretGuard)
export class AdminCommunicationController {
  constructor(private readonly processor: JourneyProcessorService) {}

  /** POST /admin/communication/process-pending — dispara processPending()
   * sem esperar cron. Auth via header `x-admin-secret` (env ADMIN_SECRET).
   * Útil pra testes manuais e GitHub Actions. */
  @Post('process-pending')
  @HttpCode(HttpStatus.OK)
  processPending(@Body() body?: { limit?: number }) {
    const limit = body?.limit ?? 10
    return this.processor.processPending(limit)
  }
}
