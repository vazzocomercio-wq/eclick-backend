/**
 * Trava a matemática de custo→preço que a precificação por variante usa.
 * A fórmula vive no serviço (depende de settings do banco); aqui reproduzo
 * SÓ o cálculo puro pra garantir que peso maior = preço maior e que a margem
 * alvo é atingida — o que sustenta "G custa mais que M".
 */
function priceFromCost(total: number, feePct: number, marginPct: number): number {
  const denom = 1 - feePct / 100 - marginPct / 100
  return denom > 0 ? Math.round((total / denom) * 100) / 100 : 0
}
function realizedMargin(price: number, feePct: number, total: number): number {
  return price > 0 ? Math.round(((price - price * feePct / 100 - total) / price) * 10000) / 100 : 0
}

describe('custo → preço', () => {
  it('peso maior gera custo maior gera preço maior (Gota G vs M)', () => {
    const custoG = (321 / 1000) * 200 + (1500 / 60) * 0.4   // filamento + energia
    const custoM = (97 / 1000) * 200 + (503 / 60) * 0.4
    expect(custoG).toBeGreaterThan(custoM)
    expect(priceFromCost(custoG, 14, 30)).toBeGreaterThan(priceFromCost(custoM, 14, 30))
  })

  it('o preço realiza a margem alvo', () => {
    const total = 74.25
    const p = priceFromCost(total, 14, 30)
    expect(realizedMargin(p, 14, total)).toBeCloseTo(30, 0)
  })

  it('margem impossível (taxa + alvo ≥ 100%) devolve 0, não preço negativo', () => {
    expect(priceFromCost(50, 60, 45)).toBe(0)
  })
})
