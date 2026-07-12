import { Injectable, Logger, BadRequestException, UnauthorizedException, OnModuleInit } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { BaileysProvider } from '../channels/providers/baileys.provider'

/**
 * Custos de Produção 3D — custeio por absorção (R$/g).
 * Porta 1:1 do motor validado em vazzo-produtos-3d (lib/custos.py):
 *
 *   custo da peça = variáveis/(1−falha) + gramas × fixo_por_g + embalagem + MO
 *     variáveis  = filamento×(1+purga) + horas×(energia_do_MATERIAL + depreciação + manutenção)
 *     fixo_por_g = total de custos fixos do mês ÷ gramas BOAS do mês
 *     gramas boas = horas_mês × g/h média (dos SKUs reais) × (1−falha)
 *
 * Energia varia por FAMÍLIA de material (PLA 95W ≠ ABS 200W na A1); variantes
 * resolvem por prefixo (PLA-SILK → PLA). NÃO inclui custo de venda (comissão,
 * frete, ads) — é outro estágio. selftest() prova a matemática no boot.
 */

// ── Types (espelham as tabelas prod3d_*) ─────────────────────────────────────
export interface Prod3dConfig {
  id: string
  tarifa_kwh: number;               tarifa_kwh_estimado: boolean
  taxa_falha: number;               fator_purga_ams: number;      perdas_estimado: boolean
  manutencao_hora: number;          manutencao_estimado: boolean
  mo_custo_hora: number;            mo_minutos_padrao: number
  horas_mes_por_impressora: number; g_por_hora_fallback: number;  producao_estimado: boolean
  alerta_whatsapp: string | null;   watchdog_key: string
}
export interface Impressora {
  id: string; modelo: string; quantidade: number; valor_pago: number
  vida_util_horas: number; potencia_ams_w: number; estimado: boolean; is_active: boolean
}
export interface Potencia { id: string; impressora_id: string; material: string; watts: number; estimado: boolean; fonte: string | null }
export interface CustoFixo { id: string; nome: string; valor_mensal: number; categoria: string; estimado: boolean }
export interface Filamento { id: string; material: string; preco_kg: number; estimado: boolean }
export interface Embalagem { id: string; codigo: string; descricao: string; unidade: string; preco: number; qtd_padrao: number; estimado: boolean }
export interface Sku { id: string; sku: string; projeto: string | null; gramas: number; horas: number; material: string }

export interface Prod3dData {
  config: Prod3dConfig
  impressoras: Impressora[]
  potencias: Potencia[]
  fixos: CustoFixo[]
  filamentos: Filamento[]
  embalagens: Embalagem[]
  skus: Sku[]
}

export const CATEGORIAS_FIXOS = ['aluguel', 'impostos', 'pessoal', 'servicos', 'insumos', 'outros']

// campo da UI → { coluna, coluna de flag estimado (limpa ao confirmar) }
const CONFIG_CAMPOS: Record<string, { col: keyof Prod3dConfig; flag?: keyof Prod3dConfig }> = {
  kwh:         { col: 'tarifa_kwh',               flag: 'tarifa_kwh_estimado' },
  falha:       { col: 'taxa_falha',               flag: 'perdas_estimado' },
  purga:       { col: 'fator_purga_ams',          flag: 'perdas_estimado' },
  manutencao:  { col: 'manutencao_hora',          flag: 'manutencao_estimado' },
  mo_hora:     { col: 'mo_custo_hora' },
  mo_minutos:  { col: 'mo_minutos_padrao' },
  horas_mes:   { col: 'horas_mes_por_impressora', flag: 'producao_estimado' },
}

@Injectable()
export class Prod3dService implements OnModuleInit {
  private readonly logger = new Logger(Prod3dService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly whatsapp: WhatsAppSender,
    private readonly baileys: BaileysProvider,
  ) {}

  onModuleInit() {
    try {
      this.selftest()
      this.logger.log('[prod3d] selftest do motor de custos PASSOU')
    } catch (e: unknown) {
      this.logger.error(`[prod3d] SELFTEST FALHOU — motor calculando errado! ${(e as Error).message}`)
    }
  }

