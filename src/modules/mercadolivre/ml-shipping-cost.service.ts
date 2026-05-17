import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'

const ML_BASE = 'https://api.mercadolibre.com'

export interface ShippingCostInput {
  /** Dimensões da embalagem, em centímetros. */
  lengthCm: number
  widthCm:  number
  heightCm: number
  /** Peso real da embalagem, em gramas. */
  weightGrams: number
  /** Preço de venda do item — o ML usa a faixa de preço pra calcular o custo. */
  itemPrice: number
  /** Tipo de anúncio (free / gold_special / gold_pro). OBRIGATÓRIO para o ML
   *  aplicar o desconto de frete por reputação — sem ele o custo vem BRUTO. */
  listingTypeId: string
}

export interface ShippingCostResult {
  /** Custo do frete grátis que o vendedor paga (R$), já com o desconto de reputação aplicado. */
  sellerCost: number
  /** Custo cheio de tabela, antes do desconto de reputação (R$). */
  grossCost: number
  /** Fração do desconto de reputação aplicado pelo ML (0–1). Ex: 0.5 = 50% (Mercado Líder). */
  discountRate: number
  /** Peso considerado pelo ML — máximo entre real e volumétrico — em gramas. */
  billableWeight: number
}

/**
 * Custo do frete grátis pago pelo vendedor no Mercado Livre.
 *
 * Fonte: `GET /users/{sellerId}/shipping_options/free?dimensions=...&item_price=...&listing_type_id=...`
 * — retorna `coverage.all_country.list_cost` (custo JÁ LÍQUIDO quando o
 * `listing_type_id` é informado) + `billable_weight` + `discount` (desconto de
 * reputação aplicado pelo ML).
 *
 * ⚠️ É OBRIGATÓRIO passar `listing_type_id`: sem ele o ML devolve o custo
 * BRUTO (`discount: none`) — para uma conta Mercado Líder isso superfatura o
 * frete em até 2×. Com o `listing_type_id`, o ML aplica o desconto de
 * reputação (varia por item: 30–50%) e devolve o custo líquido em `list_cost`.
 *
 * O ML também aplica internamente as regras de faixa de preço (o custo dá um
 * salto quando o item passa do valor mínimo de frete grátis) — basta informar
 * `item_price`.
 *
 * Usado pra ESTIMAR o frete de anúncios ainda não publicados (painel de
 * markup). Pedidos concretizados usam o custo real do shipment.
 */
@Injectable()
export class MlShippingCostService {
  private readonly logger = new Logger(MlShippingCostService.name)

  async getFreeShippingCost(
    token: string,
    sellerId: number,
    input: ShippingCostInput,
  ): Promise<ShippingCostResult | null> {
    const dims = [input.lengthCm, input.widthCm, input.heightCm]
      .map(n => Math.round(Number(n) || 0))
    const weight = Math.round(Number(input.weightGrams) || 0)
    const price  = Math.max(0, Number(input.itemPrice) || 0)
    const listingTypeId = input.listingTypeId?.trim() || 'gold_special'
    if (dims.some(d => d <= 0) || weight <= 0 || price <= 0) return null

    const dimensions = `${dims[0]}x${dims[1]}x${dims[2]},${weight}`
    try {
      const { data } = await axios.get<{
        coverage?: {
          all_country?: {
            list_cost?: number
            billable_weight?: number
            discount?: { rate?: number; promoted_amount?: number }
          }
        }
      }>(`${ML_BASE}/users/${sellerId}/shipping_options/free`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  {
          dimensions,
          item_price:      price,
          listing_type_id: listingTypeId,
          verbose:         true,
        },
        timeout: 10_000,
      })

      const ac = data?.coverage?.all_country
      if (!ac || ac.list_cost == null) return null

      // Com listing_type_id, `list_cost` já é o custo LÍQUIDO (pós-desconto).
      const sellerCost   = Math.max(0, Math.round((Number(ac.list_cost) || 0) * 100) / 100)
      const discountRate = Number(ac.discount?.rate) || 0
      const promoted     = Number(ac.discount?.promoted_amount) || 0
      // `promoted_amount` traz o custo cheio (bruto) quando há desconto.
      const grossCost    = promoted > 0
        ? Math.round(promoted * 100) / 100
        : sellerCost

      return {
        sellerCost,
        grossCost,
        discountRate,
        billableWeight: Number(ac.billable_weight) || weight,
      }
    } catch (e) {
      this.logger.warn(`[shipping-cost] fetch falhou seller=${sellerId}: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * Custo do frete grátis de um anúncio JÁ PUBLICADO — usa as dimensões
   * REAIS registradas no próprio anúncio (atributos SELLER_PACKAGE_*), não
   * estimativas do catálogo interno. Para Criativo (anúncio novo) continua-se
   * usando getFreeShippingCost direto com as dimensões digitadas.
   */
  async getItemFreeShippingCost(token: string, itemId: string): Promise<ShippingCostResult | null> {
    try {
      const { data: item } = await axios.get<{
        seller_id?: number
        price?: number
        listing_type_id?: string
        shipping?: { free_shipping?: boolean }
        attributes?: Array<{
          id?: string
          value_name?: string
          value_struct?: { number?: number; unit?: string } | null
          values?: Array<{ struct?: { number?: number; unit?: string } | null }>
        }>
      }>(`${ML_BASE}/items/${itemId}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { attributes: 'id,seller_id,price,listing_type_id,shipping,attributes' },
        timeout: 10_000,
      })

      if (!item?.shipping?.free_shipping || !item.seller_id) return null
      const attrs = Array.isArray(item.attributes) ? item.attributes : []

      /** Lê um atributo de dimensão → { n, unit }. */
      const readDim = (attrId: string): { n: number; unit: string } | null => {
        const a = attrs.find((x) => x?.id === attrId)
        if (!a) return null
        const struct = a.value_struct ?? a.values?.[0]?.struct ?? null
        let n = typeof struct?.number === 'number' ? struct.number : null
        const unit = struct?.unit ?? ''
        if (n == null && typeof a.value_name === 'string') {
          const m = a.value_name.match(/[\d.,]+/)
          if (m) n = parseFloat(m[0].replace(',', '.'))
        }
        return n != null && n > 0 ? { n, unit } : null
      }
      const L = readDim('SELLER_PACKAGE_LENGTH')
      const W = readDim('SELLER_PACKAGE_WIDTH')
      const H = readDim('SELLER_PACKAGE_HEIGHT')
      const WT = readDim('SELLER_PACKAGE_WEIGHT')
      if (!L || !W || !H || !WT) return null

      const toCm = (d: { n: number; unit: string }): number =>
        d.unit === 'mm' ? d.n / 10 : d.unit === 'm' ? d.n * 100 : d.n
      const toGrams = (d: { n: number; unit: string }): number =>
        d.unit === 'kg' ? d.n * 1000 : d.n

      return this.getFreeShippingCost(token, item.seller_id, {
        lengthCm: toCm(L),
        widthCm: toCm(W),
        heightCm: toCm(H),
        weightGrams: toGrams(WT),
        itemPrice: Number(item.price) || 0,
        listingTypeId: item.listing_type_id ?? 'gold_special',
      })
    } catch (e) {
      this.logger.warn(`[shipping-cost.item] ${itemId} falhou: ${(e as Error).message}`)
      return null
    }
  }
}
