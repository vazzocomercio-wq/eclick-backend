import {
  computeReputation, decideMeasurementPeriod, forecastPeriodChange, officialFromRow,
  remainingOccurrencesDynamic, remainingOccurrencesStatic, riskFromRatio, salesToRecoverGreen, simulateReputation,
} from './ml-reputation.engine'
import {
  BUILTIN_RULE_SETS, ML_RULE_SET_2026_09_NAME, ML_RULE_SET_LEGACY_NAME,
  classifyCounts, classifyPercentage, isValidRuleSetConfig, resolveRuleSet, resolveUpcomingRuleSet,
  thresholdsFor, toSaoPauloDate,
} from './ml-reputation.rules'
import type { ReputationInput, ReputationLevel, WindowCounts } from './ml-reputation.types'

/**
 * O motor é a parte que o lojista não pode pegar errado: a faixa decide se
 * ele perde Mercado Líder. Estes testes travam:
 *   • o período (67 → 365d, 68 → 60d) e a troca automática nas duas direções;
 *   • TODOS os limites da tabela oficial de 10/09/2026, nas bordas exatas;
 *   • a matemática de "quantas ocorrências ainda cabem" e "quantas vendas
 *     diluem" (inteiros, arredondados pra cima);
 *   • que a faixa é decidida com o valor real, não com o arredondado.
 */

const RULES_2026 = BUILTIN_RULE_SETS.find(r => r.name === ML_RULE_SET_2026_09_NAME)!
const RULES_LEGACY = BUILTIN_RULE_SETS.find(r => r.name === ML_RULE_SET_LEGACY_NAME)!
const CFG = RULES_2026.config

const AS_OF = new Date('2026-10-01T12:00:00.000Z')

function win(partial: Partial<WindowCounts> = {}): WindowCounts {
  return { completed: 0, counted: 0, sellerCancelled: 0, claims: 0, shippingIssues: 0, ...partial }
}

function input(short: Partial<WindowCounts>, long: Partial<WindowCounts> = short, extra: Partial<ReputationInput> = {}): ReputationInput {
  return { accountId: 1, orgId: 'org', asOf: AS_OF, short: win(short), long: win(long), ...extra }
}

// ── Período 60/365 ────────────────────────────────────────────────────────

describe('período de medição (regra 2026-09)', () => {
  it('67 vendas em 60 dias → 365 dias', () => {
    expect(decideMeasurementPeriod(67, CFG)).toBe(365)
    expect(computeReputation(input({ completed: 67, counted: 67 }), RULES_2026).measurementPeriod).toBe(365)
  })
  it('68 vendas → 60 dias', () => {
    expect(decideMeasurementPeriod(68, CFG)).toBe(60)
    expect(computeReputation(input({ completed: 68, counted: 68 }), RULES_2026).measurementPeriod).toBe(60)
  })
  it('69 e 100 vendas → 60 dias', () => {
    expect(decideMeasurementPeriod(69, CFG)).toBe(60)
    expect(decideMeasurementPeriod(100, CFG)).toBe(60)
  })
  it('informa quantas vendas faltam pra entrar nos 60 dias', () => {
    const r = computeReputation(input({ completed: 64, counted: 64 }), RULES_2026)
    expect(r.nextMeasurementThreshold).toBe(68)
    expect(r.salesUntilShortPeriod).toBe(4)
    expect(computeReputation(input({ completed: 90, counted: 90 }), RULES_2026).salesUntilShortPeriod).toBe(0)
  })
  it('na regra anterior o limiar é 60 vendas', () => {
    expect(decideMeasurementPeriod(60, RULES_LEGACY.config)).toBe(60)
    expect(decideMeasurementPeriod(59, RULES_LEGACY.config)).toBe(365)
  })
})

// ── Tabela de limites — bordas exatas ────────────────────────────────────

type Case = [pct: number, level: ReputationLevel]

function expectTable(metric: 'cancellations' | 'incorrectShipments' | 'claims', period: number, cases: Case[]) {
  const t = thresholdsFor(CFG, metric, period)
  for (const [pct, level] of cases) {
    // por percentual (valor real, sem arredondar)
    expect({ pct, got: classifyPercentage(pct, t) }).toEqual({ pct, got: level })
    // por contagem: N ocorrências em 10.000 vendas reproduz o percentual exato
    expect({ pct, got: classifyCounts(Math.round(pct * 100), 10_000, t) }).toEqual({ pct, got: level })
  }
}

