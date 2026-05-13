/**
 * Interface comum pra provedores de vídeo (Kling, Flow/Veo, futuros).
 *
 * Cada provider implementa essa interface. O pipeline escolhe qual usar
 * baseado em config (provider key no job) ou default.
 *
 * Convenções:
 *   - imageUrl / lastFrameUrl: signed URLs públicas (TTL >= 30min)
 *   - duration: int segundos (5, 10, etc) — provider valida o que aceita
 *   - todos métodos podem lançar HttpException com mensagem amigável
 */

export type VideoQuality = 'standard' | 'premium' | 'audio-native' | 'fast' | 'economy'
export type VideoAspectRatio = '1:1' | '16:9' | '9:16'

export interface VideoModelOption {
  /** ID interno do modelo no provider (ex: 'kling-v2-6', 'veo-3.1') */
  id:           string
  /** Nome amigável pra UI */
  label:        string
  /** Badge curta (ex: "Novo · com áudio") */
  badge?:       string
  /** Provider que oferece esse modelo */
  provider:     'kling' | 'flow'
  /** Categoria pra UI agrupar */
  quality:      VideoQuality
  /** Suporta áudio nativo? */
  hasAudio:     boolean
  /** Durações suportadas em segundos */
  supportedDurations: number[]
  /** Suporta input de último frame (tail_image / lastFrame) nativamente? */
  supportsTailImage: boolean
  /** Preço em USD por duração (chave = duração em segundos). */
  pricing:      Record<number, number>
}

export interface VideoSubmitInput {
  /** Imagem inicial (signed URL). */
  imageUrl:        string
  /** Último frame opcional (signed URL) — usado em encadeamento perfeito.
   *  Provider que não suportar (Kling) ignora e usa apenas imageUrl. */
  lastFrameUrl?:   string
  prompt:          string
  negativePrompt?: string
  duration:        number               // segundos
  aspectRatio:     VideoAspectRatio
  modelId:         string
  /** Cfg scale 0-1, default 0.5. */
  cfgScale?:       number
  /** Movimento de câmera. Implementação específica por provider. */
  cameraMotion?:   {
    /** Tipo: dolly forward (zoom in) = padrão pra ads de produto. */
    type:     'dolly-in' | 'dolly-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'orbit' | 'static'
    /** Intensidade 0-1 (provider mapeia pra seus valores nativos). */
    intensity?: number
  }
  /** Metadados que o provider pode usar (ex: enable_audio=true pra Veo). */
  options?:        Record<string, unknown>
}

export interface VideoTaskStatus {
  taskId:     string
  status:     'submitted' | 'processing' | 'succeed' | 'failed'
  statusMsg?: string
  /** URL pra baixar quando succeed. Expira ~24h. */
  videoUrl?:  string
  /** Duration real do vídeo gerado (provider pode arredondar). */
  durationSec?: number
}

export interface VideoProvider {
  /** Nome canônico do provider — usado em DB pra rastrear qual gerou. */
  readonly key: 'kling' | 'flow'

  /** Lista de modelos disponíveis (UI usa pra dropdown). */
  listModels(): VideoModelOption[]

  /** Submete um job. Retorna taskId pra polling. */
  submit(input: VideoSubmitInput): Promise<{ taskId: string }>

  /** Pollea status do job. */
  pollStatus(taskId: string): Promise<VideoTaskStatus>

  /** Baixa o vídeo gerado (Buffer MP4). */
  download(url: string): Promise<Buffer>

  /** Estima custo em USD pra esse modelo + duração. */
  estimateCost(modelId: string, duration: number): number

  /** Indica se o provider está corretamente configurado (envs setadas). */
  isConfigured(): boolean
}
