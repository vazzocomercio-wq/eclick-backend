import { Body, Controller, Delete, Get, Headers, HttpException, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { AiKnowledgeService } from './ai-knowledge.service'

interface CreateKnowledgeDto {
  type:           string                   // faq | policy | product | procedure
  title:          string
  content:        string
  tags?:          string[]
  agent_ids?:     string[]                 // optional: link immediately
  agent_id?:      string                   // legacy single-agent shortcut
}

interface UpdateKnowledgeDto {
  type?:    string
  title?:   string
  content?: string
  tags?:    string[]
  is_active?: boolean
}

@Controller('ai/knowledge')
@UseGuards(SupabaseAuthGuard)
export class AiKnowledgeController {
  constructor(private readonly kb: AiKnowledgeService) {}

  private async resolveOrgId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user?.id ?? '')
      .single()
    if (error || !data) throw new HttpException('Organização não encontrada', 400)
    return data.organization_id as string
  }

  /**
   * GET /ai/knowledge — list with optional filters.
   * If `q` (search query) is set AND `agent_id` provided, runs semantic search
   * and returns top 10 sorted by score; otherwise plain SELECT.
   */
  @Get()
  async list(
    @Headers('authorization') auth: string,
    @Query('agent_id') agentId?: string,
    @Query('type')     type?: string,
    @Query('q')        q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)

    if (q && agentId) {
      const matches = await this.kb.searchSimilar(q, agentId, 10)
      if (!matches.length) return []
      const ids = matches.map(m => m.knowledge_id)
      const { data } = await supabaseAdmin
        .from('ai_knowledge_base')
        .select('*, ai_agent_knowledge(agent_id)')
        .in('id', ids)
      // Preserve order from semantic search
      const byId = new Map((data ?? []).map(r => [r.id, r]))
      return matches.map(m => ({ ...byId.get(m.knowledge_id), score: m.score })).filter(r => r.id)
    }

    let qy = supabaseAdmin
      .from('ai_knowledge_base')
      .select('*, ai_agent_knowledge(agent_id)')
      .order('updated_at', { ascending: false })
      .limit(200)

    if (type)    qy = qy.eq('type', type)
    if (agentId) qy = qy.eq('ai_agent_knowledge.agent_id', agentId)

    const { data, error } = await qy
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  @Post()
  async create(
    @Headers('authorization') auth: string,
    @Body() body: CreateKnowledgeDto,
  ) {
    await this.resolveOrgId(auth) // auth check
    if (!body.title?.trim() || !body.content?.trim() || !body.type) {
      throw new HttpException('title, content e type são obrigatórios', 400)
    }

    const { data: row, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .insert({
        type:    body.type,
        title:   body.title,
        content: body.content,
        tags:    body.tags ?? [],
        agent_id: body.agent_id ?? null, // legacy column kept for backward-compat
      })
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)

    // Generate embedding (best-effort — don't fail the whole create on embedding failure)
    try {
      await this.kb.upsertEmbedding(row.id, `${body.title}\n\n${body.content}`)
    } catch (e: any) {
      // logged inside service
    }

    // Link to agents (M2M)
    const agentIds = body.agent_ids ?? (body.agent_id ? [body.agent_id] : [])
    if (agentIds.length) {
      await supabaseAdmin
        .from('ai_agent_knowledge')
        .upsert(agentIds.map(aid => ({ agent_id: aid, knowledge_id: row.id })), { onConflict: 'agent_id,knowledge_id' })
    }

    return row
  }

  @Patch(':id')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: UpdateKnowledgeDto,
  ) {
    await this.resolveOrgId(auth)
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .update(body)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)

    // Regenerate embedding if content (or title) changed
    if (body.content !== undefined || body.title !== undefined) {
      try {
        await this.kb.upsertEmbedding(id, `${data.title}\n\n${data.content}`)
      } catch { /* logged inside */ }
    }

    return data
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.resolveOrgId(auth)
    const { error } = await supabaseAdmin.from('ai_knowledge_base').delete().eq('id', id)
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }

  // ── Agent ↔ Knowledge linking ────────────────────────────────────────────

  @Post('/agent/:agentId/:kbId')
  @HttpCode(HttpStatus.OK)
  async link(@Param('agentId') agentId: string, @Param('kbId') kbId: string) {
    const { error } = await supabaseAdmin
      .from('ai_agent_knowledge')
      .upsert({ agent_id: agentId, knowledge_id: kbId }, { onConflict: 'agent_id,knowledge_id' })
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }

  @Delete('/agent/:agentId/:kbId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(@Param('agentId') agentId: string, @Param('kbId') kbId: string) {
    const { error } = await supabaseAdmin
      .from('ai_agent_knowledge')
      .delete()
      .eq('agent_id', agentId)
      .eq('knowledge_id', kbId)
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }
}