describe('cancelamentos — 60 dias', () => {
  it('1,50 verde · 1,51 amarelo · 3,50 amarelo · 3,51 laranja · 4,00 laranja · 4,01 vermelho', () => {
    expectTable('cancellations', 60, [
      [1.50, 'green'], [1.51, 'yellow'], [3.50, 'yellow'], [3.51, 'orange'], [4.00, 'orange'], [4.01, 'red'],
    ])
  })
})

describe('cancelamentos — 365 dias', () => {
  it('2,50 verde · 2,51 amarelo · 5,50 amarelo · 5,51 laranja · 6,50 laranja · 6,51 vermelho', () => {
    expectTable('cancellations', 365, [
      [2.50, 'green'], [2.51, 'yellow'], [5.50, 'yellow'], [5.51, 'orange'], [6.50, 'orange'], [6.51, 'red'],
    ])
  })
})

describe('envios incorretos — 60 dias', () => {
  it('10,00 verde · 10,01 amarelo · 18,00 amarelo · 18,01 laranja · 22,00 laranja · 22,01 vermelho', () => {
    expectTable('incorrectShipments', 60, [
      [10.00, 'green'], [10.01, 'yellow'], [18.00, 'yellow'], [18.01, 'orange'], [22.00, 'orange'], [22.01, 'red'],
    ])
  })
})

describe('envios incorretos — 365 dias', () => {
  it('13,00 verde · 13,01 amarelo · 23,50 amarelo · 23,51 laranja · 28,50 laranja · 28,51 vermelho', () => {
    expectTable('incorrectShipments', 365, [
      [13.00, 'green'], [13.01, 'yellow'], [23.50, 'yellow'], [23.51, 'orange'], [28.50, 'orange'], [28.51, 'red'],
    ])
  })
})

describe('reclamações — mesmos limites nos dois períodos', () => {
  it('2,00 verde · 2,01 amarelo · 4,50 amarelo · 4,51 laranja · 8,00 laranja · 8,01 vermelho', () => {
    const cases: Case[] = [[2.00, 'green'], [2.01, 'yellow'], [4.50, 'yellow'], [4.51, 'orange'], [8.00, 'orange'], [8.01, 'red']]
    expectTable('claims', 60, cases)
    expectTable('claims', 365, cases)
  })
})

describe('precisão — classifica com o valor real, arredonda só depois', () => {
  it('2,504% é amarelo mesmo que a tela mostre 2,50%', () => {
    const t = thresholdsFor(CFG, 'cancellations', 365)
    expect(classifyPercentage(2.504, t)).toBe('yellow')
    // 313 em 12.500 = 2,504%
    expect(classifyCounts(313, 12_500, t)).toBe('yellow')
    expect((313 / 12_500 * 100).toFixed(2)).toBe('2.50')
  })
  it('borda exata por contagem não sofre de ponto flutuante (3 em 200 = 1,5%)', () => {
    const t = thresholdsFor(CFG, 'cancellations', 60)
    expect(classifyCounts(3, 200, t)).toBe('green')
    expect(classifyCounts(3, 199, t)).toBe('yellow')
  })
})

// ── Troca automática de janela ───────────────────────────────────────────

