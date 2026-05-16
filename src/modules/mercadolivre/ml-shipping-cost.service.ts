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
}

export interface ShippingCostResult {
  /** Custo do frete grátis pago pelo VENDEDOR (R$), já com o subsídio do ML descontado. */
  sellerCost: number
  /** Custo de tabela bruto, antes do subsídio (R$). */
  listCost: number
  /** Peso considerado pelo ML — máximo entre real e volumétrico — em gramas. */
  billableWeight: number
  /** Fração do subsídio de reputação aplicado pelo ML (0–1). */
  discountRate: number
}

/**
 * Custo do frete grátis pago pelo vendedor no Mercado Livre.
 *
 * Fonte: `GET /users/{sellerId}/shipping_options/free?dimensions=...&item_price=...`
 * — retorna `coverage.all_country.list_cost` (custo de tabela) + `billable_weight`
 * + `discount` (subsídio de reputação do ML).
 *
 * O ML aplica internamente as regras de faixa de preço (o custo dá um salto
 * quando o item passa do valor mínimo de frete grátis) — basta informar as
 * dimensões e o `item_price`. Abaixo do valor mínimo, o ML retorna o custo
 * menor da própria tabela.
 *
 * Usado pra ESTIMAR o frete de anúncios ainda não publicados (ex: painel de
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
        params:  { dimensions, item_price: price, verbose: true },
        timeout: 10_000,
      })

      const ac = data?.coverage?.all_country
      if (!ac || ac.list_cost == null) return null

      const listCost     = Number(ac.list_cost) || 0
      const discountRate = Number(ac.discount?.rate) || 0
      const promoted     = Number(ac.discount?.promoted_amount) || 0
      // Custo do vendedor = tabela − subsídio do ML.
      const subsidy    = promoted > 0 ? promoted : listCost * discountRate
      const sellerCost = Math.max(0, Math.round((listCost - subsidy) * 100) / 100)

      return {
        sellerCost,
        listCost,
        billableWeight: Number(ac.billable_weight) || weight,
        discountRate,
      }
    } catch (e) {
      this.logger.warn(`[shipping-cost] fetch falhou seller=${sellerId}: ${(e as Error).message}`)
      return null
    }
  }
}
