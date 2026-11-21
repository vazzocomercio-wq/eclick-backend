import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { CredentialsService } from '../../credentials/credentials.service'
import { AlertSignalsService } from '../alert-signals.service'
import { AlertEngineService } from '../alert-engine.service'
import type { SignalDraft } from '../analyzers/analyzers.types'

/**
 * Vigia da saúde da IA (analyzer 'ia_saude').
 *
 * Por que existe: de 03/10 a 21/11/2026 a IA do e-Click ficou fora do ar sem
 * ninguém saber — Anthropic devolvendo 400 e depois 401 (chave), e o fallback
 * OpenAI também 401 desde 24/10. Toda chamada já grava em ai_usage_log; faltava
 * alguém olhar.
 *
 * A cada 15 min lê os últimos 30 min de ai_usage_log, agrupa por org e:
 *   - taxa de erro ≥ 80% com ≥ 5 chamadas → sinal CRITICAL 'ia_fora_do_ar'
 *     (crítico fura o horário de silêncio do Hub). 1 sinal a cada 6 h por org.
 *   - depois de um 'ia_fora_do_ar' nas últimas 48 h, taxa < 20% com ≥ 3
 *     chamadas → sinal INFO 'ia_normalizada' (uma vez).
 *
 * Multi-tenant: org com chave própria do provedor recebe o alerta dela. Org que
 * usa a chave da plataforma não tem o que fazer — o problema é da plataforma,
 * então o alerta vai pra org matriz (dona das chaves), com a lista de afetadas.
 */
@Injectable()
export class IaSaudeWatchService {
  private readonly logger = new Logger(IaSaudeWatchService.name)

  static readonly JANELA_MIN          = 30
  static readonly MIN_CHAMADAS        = 5
  static readonly TAXA_FORA           = 0.8
  static readonly TAXA_OK             = 0.2
  static readonly DEDUP_FORA_MIN      = 6 * 60
  static readonly JANELA_VOLTA_MIN    = 48 * 60

  constructor(
    private readonly signals: AlertSignalsService,
    private readonly engine:  AlertEngineService,
  ) {}

  @Cron('*/15 * * * *', { name: 'iaSaudeWatchTick' })
  async tick(): Promise<void> {
    try {
      await this.run()
    } catch (e) {
      this.logger.warn(`[ia-saude] tick falhou: ${(e as Error).message}`)
    }
  }

