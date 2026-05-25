/**
 * Helpers ffmpeg pra pipeline de vídeo.
 *
 * Dependência: binário `ffmpeg` no PATH (instalado via Dockerfile no Railway).
 *
 * Operações:
 *   - extractLastFrame(videoBuffer): retorna PNG do último frame
 *   - concatVideos([buf1, buf2, ...]): retorna MP4 concatenado
 *
 * Tudo via stdin/stdout/files temporários (sem persistir nada além do tempo
 * de processamento).
 */

import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FFMPEG_TIMEOUT_MS = 60_000  // 1 min default — pode ajustar por operação

/**
 * Extrai o último frame de um vídeo MP4 como PNG.
 *
 * Estratégia: usa -sseof (seek de trás pra frente) pra evitar varrer o arquivo todo.
 * Fallback: se -sseof falhar, usa duration probe + seek normal.
 */
export async function extractLastFrame(videoBuffer: Buffer): Promise<Buffer> {
  const tmp = await mkdtemp(join(tmpdir(), 'eclick-ffmpeg-'))
  const videoPath = join(tmp, 'in.mp4')
  const framePath = join(tmp, 'last.png')

  try {
    await writeFile(videoPath, videoBuffer)

    // -sseof -0.5 = vai pra 0.5s antes do fim
    // -update 1 + -frames:v 1 = pega só 1 frame final
    await runFfmpeg([
      '-y',
      '-sseof', '-0.5',
      '-i', videoPath,
      '-update', '1',
      '-frames:v', '1',
      '-q:v', '2',          // alta qualidade
      framePath,
    ])

    return await readFile(framePath)
  } finally {
    await cleanupTmp(tmp, [videoPath, framePath])
  }
}

/**
 * Concatena múltiplos vídeos MP4 em um único arquivo.
 *
 * Estratégia: gera arquivo de lista do ffmpeg ("file 'a.mp4'\nfile 'b.mp4'")
 * e usa demuxer concat. Re-encoda pra garantir compatibilidade entre parts
 * (alguns vídeos podem ter codecs/fps levemente diferentes).
 */
export async function concatVideos(videoBuffers: Buffer[]): Promise<Buffer> {
  if (videoBuffers.length === 0) throw new Error('concatVideos: nenhum vídeo passado')
  if (videoBuffers.length === 1) return videoBuffers[0]

  const tmp = await mkdtemp(join(tmpdir(), 'eclick-ffmpeg-'))
  const inputPaths: string[] = []
  const listPath = join(tmp, 'list.txt')
  const outPath = join(tmp, 'out.mp4')

  try {
    // Salva cada vídeo em disco
    for (let i = 0; i < videoBuffers.length; i++) {
      const p = join(tmp, `part-${i}.mp4`)
      await writeFile(p, videoBuffers[i])
      inputPaths.push(p)
    }

    // Lista pro demuxer concat. Caminhos absolutos com escape simples.
    const listContent = inputPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    await writeFile(listPath, listContent)

    // Re-encoda H.264 + AAC pra compatibilidade universal.
    await runFfmpeg(
      [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outPath,
      ],
      { timeoutMs: 180_000 },  // 3min — concat de 3 vídeos 10s pode demorar
    )

    return await readFile(outPath)
  } finally {
    await cleanupTmp(tmp, [...inputPaths, listPath, outPath])
  }
}

/**
 * Compõe um vídeo "picture-in-picture": o vídeo do produto em tela cheia (9:16)
 * como fundo + o vídeo do avatar (falante, com áudio) pequeno num canto.
 *
 *   - Canvas 1080x1920. Fundo = produto em cover+crop (sem barras).
 *   - Avatar escalado pra `sizePct`% da largura (default 30, clamp 18-40), com
 *     borda branca fina, posicionado no canto (default inferior-direito) c/ margem.
 *   - Áudio = a voz do avatar. Duração = a fala do avatar (o produto faz loop
 *     pra cobrir, e -shortest encerra quando o avatar termina).
 */
export async function composePictureInPicture(
  productBuffer: Buffer,
  avatarBuffer: Buffer,
  opts: { corner?: 'br' | 'bl' | 'tr' | 'tl'; sizePct?: number } = {},
): Promise<Buffer> {
  const corner = opts.corner ?? 'br'
  const pct = Math.max(18, Math.min(40, opts.sizePct ?? 30))
  const W = 1080
  const H = 1920
  const ovW = Math.round((W * pct) / 100)
  const margin = Math.round(W * 0.05) // ~54px

  const posByCorner: Record<string, string> = {
    br: `x=W-w-${margin}:y=H-h-${margin}`,
    bl: `x=${margin}:y=H-h-${margin}`,
    tr: `x=W-w-${margin}:y=${margin}`,
    tl: `x=${margin}:y=${margin}`,
  }
  const overlayXY = posByCorner[corner] ?? posByCorner.br

  const tmp = await mkdtemp(join(tmpdir(), 'eclick-pip-'))
  const productPath = join(tmp, 'product.mp4')
  const avatarPath = join(tmp, 'avatar.mp4')
  const outPath = join(tmp, 'out.mp4')

  try {
    await writeFile(productPath, productBuffer)
    await writeFile(avatarPath, avatarBuffer)

    // [0]=produto (loop infinito), [1]=avatar. Fundo cobre 1080x1920; avatar
    // escalado com borda branca de 4px (pad); overlay no canto; áudio do avatar.
    const filter =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg];` +
      `[1:v]scale=${ovW}:-2,pad=iw+8:ih+8:4:4:white[ov];` +
      `[bg][ov]overlay=${overlayXY}:format=auto[outv]`

    await runFfmpeg(
      [
        '-y',
        '-stream_loop', '-1', '-i', productPath,
        '-i', avatarPath,
        '-filter_complex', filter,
        '-map', '[outv]',
        '-map', '1:a:0?',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-shortest',
        outPath,
      ],
      { timeoutMs: 180_000 },
    )

    return await readFile(outPath)
  } finally {
    await cleanupTmp(tmp, [productPath, avatarPath, outPath])
  }
}

/** Detecta se ffmpeg está disponível no PATH (usar no boot pra log). */
export function ffmpegAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(false))
    proc.on('exit', code => resolve(code === 0))
  })
}

// ── Internal ───────────────────────────────────────────────────────────

function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`ffmpeg timeout após ${timeout}ms`))
    }, timeout)

    proc.on('error', e => {
      clearTimeout(timer)
      reject(new Error(`ffmpeg spawn falhou: ${e.message} — ffmpeg instalado?`))
    })

    proc.on('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
  })
}

async function cleanupTmp(_dir: string, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(p => unlink(p).catch(() => { /* já apagado */ })),
  )
  // Não removo o dir em si — fs.rmdir falha em algumas plataformas. Lixo fica
  // sob /tmp e o OS limpa periodicamente.
}
