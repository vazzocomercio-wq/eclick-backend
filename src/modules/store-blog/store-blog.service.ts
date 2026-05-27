import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../common/supabase';
import { LlmService } from '../ai/llm.service';
import { StoreBlogStudioService } from './store-blog-studio.service';
import {
  buildStoreArticleUserPrompt,
  buildStoreIdeateUserPrompt,
  fallbackCoverPrompt,
} from './store-blog.prompts';
import type {
  GenerateStorePostDto,
  IdeateStoreDto,
  PortableTextNode,
  RawArticle,
  RawArticleBlock,
  RawArticleSection,
  StoreBlogPostRow,
  StoreProductLite,
  StoreTopicIdea,
} from './store-blog.types';

const BUCKET = 'storefront-assets';

/**
 * Motor do Blog da Loja: gera artigo GEO ciente dos produtos da loja + capa,
 * fila de revisão, publica direto no SaaS (vitrine /loja/[slug]/blog renderiza).
 */
@Injectable()
export class StoreBlogService {
  private readonly log = new Logger(StoreBlogService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly studio: StoreBlogStudioService,
  ) {}

  private get db() {
    return supabaseAdmin;
  }

  // ── contexto da loja ───────────────────────────────────────────────

  private async loadStore(orgId: string): Promise<{ store_name?: string; voice?: string }> {
    const { data } = await this.db
      .from('store_config')
      .select('store_name')
      .eq('organization_id', orgId)
      .maybeSingle();
    const row = data as { store_name?: string } | null;
    return { store_name: row?.store_name, voice: undefined };
  }

