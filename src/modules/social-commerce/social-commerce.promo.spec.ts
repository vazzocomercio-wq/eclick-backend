jest.mock('../../common/supabase', () => ({ supabaseAdmin: {} }))

import { SocialCommerceService } from './social-commerce.service'
import type { MetaCatalogService } from './meta-catalog.service'
import type { MetaProductData } from './social-commerce.types'

// Promocao da loja -> sale_price no catalogo Meta (Instagram + WhatsApp).
const svc = new SocialCommerceService({} as MetaCatalogService)
const map = (p: Record<string, unknown>): MetaProductData =>
  (svc as unknown as { mapToMetaFormat: (p: unknown, ch: unknown, slug: string) => MetaProductData })
    .mapToMetaFormat({
      id: 'p1', organization_id: 'o', name: 'Vaso', brand: 'Vazzo', category: null,
      price: 199.99, stock: 5, description: null, ai_short_description: null,
      photo_urls: ['https://x/1.jpg'], channel_titles: null, channel_descriptions: null,
      gtin: null, condition: 'new', ml_permalink: null, sku: 'VZ-1', storefront_visible: true,
      sale_price: null, sale_start_at: null, sale_end_at: null,
      ...p,
    }, {}, 'vazzo')

const dia = 86_400_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('mapToMetaFormat — promocao', () => {
  it('promo vigente vai com preco e janela', () => {
    const ini = iso(-dia), fim = iso(dia)
    const out = map({ sale_price: 115.99, sale_start_at: ini, sale_end_at: fim })
    expect(out.price).toBe('199.99 BRL')
    expect(out.sale_price).toBe('115.99 BRL')
    expect(out.sale_price_effective_date).toBe(`${ini}/${fim}`)
  })

  it('sem promo manda vazio, pra apagar a promo antiga na Meta', () => {
    const out = map({})
    expect(out.sale_price).toBe('')
    expect(out.sale_price_effective_date).toBe('')
  })

  it('promo vencida ou ainda nao iniciada nao vai', () => {
    expect(map({ sale_price: 100, sale_start_at: iso(-2 * dia), sale_end_at: iso(-dia) }).sale_price).toBe('')
    expect(map({ sale_price: 100, sale_start_at: iso(dia), sale_end_at: iso(2 * dia) }).sale_price).toBe('')
  })

  it('promo maior ou igual ao preco cheio e ignorada', () => {
    expect(map({ sale_price: 199.99 }).sale_price).toBe('')
  })

  it('promo sem data de fim fica sem janela', () => {
    const out = map({ sale_price: 150 })
    expect(out.sale_price).toBe('150.00 BRL')
    expect(out.sale_price_effective_date).toBe('')
  })
})
