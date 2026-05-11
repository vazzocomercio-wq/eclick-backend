#!/usr/bin/env node
/**
 * Seed inicial pra ml_postsale (mensagens pós-venda).
 *
 * Itera orders dos últimos N dias e tenta puxar mensagens via
 *   GET /messages/packs/{external_order_id}/sellers/{seller_id}?tag=post_sale
 *
 * Popula:
 *   - ml_conversations (1 row por pack)
 *   - ml_messages (N rows por conversa)
 *
 * Pattern parecido com seed-f11-item-visits.mjs:
 *   - Token cache por seller (multi-conta)
 *   - Rate-limit 1s entre chamadas
 *   - Retry: 401 refresh + retry; 404 silencia (sem msgs nesse pack);
 *     429 cooldown 60s; 5xx backoff
 *
 * Uso:
 *   node scripts/seed-postsale-messages.mjs [ORG_UUID] [DAYS=30]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET

if (!SUPA_URL || !SVC_KEY || !ML_CLIENT_ID || !ML_CLIENT_SECRET) {
  console.error('[seed] env missing'); process.exit(1)
}

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })
const targetOrg = process.argv[2] ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const DAYS = Number(process.argv[3] ?? 30)

const RATE_LIMIT_MS = 800
const MAX_ITEMS_PER_SELLER = 500

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function refreshToken(conn) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  })
  if (!r.ok) throw new Error(`refresh ${r.status}`)
  const j = await r.json()
  await admin.from('ml_connections').update({
    access_token:  j.access_token,
    refresh_token: j.refresh_token,
    expires_at:    new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('organization_id', conn.organization_id).eq('seller_id', conn.seller_id)
  return j.access_token
}

async function getToken(orgId, sellerId) {
  const { data: conn, error } = await admin
    .from('ml_connections')
    .select('organization_id, seller_id, access_token, refresh_token, expires_at')
    .eq('organization_id', orgId).eq('seller_id', sellerId).maybeSingle()
  if (error || !conn) throw new Error(`no_token: org=${orgId} seller=${sellerId}`)
  if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
    return await refreshToken(conn)
  }
  return conn.access_token
}

// Fetch metadata of an order pra ter product + buyer info
async function fetchOrderMeta(token, orderId) {
  try {
    const r = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function scanSeller(orgId, sellerId) {
  console.log(`\n[seed] seller=${sellerId}`)
  const start = Date.now()
  let token = await getToken(orgId, sellerId)

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: orders } = await admin
    .from('orders')
    .select('external_order_id, sold_at, created_at, marketplace_listing_id, product_title, raw_data')
    .eq('organization_id', orgId)
    .eq('seller_id',       sellerId)
    .eq('platform',        'mercadolivre')
    .not('external_order_id', 'is', null)
    .gte('created_at',     since)
    .order('created_at', { ascending: false })
    .limit(MAX_ITEMS_PER_SELLER)

  // Dedup por pack_id: pack_id real vem de raw_data.pack_id; se null, é
  // single-order e pack_id == external_order_id (mas ML aceita single order
  // como pack_id também). Pra carrinhos múltiplos, raw_data.pack_id é OBRIGATÓRIO
  // — sem ele, /messages/packs/{order_id} retorna 400 "order_belong_pack".
  const packMap = new Map() // packId → { ml_listing_id, product_title }
  for (const o of (orders ?? [])) {
    const packId = o.raw_data?.pack_id ? String(o.raw_data.pack_id) : String(o.external_order_id)
    if (!packMap.has(packId)) {
      packMap.set(packId, {
        ml_listing_id:  o.marketplace_listing_id ?? null,
        product_title:  o.product_title ?? null,
      })
    }
  }
  const uniquePacks = Array.from(packMap.keys())
  console.log(`  ${uniquePacks.length} packs únicos (de ${(orders ?? []).length} orders)`)

  const stats = { checked: 0, with_msgs: 0, conversations_created: 0, messages_inserted: 0, errors: 0, bad_packs: 0 }

  for (let i = 0; i < uniquePacks.length; i++) {
    const packId = uniquePacks[i]
    if ((i + 1) % 50 === 0) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`  progress ${i + 1}/${uniquePacks.length} (${elapsed}s · with_msgs=${stats.with_msgs} convs=${stats.conversations_created})`)
    }

    try {
      const url = `https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (r.status === 401) {
        token = await getToken(orgId, sellerId)
        i--
        continue
      }
      if (r.status === 429) {
        await sleep(60_000)
        i--
        continue
      }
      if (r.status === 404) {
        // Sem mensagens neste pack — comum. Skip silencioso.
        stats.checked++
        await sleep(RATE_LIMIT_MS)
        continue
      }
      if (r.status === 400) {
        // "order_belong_pack" — pack_id errado (single order é parte de carrinho).
        // Já tratado no dedup acima mas ainda pode acontecer se raw_data falta pack_id.
        stats.bad_packs++
        await sleep(RATE_LIMIT_MS)
        continue
      }
      if (!r.ok) {
        stats.errors++
        await sleep(RATE_LIMIT_MS)
        continue
      }

      const body = await r.json()
      const messages = body?.messages ?? []
      stats.checked++

      if (messages.length === 0) {
        await sleep(RATE_LIMIT_MS)
        continue
      }

      stats.with_msgs++

      // Buyer info (do primeiro msg do comprador)
      let buyerId = 0
      let buyerNick = null
      for (const m of messages) {
        if (m.from && String(m.from.user_id) !== String(sellerId)) {
          buyerId = Number(m.from.user_id) || 0
          break
        }
      }

      // Order meta da packMap (já enriquecido na dedup)
      const packInfo  = packMap.get(packId) ?? {}
      let productTitle = packInfo.product_title ?? null
      let productThumb = null
      let listingId    = packInfo.ml_listing_id ?? null
      let orderId      = Number(packId)

      if (!productTitle) {
        const om = await fetchOrderMeta(token, packId)
        const item = om?.order_items?.[0]?.item
        productTitle = item?.title ?? null
        productThumb = item?.thumbnail ?? null
        listingId    = item?.id ?? listingId
        if (!buyerId) buyerId = om?.buyer?.id ?? 0
        if (!buyerNick) buyerNick = om?.buyer?.nickname ?? null
        await sleep(400)
      }

      // Datas
      const lastMsg     = messages[messages.length - 1]
      const lastMsgAt   = lastMsg?.message_date?.received ?? lastMsg?.message_date?.created ?? new Date().toISOString()
      let lastBuyerAt   = null
      let lastSellerAt  = null
      let unreadCount   = 0
      for (const m of messages) {
        const ts = m.message_date?.received ?? m.message_date?.created
        if (!ts) continue
        const fromId = String(m.from?.user_id ?? '')
        if (fromId === String(sellerId)) {
          if (!lastSellerAt || ts > lastSellerAt) lastSellerAt = ts
        } else {
          if (!lastBuyerAt || ts > lastBuyerAt) lastBuyerAt = ts
          if (!m.message_date?.read) unreadCount++
        }
      }

      // Upsert conversation
      const convPayload = {
        organization_id:        orgId,
        seller_id:              sellerId,
        pack_id:                Number(packId),
        order_id:               orderId,
        buyer_id:               buyerId,
        buyer_nickname:         buyerNick,
        ml_listing_id:          listingId,
        product_title:          productTitle,
        product_thumbnail:      productThumb,
        status:                 'active',
        last_message_at:        lastMsgAt,
        last_buyer_message_at:  lastBuyerAt,
        last_seller_message_at: lastSellerAt,
        unread_count:           unreadCount,
        updated_at:             new Date().toISOString(),
      }

      const { data: convRow, error: convErr } = await admin
        .from('ml_conversations')
        .upsert(convPayload, { onConflict: 'organization_id,pack_id' })
        .select('id')
        .single()
      if (convErr) {
        // Tentar com fallback sem onConflict (caso UNIQUE seja diferente)
        const { data: existing } = await admin
          .from('ml_conversations')
          .select('id')
          .eq('organization_id', orgId)
          .eq('pack_id', Number(packId))
          .maybeSingle()
        if (existing) {
          await admin.from('ml_conversations').update(convPayload).eq('id', existing.id)
        } else {
          const { data: inserted, error: insErr } = await admin
            .from('ml_conversations').insert(convPayload).select('id').single()
          if (insErr) {
            console.warn(`    ✗ conv upsert pack=${packId}: ${insErr.message}`)
            stats.errors++
            continue
          }
          convRow ?? (await admin.from('ml_conversations').select('id').eq('pack_id', Number(packId)).eq('organization_id', orgId).maybeSingle()).data
        }
      }

      const convId = convRow?.id ?? (await admin.from('ml_conversations').select('id').eq('pack_id', Number(packId)).eq('organization_id', orgId).maybeSingle()).data?.id
      if (!convId) {
        stats.errors++
        continue
      }
      stats.conversations_created++

      // Insert messages (skip duplicates por ml_message_id)
      for (const m of messages) {
        const mlMsgId = m.id ?? m.message_id ?? null
        if (!mlMsgId) continue

        // Já existe?
        const { data: exists } = await admin
          .from('ml_messages')
          .select('id')
          .eq('ml_message_id', String(mlMsgId))
          .maybeSingle()
        if (exists) continue

        const fromId = String(m.from?.user_id ?? '')
        const direction = fromId === String(sellerId) ? 'outbound' : 'inbound'
        const text = m.text?.plain ?? m.text ?? m.message?.text ?? ''
        const sentAt     = m.message_date?.created ?? null
        const receivedAt = m.message_date?.received ?? null
        const readAt     = m.message_date?.read ?? null
        const modStatus  = m.message_moderation?.status ?? null

        await admin.from('ml_messages').insert({
          conversation_id:   convId,
          ml_message_id:     String(mlMsgId),
          direction,
          text,
          attachments:       m.message_attachments ?? m.attachments ?? [],
          sent_at:           sentAt,
          received_at:       receivedAt,
          read_at:           readAt,
          moderation_status: modStatus,
          raw:               m,
        })
        stats.messages_inserted++
      }

      await sleep(RATE_LIMIT_MS)
    } catch (err) {
      stats.errors++
      console.warn(`    ✗ pack=${packId}: ${err.message}`)
    }
  }

  const dur = Math.round((Date.now() - start) / 1000)
  console.log(`  done seller=${sellerId} checked=${stats.checked} with_msgs=${stats.with_msgs} convs=${stats.conversations_created} msgs=${stats.messages_inserted} bad_packs=${stats.bad_packs} errors=${stats.errors} duration=${dur}s`)
  return stats
}

// ── Main ──────────────────────────────────────────────────────────
console.log(`[seed] org=${targetOrg.slice(0, 8)} days=${DAYS}`)
const { data: conns } = await admin
  .from('ml_connections')
  .select('seller_id, nickname')
  .eq('organization_id', targetOrg)

for (const c of (conns ?? [])) {
  try {
    await scanSeller(targetOrg, c.seller_id)
  } catch (e) {
    console.error(`[seed] ✗ seller=${c.seller_id}: ${e.message}`)
  }
}

console.log('\n[seed] done')
