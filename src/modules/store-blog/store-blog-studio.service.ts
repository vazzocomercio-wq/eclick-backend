import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { supabaseAdmin } from '../../common/supabase';
import { LlmService } from '../ai/llm.service';
import { STORE_ARTICLE_SYSTEM_PROMPT, STORE_IDEATE_SYSTEM_PROMPT } from './store-blog.prompts';

export type StoreBlogPromptKey = 'article' | 'ideate';

export interface StoreBlogSettings {
  voice: string | null;
  prompt_article: string | null;
  prompt_ideate: string | null;
  display_font: string | null;
}

export interface StoreBlogKnowledge {
  id: string;
  source_type: 'url' | 'text';
  value: string;
  title: string | null;
  extracted_text: string | null;
  is_active: boolean;
  created_at: string;
}

const PROMPT_DEFAULTS: Record<StoreBlogPromptKey, string> = {
  article: STORE_ARTICLE_SYSTEM_PROMPT,
  ideate: STORE_IDEATE_SYSTEM_PROMPT,
};

/**
 * Estúdio do Blog da Loja: voz da marca, system prompts editáveis (article/
 * ideate), base de conhecimento e fonte (key fontPair). Esparso — código = fallback.
 */
@Injectable()
export class StoreBlogStudioService {
  private readonly log = new Logger(StoreBlogStudioService.name);

  constructor(private readonly llm: LlmService) {}

  private get db() {
    return supabaseAdmin;
  }

  // ── settings (voz + fonte) ───────────────────────────────────────────

  async getSettings(orgId: string): Promise<StoreBlogSettings> {
    const { data } = await this.db
      .from('store_blog_settings')
      .select('voice, prompt_article, prompt_ideate, display_font')
      .eq('organization_id', orgId)
      .maybeSingle();
    const r = data as StoreBlogSettings | null;
    return {
      voice: r?.voice ?? null,
      prompt_article: r?.prompt_article ?? null,
      prompt_ideate: r?.prompt_ideate ?? null,
      display_font: r?.display_font ?? null,
    };
  }

  async updateSettings(
    orgId: string,
    dto: { voice?: string | null; display_font?: string | null },
  ): Promise<StoreBlogSettings> {
    const payload: Record<string, unknown> = { organization_id: orgId, updated_at: new Date().toISOString() };
    if ('voice' in dto) payload.voice = dto.voice ?? null;
    if ('display_font' in dto) payload.display_font = dto.display_font || null;
    const { error } = await this.db.from('store_blog_settings').upsert(payload, { onConflict: 'organization_id' });
    if (error) throw new BadRequestException(error.message);
    return this.getSettings(orgId);
  }

  async getDisplayFont(orgId: string): Promise<string | null> {
    try {
      const { data } = await this.db
        .from('store_blog_settings')
        .select('display_font')
        .eq('organization_id', orgId)
        .maybeSingle();
      return (data as { display_font?: string } | null)?.display_font ?? null;
    } catch {
      return null;
    }
  }

