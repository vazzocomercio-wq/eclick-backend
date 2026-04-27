import { Controller, Get, Patch, Post, Body, Param, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { CustomerIdentityService } from './customer-identity.service'

@Controller('customers')
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  constructor(private readonly svc: CustomerIdentityService) {}

  @Get()
  list(
    @Query('search')            search?:           string,
    @Query('channel')           channel?:          string,
    @Query('limit')             limit?:            string,
    @Query('enrichment_status') enrichmentStatus?: string,
    @Query('has_cpf')           hasCpf?:           string,
    @Query('has_phone')         hasPhone?:         string,
    @Query('has_whatsapp')      hasWa?:            string,
    @Query('has_email')         hasEmail?:         string,
  ) {
    const flag = (v?: string) => v === '1' || v === 'true'
    return this.svc.list({
      search, channel,
      limit: limit ? Number(limit) : 200,
      enrichment_status: enrichmentStatus,
      has_cpf:      flag(hasCpf),
      has_phone:    flag(hasPhone),
      has_whatsapp: flag(hasWa),
      has_email:    flag(hasEmail),
    })
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { display_name?: string; tags?: string[]; notes?: string; email?: string; phone?: string },
  ) {
    return this.svc.update(id, body)
  }

  @Post('merge')
  merge(@Body() body: { target_id: string; source_id: string }) {
    return this.svc.mergeProfiles(body.target_id, body.source_id)
  }
}
