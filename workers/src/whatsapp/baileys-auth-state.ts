import {
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  BufferJSON,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys'
import { getSupabase } from '../supabase.js'

/**
 * Persistência do auth state Baileys em `public.channels.credentials.baileys_auth`.
 *
 * Substitui `useMultiFileAuthState` (filesystem) por UPDATE no jsonb da row do canal.
 * Schema do jsonb:
 *
 *   credentials.baileys_auth = {
 *     creds: <AuthenticationCreds serializado com BufferJSON>,
 *     keys: {
 *       'pre-key':                { [id]: <SignalDataTypeMap['pre-key']> },
 *       'session':                { [id]: <SignalDataTypeMap['session']> },
 *       'sender-key':             { [id]: <...> },
 *       'app-state-sync-key':     { [id]: <...> },
 *       'app-state-sync-version': { [id]: <...> },
 *       'sender-key-memory':      { [id]: <...> },
 *     }
 *   }
 *
 * BufferJSON.replacer/reviver é OBRIGATÓRIO — JSON.stringify nativo perde
 * Buffer/Map binários (curve25519 keys) e a sessão quebra silenciosamente.
 */

type KeyType = keyof SignalDataTypeMap
type KeyMap = { [type in KeyType]?: { [id: string]: SignalDataTypeMap[type] | null } }

interface PersistedAuth {
  creds: AuthenticationCreds
  keys: KeyMap
}

export interface BaileysAuthHandle {
  state: AuthenticationState
  saveCreds: () => Promise<void>
  /** Limpa todo o auth state (usado em DisconnectReason.loggedOut). */
  clear: () => Promise<void>
}

export async function loadAuthState(channelId: string): Promise<BaileysAuthHandle> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('channels')
    .select('credentials')
    .eq('id', channelId)
    .maybeSingle()

  if (error) {
    throw new Error(`loadAuthState(${channelId}): ${error.message}`)
  }

  const stored = (data?.credentials as { baileys_auth?: unknown } | null)
    ?.baileys_auth as PersistedAuth | undefined

  const creds: AuthenticationCreds = stored?.creds
    ? (JSON.parse(JSON.stringify(stored.creds), BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds()

  const keys: KeyMap = stored?.keys
    ? (JSON.parse(JSON.stringify(stored.keys), BufferJSON.reviver) as KeyMap)
    : {}

  // Persiste o jsonb inteiro (replace). KeyMap em memória JÁ é o estado completo.
  async function persist(): Promise<void> {
    const serialized: PersistedAuth = JSON.parse(
      JSON.stringify({ creds, keys }, BufferJSON.replacer),
    ) as PersistedAuth

    // Mescla baileys_auth no credentials existente (não sobrescreve outros campos).
    const { data: row } = await supabase
      .from('channels')
      .select('credentials')
      .eq('id', channelId)
      .maybeSingle()

    const current =
      ((row?.credentials as Record<string, unknown> | null) ?? {}) as Record<string, unknown>

    const merged = { ...current, baileys_auth: serialized }

    const { error: upErr } = await supabase
      .from('channels')
      .update({ credentials: merged })
      .eq('id', channelId)

    if (upErr) {
      // eslint-disable-next-line no-console
      console.warn(`[baileys-auth] persist(${channelId}) falhou: ${upErr.message}`)
    }
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const bucket = (keys[type] ?? {}) as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const id of ids) {
          let v = bucket[id]
          // app-state-sync-key precisa vir como proto (não plain JSON)
          if (type === 'app-state-sync-key' && v) {
            v = proto.Message.AppStateSyncKeyData.fromObject(v as object)
          }
          if (v !== undefined && v !== null) out[id] = v
        }
        return out as never
      },
      set: async (data) => {
        for (const typeStr of Object.keys(data)) {
          const type = typeStr as KeyType
          const bucket = (keys[type] ??= {}) as Record<string, unknown>
          const records = (data[type] ?? {}) as Record<string, unknown>
          for (const id of Object.keys(records)) {
            const v = records[id]
            if (v === null || v === undefined) {
              delete bucket[id]
            } else {
              bucket[id] = v
            }
          }
        }
        await persist()
      },
    },
  }

  return {
    state,
    saveCreds: persist,
    clear: async () => {
      const { data: row } = await supabase
        .from('channels')
        .select('credentials')
        .eq('id', channelId)
        .maybeSingle()
      const current =
        ((row?.credentials as Record<string, unknown> | null) ?? {}) as Record<string, unknown>
      delete current.baileys_auth
      await supabase
        .from('channels')
        .update({ credentials: current })
        .eq('id', channelId)
    },
  }
}
