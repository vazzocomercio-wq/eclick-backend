import { Body, Controller, Delete, Get, Headers, HttpException, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { ChatWidgetService } from './chat-widget.service'

@Controller('widgets')
@UseGuards(SupabaseAuthGuard)
export class WidgetsController {
  constructor(private readonly svc: ChatWidgetService) {}

  private async resolveUserId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    if (!user?.id) throw new HttpException('Usuário não autenticado', 401)
    return user.id
  }

  @Get()
  async list(@Headers('authorization') auth: string) {
    const userId = await this.resolveUserId(auth)
    return this.svc.listForUser(userId)
  }

  @Post()
  async create(@Headers('authorization') auth: string, @Body() body: Record<string, unknown>) {
    const userId = await this.resolveUserId(auth)
    return this.svc.create(userId, body)
  }

  @Patch(':id')
  async update(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    await this.resolveUserId(auth) // RLS ensures tenant isolation
    return this.svc.update(id, body)
  }

  @Delete(':id')
  async remove(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.resolveUserId(auth)
    await this.svc.remove(id)
    return { ok: true }
  }

  @Get(':id/snippet')
  async snippet(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.resolveUserId(auth)
    const widget = await this.svc.getOrThrow(id)
    const backendUrl = process.env.PUBLIC_BACKEND_URL ?? ''
    return this.svc.buildSnippet(widget, backendUrl)
  }
}