  // ── Carga ──────────────────────────────────────────────────────────────────
  async loadAll(orgId: string): Promise<Prod3dData> {
    let { data: config } = await supabaseAdmin.from('prod3d_config')
      .select('*').eq('organization_id', orgId).maybeSingle()
    if (!config) {
      // primeira visita da org: cria a row de parâmetros com defaults do schema
      const ins = await supabaseAdmin.from('prod3d_config')
        .insert({ organization_id: orgId }).select('*').single()
      config = ins.data
    }
    const [imp, pot, fix, fil, emb, skus] = await Promise.all([
      supabaseAdmin.from('prod3d_impressoras').select('*').eq('organization_id', orgId).eq('is_active', true).order('created_at'),
      supabaseAdmin.from('prod3d_potencias').select('*').eq('organization_id', orgId),
      supabaseAdmin.from('prod3d_custos_fixos').select('*').eq('organization_id', orgId).order('valor_mensal', { ascending: false }),
      supabaseAdmin.from('prod3d_filamentos').select('*').eq('organization_id', orgId).order('material'),
      supabaseAdmin.from('prod3d_embalagens').select('*').eq('organization_id', orgId).order('codigo'),
      supabaseAdmin.from('prod3d_skus').select('*').eq('organization_id', orgId).order('sku'),
    ])
    return {
      config: config as Prod3dConfig,
      impressoras: (imp.data ?? []) as Impressora[],
      potencias: (pot.data ?? []) as Potencia[],
      fixos: (fix.data ?? []) as CustoFixo[],
      filamentos: (fil.data ?? []) as Filamento[],
      embalagens: (emb.data ?? []) as Embalagem[],
      skus: (skus.data ?? []) as Sku[],
    }
  }

  // ── Motor (funções puras — mesmas contas do Python) ────────────────────────

  /** Resolve o material pra FAMÍLIA de potência: match exato, senão a família
   * que é prefixo do nome (PLA-SILK → PLA). Sem família → PLA (check avisa). */
  familiaEnergia(familias: string[], material: string): string {
    if (familias.includes(material)) return material
    const porTamanho = [...familias].sort((a, b) => b.length - a.length)
    for (const base of porTamanho) if (material.startsWith(base)) return base
    return 'PLA'
  }

  private potenciaW(d: Prod3dData, imp: Impressora, material: string): number {
    const tab = d.potencias.filter(p => p.impressora_id === imp.id)
    if (!tab.length) return 0
    const fam = this.familiaEnergia(tab.map(p => p.material), material)
    const ent = tab.find(p => p.material === fam) ?? tab.find(p => p.material === 'PLA') ?? tab[0]
    return ent.watts + (imp.potencia_ams_w || 0)
  }

  /** R$/hora de impressora LIGADA imprimindo `material` (média ponderada da frota). */
  custoHoraMaquina(d: Prod3dData, material = 'PLA') {
    const imps = d.impressoras
    const totQtd = imps.reduce((s, i) => s + i.quantidade, 0)
    if (!totQtd) return { energia: 0, depreciacao: 0, manutencao: d.config.manutencao_hora, total: d.config.manutencao_hora }
    const energia = imps.reduce((s, i) => s + this.potenciaW(d, i, material) / 1000 * d.config.tarifa_kwh * i.quantidade, 0) / totQtd
    const depreciacao = imps.reduce((s, i) => s + i.valor_pago / i.vida_util_horas * i.quantidade, 0) / totQtd
    const manutencao = d.config.manutencao_hora
    return { energia, depreciacao, manutencao, total: energia + depreciacao + manutencao }
  }

  /** g/h média ponderada dos SKUs reais (Σg/Σh); fallback do parâmetro sem SKUs. */
  gPorHoraMedia(d: Prod3dData): { gh: number; origem: string } {
    const totG = d.skus.reduce((s, k) => s + k.gramas, 0)
    const totH = d.skus.reduce((s, k) => s + k.horas, 0)
    if (totH > 0) return { gh: totG / totH, origem: `média ponderada de ${d.skus.length} SKUs fatiados` }
    return { gh: d.config.g_por_hora_fallback, origem: 'fallback do parâmetro (nenhum SKU cadastrado)' }
  }

  capacidadeMensal(d: Prod3dData) {
    const n = d.impressoras.reduce((s, i) => s + i.quantidade, 0)
    const horas = d.config.horas_mes_por_impressora * n
    const { gh, origem } = this.gPorHoraMedia(d)
    const gBrutas = horas * gh
    const gBoas = gBrutas * (1 - d.config.taxa_falha)
    return { impressoras: n, horas_mes: horas, g_por_hora: gh, origem_g_por_hora: origem, g_brutas_mes: gBrutas, g_boas_mes: gBoas }
  }

  totalFixosMensal(d: Prod3dData) {
    const porCategoria: Record<string, number> = {}
    for (const f of d.fixos) porCategoria[f.categoria] = (porCategoria[f.categoria] ?? 0) + f.valor_mensal
    return { total: d.fixos.reduce((s, f) => s + f.valor_mensal, 0), por_categoria: porCategoria }
  }

  custoFixoPorGrama(d: Prod3dData): number {
    const gBoas = this.capacidadeMensal(d).g_boas_mes
    return gBoas > 0 ? this.totalFixosMensal(d).total / gBoas : 0
  }