describe('troca de janela recalcula tudo', () => {
  // 67 concluídas / 70 consideradas em 60d, 3 cancelamentos → 4,29% (365d: 300 vendas, 6 cancel → 2%)
  const short67 = { completed: 67, counted: 70, sellerCancelled: 3, claims: 1, shippingIssues: 5 }
  const long    = { completed: 300, counted: 306, sellerCancelled: 6, claims: 5, shippingIssues: 30 }

  it('67 vendas → 365d: usa denominador e limites de 365', () => {
    const r = computeReputation(input(short67, long), RULES_2026)
    expect(r.measurementPeriod).toBe(365)
    expect(r.salesConsidered).toBe(306)
    const c = r.metrics.cancellations
    expect(c.affectedSales).toBe(6)
    expect(c.greenLimit).toBe(2.5)
    expect(c.level).toBe('green')
    expect(r.metrics.incorrectShipments.greenLimit).toBe(13)
  })

  it('chega 1 venda → 68 → 60d: novo denominador, novas ocorrências, novos limites', () => {
    const short68 = { ...short67, completed: 68, counted: 71 }
    const r = computeReputation(input(short68, long), RULES_2026)
    expect(r.measurementPeriod).toBe(60)
    expect(r.salesConsidered).toBe(71)
    const c = r.metrics.cancellations
    expect(c.affectedSales).toBe(3)
    expect(c.greenLimit).toBe(1.5)
    expect(c.level).toBe('red')               // 3/71 = 4,23% > 4%
    expect(r.metrics.incorrectShipments.greenLimit).toBe(10)
    expect(r.metrics.incorrectShipments.level).toBe('green')   // 5/71 = 7,04%
  })

  it('uma venda antiga sai da janela → 67 → volta a 365d automaticamente', () => {
    const r = computeReputation(input(short67, long), RULES_2026)
    expect(r.measurementPeriod).toBe(365)
    expect(r.metrics.cancellations.level).toBe('green')
    expect(r.metrics.cancellations.greenLimit).toBe(2.5)
  })
})

// ── Margem, ocorrências restantes e vendas pra recuperar ─────────────────

describe('ocorrências que ainda cabem', () => {
  it('6 em 334, verde até 2,5% → cabem 2 (estático) e 2 (dinâmico)', () => {
    expect(remainingOccurrencesStatic(6, 334, 2.5)).toBe(2)    // 8/334 = 2,395% ✓ · 9/334 = 2,69% ✗
    expect(remainingOccurrencesDynamic(6, 334, 2.5)).toBe(2)   // 8/336 = 2,38% ✓ · 9/337 = 2,67% ✗
  })
  it('na borda exata cabe 0, não negativo', () => {
    expect(remainingOccurrencesStatic(3, 200, 1.5)).toBe(0)
    expect(remainingOccurrencesStatic(4, 200, 1.5)).toBe(0)
  })
  it('dinâmico pode caber mais que o estático quando o limite é alto', () => {
    // 10 em 100, limite 13%: estático 3 (13/100) · dinâmico 3 (13/103=12,6% ✓, 14/104=13,46% ✗)
    expect(remainingOccurrencesStatic(10, 100, 13)).toBe(3)
    expect(remainingOccurrencesDynamic(10, 100, 13)).toBe(3)
    // 0 em 50, limite 13%: estático 6 · dinâmico 7 (7/57 = 12,28%)
    expect(remainingOccurrencesStatic(0, 50, 13)).toBe(6)
    expect(remainingOccurrencesDynamic(0, 50, 13)).toBe(7)
  })
  it('sem vendas → null (não inventa margem)', () => {
    expect(remainingOccurrencesStatic(0, 0, 2.5)).toBeNull()
    expect(remainingOccurrencesDynamic(0, 0, 2.5)).toBeNull()
  })
})

describe('vendas necessárias pra voltar ao verde', () => {
  it('8 cancelamentos em 200 (4%) com verde 2,5% → 120 vendas limpas (8/320 = 2,5%)', () => {
    expect(salesToRecoverGreen(8, 200, 2.5)).toBe(120)
  })
  it('arredonda pra CIMA: 7 em 200 (3,5%) → 80 vendas (7/280 = 2,5%); 7 em 201 → 79', () => {
    expect(salesToRecoverGreen(7, 200, 2.5)).toBe(80)
    expect(salesToRecoverGreen(7, 201, 2.5)).toBe(79)
    // 9 em 200, verde 2,5: 9·100/2,5 = 360 → 160. 9 em 100, verde 2,0: 450 → 350
    expect(salesToRecoverGreen(9, 100, 2.0)).toBe(350)
    // caso não inteiro: 1 em 10, verde 1,5 → precisa total ≥ 66,67 → 67 → 57 vendas
    expect(salesToRecoverGreen(1, 10, 1.5)).toBe(57)
    expect(Number.isInteger(salesToRecoverGreen(1, 10, 1.5))).toBe(true)
  })
  it('já verde → 0; sem ocorrência → 0', () => {
    expect(salesToRecoverGreen(6, 334, 2.5)).toBe(0)
    expect(salesToRecoverGreen(0, 0, 2.5)).toBe(0)
  })
})

