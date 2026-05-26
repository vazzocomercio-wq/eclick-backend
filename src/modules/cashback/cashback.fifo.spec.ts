import { allocateFifo } from './cashback.fifo'

describe('allocateFifo (cashback FIFO)', () => {
  it('consome um único lote parcialmente', () => {
    const r = allocateFifo([{ id: 'a', remaining: 1000 }], 300)
    expect(r.takes).toEqual([{ id: 'a', take: 300 }])
    expect(r.leftover).toBe(0)
  })

  it('atravessa múltiplos lotes em ordem (FIFO)', () => {
    const r = allocateFifo([
      { id: 'a', remaining: 200 },
      { id: 'b', remaining: 500 },
    ], 600)
    expect(r.takes).toEqual([{ id: 'a', take: 200 }, { id: 'b', take: 400 }])
    expect(r.leftover).toBe(0)
  })

  it('pula lotes zerados', () => {
    const r = allocateFifo([
      { id: 'a', remaining: 0 },
      { id: 'b', remaining: 500 },
    ], 300)
    expect(r.takes).toEqual([{ id: 'b', take: 300 }])
    expect(r.leftover).toBe(0)
  })

  it('reporta leftover quando os lotes não cobrem (legado sem remaining)', () => {
    const r = allocateFifo([{ id: 'a', remaining: 100 }], 500)
    expect(r.takes).toEqual([{ id: 'a', take: 100 }])
    expect(r.leftover).toBe(400)
  })

  it('valor zero/negativo não consome nada', () => {
    expect(allocateFifo([{ id: 'a', remaining: 100 }], 0).takes).toEqual([])
    expect(allocateFifo([{ id: 'a', remaining: 100 }], -50).takes).toEqual([])
  })

  it('cenário do bug: ganha 10+10, gasta 10 → expirar o 1º lote tira 0', () => {
    // Lotes em ordem FIFO (lote1 vence antes). Cliente resgata R$10.
    const lots = [
      { id: 'lote1', remaining: 1000 },
      { id: 'lote2', remaining: 1000 },
    ]
    const { takes } = allocateFifo(lots, 1000)
    // Aplica o consumo nos lotes (simula o que o service grava)
    for (const t of takes) {
      const lot = lots.find(l => l.id === t.id)!
      lot.remaining -= t.take
    }
    expect(lots.find(l => l.id === 'lote1')!.remaining).toBe(0)    // lote1 consumido
    expect(lots.find(l => l.id === 'lote2')!.remaining).toBe(1000) // lote2 intacto

    // Quando lote1 expira, a expiração tira só o remaining (0) — NÃO os 1000
    // originais. Saldo do cliente segue 1000 (o lote2). Era esse o bug.
    const expireAmountLote1 = lots.find(l => l.id === 'lote1')!.remaining
    expect(expireAmountLote1).toBe(0)
  })
})
