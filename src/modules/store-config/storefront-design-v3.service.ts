import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import type { StorefrontDesignV3, Section, Block } from './storefront-design-v3.types'
import {
  STOREFRONT_TEMPLATE_V3_MAP,
  DEFAULT_DESIGN_V3,
} from './storefront-design-v3.templates'
import { validateDesignV3 } from './storefront-design-v3.validator'

/**
 * Store Builder v3 — service esqueleto (Fase A.8).
 *
 * Responsabilidades minimas: ler/gravar design v3 da loja, aplicar template
 * inicial. Geracao por IA (prompt/imagem/URL/Canva) vira na Fase C quando
 * adaptarmos o SYSTEM_PROMPT pro novo schema.
 *
 * Multi-tenant: toda operacao recebe orgId. store_config.organization_id e
 * UNIQUE (1 loja por org no MVP — multi-loja por org fica como melhoria
 * futura registrada).
 */
@Injectable()
export class StorefrontDesignV3Service {
  private readonly logger = new Logger(StorefrontDesignV3Service.name)

  /**
   * Le o design v3 da loja. Se a coluna estiver null (loja nunca migrou
   * pro v3) retorna DEFAULT_DESIGN_V3 — o renderer e responsavel por
   * decidir entre v3 e v2 antes de chamar isso.
   */
  async getDesign(orgId: string): Promise<StorefrontDesignV3> {
    const { data, error } = await supabaseAdmin
      .from('store_config')
      .select('design_v3')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) {
      this.logger.error(`[v3] getDesign org=${orgId} ${error.message}`)
      throw new BadRequestException('Falha ao carregar design da loja.')
    }
    if (!data?.design_v3) return DEFAULT_DESIGN_V3
    return validateDesignV3(data.design_v3, DEFAULT_DESIGN_V3)
  }

  /**
   * Valida o design recebido e grava em store_config.design_v3 (upsert).
   * A loja precisa ja existir (store_config row criada por outro fluxo).
   */
  async saveDesign(orgId: string, raw: unknown): Promise<StorefrontDesignV3> {
    const design = validateDesignV3(raw, DEFAULT_DESIGN_V3)
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ design_v3: design as unknown as Record<string, unknown> })
      .eq('organization_id', orgId)
    if (error) {
      this.logger.error(`[v3] saveDesign org=${orgId} ${error.message}`)
      throw new BadRequestException('Falha ao salvar design da loja.')
    }
    this.logger.log(`[v3] saveDesign org=${orgId} templateKey=${design.meta.templateKey}`)
    return design
  }

  /**
   * Aplica um template inicial: copia o template do MAP, reescreve TODOS
   * os ids (sections + blocks + globals) com randomUUID pra que cada loja
   * tenha ids unicos e o editor possa diff-ar mudancas.
   */
  async applyTemplate(orgId: string, templateKey: string): Promise<StorefrontDesignV3> {
    const template = STOREFRONT_TEMPLATE_V3_MAP[templateKey]
    if (!template) {
      throw new NotFoundException(`Template "${templateKey}" nao encontrado.`)
    }
    const cloned = cloneDesignWithFreshIds(template.design)
    return this.saveDesign(orgId, cloned)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: clona o design trocando todos os ids deterministicos por uuid
// ─────────────────────────────────────────────────────────────────────────

function cloneDesignWithFreshIds(d: StorefrontDesignV3): StorefrontDesignV3 {
  return {
    version: 3,
    theme: structuredClone(d.theme),
    globals: {
      header: refreshSectionIds(d.globals.header),
      footer: refreshSectionIds(d.globals.footer),
    },
    pages: {
      home:       { ...d.pages.home,       sections: d.pages.home.sections.map(refreshSectionIds) },
      product:    { ...d.pages.product,    sections: d.pages.product.sections.map(refreshSectionIds) },
      collection: { ...d.pages.collection, sections: d.pages.collection.sections.map(refreshSectionIds) },
      cart:       { ...d.pages.cart,       sections: d.pages.cart.sections.map(refreshSectionIds) },
      checkout:   { ...d.pages.checkout,   sections: d.pages.checkout.sections.map(refreshSectionIds) },
    },
    meta: { templateKey: d.meta.templateKey, updatedAt: new Date().toISOString() },
  }
}

function refreshSectionIds<T extends Section>(s: T): T {
  const cloned = structuredClone(s) as T
  ;(cloned as Section).id = randomUUID()
  ;(cloned as Section).blocks = (cloned as Section).blocks.map((b: Block) => ({
    ...b, id: randomUUID(),
  })) as Section['blocks']
  return cloned
}
