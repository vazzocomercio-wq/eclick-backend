import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { ActiveResolverService } from '../active-bridge/active-resolver.service'

/**
 * Product OS — Fase 3: despacho de tarefas operacionais pro e-Click Active.
 * SaaS→Active, uma direção. Reusa o active-bridge existente, degrada
 * graciosamente se não configurado, e NUNCA bloqueia a ação do SaaS.
 */

const PIPELINE_NAME = 'Desenvolvimento de Produto'
const PRODUCT_DEV_STAGE_NAMES = ['Ideia', 'Briefing', 'Modelagem', 'Prototipagem', 'Aprovado', 'Publicado']

const STATUS_TO_ACTIVE_STAGE: Record<string, string | null> = {
  ideia: 'Ideia', briefing: 'Briefing', modelagem: 'Modelagem', prototipo: 'Prototipagem',
  aprovado: 'Aprovado', publicado: 'Publicado', monitorando: 'Publicado', arquivado: null,
}

interface DevRow { id: string; name: string; status: string; production_profile: string; active_deal_id: string | null }

@Injectable()
export class ProductOsActiveService {
  private readonly log = new Logger(ProductOsActiveService.name)

  constructor(
    private readonly bridge: ActiveBridgeClient,
    private readonly resolver: ActiveResolverService,
  ) {}

  private softSkip(message: string) { return { ok: true, dispatched: false, skipped_no_bridge: true, message } }

  private taskBodyFor(status: string, name: string, note?: string): string {
    const base: Record<string, string> = {
      modelagem: `Modelar CAD: ${name}`,
      prototipo: `Imprimir/validar protótipo: ${name}`,
      aprovado:  `Publicar nos canais: ${name}`,
    }
    const t = base[status] ?? `Desenvolver produto: ${name}`
    return (note ? `${t} — ${note}` : t).slice(0, 200)
  }

  /** Despacha (ou re-sincroniza) um card no funil "Desenvolvimento de Produto". */
  async dispatch(devId: string, orgId: string, dispatcherUserId: string | null, body: { assigned_to?: string; note?: string; stage?: string }) {
    const { data } = await supabaseAdmin.from('product_dev')
      .select('id, name, status, production_profile, active_deal_id')
      .eq('id', devId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Produto não encontrado')
    const dev = data as DevRow
    if (dev.status === 'arquivado') throw new BadRequestException('Produto arquivado não pode ser despachado')

    if (!this.bridge.isConfigured()) {
      return this.softSkip('Integração com o Active não está configurada nesta conta. O produto foi salvo, mas nenhuma tarefa foi enviada ao CRM.')
    }

    let activeOrgId: string
    try {
      const r = await this.resolver.resolveActiveOrgForUser(dispatcherUserId ?? '')
      activeOrgId = r.org_id
    } catch {
      return this.softSkip('Não encontramos sua conta no e-Click Active. Verifique se o módulo Active está ativo antes de despachar tarefas.')
    }

    const deeplink = `${process.env.FRONTEND_PUBLIC_URL ?? 'https://eclick.app.br'}/dashboard/catalogo/product-os`

    // já despachado → só reflete o status no card
    if (dev.active_deal_id) {
      const stageName = body.stage ?? STATUS_TO_ACTIVE_STAGE[dev.status] ?? undefined
      try {
        const mv = await this.bridge.moveCard({ deal_id: dev.active_deal_id, to_stage_name: stageName, action_link: { label: 'Abrir no SaaS', url: deeplink } })
        return { ok: true, already_dispatched: true, deal_id: dev.active_deal_id, moved: mv.moved ?? false, message: 'Este produto já tem um card no Active. Atualizamos o status do card.' }
      } catch {
        return { ok: true, already_dispatched: true, deal_id: dev.active_deal_id, message: 'Este produto já tem um card no Active.' }
      }
    }

    // garante o funil
    const pipe = await this.bridge.ensureServicePipeline({ organization_id: activeOrgId, name: PIPELINE_NAME, stages: PRODUCT_DEV_STAGE_NAMES })
    if (pipe.skipped_no_bridge || !pipe.pipeline_id) {
      return this.softSkip('Não foi possível preparar o funil no Active agora. Tente novamente em instantes.')
    }
    const wantStage = body.stage ?? STATUS_TO_ACTIVE_STAGE[dev.status] ?? 'Ideia'
    const stageId = pipe.stages?.find(s => s.name === wantStage)?.id ?? pipe.default_stage_id
    if (!stageId) return this.softSkip('Funil do Active sem etapas configuradas.')

    try {
      const res = await this.bridge.createCampaignCard({
        organization_id: activeOrgId, pipeline_id: pipe.pipeline_id, stage_id: stageId,
        assigned_to: body.assigned_to,
        title: `Desenvolver: ${dev.name}`,
        task_title: this.taskBodyFor(dev.status, dev.name, body.note),
        due_date: new Date(Date.now() + 24 * 3600_000).toISOString(),
        tags: ['product_os', `perfil:${dev.production_profile}`],
        metadata: { source: 'saas_product_os', card_kind: 'product_dev', product_dev_id: devId, status: dev.status, deeplink, note: body.note ?? null },
        dedup_key: `product_os:${devId}`,
      })
      if (res.skipped_no_bridge) return this.softSkip('Active não recebeu a tarefa (integração indisponível).')
      if (res.deal_id) {
        await supabaseAdmin.from('product_dev').update({ active_deal_id: res.deal_id }).eq('id', devId).eq('organization_id', orgId)
        await supabaseAdmin.from('product_dev_event').insert({
          organization_id: orgId, product_dev_id: devId, event_type: 'dispatched',
          payload: { deal_id: res.deal_id, task_id: res.task_id ?? null, stage: wantStage }, actor_id: dispatcherUserId,
        }).then(() => {}, () => {})
      }
      return { ok: true, dispatched: true, deal_id: res.deal_id ?? null, task_id: res.task_id ?? null, message: 'Tarefa enviada para o Active.' }
    } catch (e) {
      this.log.warn(`[product-os.dispatch] ${(e as Error).message}`)
      return { ok: true, dispatched: false, message: 'Não foi possível enviar a tarefa ao Active agora. Tente novamente em instantes.' }
    }
  }

  /** Reflete o status atual no card do Active (best-effort, nunca lança). */
  async reflectStatus(orgId: string, devId: string): Promise<void> {
    if (!this.bridge.isConfigured()) return
    const { data } = await supabaseAdmin.from('product_dev').select('status, active_deal_id').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const row = data as { status: string; active_deal_id: string | null } | null
    if (!row?.active_deal_id) return
    const stageName = STATUS_TO_ACTIVE_STAGE[row.status]
    if (!stageName) return
    const deeplink = `${process.env.FRONTEND_PUBLIC_URL ?? 'https://eclick.app.br'}/dashboard/catalogo/product-os`
    try {
      await this.bridge.moveCard({ deal_id: row.active_deal_id, to_stage_name: stageName, action_link: { label: 'Abrir no SaaS', url: deeplink } })
    } catch (e) {
      this.log.warn(`[product-os.reflect] ${(e as Error).message}`)
    }
  }
}
