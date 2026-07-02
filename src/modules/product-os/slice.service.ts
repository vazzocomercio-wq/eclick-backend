import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — fatiamento automático via Bambu Studio CLI (roda no PC da farm).
 * O backend só orquestra: cria o job, o agente puxa na resposta da telemetria,
 * fatia com os perfis oficiais achatados, sobe o .gcode.3mf por URL assinada e
 * reporta os números REAIS (tempo + gramas), que alimentam custo/margem/Gantt.
 */

const RUN_TIMEOUT_MS = 20 * 60_000   // 'running' há mais que isso = agente caiu no meio

export interface SliceJobOut {
  id: string
  source_url: string
  source_name: string | null
  plate: number
  machine_profile: string
  process_profile: string
  filament_profile: string
  upload_url: string
  upload_path: string
}

interface SliceMeta {
  prediction_s?: number
  filaments?: Array<{ id?: number; filament_id?: string; used_g?: number }>
  duration_ms?: number
}

@Injectable()
export class SliceService {
  private readonly logger = new Logger(SliceService.name)

  /** Material da versão → perfil de filamento oficial da A1 (achatado no agente). */
  private filamentProfile(material: string | null): string {
    const m = (material ?? '').trim().toUpperCase()
    if (m.includes('PETG')) return 'Bambu PETG Basic @BBL A1'
    if (m.includes('ABS')) return 'Bambu ABS @BBL A1'
    if (m.includes('TPU')) return 'Bambu TPU 95A @BBL A1'
    if (m.includes('SILK')) return 'Bambu PLA Silk @BBL A1'
    if (m.includes('MATTE') || m.includes('MATE')) return 'Bambu PLA Matte @BBL A1'
    return 'Bambu PLA Basic @BBL A1'
  }

  private uploadPath(orgId: string, versionId: string, jobId: string): string {
    return `sliced/${orgId}/${versionId}-${jobId}.gcode.3mf`
  }

  private publicUrl(path: string): string {
    return `${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/object/public/product-os/${path}`
  }

