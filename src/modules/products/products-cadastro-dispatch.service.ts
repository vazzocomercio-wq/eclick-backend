import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { ActiveResolverService } from '../active-bridge/active-resolver.service'
import { ProductsCompletenessService } from './products-completeness.service'

/**
 * F4 (sessão 2026-05-14) — Despacho de tarefas de cadastro pro operador (Active CRM)
 * + cron diário que (a) gera alert_signal pro lojista e (b) reconcilia tags.
 *
 * Fluxo:
 *   1. Gestor seleciona N produtos em /produtos/operacao-cadastro
 *   2. POST /products/dispatch-to-operator { product_ids[], operator_user_id, pipeline_id, stage_id, due_date }
 *   3. Pra cada product_id:
 *      - Avalia completeness (gera lista de missing_fields)
 *      - Chama activeBridge.createCampaignCard() com dedup_key = product_cadastro:<product_id>
 *      - Salva linha em product_operator_assignments
 *   4. Cron diário 8h:
 *      - Re-avalia completeness de todos produtos com tag cadastro_pendente
 *      - Remove tag dos completos automaticamente
 *      - Se ainda houver pendentes → emite alert_signal categoria 'catalog_incomplete'
 */

export interface DispatchInput {
  product_ids:        string[]
  operator_user_id:   string         // uuid do user Active
  pipeline_id:        string         // uuid do funil Active
  stage_id:           string         // uuid do estágio inicial
  due_date?:          string         // ISO 8601
  task_priority?:     'low' | 'normal' | 'high' | 'urgent'
  notes?:             string
}

export interface DispatchResult {
  ok:               true
  dispatched:       number
  skipped_existing: number          // produto já tinha assignment OPEN
  errors:           Array<{ product_id: string; message: string }>
  assignments:      Array<{ product_id: string; assignment_id: string; deal_id?: string; task_id?: string }>
}

@Injectable()
export class ProductsCadastroDispatchService {
  private readonly log = new Logger(ProductsCadastroDispatchService.name)

  constructor(
    private readonly bridge:        ActiveBridgeClient,
    private readonly activeResolver: ActiveResolverService,
    private readonly completeness:  ProductsCompletenessService,
  ) {}

