import { Injectable, Logger, HttpException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'
import { AiSettingsService } from './ai-settings.service'

@Injectable()
export class AiKnowledgeService {
  private readonly logger = new Logger(AiKnowledgeService.name)

  constructor(
    private readonly credentials: CredentialsService,
    private readonly settings:    AiSettingsService,
  ) {}

  /**
   * Generates an embedding for the given text using the provider/model
   * configured in ai_module_settings (default: openai text-embedding-3-small).
   * Returns a vector of 1536 numbers (compatible with the column type).
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const cfg = await this.settings.getSettings()
    const provider = cfg.embedding_provider ?? 'openai'
    const model    = cfg.embedding_model    ?? 'text-embedding-3-small'

    if (provider !== 'openai') {
      throw new HttpException(`Provider "${provider}" não suportado para embeddings ainda`, 400)
    }

    const apiKey = await this.getProviderKey(provider)
    if (!apiKey) throw new HttpException(`Sem credencial ativa para ${provider}`, 400)

    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model, input: text },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
      )
      const vec = data?.data?.[0]?.embedding as number[] | undefined
      if (!vec || !Array.isArray(vec)) throw new Error('OpenAI não retornou embedding')
      return vec
    } catch (e: any) {
      this.logger.error(`[embedding] ${e?.response?.status ?? '?'} ${e?.message}`)
      throw new HttpException(e?.response?.data?.error?.message ?? e?.message ?? 'Falha ao gerar embedding', 502)
    }
  }

  /**
   * Top-N most similar knowledge entries for a query, restricted to entries
   * the given agent has access to (via ai_agent_knowledge join).
   */
  async searchSimilar(
    query: string,
    agentId: string,
    limit = 5,
  ): Promise<Array<{ knowledge_id: string; content: string; score: number }>> {
    const queryEmbedding = await this.generateEmbedding(query)

    // pgvector cosine distance: 1 - (a <=> b) → similarity. Lower distance = closer.
    // Using a Postgres function via supabase RPC keeps the query indexed (ivfflat).
    // If the RPC doesn't exist, fall back to a simple SELECT with cosine_distance.
    const { data, error } = await supabaseAdmin.rpc('match_agent_knowledge', {
      query_embedding: queryEmbedding,
      match_agent_id:  agentId,
      match_count:     limit,
    })

    if (!error && data) return data as { knowledge_id: string; content: string; score: number }[]

    // Fallback: client-side cosine — only works for small KBs.
    // Logs a warning so the user knows to create the RPC for production scale.
    this.logger.warn(`[searchSimilar] RPC match_agent_knowledge missing (${error?.message ?? 'no data'}); falling back to client-side filter`)

    const { data: rows } = await supabaseAdmin
      .from('ai_knowledge_embeddings')
      .select('knowledge_id, content, embedding, ai_agent_knowledge!inner(agent_id)')
      .eq('ai_agent_knowledge.agent_id', agentId)
      .limit(50)

    if (!rows?.length) return []

    const scored = (rows as Array<{ knowledge_id: string; content: string; embedding: number[] }>).map(r => ({
      knowledge_id: r.knowledge_id,
      content:      r.content,
      score:        cosineSimilarity(queryEmbedding, r.embedding),
    }))

    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Persist embedding for a knowledge_base row. Replaces any existing row. */
  async upsertEmbedding(knowledgeId: string, content: string): Promise<void> {
    const embedding = await this.generateEmbedding(content)

    // Replace any existing embedding for this knowledge_id
    await supabaseAdmin.from('ai_knowledge_embeddings').delete().eq('knowledge_id', knowledgeId)
    const { error } = await supabaseAdmin.from('ai_knowledge_embeddings').insert({
      knowledge_id: knowledgeId,
      content,
      embedding,
    })
    if (error) this.logger.warn(`[upsertEmbedding] insert failed kb=${knowledgeId}: ${error.message}`)
  }

  /** Bump times_used + last_used_at when a knowledge entry is cited in a response. */
  async recordUsage(knowledgeIds: string[]): Promise<void> {
    if (!knowledgeIds.length) return
    // Postgres: increment times_used and update last_used_at for each id
    for (const id of knowledgeIds) {
      const { data: row } = await supabaseAdmin
        .from('ai_knowledge_base')
        .select('times_used')
        .eq('id', id)
        .maybeSingle()
      const times = (row?.times_used ?? 0) + 1
      await supabaseAdmin
        .from('ai_knowledge_base')
        .update({ times_used: times, last_used_at: new Date().toISOString() })
        .eq('id', id)
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async getProviderKey(provider: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('api_credentials')
      .select('encrypted_value')
      .eq('provider', provider)
      .eq('is_active', true)
      .maybeSingle()
    if (!data?.encrypted_value) return null
    try {
      return this.credentials.decrypt(data.encrypted_value as string)
    } catch (e) {
      this.logger.error(`[getProviderKey] decrypt failed for ${provider}: ${(e as Error).message}`)
      return null
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
