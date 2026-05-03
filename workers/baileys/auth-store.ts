import {
  AuthenticationCreds, AuthenticationState, BufferJSON,
  initAuthCreds, proto, SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Auth state Baileys persistido em Postgres.
 *
 * Substitui useMultiFileAuthState (filesystem) — Railway efêmero entre deploys.
 *
 * Serialização: BufferJSON.replacer/reviver. JSON.stringify nativo perde Buffer
 * e Map binários (curve25519 keys, sender stores) — sessão quebra silenciosa.
 *
 * Estrutura:
 *   creds jsonb — AuthenticationCreds (objeto único, escreve a cada creds.update)
 *   keys  jsonb — Map<"$type-$id", value> (re-escreve full a cada save — simples
 *                 pra MVP; pra muitas orgs ativas considerar tabela separada).
 */

const TABLE = 'whatsapp_free_sessions'
const SESSION_NAME = 'default'

type KeyType = keyof SignalDataTypeMap
type StoredKeys = Record<string, unknown>

function keyId(type: KeyType, id: string): string {
  return `${type}-${id}`
}

/** Serialize via BufferJSON pra preservar Buffer/Map. */
function serialize<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, BufferJSON.replacer))
}

/** Restaura Buffer/Map a partir do JSON do banco. */
function deserialize<T>(v: unknown): T {
  return JSON.parse(JSON.stringify(v ?? null), BufferJSON.reviver) as T
}

export interface AuthStoreHandle {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

export async function useDbAuthState(
  supabase: SupabaseClient,
  orgId: string,
): Promise<AuthStoreHandle> {
  // 1. Carrega state inicial do banco
  const { data: row } = await supabase
    .from(TABLE)
    .select('creds, keys')
    .eq('organization_id', orgId)
    .eq('session_name', SESSION_NAME)
    .maybeSingle()

  const creds: AuthenticationCreds = row?.creds
    ? deserialize<AuthenticationCreds>(row.creds)
    : initAuthCreds()

  // Cache em memória (escrito de volta no save)
  const keysMem: StoredKeys = row?.keys
    ? deserialize<StoredKeys>(row.keys)
    : {}

  // Helper: re-escreve creds + keys atuais
  const persist = async (): Promise<void> => {
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        {
          organization_id: orgId,
          session_name: SESSION_NAME,
          creds: serialize(creds),
          keys: serialize(keysMem),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,session_name' },
      )
    if (error) {
      console.error(`[auth-store] persist falhou orgId=${orgId}: ${error.message}`)
      throw error
    }
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out: Record<string, unknown> = {}
        for (const id of ids) {
          const stored = keysMem[keyId(type as KeyType, id)]
          if (!stored) continue
          // app-state-sync-key precisa ser convertido pra proto
          if (type === 'app-state-sync-key') {
            out[id] = proto.Message.AppStateSyncKeyData.fromObject(stored as object)
          } else {
            out[id] = stored
          }
        }
        return out as { [_ in string]: SignalDataTypeMap[typeof type] }
      },
      set: async (data) => {
        for (const type of Object.keys(data) as KeyType[]) {
          const byId = data[type]
          if (!byId) continue
          for (const id of Object.keys(byId)) {
            const value = byId[id]
            if (value === null || value === undefined) {
              delete keysMem[keyId(type, id)]
            } else {
              keysMem[keyId(type, id)] = value
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
  }
}

/** Limpa state da org (logout). */
export async function clearDbAuthState(
  supabase: SupabaseClient,
  orgId: string,
): Promise<void> {
  await supabase
    .from(TABLE)
    .update({
      creds: null,
      keys: null,
      status: 'disconnected',
      phone_number: null,
      phone_name: null,
      last_disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', orgId)
    .eq('session_name', SESSION_NAME)
}
