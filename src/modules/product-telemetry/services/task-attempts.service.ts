import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TaskAttemptInput {
  orgId:         string
  userId:        string
  attemptId:     string
  taskName:      string
  startedAt?:    string
  steps?:        string[]
  completedAt?:  string | null
  abandonedAt?:  string | null
  abandonedStep?: string | null
  outcome?:      string | null
}

/**
 * Upsert idempotente de tentativas de tarefa (funil) em telemetry_task_attempts.
 * A tabela tem GRANT só service_role — por isso a escrita passa SEMPRE pelo
 * backend. O frontend manda o snapshot completo da tentativa (id gerado no
 * client) e o backend faz upsert por id. org/user vêm do JWT, nunca do body.
 */
@Injectable()
export class TaskAttemptsService {
  private readonly logger = new Logger(TaskAttemptsService.name)

  async upsert(input: TaskAttemptInput): Promise<{ ok: boolean }> {
    if (!UUID_RE.test(input.attemptId) || !input.taskName?.trim()) {
      return { ok: false }
    }
    const row = {
      id:             input.attemptId,
      org_id:         input.orgId,
      user_id:        input.userId,
      task_name:      input.taskName.trim().slice(0, 60),
      started_at:     input.startedAt ?? new Date().toISOString(),
      completed_at:   input.completedAt ?? null,
      abandoned_at:   input.abandonedAt ?? null,
      abandoned_step: input.abandonedStep ? String(input.abandonedStep).slice(0, 40) : null,
      steps_completed: Array.isArray(input.steps) ? input.steps.slice(0, 50).map(s => String(s).slice(0, 40)) : [],
      outcome:        input.outcome ? String(input.outcome).slice(0, 20) : null,
    }
    const { error } = await supabaseAdmin
      .from('telemetry_task_attempts')
      .upsert(row, { onConflict: 'id' })
    if (error) {
      this.logger.warn(`[task-attempts] upsert falhou (${input.taskName}): ${error.message}`)
      return { ok: false }
    }
    return { ok: true }
  }
}
