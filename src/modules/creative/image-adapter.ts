/**
 * Image adapter — adapta imagem source pro aspect alvo do vídeo.
 *
 * Providers de vídeo (Kling no image2video, Veo no Vertex) herdam o aspect
 * da source image — ignoram o param `aspect_ratio`. Pra produzir vídeos
 * em proporção diferente da imagem original, recortamos antes de submeter.
 *
 * Estratégia: center-crop (mantém o centro, descarta as bordas que sobram).
 * Funciona bem pra cenas onde o produto está centralizado.
 *
 * Não usa AI inpainting (mais caro, lento) — pra ESTENDER a cena via IA,
 * usar Nano Banana com prompt "estende esta cena verticalmente" em fluxo
 * separado.
 */

import { Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { CreativeService } from './creative.service'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as typeof import('sharp')

export type TargetAspect = '1:1' | '16:9' | '9:16'

const ASPECT_RATIOS: Record<TargetAspect, number> = {
  '1:1':  1.0,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
}

/** Tolerância de match: se imagem já tá dentro de 1% do aspect alvo,
 *  não vale a pena gastar I/O com crop — retorna URL original. */
const ASPECT_TOLERANCE = 0.01

export interface AdaptImageArgs {
  /** URL signed (com TTL >= 30s) da imagem original. */
  sourceUrl:    string
  /** Aspect alvo do vídeo. */
  targetAspect: TargetAspect
  /** Identificadores pra organizar a key no bucket. */
  orgId:        string
  productId:    string
  videoId:      string
  /** CreativeService pra assinar a URL final. */
  creative:     CreativeService
  logger?:      Logger
}

/**
 * Adapta imagem source pro aspect alvo do vídeo via center-crop.
 *
 * - Se imagem já bate com aspect (±1%) → retorna URL original
 * - Senão → baixa, crop centralizado, upload em
 *   `{org}/{product}/videos/sources/{videoId}.jpg`, retorna URL assinada
 *
 * @returns URL assinada pronta pra mandar pro provider de vídeo
 */
export async function adaptImageForVideo(args: AdaptImageArgs): Promise<string> {
  const { sourceUrl, targetAspect, orgId, productId, videoId, creative, logger } = args

  const target = ASPECT_RATIOS[targetAspect]

  // 1. Download
  const res = await axios.get<ArrayBuffer>(sourceUrl, {
    responseType:     'arraybuffer',
    timeout:          30_000,
    maxContentLength: 20 * 1024 * 1024,
  })
  const buf = Buffer.from(res.data)

  // 2. Read dimensions
  const meta = await sharp(buf).metadata()
  if (!meta.width || !meta.height) {
    throw new Error('sharp: imagem sem dimensões legíveis')
  }
  const actual = meta.width / meta.height

  // 3. Skip se já bate
  if (Math.abs(actual - target) / target < ASPECT_TOLERANCE) {
    logger?.log(`[image-adapter] ${meta.width}x${meta.height} já é ${targetAspect}, sem crop`)
    return sourceUrl
  }

  // 4. Calcula crop centralizado
  let cropWidth: number
  let cropHeight: number
  let left: number
  let top: number
  if (actual > target) {
    // Imagem mais larga que alvo → corta os lados (mantém altura)
    cropHeight = meta.height
    cropWidth  = Math.round(meta.height * target)
    left = Math.round((meta.width - cropWidth) / 2)
    top  = 0
  } else {
    // Imagem mais alta que alvo → corta topo e base (mantém largura)
    cropWidth  = meta.width
    cropHeight = Math.round(meta.width / target)
    left = 0
    top  = Math.round((meta.height - cropHeight) / 2)
  }

  const cropped = await sharp(buf)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 92 })
    .toBuffer()

  // 5. Upload na pasta de sources do vídeo
  const storagePath = `${orgId}/${productId}/videos/sources/${videoId}.jpg`
  const { error } = await supabaseAdmin.storage
    .from('creative')
    .upload(storagePath, cropped, {
      contentType:  'image/jpeg',
      upsert:       true,
      cacheControl: '3600',
    })
  if (error) throw new Error(`image-adapter.upload: ${error.message}`)

  logger?.log(
    `[image-adapter] crop ${meta.width}x${meta.height}(${actual.toFixed(2)}) → ` +
    `${cropWidth}x${cropHeight}(${targetAspect}) saved=${storagePath}`,
  )

  // 6. Assina URL final
  return creative.signImage(storagePath, 600)
}
