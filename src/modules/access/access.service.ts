import {
  Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'

/**
 * F17-A · Gate de cadastro — orquestração.
 *
 * Fluxo:
 *  1. Visitante submete /solicitar-acesso → POST /access/request (público).
 *  2. Founder vê /dashboard/admin/access-requests → aprova/rejeita.
 *  3. Aprovação cria auth.user (via invite por email) + organization + member
 *     + subscription. Espelha plan.enabled_modules em organizations.enabled_modules
 *     (gating de menu já existente — middleware lê dali).
 *  4. User recebe email com link pra definir senha → entra no /dashboard.
 *
 * Fase 2 (Stripe/MP) — webhooks marcam status='paid' e disparam approve auto.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name)

  /** E-mail do platform admin (alinhado com isPlatformAdmin do frontend). */
  private readonly PLATFORM_ADMIN_EMAILS = ['vazzocomercio@gmail.com']

  constructor(private readonly wa: WhatsAppSender) {}

  /** Lança ForbiddenException se o user não for platform admin. */
  async assertPlatformAdmin(userId: string): Promise<void> {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (error || !data?.user?.email) {
      throw new ForbiddenException('Não autorizado.')
    }
    const email = data.user.email.toLowerCase()
    if (!this.PLATFORM_ADMIN_EMAILS.includes(email)) {
      throw new ForbiddenException('Apenas administradores da plataforma podem fazer essa ação.')
    }
  }

  /** Lista todos os planos ativos (público — usado pelo /solicitar-acesso). */
  async listPlans() {
    const { data, error } = await supabaseAdmin
      .from('access_plans')
      .select('id, key, name, description, target, price_brl, billing_period, enabled_modules, features, display_order')
      .eq('active', true)
      .order('display_order')
    if (error) throw new BadRequestException(`Erro ao carregar planos: ${error.message}`)
    return data ?? []
  }

  /** Recebe submissão do form público. */
  async submitRequest(input: {
    name:         string
    email:        string
    phone?:       string
    company?:     string
    message?:     string
    planKey?:     string
    ipAddress?:   string
    userAgent?:   string
    source?:      string
  }) {
    const name  = input.name?.trim() ?? ''
    const email = input.email?.trim().toLowerCase() ?? ''
    if (name.length < 2)              throw new BadRequestException('Nome muito curto.')
    if (!email || !email.includes('@')) throw new BadRequestException('E-mail inválido.')

    // Se planKey veio, valida que existe e está ativo
    let planKey: string | null = null
    if (input.planKey) {
      const { data: plan } = await supabaseAdmin
        .from('access_plans')
        .select('key, active')
        .eq('key', input.planKey)
        .maybeSingle()
      if (!plan || !plan.active) throw new BadRequestException('Plano inválido.')
      planKey = plan.key as string
    }

    // Dedupe leve: se já tem pedido pendente desse email, retorna o existente
    const { data: existing } = await supabaseAdmin
      .from('access_requests')
      .select('id, status, created_at')
      .eq('email', email)
      .in('status', ['pending', 'approved', 'paid'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing) {
      this.logger.log(`[access.submit] email=${email} já tem pedido id=${existing.id} status=${existing.status} — devolvendo`)
      return { id: existing.id, duplicated: true, status: existing.status }
    }

    const { data, error } = await supabaseAdmin
      .from('access_requests')
      .insert({
        name,
        email,
        phone:               input.phone?.trim() || null,
        company:             input.company?.trim() || null,
        message:             input.message?.trim() || null,
        requested_plan_key:  planKey,
        ip_address:          input.ipAddress || null,
        user_agent:          input.userAgent || null,
        source:              input.source || 'web',
      })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`Erro ao salvar pedido: ${error.message}`)

    this.logger.log(`[access.submit] novo pedido id=${data.id} email=${email} plan=${planKey ?? 'none'}`)

    // A9 · notifica founder via WhatsApp (best-effort, não trava o submit)
    this.notifyFounder({
      requestId: data.id as string,
      name, email,
      phone:    input.phone?.trim() || null,
      company:  input.company?.trim() || null,
      planKey,
    }).catch(e => this.logger.warn(`[access.submit] notify falhou: ${(e as Error).message}`))

    return { id: data.id, duplicated: false, status: 'pending' }
  }

  /** Dispara WhatsApp pro founder com resumo do pedido + link pro painel admin.
   *  Best-effort: erros são logados mas não propagam. Skip silencioso se
   *  FOUNDER_NOTIFICATION_PHONE (ou fallback TELEMETRY_ALERT_PHONE) não setado. */
  private async notifyFounder(p: {
    requestId: string
    name:      string
    email:     string
    phone:     string | null
    company:   string | null
    planKey:   string | null
  }): Promise<void> {
    const phone = process.env.FOUNDER_NOTIFICATION_PHONE
      ?? process.env.TELEMETRY_ALERT_PHONE
      ?? ''
    if (!phone) {
      this.logger.log('[access.notify] FOUNDER_NOTIFICATION_PHONE/TELEMETRY_ALERT_PHONE não setado — skip')
      return
    }

    const planLabel = p.planKey ? `plano *${p.planKey}*` : 'sem plano'
    const lines = [
      `🚪 *Novo pedido de acesso* — e-Click`,
      ``,
      `*${p.name}*${p.company ? ` (${p.company})` : ''}`,
      `📧 ${p.email}`,
      p.phone ? `📱 ${p.phone}` : null,
      `💼 ${planLabel}`,
      ``,
      `🔗 https://eclick.app.br/dashboard/admin/access-requests`,
    ].filter(Boolean) as string[]

    const r = await this.wa.sendTextMessage({ phone, message: lines.join('\n') })
    if (r.success) {
      this.logger.log(`[access.notify] whatsapp ok requestId=${p.requestId} -> ${phone}`)
    } else {
      this.logger.warn(`[access.notify] whatsapp falhou requestId=${p.requestId}: ${r.error ?? '?'}`)
    }
  }

  /** Lista pedidos pra painel admin. */
  async listRequests(filters: { status?: string; limit?: number }) {
    const q = supabaseAdmin
      .from('access_requests')
      .select('id, name, email, phone, company, message, requested_plan_key, status, payment_provider, paid_at, reviewed_at, rejection_reason, provisioned_user_id, provisioned_org_id, created_at')
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 100)
    if (filters.status) q.eq('status', filters.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Aprova um pedido: cria auth.user (via convite), organization, member
   *  e subscription. Idempotente: se já provisionado, retorna o existente. */
  async approve(requestId: string, reviewerId: string): Promise<{
    ok: true
    userId: string
    orgId: string
    email: string
    planKey: string
  }> {
    const { data: req, error: reqErr } = await supabaseAdmin
      .from('access_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()
    if (reqErr || !req) throw new NotFoundException('Pedido não encontrado.')

    // Idempotência
    if (req.status === 'provisioned' && req.provisioned_user_id && req.provisioned_org_id) {
      return {
        ok: true,
        userId:  req.provisioned_user_id as string,
        orgId:   req.provisioned_org_id  as string,
        email:   req.email as string,
        planKey: (req.requested_plan_key as string) ?? '',
      }
    }
    if (!['pending', 'approved', 'paid'].includes(req.status as string)) {
      throw new BadRequestException(`Status inválido pra aprovar: ${req.status}`)
    }

    if (!req.requested_plan_key) {
      throw new BadRequestException('Pedido sem plano definido — peça pro contato selecionar um plano.')
    }

    // Plano
    const { data: plan, error: planErr } = await supabaseAdmin
      .from('access_plans')
      .select('id, key, enabled_modules')
      .eq('key', req.requested_plan_key)
      .maybeSingle()
    if (planErr || !plan) throw new NotFoundException('Plano não encontrado.')

    // 1. auth.user via convite (email é enviado pelo Supabase com link pra definir senha)
    const email = (req.email as string).toLowerCase()
    let userId: string

    // Tenta achar user já existente
    const existing = await this.findUserByEmail(email)
    if (existing) {
      userId = existing.id
      this.logger.log(`[access.approve] user já existe pra ${email}: ${userId}`)
    } else {
      const { data: invited, error: invErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: req.name, company: req.company ?? null },
        redirectTo: 'https://eclick.app.br/auth/callback?next=/dashboard',
      })
      if (invErr || !invited?.user) {
        throw new BadRequestException(`Erro ao convidar usuário: ${invErr?.message ?? 'desconhecido'}`)
      }
      userId = invited.user.id
      this.logger.log(`[access.approve] convite enviado pra ${email}, user=${userId}`)
    }

    // 2. organization (com enabled_modules do plano já setado)
    const baseSlug = this.slugify((req.company as string | null) || (req.name as string))
    let orgId: string | null = null
    for (const candidate of [baseSlug, `${baseSlug}-${Math.random().toString(36).slice(2, 5)}`]) {
      const { data, error } = await supabaseAdmin
        .from('organizations')
        .insert({
          name:            (req.company as string | null) ?? (req.name as string),
          slug:            candidate,
          enabled_modules: plan.enabled_modules,
        })
        .select('id')
        .maybeSingle()
      if (!error && data) { orgId = data.id as string; break }
      if (error?.code !== '23505') {
        throw new BadRequestException(`Erro ao criar organização: ${error?.message ?? '?'}`)
      }
    }
    if (!orgId) throw new BadRequestException('Não consegui gerar slug único — tente novamente.')

    // 3. member (role owner). Idempotente caso retry
    const { error: memErr } = await supabaseAdmin
      .from('organization_members')
      .insert({ organization_id: orgId, user_id: userId, role: 'owner' })
    if (memErr && memErr.code !== '23505') {
      // Rollback da org pra não deixar lixo
      await supabaseAdmin.from('organizations').delete().eq('id', orgId)
      throw new BadRequestException(`Erro ao vincular owner: ${memErr.message}`)
    }

    // 4. subscription (1 ativa por org via unique index)
    const { error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        organization_id:     orgId,
        plan_id:             plan.id,
        status:              'active',
        source:              'manual',
        access_request_id:   requestId,
        current_period_start: new Date().toISOString(),
      })
    if (subErr && subErr.code !== '23505') {
      this.logger.warn(`[access.approve] subscription falhou (não crítico): ${subErr.message}`)
    }

    // 5. Marca request como provisionado
    await supabaseAdmin
      .from('access_requests')
      .update({
        status:               'provisioned',
        reviewed_by:          reviewerId,
        reviewed_at:          new Date().toISOString(),
        provisioned_user_id:  userId,
        provisioned_org_id:   orgId,
        provisioned_at:       new Date().toISOString(),
      })
      .eq('id', requestId)

    this.logger.log(`[access.approve] ok id=${requestId} user=${userId} org=${orgId} plan=${plan.key}`)
    return { ok: true, userId, orgId, email, planKey: plan.key as string }
  }

  /** Rejeita um pedido sem provisionar. */
  async reject(requestId: string, reviewerId: string, reason?: string): Promise<{ ok: true }> {
    const { data: req } = await supabaseAdmin
      .from('access_requests')
      .select('status')
      .eq('id', requestId)
      .maybeSingle()
    if (!req) throw new NotFoundException('Pedido não encontrado.')
    if (req.status === 'provisioned') {
      throw new BadRequestException('Pedido já provisionado — use cancelar/suspender em vez de rejeitar.')
    }

    const { error } = await supabaseAdmin
      .from('access_requests')
      .update({
        status:           'rejected',
        reviewed_by:      reviewerId,
        reviewed_at:      new Date().toISOString(),
        rejection_reason: reason?.trim() || null,
      })
      .eq('id', requestId)
    if (error) throw new BadRequestException(`Erro ao rejeitar: ${error.message}`)
    return { ok: true }
  }

  /** Helper: encontra user.id por email via admin API (pagina lista). */
  private async findUserByEmail(email: string): Promise<{ id: string } | null> {
    const target = email.toLowerCase()
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw new BadRequestException(`Erro ao listar usuários: ${error.message}`)
      const users = (data?.users ?? []) as Array<{ id: string; email?: string }>
      const u = users.find(x => (x.email ?? '').toLowerCase() === target)
      if (u) return { id: u.id }
      if (users.length < 200) break
    }
    return null
  }

  /** Slug ASCII a partir de nome/empresa. */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  }
}
