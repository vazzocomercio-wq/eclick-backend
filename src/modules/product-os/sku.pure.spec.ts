import {
  ALPHA_KINDS, KINDS, PARENT_KIND, buildBase, buildVariantSku, deriveAlphaCode,
  normLabel, sanitizeAlphaCode, variationAttributes, variationType, variationValue,
} from './sku.pure'

describe('SKU — formato', () => {
  it('monta o base como MARCA-MIOLO', () => {
    expect(buildBase('VZ', '07', '01', '02', '02')).toBe('VZ-07010202')
  })

  // A regressão que mais custa caro: todo SKU já publicado é permanente
  // (pedidos/anúncios/analytics penduram nele). Sem tamanho, NADA muda.
  it('sem tamanho, o SKU sai base-cor — idêntico ao de antes do eixo novo', () => {
    expect(buildVariantSku('VZ-07010202', '47')).toBe('VZ-07010202-47')
    expect(buildVariantSku('VZ-07010202', '47', null)).toBe('VZ-07010202-47')
    expect(buildVariantSku('VZ-07010202', '47', '')).toBe('VZ-07010202-47')
    expect(buildVariantSku('VZ-07010202', '47', '   ')).toBe('VZ-07010202-47')
  })

  it('com tamanho, o SKU sufixa na ordem base-cor-tamanho', () => {
    expect(buildVariantSku('VZ-07010202', '47', 'G')).toBe('VZ-07010202-47-G')
    expect(buildVariantSku('VZ-07010202', '47', 'GG')).toBe('VZ-07010202-47-GG')
  })

  it('a mesma cor em tamanhos diferentes gera SKUs distintos', () => {
    const g = buildVariantSku('VZ-07010202', '47', 'G')
    const m = buildVariantSku('VZ-07010202', '47', 'M')
    expect(g).not.toBe(m)
  })
})

describe('SKU — códigos', () => {
  it('deriva o código do tamanho a partir do rótulo', () => {
    expect(deriveAlphaCode('Grande')).toBe('G')
    expect(deriveAlphaCode('Médio')).toBe('M')     // acento não vira código
    expect(deriveAlphaCode('Pequeno')).toBe('P')
    expect(deriveAlphaCode('GG')).toBe('GG')       // rótulo curto = o próprio código
    expect(deriveAlphaCode('XL')).toBe('XL')
  })

  it('devolve vazio quando não sobra nada utilizável', () => {
    expect(deriveAlphaCode('')).toBe('')
    expect(deriveAlphaCode('   ')).toBe('')
    expect(deriveAlphaCode('!!!')).toBe('')
  })

  it('sanitiza código digitado (acento, minúscula, símbolo, tamanho)', () => {
    expect(sanitizeAlphaCode('vz')).toBe('VZ')
    expect(sanitizeAlphaCode('g-1')).toBe('G1')
    expect(sanitizeAlphaCode('ÁB')).toBe('AB')
    expect(sanitizeAlphaCode('ABCDEF')).toBe('ABC')  // trava em 3
  })

  it('normaliza rótulo ignorando acento e caixa (Giratório ≡ Giratorio)', () => {
    expect(normLabel('Giratório')).toBe(normLabel('giratorio'))
    expect(normLabel('  Nature   Bath ')).toBe('nature bath')
  })
})

describe('SKU — taxonomia', () => {
  it('tamanho é um kind válido, de topo e alfanumérico', () => {
    expect(KINDS).toContain('tamanho')
    expect(PARENT_KIND.tamanho).toBeNull()     // eixo ortogonal, não pendura em linha
    expect(ALPHA_KINDS).toContain('tamanho')
  })

  it('cor continua sendo eixo de topo', () => {
    expect(PARENT_KIND.cor).toBeNull()
  })
})

describe('Catálogo — variations[]', () => {
  const creme = { corLabel: 'Creme' }
  const cremeG = { corLabel: 'Creme', tamanhoLabel: 'G' }
  const cremeM = { corLabel: 'Creme', tamanhoLabel: 'M' }

  // Zero regressão: produto de 1 eixo tem que sair byte-a-byte como saía.
  it('1 eixo → type Cor e value = a cor, como sempre', () => {
    expect(variationType([creme])).toBe('Cor')
    expect(variationValue(creme)).toBe('Creme')
    expect(variationAttributes(creme)).toEqual({ Cor: 'Creme' })
  })

  it('2 eixos → type Cor + Tamanho e value combinado', () => {
    expect(variationType([cremeG, cremeM])).toBe('Cor + Tamanho')
    expect(variationValue(cremeG)).toBe('Creme / G')
  })

  it('attributes decompõe o que value não decompõe', () => {
    expect(variationAttributes(cremeG)).toEqual({ Cor: 'Creme', Tamanho: 'G' })
  })

  // O type é o TIER da Shopee e o rótulo do dropdown: tem que ser um só no
  // produto inteiro. Se cada linha escolhesse o seu, o anúncio sairia com dois
  // tiers concorrentes.
  it('o type é uniforme no produto — qualquer variante com tamanho decide', () => {
    expect(variationType([creme, cremeG])).toBe('Cor + Tamanho')
  })

  it('tamanho em branco não conta como eixo', () => {
    expect(variationType([{ corLabel: 'Creme', tamanhoLabel: '' }])).toBe('Cor')
    expect(variationType([{ corLabel: 'Creme', tamanhoLabel: '  ' }])).toBe('Cor')
    expect(variationValue({ corLabel: 'Creme', tamanhoLabel: null })).toBe('Creme')
  })

  // Cada combinação precisa de um value ÚNICO: é ele que vira opção no
  // dropdown do comprador. Repetido = duas opções "Creme" indistinguíveis.
  it('as 4 combinações de 2 cores × 2 tamanhos têm values distintos', () => {
    const combos = [
      { corLabel: 'Creme', tamanhoLabel: 'G' }, { corLabel: 'Creme', tamanhoLabel: 'M' },
      { corLabel: 'Marrom', tamanhoLabel: 'G' }, { corLabel: 'Marrom', tamanhoLabel: 'M' },
    ]
    const values = combos.map(variationValue)
    expect(new Set(values).size).toBe(4)
  })
})
