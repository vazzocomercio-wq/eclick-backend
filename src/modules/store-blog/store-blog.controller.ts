import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ReqUser } from '../../common/decorators/user.decorator';
import { StoreBlogService } from './store-blog.service';
import type { GenerateStorePostDto, IdeateStoreDto } from './store-blog.types';

interface ReqUserPayload {
  id: string;
  orgId: string | null;
}

@Controller('store-blog')
@UseGuards(SupabaseAuthGuard)
export class StoreBlogController {
  constructor(private readonly svc: StoreBlogService) {}

  /** Produtos da loja (pra escolher quais o artigo apresenta). */
  @Get('products')
  products(@ReqUser() user: ReqUserPayload, @Query('q') q?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.listProducts(user.orgId, undefined, 60).then((all) =>
      q?.trim() ? all.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())) : all,
    );
  }

  /** IA sugere N pautas ancoradas nos produtos da loja. */
  @Post('ideate')
  ideate(@ReqUser() user: ReqUserPayload, @Body() dto: IdeateStoreDto) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.ideate(user.orgId, dto);
  }

  /** Lote: IA sugere N pautas e gera os N artigos (fila de revisão). */
  @Post('generate-batch')
  generateBatch(@ReqUser() user: ReqUserPayload, @Body() dto: IdeateStoreDto) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.generateBatch(user.orgId, user.id, dto);
  }

  /** Gera um artigo GEO ciente dos produtos da loja + capa → fila de revisão. */
  @Post('generate')
  generate(@ReqUser() user: ReqUserPayload, @Body() dto: GenerateStorePostDto) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.generateArticle(user.orgId, user.id, dto);
  }

  @Get('posts')
  list(@ReqUser() user: ReqUserPayload, @Query('status') status?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.list(user.orgId, status);
  }

  @Get('posts/:id')
  get(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.get(user.orgId, id);
  }

  /** Publica (vai pro ar na vitrine /loja/[slug]/blog). */
  @Post('posts/:id/publish')
  publish(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.publish(user.orgId, id);
  }

  @Post('posts/:id/reject')
  reject(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.reject(user.orgId, id, body?.reason);
  }

  @Post('posts/:id/schedule')
  schedule(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Body() body: { scheduled_for: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.schedule(user.orgId, id, body?.scheduled_for);
  }

  @Post('posts/:id/unschedule')
  unschedule(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente');
    return this.svc.unschedule(user.orgId, id);
  }
}
