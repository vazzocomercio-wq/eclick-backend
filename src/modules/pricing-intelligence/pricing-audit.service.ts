import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface AuditEntry {
  id:              string
  organization_id: string
  config_id:       string | null
  field_path:      string
  old_value:       unknown
  new_value:       unknown
  changed_by:      string | null
  change_reason:   string | null
  created_at:      string
}

/** Registra mudanças em pricing_intelligence_config field-by-field
 * (path notation: "abc_strategies.A.min_margin_pct"). Best-effort —
 * falha de audit não trava o write principal. */
@Injectable()
export class PricingAuditService {
  private readonly logger = new Logger(PricingAuditService.name)

  async log(entry: {
    orgId:        string
    configId:     string
    fieldPath:    string
    oldValue:     unknown
    newValue:     unknown
    changedBy?:   string | null
    reason?:      string | null
  }): Promise<void> {
    try {
      await supabaseAdmin.from('pricing_config_audit').insert({
        organization_id: entry.orgId,
        config_id:       entry.configId,
        field_path:      entry.fieldPath,
        old_value:       entry.oldValue ?? null,
        new_value:       entry.newValue ?? null,
        changed_by:      entry.changedBy ?? null,
        change_reason:   entry.reason ?? null,
      })
    } catch (e: unknown) {
      this.logger.warn(`[pricing.audit] insert falhou ${entry.fieldPath}: ${(e as Error)?.message}`)
    }
  }

  /** Múltiplas mudanças de uma vez (uso: applyPreset, reset). */
  async logBatch(entries: Array<{
    orgId:      string
    configId:   string
    fieldPath:  string
    oldValue:   unknown
    newValue:   unknown
    changedBy?: string | null
    reason?:    string | null
  }>): Promise<void> {
    if (entries.length === 0) return
    try {
      const rows = entries.map(e => ({
        organization_id: e.orgId,
        config_id:       e.configId,
        field_path:      e.fieldPath,
        old_value:       e.oldValue ?? null,
        new_value:       e.newValue ?? null,
        changed_by:      e.changedBy ?? null,
        change_reason:   e.reason ?? null,
      }))
      // chunk 200 por insert pra evitar payload gigante
      for (let i = 0; i < rows.length; i += 200) {
        await supabaseAdmin.from('pricing_config_audit').insert(rows.slice(i, i + 200))
      }
    } catch (e: unknown) {
      this.logger.warn(`[pricing.audit] batch insert falhou: ${(e as Error)?.message}`)
    }
  }

  /** Últimas N mudanças da org. UI mostra na aba Auditoria. */
  async list(orgId: string, limit = 50): Promise<AuditEntry[]> {
    const { data } = await supabaseAdmin
      .from('pricing_config_audit')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))
    return (data ?? []) as AuditEntry[]
  }
}