  private precoFilamentoPorG(d: Prod3dData, material: string): number {
    const fil = d.filamentos.find(f => f.material === material)
    if (!fil) throw new BadRequestException(
      `Filamento '${material}' não cadastrado — cadastre o preço em Filamentos antes de usar.`)
    return fil.preco_kg / 1000
  }

  /** Embalagem padrão de 1 peça = Σ (preço × qtd_padrao). */
  custoEmbalagemPadrao(d: Prod3dData): number {
    return d.embalagens.reduce((s, e) => s + e.preco * (e.qtd_padrao || 0), 0)
  }

  /** Custo de produção COMPLETO de 1 peça boa, com breakdown. */
  custoPeca(d: Prod3dData, gramas: number, horas: number, material = 'PLA', minutosMo?: number) {
    const c = d.config
    const sobrevive = 1 - c.taxa_falha
    const filamento = gramas * this.precoFilamentoPorG(d, material) * (1 + c.fator_purga_ams) / sobrevive
    const hm = this.custoHoraMaquina(d, material)
    const energia = horas * hm.energia / sobrevive
    const depreciacao = horas * hm.depreciacao / sobrevive
    const manutencao = horas * hm.manutencao / sobrevive
    const fixo = gramas * this.custoFixoPorGrama(d)
    const maoDeObra = (minutosMo ?? c.mo_minutos_padrao) * c.mo_custo_hora / 60
    const embalagem = this.custoEmbalagemPadrao(d)
    const total = filamento + energia + depreciacao + manutencao + fixo + maoDeObra + embalagem
    return {
      gramas, horas, material, filamento, energia, depreciacao, manutencao,
      fixo_rateado: fixo, mao_de_obra: maoDeObra, embalagem,
      total, por_grama: gramas > 0 ? total / gramas : 0,
    }
  }

  /** O número-resumo: R$ por grama BOA produzida, decomposto (mix real dos SKUs). */
  custoPorGramaGeral(d: Prod3dData) {
    const c = d.config
    const cap = this.capacidadeMensal(d)
    const sobrevive = 1 - c.taxa_falha
    const hm = this.custoHoraMaquina(d)
    const totG = d.skus.reduce((s, k) => s + k.gramas, 0)
    const totH = d.skus.reduce((s, k) => s + k.horas, 0)
    const precoGMix = totG > 0
      ? d.skus.reduce((s, k) => s + k.gramas * this.precoFilamentoPorGSafe(d, k.material), 0) / totG
      : this.precoFilamentoPorGSafe(d, 'PLA')
    const energiaH = totH > 0
      ? d.skus.reduce((s, k) => s + k.horas * this.custoHoraMaquina(d, k.material).energia, 0) / totH
      : hm.energia
    const porGDeHora = (custoH: number) => cap.g_por_hora > 0 ? custoH / cap.g_por_hora / sobrevive : 0
    const comp = {
      filamento: precoGMix * (1 + c.fator_purga_ams) / sobrevive,
      energia: porGDeHora(energiaH),
      depreciacao: porGDeHora(hm.depreciacao),
      manutencao: porGDeHora(hm.manutencao),
      fixo_rateado: this.custoFixoPorGrama(d),
    }
    return { ...comp, total: comp.filamento + comp.energia + comp.depreciacao + comp.manutencao + comp.fixo_rateado }
  }

  private precoFilamentoPorGSafe(d: Prod3dData, material: string): number {
    try { return this.precoFilamentoPorG(d, material) } catch { return 0 }
  }

