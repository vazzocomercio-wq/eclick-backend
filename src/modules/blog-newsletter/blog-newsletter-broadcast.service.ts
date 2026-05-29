import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { supabaseAdmin } from '../../common/supabase';
import { EmailSettingsService } from '../email-settings/email-settings.service';
import { BlogNewsletterService } from './blog-newsletter.service';

/** Org da própria e-Click que tem Resend configurado pra envio do blog.
 *  Override via env `ECLICK_NEWSLETTER_ORG_ID` se mudar no futuro. */
const DEFAULT_ECLICK_ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833';
const SITE_URL = 'https://eclick.app.br';

interface DeliveryRow {
  id: string;
  broadcast_id: string;
  signup_id: string;
  email: string;
}

interface BroadcastRow {
  id: string;
  post_slug: string;
  post_title: string;
  post_excerpt: string | null;
  cover_image_url: string | null;
}

interface SignupTokenRow {
  id: string;
  unsubscribe_token: string;
}

/**
 * Worker que processa a fila `blog_newsletter_deliveries`:
 * pega `status='pending'` (limit 50/tick), envia via Resend usando as
 * credenciais da org e-Click (4ef1aabd…) e marca como sent/failed.
 *
 * Trigger: @Cron a cada 1 minuto. Desligável via env `BLOG_NEWSLETTER_DISABLED=true`.
 */
@Injectable()
export class BlogNewsletterBroadcastService {
  private readonly log = new Logger(BlogNewsletterBroadcastService.name);
  private running = false;

