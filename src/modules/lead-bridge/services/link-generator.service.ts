import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Crockford-ish, no 0/O/1/I

@Injectable()
export class LinkGeneratorService {
  /** 8-char URL-safe token. Retries up to 5x in the rare case of collision. */
  async generateUniqueToken(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const token = Array.from({ length: 8 }, () =>
        ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
      ).join('')
      const { data } = await supabaseAdmin
        .from('lead_bridge_links')
        .select('id')
        .eq('short_token', token)
        .maybeSingle()
      if (!data) return token
    }
    throw new Error('Não foi possível gerar token único após 5 tentativas')
  }

  /** Returns a public QR PNG URL — uses api.qrserver.com so we don't need
   * to bundle a QR generator. The image is rendered on the fly when the
   * user opens the page or downloads it for printing. */
  qrCodeUrl(publicLandingUrl: string, size = 400): string {
    const data = encodeURIComponent(publicLandingUrl)
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${data}`
  }
}