  /** Exposto pra teste manual. Retorna o que avaliou por org. */
  async run(): Promise<Array<{ orgId: string; total: number; erros: number; acao: string }>> {
    const since = new Date(Date.now() - IaSaudeWatchService.JANELA_MIN * 60_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ai_usage_log')
      .select('organization_id, provider, model, feature, error_message, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as UsageRow[]
    if (rows.length === 0) return []

    // Quem paga a conta de cada linha: org com chave própria → ela; senão → matriz.
    const donos = await this.resolverDonos(rows)
    const porDono = new Map<string, UsageRow[]>()
    for (const r of rows) {
      const dono = donos.get(`${r.organization_id}|${r.provider}`) ?? r.organization_id
      if (!dono) continue
      if (!porDono.has(dono)) porDono.set(dono, [])
      porDono.get(dono)!.push(r)
    }

    const out: Array<{ orgId: string; total: number; erros: number; acao: string }> = []
    for (const [orgId, lista] of porDono) {
      const acao = await this.avaliarOrg(orgId, lista)
      out.push({ orgId, total: lista.length, erros: lista.filter(r => r.error_message).length, acao })
    }
    return out
  }

  // ── Avaliação ──────────────────────────────────────────────────────────

  private async avaliarOrg(orgId: string, rows: UsageRow[]): Promise<string> {
    const total = rows.length
    const erros = rows.filter(r => r.error_message)
    const taxa  = total ? erros.length / total : 0

    if (total >= IaSaudeWatchService.MIN_CHAMADAS && taxa >= IaSaudeWatchService.TAXA_FORA) {
      if (await this.temSinalRecente(orgId, 'ia_fora_do_ar', IaSaudeWatchService.DEDUP_FORA_MIN)) return 'fora (já avisado)'
      const draft = await this.draftFora(orgId, rows, erros)
      await this.emitir(orgId, draft)
      return 'fora (alerta emitido)'
    }

    if (total >= 3 && taxa < IaSaudeWatchService.TAXA_OK) {
      const ultimoFora = await this.ultimoSinal(orgId, 'ia_fora_do_ar', IaSaudeWatchService.JANELA_VOLTA_MIN)
      if (!ultimoFora) return 'ok'
      const voltaDepois = await this.ultimoSinal(orgId, 'ia_normalizada', IaSaudeWatchService.JANELA_VOLTA_MIN)
      if (voltaDepois && voltaDepois.created_at > ultimoFora.created_at) return 'ok'
      await this.emitir(orgId, {
        analyzer:      'ia_saude',
        category:      'ia_normalizada',
        severity:      'info',
        score:         85,
        entity_type:   null,
        entity_id:     'ia',
        entity_name:   'IA do e-Click',
        data:          { chamadas_30min: total, erros_30min: erros.length },
        summary_pt:    `IA do e-Click voltou a funcionar: ${total - erros.length} de ${total} chamadas OK nos últimos 30 min.`,
        suggestion_pt: null,
      })
      return 'normalizada (aviso emitido)'
    }
    return 'ok'
  }

  private async draftFora(orgId: string, rows: UsageRow[], erros: UsageRow[]): Promise<SignalDraft> {
    // Status HTTP mais frequente → causa provável em linguagem de dono.
    // error_message pode trazer primário E fallback: "anthropic/x: HTTP 401 → openai/y (fallback): HTTP 401".
    const contagem = new Map<string, number>()
    const provSet  = new Set<string>()
    for (const e of erros) {
      const msg = e.error_message ?? ''
      const sts = [...msg.matchAll(/HTTP (\d{3})/g)].map(m => m[1])
      for (const st of sts.length ? sts : ['outro']) contagem.set(st, (contagem.get(st) ?? 0) + 1)
      const provs = [...msg.matchAll(/(?:^|→ )(\w+)\//g)].map(m => m[1])
      for (const p of provs.length ? provs : [e.provider]) provSet.add(p)
    }
    const [statusTop] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['outro']
    const provedores = [...provSet]
    const features   = [...new Set(erros.map(e => e.feature))].slice(0, 6)
    const orgsAfetadas = [...new Set(rows.map(r => r.organization_id))]
    const ultimoOk   = await this.ultimoSucesso(orgsAfetadas)

    const causa = causaPorStatus(statusTop)
    const desde = ultimoOk ? ` Último sucesso: ${fmtBr(ultimoOk)}.` : ' Nenhum sucesso registrado.'

    return {
      analyzer:      'ia_saude',
      category:      'ia_fora_do_ar',
      severity:      'critical',
      score:         95,
      entity_type:   null,
      entity_id:     'ia',
      entity_name:   'IA do e-Click',
      data: {
        chamadas_30min:  rows.length,
        erros_30min:     erros.length,
        status_http:     Object.fromEntries(contagem),
        provedores,
        features,
        orgs_afetadas:   orgsAfetadas,
        ultimo_sucesso:  ultimoOk,
      },
      summary_pt:    `IA do e-Click fora do ar: ${erros.length} de ${rows.length} chamadas falharam nos últimos 30 min (${provedores.join(' + ')}, HTTP ${statusTop}).${desde}`,
      suggestion_pt: causa,
      expires_at:    new Date(Date.now() + 24 * 3600_000).toISOString(),
    }
  }

  // ── Persistência / dedup ───────────────────────────────────────────────

  private async emitir(orgId: string, draft: SignalDraft): Promise<void> {
    const inserted = await this.signals.insertMany(orgId, [draft])
    if (inserted.length) await this.engine.processMany(orgId, inserted)
    this.logger.warn(`[ia-saude] org=${orgId} ${draft.category}: ${draft.summary_pt}`)
  }

  private async temSinalRecente(orgId: string, category: string, minutos: number): Promise<boolean> {
    return !!(await this.ultimoSinal(orgId, category, minutos))
  }

  private async ultimoSinal(orgId: string, category: string, minutos: number): Promise<{ created_at: string } | null> {
    const since = new Date(Date.now() - minutos * 60_000).toISOString()
    const { data } = await supabaseAdmin
      .from('alert_signals')
      .select('created_at')
      .eq('organization_id', orgId)
      .eq('analyzer', 'ia_saude')
      .eq('category', category)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
    return (data?.[0] as { created_at: string } | undefined) ?? null
  }

  private async ultimoSucesso(orgIds: string[]): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('ai_usage_log')
      .select('created_at')
      .in('organization_id', orgIds)
      .is('error_message', null)
      .order('created_at', { ascending: false })
      .limit(1)
    return (data?.[0] as { created_at: string } | undefined)?.created_at ?? null
  }

  /** (org|provider) → org que deve receber o alerta. */
  private async resolverDonos(rows: UsageRow[]): Promise<Map<string, string>> {
    const pares = [...new Set(rows.map(r => `${r.organization_id}|${r.provider}`))]
    const orgIds = [...new Set(rows.map(r => r.organization_id).filter(Boolean))]
    const { data } = await supabaseAdmin
      .from('api_credentials')
      .select('organization_id, provider')
      .in('organization_id', orgIds)
      .eq('is_active', true)
    const proprias = new Set((data ?? []).map((c: { organization_id: string; provider: string }) => `${c.organization_id}|${c.provider}`))
    const out = new Map<string, string>()
    for (const p of pares) {
      const [org] = p.split('|')
      out.set(p, proprias.has(p) ? org : CredentialsService.PLATFORM_ORG_ID)
    }
    return out
  }
}

interface UsageRow {
  organization_id: string
  provider:        string
  model:           string
  feature:         string
  error_message:   string | null
  created_at:      string
}

/** Causa provável + o que fazer, por status HTTP do provedor. */
export function causaPorStatus(status: string): string {
  switch (status) {
    case '401':
    case '403': return 'Chave de API inválida ou revogada. Gere uma chave nova no console do provedor e troque em Configurações > IA.'
    case '400':
    case '402': return 'Provável falta de crédito ou problema de cobrança na conta do provedor. Confira o saldo no console.'
    case '429': return 'Limite de uso do provedor atingido. Confira o limite da conta ou reduza o volume de chamadas.'
    case '500':
    case '502':
    case '503':
    case '529': return 'Instabilidade no provedor. Costuma voltar sozinha; se passar de 1 h, confira a página de status.'
    default:    return 'Erro fora do padrão. Confira os logs do backend (LlmService) e o ai_usage_log.'
  }
}

function fmtBr(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
