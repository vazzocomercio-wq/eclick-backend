import {
  WebSocketGateway, WebSocketServer,
  OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import { Namespace, Socket } from 'socket.io'
import { createClient } from '@supabase/supabase-js'

/**
 * Gateway Socket.IO em namespace `/events`.
 *
 * Cliente conecta com `auth: { token: <supabase access_token> }`. Gateway
 * resolve user → org via service_role e dá join na room `org:{orgId}`.
 *
 * Worker NÃO conecta direto — chama POST /internal/realtime no API que
 * delega aqui em emitToOrg().
 *
 * Bug #4 Active: this.server quando declarado com namespace é Namespace,
 * NÃO Server. Acessar adapter via `(server as any).adapter`, sem
 * `.sockets.adapter`. Tipos do socket.io 4.x não expõem isso de forma
 * idiomática — cast inevitável.
 */
@WebSocketGateway({ namespace: '/events', cors: { origin: '*' } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name)

  @WebSocketServer()
  private server!: Namespace

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = (client.handshake.auth?.token as string | undefined)
        ?? (client.handshake.headers.authorization as string | undefined)?.replace(/^Bearer\s+/i, '')

      if (!token) {
        client.emit('error', { message: 'token ausente' })
        client.disconnect(true)
        return
      }

      const url = process.env.SUPABASE_URL
      const anon = process.env.SUPABASE_ANON_KEY
      if (!url || !anon) {
        this.logger.error('[connect] SUPABASE_URL/ANON_KEY ausentes')
        client.disconnect(true)
        return
      }

      // Resolver user via JWT (anon key + access_token)
      const sb = createClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      })
      const { data: userData } = await sb.auth.getUser()
      const userId = userData?.user?.id
      if (!userId) {
        client.emit('error', { message: 'token inválido' })
        client.disconnect(true)
        return
      }

      // Resolver orgId via organization_members
      const { data: member } = await sb
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle()

      const orgId = member?.organization_id as string | undefined
      if (!orgId) {
        client.emit('error', { message: 'usuário sem organização' })
        client.disconnect(true)
        return
      }

      void client.join(`org:${orgId}`)
      client.data.userId = userId
      client.data.orgId = orgId
      this.logger.log(`[connect] user=${userId} org=${orgId} sid=${client.id}`)
      client.emit('ready', { orgId })
    } catch (err) {
      this.logger.error(`[connect] erro: ${err instanceof Error ? err.message : String(err)}`)
      client.disconnect(true)
    }
  }

  handleDisconnect(client: Socket): void {
    const orgId = client.data?.orgId as string | undefined
    if (orgId) this.logger.log(`[disconnect] org=${orgId} sid=${client.id}`)
  }

  /**
   * Emite evento pra todos os sockets da org. Usado pelo InternalController
   * quando recebe broadcast do worker.
   */
  emitToOrg(orgId: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(`[emit] server ainda não inicializado — event=${event} org=${orgId} dropado`)
      return
    }
    const room = `org:${orgId}`
    // Bug #4: usar (server as any).adapter, NÃO server.sockets.adapter
    const size = (this.server as unknown as { adapter?: { rooms?: Map<string, Set<string>> } })
      .adapter?.rooms?.get(room)?.size ?? 0
    this.server.to(room).emit(event, payload)
    this.logger.log(`[emit] event=${event} org=${orgId} listeners=${size}`)
  }
}
