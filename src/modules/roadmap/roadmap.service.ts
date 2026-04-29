import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export type RoadmapStatus = 'done' | 'wip' | 'next' | 'new' | 'planned'

export interface RoadmapItem {
  id:        string
  phase_id:  string
  label:     string
  status:    RoadmapStatus
  priority:  number
  notes:     string | null
  created_at: string
  updated_at: string
}

export interface RoadmapPhase {
  id:         string
  num:        string
  label:      string
  sub:        string | null
  status:     RoadmapStatus
  pct:        number
  sort_order: number
  items:      RoadmapItem[]
}

const ALLOWED_STATUS: readonly RoadmapStatus[] = ['done', 'wip', 'next', 'new', 'planned'] as const

@Injectable()
export class RoadmapService {
  private readonly logger = new Logger(RoadmapService.name)

  /** GET /roadmap — fases ordenadas por sort_order, items aninhados ordenados
   * por status (done primeiro) e created_at. Retorna shape pronto pra render. */
  async list(orgId: string): Promise<RoadmapPhase[]> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')

    const [phasesRes, itemsRes] = await Promise.all([
      supabaseAdmin
        .from('roadmap_phases')
        .select('id, num, label, sub, status, pct, sort_order')
        .eq('organization_id', orgId)
        .order('sort_order', { ascending: true }),
      supabaseAdmin
        .from('roadmap_items')
        .select('id, phase_id, label, status, priority, notes, created_at, updated_at')
        .eq('organization_id', orgId),
    ])

    if (phasesRes.error) throw new BadRequestException(phasesRes.error.message)
    if (itemsRes.error)  throw new BadRequestException(itemsRes.error.message)

    const phases = (phasesRes.data ?? []) as unknown as RoadmapPhase[]
    const items  = (itemsRes.data ?? []) as unknown as RoadmapItem[]

    // Sort items: done first, then wip, next, new, planned. Tiebreak: created_at asc.
    const order: Record<RoadmapStatus, number> = { done: 0, wip: 1, next: 2, new: 3, planned: 4 }
    items.sort((a, b) => {
      const d = (order[a.status] ?? 99) - (order[b.status] ?? 99)
      if (d !== 0) return d
      return a.created_at.localeCompare(b.created_at)
    })

    const byPhase = new Map<string, RoadmapItem[]>()
    for (const it of items) {
      const arr = byPhase.get(it.phase_id) ?? []
      arr.push(it)
      byPhase.set(it.phase_id, arr)
    }

