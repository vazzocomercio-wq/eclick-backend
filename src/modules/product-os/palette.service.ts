import { BadRequestException, Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — Paletas de cor por categoria.
 * Recurso PRÓPRIO do Product OS (não toca no IA Criativo). Cada categoria pode
 * ter uma paleta primária; as cores alimentam a geração de imagens (o usuário
 * copia o "prompt de cores").
 */

export interface PaletteColor { hex: string; label?: string; input_id?: string | null }

@Injectable()
export class PaletteService {
  private cleanColors(colors: unknown): PaletteColor[] {
    if (!Array.isArray(colors)) return []
    const out: PaletteColor[] = []
    for (const c of colors) {
      const hex = String((c as PaletteColor)?.hex ?? '').trim()
      const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
      if (!m) continue
      out.push({ hex: `#${m[1].toLowerCase()}`, label: String((c as PaletteColor)?.label ?? '').trim() || undefined, input_id: (c as PaletteColor)?.input_id ?? null })
    }
    return out.slice(0, 24)
  }

  async list(orgId: string, categoryId?: string | null) {
    let q = supabaseAdmin.from('product_os_palette')
      .select('*, category:category_id(id, code, label)')
      .eq('organization_id', orgId).order('is_primary', { ascending: false }).order('name')
    if (categoryId) q = q.eq('category_id', categoryId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(row => {
      const r = row as Record<string, unknown> & { category?: unknown }
      const cat = Array.isArray(r.category) ? r.category[0] : r.category
      return { ...r, category: cat ?? null }
    })
  }

  async create(orgId: string, userId: string | null, body: { name: string; category_id?: string | null; colors?: PaletteColor[]; notes?: string; is_primary?: boolean }) {
    const name = (body.name ?? '').trim()
    if (!name) throw new BadRequestException('Nome obrigatório')
    const colors = this.cleanColors(body.colors)
    if (!colors.length) throw new BadRequestException('Adicione ao menos uma cor (hex)')
    const categoryId = body.category_id ?? null
    if (body.is_primary && categoryId) await this.clearPrimary(orgId, categoryId)
    const { data, error } = await supabaseAdmin.from('product_os_palette').insert({
      organization_id: orgId, name, category_id: categoryId, colors, notes: body.notes ?? null,
      is_primary: !!body.is_primary && !!categoryId, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar paleta: ${error?.message ?? 'sem dados'}`)
    return data
  }

  async update(orgId: string, id: string, patch: { name?: string; category_id?: string | null; colors?: PaletteColor[]; notes?: string | null }) {
    const safe: Record<string, unknown> = {}
    if ('name' in patch) { const n = (patch.name ?? '').trim(); if (!n) throw new BadRequestException('Nome obrigatório'); safe.name = n }
    if ('category_id' in patch) safe.category_id = patch.category_id ?? null
    if ('colors' in patch) { const c = this.cleanColors(patch.colors); if (!c.length) throw new BadRequestException('Adicione ao menos uma cor'); safe.colors = c }
    if ('notes' in patch) safe.notes = patch.notes ?? null
    if (!Object.keys(safe).length) throw new BadRequestException('Nada a atualizar')
    const { data, error } = await supabaseAdmin.from('product_os_palette').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar: ${error?.message ?? 'paleta não encontrada'}`)
    return data
  }

  async remove(orgId: string, id: string) {
    const { error } = await supabaseAdmin.from('product_os_palette').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  private async clearPrimary(orgId: string, categoryId: string) {
    await supabaseAdmin.from('product_os_palette').update({ is_primary: false })
      .eq('organization_id', orgId).eq('category_id', categoryId).eq('is_primary', true)
  }

  /** Marca esta paleta como a primária (escolhida) da categoria dela. */
  async setPrimary(orgId: string, id: string) {
    const { data } = await supabaseAdmin.from('product_os_palette').select('category_id').eq('id', id).eq('organization_id', orgId).maybeSingle()
    const categoryId = (data as { category_id: string | null } | null)?.category_id
    if (!categoryId) throw new BadRequestException('Vincule a paleta a uma categoria antes de torná-la primária.')
    await this.clearPrimary(orgId, categoryId)
    const { error } = await supabaseAdmin.from('product_os_palette').update({ is_primary: true }).eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }
}
