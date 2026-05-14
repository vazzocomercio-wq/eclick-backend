/**
 * e-Otimizer IA MVP 4 — detector de permissões de edição do ML.
 *
 * Pra um anúncio existente, retorna o que pode ser editado:
 *   🟢 free        — totalmente editável
 *   🟡 restricted  — pode editar com cuidado (provavelmente vai dar OK)
 *   🔴 locked      — não tente (vai dar 403)
 *
 * Decisão é conservadora (pós-feedback ChatGPT): título com vendas vira
 * locked por default. Em vez de tentar edição parcial arriscada, o
 * Optimizer gera "título sugerido pra clone" — user copia pra novo anúncio.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios, { type AxiosError } from 'axios'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

export type EditMode = 'free' | 'restricted' | 'locked'

export interface ListingPermissions {
  mlb_id:          string
  sold_quantity:   number
  listing_type_id: string
  catalog_listing: boolean
  category_id:     string

  title:          EditMode
  description:    EditMode
  pictures:       EditMode
  category:       EditMode
  listing_type:   EditMode
  attributes_overall: EditMode
  /** Atributos que sabemos que sempre travam após venda (BRAND, MODEL geralmente) */
  attributes_locked_keys: string[]

  /** Mensagem human-readable explicando o estado. */
  rationale: string[]
}

/** Subset de campos de /items/{id} que precisamos pra decidir permissões. */
export interface MlItemForPermissions {
  id:                 string
  title:              string
  description?:       string
  sold_quantity:      number
  listing_type_id:    string
  catalog_listing:    boolean
  category_id:        string
  status:             string
  price:              number
  pictures:           Array<{ id: string; url: string; secure_url: string }>
  attributes:         Array<{ id: string; name: string; value_id?: string | null; value_name?: string | null }>
  shipping?:          Record<string, unknown>
  tags?:              string[]
}

