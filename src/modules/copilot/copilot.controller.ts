import { Controller, Post, Get, Body, Query, UseGuards, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common'
import { CopilotService } from './copilot.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('copilot')
@UseGuards(SupabaseAuthGuard)
export class CopilotController {
  constructor(private readonly svc: CopilotService) {}

  /** GET /copilot/route-context?pathname=/x/y — KB entries que matcham
   *  a tela atual. Usado pela UI pra mostrar tópicos sugeridos antes do
   *  user perguntar. */
  @Get('route-context')
  routeContext(@Query('pathname') pathname?: string) {
    if (!pathname) throw new BadRequestException('pathname obrigatório')
    return this.svc.getRouteContext(pathname)
  }

  /** POST /copilot/help — chat principal. */
  @Post('help')
  @HttpCode(HttpStatus.OK)
  help(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      pathname: string
      question: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    },
  ) {
    if (!u.orgId)            throw new BadRequestException('orgId ausente')
    if (!body?.pathname)     throw new BadRequestException('pathname obrigatório')
    if (!body?.question)     throw new BadRequestException('question obrigatório')
    return this.svc.chat({
      orgId:    u.orgId,
      pathname: body.pathname,
      question: body.question,
      history:  body.history,
    })
  }

  /** GET /copilot/kb — lista todas as entries por categoria. */
  @Get('kb')
  listKb() {
    return this.svc.listKbByCategory()
  }
}