    return phases.map(p => ({ ...p, items: byPhase.get(p.id) ?? [] }))
  }

  /** PATCH /roadmap/phases/:id — body: { status?, pct?, label?, sub? }. Só
   * altera campos passados. Org-scope checado pelo update WHERE. */
  async updatePhase(
    orgId: string, id: string,
    body: { status?: RoadmapStatus; pct?: number; label?: string; sub?: string | null },
  ): Promise<RoadmapPhase> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')
    if (body.status && !ALLOWED_STATUS.includes(body.status)) {
      throw new BadRequestException(`status inválido: ${body.status}`)
    }
    if (body.pct != null && (body.pct < 0 || body.pct > 100)) {
      throw new BadRequestException('pct deve ser entre 0 e 100')
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.status !== undefined) patch.status = body.status
    if (body.pct    !== undefined) patch.pct    = body.pct
    if (body.label  !== undefined) patch.label  = body.label
    if (body.sub    !== undefined) patch.sub    = body.sub

    const { data, error } = await supabaseAdmin
      .from('roadmap_phases')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('id, num, label, sub, status, pct, sort_order')
      .single()
    if (error || !data) throw new NotFoundException(error?.message ?? 'Fase não encontrada')
    return { ...(data as unknown as RoadmapPhase), items: [] }
  }

  /** POST /roadmap/items — cria item e recalcula pct da fase. */
  async createItem(
    orgId: string,
    body: { phase_id: string; label: string; status?: RoadmapStatus; priority?: number; notes?: string | null },
  ): Promise<RoadmapItem> {
    if (!orgId)            throw new BadRequestException('orgId obrigatório')
    if (!body.phase_id)    throw new BadRequestException('phase_id obrigatório')
    if (!body.label?.trim()) throw new BadRequestException('label obrigatório')
    const status   = body.status ?? 'new'
    const priority = body.priority ?? 0
    if (!ALLOWED_STATUS.includes(status)) {
      throw new BadRequestException(`status inválido: ${status}`)
    }

    // Valida que phase pertence à org (defesa contra cross-org via service_role).
    const { data: phase } = await supabaseAdmin
      .from('roadmap_phases')
      .select('id')
      .eq('id', body.phase_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!phase) throw new NotFoundException('Fase não encontrada nesta org')

    const { data, error } = await supabaseAdmin
      .from('roadmap_items')
      .insert({
        organization_id: orgId,
        phase_id:        body.phase_id,
        label:           body.label.trim(),
        status,
        priority,
        notes:           body.notes ?? null,
      })
      .select('*')
      .single()
    if (error || !data) throw new BadRequestException(error?.message ?? 'Falha ao criar item')

    await this.recalcPhasePct(orgId, body.phase_id)
    return data as unknown as RoadmapItem
  }

  /** PATCH /roadmap/items/:id — atualiza status/label/priority/notes e
   * recalcula pct da fase pai. */
  async updateItem(
    orgId: string, id: string,
    body: { status?: RoadmapStatus; label?: string; priority?: number; notes?: string | null },
  ): Promise<RoadmapItem> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')
    if (body.status && !ALLOWED_STATUS.includes(body.status)) {
      throw new BadRequestException(`status inválido: ${body.status}`)
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.status   !== undefined) patch.status   = body.status
    if (body.label    !== undefined) patch.label    = body.label
    if (body.priority !== undefined) patch.priority = body.priority
    if (body.notes    !== undefined) patch.notes    = body.notes

    const { data, error } = await supabaseAdmin
      .from('roadmap_items')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .single()
    if (error || !data) throw new NotFoundException(error?.message ?? 'Item não encontrado')

    const item = data as unknown as RoadmapItem
    await this.recalcPhasePct(orgId, item.phase_id)
    return item
  }

  /** DELETE /roadmap/items/:id — remove + recalcula pct da fase. */
  async deleteItem(orgId: string, id: string): Promise<{ ok: true }> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')

    const { data: existing } = await supabaseAdmin
      .from('roadmap_items')
      .select('phase_id')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!existing) throw new NotFoundException('Item não encontrado')

    const { error } = await supabaseAdmin
      .from('roadmap_items')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)

    await this.recalcPhasePct(orgId, (existing as { phase_id: string }).phase_id)
    return { ok: true }
  }

  /** Recalcula pct = (done + 0.5*wip) / total * 100, arredondado. wip conta
   * como meio item completo pra dar progresso parcial visual. Sem items, pct=0. */
  private async recalcPhasePct(orgId: string, phaseId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('roadmap_items')
      .select('status')
      .eq('organization_id', orgId)
      .eq('phase_id', phaseId)
    const items = (data ?? []) as Array<{ status: RoadmapStatus }>
    if (items.length === 0) {
      await supabaseAdmin
        .from('roadmap_phases')
        .update({ pct: 0, updated_at: new Date().toISOString() })
        .eq('id', phaseId)
        .eq('organization_id', orgId)
      return
    }

    const done = items.filter(i => i.status === 'done').length
    const wip  = items.filter(i => i.status === 'wip').length
    const pct  = Math.round(((done + wip * 0.5) / items.length) * 100)

    await supabaseAdmin
      .from('roadmap_phases')
      .update({ pct, updated_at: new Date().toISOString() })
      .eq('id', phaseId)
      .eq('organization_id', orgId)
  }
}