  /** Cria (ou devolve o já aberto) job de fatiamento de uma versão. */
  async requestSlice(orgId: string, versionId: string, userId: string | null) {
    const { data: v } = await supabaseAdmin.from('product_dev_version')
      .select('id, organization_id, file_url, material, product_dev_id, part_id')
      .eq('id', versionId).maybeSingle()
    const ver = v as { id: string; organization_id: string; file_url: string | null; material: string | null } | null
    if (!ver || ver.organization_id !== orgId) throw new BadRequestException('Versão não encontrada')
    if (!ver.file_url) throw new BadRequestException('A versão não tem arquivo de modelo (.stl/.3mf) para fatiar. Suba o modelo primeiro.')
    if (/\.gcode\.3mf/i.test(ver.file_url)) throw new BadRequestException('Este arquivo já está fatiado (.gcode.3mf) — pode enviar direto pra impressora.')
    if (!/\.(stl|3mf|obj)([?#]|$)/i.test(ver.file_url)) throw new BadRequestException('Só sei fatiar .stl, .3mf (projeto) ou .obj. Suba um desses formatos na versão.')

    // job aberto pra esta versão? → idempotente, devolve o mesmo
    const { data: open } = await supabaseAdmin.from('slice_job')
      .select('id, status, created_at').eq('version_id', versionId).in('status', ['pending', 'running'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (open) return { ...(open as Record<string, unknown>), already_queued: true }

    const name = decodeURIComponent(String(ver.file_url).split('?')[0].split('/').pop() || 'model.stl')
    const { data, error } = await supabaseAdmin.from('slice_job').insert({
      organization_id: orgId, version_id: versionId, source_url: ver.file_url, source_name: name,
      filament_profile: this.filamentProfile(ver.material), requested_by: userId,
    }).select('id, status, created_at').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar job de fatiamento: ${error?.message ?? 'sem dados'}`)
    return data
  }

  /** Último job da versão (a tela faz poll disso enquanto fatia). */
  async latestJob(orgId: string, versionId: string) {
    const { data } = await supabaseAdmin.from('slice_job')
      .select('id, status, error, result_url, result_meta, created_at, started_at, finished_at')
      .eq('organization_id', orgId).eq('version_id', versionId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    return data ?? null
  }

  /** Entrega (no máx.) 1 job pendente pro agente — chamado dentro da resposta
   *  da telemetria. Fatiar é pesado: 1 por vez por agente. */
  async pullJobs(orgId: string, agentId: string): Promise<SliceJobOut[]> {
    // agente caiu no meio? → job 'running' velho vira 'failed' (o usuário refaz)
    await supabaseAdmin.from('slice_job')
      .update({ status: 'failed', error: 'O agente não concluiu o fatiamento em 20min (PC da farm desligou/reiniciou?). Tente de novo.', finished_at: new Date().toISOString() })
      .eq('organization_id', orgId).eq('status', 'running')
      .lt('started_at', new Date(Date.now() - RUN_TIMEOUT_MS).toISOString())

    const { data: busy } = await supabaseAdmin.from('slice_job').select('id')
      .eq('agent_id', agentId).eq('status', 'running').limit(1).maybeSingle()
    if (busy) return []

    const { data: pend } = await supabaseAdmin.from('slice_job')
      .select('id, version_id, source_url, source_name, plate, machine_profile, process_profile, filament_profile')
      .eq('organization_id', orgId).eq('status', 'pending')
      .order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (!pend) return []
    const job = pend as { id: string; version_id: string; source_url: string; source_name: string | null; plate: number; machine_profile: string; process_profile: string; filament_profile: string }

    const path = this.uploadPath(orgId, job.version_id, job.id)
    const { data: up, error: upErr } = await supabaseAdmin.storage.from('product-os').createSignedUploadUrl(path)
    if (upErr || !up) { this.logger.warn(`[slice] signed upload falhou: ${upErr?.message}`); return [] }

    // CAS: outro push pode ter levado o mesmo job
    const { data: took } = await supabaseAdmin.from('slice_job')
      .update({ status: 'running', agent_id: agentId, started_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'pending').select('id')
    if (!took?.length) return []

    return [{
      id: job.id, source_url: job.source_url, source_name: job.source_name, plate: job.plate,
      machine_profile: job.machine_profile, process_profile: job.process_profile, filament_profile: job.filament_profile,
      upload_url: up.signedUrl, upload_path: path,
    }]
  }

  /** Resultado do agente (auth por token de agente): grava o job e leva os
   *  números REAIS pra versão (sliced_file_url + tempo + gramas). */
  async completeJob(token: string, body: { job_id?: string; ok?: boolean; error?: string; meta?: SliceMeta }) {
    if (!token) throw new UnauthorizedException('token ausente')
    const { data: agent } = await supabaseAdmin.from('farm_agent')
      .select('id, organization_id, status').eq('token', token).maybeSingle()
    const a = agent as { id: string; organization_id: string; status: string } | null
    if (!a || a.status !== 'ativo') throw new UnauthorizedException('agente inválido ou revogado')
    if (!body?.job_id) throw new BadRequestException('job_id ausente')

    const { data: j } = await supabaseAdmin.from('slice_job')
      .select('id, organization_id, version_id, status').eq('id', body.job_id).maybeSingle()
    const job = j as { id: string; organization_id: string; version_id: string; status: string } | null
    if (!job || job.organization_id !== a.organization_id) throw new BadRequestException('Job não encontrado')
    if (job.status !== 'running') return { ok: true, ignored: true }   // timeout/refeito no meio-tempo

    if (!body.ok) {
      await supabaseAdmin.from('slice_job')
        .update({ status: 'failed', error: (body.error || 'falha no fatiamento').slice(0, 500), finished_at: new Date().toISOString() })
        .eq('id', job.id).eq('status', 'running')
      this.logger.warn(`[slice] job ${job.id.slice(0, 8)} falhou: ${body.error}`)
      return { ok: true }
    }

    const meta = body.meta ?? {}
    const path = this.uploadPath(job.organization_id, job.version_id, job.id)
    const url = this.publicUrl(path)
    const minutes = Number(meta.prediction_s) > 0 ? Math.max(1, Math.round(Number(meta.prediction_s) / 60)) : null
    const grams = (meta.filaments ?? []).reduce((s, f) => s + (Number(f.used_g) || 0), 0)

    await supabaseAdmin.from('slice_job')
      .update({ status: 'done', result_url: url, result_meta: meta as Record<string, unknown>, finished_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'running')

    // versão: arquivo fatiado + números reais (pesos por filamento preservam a
    // cor/material que o usuário já definiu; só o peso vem do slicer)
    const { data: vd } = await supabaseAdmin.from('product_dev_version')
      .select('id, product_dev_id, filaments').eq('id', job.version_id).maybeSingle()
    const ver = vd as { id: string; product_dev_id: string | null; filaments: Array<{ material?: string | null; color?: string | null; weight_g?: number | null }> | null } | null
    const patch: Record<string, unknown> = { sliced_file_url: url }
    if (minutes) patch.print_time_minutes = minutes
    if (grams > 0) {
      patch.weight_g = Math.round(grams * 100) / 100
      const used = (meta.filaments ?? []).map(f => Number(f.used_g) || 0)
      const cur = Array.isArray(ver?.filaments) ? ver!.filaments! : []
      patch.filaments = used.map((g, i) => ({
        material: cur[i]?.material ?? null, color: cur[i]?.color ?? null, weight_g: Math.round(g * 100) / 100,
      }))
    }
    await supabaseAdmin.from('product_dev_version').update(patch).eq('id', job.version_id)

    if (ver?.product_dev_id) await supabaseAdmin.from('product_dev_event').insert({
      organization_id: job.organization_id, product_dev_id: ver.product_dev_id, event_type: 'version_sliced',
      payload: { version_id: job.version_id, slice_job_id: job.id, print_time_minutes: minutes, weight_g: grams || null }, is_auto: true,
    }).then(() => {}, () => {})

    this.logger.log(`[slice] job ${job.id.slice(0, 8)} concluído (${minutes ?? '?'}min, ${grams ? grams.toFixed(1) + 'g' : '?g'})`)
    return { ok: true }
  }
}
