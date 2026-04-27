import { Controller, Get, Patch, Post, Delete, Body, Param, Query, UseGuards } from '@nestjs/common'
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
    @Query('page')              page?:             string,
    @Query('per_page')          perPage?:          string,
    @Query('sort_by')           sortBy?:           string,
    @Query('sort_dir')          sortDir?:          string,
    @Query('enrichment_status') enrichmentStatus?: string,
    @Query('has_cpf')           hasCpf?:           string,
    @Query('has_phone')         hasPhone?:         string,
    @Query('has_whatsapp')      hasWa?:            string,
    @Query('has_email')         hasEmail?:         string,
    @Query('is_vip')            isVip?:            string,
    @Query('is_blocked')        isBlocked?:        string,
  ) {
    const flag = (v?: string) => v === '1' || v === 'true'
    return this.svc.list({
      search, channel,
      limit:    limit    ? Number(limit)    : undefined,
      page:     page     ? Number(page)     : undefined,
      per_page: perPage  ? Number(perPage)  : undefined,
      sort_by:  sortBy,
      sort_dir: sortDir === 'asc' ? 'asc' : sortDir === 'desc' ? 'desc' : undefined,
      enrichment_status: enrichmentStatus,
      has_cpf:      flag(hasCpf),
      has_phone:    flag(hasPhone),
      has_whatsapp: flag(hasWa),
      has_email:    flag(hasEmail),
      is_vip:       flag(isVip),
      is_blocked:   flag(isBlocked),
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

  @Post(':id/tags/:tag')
  addTag(@Param('id') id: string, @Param('tag') tag: string) {
    return this.svc.setTag(id, tag, true)
  }

  @Delete(':id/tags/:tag')
  removeTag(@Param('id') id: string, @Param('tag') tag: string) {
    return this.svc.setTag(id, tag, false)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }

  @Post('merge')
  merge(@Body() body: { target_id: string; source_id: string }) {
    return this.svc.mergeProfiles(body.target_id, body.source_id)
  }
}
