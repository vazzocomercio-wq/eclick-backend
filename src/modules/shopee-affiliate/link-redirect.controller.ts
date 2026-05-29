import { Controller, Get, Param, Res, Logger } from '@nestjs/common'
import { Response } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { LinkStudioService } from './link-studio.service'

/** F18 F2.4 — Redirect público dos links encurtados de afiliado.
 *  `api.eclick.app.br/go/{hash}` → 302 pro destino (tracked_url ?? target_url)
 *  + incrementa contador de cliques. SEM auth (link público compartilhável). */
@Controller('go')
export class LinkRedirectController {
  private readonly logger = new Logger(LinkRedirectController.name)

  constructor(private readonly linkStudio: LinkStudioService) {}

  @Get(':hash')
  @Public()
  async redirect(@Param('hash') hash: string, @Res() res: Response): Promise<void> {
    let target: string | null = null
    try {
      target = await this.linkStudio.resolveAndCount(hash)
    } catch (e) {
      this.logger.error(`[go] resolve ${hash}: ${(e as Error)?.message}`)
    }
    if (!target) {
      // Hash inválido → manda pra home da Shopee (fallback gracioso).
      res.redirect(302, 'https://shopee.com.br')
      return
    }
    res.redirect(302, target)
  }
}