  /** Despacha N produtos pro operador. Idempotente via dedup_key. */
  async dispatch(orgId: string, dispatcherUserId: string | null, input: DispatchInput): Promise<DispatchResult> {
    if (!Array.isArray(input.product_ids) || input.product_ids.length === 0) {
      throw new BadRequestException('product_ids[] obrigatório')
    }
    if (!input.operator_user_id) throw new BadRequestException('operator_user_id obrigatório')
    if (!input.pipeline_id || !input.stage_id) {
      throw new BadRequestException('pipeline_id + stage_id obrigatórios (config Active)')
    }
    if (input.product_ids.length > 100) {
      throw new BadRequestException('Máximo 100 produtos por dispatch.')
    }

    // Prazo da tarefa de criação do card: 1 dia (regra do funil "Anúncios ML"
    // — cada etapa gera tarefa pro operador; a de criação tem 24h, as demais
    // 3h via automação de stage). Respeita o prazo que o gestor escolheu.
    const dueDate = input.due_date
      ?? new Date(Date.now() + 24 * 3600_000).toISOString()

    // SaaS e Active são produtos distintos com orgs separadas. Pipeline +
    // Stage IDs vêm do Active e pertencem à org Active do dispatcher.
    // Bridge precisa receber o org_id Active (não o SaaS) pra que a validação
    // assertStageInOrg() lá no Active passe.
    let activeOrgId: string
    try {
      if (!dispatcherUserId) throw new BadRequestException('dispatcherUserId ausente — não dá pra resolver org Active')
      const resolved = await this.activeResolver.resolveActiveOrgForUser(dispatcherUserId)
      activeOrgId = resolved.org_id
    } catch (e) {
      throw new BadRequestException(`Não foi possível resolver org no Active CRM: ${(e as Error).message}`)
    }

    // Resolve o stage de "em andamento" do pipeline — pra onde o card vai
    // quando o operador confirma que abriu o IA Criativo. Heurística: stage
    // não-terminal cujo nome casa /andamento|progress/i; fallback = primeiro
    // stage não-terminal depois do stage inicial. Best-effort: se falhar, o
    // card ainda é criado, só sem o atalho de auto-move.
    let inProgressStageId: string | null = null
    try {
      const stages = await this.activeResolver.listStages(dispatcherUserId, input.pipeline_id)
      const nonTerminal = stages
        .filter(s => !s.is_won && !s.is_lost)
        .sort((a, b) => a.position - b.position)
      const byName = nonTerminal.find(s => /andamento|progress/i.test(s.name))
      if (byName) {
        inProgressStageId = byName.id
      } else {
        const initialPos = nonTerminal.find(s => s.id === input.stage_id)?.position ?? -1
        inProgressStageId = (nonTerminal.find(s => s.position > initialPos) ?? nonTerminal[0])?.id ?? null
      }
    } catch (e) {
      this.log.warn(`[cadastro-dispatch] não resolvi in_progress stage: ${(e as Error).message}`)
    }

    // Fetch produtos + checa que pertencem ao org
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('id, sku, name, brand, cost_price, my_price, price, weight_kg, width_cm, length_cm, height_cm, photo_urls, description, category_ml_id, gtin, attributes, ml_title')
      .eq('organization_id', orgId)
      .in('id', input.product_ids)
    if (error) throw new BadRequestException(error.message)

    const fetchedIds = new Set((products ?? []).map(p => p.id as string))
    const missing = input.product_ids.filter(id => !fetchedIds.has(id))

    const dispatched: DispatchResult['assignments'] = []
    const errors: DispatchResult['errors'] = []
    let skippedExisting = 0

    for (const m of missing) {
      errors.push({ product_id: m, message: 'Produto não encontrado nesse org' })
    }

    for (const p of (products ?? [])) {
      try {
        // Já existe assignment OPEN?
        const { data: existing } = await supabaseAdmin
          .from('product_operator_assignments')
          .select('id, active_deal_id, active_task_id')
          .eq('organization_id', orgId)
          .eq('product_id', p.id as string)
          .in('status', ['open', 'in_progress'])
          .maybeSingle()
        if (existing) {
          // Verifica se o deal ainda está ATIVO no Active. Um deal só conta
          // como "card aberto" se:
          //   - ainda existe na tabela (user pode ter deletado), E
          //   - não está em stage terminal — won_at/lost_at nulos. Card movido
          //     pra "Ganho"/"Perdido" saiu do fluxo de trabalho, então não
          //     deve bloquear um novo dispatch.
          // Quando o deal não conta mais, cancela o assignment órfão e segue
          // pra criar um card novo.
          const dealId = (existing as { active_deal_id: string | null }).active_deal_id
          let dealStillOpen = false
          let staleReason = 'deal sumiu do Active'
          if (dealId) {
            const { data: deal } = await supabaseAdmin
              .schema('active')
              .from('deals')
              .select('id, won_at, lost_at')
              .eq('id', dealId)
              .maybeSingle()
            const d = deal as { won_at: string | null; lost_at: string | null } | null
            if (d) {
              dealStillOpen = !d.won_at && !d.lost_at
              if (!dealStillOpen) staleReason = d.won_at ? 'deal movido pra Ganho' : 'deal movido pra Perdido'
            }
          }
          if (dealStillOpen) {
            skippedExisting++
            continue
          }
          // Deal não conta mais (sumiu OU em stage terminal) — cancela o
          // assignment órfão e prossegue criando card novo.
          await supabaseAdmin
            .from('product_operator_assignments')
            .update({
              status:      'cancelled',
              updated_at:  new Date().toISOString(),
            })
            .eq('id', (existing as { id: string }).id)
          this.log.log(`[cadastro-dispatch] assignment órfão cancelado pra produto=${p.id} (${staleReason}: ${dealId})`)
        }

        // Avalia missing fields
        const completeness = await this.completeness.evaluate(p as any)
        const missingFields: Array<{ label: string; type: 'universal' | 'ml_attr'; id?: string }> = [
          ...completeness.missing_universal.map(label => ({ label, type: 'universal' as const })),
          ...completeness.missing_ml_attrs.map(a => ({ label: a.name, type: 'ml_attr' as const, id: a.id })),
        ]

        const taskBody = missingFields.length > 0
          ? `Preencher: ${missingFields.map(m => m.label).join(' • ')}`
          : 'Revisar cadastro completo'

        const dedupKey = `product_cadastro:${p.id}`
        const baseUrl = process.env.FRONTEND_PUBLIC_URL ?? 'https://eclick.app.br'
        // Deeplink abre o fluxo de Novo Anúncio do IA Criativo já amarrado ao
        // produto do catálogo: a tela resolve se já existe anúncio (redireciona)
        // ou abre o Step 1 pré-preenchido (nome/categoria/marca/foto). `p.id` é
        // o products.id do catálogo — NÃO o creative_products.id.
        const deeplink = `${baseUrl}/dashboard/creative/new?catalogProductId=${p.id}&source=cadastro`

        const bridgeRes = await this.bridge.createCampaignCard({
          organization_id: activeOrgId,
          pipeline_id:     input.pipeline_id,
          stage_id:        input.stage_id,
          assigned_to:     input.operator_user_id,
          title:           `Completar cadastro: ${(p as any).name} ${(p as any).sku ? `(${(p as any).sku})` : ''}`.trim(),
          task_title:      taskBody.slice(0, 200),
          due_date:        dueDate,
          tags:            ['cadastro_pendente', ...missingFields.slice(0, 5).map(m => toMlTagSlug(m.label))],
          metadata: {
            source:          'saas_cadastro',
            // Marcador estável usado pelo Active pra detectar card de cadastro
            // (o `source` é sobrescrito pra 'saas:ml-campaigns' no bridge).
            card_kind:       'product_cadastro',
            product_id:      p.id,
            sku:             (p as any).sku,
            missing_fields:  missingFields,
            deeplink,
            // Stage pra onde o card vai quando o operador confirma abrir o
            // IA Criativo. null = pipeline sem stage de andamento detectável.
            in_progress_stage_id: inProgressStageId,
            priority:        input.task_priority ?? 'normal',
            notes:           input.notes ?? null,
          },
          dedup_key:       dedupKey,
        })

        // Persiste assignment local (audit)
        const { data: assignment, error: assignErr } = await supabaseAdmin
          .from('product_operator_assignments')
          .insert({
            organization_id:         orgId,
            product_id:              p.id,
            dispatched_by:           dispatcherUserId,
            operator_user_id:        input.operator_user_id,
            active_pipeline_id:      input.pipeline_id,
            active_stage_id:         input.stage_id,
            active_deal_id:          bridgeRes.deal_id ?? null,
            active_task_id:          bridgeRes.task_id ?? null,
            due_date:                dueDate,
            missing_fields_snapshot: missingFields,
            status:                  'open',
            dedup_key:               dedupKey,
          })
          .select('id')
          .single()
        if (assignErr || !assignment) {
          // Race / duplicate key — pode acontecer se dois requests simultâneos.
          // Não é erro fatal; conta como skipped.
          this.log.warn(`[cadastro-dispatch] insert assignment falhou (race?): ${assignErr?.message}`)
          skippedExisting++
          continue
        }

        dispatched.push({
          product_id:    p.id as string,
          assignment_id: assignment.id as string,
          deal_id:       bridgeRes.deal_id ?? undefined,
          task_id:       bridgeRes.task_id ?? undefined,
        })
      } catch (e) {
        this.log.error(`[cadastro-dispatch] product=${p.id} falhou: ${(e as Error).message}`)
        errors.push({ product_id: p.id as string, message: (e as Error).message.slice(0, 200) })
      }
    }

    return {
      ok:               true,
      dispatched:       dispatched.length,
      skipped_existing: skippedExisting,
      errors,
      assignments:      dispatched,
    }
  }

