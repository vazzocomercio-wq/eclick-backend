import { Body, Controller, Delete, Get, Headers, HttpException, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { AiKnowledgeService } from './ai-knowledge.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

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
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
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
  @RequirePermission('ai.view_usage')
  async list(
    @Headers('authorization') auth: string,
    @Query('agent_id') agentId?: string,
    @Query('type')     type?: string,
    @Query('q')        q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)

    if (q && agentId) {
      const matches = await this.kb.searchSimilar(orgId, q, agentId, 10)
      if (!matches.length) return []
      const ids = matches.map(m => m.knowledge_id)
      const { data } = await supabaseAdmin
        .from('ai_knowledge_base')
        .select('*, ai_agent_knowledge(agent_id, organization_id)')
        .eq('organization_id', orgId)
        .in('id', ids)
      // Preserve order from semantic search
      const byId = new Map((data ?? []).map(r => [r.id, r]))
      return matches.map(m => ({ ...byId.get(m.knowledge_id), score: m.score })).filter(r => r.id)
    }

    let qy = supabaseAdmin
      .from('ai_knowledge_base')
      .select('*, ai_agent_knowledge(agent_id, organization_id)')
      .eq('organization_id', orgId)
      .order('updated_at', { ascending: false })
      .limit(200)

    if (type)    qy = qy.eq('type', type)
    if (agentId) qy = qy.eq('ai_agent_knowledge.agent_id', agentId)

    const { data, error } = await qy
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  @Post()
  @RequirePermission('ai.manage_budget')
  async create(
    @Headers('authorization') auth: string,
    @Body() body: CreateKnowledgeDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    if (!body.title?.trim() || !body.content?.trim() || !body.type) {
      throw new HttpException('title, content e type são obrigatórios', 400)
    }

    const { data: row, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .insert({
        organization_id: orgId,
        type:    body.type,
        title:   body.title,
        content: body.content,
        tags:    body.tags ?? [],
        // legacy agent_id removido em AI-6 — vínculo agora é só via M:M abaixo
      })
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)

    // Generate embedding (best-effort — don't fail the whole create on embedding failure)
    try {
      await this.kb.upsertEmbedding(orgId, row.id, `${body.title}\n\n${body.content}`)
    } catch (e: any) {
      // logged inside service
    }

    // Link to agents (M2M) — todos os agents passados precisam ser da mesma org
    const agentIds = body.agent_ids ?? (body.agent_id ? [body.agent_id] : [])
    if (agentIds.length) {
      const { data: validAgents } = await supabaseAdmin
        .from('ai_agents').select('id').eq('organization_id', orgId).in('id', agentIds)
      const validIds = (validAgents ?? []).map(a => a.id as string)
      if (validIds.length) {
        await supabaseAdmin
          .from('ai_agent_knowledge')
          .upsert(
            validIds.map(aid => ({ agent_id: aid, knowledge_id: row.id, organization_id: orgId })),
            { onConflict: 'agent_id,knowledge_id' },
          )
      }
    }

    return row
  }

  @Patch(':id')
  @RequirePermission('ai.manage_budget')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: UpdateKnowledgeDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .update(body)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)

    // Regenerate embedding if content (or title) changed
    if (body.content !== undefined || body.title !== undefined) {
      try {
        await this.kb.upsertEmbedding(orgId, id, `${data.title}\n\n${data.content}`)
      } catch { /* logged inside */ }
    }

    return data
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  async remove(@Headers('authorization') auth: string, @Param('id') id: string) {
    const orgId = await this.resolveOrgId(auth)
    const { error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }

  // ── Agent ↔ Knowledge linking ────────────────────────────────────────────

  @Post('/agent/:agentId/:kbId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai.manage_budget')
  async link(
    @Headers('authorization') auth: string,
    @Param('agentId') agentId: string,
    @Param('kbId') kbId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    // Valida ambos pertencem à org
    const [{ data: ag }, { data: kb }] = await Promise.all([
      supabaseAdmin.from('ai_agents').select('id').eq('id', agentId).eq('organization_id', orgId).maybeSingle(),
      supabaseAdmin.from('ai_knowledge_base').select('id').eq('id', kbId).eq('organization_id', orgId).maybeSingle(),
    ])
    if (!ag || !kb) throw new HttpException('Agent ou knowledge não encontrado', 404)
    const { error } = await supabaseAdmin
      .from('ai_agent_knowledge')
      .upsert(
        { agent_id: agentId, knowledge_id: kbId, organization_id: orgId },
        { onConflict: 'agent_id,knowledge_id' },
      )
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }

  @Delete('/agent/:agentId/:kbId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  async unlink(
    @Headers('authorization') auth: string,
    @Param('agentId') agentId: string,
    @Param('kbId') kbId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const { error } = await supabaseAdmin
      .from('ai_agent_knowledge')
      .delete()
      .eq('organization_id', orgId)
      .eq('agent_id', agentId)
      .eq('knowledge_id', kbId)
    if (error) throw new HttpException(error.message, 400)
    return { ok: true }
  }
}