describe('risco preventivo (margem consumida da faixa)', () => {
  const risk = CFG.risk
  it('70% = atenção · 85% = alto · 95% = crítico', () => {
    expect(riskFromRatio(0.5,  risk)).toBe('safe')
    expect(riskFromRatio(0.70, risk)).toBe('attention')
    expect(riskFromRatio(0.85, risk)).toBe('high')
    expect(riskFromRatio(0.95, risk)).toBe('critical')
  })
  it('2,28% com verde 2,5% → atenção alta (91% da margem) e margem de 0,22 p.p.', () => {
    // 228 em 10.000, período 365 (menos de 68 em 60d)
    const r = computeReputation(input({ completed: 10, counted: 10 }, { completed: 10_000, counted: 10_000, sellerCancelled: 228 }), RULES_2026)
    const c = r.metrics.cancellations
    expect(c.level).toBe('green')
    expect(c.distancePercentagePoints).toBeCloseTo(0.22, 6)
    expect(c.marginUsedRatio).toBeCloseTo(0.912, 3)
    expect(c.riskLevel).toBe('high')
  })
  it('vermelho é sempre crítico; laranja no mínimo alto; amarelo no mínimo atenção', () => {
    const red    = computeReputation(input({ completed: 100, counted: 100, sellerCancelled: 5 }), RULES_2026).metrics.cancellations
    const orange = computeReputation(input({ completed: 1000, counted: 1000, sellerCancelled: 36 }), RULES_2026).metrics.cancellations
    const yellow = computeReputation(input({ completed: 1000, counted: 1000, sellerCancelled: 16 }), RULES_2026).metrics.cancellations
    expect(red.level).toBe('red');       expect(red.riskLevel).toBe('critical')
    expect(orange.level).toBe('orange'); expect(['high', 'critical']).toContain(orange.riskLevel)
    expect(yellow.level).toBe('yellow'); expect(['attention', 'high', 'critical']).toContain(yellow.riskLevel)
  })
  it('risco da conta é o pior entre as métricas; faixa geral é a pior faixa', () => {
    const r = computeReputation(input({ completed: 100, counted: 100, sellerCancelled: 0, claims: 9, shippingIssues: 0 }), RULES_2026)
    expect(r.metrics.claims.level).toBe('red')
    expect(r.overallLevel).toBe('red')
    expect(r.riskLevel).toBe('critical')
  })
})

// ── Divisão por zero / sem dados ─────────────────────────────────────────

describe('conta sem vendas', () => {
  it('não divide por zero: percentual null, faixa e risco desconhecidos', () => {
    const r = computeReputation(input({}), RULES_2026)
    expect(r.measurementPeriod).toBe(365)
    for (const m of Object.values(r.metrics)) {
      expect(m.percentage).toBeNull()
      expect(m.level).toBe('unknown')
      expect(m.riskLevel).toBe('unknown')
    }
    expect(r.overallLevel).toBe('unknown')
  })
})

// ── Previsão de troca de período pelas datas reais ───────────────────────

describe('previsão 60 → 365 pela saída de vendas da janela', () => {
  const day = (n: number) => new Date(AS_OF.getTime() - (60 - n) * 86_400_000).toISOString()  // sai da janela em n dias
  it('70 vendas e 5 saindo em 48h → cai em ~2 dias se não vender', () => {
    const exits = [day(0.5), day(1), day(1.5), day(2), day(2), day(9)]
    const f = forecastPeriodChange(70, exits, CFG, AS_OF)
    expect(f?.kind).toBe('may_drop_to_long')
    expect(f?.dropInDays).toBeCloseTo(1.5, 1)   // 3ª saída derruba de 70 pra 67
  })
  it('sem saídas suficientes no horizonte → estável', () => {
    const f = forecastPeriodChange(100, [day(1), day(2)], CFG, AS_OF)
    expect(f?.kind).toBe('stable')
  })
  it('conta já em 365d não tem queda a prever', () => {
    expect(forecastPeriodChange(50, [day(1)], CFG, AS_OF)).toBeNull()
  })
})

// ── Vigência das regras ──────────────────────────────────────────────────