  /** Lista assignments do org (filtros opcionais). Usado pela tela do gestor. */
  async list(orgId: string, opts: { status?: string; operator?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    let q = supabaseAdmin
      .from('product_operator_assignments')
      .select('id, product_id, operator_user_id, active_deal_id, active_task_id, due_date, status, missing_fields_snapshot, created_at, completed_at, products:product_id(id, name, sku, photo_urls)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (opts.status)   q = q.eq('status', opts.status)
    if (opts.operator) q = q.eq('operator_user_id', opts.operator)
    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  /** Callback do Active quando task fica completed (POST /products/cadastro-callback). */
  async markCompletedByTaskId(activeTaskId: string): Promise<{ updated: boolean; product_id?: string }> {
    const { data: assignment } = await supabaseAdmin
      .from('product_operator_assignments')
      .select('id, product_id, status')
      .eq('active_task_id', activeTaskId)
      .maybeSingle()
    if (!assignment) return { updated: false }

    await supabaseAdmin
      .from('product_operator_assignments')
      .update({
        status:       'completed',
        completed_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      })
      .eq('id', assignment.id as string)

    // Re-avalia produto pra ver se ficou completo
    try {
      await this.completeness.refreshAndCleanupTag(assignment.product_id as string)
    } catch (e) {
      this.log.warn(`[cadastro-dispatch] refresh tag falhou: ${(e as Error).message}`)
    }

    return { updated: true, product_id: assignment.product_id as string }
  }

  /**
   * Callback do Active quando o estado de um deal de cadastro muda
   * (POST /products/cadastro-deal-callback).
   *
   * Cobre o gap do callback por task: mover o deal no kanban não completa as
   * tasks vinculadas (e "Perdido" não tem cascata nenhuma), então o assignment
   * ficava preso em 'open'. Mapeamento estado do deal → status do assignment:
   *
   * - 'won'         → 'completed' (+ refresh da tag do produto)
   * - 'lost'        → 'cancelled'
   * - 'in_progress' → 'in_progress' (operador começou a trabalhar — só
   *                    promove a partir de 'open', nunca rebaixa terminal)
   *
   * Idempotente: só atua em assignments ainda open/in_progress.
   */
  async syncAssignmentByDealState(
    activeDealId: string,
    state: 'won' | 'lost' | 'in_progress',
  ): Promise<{ updated: boolean; product_id?: string }> {
    const { data: assignment } = await supabaseAdmin
      .from('product_operator_assignments')
      .select('id, product_id, status')
      .eq('active_deal_id', activeDealId)
      .in('status', ['open', 'in_progress'])
      .maybeSingle()
    if (!assignment) return { updated: false }

    // in_progress só promove a partir de 'open' — não re-escreve um assignment
    // que já está in_progress (evita update redundante a cada movimentação).
    if (state === 'in_progress' && assignment.status !== 'open') {
      return { updated: false, product_id: assignment.product_id as string }
    }

    const nextStatus = state === 'won' ? 'completed'
                     : state === 'lost' ? 'cancelled'
                     : 'in_progress'
    const now = new Date().toISOString()
    await supabaseAdmin
      .from('product_operator_assignments')
      .update({
        status:       nextStatus,
        completed_at: state === 'won' ? now : null,
        updated_at:   now,
      })
      .eq('id', assignment.id as string)

    this.log.log(`[cadastro-dispatch] deal ${activeDealId} → ${state}; assignment ${assignment.id} marcado ${nextStatus}`)

    // Won: re-avalia produto pra ver se ficou completo (remove tag se sim)
    if (state === 'won') {
      try {
        await this.completeness.refreshAndCleanupTag(assignment.product_id as string)
      } catch (e) {
        this.log.warn(`[cadastro-dispatch] refresh tag falhou: ${(e as Error).message}`)
      }
    }

    return { updated: true, product_id: assignment.product_id as string }
  }

  // ── Cron diário 8h ─────────────────────────────────────────────────────────

  /**
   * Roda diariamente 8h BRT (cron em UTC = 11h). Pra cada org com produtos
   * pendentes:
   *   1. Re-avalia completeness em batch (até 500/org)
   *   2. Remove tag dos que ficaram completos
   *   3. Emite alert_signal categoria 'catalog_incomplete' se ainda houver
   */
  @Cron('0 11 * * *', { name: 'catalog_incomplete_daily', timeZone: 'UTC' })
  async dailyCatalogIncompleteCheck(): Promise<void> {
    this.log.log('[catalog-incomplete-cron] iniciando varredura diária')

    // Lista orgs com produtos pendentes
    const { data: orgs } = await supabaseAdmin
      .from('products')
      .select('organization_id')
      .or('tags.cs.{cadastro_pendente},catalog_status.eq.incomplete')
      .limit(1000)
    const orgIds = [...new Set((orgs ?? []).map(o => o.organization_id as string).filter(Boolean))]

    this.log.log(`[catalog-incomplete-cron] ${orgIds.length} orgs com produtos pendentes`)

    for (const orgId of orgIds) {
      try {
        const summary = await this.completeness.evaluateBulk(orgId, 500)

        // Reconcilia tags em produtos que ficaram completos por edição manual
        const sampleIds = summary.sample_incomplete.map(s => s.id)
        if (sampleIds.length > 0) {
          // refresh em paralelo só do sample (resto vai naturalmente quando user editar)
          await Promise.all(sampleIds.slice(0, 50).map(id =>
            this.completeness.refreshAndCleanupTag(id).catch(e =>
              this.log.warn(`[catalog-incomplete-cron] refresh ${id} falhou: ${(e as Error).message}`)
            ),
          ))
        }

        // Emite alert se houver pendentes
        if (summary.incomplete_count > 0) {
          await this.emitCatalogIncompleteAlert(orgId, summary)
        }
      } catch (e) {
        this.log.error(`[catalog-incomplete-cron] org=${orgId} falhou: ${(e as Error).message}`)
      }
    }

    this.log.log('[catalog-incomplete-cron] concluído')
  }

  private async emitCatalogIncompleteAlert(orgId: string, summary: {
    total: number
    incomplete_count: number
    by_missing: Record<string, number>
    sample_incomplete: Array<{ id: string; sku: string | null; name: string; missing: string[] }>
  }): Promise<void> {
    // Idempotência: 1 alert/dia por org
    const today = new Date().toISOString().slice(0, 10)
    const { data: existing } = await supabaseAdmin
      .from('alert_signals')
      .select('id')
      .eq('organization_id', orgId)
      .eq('category', 'catalog_incomplete')
      .gte('created_at', today + 'T00:00:00Z')
      .limit(1)
      .maybeSingle()
    if (existing) return

    const topMissing = Object.entries(summary.by_missing)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([field, count]) => `${field} (${count})`)

    const severity = summary.incomplete_count >= 50 ? 'high' : summary.incomplete_count >= 10 ? 'medium' : 'low'

    await supabaseAdmin.from('alert_signals').insert({
      organization_id: orgId,
      analyzer:        'catalog',
      category:        'catalog_incomplete',
      severity,
      score:           Math.min(summary.incomplete_count, 100),
      entity_type:     'product_batch',
      entity_name:     `${summary.incomplete_count} produtos pendentes`,
      data:            {
        incomplete_count: summary.incomplete_count,
        total_evaluated:  summary.total,
        top_missing:      topMissing,
        sample_ids:       summary.sample_incomplete.slice(0, 5).map(s => s.id),
      },
      summary_pt:      `${summary.incomplete_count} produto${summary.incomplete_count === 1 ? '' : 's'} precisa${summary.incomplete_count === 1 ? '' : 'm'} de cadastro completo`,
      suggestion_pt:   `Principais campos faltando: ${topMissing.join(', ')}. Despache pro operador em /produtos/operacao-cadastro.`,
      status:          'new',
      expires_at:      new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    })
    this.log.log(`[catalog-incomplete-cron] alert emitido org=${orgId} count=${summary.incomplete_count}`)
  }
}

/**
 * Mapeia label do campo faltante pra slug-de-tag amigável usando a nomenclatura
 * que aparece na vitrine do Mercado Livre (em vez de nomes técnicos).
 *
 * Ex: "Pelo menos 1 foto" → "fotos"; "Descrição (≥80 chars)" → "descricao".
 *
 * Slug normalizado: lowercase, sem acento, sem espaço/parênteses, underscore
 * apenas entre palavras quando termo composto (raro).
 */
const ML_TAG_SLUG_MAP: Record<string, string> = {
  // Universais (UNIVERSAL_LABELS em products-completeness.service.ts)
  'sku':                       'sku',
  'nome':                      'nome',
  'marca':                     'marca',
  'custo':                     'preco_custo',
  'preço':                     'preco',
  'preço de custo':            'preco_custo',
  'peso (kg)':                 'peso',
  'largura':                   'largura',
  'comprimento':               'comprimento',
  'altura':                    'altura',
  'pelo menos 1 foto':         'fotos',
  'descrição (≥80 chars)':     'descricao',
  'descrição':                 'descricao',
  'categoria ml':              'categoria',
  'categoria':                 'categoria',
  'título ml':                 'titulo',
  'título':                    'titulo',
  // ML attrs comuns (vêm dinâmicos, mas dá pra mapear os top)
  'cor principal':             'cor',
  'cor':                       'cor',
  'material':                  'material',
  'modelo':                    'modelo',
  'altura do produto':         'altura',
  'largura do produto':        'largura',
  'comprimento do produto':    'comprimento',
  'profundidade do produto':   'profundidade',
  'voltagem':                  'voltagem',
  'potência':                  'potencia',
  'temperatura de cor':        'temperatura_cor',
  'tipo de lâmpada':           'tipo_lampada',
  'condição do item':          'condicao',
  'unidades por embalagem':    'unidades',
  'is_kit':                    'kit',
}

function toMlTagSlug(label: string): string {
  const normalized = label.trim().toLowerCase()
  const fromMap = ML_TAG_SLUG_MAP[normalized]
  if (fromMap) return fromMap

  // Fallback: normaliza removendo acentos, parênteses e símbolos
  return normalized
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip acentos
    .replace(/[()≥≤<>≠]/g, '')                          // strip símbolos
    .replace(/[^a-z0-9\s_]/g, '')                       // só letras/dígitos/espaço/underscore
    .trim()
    .replace(/\s+/g, '_')                                // espaços → underscore
    .replace(/_+/g, '_')                                 // underscores duplos → simples
    .slice(0, 30)                                        // tag não pode ser absurda
}
