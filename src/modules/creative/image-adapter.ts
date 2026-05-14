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
  /** Quando provider exige dimensões EXATAS (ex: Sora 2 720x1280),
   *  força resize após crop. Sem isso só ajusta aspect. */
  targetWidth?:  number
  targetHeight?: number
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
  const { sourceUrl, targetAspect, orgId, productId, videoId, creative, logger, targetWidth, targetHeight } = args

  const target = ASPECT_RATIOS[targetAspect]
  const needsExactSize = !!(targetWidth && targetHeight)

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
  const aspectMatches = Math.abs(actual - target) / target < ASPECT_TOLERANCE

  // 3. Skip se aspect bate E provider não exige tamanho exato
  if (aspectMatches && !needsExactSize) {
    logger?.log(`[image-adapter] ${meta.width}x${meta.height} já é ${targetAspect}, sem crop`)
    return sourceUrl
  }
  // Se aspect bate mas precisa de tamanho exato, ainda pode pular o crop e ir direto pro resize
  if (aspectMatches && needsExactSize && meta.width === targetWidth && meta.height === targetHeight) {
    logger?.log(`[image-adapter] ${meta.width}x${meta.height} já é ${targetWidth}x${targetHeight}, sem mudança`)
    return sourceUrl
  }

  // 4. Calcula crop centralizado (sempre roda quando não bate aspect, ou pra normalizar antes do resize)
  let cropWidth: number
  let cropHeight: number
  let left: number
  let top: number
  if (actual > target) {
    cropHeight = meta.height
    cropWidth  = Math.round(meta.height * target)
    left = Math.round((meta.width - cropWidth) / 2)
    top  = 0
  } else if (actual < target) {
    cropWidth  = meta.width
    cropHeight = Math.round(meta.width / target)
    left = 0
    top  = Math.round((meta.height - cropHeight) / 2)
  } else {
    // Aspect bate, sem crop necessário — mas vai resize pra dimensões exatas
    cropWidth  = meta.width
    cropHeight = meta.height
    left = 0
    top  = 0
  }

  // 5. Pipeline sharp: extract → resize (se exigido) → jpeg
  let pipeline = sharp(buf).extract({ left, top, width: cropWidth, height: cropHeight })
  if (needsExactSize) {
    pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'fill' })
  }
  const finalBuf = await pipeline.jpeg({ quality: 92 }).toBuffer()

  // 6. Upload na pasta de sources do vídeo
  const storagePath = `${orgId}/${productId}/videos/sources/${videoId}.jpg`
  const { error } = await supabaseAdmin.storage
    .from('creative')
    .upload(storagePath, finalBuf, {
      contentType:  'image/jpeg',
      upsert:       true,
      cacheControl: '3600',
    })
  if (error) throw new Error(`image-adapter.upload: ${error.message}`)

  const finalDims = needsExactSize ? `${targetWidth}x${targetHeight}` : `${cropWidth}x${cropHeight}`
  logger?.log(
    `[image-adapter] ${meta.width}x${meta.height}(${actual.toFixed(2)}) → ` +
    `${finalDims}(${targetAspect}) saved=${storagePath}`,
  )

  // 7. Assina URL final
  return creative.signImage(storagePath, 600)
}
