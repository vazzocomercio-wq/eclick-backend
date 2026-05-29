import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import * as crypto from 'crypto'
import * as QRCode from 'qrcode'
import { supabaseAdmin } from '../../common/supabase'

/** F18 F2.4 — Link Studio: gera link rastreável de afiliado por canal.
 *
 *  sub_id = `{org_short}_{channel}_{ts36}` — atribuição por canal pro
 *  Attribution Analytics (F2.5) separar receita por origem.
 *
 *  short_hash → URL encurtada `${SHORT_BASE}/go/{hash}` que 302-redireciona
 *  pro destino. Enquanto a Affiliate API não conecta, o destino é a URL
 *  pública do produto Shopee + sub_id. Quando conectar, tracked_url (link
 *  oficial Shopee com cookie de atribuição) substitui. */
@Injectable()
export class LinkStudioService {
  private readonly logger = new Logger(LinkStudioService.name)

  private readonly CHANNELS = new Set([
    'whatsapp', 'instagram', 'tiktok', 'shopee_video', 'shopee_live', 'blog',
  ])

  private get shortBase(): string {
    return process.env.SHOPEE_SHORT_BASE
      ?? process.env.NEXT_PUBLIC_BACKEND_URL
      ?? 'https://api.eclick.app.br'
  }

  /** Gera um link rastreável pra uma oferta + canal. */
  async generate(args: {
    orgId:   string
    itemId:  number
    channel: string
  }): Promise<LinkResult> {
    if (!this.CHANNELS.has(args.channel)) {
      throw new BadRequestException(`Canal inválido. Use: ${[...this.CHANNELS].join(', ')}`)
    }

    // Busca a oferta pra montar destino + validar que existe na org
    const { data: offer } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_offers')
      .select('item_id, shop_id, name')
      .eq('organization_id', args.orgId)
      .eq('item_id', args.itemId)
      .maybeSingle()
    if (!offer) throw new BadRequestException('Oferta não encontrada nesta org')
    const off = offer as { item_id: number; shop_id: number | null; name: string | null }

    const orgShort = args.orgId.replace(/-/g, '').slice(0, 6)
    const ts36     = Date.now().toString(36)
    const subId    = `${orgShort}_${args.channel}_${ts36}`
    const shortHash = base62(7)

    // Destino: link oficial Shopee virá da Affiliate API (tracked_url).
    // Fallback até lá: URL pública do produto + sub_id.
    const targetUrl = off.shop_id
      ? `https://shopee.com.br/product/${off.shop_id}/${off.item_id}?sub_id=${encodeURIComponent(subId)}`
      : `https://shopee.com.br/product/${off.item_id}?sub_id=${encodeURIComponent(subId)}`

    const shortUrl = `${this.shortBase.replace(/\/+$/, '')}/go/${shortHash}`

    const { data: inserted, error } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_links')
      .insert({
        organization_id: args.orgId,
        item_id:         args.itemId,
        sub_id:          subId,
        channel:         args.channel,
        short_hash:      shortHash,
        target_url:      targetUrl,
        tracked_url:     null,        // setado quando Affiliate API conectar
      })
      .select('id, created_at')
      .single()
    if (error) {
      this.logger.error(`[link-studio] insert: ${error.message}`)
      throw new Error(error.message)
    }

    const qrDataUrl = await QRCode.toDataURL(shortUrl, { margin: 1, width: 240 })

    return {
      id:          (inserted as { id: string }).id,
      item_id:     args.itemId,
      name:        off.name,
      channel:     args.channel,
      sub_id:      subId,
      short_url:   shortUrl,
      target_url:  targetUrl,
      qr_data_url: qrDataUrl,
      clicks:      0,
      created_at:  (inserted as { created_at: string }).created_at,
    }
  }

  /** Lista links da org (mais recentes primeiro). */
  async list(orgId: string, itemId?: number): Promise<LinkRow[]> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('affiliate_links')
      .select('id, item_id, sub_id, channel, short_hash, target_url, tracked_url, clicks, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (itemId != null) q = q.eq('item_id', itemId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return ((data ?? []) as unknown as Array<Omit<LinkRow, 'short_url'>>).map(r => ({
      ...r,
      short_url: `${this.shortBase.replace(/\/+$/, '')}/go/${r.short_hash}`,
    }))
  }

  /** Resolve hash → URL de destino + incrementa cliques. Usado pelo
   *  redirect público. Retorna null se hash não existe. */
  async resolveAndCount(hash: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_links')
      .select('id, target_url, tracked_url, clicks')
      .eq('short_hash', hash)
      .maybeSingle()
    if (!data) return null
    const row = data as { id: string; target_url: string; tracked_url: string | null; clicks: number }

    // Incrementa cliques (best-effort — não bloqueia o redirect)
    void supabaseAdmin
      .schema('shopee')
      .from('affiliate_links')
      .update({ clicks: (row.clicks ?? 0) + 1, last_click_at: new Date().toISOString() })
      .eq('id', row.id)
      .then(({ error }) => { if (error) this.logger.warn(`[link-studio] click count: ${error.message}`) })

    return row.tracked_url ?? row.target_url
  }
}

export interface LinkResult {
  id:          string
  item_id:     number
  name:        string | null
  channel:     string
  sub_id:      string
  short_url:   string
  target_url:  string
  qr_data_url: string
  clicks:      number
  created_at:  string
}

export interface LinkRow {
  id:          string
  item_id:     number
  sub_id:      string
  channel:     string
  short_hash:  string
  target_url:  string
  tracked_url: string | null
  clicks:      number
  short_url:   string
  created_at:  string
}

/** Hash base62 aleatório (URL-safe, sem ambiguidade). */
function base62(len: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % 62]
  return out
}