  // ── Auditoria de configuração (check) ──────────────────────────────────────
  check(d: Prod3dData): Array<[nivel: 'ERRO' | 'AVISO' | 'ESTIMADO', msg: string]> {
    const p: Array<['ERRO' | 'AVISO' | 'ESTIMADO', string]> = []
    const c = d.config
    if (c.tarifa_kwh <= 0) p.push(['ERRO', 'Tarifa de kWh ≤ 0 — ajuste em Energia.'])
    if (c.horas_mes_por_impressora <= 0) p.push(['ERRO', 'Horas de impressão/mês ≤ 0.'])
    else if (c.horas_mes_por_impressora > 744) p.push(['ERRO', `${c.horas_mes_por_impressora}h/mês > horas de um mês (744).`])
    else if (c.horas_mes_por_impressora > 595) p.push(['AVISO', `${c.horas_mes_por_impressora}h/mês por impressora = >80% de utilização 24/7. Realista?`])
    if (!d.impressoras.length) p.push(['ERRO', 'Nenhuma impressora cadastrada — o custo de máquina está zerado.'])
    for (const i of d.impressoras) {
      const tab = d.potencias.filter(x => x.impressora_id === i.id)
      if (!tab.some(x => x.material === 'PLA'))
        p.push(['ERRO', `Impressora '${i.modelo}': cadastre ao menos a potência de PLA.`])
    }
    if (!this.totalFixosMensal(d).total) p.push(['AVISO', 'Nenhum custo fixo mensal cadastrado — o rateio por grama está em zero.'])
    const temPessoalFixo = (this.totalFixosMensal(d).por_categoria['pessoal'] ?? 0) > 0
    if (temPessoalFixo && c.mo_custo_hora > 0)
      p.push(['AVISO', 'Pessoal está nos custos fixos E mão de obra direta > 0: risco de CONTAR O FUNCIONÁRIO DUAS VEZES. Zere um dos dois.'])
    if (this.gPorHoraMedia(d).origem.includes('fallback'))
      p.push(['AVISO', 'g/h média vem de estimativa — cadastre SKUs fatiados para usar dado real.'])
    for (const s of d.skus) {
      if (!d.filamentos.some(f => f.material === s.material))
        p.push(['ERRO', `SKU '${s.sku}': filamento '${s.material}' sem preço cadastrado.`])
      for (const i of d.impressoras) {
        const fams = d.potencias.filter(x => x.impressora_id === i.id).map(x => x.material)
        if (fams.length && this.familiaEnergia(fams, s.material) === 'PLA' && !s.material.startsWith('PLA'))
          p.push(['AVISO', `SKU '${s.sku}': sem família de potência p/ ${s.material} na '${i.modelo}' — energia calculada como PLA.`])
      }
    }
    // pendências de confirmação (valores estimados)
    if (c.tarifa_kwh_estimado) p.push(['ESTIMADO', `Tarifa kWh R$ ${c.tarifa_kwh} — confirme na conta de luz (total da conta ÷ kWh do mês).`])
    for (const i of d.impressoras) if (i.estimado) p.push(['ESTIMADO', `Impressora '${i.modelo}': valor pago/vida útil estimados.`])
    for (const x of d.potencias) if (x.estimado) {
      const imp = d.impressoras.find(i => i.id === x.impressora_id)
      p.push(['ESTIMADO', `Potência de ${x.material} na '${imp?.modelo ?? '?'}' (${x.watts}W) é estimada — meça com tomada medidora.`])
    }
    if (c.producao_estimado) p.push(['ESTIMADO', 'Horas de impressão/mês estimadas — ajuste com o histórico real.'])
    if (c.perdas_estimado) p.push(['ESTIMADO', 'Taxa de falha e purga AMS estimadas — meça algumas semanas de produção.'])
    if (c.manutencao_estimado) p.push(['ESTIMADO', 'Custo de manutenção por hora estimado.'])
    for (const f of d.filamentos) if (f.estimado) p.push(['ESTIMADO', `Preço do filamento ${f.material} (R$ ${f.preco_kg}/kg) — confirme na compra.`])
    for (const e of d.embalagens) if (e.estimado) p.push(['ESTIMADO', `Embalagem '${e.codigo}' (R$ ${e.preco}/${e.unidade}) — confirme na compra.`])
    for (const f of d.fixos) if (f.estimado) p.push(['ESTIMADO', `Custo fixo '${f.nome}' (R$ ${f.valor_mensal}/mês) — confirme.`])
    return p
  }

  /** Payload completo pra tela: cadastros + KPIs + custo por SKU + auditoria. */
  async dados(orgId: string) {
    const d = await this.loadAll(orgId)
    let kpis: Record<string, unknown> | null = null
    let skuCustos: Array<Record<string, unknown> | null> = []
    try {
      kpis = {
        custo_g: this.custoPorGramaGeral(d),
        hm_pla: this.custoHoraMaquina(d, 'PLA'),
        fixos: this.totalFixosMensal(d),
        cap: this.capacidadeMensal(d),
      }
      skuCustos = d.skus.map(s => {
        try { return this.custoPeca(d, s.gramas, s.horas, s.material) } catch { return null }
      })
    } catch (e: unknown) {
      this.logger.warn(`[prod3d.dados] KPIs indisponíveis: ${(e as Error).message}`)
    }
    return { ...d, kpis, sku_custos: skuCustos, problemas: this.check(d) }
  }

  // ── Mutações (todas auditadas em prod3d_historico) ─────────────────────────
  private async auditar(orgId: string, userId: string | null, acao: string, detalhe: Record<string, unknown>) {
    await supabaseAdmin.from('prod3d_historico').insert({ organization_id: orgId, user_id: userId, acao, detalhe })
  }

