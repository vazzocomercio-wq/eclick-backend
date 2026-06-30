import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — Gerador de SKU inteligível.
 *
 * SKU = MARCA + CATEGORIA + SUB + LINHA + CARACTERISTICA + "-" + COR
 * Categoria→Sub→Linha→Característica são hierárquicos (código sequencial dentro
 * do pai); a Característica é o discriminador do modelo na linha. Cor é o eixo de
 * variação: 1 modelo → N SKUs (base-cor). Só p/ produtos do Product OS.
 */

export type SkuKind = 'marca' | 'categoria' | 'sub' | 'linha' | 'caracteristica' | 'cor'
const KINDS: SkuKind[] = ['marca', 'categoria', 'sub', 'linha', 'caracteristica', 'cor']
// pai esperado de cada kind (null = topo). Define a hierarquia.
const PARENT_KIND: Record<SkuKind, SkuKind | null> = {
  marca: null, categoria: null, cor: null, sub: 'categoria', linha: 'sub', caracteristica: 'linha',
}
const ZERO = '00000000-0000-0000-0000-000000000000'

export interface TaxRow { id: string; organization_id: string; kind: string; code: string; label: string; parent_id: string | null; sort_order: number }

@Injectable()
export class SkuService {
  private readonly logger = new Logger(SkuService.name)

  private assertKind(kind: string): SkuKind {
    if (!KINDS.includes(kind as SkuKind)) throw new BadRequestException(`Dimensão inválida: ${kind}`)
    return kind as SkuKind
  }

  /** Próximo código sequencial (2 díg.) dentro do escopo (org, kind, pai). */
  private async nextNumericCode(orgId: string, kind: SkuKind, parentId: string | null): Promise<string> {
    let q = supabaseAdmin.from('sku_taxonomy').select('code').eq('organization_id', orgId).eq('kind', kind)
    q = parentId ? q.eq('parent_id', parentId) : q.is('parent_id', null)
    const { data } = await q
    const max = (data ?? []).reduce((m, r) => Math.max(m, parseInt((r as { code: string }).code, 10) || 0), 0)
    return String(max + 1).padStart(2, '0')
  }