  constructor(
    private readonly emailSettings: EmailSettingsService,
    private readonly svc: BlogNewsletterService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (process.env.BLOG_NEWSLETTER_DISABLED === 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.processPending();
    } catch (e) {
      this.log.error(`tick falhou: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Pega 50 deliveries pendentes, agrupa por broadcast, envia e marca.
   */
  async processPending(): Promise<{ processed: number }> {
    const orgId = process.env.ECLICK_NEWSLETTER_ORG_ID ?? DEFAULT_ECLICK_ORG;
    const cfg = await this.emailSettings.getDecryptedKey(orgId);
    if (!cfg) {
      this.log.warn(`Sem email_settings pra org ${orgId} — pulando broadcast`);
      return { processed: 0 };
    }

    const { data: deliveries, error } = await supabaseAdmin
      .from('blog_newsletter_deliveries')
      .select('id, broadcast_id, signup_id, email')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) {
      this.log.error(`fetch deliveries falhou: ${error.message}`);
      return { processed: 0 };
    }
    if (!deliveries || deliveries.length === 0) return { processed: 0 };

    // Carrega broadcasts referenciados (1 query)
    const broadcastIds = [...new Set(deliveries.map((d) => d.broadcast_id))];
    const { data: broadcasts } = await supabaseAdmin
      .from('blog_newsletter_broadcasts')
      .select('id, post_slug, post_title, post_excerpt, cover_image_url')
      .in('id', broadcastIds);
    const broadcastMap = new Map<string, BroadcastRow>(
      (broadcasts ?? []).map((b) => [b.id as string, b as BroadcastRow]),
    );

    // Carrega tokens de unsubscribe (1 query)
    const signupIds = [...new Set(deliveries.map((d) => d.signup_id))];
    const { data: signups } = await supabaseAdmin
      .from('blog_newsletter_signups')
      .select('id, unsubscribe_token')
      .in('id', signupIds);
    const tokenMap = new Map<string, string>(
      (signups ?? []).map((s) => [s.id as string, (s as SignupTokenRow).unsubscribe_token]),
    );

    let sent = 0;
    let failed = 0;
    for (const d of deliveries as DeliveryRow[]) {
      const broadcast = broadcastMap.get(d.broadcast_id);
      if (!broadcast) {
        await this.markDelivery(d.id, 'failed', null, 'broadcast não encontrado');
        failed++;
        continue;
      }
      const token = tokenMap.get(d.signup_id) ?? '';
      const subject = broadcast.post_title;
      const html = renderHtml({
        title: broadcast.post_title,
        excerpt: broadcast.post_excerpt,
        coverUrl: broadcast.cover_image_url,
        postUrl: `${SITE_URL}/blog/${broadcast.post_slug}`,
        unsubscribeUrl: this.svc.unsubscribeUrl(token),
      });

      const r = await this.emailSettings.sendVia(
        cfg.provider, cfg.apiKey, cfg.fromName, cfg.fromAddress,
        d.email, subject, html,
      );
      if (r.ok) {
        await this.markDelivery(d.id, 'sent', r.messageId ?? null, null);
        sent++;
      } else {
        await this.markDelivery(d.id, 'failed', null, r.error ?? 'erro desconhecido');
        failed++;
      }
    }

    // Atualiza totals dos broadcasts tocados
    for (const bid of broadcastIds) {
      await this.refreshBroadcastTotals(bid);
    }

    this.log.log(`[newsletter] tick processou ${deliveries.length} (sent=${sent} failed=${failed})`);
    return { processed: deliveries.length };
  }

  private async markDelivery(
    id: string,
    status: 'sent' | 'failed',
    messageId: string | null,
    err: string | null,
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from('blog_newsletter_deliveries')
      .update({
        status,
        provider_message_id: messageId,
        error_message: err,
        attempted_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) this.log.warn(`markDelivery ${id} falhou: ${error.message}`);
  }

  /** Conta sent/failed de um broadcast e marca status quando 100% processado. */
  private async refreshBroadcastTotals(broadcastId: string): Promise<void> {
    const { data: stats } = await supabaseAdmin
      .from('blog_newsletter_deliveries')
      .select('status')
      .eq('broadcast_id', broadcastId);
    if (!stats) return;
    const sent = stats.filter((s) => s.status === 'sent').length;
    const failed = stats.filter((s) => s.status === 'failed').length;
    const pending = stats.filter((s) => s.status === 'pending').length;
    const update: Record<string, unknown> = {
      total_sent: sent,
      total_failed: failed,
    };
    if (pending === 0) {
      update.status = failed > 0 && sent === 0 ? 'failed' : 'sent';
      update.finished_at = new Date().toISOString();
    } else {
      update.status = 'sending';
    }
    await supabaseAdmin.from('blog_newsletter_broadcasts').update(update).eq('id', broadcastId);
  }
}

/** Template HTML simples (cyan/black, marca e-Click). Compatível com clientes
 *  conservadores (Gmail/Outlook), usa table inline pra layout. */
function renderHtml(input: {
  title: string;
  excerpt: string | null;
  coverUrl: string | null;
  postUrl: string;
  unsubscribeUrl: string;
}): string {
  const safeTitle = escapeHtml(input.title);
  const safeExcerpt = input.excerpt ? escapeHtml(input.excerpt) : '';
  const cover = input.coverUrl
    ? `<img src="${escapeAttr(input.coverUrl)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:12px;margin-bottom:24px;" />`
    : '';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#09090b;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0f0f12;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;">
        <tr><td>
          <div style="color:#00E5FF;font-weight:800;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;">Blog e-Click</div>
          ${cover}
          <h1 style="font-size:26px;font-weight:700;letter-spacing:-0.02em;margin:0 0 14px;color:#fafafa;">${safeTitle}</h1>
          ${safeExcerpt ? `<p style="color:#a1a1aa;font-size:15.5px;line-height:1.6;margin:0 0 24px;">${safeExcerpt}</p>` : ''}
          <a href="${escapeAttr(input.postUrl)}" style="display:inline-block;background:#00E5FF;color:#04141a;font-weight:800;font-size:14.5px;padding:13px 22px;border-radius:10px;text-decoration:none;">Ler agora →</a>
        </td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:11.5px;color:#71717a;">
        Você recebeu porque se inscreveu em <a href="${SITE_URL}/blog" style="color:#a1a1aa;">eclick.app.br/blog</a>.<br/>
        <a href="${escapeAttr(input.unsubscribeUrl)}" style="color:#71717a;text-decoration:underline;">Cancelar inscrição</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