describe('regras versionadas', () => {
  it('antes de 10/09/2026 vale a regra anterior; a partir dela, a nova', () => {
    expect(resolveRuleSet(BUILTIN_RULE_SETS, '2026-09-09').name).toBe(ML_RULE_SET_LEGACY_NAME)
    expect(resolveRuleSet(BUILTIN_RULE_SETS, '2026-09-10').name).toBe(ML_RULE_SET_2026_09_NAME)
    expect(resolveRuleSet(BUILTIN_RULE_SETS, '2027-01-01').name).toBe(ML_RULE_SET_2026_09_NAME)
  })
  it('a próxima regra fica disponível como simulação antes da vigência', () => {
    expect(resolveUpcomingRuleSet(BUILTIN_RULE_SETS, '2026-08-21')?.name).toBe(ML_RULE_SET_2026_09_NAME)
    expect(resolveUpcomingRuleSet(BUILTIN_RULE_SETS, '2026-09-10')).toBeNull()
  })
  it('o resultado registra qual regra foi usada (auditoria)', () => {
    const r = computeReputation(input({ completed: 1, counted: 1 }), RULES_LEGACY)
    expect(r.ruleSet.name).toBe(ML_RULE_SET_LEGACY_NAME)
    expect(r.ruleSet.effectiveUntil).toBe('2026-09-09')
  })
  it('config do banco é validado antes de usar', () => {
    expect(isValidRuleSetConfig(CFG)).toBe(true)
    expect(isValidRuleSetConfig({ ...CFG, metrics: { ...CFG.metrics, claims: {} } })).toBe(false)
    expect(isValidRuleSetConfig(null)).toBe(false)
  })
  it('data civil em São Paulo não vira o dia às 21h (UTC−3)', () => {
    expect(toSaoPauloDate(new Date('2026-09-10T01:30:00.000Z'))).toBe('2026-09-09')
    expect(toSaoPauloDate(new Date('2026-09-10T03:30:00.000Z'))).toBe('2026-09-10')
  })
})

// ── Oficial × local ──────────────────────────────────────────────────────

describe('dados oficiais do ML', () => {
  it('converte fração 0-1 pra p.p. uma única vez e marca divergência relevante', () => {
    const official = officialFromRow({ cancellations_rate: '0.0100', claims_rate: 0.02, delayed_handling_rate: null, level_id: '5_green' })
    expect(official?.cancellations.percentage).toBeCloseTo(1.0, 9)
    expect(official?.delayedHandling.percentage).toBeNull()
    // local 3% vs oficial 1% → delta 2 p.p., 200% relativo → significativa
    const r = computeReputation(input({ completed: 100, counted: 100, sellerCancelled: 3, claims: 2 }, undefined, { official }), RULES_2026)
    expect(r.metrics.cancellations.divergence?.significant).toBe(true)
    expect(r.metrics.claims.divergence?.significant).toBe(false)
  })
})

// ── Simulador ────────────────────────────────────────────────────────────

describe('simulador (só visual)', () => {
  const base = input({ completed: 100, counted: 100, sellerCancelled: 1 })
  it('+2 cancelamentos muda a faixa e informa a margem nova', () => {
    expect(computeReputation(base, RULES_2026).metrics.cancellations.level).toBe('green')  // 1%
    const sim = simulateReputation(base, RULES_2026, { extraOccurrences: { cancellations: 2 } })
    expect(sim.metrics.cancellations.affectedSales).toBe(3)
    expect(sim.metrics.cancellations.totalSales).toBe(102)   // cada cancelamento foi uma venda
    expect(sim.metrics.cancellations.level).toBe('yellow')   // 2,94%
  })
  it('+50 vendas sem problemas dilui o índice', () => {
    const sim = simulateReputation(input({ completed: 100, counted: 100, sellerCancelled: 2 }), RULES_2026, { extraSales: 50 })
    expect(sim.metrics.cancellations.totalSales).toBe(150)
    expect(sim.metrics.cancellations.percentage).toBeCloseTo(1.3333, 3)
    expect(sim.metrics.cancellations.level).toBe('green')
  })
  it('não altera a entrada original', () => {
    simulateReputation(base, RULES_2026, { extraOccurrences: { claims: 5 }, extraSales: 10 })
    expect(base.short.claims).toBe(0)
    expect(base.short.counted).toBe(100)
  })
})