@Injectable()
export class MlEditPermissionsService {
  private readonly logger = new Logger(MlEditPermissionsService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  /**
   * Pega o item via ML API (usando token da org) + decide permissões.
   * Tenta TODAS as contas ML da org até achar uma que retorne dono do anúncio.
   * Útil pra orgs com múltiplas contas (ex: Vazzo tem 2 sellers).
   */
  async fetchAndCheck(orgId: string, mlbId: string): Promise<{
    item:        MlItemForPermissions
    permissions: ListingPermissions
  }> {
    const tokens = await this.mercadolivre.getAllTokensForOrg(orgId)
    if (tokens.length === 0) {
      throw new BadRequestException('Nenhuma conta Mercado Livre conectada a esta organização. Conecte em Configurações > Integrações.')
    }

    let item: MlItemForPermissions | null = null
    let lastError: string | null = null
    let tokenUsed: string | null = null

    for (const { token } of tokens) {
      try {
        const { data } = await axios.get<Record<string, unknown>>(`${ML_BASE}/items/${mlbId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
        })
        item = this.parseItem(data)
        tokenUsed = token
        break
      } catch (e: unknown) {
        if (axios.isAxiosError(e)) {
          const ax = e as AxiosError<{ message?: string; error?: string }>
          lastError = `ML ${ax.response?.status ?? '?'}: ${ax.response?.data?.message ?? ax.message}`
          continue
        }
        lastError = (e as Error).message
      }
    }

    if (!item || !tokenUsed) {
      throw new BadRequestException(
        `Não foi possível acessar o anúncio ${mlbId} com nenhuma das suas contas ML. ` +
        `Verifique se o ID está correto e se a conta dona dele está conectada. ` +
        `Último erro: ${lastError ?? 'desconhecido'}`,
      )
    }

    // Description vem em endpoint separado
    try {
      const { data: descData } = await axios.get<{ plain_text?: string; text?: string }>(
        `${ML_BASE}/items/${mlbId}/description`,
        { headers: { Authorization: `Bearer ${tokenUsed}` }, timeout: 10_000 },
      )
      item.description = descData.plain_text ?? descData.text ?? ''
    } catch {
      item.description = ''
    }

    const permissions = this.computePermissions(item)
    return { item, permissions }
  }

  /**
   * Decisão de permissões com base nas regras ML conhecidas (maio/2026).
   * Conservadora: prefere locked-by-default em casos ambíguos.
   */
  computePermissions(item: MlItemForPermissions): ListingPermissions {
    const rationale: string[] = []
    const sold = item.sold_quantity ?? 0
    const isFree = item.listing_type_id === 'free'
    const isCatalog = item.catalog_listing === true

    // ── TÍTULO ────────────────────────────────────────────────────────────
    let title: EditMode = 'free'
    if (isCatalog) {
      title = 'locked'
      rationale.push('Título travado: anúncio vinculado ao catálogo (título vem do catálogo).')
    } else if (sold > 0 && isFree) {
      title = 'locked'
      rationale.push(`Título travado: anúncio Grátis com ${sold} vendas — ML não permite alterar.`)
    } else if (sold > 0) {
      // Política conservadora pós-feedback: trata como locked mesmo em premium.
      // Optimizer mostra sugestão pra clone em vez de tentar PUT.
      title = 'locked'
      rationale.push(`Título travado: anúncio com ${sold} vendas — risco alto de erro na API. Sugestão fica disponível pra você criar anúncio novo.`)
    }

    // ── DESCRIÇÃO ─────────────────────────────────────────────────────────
    // Quase sempre editável, mesmo com vendas. Só catálogo bloqueia.
    const description: EditMode = isCatalog ? 'restricted' : 'free'
    if (isCatalog) rationale.push('Descrição: editável, mas algumas categorias de catálogo limitam.')

    // ── IMAGENS ───────────────────────────────────────────────────────────
    const pictures: EditMode = 'free'  // ML sempre permite editar imagens (até 10)

    // ── CATEGORIA ─────────────────────────────────────────────────────────
    const category: EditMode = sold > 0 ? 'locked' : 'free'
    if (sold > 0) rationale.push('Categoria travada: anúncios com vendas não podem mudar de categoria.')

    // ── TIPO DE ANÚNCIO ───────────────────────────────────────────────────
    // Só upgrade permitido (clássico → premium). Downgrade NÃO. Free → paid OK.
    let listing_type: EditMode = 'restricted'
    if (item.listing_type_id === 'gold_pro') {
      listing_type = 'locked'
      rationale.push('Tipo Premium: não pode fazer downgrade.')
    } else if (sold === 0) {
      listing_type = 'free'
    }

    // ── ATRIBUTOS ─────────────────────────────────────────────────────────
    // Maioria editável. BRAND/MODEL travam após primeira venda em algumas categorias.
    const attributesLocked: string[] = []
    let attributes_overall: EditMode = 'free'
    if (sold > 0) {
      attributesLocked.push('BRAND', 'MODEL')
      attributes_overall = 'restricted'
      rationale.push('Atributos críticos (BRAND, MODEL) podem estar travados após venda — outros são editáveis.')
    }
    if (isCatalog) {
      attributesLocked.push('BRAND', 'MODEL', 'GTIN')
      attributes_overall = 'restricted'
      rationale.push('Catálogo: atributos do produto-pai vêm do catálogo, não dá pra alterar.')
    }

    if (rationale.length === 0) {
      rationale.push('Anúncio sem vendas e sem catálogo — todos os campos editáveis livremente.')
    }

    return {
      mlb_id:                 item.id,
      sold_quantity:          sold,
      listing_type_id:        item.listing_type_id,
      catalog_listing:        isCatalog,
      category_id:            item.category_id,
      title,
      description,
      pictures,
      category,
      listing_type,
      attributes_overall,
      attributes_locked_keys: Array.from(new Set(attributesLocked)),
      rationale,
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private parseItem(raw: Record<string, unknown>): MlItemForPermissions {
    return {
      id:              raw.id as string,
      title:           raw.title as string,
      sold_quantity:   Number(raw.sold_quantity ?? 0),
      listing_type_id: raw.listing_type_id as string,
      catalog_listing: Boolean(raw.catalog_listing),
      category_id:     raw.category_id as string,
      status:          (raw.status as string) ?? 'active',
      price:           Number(raw.price ?? 0),
      pictures:        (raw.pictures as MlItemForPermissions['pictures']) ?? [],
      attributes:      (raw.attributes as MlItemForPermissions['attributes']) ?? [],
      shipping:        (raw.shipping as Record<string, unknown>) ?? {},
      tags:            (raw.tags as string[]) ?? [],
    }
  }
}