  async listProducts(orgId: string, ids?: string[], limit = 40): Promise<StoreProductLite[]> {
    let q = this.db
      .from('products')
      .select('id, name, category, brand, price, photo_urls, ai_short_description, description, storefront_visible')
      .eq('organization_id', orgId);
    if (ids?.length) q = q.in('id', ids);
    else q = q.eq('storefront_visible', true).order('updated_at', { ascending: false }).limit(limit);
    const { data } = await q;
    return ((data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: p.id as string,
      name: p.name as string,
      category: (p.category as string) ?? null,
      brand: (p.brand as string) ?? null,
      price: Number((p.price as number) ?? 0),
      photo_url: (p.photo_urls as string[] | null)?.[0] ?? null,
      short_description:
        (p.ai_short_description as string) ?? (p.description ? (p.description as string).slice(0, 200) : null),
    }));
  }

  // ── geração ─────────────────────────────────────────────────────────

  async generateArticle(orgId: string, userId: string | null, dto: GenerateStorePostDto): Promise<StoreBlogPostRow> {
    if (!dto.topic?.trim()) throw new BadRequestException('Informe o tema/pauta.');
    const postId = await this.createDraft(orgId, userId, dto.topic);
    return this.runGeneration(orgId, postId, dto.topic, dto.productIds, dto.notes, dto.generateCover);
  }

  private async createDraft(orgId: string, userId: string | null, topic: string): Promise<string> {
    const { data, error } = await this.db
      .from('store_blog_posts')
      .insert({
        organization_id: orgId,
        created_by: userId,
        title: topic.slice(0, 180),
        slug: `rascunho-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'generating',
        source_topic: topic,
      })
      .select('id')
      .single();
    if (error) throw new BadRequestException(`store_blog_posts insert: ${error.message}`);
    return (data as { id: string }).id;
  }

  private async runGeneration(
    orgId: string,
    postId: string,
    topic: string,
    productIds?: string[],
    notes?: string,
    generateCover = true,
  ): Promise<StoreBlogPostRow> {
    const t0 = Date.now();
    try {
      const [store, products, system, voice, knowledge] = await Promise.all([
        this.loadStore(orgId),
        this.listProducts(orgId, productIds),
        this.studio.resolveSystemPrompt(orgId, 'article'),
        this.studio.getVoice(orgId),
        this.studio.getKnowledgeBlock(orgId),
      ]);
      const out = await this.llm.generateText({
        orgId,
        feature: 'store_blog_article',
        systemPrompt: system,
        userPrompt: buildStoreArticleUserPrompt({ topic, notes, storeName: store.store_name, voice, knowledge, products }),
        jsonMode: true,
        maxTokens: 6000,
        temperature: 0.6,
      });
      const art = this.parseJson<RawArticle>(out.text);
      if (!art?.title || !art.sections?.length) {
        await this.markFailed(postId, 'IA retornou JSON inválido');
        throw new BadRequestException('Geração falhou — a IA não retornou um artigo válido.');
      }

      const validIds = new Set(products.map((p) => p.id));
      const body = this.toPortableText(art.sections, validIds);
      const slug = this.slugify(art.slug || art.title);
      let totalCost = out.costUsd ?? 0;

      // imagens inline (até 2) só se cover habilitado
      if (generateCover !== false) {
        totalCost += await this.generateInlineImages(orgId, body);
      } else {
        this.stripInlineImagePlaceholders(body);
      }

      let coverUrl: string | null = null;
      if (generateCover !== false) {
        const cov = await this.generateAndUploadImage(orgId, art.coverImagePrompt || fallbackCoverPrompt(art.title));
        coverUrl = cov.url;
        totalCost += cov.cost;
      }

      const featured = (art.featuredProductIds ?? []).filter((id) => validIds.has(id));

      const { data: updated, error: updErr } = await this.db
        .from('store_blog_posts')
        .update({
          title: art.title,
          slug,
          excerpt: art.excerpt ?? null,
          tldr: art.tldr ?? [],
          body,
          faq: art.faq ?? [],
          ai_prompts: art.aiPrompts ?? [],
          citation_sources: art.citationSources ?? [],
          tags: art.tags ?? [],
          featured_product_ids: featured,
          cover_image_url: coverUrl,
          seo_title: art.seoTitle ?? null,
          meta_description: art.metaDescription ?? null,
          focus_keyword: art.focusKeyword ?? null,
          reading_time_minutes: art.readingTimeMinutes ?? null,
          status: 'review',
          cost_usd: totalCost,
          generation_metadata: { latency_ms: Date.now() - t0, cover_prompt: art.coverImagePrompt ?? null },
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId)
        .eq('organization_id', orgId)
        .select('*')
        .single();
      if (updErr) throw new BadRequestException(`store_blog_posts update: ${updErr.message}`);
      this.log.log(`[store-blog] artigo ${postId} gerado em ${Date.now() - t0}ms (review)`);
      return updated as StoreBlogPostRow;
    } catch (e) {
      if (!(e instanceof BadRequestException)) await this.markFailed(postId, (e as Error).message);
      throw e;
    }
  }

  async generateBatch(orgId: string, userId: string | null, dto: IdeateStoreDto): Promise<StoreBlogPostRow[]> {
    const { topics } = await this.ideate(orgId, dto);
    if (!topics.length) throw new BadRequestException('A IA não sugeriu pautas — tente outra semente.');
    const drafts: Array<{ id: string; topic: string; productIds?: string[] }> = [];
    for (const tpc of topics) {
      const id = await this.createDraft(orgId, userId, tpc.title);
      drafts.push({ id, topic: tpc.title, productIds: tpc.productIds });
    }
    void this.runBatch(orgId, drafts);
    const { data } = await this.db
      .from('store_blog_posts')
      .select('*')
      .in('id', drafts.map((d) => d.id));
    return (data ?? []) as StoreBlogPostRow[];
  }

  private async runBatch(orgId: string, drafts: Array<{ id: string; topic: string; productIds?: string[] }>): Promise<void> {
    for (const d of drafts) {
      try {
        await this.runGeneration(orgId, d.id, d.topic, d.productIds);
      } catch (e) {
        this.log.warn(`[store-blog] lote item ${d.id} falhou: ${(e as Error).message}`);
      }
    }
  }

  async ideate(orgId: string, dto: IdeateStoreDto): Promise<{ topics: StoreTopicIdea[] }> {
    const count = Math.min(Math.max(dto.count ?? 5, 1), 10);
    const [store, products, existing, system] = await Promise.all([
      this.loadStore(orgId),
      this.listProducts(orgId, undefined, 50),
      this.db
        .from('store_blog_posts')
        .select('title')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(50),
      this.studio.resolveSystemPrompt(orgId, 'ideate'),
    ]);
    const existingTitles = ((existing.data ?? []) as Array<{ title: string }>).map((r) => r.title);
    const out = await this.llm.generateText({
      orgId,
      feature: 'store_blog_ideate',
      systemPrompt: system,
      userPrompt: buildStoreIdeateUserPrompt({ seed: dto.seed, count, storeName: store.store_name, existingTitles, products }),
      jsonMode: true,
      maxTokens: 2000,
      temperature: 0.8,
    });
    const parsed = this.parseJson<{ topics?: StoreTopicIdea[] }>(out.text);
    const topics = (parsed?.topics ?? [])
      .filter((t): t is StoreTopicIdea => !!t && typeof t.title === 'string' && t.title.length > 0)
      .slice(0, count);
    return { topics };
  }

  // ── CRUD pipeline ────────────────────────────────────────────────────

  async list(orgId: string, status?: string): Promise<StoreBlogPostRow[]> {
    let q = this.db
      .from('store_blog_posts')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new BadRequestException(`store_blog_posts list: ${error.message}`);
    return (data ?? []) as StoreBlogPostRow[];
  }

  async get(orgId: string, id: string): Promise<StoreBlogPostRow> {
    const { data } = await this.db
      .from('store_blog_posts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (!data) throw new NotFoundException('Post não encontrado');
    return data as StoreBlogPostRow;
  }

  async reject(orgId: string, id: string, reason?: string): Promise<StoreBlogPostRow> {
    const { data, error } = await this.db
      .from('store_blog_posts')
      .update({ status: 'archived', rejected_reason: reason ?? null, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as StoreBlogPostRow;
  }

  async publish(orgId: string, id: string): Promise<StoreBlogPostRow> {
    const row = await this.get(orgId, id);
    if (row.status === 'generating') throw new BadRequestException('Artigo ainda gerando.');
    const nowIso = new Date().toISOString();
    const { data, error } = await this.db
      .from('store_blog_posts')
      .update({ status: 'published', published_at: row.published_at ?? nowIso, updated_at: nowIso })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    const published = data as StoreBlogPostRow;
    void this.revalidateStoreBlog(await this.slugForOrg(orgId), published.slug);
    this.log.log(`[store-blog] post ${id} publicado`);
    return published;
  }

  /** Slug público da loja (store_config). */
  private async slugForOrg(orgId: string): Promise<string | null> {
    const { data } = await this.db.from('store_config').select('store_slug').eq('organization_id', orgId).maybeSingle();
    return (data as { store_slug?: string } | null)?.store_slug ?? null;
  }

  /**
   * Avisa o frontend pra revalidar a vitrine do blog da loja (post aparece na
   * hora). Best-effort. Env: STORE_BLOG_REVALIDATE_URL (ou BLOG_REVALIDATE_URL)
   * + BLOG_REVALIDATE_SECRET.
   */
  private async revalidateStoreBlog(slug: string | null, postSlug?: string): Promise<void> {
    const url = process.env.STORE_BLOG_REVALIDATE_URL || process.env.BLOG_REVALIDATE_URL;
    const secret = process.env.BLOG_REVALIDATE_SECRET;
    if (!url || !secret || !slug) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, storeSlug: slug, postSlug }),
      });
    } catch (e) {
      this.log.warn(`revalidate store-blog falhou (non-fatal): ${(e as Error).message}`);
    }
  }

  async schedule(orgId: string, id: string, scheduledForIso: string): Promise<StoreBlogPostRow> {
    const when = new Date(scheduledForIso);
    if (Number.isNaN(when.getTime())) throw new BadRequestException('Data/hora inválida.');
    if (when.getTime() < Date.now() - 60_000) throw new BadRequestException('Agende para um horário futuro.');
    const row = await this.get(orgId, id);
    if (row.status === 'generating') throw new BadRequestException('Artigo ainda gerando.');
    if (row.status === 'published') throw new BadRequestException('Post já publicado.');
    const { data, error } = await this.db
      .from('store_blog_posts')
      .update({ status: 'scheduled', scheduled_for: when.toISOString(), updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as StoreBlogPostRow;
  }

  async unschedule(orgId: string, id: string): Promise<StoreBlogPostRow> {
    const { data, error } = await this.db
      .from('store_blog_posts')
      .update({ status: 'review', scheduled_for: null, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .eq('status', 'scheduled')
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as StoreBlogPostRow;
  }

  // ── leitura pública (vitrine /loja/[slug]/blog) ──────────────────────

  /** Resolve a org dona da loja a partir do slug público. null se não achar. */
  async resolveOrgBySlug(slug: string): Promise<string | null> {
    const { data } = await this.db
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .maybeSingle();
    return (data as { organization_id?: string } | null)?.organization_id ?? null;
  }

  /** Cards de posts publicados de uma loja (mais recentes primeiro) + fonte do blog. */
  async listPublishedBySlug(slug: string): Promise<{ posts: Array<Record<string, unknown>>; blogFont: string | null }> {
    const orgId = await this.resolveOrgBySlug(slug);
    if (!orgId) return { posts: [], blogFont: null };
    const [{ data }, blogFont] = await Promise.all([
      this.db
        .from('store_blog_posts')
        .select('id, title, slug, excerpt, cover_image_url, reading_time_minutes, tags, published_at')
        .eq('organization_id', orgId)
        .eq('status', 'published')
        .lte('published_at', new Date().toISOString())
        .order('published_at', { ascending: false })
        .limit(100),
      this.studio.getDisplayFont(orgId),
    ]);
    return { posts: (data ?? []) as Array<Record<string, unknown>>, blogFont };
  }

  /** Post publicado (full) + produtos hidratados + fonte do blog. */
  async getPublishedBySlug(
    slug: string,
    postSlug: string,
  ): Promise<{ post: StoreBlogPostRow; products: StoreProductLite[]; blogFont: string | null } | null> {
    const orgId = await this.resolveOrgBySlug(slug);
    if (!orgId) return null;
    const { data } = await this.db
      .from('store_blog_posts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('slug', postSlug)
      .eq('status', 'published')
      .lte('published_at', new Date().toISOString())
      .maybeSingle();
    if (!data) return null;
    const post = data as StoreBlogPostRow;
    const ids = new Set<string>(post.featured_product_ids ?? []);
    for (const node of post.body ?? []) {
      const grid = node as { productIds?: string[] };
      if (node._type === 'productGrid' && Array.isArray(grid.productIds)) {
        for (const id of grid.productIds) ids.add(id);
      }
    }
    const [products, blogFont] = await Promise.all([
      ids.size ? this.listProducts(orgId, [...ids]) : Promise.resolve([]),
      this.studio.getDisplayFont(orgId),
    ]);
    return { post, products, blogFont };
  }

  /** Worker: publica todos os agendados vencidos (cross-org, service_role). Retorna quantos. */
  async publishDue(): Promise<number> {
    const nowIso = new Date().toISOString();
    const { data } = await this.db
      .from('store_blog_posts')
      .select('id, organization_id, slug, published_at')
      .eq('status', 'scheduled')
      .lte('scheduled_for', nowIso)
      .limit(20);
    const rows = (data ?? []) as Array<{ id: string; organization_id: string; slug: string; published_at: string | null }>;
    const slugCache = new Map<string, string | null>();
    let n = 0;
    for (const r of rows) {
      const { error } = await this.db
        .from('store_blog_posts')
        .update({ status: 'published', published_at: r.published_at ?? nowIso, updated_at: nowIso })
        .eq('id', r.id)
        .eq('status', 'scheduled');
      if (error) continue;
      n++;
      if (!slugCache.has(r.organization_id)) slugCache.set(r.organization_id, await this.slugForOrg(r.organization_id));
      void this.revalidateStoreBlog(slugCache.get(r.organization_id) ?? null, r.slug);
    }
    return n;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async markFailed(postId: string, reason: string): Promise<void> {
    await this.db
      .from('store_blog_posts')
      .update({ status: 'failed', rejected_reason: reason.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', postId);
  }

  /** Gera imagem via IA e sobe pro storage. Retorna {url, cost}. Best-effort (url null se falhar). */
  private async generateAndUploadImage(orgId: string, prompt: string): Promise<{ url: string | null; cost: number }> {
    try {
      const out = await this.llm.generateImage({ orgId, feature: 'store_blog_cover', prompt, format: 'wide', n: 1 });
      const img = out.images?.[0];
      if (img?.url && img.url.startsWith('http')) return { url: img.url, cost: out.costUsd };
      if (img?.b64) {
        const path = `${orgId}/blog/${randomUUID()}.png`;
        const buffer = Buffer.from(img.b64, 'base64');
        const { error: upErr } = await this.db.storage.from(BUCKET).upload(path, buffer, { contentType: 'image/png', upsert: false });
        if (upErr) {
          this.log.warn(`[store-blog] upload imagem falhou: ${upErr.message}`);
          return { url: null, cost: out.costUsd };
        }
        const { data: pub } = this.db.storage.from(BUCKET).getPublicUrl(path);
        return { url: pub?.publicUrl ?? null, cost: out.costUsd };
      }
      return { url: null, cost: out.costUsd };
    } catch (e) {
      this.log.warn(`[store-blog] geração de imagem falhou: ${(e as Error).message}`);
      return { url: null, cost: 0 };
    }
  }

  private async generateInlineImages(orgId: string, body: PortableTextNode[]): Promise<number> {
    const MAX = 2;
    const pending = body.filter((n) => n._type === 'image' && typeof n._genPrompt === 'string');
    let done = 0;
    let cost = 0;
    for (const node of pending) {
      if (done >= MAX) {
        this.removeNode(body, node);
        continue;
      }
      const img = await this.generateAndUploadImage(orgId, node._genPrompt as string);
      cost += img.cost;
      if (img.url) {
        node.url = img.url;
        delete node._genPrompt;
        done++;
      } else {
        this.removeNode(body, node);
      }
    }
    return cost;
  }

  private stripInlineImagePlaceholders(body: PortableTextNode[]): void {
    for (const node of body.filter((n) => n._type === 'image' && typeof n._genPrompt === 'string')) {
      this.removeNode(body, node);
    }
  }

  private removeNode(body: PortableTextNode[], node: PortableTextNode): void {
    const idx = body.indexOf(node);
    if (idx >= 0) body.splice(idx, 1);
  }

  private toPortableText(sections: RawArticleSection[], validIds: Set<string>): PortableTextNode[] {
    const out: PortableTextNode[] = [];
    for (const s of sections ?? []) {
      if (s.heading?.trim()) out.push(this.textBlock('h2', s.heading.trim()));
      for (const p of s.paragraphs ?? []) {
        if (p?.trim()) out.push(this.textBlock('normal', p.trim()));
      }
      for (const b of s.blocks ?? []) {
        const node = this.customBlock(b, validIds);
        if (node) out.push(node);
      }
    }
    return out;
  }

  private textBlock(style: string, text: string): PortableTextNode {
    return {
      _type: 'block',
      _key: this.k(),
      style,
      markDefs: [],
      children: [{ _type: 'span', _key: this.k(), text, marks: [] }],
    };
  }

  private customBlock(b: RawArticleBlock, validIds: Set<string>): PortableTextNode | null {
    const _key = this.k();
    switch (b.type) {
      case 'productGrid': {
        const ids = (b.productIds ?? []).filter((id) => validIds.has(id));
        return ids.length ? { _type: 'productGrid', _key, productIds: ids } : null;
      }
      case 'image':
        return b.prompt?.trim()
          ? { _type: 'image', _key, _genPrompt: b.prompt.trim(), alt: b.alt ?? '', caption: b.caption ?? undefined }
          : null;
      case 'stat':
        return b.value && b.label ? { _type: 'stat', _key, value: b.value, label: b.label, source: b.source } : null;
      case 'paperQuote':
        return b.quote
          ? { _type: 'paperQuote', _key, quote: b.quote, paperTitle: b.paperTitle, authors: b.authors, venue: b.venue, url: b.url }
          : null;
      case 'callout':
        return b.body ? { _type: 'callout', _key, variant: b.variant ?? 'info', title: b.title, body: b.body } : null;
      case 'comparison':
        return b.leftLabel && b.rightLabel && b.rows?.length
          ? {
              _type: 'comparison',
              _key,
              leftLabel: b.leftLabel,
              rightLabel: b.rightLabel,
              rows: b.rows.map((r) => ({ _type: 'comparisonRow', _key: this.k(), aspect: r.aspect, left: r.left, right: r.right })),
            }
          : null;
      default:
        return null;
    }
  }

  private slugify(s: string): string {
    return (s || 'post')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80);
  }

  private k(): string {
    return Math.random().toString(36).slice(2, 12);
  }

  private parseJson<T>(raw: string): T | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    const candidate = fenced ? fenced[1] : trimmed;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      const m = /\{[\s\S]*\}/.exec(candidate);
      if (m) {
        try {
          return JSON.parse(m[0]) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