  async listTaxonomy(orgId: string, kind: string, parentId?: string | null) {
    const k = this.assertKind(kind)
    let q = supabaseAdmin.from('sku_taxonomy').select('id, kind, code, label, parent_id, sort_order')
      .eq('organization_id', orgId).eq('kind', k).order('code', { ascending: true })
    if (PARENT_KIND[k]) { if (!parentId) return []; q = q.eq('parent_id', parentId) }
    else q = q.is('parent_id', null)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async createTaxonomy(orgId: string, userId: string | null, body: { kind: string; label: string; parent_id?: string | null; code?: string; notes?: string }) {
    const k = this.assertKind(body.kind)
    const label = (body.label ?? '').trim()
    if (!label) throw new BadRequestException('Nome obrigatório')
    const needsParent = PARENT_KIND[k]
    const parentId = body.parent_id ?? null
    if (needsParent) {
      if (!parentId) throw new BadRequestException(`${k} exige um pai (${needsParent})`)
      const { data: p } = await supabaseAdmin.from('sku_taxonomy').select('kind').eq('id', parentId).eq('organization_id', orgId).maybeSingle()
      if (!p || (p as { kind: string }).kind !== needsParent) throw new BadRequestException(`Pai inválido — esperado ${needsParent}`)
    } else if (parentId) throw new BadRequestException(`${k} é nível de topo (sem pai)`)

    // marca = código alfanumérico do usuário (VZ); demais = sequencial numérico
    let code: string
    if (k === 'marca') {
      code = (body.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (!code) throw new BadRequestException('Marca exige um código (ex: VZ)')
    } else {
      code = (body.code ?? '').trim() || await this.nextNumericCode(orgId, k, parentId)
      code = String(parseInt(code, 10) || 0).padStart(2, '0')
    }

    // insere com retry simples em corrida de código sequencial
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await supabaseAdmin.from('sku_taxonomy').insert({
        organization_id: orgId, kind: k, code, label, parent_id: parentId, notes: body.notes ?? null, created_by: userId,
      }).select('id, kind, code, label, parent_id').maybeSingle()
      if (!error && data) return data
      if (error && /duplicate|unique/i.test(error.message)) {
        if (/ux_skutax_label/.test(error.message)) throw new BadRequestException(`Já existe "${label}" nesse nível`)
        if (k === 'marca') throw new BadRequestException(`Código de marca "${code}" já existe`)
        code = await this.nextNumericCode(orgId, k, parentId)   // corrida → tenta o próximo
        continue
      }
      throw new BadRequestException(`Erro ao criar: ${error?.message ?? 'sem dados'}`)
    }
    throw new BadRequestException('Não foi possível gerar um código único — tente de novo')
  }

  async updateTaxonomy(orgId: string, id: string, patch: { label?: string; notes?: string; sort_order?: number }) {
    const safe: Record<string, unknown> = {}
    if ('label' in patch) { const l = (patch.label ?? '').trim(); if (!l) throw new BadRequestException('Nome obrigatório'); safe.label = l }
    if ('notes' in patch) safe.notes = patch.notes ?? null
    if ('sort_order' in patch) safe.sort_order = Number(patch.sort_order) || 0
    if (!Object.keys(safe).length) throw new BadRequestException('Nada a atualizar')
    // código é IMUTÁVEL (mudar quebraria SKUs já gerados)
    const { data, error } = await supabaseAdmin.from('sku_taxonomy').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('id, kind, code, label').maybeSingle()
    if (error) throw new BadRequestException(/ux_skutax_label/.test(error.message) ? 'Já existe esse nome no nível' : `Erro: ${error.message}`)
    if (!data) throw new BadRequestException('Valor não encontrado')
    return data
  }

  async deleteTaxonomy(orgId: string, id: string) {
    // bloqueia se estiver em uso (filho, classificação de produto ou variante de cor)
    const { count: kids } = await supabaseAdmin.from('sku_taxonomy').select('id', { count: 'exact', head: true }).eq('parent_id', id)
    if ((kids ?? 0) > 0) throw new BadRequestException('Tem subníveis — apague-os antes')
    const cols = ['sku_marca_id', 'sku_categoria_id', 'sku_sub_id', 'sku_linha_id', 'sku_caracteristica_id']
    for (const c of cols) {
      const { count } = await supabaseAdmin.from('product_dev').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq(c, id)
      if ((count ?? 0) > 0) throw new BadRequestException('Está em uso por produtos — não dá pra apagar')
    }
    const { count: vars } = await supabaseAdmin.from('product_dev_sku_variant').select('id', { count: 'exact', head: true }).eq('cor_id', id)
    if ((vars ?? 0) > 0) throw new BadRequestException('Cor em uso por variantes — não dá pra apagar')
    const { error } = await supabaseAdmin.from('sku_taxonomy').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── classificação do modelo + geração do base ─────────────────────
  private async loadRow(orgId: string, id: string | null | undefined): Promise<TaxRow | null> {
    if (!id) return null
    const { data } = await supabaseAdmin.from('sku_taxonomy').select('id, organization_id, kind, code, label, parent_id, sort_order')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    return (data as TaxRow | null) ?? null
  }

  async getSku(orgId: string, devId: string) {
    const { data: dev } = await supabaseAdmin.from('product_dev')
      .select('sku_marca_id, sku_categoria_id, sku_sub_id, sku_linha_id, sku_caracteristica_id, sku_base')
      .eq('id', devId).eq('organization_id', orgId).maybeSingle()
    if (!dev) throw new BadRequestException('Produto não encontrado')
    const d = dev as Record<string, string | null>
    const [marca, categoria, sub, linha, caracteristica] = await Promise.all([
      this.loadRow(orgId, d.sku_marca_id), this.loadRow(orgId, d.sku_categoria_id), this.loadRow(orgId, d.sku_sub_id),
      this.loadRow(orgId, d.sku_linha_id), this.loadRow(orgId, d.sku_caracteristica_id),
    ])
    const { data: vars } = await supabaseAdmin.from('product_dev_sku_variant')
      .select('id, cor_id, sku, product_id, cor:cor_id(id, code, label)').eq('product_dev_id', devId).order('sku')
    const variants = (vars ?? []).map(v => { const r = v as Record<string, unknown> & { cor?: unknown }; const cor = Array.isArray(r.cor) ? r.cor[0] : r.cor; return { id: r.id, sku: r.sku, product_id: r.product_id, cor } })
    return { classification: { marca, categoria, sub, linha, caracteristica }, base: d.sku_base, variants }
  }

  /** Valida a cadeia hierárquica e grava a classificação + sku_base. */
  async setClassification(orgId: string, devId: string, body: { marca_id: string; categoria_id: string; sub_id: string; linha_id: string; caracteristica_id: string }) {
    const [marca, categoria, sub, linha, carac] = await Promise.all([
      this.loadRow(orgId, body.marca_id), this.loadRow(orgId, body.categoria_id), this.loadRow(orgId, body.sub_id),
      this.loadRow(orgId, body.linha_id), this.loadRow(orgId, body.caracteristica_id),
    ])
    if (!marca || marca.kind !== 'marca') throw new BadRequestException('Marca inválida')
    if (!categoria || categoria.kind !== 'categoria') throw new BadRequestException('Categoria inválida')
    if (!sub || sub.kind !== 'sub' || sub.parent_id !== categoria.id) throw new BadRequestException('Sub-categoria não pertence à categoria')
    if (!linha || linha.kind !== 'linha' || linha.parent_id !== sub.id) throw new BadRequestException('Linha não pertence à sub-categoria')
    if (!carac || carac.kind !== 'caracteristica' || carac.parent_id !== linha.id) throw new BadRequestException('Característica não pertence à linha')

    const base = `${marca.code}${categoria.code}${sub.code}${linha.code}${carac.code}`
    const { error } = await supabaseAdmin.from('product_dev').update({
      sku_marca_id: marca.id, sku_categoria_id: categoria.id, sku_sub_id: sub.id, sku_linha_id: linha.id, sku_caracteristica_id: carac.id, sku_base: base,
    }).eq('id', devId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao salvar: ${error.message}`)

    // base mudou → regenera o SKU de cada variante de cor existente
    const { data: vars } = await supabaseAdmin.from('product_dev_sku_variant').select('id, cor_id').eq('product_dev_id', devId)
    for (const v of (vars ?? []) as Array<{ id: string; cor_id: string }>) {
      const cor = await this.loadRow(orgId, v.cor_id)
      if (cor) await supabaseAdmin.from('product_dev_sku_variant').update({ sku: `${base}-${cor.code}` }).eq('id', v.id)
    }
    return this.getSku(orgId, devId)
  }

  /** Define as cores do modelo → 1 SKU (base-cor) por cor. */
  async setColors(orgId: string, devId: string, corIds: string[]) {
    const { data: dev } = await supabaseAdmin.from('product_dev').select('sku_base').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const base = (dev as { sku_base: string | null } | null)?.sku_base
    if (!base) throw new BadRequestException('Defina a classificação (base do SKU) antes das cores')
    const wanted = [...new Set((corIds ?? []).filter(Boolean))]

    const { data: existing } = await supabaseAdmin.from('product_dev_sku_variant').select('id, cor_id').eq('product_dev_id', devId)
    const existingByCor = new Map((existing ?? []).map(r => [(r as { cor_id: string }).cor_id, (r as { id: string }).id]))

    // remove as cores desmarcadas
    const toRemove = [...existingByCor.keys()].filter(c => !wanted.includes(c))
    for (const c of toRemove) await supabaseAdmin.from('product_dev_sku_variant').delete().eq('id', existingByCor.get(c)!)

    // adiciona as novas
    for (const corId of wanted) {
      if (existingByCor.has(corId)) continue
      const cor = await this.loadRow(orgId, corId)
      if (!cor || cor.kind !== 'cor') throw new BadRequestException('Cor inválida')
      const { error } = await supabaseAdmin.from('product_dev_sku_variant').insert({
        organization_id: orgId, product_dev_id: devId, cor_id: corId, sku: `${base}-${cor.code}`,
      })
      if (error && !/duplicate|unique/i.test(error.message)) throw new BadRequestException(`Erro ao gerar variante: ${error.message}`)
    }
    return this.getSku(orgId, devId)
  }
}
