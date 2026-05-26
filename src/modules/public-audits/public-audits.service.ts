import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { PublicAuditProcessorService } from './public-audit-processor.service'

/**
 * AI Visibility OS — Landing pública "Auditoria GEO Grátis" (Sprint 1).
 *
 * Fluxo do submit:
 *   1. valida input (nome completo + email + whatsapp obrigatórios; LGPD)
 *   2. honeypot (campo invisível preenchido = bot → descarta silenciosamente)
 *   3. rate limit por IP-hash (3 por 24h)
 *   4. grava em public_audits (status 'running')
 *   5. push best-effort pro Active (funil "Captação GEO": contato + deal + tags)
 *   6. devolve { audit_id, polling_url } pro front pollar (worker é Sprint 2)
 *
 * A análise GEO em si (scrape + score + simulação + emails) é Sprint 2.
 * Aqui status fica 'running' e o lead já nasce no funil do Active.
 */

const RATE_LIMIT_MAX   = 3                       // auditorias por IP
const RATE_WINDOW_MS    = 24 * 60 * 60 * 1000     // janela 24h
const GEO_FUNNEL_NAME   = 'Captação GEO'
const GEO_FUNNEL_STAGES = ['Auditoria realizada', 'Nutrição', 'Demo agendada', 'Cliente']

/** Org dona dos leads públicos (plataforma). Configurável; default = Vazzo. */
function platformOrgId(): string {
  return process.env.PUBLIC_AUDIT_ORG_ID ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'
}

export interface StartAuditInput {
  name:      string
  email:     string
  whatsapp:  string
  url:       string
  category?: string
  lgpd:      boolean
  honeypot?: string                 // campo invisível anti-bot (deve vir vazio)
  utm?:      Record<string, string>
}

export interface StartAuditResult {
  audit_id:    string
  polling_url: string
  status:      'running'
}

export interface PublicAuditStatus {
  id:         string
  status:     'running' | 'done' | 'failed'
  geo_score:  number | null
  platform:   string | null
  result:     unknown | null
  created_at: string
}

@Injectable()
export class PublicAuditsService {
  private readonly logger = new Logger(PublicAuditsService.name)

  constructor(
    private readonly bridge: ActiveBridgeClient,
    private readonly processor: PublicAuditProcessorService,
  ) {}

  async start(input: StartAuditInput, ip: string, userAgent?: string): Promise<StartAuditResult> {
    // 2. Honeypot — bot preencheu campo invisível. Descarta sem persistir nem
    //    queimar rate limit, devolvendo shape de sucesso pra não dar pista.
    if (input.honeypot && input.honeypot.trim().length > 0) {
      this.logger.warn('[public-audit] honeypot acionado — descartado')
      const fake = createHash('sha256').update(`${ip}:${Date.now()}`).digest('hex').slice(0, 32)
      const id = `${fake.slice(0, 8)}-${fake.slice(8, 12)}-4${fake.slice(13, 16)}-8${fake.slice(17, 20)}-${fake.slice(20, 32)}`
      return { audit_id: id, polling_url: `/public/audits/${id}`, status: 'running' }
    }

    // 1. Validação (mensagens em PT-BR, leigo-friendly)
    const name = (input.name ?? '').trim()
    if (name.length < 3 || !name.includes(' ')) {
      throw new BadRequestException('Informe seu nome completo (nome e sobrenome).')
    }
    const email = (input.email ?? '').trim().toLowerCase()
    if (!isValidEmail(email)) {
      throw new BadRequestException('Email inválido. Confira e tente de novo.')
    }
    const whatsapp = normalizePhoneBr(input.whatsapp ?? '')
    if (!whatsapp) {
      throw new BadRequestException('WhatsApp inválido. Use DDD + número (ex.: 11 91234-5678).')
    }
    const url = (input.url ?? '').trim()
    if (!isValidHttpUrl(url)) {
      throw new BadRequestException('Cole um link válido do seu anúncio ou loja (começando com http).')
    }
    if (input.lgpd !== true) {
      throw new BadRequestException('É necessário aceitar a política de privacidade (LGPD).')
    }
    const category = (input.category ?? '').trim().slice(0, 60) || null

    // 3. Rate limit por IP
    const ipHash = hashIp(ip)
    await this.enforceRateLimit(ipHash)

    // Detecção de plataforma + normalização da URL
    const platform = detectPlatform(url)
    const urlNorm  = normalizeUrl(url)

    // 4. Persiste a auditoria (status 'running')
    const { data: row, error } = await supabaseAdmin
      .from('public_audits')
      .insert({
        name,
        email,
        whatsapp,
        category,
        ip_hash:           ipHash,
        user_agent:        userAgent ? userAgent.slice(0, 500) : null,
        utm:               input.utm && Object.keys(input.utm).length > 0 ? input.utm : null,
        url:               url.slice(0, 1000),
        url_normalized:    urlNorm.slice(0, 1000),
        detected_platform: platform,
        status:            'running',
      })
      .select('id')
      .maybeSingle()
    if (error || !row) {
      this.logger.error(`[public-audit] insert falhou: ${error?.message ?? '?'}`)
      throw new BadRequestException('Não foi possível iniciar a auditoria. Tente novamente.')
    }
    const auditId = (row as { id: string }).id

    // 5. Dispara a análise na hora (worker; o @Cron é só rede de segurança)
    this.processor.kick(auditId)

    // 6. Push best-effort pro Active (nunca bloqueia o submit)
    void this.pushToActive(auditId, { name, email, whatsapp, url, category, platform })

    return { audit_id: auditId, polling_url: `/public/audits/${auditId}`, status: 'running' }
  }

