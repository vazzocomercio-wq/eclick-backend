import { normalizeMinStock, applyVirtualStockRule } from './stock.rules'

/**
 * A regra de pausa por estoque mínimo é o que impede vender o que não existe.
 * Estes testes travam o comportamento nos dois pontos que já quebraram:
 *   1. o mínimo tem de valer contra o estoque FÍSICO (antes era comparado
 *      contra físico+virtual e virava letra morta em produto com vitrine);
 *   2. a assinatura da regra antiga (min = virtual) tem de continuar sendo
 *      lida como "pausa no físico zero", independente da migration ter rodado.
 */
describe('normalizeMinStock', () => {
  it('mantém um mínimo real', () => {
    expect(normalizeMinStock(3, 10000)).toBe(3)
    expect(normalizeMinStock(1, 0)).toBe(1)
  })

  it('trata a assinatura da regra antiga (min = virtual) como 0', () => {
    expect(normalizeMinStock(10000, 10000)).toBe(0)
    expect(normalizeMinStock(1000, 1000)).toBe(0)
  })

  it('não confunde min=0 e virtual=0 (não há regra antiga aí)', () => {
    expect(normalizeMinStock(0, 0)).toBe(0)
  })

  it('trata nulo/indefinido/negativo como 0', () => {
    expect(normalizeMinStock(null, 500)).toBe(0)
    expect(normalizeMinStock(undefined, 500)).toBe(0)
    expect(normalizeMinStock(-5, 500)).toBe(0)
  })
})

describe('applyVirtualStockRule', () => {
  const base = { physical: 0, virtual: 0, reserved: 0, minStock: 0, autoPause: true }

  it('pausa quando o físico zera (mínimo 0)', () => {
    const r = applyVirtualStockRule({ ...base, physical: 0, virtual: 10000 })
    expect(r.pause).toBe(true)
    expect(r.effectiveQty).toBe(0)
  })

  it('publica físico + virtual enquanto houver físico', () => {
    const r = applyVirtualStockRule({ ...base, physical: 90, virtual: 10000 })
    expect(r.pause).toBe(false)
    expect(r.qty).toBe(10090)
    expect(r.effectiveQty).toBe(10090)
  })

  it('respeita um mínimo REAL mesmo com vitrine virtual grande', () => {
    // o bug antigo: 10.003 <= 3 dava falso e o anúncio nunca pausava
    const aindaVende = applyVirtualStockRule({ ...base, physical: 4, virtual: 10000, minStock: 3 })
    expect(aindaVende.pause).toBe(false)

    const pausa = applyVirtualStockRule({ ...base, physical: 3, virtual: 10000, minStock: 3 })
    expect(pausa.pause).toBe(true)
    expect(pausa.effectiveQty).toBe(0)
  })

  it('a assinatura antiga (min = virtual) segue pausando só no físico zero', () => {
    const comEstoque = applyVirtualStockRule({ ...base, physical: 1, virtual: 10000, minStock: 10000 })
    expect(comEstoque.pause).toBe(false)

    const semEstoque = applyVirtualStockRule({ ...base, physical: 0, virtual: 10000, minStock: 10000 })
    expect(semEstoque.pause).toBe(true)
  })

  it('desconta o reservado do físico livre', () => {
    const r = applyVirtualStockRule({ ...base, physical: 5, virtual: 100, reserved: 5, minStock: 0 })
    expect(r.fisicoLivre).toBe(0)
    expect(r.pause).toBe(true)
  })

  it('não pausa nada quando a auto-pausa está desligada', () => {
    const r = applyVirtualStockRule({ ...base, physical: 0, virtual: 0, autoPause: false })
    expect(r.pause).toBe(false)
    expect(r.effectiveQty).toBe(0) // 0 porque não há estoque, não porque pausou
  })

  it('nunca devolve quantidade negativa', () => {
    const r = applyVirtualStockRule({ ...base, physical: 2, virtual: 0, reserved: 99, autoPause: false })
    expect(r.qty).toBe(0)
    expect(r.fisicoLivre).toBe(0)
  })
})
