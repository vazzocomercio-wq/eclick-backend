import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '../../common/supabase';
import type {
  BlogNewsletterSignupDto,
  BlogNewsletterSignupRow,
  NotifySubscribersDto,
} from './blog-newsletter.types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE_URL = 'https://eclick.app.br';

/**
 * Captação + listagem de inscritos da newsletter do blog (eclick.app.br/blog).
 * NÃO multi-tenant — é a newsletter DA e-Click.
 */
@Injectable()
export class BlogNewsletterService {
  private readonly log = new Logger(BlogNewsletterService.name);

  private get db() {
    return supabaseAdmin;
  }

  /**
   * Inscreve um email no widget público do blog.
   *
   * - Idempotente: mesmo email retorna a row existente sem erro.
   * - Re-inscrição: se estava `unsubscribed`, volta pra `active`.
   * - Rate-limit cabe ao caller (controller usa ip_hash); aqui só persiste.
   */
  async signup(dto: BlogNewsletterSignupDto, meta: { ip?: string; userAgent?: string }): Promise<{
    ok: true;
    reactivated: boolean;
    alreadyActive: boolean;
  }> {
    const email = (dto.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException('Email inválido.');
    }

    const ipHash = meta.ip ? this.hashIp(meta.ip) : null;
    const ua = (meta.userAgent ?? '').slice(0, 400) || null;

    // Tenta achar inscrito existente (por email_lower único).
    const { data: existing } = await this.db
      .from('blog_newsletter_signups')
      .select('id, status')
      .eq('email_lower', email)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'active') {
        return { ok: true, reactivated: false, alreadyActive: true };
      }
      // unsubscribed/bounced → reativa
      const { error: updErr } = await this.db
        .from('blog_newsletter_signups')
        .update({ status: 'active', unsubscribed_at: null })
        .eq('id', existing.id);
      if (updErr) throw new BadRequestException(updErr.message);
      this.log.log(`[newsletter] reativou inscrição ${existing.id} (${email})`);
      return { ok: true, reactivated: true, alreadyActive: false };
    }

    const utm = dto.utm ?? {};
    const { error: insErr } = await this.db.from('blog_newsletter_signups').insert({
      email,
      source_post_slug: dto.sourcePostSlug ?? null,
      source_position: dto.sourcePosition ?? null,
      utm_source: utm.source ?? null,
      utm_medium: utm.medium ?? null,
      utm_campaign: utm.campaign ?? null,
      ip_hash: ipHash,
      user_agent: ua,
    });
    if (insErr) {
      // race condition no email unique → trata como sucesso idempotente
      if ((insErr as { code?: string }).code === '23505') {
        return { ok: true, reactivated: false, alreadyActive: true };
      }
      throw new BadRequestException(insErr.message);
    }
    this.log.log(`[newsletter] nova inscrição ${email} (source=${dto.sourcePosition ?? '?'})`);
    return { ok: true, reactivated: false, alreadyActive: false };
  }

  /**
   * Opt-out via token. Retorna HTML simples (página de confirmação).
   */
  async unsubscribe(token: string): Promise<{ ok: boolean; email?: string; alreadyOut?: boolean }> {
    if (!token || token.length < 32) return { ok: false };
    const { data: row } = await this.db
      .from('blog_newsletter_signups')
      .select('id, email, status')
      .eq('unsubscribe_token', token)
      .maybeSingle();
    if (!row) return { ok: false };
    if (row.status === 'unsubscribed') return { ok: true, email: row.email, alreadyOut: true };
    const { error } = await this.db
      .from('blog_newsletter_signups')
      .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) return { ok: false };
    this.log.log(`[newsletter] opt-out ${row.email}`);
    return { ok: true, email: row.email };
  }

  /**
   * Lista todos os inscritos ativos (paginado, p/ broadcast).
   */
  async listActive(limit = 1000, offset = 0): Promise<BlogNewsletterSignupRow[]> {
    const { data, error } = await this.db
      .from('blog_newsletter_signups')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as BlogNewsletterSignupRow[];
  }

  /**
   * Enfileira broadcast para um post novo. Cria 1 row em broadcasts +
   * N rows em deliveries (uma por inscrito ativo). Idempotente por slug
   * (UNIQUE constraint).
   */
  async enqueueBroadcast(dto: NotifySubscribersDto): Promise<{
    broadcastId: string | null;
    queued: number;
    alreadySent: boolean;
  }> {
    if (!dto?.slug || !dto?.title) throw new BadRequestException('slug e title obrigatórios');

    // Tenta criar — se já existe (mesmo slug), retorna alreadySent
    const { data: created, error: createErr } = await this.db
      .from('blog_newsletter_broadcasts')
      .insert({
        post_slug: dto.slug,
        post_title: dto.title,
        post_excerpt: dto.excerpt ?? null,
        cover_image_url: dto.coverImageUrl ?? null,
        status: 'queued',
      })
      .select('id')
      .single();

    if (createErr) {
      if ((createErr as { code?: string }).code === '23505') {
        this.log.log(`[newsletter] broadcast pra ${dto.slug} já existe — skip`);
        return { broadcastId: null, queued: 0, alreadySent: true };
      }
      throw new BadRequestException(createErr.message);
    }

    const broadcastId = created.id as string;
    const subs = await this.listActive(10_000, 0);
    if (subs.length === 0) {
      // Marca como sent vazio
      await this.db
        .from('blog_newsletter_broadcasts')
        .update({ status: 'sent', finished_at: new Date().toISOString(), total_targets: 0 })
        .eq('id', broadcastId);
      this.log.log(`[newsletter] broadcast ${broadcastId} sem inscritos — marcado sent vazio`);
      return { broadcastId, queued: 0, alreadySent: false };
    }

    const rows = subs.map((s) => ({
      broadcast_id: broadcastId,
      signup_id: s.id,
      email: s.email,
      status: 'pending' as const,
    }));
    // Bulk insert em chunks de 500
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: dErr } = await this.db.from('blog_newsletter_deliveries').insert(chunk);
      if (dErr) {
        this.log.warn(`[newsletter] insert deliveries falhou chunk ${i}: ${dErr.message}`);
      } else {
        inserted += chunk.length;
      }
    }
    await this.db
      .from('blog_newsletter_broadcasts')
      .update({ total_targets: inserted })
      .eq('id', broadcastId);
    this.log.log(`[newsletter] broadcast ${broadcastId} enfileirado (${inserted} envios) — ${dto.slug}`);
    return { broadcastId, queued: inserted, alreadySent: false };
  }

  /**
   * URL absoluta de unsubscribe pro template do email.
   */
  unsubscribeUrl(token: string): string {
    return `${SITE_URL}/blog/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  private hashIp(ip: string): string {
    const salt = process.env.NEWSLETTER_IP_SALT ?? 'eclick-blog-newsletter';
    return createHash('sha256').update(`${ip}|${salt}`).digest('hex').slice(0, 32);
  }
}
