import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Conector D-ID (avatar falante) pro Influenciador IA do Social Commerce AI.
 * Alternativa barata ao Creatify pra ter um "rosto" apresentando o produto.
 *
 * Gated por `DID_API_KEY` (chave do D-ID Studio → Settings → API Keys).
 * Se a chave não estiver setada, tudo retorna "não configurado" — não quebra
 * nada do que já existe.
 *
 * Fluxo: POST /talks (source_url=foto do apresentador + script falado + voz) →
 * GET /talks/{id} até status=done → espelha o mp4 pro bucket público
 * `storefront-assets` (URL https estável, igual aos reels).
 *
 * Doc: https://docs.d-id.com/reference/createtalk
 */

const DID_BASE = 'https://api.d-id.com'
const PUBLIC_BUCKET = 'storefront-assets'
const DEFAULT_VOICE = 'pt-BR-FranciscaNeural'

export interface StartAvatarDto {
  /** Texto que o avatar vai falar (roteiro). */
  script: string
  /** Foto do apresentador (https, rosto visível). Sem isso, usa o padrão do D-ID. */
  presenter_image_url?: string
  /** Voz Microsoft (ex: pt-BR-FranciscaNeural / pt-BR-AntonioNeural). */
  voice_id?: string
  /** Nome amigável (debug). */
  name?: string
}

export interface AvatarStatus {
  status: 'generating' | 'completed' | 'failed'
  public_url: string | null
  error: string | null
}

@Injectable()
export class DidAvatarService {
  private readonly log = new Logger(DidAvatarService.name)

  isConfigured(): boolean {
    return !!process.env.DID_API_KEY
  }

  private authHeader(): string {
    // A chave do D-ID Studio já vem pronta pra Basic. Se vier "email:senha",
    // o operador deve base64 antes de setar. Aceitamos os dois: se tiver ':',
    // base64-amos aqui.
    const key = (process.env.DID_API_KEY ?? '').trim()
    if (key.includes(':')) return `Basic ${Buffer.from(key).toString('base64')}`
    return `Basic ${key}`
  }

  /** Valida a chave (GET /credits). */
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.isConfigured()) return { ok: false, detail: 'DID_API_KEY ausente' }
    try {
      const res = await fetch(`${DID_BASE}/credits`, {
        headers: { Authorization: this.authHeader(), accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  /** Cria um talk; devolve o id como job_id. */
  async startAvatarVideo(dto: StartAvatarDto): Promise<{ job_id: string }> {
    if (!this.isConfigured()) {
      throw new BadRequestException('D-ID não configurado (defina DID_API_KEY)')
    }
    if (!dto.script?.trim()) throw new BadRequestException('script obrigatório')
    const body: Record<string, unknown> = {
      script: {
        type: 'text',
        input: dto.script.slice(0, 3500),
        provider: { type: 'microsoft', voice_id: dto.voice_id || DEFAULT_VOICE },
      },
      config: { stitch: true },
      name: dto.name?.slice(0, 80),
    }
    if (dto.presenter_image_url) body.source_url = dto.presenter_image_url

    const res = await fetch(`${DID_BASE}/talks`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      this.log.warn(`D-ID createTalk ${res.status}: ${txt.slice(0, 200)}`)
      throw new BadRequestException(`D-ID recusou (HTTP ${res.status})`)
    }
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new BadRequestException('D-ID não retornou id')
    return { job_id: json.id }
  }

  /** Status do talk; quando done, espelha o mp4 pro bucket público. */
  async getAvatarVideo(orgId: string, jobId: string): Promise<AvatarStatus> {
    if (!this.isConfigured()) {
      return { status: 'failed', public_url: null, error: 'D-ID não configurado' }
    }
    try {
      const res = await fetch(`${DID_BASE}/talks/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: this.authHeader(), accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        return { status: 'failed', public_url: null, error: `HTTP ${res.status}` }
      }
      const json = (await res.json()) as {
        status?: string
        result_url?: string
        error?: { description?: string } | string
      }
      const st = json.status ?? 'unknown'
      if (st === 'done' && json.result_url) {
        const publicUrl = await this.mirror(orgId, jobId, json.result_url)
        return { status: 'completed', public_url: publicUrl, error: null }
      }
      if (st === 'error' || st === 'rejected') {
        const err =
          typeof json.error === 'string'
            ? json.error
            : (json.error?.description ?? 'D-ID falhou')
        return { status: 'failed', public_url: null, error: err }
      }
      return { status: 'generating', public_url: null, error: null }
    } catch (e) {
      return { status: 'failed', public_url: null, error: (e as Error).message }
    }
  }

  /** Baixa o mp4 do D-ID e sobe pro bucket público (URL https estável). */
  private async mirror(
    orgId: string,
    jobId: string,
    resultUrl: string,
  ): Promise<string | null> {
    try {
      const r = await fetch(resultUrl, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) return resultUrl
      const buf = Buffer.from(await r.arrayBuffer())
      const path = `${orgId}/avatars/${jobId}.mp4`
      const { error } = await supabaseAdmin.storage
        .from(PUBLIC_BUCKET)
        .upload(path, buf, { contentType: 'video/mp4', upsert: true })
      if (error) {
        this.log.warn(`mirror avatar falhou: ${error.message}`)
        return resultUrl
      }
      const { data } = supabaseAdmin.storage.from(PUBLIC_BUCKET).getPublicUrl(path)
      return data.publicUrl
    } catch (e) {
      this.log.warn(`mirror avatar erro: ${(e as Error).message}`)
      return resultUrl
    }
  }
}
