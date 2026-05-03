import http from 'node:http'
import type { BaileysManager } from './whatsapp/baileys.manager.js'
import type { OutboundContent } from './whatsapp/baileys.session.js'

/**
 * HTTP server interno do worker. Existe pra a API NestJS conseguir
 * pedir envio de mensagens via Baileys — porque o socket WebSocket vive
 * em memória aqui, não na API.
 *
 * Endpoints:
 *   GET /internal/health  (sem auth)
 *
 *   POST /internal/baileys/send
 *     Headers: X-Internal-Key: <INTERNAL_API_KEY>
 *     Body: { channel_id, to, content_type, content }
 *
 *   POST /internal/baileys/check-number
 *     Headers: X-Internal-Key: <INTERNAL_API_KEY>
 *     Body: { org_id, phone }
 *
 * Usa só `node:http` builtin — sem Express/Fastify pra manter o worker leve.
 */
export class InternalServer {
  private server: http.Server | null = null

  constructor(
    private readonly manager: BaileysManager,
    private readonly options: { port: number; secret: string },
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[internal-server] handler erro:', err)
        if (!res.headersSent) {
          this.json(res, 500, { error: 'internal', detail: String(err) })
        }
      })
    })

    // Em dev: bind 127.0.0.1 (loopback) — não expor publicamente.
    // Em Railway/prod: bind 0.0.0.0 — API service alcança via private networking
    // (`http://workers.railway.internal:3030`). Auth via X-Internal-Key.
    const bindHost = process.env.WORKER_INTERNAL_BIND ?? '127.0.0.1'
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.options.port, bindHost, () => {
        // eslint-disable-next-line no-console
        console.log(`[internal-server] ouvindo em http://${bindHost}:${this.options.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve())
    })
    this.server = null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/'

    if (req.method === 'GET' && url === '/internal/health') {
      this.json(res, 200, { ok: true, sessions: this.manager.sessionCount })
      return
    }

    if (!this.checkAuth(req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'POST' && url === '/internal/baileys/send') {
      await this.handleSend(req, res)
      return
    }

    if (req.method === 'POST' && url === '/internal/baileys/check-number') {
      await this.handleCheckNumber(req, res)
      return
    }

    this.json(res, 404, { error: 'not_found' })
  }

  private async handleCheckNumber(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: CheckNumberBody
    try {
      body = await this.parseJsonBody<CheckNumberBody>(req)
    } catch (err) {
      this.json(res, 400, { error: 'invalid_json', detail: String(err) })
      return
    }

    if (!body || typeof body.org_id !== 'string' || typeof body.phone !== 'string') {
      this.json(res, 400, { error: 'invalid_body', detail: 'org_id e phone são obrigatórios' })
      return
    }

    try {
      const result = await this.manager.checkNumber(body.org_id, body.phone)
      this.json(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('no_active_session')) {
        this.json(res, 503, { error: 'no_active_session', detail: message })
      } else {
        // eslint-disable-next-line no-console
        console.error('[internal-server] checkNumber falhou:', err)
        this.json(res, 500, { error: 'check_failed', detail: message })
      }
    }
  }

  private async handleSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: SendBody
    try {
      body = await this.parseJsonBody<SendBody>(req)
    } catch (err) {
      this.json(res, 400, { error: 'invalid_json', detail: String(err) })
      return
    }

    if (!body || typeof body.channel_id !== 'string' || typeof body.to !== 'string') {
      this.json(res, 400, { error: 'invalid_body', detail: 'channel_id e to são obrigatórios' })
      return
    }

    const content = normalizeContent(body.content_type, body.content)
    if (!content) {
      this.json(res, 400, {
        error: 'unsupported_content',
        detail: `content_type=${body.content_type} ou shape do content inválido`,
      })
      return
    }

    try {
      const result = await this.manager.sendMessage(body.channel_id, body.to, content)
      this.json(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('channel_not_found')) {
        this.json(res, 404, { error: 'channel_not_found', detail: message })
      } else if (message.startsWith('session_not_ready')) {
        this.json(res, 503, { error: 'session_not_ready', detail: message })
      } else if (message.startsWith('session_terminated')) {
        this.json(res, 503, { error: 'session_terminated', detail: message })
      } else {
        // eslint-disable-next-line no-console
        console.error('[internal-server] sendMessage falhou:', err)
        this.json(res, 500, { error: 'send_failed', detail: message })
      }
    }
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers['x-internal-key']
    const provided = Array.isArray(header) ? header[0] : header
    return typeof provided === 'string' && provided === this.options.secret
  }

  private async parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf-8')
    if (!raw) return {} as T
    return JSON.parse(raw) as T
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

interface SendBody {
  channel_id: string
  /** Telefone internacional sem `+` (ex: 5571999999999) ou JID completo. */
  to: string
  content_type: 'text' | 'image' | 'audio' | 'video' | 'document'
  content: Record<string, unknown>
}

interface CheckNumberBody {
  org_id: string
  phone: string
}

function normalizeContent(
  contentType: SendBody['content_type'],
  content: Record<string, unknown> | null | undefined,
): OutboundContent | null {
  if (!content || typeof content !== 'object') return null
  const c = content as Record<string, unknown>

  switch (contentType) {
    case 'text':
      return typeof c.body === 'string' ? { kind: 'text', body: c.body } : null
    case 'image':
      return typeof c.url === 'string'
        ? {
            kind: 'image',
            url: c.url,
            ...(typeof c.caption === 'string' ? { caption: c.caption } : {}),
          }
        : null
    case 'audio':
      return typeof c.url === 'string'
        ? {
            kind: 'audio',
            url: c.url,
            ...(typeof c.mime_type === 'string' ? { mime_type: c.mime_type } : {}),
            ...(typeof c.ptt === 'boolean' ? { ptt: c.ptt } : {}),
          }
        : null
    case 'video':
      return typeof c.url === 'string'
        ? {
            kind: 'video',
            url: c.url,
            ...(typeof c.caption === 'string' ? { caption: c.caption } : {}),
          }
        : null
    case 'document':
      return typeof c.url === 'string'
        ? {
            kind: 'document',
            url: c.url,
            ...(typeof c.filename === 'string' ? { filename: c.filename } : {}),
            ...(typeof c.mime_type === 'string' ? { mime_type: c.mime_type } : {}),
          }
        : null
    default:
      return null
  }
}