  async setConfig(orgId: string, userId: string | null, campo: string, valor: number) {
    const def = CONFIG_CAMPOS[campo]
    if (!def) throw new BadRequestException(`Campo desconhecido: ${campo} (use ${Object.keys(CONFIG_CAMPOS).join(', ')})`)
    if (!Number.isFinite(valor)) throw new BadRequestException('Valor inválido.')
    if ((campo === 'falha' || campo === 'purga') && (valor < 0 || valor >= 1))
      throw new BadRequestException('Falha/purga deve estar entre 0 e 1 (ex.: 0.05 = 5%).')
    const d = await this.loadAll(orgId)
    const antes = d.config[def.col]
    const patch: Record<string, unknown> = { [def.col]: valor }
    if (def.flag) patch[def.flag] = false
    const { error } = await supabaseAdmin.from('prod3d_config').update(patch).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'config.set', { campo, de: antes, para: valor })
    return { ok: true }
  }

  async setImpressora(orgId: string, userId: string | null, id: string, campo: string, valor: number) {
    const permitidos = ['valor_pago', 'vida_util_horas', 'quantidade', 'potencia_ams_w']
    if (!permitidos.includes(campo)) throw new BadRequestException(`Campo de impressora desconhecido: ${campo}`)
    const patch: Record<string, unknown> = { [campo]: valor }
    if (campo === 'valor_pago' || campo === 'vida_util_horas') patch['estimado'] = false
    const { error } = await supabaseAdmin.from('prod3d_impressoras')
      .update(patch).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'impressora.set', { id, campo, para: valor })
    return { ok: true }
  }

  async addImpressora(orgId: string, userId: string | null, b: { modelo: string; quantidade?: number; valor_pago?: number; vida_util_horas?: number; potencia_ams_w?: number }) {
    if (!b.modelo?.trim()) throw new BadRequestException('Informe o modelo da impressora.')
    const { data, error } = await supabaseAdmin.from('prod3d_impressoras').insert({
      organization_id: orgId, modelo: b.modelo.trim(), quantidade: b.quantidade ?? 1,
      valor_pago: b.valor_pago ?? 0, vida_util_horas: b.vida_util_horas ?? 6000,
      potencia_ams_w: b.potencia_ams_w ?? 0, estimado: true,
    }).select('id').single()
    if (error) throw new BadRequestException(error.message.includes('duplicate') ? 'Já existe impressora com esse modelo.' : error.message)
    await this.auditar(orgId, userId, 'impressora.add', { modelo: b.modelo })
    return { ok: true, id: data?.id }
  }

  async setPotencia(orgId: string, userId: string | null, b: { impressora_id: string; material: string; watts: number; fonte?: string }) {
    const mat = b.material?.trim().toUpperCase()
    if (!mat) throw new BadRequestException('Informe o material.')
    if (!Number.isFinite(b.watts) || b.watts <= 0) throw new BadRequestException('Watts deve ser > 0.')
    const { error } = await supabaseAdmin.from('prod3d_potencias').upsert({
      organization_id: orgId, impressora_id: b.impressora_id, material: mat,
      watts: b.watts, estimado: false,
      fonte: b.fonte?.trim() || 'confirmado na tela de custos',
    }, { onConflict: 'organization_id,impressora_id,material' })
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'potencia.set', { material: mat, para: b.watts })
    return { ok: true }
  }

  /** Sem categoria informada, a IA classifica pelo nome (haiku, jsonMode).
   * Falha de IA nunca bloqueia o cadastro — cai em 'outros'. */
  private async classificarCategoria(orgId: string, nome: string): Promise<{ cat: string; porIa: boolean }> {
    try {
      const r = await this.llm.generateText({
        orgId, feature: 'prod3d_categoria', jsonMode: true, maxTokens: 60, temperature: 0,
        systemPrompt: 'Você classifica custos fixos mensais de uma fábrica de impressão 3D. ' +
          `Responda SÓ JSON {"categoria": "..."} com uma de: ${CATEGORIAS_FIXOS.join(', ')}. ` +
          'aluguel=espaço físico; impostos=tributos fixos; pessoal=salários/encargos; ' +
          'servicos=contador/internet/energia fixa/seguros; insumos=materiais de bancada; outros=resto.',
        userPrompt: `Custo: "${nome}"`,
      })
      const cat = String((JSON.parse(r.text) as { categoria?: string })?.categoria ?? '').toLowerCase()
      if (CATEGORIAS_FIXOS.includes(cat)) return { cat, porIa: true }
    } catch (e: unknown) {
      this.logger.warn(`[prod3d] classificação IA falhou: ${(e as Error).message}`)
    }
    return { cat: 'outros', porIa: false }
  }

  async addFixo(orgId: string, userId: string | null, b: { nome: string; valor_mensal: number; categoria?: string }) {
    if (!b.nome?.trim()) throw new BadRequestException('Dê um nome ao custo.')
    let cat = b.categoria
    let porIa = false
    if (!cat) ({ cat, porIa } = await this.classificarCategoria(orgId, b.nome.trim()))
    if (!CATEGORIAS_FIXOS.includes(cat)) throw new BadRequestException(`Categoria inválida (${CATEGORIAS_FIXOS.join(', ')}).`)
    const { error } = await supabaseAdmin.from('prod3d_custos_fixos').insert({
      organization_id: orgId, nome: b.nome.trim(), valor_mensal: b.valor_mensal, categoria: cat, estimado: false,
    })
    if (error) throw new BadRequestException(error.message.includes('duplicate') ? 'Já existe um custo com esse nome — edite o valor na tabela.' : error.message)
    await this.auditar(orgId, userId, 'fixo.add', { nome: b.nome, valor: b.valor_mensal, categoria: cat, categoria_por_ia: porIa })
    return { ok: true, categoria: cat, categoria_por_ia: porIa }
  }

  async setFixo(orgId: string, userId: string | null, id: string, valorMensal: number) {
    const { data: antes } = await supabaseAdmin.from('prod3d_custos_fixos')
      .select('nome, valor_mensal').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!antes) throw new BadRequestException('Custo fixo não encontrado.')
    const { error } = await supabaseAdmin.from('prod3d_custos_fixos')
      .update({ valor_mensal: valorMensal, estimado: false }).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'fixo.set', { nome: antes.nome, de: antes.valor_mensal, para: valorMensal })
    return { ok: true }
  }

  async rmFixo(orgId: string, userId: string | null, id: string) {
    const { data: antes } = await supabaseAdmin.from('prod3d_custos_fixos')
      .select('nome, valor_mensal').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!antes) throw new BadRequestException('Custo fixo não encontrado.')
    await supabaseAdmin.from('prod3d_custos_fixos').delete().eq('id', id).eq('organization_id', orgId)
    await this.auditar(orgId, userId, 'fixo.rm', { nome: antes.nome, valor: antes.valor_mensal })
    return { ok: true }
  }

  async setFilamento(orgId: string, userId: string | null, material: string, precoKg: number) {
    const mat = material?.trim().toUpperCase()
    if (!mat) throw new BadRequestException('Informe o material.')
    if (!Number.isFinite(precoKg) || precoKg < 0) throw new BadRequestException('Preço inválido.')
    const { error } = await supabaseAdmin.from('prod3d_filamentos').upsert({
      organization_id: orgId, material: mat, preco_kg: precoKg, estimado: false,
    }, { onConflict: 'organization_id,material' })
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'filamento.set', { material: mat, para: precoKg })
    return { ok: true }
  }

  async setEmbalagem(orgId: string, userId: string | null, id: string, b: { preco?: number; qtd_padrao?: number }) {
    const patch: Record<string, unknown> = {}
    if (b.preco !== undefined) { patch['preco'] = b.preco; patch['estimado'] = false }
    if (b.qtd_padrao !== undefined) patch['qtd_padrao'] = b.qtd_padrao
    if (!Object.keys(patch).length) throw new BadRequestException('Nada pra atualizar.')
    const { error } = await supabaseAdmin.from('prod3d_embalagens')
      .update(patch).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'embalagem.set', { id, ...b })
    return { ok: true }
  }

  async addSku(orgId: string, userId: string | null, b: { sku: string; projeto?: string; gramas: number; horas: number; material?: string }) {
    if (!b.sku?.trim()) throw new BadRequestException('Dê um nome ao SKU.')
    if (!(b.gramas > 0) || !(b.horas > 0)) throw new BadRequestException('Informe gramas e horas do fatiador (> 0).')
    const { error } = await supabaseAdmin.from('prod3d_skus').insert({
      organization_id: orgId, sku: b.sku.trim(), projeto: b.projeto ?? null,
      gramas: b.gramas, horas: b.horas, material: (b.material ?? 'PLA').trim().toUpperCase(),
    })
    if (error) throw new BadRequestException(error.message.includes('duplicate') ? 'Esse SKU já existe.' : error.message)
    await this.auditar(orgId, userId, 'sku.add', { sku: b.sku, g: b.gramas, h: b.horas })
    return { ok: true }
  }

  async rmSku(orgId: string, userId: string | null, id: string) {
    const { data: antes } = await supabaseAdmin.from('prod3d_skus')
      .select('sku').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!antes) throw new BadRequestException('SKU não encontrado.')
    await supabaseAdmin.from('prod3d_skus').delete().eq('id', id).eq('organization_id', orgId)
    await this.auditar(orgId, userId, 'sku.rm', { sku: antes.sku })
    return { ok: true }
  }

  /** Parágrafo executivo do custo de produção em linguagem de investidor. */
  async explicarInvestidor(orgId: string) {
    const d = await this.loadAll(orgId)
    const cg = this.custoPorGramaGeral(d)
    const cap = this.capacidadeMensal(d)
    const fixos = this.totalFixosMensal(d)
    const estimados = this.check(d).filter(p => p[0] === 'ESTIMADO').length
    const resumo = [
      `Custo de produção por grama boa: R$ ${cg.total.toFixed(3)}/g`,
      `Composição por grama: fixos R$ ${cg.fixo_rateado.toFixed(3)}, filamento R$ ${cg.filamento.toFixed(3)}, depreciação R$ ${cg.depreciacao.toFixed(3)}, energia R$ ${cg.energia.toFixed(3)}, manutenção R$ ${cg.manutencao.toFixed(3)}`,
      `Custos fixos mensais: R$ ${fixos.total.toFixed(2)} (${Object.entries(fixos.por_categoria).map(([c, v]) => `${c} ${v.toFixed(0)}`).join(', ')})`,
      `Capacidade: ${cap.g_boas_mes.toFixed(0)} g boas/mês (${cap.impressoras} impressora(s) × ${d.config.horas_mes_por_impressora}h × ${cap.g_por_hora.toFixed(1)} g/h, falha ${(d.config.taxa_falha * 100).toFixed(0)}%)`,
      `SKUs cadastrados: ${d.skus.length} (produtividade ${cap.origem_g_por_hora})`,
      `Valores ainda estimados aguardando confirmação: ${estimados}`,
    ].join('\n')
    const r = await this.llm.generateText({
      orgId, feature: 'prod3d_explicar', maxTokens: 600, temperature: 0.4,
      systemPrompt: 'Você é analista financeiro explicando o custo de PRODUÇÃO de uma fábrica de ' +
        'impressão 3D para um investidor/sócio leigo, em pt-BR. Metodologia: custeio por absorção — ' +
        'custos fixos mensais rateados nas gramas boas produzidas; falha encarece a peça boa; energia ' +
        'varia por material. Escreva 1-2 parágrafos claros e diretos: o número-chave, o que domina o ' +
        'custo, a alavanca principal (utilização das impressoras dilui os fixos), e o grau de confiança ' +
        'dos números (estimados vs confirmados). Sem jargão, sem markdown, sem inventar números.',
      userPrompt: resumo,
    })
    return { texto: r.text }
  }

  // ── Alerta de impressora (WhatsApp) ─────────────────────────────────────────

  async setAlertaWhatsapp(orgId: string, userId: string | null, numero: string) {
    const limpo = (numero ?? '').replace(/\D/g, '')
    if (limpo && (limpo.length < 12 || limpo.length > 13))
      throw new BadRequestException('Número inválido — use DDI+DDD+número (ex.: 5511999998888).')
    const { error } = await supabaseAdmin.from('prod3d_config')
      .update({ alerta_whatsapp: limpo || null }).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.auditar(orgId, userId, 'alerta.whatsapp.set', { numero: limpo || null })
    return { ok: true }
  }

  /** Chamado pelo VIGIA local (sem login — autentica pela watchdog_key).
   * Repassa no WhatsApp a mensagem que a impressora deu. */
  async alertaImpressora(watchdogKey: string, b: { impressora?: string; evento?: string; mensagem: string }) {
    if (!watchdogKey) throw new UnauthorizedException('watchdog_key ausente.')
    const { data: cfg } = await supabaseAdmin.from('prod3d_config')
      .select('organization_id, alerta_whatsapp').eq('watchdog_key', watchdogKey).maybeSingle()
    if (!cfg) throw new UnauthorizedException('watchdog_key inválida.')
    const orgId = cfg.organization_id as string
    if (!b?.mensagem?.trim()) throw new BadRequestException('mensagem obrigatória.')
    if (!cfg.alerta_whatsapp)
      return { ok: false, error: 'Nenhum número de WhatsApp configurado em Custos de Produção.' }
    const texto = `🖨️ ${b.impressora?.trim() || 'Impressora'}${b.evento ? ` [${b.evento}]` : ''}\n${b.mensagem.trim()}`.slice(0, 1500)
    const r = await this.enviarWhatsapp(orgId, cfg.alerta_whatsapp as string, texto)
    await this.auditar(orgId, null, 'alerta.impressora', {
      evento: b.evento ?? null, impressora: b.impressora ?? null,
      enviado: r.success, via: r.via, erro: r.error ?? null,
    })
    if (!r.success) this.logger.warn(`[prod3d.alerta] WhatsApp falhou (${r.via}): ${r.error}`)
    return { ok: r.success, via: r.via, error: r.error }
  }

  /** Envia WhatsApp preferindo o canal GRATUITO da org (Baileys/WhatsApp Web
   * conectado em Canais); se não houver canal conectado, cai pro gateway
   * (Z-API/Meta) do WhatsAppSender. */
  private async enviarWhatsapp(orgId: string, phone: string, message: string):
      Promise<{ success: boolean; via: string; error?: string }> {
    const { data: canal } = await supabaseAdmin.from('channels')
      .select('id, status').eq('organization_id', orgId)
      .eq('status', 'connected').order('updated_at', { ascending: false })
      .limit(1).maybeSingle()
    if (canal) {
      try {
        await this.baileys.sendMessage(canal.id as string, phone, 'text', { body: message })
        return { success: true, via: 'canal-gratuito' }
      } catch (e: unknown) {
        this.logger.warn(`[prod3d.alerta] canal gratuito falhou, tentando gateway: ${(e as Error).message}`)
      }
    }
    const r = await this.whatsapp.sendTextMessage({ phone, message })
    return { success: r.success, via: canal ? 'gateway-fallback' : 'gateway', error: r.error }
  }

  /** Botão "Enviar teste" da tela — valida o canal fim-a-fim. */
  async alertaTeste(orgId: string) {
    const { data: cfg } = await supabaseAdmin.from('prod3d_config')
      .select('watchdog_key, alerta_whatsapp').eq('organization_id', orgId).maybeSingle()
    if (!cfg?.alerta_whatsapp)
      throw new BadRequestException('Configure o número de WhatsApp antes de testar.')
    return this.alertaImpressora(cfg.watchdog_key as string, {
      impressora: 'Teste', evento: 'teste',
      mensagem: 'Alerta de impressora funcionando — este é um teste enviado pela tela de Custos de Produção.',
    })
  }

  async historico(orgId: string, limit = 50) {
    const { data } = await supabaseAdmin.from('prod3d_historico')
      .select('acao, detalhe, created_at').eq('organization_id', orgId)
      .order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200))
    return data ?? []
  }

  // ── Selftest — prova matemática com números de mão (mesma do Python) ───────
  selftest() {
    const d: Prod3dData = {
      config: {
        id: 't', tarifa_kwh: 1, tarifa_kwh_estimado: false,
        taxa_falha: 0, fator_purga_ams: 0, perdas_estimado: false,
        manutencao_hora: 0.2, manutencao_estimado: false,
        mo_custo_hora: 0, mo_minutos_padrao: 0,
        horas_mes_por_impressora: 300, g_por_hora_fallback: 15, producao_estimado: false,
        alerta_whatsapp: null, watchdog_key: 'selftest',
      },
      impressoras: [{ id: 'i1', modelo: 'T', quantidade: 1, valor_pago: 6000, vida_util_horas: 6000, potencia_ams_w: 0, estimado: false, is_active: true }],
      potencias: [
        { id: 'p1', impressora_id: 'i1', material: 'PLA', watts: 100, estimado: false, fonte: null },
        { id: 'p2', impressora_id: 'i1', material: 'ABS', watts: 200, estimado: false, fonte: null },
      ],
      fixos: [{ id: 'f1', nome: 'x', valor_mensal: 3000, categoria: 'outros', estimado: false }],
      filamentos: [
        { id: 'm1', material: 'PLA', preco_kg: 100, estimado: false },
        { id: 'm2', material: 'ABS', preco_kg: 100, estimado: false },
      ],
      embalagens: [],
      skus: [{ id: 's1', sku: 't', projeto: null, gramas: 20, horas: 1, material: 'PLA' }],
    }
    const eq = (a: number, b: number, msg: string) => {
      if (Math.abs(a - b) > 1e-9) throw new Error(`${msg}: esperado ${b}, veio ${a}`)
    }
    const hm = this.custoHoraMaquina(d, 'PLA')
    eq(hm.energia, 0.10, 'energia/h')          // 100W × R$1/kWh
    eq(hm.depreciacao, 1.00, 'depreciação/h')  // 6000 ÷ 6000h
    eq(hm.total, 1.30, 'hora-máquina')
    eq(this.capacidadeMensal(d).g_boas_mes, 6000, 'capacidade')  // 300h × 20g/h
    eq(this.custoFixoPorGrama(d), 0.5, 'fixo/g')                 // 3000 ÷ 6000
    const pc = this.custoPeca(d, 100, 5, 'PLA')
    eq(pc.filamento, 10, 'filamento')      // 100g × R$0,10
    eq(pc.fixo_rateado, 50, 'fixo peça')   // 100g × R$0,50
    eq(pc.total, 66.5, 'total peça')       // 10 + 6,5 + 50
    const pcAbs = this.custoPeca(d, 100, 5, 'ABS')
    eq(pcAbs.energia, 2 * pc.energia, 'energia ABS 2×')
    eq(pcAbs.total, 67, 'total ABS')
    if (this.familiaEnergia(['PLA', 'ABS'], 'PLA-SILK') !== 'PLA') throw new Error('família PLA-SILK')
    if (this.familiaEnergia(['PLA', 'ABS'], 'ABS-GF') !== 'ABS') throw new Error('família ABS-GF')
    const cg = this.custoPorGramaGeral(d)
    eq(cg.total, 0.10 + 1.30 / 20 + 0.50, 'custo por grama geral')
    return true
  }
}