  /** Status público sanitizado (sem PII). O worker (Sprint 2) preenche o resultado. */
  async getStatus(id: string): Promise<PublicAuditStatus> {
    if (!isUuid(id)) throw new BadRequestException('Id inválido.')
    const { data } = await supabaseAdmin
      .from('public_audits')
      .select('id, status, geo_score, detected_platform, result_json, created_at')
      .eq('id', id)
      .maybeSingle()
    if (!data) throw new HttpException('Auditoria não encontrada.', HttpStatus.NOT_FOUND)
    const r = data as {
      id: string; status: string; geo_score: number | null
      detected_platform: string | null; result_json: unknown | null; created_at: string
    }
    return {
      id:         r.id,
      status:     (r.status as PublicAuditStatus['status']) ?? 'running',
      geo_score:  r.geo_score ?? null,
      platform:   r.detected_platform ?? null,
      result:     r.result_json ?? null,
      created_at: r.created_at,
    }
  }

  /** Descadastro (LGPD): opta-out por email (todas as auditorias daquele email). */
  async unsubscribe(auditId: string): Promise<{ ok: true; optedOut: boolean }> {
    if (!isUuid(auditId)) throw new BadRequestException('Id inválido.')
    const { data } = await supabaseAdmin
      .from('public_audits')
      .select('email')
      .eq('id', auditId)
      .maybeSingle()
    const email = (data as { email: string } | null)?.email
    if (!email) return { ok: true, optedOut: false } // id desconhecido: não vaza existência
    await supabaseAdmin
      .from('public_audits')
      .update({ opted_out: true, opted_out_at: new Date().toISOString() })
      .eq('email', email)
    this.logger.log(`[public-audit] descadastro email=${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`)
    return { ok: true, optedOut: true }
  }

