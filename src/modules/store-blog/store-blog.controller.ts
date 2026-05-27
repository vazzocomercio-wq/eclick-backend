import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ReqUser } from '../../common/decorators/user.decorator';
import { StoreBlogService } from './store-blog.service';
import { StoreBlogStudioService, type StoreBlogPromptKey } from './store-blog-studio.service';
import type { GenerateStorePostDto, IdeateStoreDto } from './store-blog.types';

interface ReqUserPayload {
  id: string;
  orgId: string | null;
}

@Controller('store-blog')
@UseGuards(SupabaseAuthGuard)
export class StoreBlogController {
  constructor(
    private readonly svc: StoreBlogService,
    private readonly studio: StoreBlogStudioService,
  ) {}

  // ── Estúdio: voz/fonte + prompts + conhecimento ──────────────────────

  @Get('settings')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.getSettings(u.orgId);
  }

  @Put('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: { voice?: string | null; display_font?: string | null }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.updateSettings(u.orgId, body);
  }

  @Get('studio/prompts')
  listPrompts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.listPrompts(u.orgId);
  }

  @Put('studio/prompts/:key')
  upsertPrompt(@ReqUser() u: ReqUserPayload, @Param('key') key: StoreBlogPromptKey, @Body() body: { prompt: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.upsertPrompt(u.orgId, key, body?.prompt);
  }

  @Delete('studio/prompts/:key')
  resetPrompt(@ReqUser() u: ReqUserPayload, @Param('key') key: StoreBlogPromptKey) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.resetPrompt(u.orgId, key);
  }

  @Post('studio/prompts/:key/generate')
  generatePrompt(@ReqUser() u: ReqUserPayload, @Param('key') key: StoreBlogPromptKey, @Body() body: { instruction: string; current_prompt?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.generatePrompt(u.orgId, { key, instruction: body?.instruction, current_prompt: body?.current_prompt });
  }

  @Get('studio/knowledge')
  listKnowledge(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.listKnowledge(u.orgId);
  }

  @Post('studio/knowledge')
  addKnowledge(@ReqUser() u: ReqUserPayload, @Body() body: { source_type: 'url' | 'text'; value: string; title?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.addKnowledge(u.orgId, body);
  }

  @Delete('studio/knowledge/:id')
  removeKnowledge(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente');
    return this.studio.removeKnowledge(u.orgId, id);
  }

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

/** Leitura pública pra vitrine /loja/[slug]/blog (sem auth). */
@Controller('public/store-blog')
export class StoreBlogPublicController {
  constructor(private readonly svc: StoreBlogService) {}

  @Get(':slug/posts')
  @Public()
  posts(@Param('slug') slug: string) {
    return this.svc.listPublishedBySlug(slug);
  }

  @Get(':slug/posts/:postSlug')
  @Public()
  async post(@Param('slug') slug: string, @Param('postSlug') postSlug: string) {
    const res = await this.svc.getPublishedBySlug(slug, postSlug);
    if (!res) throw new NotFoundException('Post não encontrado');
    return res;
  }
}
