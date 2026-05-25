import { Controller, Get, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string }

/**
 * AI Visibility OS (GEO). Setup inicial: só expõe um status pra confirmar
 * que o módulo subiu e a auth está wired. SupabaseAuthGuard é por-controller
 * (o projeto NÃO tem guard global) — org vem do JWT via @ReqUser.
 */
@Controller('ai-visibility')
@UseGuards(SupabaseAuthGuard)
export class AiVisibilityController {
  @Get('status')
  status(@ReqUser() user: ReqUserPayload): { module: string; phase: string; orgId: string } {
    return { module: 'ai-visibility', phase: 'setup', orgId: user.orgId }
  }
}
