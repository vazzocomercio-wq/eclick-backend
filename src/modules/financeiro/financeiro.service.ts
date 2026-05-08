import { Injectable, HttpException, NotFoundException, BadRequestException, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreatePayableDto {
  description: string
  amount: number
  due_date: string             // 'YYYY-MM-DD'
  beneficiary_name: string
  source_type?: 'manual' | 'service' | 'rent' | 'tax' | 'salary' | 'utility' | 'other'
  supplier_id?: string | null
  beneficiary_doc?: string | null
  issue_date?: string | null
  payment_method?: string | null
  category?: string | null
  cost_center?: string | null
  notes?: string | null
}

export interface UpdatePayableDto extends Partial<CreatePayableDto> {
  status?: 'pending' | 'cancelled'
}

export interface MarkPaidDto {
  paid_amount?: number          // se ausente, paga total restante
  payment_method: string
  payment_reference?: string | null
  payment_proof_url?: string | null
  payment_proof_storage_path?: string | null
  paid_at?: string | null       // default agora
  notes?: string | null
}

export interface PayableSourceCreate {
  organization_id: string
  source_type: 'dropship_oc' | 'purchase_order'
  source_id: string
  description: string
  amount: number
  due_date: string
  beneficiary_name: string
  supplier_id?: string | null
  beneficiary_doc?: string | null
  category?: string | null
  metadata?: Record<string, unknown>
  created_by?: string | null
}

@Injectable()
export class FinanceiroService {
  private readonly logger = new Logger('FinanceiroService')

  // ── Cron: marca payables vencidos como overdue ────────────────────────────

  @Cron('0 6 * * *', { name: 'financeiro-mark-overdue' })
  async markOverdueTick() {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const { data, error } = await supabaseAdmin
        .from('accounts_payable')
        .update({ status: 'overdue', updated_at: new Date().toISOString() })
        .lt('due_date', today)
        .in('status', ['pending', 'partial'])
        .select('id')
      if (error) throw error
      const count = data?.length ?? 0
      if (count > 0) {
        this.logger.log(`[overdue] ${count} payables marcados como overdue`)
      }
    } catch (e) {
      this.logger.warn(`[overdue] erro: ${e instanceof Error ? e.message : e}`)
    }
  }

  // ── Numbering ──────────────────────────────────────────────────────────────

  private async generatePayableNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const month = String(new Date().getMonth() + 1).padStart(2, '0')
    const { count } = await supabaseAdmin
      .from('accounts_payable')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', `${year}-${month}-01`)
    return `AP-${year}${month}-${String((count ?? 0) + 1).padStart(4, '0')}`
  }

  // ── CRUD manual ────────────────────────────────────────────────────────────

  async createPayable(orgId: string, userId: string | null, dto: CreatePayableDto) {
    if (!dto.description?.trim()) throw new BadRequestException('Descrição obrigatória')
    if (!dto.beneficiary_name?.trim()) throw new BadRequestException('Beneficiário obrigatório')
    if (typeof dto.amount !== 'number' || dto.amount < 0) throw new BadRequestException('Valor inválido')
    if (!dto.due_date) throw new BadRequestException('Vencimento obrigatório')

    const number = await this.generatePayableNumber(orgId)

    const { data, error } = await supabaseAdmin
      .from('accounts_payable')
      .insert({
        organization_id: orgId,
        payable_number: number,
        description: dto.description.trim(),
        source_type: dto.source_type ?? 'manual',
        source_id: null,
        supplier_id: dto.supplier_id ?? null,
        beneficiary_name: dto.beneficiary_name.trim(),
        beneficiary_doc: dto.beneficiary_doc ?? null,
        amount: dto.amount,
        issue_date: dto.issue_date ?? new Date().toISOString().slice(0, 10),
        due_date: dto.due_date,
        status: 'pending',
        payment_method: dto.payment_method ?? null,
        category: dto.category ?? null,
        cost_center: dto.cost_center ?? null,
        notes: dto.notes ?? null,
        created_by: userId,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  /** Cria payable a partir de outra entidade (OC dropship, PO de importação).
   *  Idempotente via UNIQUE (source_type, source_id). */
  async createPayableFromSource(input: PayableSourceCreate) {
    // Verifica se já existe
    const { data: existing } = await supabaseAdmin
      .from('accounts_payable')
      .select('id')
      .eq('source_type', input.source_type)
      .eq('source_id', input.source_id)
      .maybeSingle()
    if (existing) return existing  // Idempotente

    const number = await this.generatePayableNumber(input.organization_id)

    const { data, error } = await supabaseAdmin
      .from('accounts_payable')
      .insert({
        organization_id: input.organization_id,
        payable_number: number,
        description: input.description,
        source_type: input.source_type,
        source_id: input.source_id,
        supplier_id: input.supplier_id ?? null,
        beneficiary_name: input.beneficiary_name,
        beneficiary_doc: input.beneficiary_doc ?? null,
        amount: input.amount,
        issue_date: new Date().toISOString().slice(0, 10),
        due_date: input.due_date,
        status: 'pending',
        category: input.category ?? null,
        metadata: input.metadata ?? {},
        created_by: input.created_by ?? null,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async listPayables(orgId: string, filters: {
    status?: string;
    source_type?: string;
    supplier_id?: string;
    due_from?: string;
    due_to?: string;
    q?: string;
  }) {
    let query = supabaseAdmin
      .from('accounts_payable')
      .select(`
        id, payable_number, description, source_type, source_id,
        supplier_id, beneficiary_name, beneficiary_doc,
        amount, paid_amount, remaining_amount,
        issue_date, due_date, paid_at, status,
        payment_method, payment_reference, payment_proof_url,
        category, cost_center, notes,
        created_at, updated_at,
        suppliers(id, name)
      `)
      .eq('organization_id', orgId)
      .order('due_date', { ascending: true })
      .limit(200)

    if (filters.status) {
      const arr = filters.status.split(',')
      query = arr.length > 1 ? query.in('status', arr) : query.eq('status', filters.status)
    }
    if (filters.source_type) query = query.eq('source_type', filters.source_type)
    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.due_from) query = query.gte('due_date', filters.due_from)
    if (filters.due_to) query = query.lte('due_date', filters.due_to)
    if (filters.q) query = query.or(`description.ilike.%${filters.q}%,beneficiary_name.ilike.%${filters.q}%,payable_number.ilike.%${filters.q}%`)

    const { data, error } = await query
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getPayable(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('accounts_payable')
      .select(`*, suppliers(id, name, legal_name, tax_id)`)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Conta a pagar não encontrada')
    return data
  }

  async updatePayable(orgId: string, id: string, dto: UpdatePayableDto) {
    const existing = await this.getPayable(orgId, id) as Record<string, unknown>
    if (existing.status === 'paid') {
      throw new BadRequestException('Não pode editar conta já paga')
    }
    const patch: Record<string, unknown> = {}
    const fields = [
      'description', 'beneficiary_name', 'beneficiary_doc', 'supplier_id',
      'amount', 'issue_date', 'due_date', 'payment_method',
      'category', 'cost_center', 'notes', 'status',
    ] as const
    const dtoRec = dto as Record<string, unknown>
    for (const k of fields) if (dtoRec[k] !== undefined) patch[k] = dtoRec[k]

    if (Object.keys(patch).length === 0) return existing

    patch.updated_at = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('accounts_payable')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async markPaid(orgId: string, id: string, dto: MarkPaidDto) {
    const existing = await this.getPayable(orgId, id) as Record<string, unknown>
    if (existing.status === 'paid' || existing.status === 'cancelled') {
      throw new BadRequestException(`Conta já ${existing.status === 'paid' ? 'paga' : 'cancelada'}`)
    }
    if (!dto.payment_method) throw new BadRequestException('Método de pagamento obrigatório')

    const totalAmount = Number(existing.amount ?? 0)
    const alreadyPaid = Number(existing.paid_amount ?? 0)
    const remaining = totalAmount - alreadyPaid
    const paying = dto.paid_amount ?? remaining
    if (paying <= 0) throw new BadRequestException('Valor de pagamento inválido')
    if (paying > remaining + 0.001) throw new BadRequestException(`Valor maior que restante (R$ ${remaining.toFixed(2)})`)

    const newPaidAmount = alreadyPaid + paying
    const isFullyPaid = Math.abs(totalAmount - newPaidAmount) < 0.01
    const newStatus = isFullyPaid ? 'paid' : 'partial'

    const paidAt = dto.paid_at ?? new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('accounts_payable')
      .update({
        paid_amount: newPaidAmount,
        status: newStatus,
        paid_at: isFullyPaid ? paidAt : (existing.paid_at ?? null),
        payment_method: dto.payment_method,
        payment_reference: dto.payment_reference ?? existing.payment_reference,
        payment_proof_url: dto.payment_proof_url ?? existing.payment_proof_url,
        payment_proof_storage_path: dto.payment_proof_storage_path ?? existing.payment_proof_storage_path,
        notes: dto.notes ? `${(existing.notes as string) ?? ''}\n${dto.notes}`.trim() : existing.notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    // Side-effect: atualizar source quando totalmente pago
    if (isFullyPaid && existing.source_type === 'dropship_oc' && existing.source_id) {
      await supabaseAdmin
        .from('dropship_purchase_orders')
        .update({
          status: 'paid',
          paid_at: paidAt,
          payment_method: dto.payment_method,
          payment_reference: dto.payment_reference ?? null,
          payment_proof_url: dto.payment_proof_url ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.source_id as string)
    }

    return data
  }

  async cancelPayable(orgId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo obrigatório')
    const existing = await this.getPayable(orgId, id) as Record<string, unknown>
    if (existing.status === 'paid') throw new BadRequestException('Não pode cancelar conta já paga')

    const { error } = await supabaseAdmin
      .from('accounts_payable')
      .update({
        status: 'cancelled',
        notes: `${(existing.notes as string) ?? ''}\n[CANCELADO] ${reason.trim()}`.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Dashboard summary ──────────────────────────────────────────────────────

  async getSummary(orgId: string) {
    const today = new Date().toISOString().slice(0, 10)
    const next7d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    const next30d = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const { data: pending } = await supabaseAdmin
      .from('accounts_payable')
      .select('amount, paid_amount, due_date, status')
      .eq('organization_id', orgId)
      .in('status', ['pending', 'partial', 'overdue'])

    const totalPending = (pending ?? []).reduce((s, p) =>
      s + Math.max(0, Number(p.amount ?? 0) - Number(p.paid_amount ?? 0)), 0,
    )
    const overdueCount = (pending ?? []).filter(p => p.status === 'overdue').length
    const overdueValue = (pending ?? [])
      .filter(p => p.status === 'overdue')
      .reduce((s, p) => s + Math.max(0, Number(p.amount ?? 0) - Number(p.paid_amount ?? 0)), 0)
    const next7dValue = (pending ?? [])
      .filter(p => p.due_date >= today && p.due_date <= next7d)
      .reduce((s, p) => s + Math.max(0, Number(p.amount ?? 0) - Number(p.paid_amount ?? 0)), 0)
    const next30dValue = (pending ?? [])
      .filter(p => p.due_date >= today && p.due_date <= next30d)
      .reduce((s, p) => s + Math.max(0, Number(p.amount ?? 0) - Number(p.paid_amount ?? 0)), 0)

    const { data: paidThisMonth } = await supabaseAdmin
      .from('accounts_payable')
      .select('paid_amount, paid_at')
      .eq('organization_id', orgId)
      .eq('status', 'paid')
      .gte('paid_at', monthStart.toISOString())
    const paidThisMonthValue = (paidThisMonth ?? []).reduce((s, p) =>
      s + Number(p.paid_amount ?? 0), 0,
    )

    return {
      total_pending: totalPending,
      overdue_count: overdueCount,
      overdue_value: overdueValue,
      next_7d_value: next7dValue,
      next_30d_value: next30dValue,
      paid_this_month: paidThisMonthValue,
      pending_count: (pending ?? []).length,
    }
  }
}