  async getVoice(orgId: string): Promise<string | undefined> {
    try {
      const { data } = await this.db.from('store_blog_settings').select('voice').eq('organization_id', orgId).maybeSingle();
      return (data as { voice?: string } | null)?.voice?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // ── prompts editáveis ────────────────────────────────────────────────

  async listPrompts(orgId: string): Promise<Array<{ key: StoreBlogPromptKey; prompt: string; is_default: boolean }>> {
    const { data } = await this.db
      .from('store_blog_settings')
      .select('prompt_article, prompt_ideate')
      .eq('organization_id', orgId)
      .maybeSingle();
    const r = data as { prompt_article?: string; prompt_ideate?: string } | null;
    return (['article', 'ideate'] as StoreBlogPromptKey[]).map((key) => {
      const override = key === 'article' ? r?.prompt_article : r?.prompt_ideate;
      return override?.trim()
        ? { key, prompt: override, is_default: false }
        : { key, prompt: PROMPT_DEFAULTS[key], is_default: true };
    });
  }

  async upsertPrompt(orgId: string, key: StoreBlogPromptKey, prompt: string): Promise<{ ok: true }> {
    if (!PROMPT_DEFAULTS[key]) throw new BadRequestException(`key inválida: ${key}`);
    if (!prompt?.trim()) throw new BadRequestException('prompt obrigatório');
    const col = key === 'article' ? 'prompt_article' : 'prompt_ideate';
    const { error } = await this.db
      .from('store_blog_settings')
      .upsert({ organization_id: orgId, [col]: prompt.trim(), updated_at: new Date().toISOString() }, { onConflict: 'organization_id' });
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  async resetPrompt(orgId: string, key: StoreBlogPromptKey): Promise<{ ok: true }> {
    const col = key === 'article' ? 'prompt_article' : 'prompt_ideate';
    await this.db
      .from('store_blog_settings')
      .upsert({ organization_id: orgId, [col]: null, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' });
    return { ok: true };
  }

  async resolveSystemPrompt(orgId: string, key: StoreBlogPromptKey): Promise<string> {
    try {
      const col = key === 'article' ? 'prompt_article' : 'prompt_ideate';
      const { data } = await this.db.from('store_blog_settings').select(col).eq('organization_id', orgId).maybeSingle();
      const override = (data as Record<string, string | null> | null)?.[col];
      if (override?.trim()) return override;
    } catch (e) {
      this.log.warn(`resolveSystemPrompt(${key}) fallback: ${(e as Error).message}`);
    }
    return PROMPT_DEFAULTS[key];
  }

  async generatePrompt(orgId: string, dto: { key: StoreBlogPromptKey; instruction: string; current_prompt?: string }): Promise<{ prompt: string }> {
    if (!dto.instruction?.trim()) throw new BadRequestException('instruction obrigatória');
    const what =
      dto.key === 'article'
        ? 'o SYSTEM PROMPT do redator de artigos do blog da loja (que retorna JSON estruturado e apresenta produtos reais)'
        : 'o SYSTEM PROMPT do estrategista que sugere pautas do blog da loja (retorna JSON)';
    const out = await this.llm.generateText({
      orgId,
      feature: 'store_blog_ideate',
      systemPrompt: `Você ajuda a escrever SYSTEM PROMPTS pra IA de conteúdo do blog de uma loja. Reescreva ${what}, mantendo o CONTRATO DE SAÍDA (mesmo schema JSON) intacto — só ajuste tom/foco/instruções. Responda APENAS com o texto do prompt, sem markdown.`,
      userPrompt: [
        dto.current_prompt ? `PROMPT ATUAL:\n${dto.current_prompt}` : `PARTA DO PADRÃO:\n${PROMPT_DEFAULTS[dto.key]}`,
        `INTENÇÃO: ${dto.instruction}`,
      ].join('\n\n'),
      maxTokens: 4000,
      temperature: 0.5,
    });
    return { prompt: (out.text ?? '').trim() };
  }

  // ── base de conhecimento ─────────────────────────────────────────────

  async listKnowledge(orgId: string): Promise<StoreBlogKnowledge[]> {
    const { data } = await this.db
      .from('store_blog_knowledge')
      .select('id, source_type, value, title, extracted_text, is_active, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    return (data ?? []) as StoreBlogKnowledge[];
  }

  async addKnowledge(orgId: string, dto: { source_type: 'url' | 'text'; value: string; title?: string }): Promise<StoreBlogKnowledge> {
    if (!dto.value?.trim()) throw new BadRequestException('value obrigatório');
    let title = dto.title ?? null;
    let extracted: string | null = null;
    if (dto.source_type === 'url') {
      try {
        const res = await fetch(dto.value, { signal: AbortSignal.timeout(8000) });
        const html = await res.text();
        const t = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
        title = title || (t?.[1]?.trim() ?? new URL(dto.value).hostname);
        extracted = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000) || null;
      } catch {
        title = title || dto.value.slice(0, 40);
      }
    } else {
      extracted = dto.value.trim().slice(0, 6000);
      title = title || 'Nota';
    }
    const { data, error } = await this.db
      .from('store_blog_knowledge')
      .insert({ organization_id: orgId, source_type: dto.source_type, value: dto.value.trim(), title, extracted_text: extracted })
      .select('id, source_type, value, title, extracted_text, is_active, created_at')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as StoreBlogKnowledge;
  }

  async removeKnowledge(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await this.db.from('store_blog_knowledge').delete().eq('organization_id', orgId).eq('id', id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  /** Bloco de conhecimento pra injetar no prompt de geração. Best-effort. */
  async getKnowledgeBlock(orgId: string): Promise<string | undefined> {
    try {
      const { data } = await this.db
        .from('store_blog_knowledge')
        .select('source_type, title, value, extracted_text')
        .eq('organization_id', orgId)
        .eq('is_active', true);
      const rows = (data ?? []) as Array<Pick<StoreBlogKnowledge, 'source_type' | 'title' | 'value' | 'extracted_text'>>;
      const parts = rows
        .map((r) => {
          const txt = (r.extracted_text || '').trim();
          if (!txt) return '';
          const head = r.source_type === 'url' ? `${r.title || 'Fonte'} (${r.value})` : r.title || 'Nota';
          return `### ${head}\n${txt.slice(0, 2500)}`;
        })
        .filter(Boolean);
      if (!parts.length) return undefined;
      return parts.join('\n\n').slice(0, 8000);
    } catch {
      return undefined;
    }
  }
}
