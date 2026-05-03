/**
 * Cliente HTTP minimal pro endpoint POST /internal/realtime do API NestJS.
 * Usado pelo worker pra emitir broadcasts (whatsapp:qr, whatsapp:connected,
 * whatsapp:disconnected, message:new) sem manter conexão socket própria.
 *
 * INTERNAL_API_URL no SaaS = https://api.eclick.app.br (NÃO api.active.*).
 *
 * Falhas de rede aqui são best-effort: logamos e seguimos a vida.
 */

interface BroadcastInput {
  org_id: string
  event:
    | 'whatsapp:qr'
    | 'whatsapp:connected'
    | 'whatsapp:disconnected'
    | 'message:new'
  payload: unknown
}

export async function broadcastRealtime(input: BroadcastInput): Promise<boolean> {
  const url = process.env.INTERNAL_API_URL
  const key = process.env.INTERNAL_API_KEY
  if (!url || !key) {
    // eslint-disable-next-line no-console
    console.warn(
      `[internal-api] env ausente: INTERNAL_API_URL=${!!url} INTERNAL_API_KEY=${!!key} — broadcast event=${input.event} descartado`,
    )
    return false
  }

  try {
    // eslint-disable-next-line no-console
    console.log(
      `[internal-api] → POST ${url}/internal/realtime event=${input.event} org=${input.org_id}`,
    )
    const res = await fetch(`${url}/internal/realtime`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': key,
      },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.warn(
        `[internal-api] broadcast event=${input.event} falhou: ${res.status} ${res.statusText} body=${body.slice(0, 200)}`,
      )
      return false
    }
    // eslint-disable-next-line no-console
    console.log(`[internal-api] ✓ broadcast event=${input.event} OK`)
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[internal-api] broadcast event=${input.event} erro: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}
