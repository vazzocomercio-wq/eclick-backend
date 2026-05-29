import { BadRequestException, Body, Controller, Get, Headers, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { InternalKeyGuard } from '../internal/internal-key.guard';
import { BlogNewsletterService } from './blog-newsletter.service';
import { BlogNewsletterBroadcastService } from './blog-newsletter-broadcast.service';
import type { BlogNewsletterSignupDto, NotifySubscribersDto } from './blog-newsletter.types';

const SITE_URL = 'https://eclick.app.br';

/**
 * Endpoints públicos do widget do blog. NÃO usa AuthGuard global — usa
 * `@Public()` pra escapar do guard padrão (config no main.ts).
 */
@Public()
@Controller('public/blog/newsletter')
export class BlogNewsletterPublicController {
  constructor(private readonly svc: BlogNewsletterService) {}

  @Post('signup')
  async signup(@Body() body: BlogNewsletterSignupDto, @Req() req: Request) {
    const ip = pickIp(req);
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    const res = await this.svc.signup(body ?? {} as BlogNewsletterSignupDto, { ip, userAgent: userAgent ?? undefined });
    return res;
  }

  /**
   * Página HTML de confirmação. Aceita GET pra que o link funcione direto
   * do email. Token inválido renderiza mensagem amigável.
   */
  @Get('unsubscribe')
  async unsubscribe(@Query('token') token: string, @Res() res: Response) {
    const out = await this.svc.unsubscribe(token ?? '');
    const html = renderUnsubHtml(out);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }
}

/**
 * Endpoint interno disparado pelo Active após publicar um post no Sanity.
 * Cria o broadcast (1 row em `blog_newsletter_broadcasts`) + enfileira N
 * deliveries (1 por inscrito ativo). Worker `BlogNewsletterBroadcastService`
 * processa a fila a cada minuto.
 *
 * Idempotente: 2ª chamada pro mesmo slug retorna alreadySent.
 */
@UseGuards(InternalKeyGuard)
@Controller('internal/blog')
export class BlogNewsletterInternalController {
  constructor(
    private readonly svc: BlogNewsletterService,
    private readonly broadcast: BlogNewsletterBroadcastService,
  ) {}

  @Post('notify-subscribers')
  async notify(@Body() body: NotifySubscribersDto, @Headers('x-trigger-send') triggerSend?: string) {
    if (!body?.slug || !body?.title) throw new BadRequestException('slug e title obrigatórios');
    const enqueued = await this.svc.enqueueBroadcast(body);
    // Opcional: dispara um tick imediato (não espera o cron de 1min) se o
    // caller passar X-Trigger-Send: true. Útil pro smoke; em prod o cron
    // pega em <=60s.
    if (triggerSend === 'true' && enqueued.broadcastId) {
      void this.broadcast.processPending().catch(() => null);
    }
    return enqueued;
  }
}

function pickIp(req: Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return xff[0];
  return req.socket?.remoteAddress;
}

function renderUnsubHtml(out: { ok: boolean; email?: string; alreadyOut?: boolean }): string {
  const ok = out.ok;
  const title = ok ? (out.alreadyOut ? 'Você já estava fora' : 'Inscrição cancelada') : 'Link inválido';
  const msg = ok
    ? `Pronto. <strong>${out.email ?? ''}</strong> não vai mais receber os emails do blog.`
    : 'Não conseguimos confirmar este link de cancelamento. Pode ser que já tenha sido usado ou expirado.';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${title} · e-Click</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.card{background:#0f0f12;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px 32px;max-width:480px;width:100%}
h1{font-size:24px;font-weight:700;letter-spacing:-0.02em;margin:0 0 12px;color:#fafafa}
p{font-size:15px;line-height:1.6;color:#a1a1aa;margin:0 0 20px}
a{display:inline-block;background:#00E5FF;color:#04141a;font-weight:800;font-size:14.5px;padding:11px 18px;border-radius:10px;text-decoration:none}
.label{color:#00E5FF;font-weight:800;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px}</style></head>
<body><div class="card">
<div class="label">Blog e-Click</div>
<h1>${title}</h1>
<p>${msg}</p>
<a href="${SITE_URL}/blog">Voltar ao blog</a>
</div></body></html>`;
}
