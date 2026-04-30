import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import type { ImageFormat } from '../ai/types'

const BUCKET = 'campaign-assets'
const FORMAT_DIMS: Record<Exclude<ImageFormat, 'custom'>, { width: number; height: number }> = {
  square_1080:     { width: 1080, height: 1080 },
  story_1080x1920: { width: 1080, height: 1920 },
  feed_1080x1350:  { width: 1080, height: 1350 },
}

export interface SavedAsset {
  id:           string
  storage_path: string
  storage_url:  string
  width:        number
  height:       number
  provider:     string
  model:        string
  cost_usd:     number
}

/** Sprint F5-2 — orquestra storage de imagens geradas + cron de limpeza.
 *
 * ⚠️ Bucket "campaign-assets" precisa existir no Supabase Storage
 * (criar via dashboard ou via API antes de testar). */
@Injectable()
export class CampaignAssetsService {
  private readonly logger = new Logger(CampaignAssetsService.name)

  /** Faz download da URL da imagem gerada (OpenAI), upload pro Supabase
   * Storage, insere row em campaign_assets. Retorna metadados pro frontend. */
  async saveGeneratedImage(input: {
    orgId:           string
    campaignId?:     string | null
    imageSourceUrl?: string         // se já é URL pública
    imageBase64?:    string         // se vier b64_json
    format:          ImageFormat
    customSize?:     { width: number; height: number }
    provider:        string
    model:           string
    prompt:          string
    sourceImageUrl?: string         // referência da base original
    costUsd:         number
  }): Promise<SavedAsset> {
    if (!input.imageSourceUrl && !input.imageBase64) {
      throw new BadRequestException('imageSourceUrl ou imageBase64 obrigatório')
    }

    const dims = input.format === 'custom'
      ? (input.customSize ?? { width: 1024, height: 1024 })
      : FORMAT_DIMS[input.format]

    // Download bytes
    let buffer: Buffer
    if (input.imageBase64) {
      buffer = Buffer.from(input.imageBase64, 'base64')
    } else {
      const res = await axios.get<ArrayBuffer>(input.imageSourceUrl!, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      })
      buffer = Buffer.from(res.data)
    }

    // Upload pro Supabase Storage
    const assetId = randomUUID()
    const path = `${input.orgId}/${input.campaignId ?? 'draft'}/${assetId}.png`
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: 'image/png',
        upsert:      false,
      })
    if (upErr) {
      throw new BadRequestException(`Upload Storage falhou: ${upErr.message}`)
    }

    // Public URL (bucket é público nesta sprint)
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path)
    const storageUrl = pub.publicUrl

    // INSERT em campaign_assets — expira em 30d se não aprovada
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const { data, error: dbErr } = await supabaseAdmin
      .from('campaign_assets')
      .insert({
        id:               assetId,
        organization_id:  input.orgId,
        campaign_id:      input.campaignId ?? null,
        type:             'image',
        format:           input.format,
        width:            dims.width,
        height:           dims.height,
        storage_path:     path,
        storage_url:      storageUrl,
        provider:         input.provider,
        model:            input.model,
        prompt:           input.prompt,
        source_image_url: input.sourceImageUrl ?? null,
        cost_usd:         input.costUsd,
        approved:         false,
        expires_at:       expiresAt,
      })
      .select('id')
      .single()
    if (dbErr) {
      // Rollback storage upload
      await supabaseAdmin.storage.from(BUCKET).remove([path]).catch(() => null)
      throw new BadRequestException(`Insert campaign_assets falhou: ${dbErr.message}`)
    }

    return {
      id:           data!.id as string,
      storage_path: path,
      storage_url:  storageUrl,
      width:        dims.width,
      height:       dims.height,
      provider:     input.provider,
      model:        input.model,
      cost_usd:     input.costUsd,
    }
  }

  /** Aprovar asset → expires_at=NULL, approved=true. Vincula campaign_id se passado. */
  async approve(orgId: string, assetId: string, campaignId?: string | null): Promise<{ ok: true }> {
    const update: Record<string, unknown> = {
      approved:    true,
      approved_at: new Date().toISOString(),
      expires_at:  null,
    }
    if (campaignId) update.campaign_id = campaignId

    const { error } = await supabaseAdmin
      .from('campaign_assets')
      .update(update)
      .eq('id', assetId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  /** Busca um asset com checagem de org. */
  async getOne(orgId: string, assetId: string) {
    const { data, error } = await supabaseAdmin
      .from('campaign_assets')
      .select('*')
      .eq('id', assetId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new BadRequestException('Asset não encontrado')
    return data
  }

  // ── Cron de limpeza (3am diário) ─────────────────────────────────────────

  @Cron('0 3 * * *', { name: 'campaignAssetsCleanup' })
  async cleanupExpired(): Promise<void> {
    const now = new Date().toISOString()
    const { data: expired, error } = await supabaseAdmin
      .from('campaign_assets')
      .select('id, storage_path')
      .not('expires_at', 'is', null)
      .lte('expires_at', now)
      .limit(1000)

    if (error) {
      this.logger.warn(`[campaign_assets.cron] fetch falhou: ${error.message}`)
      return
    }
    const rows = (expired ?? []) as Array<{ id: string; storage_path: string }>
    if (rows.length === 0) return

    // Batch delete do Storage
    const paths = rows.map(r => r.storage_path)
    const { error: stErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths)
    if (stErr) this.logger.warn(`[campaign_assets.cron] storage remove falhou: ${stErr.message}`)

    // Batch delete do DB
    const ids = rows.map(r => r.id)
    const { error: delErr } = await supabaseAdmin.from('campaign_assets').delete().in('id', ids)
    if (delErr) this.logger.warn(`[campaign_assets.cron] db delete falhou: ${delErr.message}`)
    else        this.logger.log(`[campaign_assets.cron] limpou ${rows.length} assets expirados`)
  }
}