  /** Lead pede demo no resultado → dispara o agendador (Concierge) do Active:
   *  propõe 3 horários no WhatsApp; quando o lead responde, agenda sozinho. */
  async requestDemo(auditId: string): Promise<{ ok: true; proposed: boolean; reason?: string }> {
    if (!isUuid(auditId)) throw new BadRequestException('Id inválido.')
    const { data } = await supabaseAdmin
      .from('public_audits')
      .select('name, whatsapp, opted_out')
      .eq('id', auditId)
      .maybeSingle()
    const a = data as { name: string; whatsapp: string | null; opted_out: boolean } | null
    if (!a) throw new HttpException('Auditoria não encontrada.', HttpStatus.NOT_FOUND)
    if (a.opted_out) return { ok: true, proposed: false, reason: 'opted_out' }
    if (!a.whatsapp) return { ok: true, proposed: false, reason: 'no_whatsapp' }

    const orgId = platformOrgId()
    try {
      const r = await this.bridge.requestScheduling({
        organization_id: orgId,
        phone: a.whatsapp,
        name: a.name,
        intro_message: 'Que bom que você quer conhecer o e-Click de perto! Tenho esses horários pra uma demo:',
        origin_message: `Demo solicitada via Auditoria GEO (${auditId})`,
      })
      // Best-effort: avança o card do funil pra "Demo agendada".
      void this.bridge.moveCard({
        organization_id: orgId, dedup_key: `public_audit:${auditId}`, to_stage_name: 'Demo agendada',
      }).catch(() => undefined)
      if (r.skipped_no_bridge) return { ok: true, proposed: false, reason: 'bridge_off' }
      return { ok: true, proposed: r.proposed ?? false, reason: r.reason }
    } catch (e) {
      this.logger.warn(`[public-audit] request-demo falhou audit=${auditId}: ${(e as Error).message}`)
      return { ok: true, proposed: false, reason: 'error' }
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  private async enforceRateLimit(ipHash: string): Promise<void> {
    const now = Date.now()
    const { data } = await supabaseAdmin
      .from('public_audit_rate_limits')
      .select('ip_hash, count, window_start')
      .eq('ip_hash', ipHash)
      .maybeSingle()

    const row = data as { ip_hash: string; count: number; window_start: string } | null
    if (!row) {
      await supabaseAdmin.from('public_audit_rate_limits').insert({
        ip_hash: ipHash, count: 1, window_start: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      })
      return
    }

    const windowAge = now - new Date(row.window_start).getTime()
    if (windowAge > RATE_WINDOW_MS) {
      // Janela expirou — reseta
      await supabaseAdmin.from('public_audit_rate_limits').update({
        count: 1, window_start: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      }).eq('ip_hash', ipHash)
      return
    }

    if (row.count >= RATE_LIMIT_MAX) {
      throw new HttpException(
        'Você já fez algumas auditorias hoje. Tente novamente amanhã — ou fale com a gente pra liberar mais.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    await supabaseAdmin.from('public_audit_rate_limits').update({
      count: row.count + 1, updated_at: new Date(now).toISOString(),
    }).eq('ip_hash', ipHash)
  }

  /** Cria contato + deal no funil "Captação GEO" do Active. No-op se bridge off. */
  private async pushToActive(
    auditId: string,
    lead: { name: string; email: string; whatsapp: string; url: string; category: string | null; platform: string },
  ): Promise<void> {
    try {
      const orgId = platformOrgId()
      const funnel = await this.bridge.ensureServicePipeline({
        organization_id: orgId,
        name:            GEO_FUNNEL_NAME,
        stages:          GEO_FUNNEL_STAGES,
      })
      if (funnel.skipped_no_bridge || !funnel.pipeline_id || !funnel.default_stage_id) {
        this.logger.warn('[public-audit] Active bridge off/sem funil — lead fica só no SaaS')
        return
      }

      const result = await this.bridge.createLead({
        organization_id: orgId,
        pipeline_id:     funnel.pipeline_id,
        stage_id:        funnel.default_stage_id,
        contact:         { name: lead.name, email: lead.email, phone: lead.whatsapp },
        title:           `Auditoria GEO — ${lead.name}`,
        message:         `Auditou: ${lead.url}${lead.category ? ` (categoria: ${lead.category})` : ''}`,
        tags:            ['auditoria-publica', 'geo', `plataforma-${lead.platform}`],
        custom_fields:   { audit_id: auditId, audited_url: lead.url, platform: lead.platform },
        dedup_key:       `public_audit:${auditId}`,
      })
      if (result.skipped_no_bridge) return

      await supabaseAdmin
        .from('public_audits')
        .update({
          active_contact_id:   result.contact_id ?? null,
          active_deal_id:      result.deal_id ?? null,
          active_funnel_stage: GEO_FUNNEL_STAGES[0],
        })
        .eq('id', auditId)
    } catch (e) {
      this.logger.warn(`[public-audit] push Active falhou audit=${auditId}: ${(e as Error).message}`)
    }
  }
}

// ── helpers (puros) ────────────────────────────────────────────────────

function hashIp(ip: string): string {
  return createHash('sha256').update(ip || 'unknown').digest('hex')
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160
}

function isValidHttpUrl(url: string): boolean {
  if (!url || url.length > 1000) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/** Normaliza telefone BR pra dígitos com DDI 55. Retorna '' se inválido. */
function normalizePhoneBr(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (d.length === 10 || d.length === 11) return `55${d}`            // DDD + número
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d
  return ''
}

function detectPlatform(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('mercadolivre') || u.includes('mercadolibre') || /\/mlb-?\d/i.test(u)) return 'mercadolivre'
  if (u.includes('shopee'))  return 'shopee'
  if (u.includes('amazon'))  return 'amazon'
  if (u.includes('magazineluiza') || u.includes('magalu')) return 'magalu'
  return 'generic'
}

/** Normalização leve: remove fragmento + parâmetros de tracking, sem barra final. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']
    for (const k of drop) u.searchParams.delete(k)
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s
  } catch {
    return url
  }
}
