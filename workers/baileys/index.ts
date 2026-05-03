import express, { Request, Response, NextFunction } from 'express'
import { BaileysManager } from './baileys.manager'

const PORT = parseInt(process.env.WORKER_INTERNAL_PORT ?? '3030', 10)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY

if (!INTERNAL_API_KEY) {
  console.error('[baileys-worker] INTERNAL_API_KEY ausente — abortando')
  process.exit(1)
}

const manager = new BaileysManager()
const app = express()
app.use(express.json({ limit: '1mb' }))

// ── Auth middleware ─────────────────────────────────────────────────────

function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  if (req.headers['x-internal-key'] !== INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

// ── Health (Railway healthcheck) ────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: manager['sessions']?.size ?? 0 })
})

// ── Internal endpoints (chamados pela API NestJS) ───────────────────────

app.post('/internal/baileys/create-session', requireInternalKey, async (req, res) => {
  try {
    const orgId = req.body?.orgId
    if (!orgId) { res.status(400).json({ error: 'orgId obrigatório' }); return }
    await manager.createSession(orgId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.post('/internal/baileys/disconnect', requireInternalKey, async (req, res) => {
  try {
    const orgId = req.body?.orgId
    if (!orgId) { res.status(400).json({ error: 'orgId obrigatório' }); return }
    await manager.destroySession(orgId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/internal/baileys/status/:orgId', requireInternalKey, (req, res) => {
  const orgId = String(req.params.orgId)
  const status = manager.getStatus(orgId)
  res.json({ orgId, in_memory_status: status, has_session: manager.hasSession(orgId) })
})

// ── Boot ────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[baileys-worker] rodando na porta ${PORT}`)

  // Restaura sessões ativas no boot (single-shot)
  manager.restoreActiveSessions().catch(e => {
    console.error('[baileys-worker] restoreActiveSessions falhou:', e)
  })

  // Safety net: reconcile a cada 60s
  setInterval(() => {
    manager.reconcile().catch(e => {
      console.error('[baileys-worker] reconcile falhou:', e)
    })
  }, 60_000)
})

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`[baileys-worker] ${signal} recebido — encerrando`)
  server.close(() => process.exit(0))
  // Hard exit após 10s caso o close trave
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
