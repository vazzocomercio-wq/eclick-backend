import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'

/**
 * MakerWorld — leitor da API by-id (não-oficial, endpoint interno da Bambu).
 *
 * Peça 1 do épico: cola link → busca metadados → pré-preenche um product_dev.
 * NÃO existe API pública oficial; o endpoint por-id responde anônimo (HTTP 200,
 * rico) mas pode mudar sem aviso. O arquivo binário (.3mf/.stl) NÃO vem pela
 * API — só metadados + capa. Busca/ranking é travada por login (Peça 3).
 *
 * LANDMINE de licença: muito modelo é não-comercial / sem-derivados. A API
 * expõe `license` + `allowReCreation` → guardamos estruturado pra que a Peça 2
 * (porteiro) bloqueie o portfólio. Aqui só LEMOS e damos o veredito; não bloqueia.
 */

const API_HOSTS = [
  'https://makerworld.com/api/v1/design-service/design',
  'https://api.bambulab.com/v1/design-service/design', // espelho
]
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Veredito de licença pra remodelar+vender. Reutilizado pela Peça 2. */
export interface LicenseVerdict {
  level:           'green' | 'yellow' | 'red'
  can_remodel:     boolean   // permite criar obra derivada?
  can_commercial:  boolean   // permite uso comercial (vender)?
  label:           string    // rótulo curto PT-BR
  reason:          string     // explicação PT-BR
}

export interface MakerworldDesign {
  source_platform:    'makerworld'
  source_url:         string
  external_id:        string
  title:              string
  license:            string | null
  license_title:      string | null
  allow_recreation:   boolean
  is_printable:       boolean
  cover_url:          string | null
  creator:            string | null
  creator_handle:     string | null
  download_count:     number
  print_count:        number
  like_count:         number
  collection_count:   number
  tags:               string[]
  categories:         string[]
  // métricas de fabricação da 1ª instância (perfil de impressão)
  weight_g:           number | null
  print_time_minutes: number | null
  material_count:     number | null
  need_ams:           boolean
  is_remix:           boolean      // tem linhagem (originals)?
  verdict:            LicenseVerdict
  raw:                Record<string, unknown> // snapshot bruto pra source_metadata
}

@Injectable()
export class MakerworldService {
  private readonly logger = new Logger(MakerworldService.name)

  /** Extrai o ID do design de uma URL MakerWorld (vários formatos) ou ID cru. */
  parseId(input: string): string {
    const raw = (input ?? '').trim()
    if (!raw) throw new BadRequestException('Informe o link ou o ID do modelo MakerWorld.')
    // ID puro
    if (/^\d{2,}$/.test(raw)) return raw
    // .../models/1234567(-slug)(#...) ou .../design/1234567
    const m = raw.match(/(?:models|design)\/(\d+)/i)
    if (m) return m[1]
    // ?id=1234567 (query)
    const q = raw.match(/[?&]id=(\d+)/i)
    if (q) return q[1]
    throw new BadRequestException('Link MakerWorld inválido. Cole a URL do modelo (ex: makerworld.com/en/models/1234567) ou o ID.')
  }

  /** Busca o design por ID, tentando o host principal e o espelho. */
  async fetchDesign(input: string): Promise<MakerworldDesign> {
    const id = this.parseId(input)
    let lastErr: unknown = null
    for (const host of API_HOSTS) {
      try {
        const { data } = await axios.get(`${host}/${id}`, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          timeout: 12000,
          validateStatus: s => s === 200,
        })
        if (!data || typeof data !== 'object') { lastErr = new Error('resposta vazia'); continue }
        if (!data.id || !data.title) {
          // 200 mas vazio = design removido/privado
          throw new NotFoundException('Modelo não encontrado, removido ou privado no MakerWorld.')
        }
        return this.normalize(id, data as Record<string, unknown>)
      } catch (e) {
        if (e instanceof NotFoundException) throw e
        lastErr = e
      }
    }
    this.logger.warn(`[makerworld] falha ao buscar design ${id}: ${(lastErr as Error)?.message}`)
    throw new BadRequestException('Não consegui ler o MakerWorld agora. Tente de novo em instantes.')
  }

  /** Normaliza o JSON cru da API para o shape interno. */
  private normalize(id: string, j: Record<string, any>): MakerworldDesign {
    const inst = Array.isArray(j.instances) && j.instances.length ? j.instances[0] : null
    const license: string | null = j.license || null
    const allow = j.allowReCreation === true
    const tags: string[] = Array.isArray(j.tags) ? j.tags.filter((t: unknown) => typeof t === 'string') : []
    const categories: string[] = Array.isArray(j.categories)
      ? j.categories.map((c: any) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
      : []
    const predictionSec = Number(inst?.prediction ?? inst?.time ?? 0)

    return {
      source_platform:    'makerworld',
      source_url:         `https://makerworld.com/en/models/${id}`,
      external_id:        String(j.id ?? id),
      title:              String(j.title ?? '').trim(),
      license,
      license_title:      j.licenseDescriptionInfo?.title || null,
      allow_recreation:   allow,
      is_printable:       j.isPrintable === true,
      cover_url:          j.coverUrl || j.coverPortrait || j.coverLandscape || null,
      creator:            j.designCreator?.name || null,
      creator_handle:     j.designCreator?.handle || null,
      download_count:     Number(j.downloadCount ?? 0),
      print_count:        Number(j.printCount ?? 0),
      like_count:         Number(j.likeCount ?? 0),
      collection_count:   Number(j.collectionCount ?? 0),
      tags,
      categories,
      weight_g:           inst?.weight != null ? Number(inst.weight) : null,
      print_time_minutes: predictionSec > 0 ? Math.round(predictionSec / 60) : null,
      material_count:     inst?.materialCnt != null ? Number(inst.materialCnt) : null,
      need_ams:           inst?.needAms === true,
      is_remix:           Array.isArray(j.originals) ? j.originals.length > 0 : !!j.originals,
      verdict:            this.licenseVerdict(license, allow),
      raw: {
        id: j.id, title: j.title, license, licenseDescriptionInfo: j.licenseDescriptionInfo,
        allowReCreation: j.allowReCreation, isPrintable: j.isPrintable, isPointRedeemable: j.isPointRedeemable,
        downloadCount: j.downloadCount, printCount: j.printCount, likeCount: j.likeCount, collectionCount: j.collectionCount,
        designCreator: j.designCreator ? { uid: j.designCreator.uid, name: j.designCreator.name, handle: j.designCreator.handle } : null,
        originals: j.originals ?? null, tags, categories,
        coverUrl: j.coverUrl, instance0: inst ? { weight: inst.weight, prediction: inst.prediction, materialCnt: inst.materialCnt, needAms: inst.needAms, profileId: inst.profileId } : null,
        fetched_from: 'makerworld_by_id',
      },
    }
  }

  /**
   * Veredito de licença pra "posso remodelar e vender?". `allowReCreation` é a
   * flag autoritativa da MakerWorld pra derivar/recriar; o código de licença
   * (Creative Commons) refina o uso comercial (NC) e derivados (ND).
   *   verde  = pode derivar E vender
   *   amarelo= pode derivar mas NÃO comercial (ou licença ambígua) → cautela
   *   vermelho= não pode derivar (sem-derivados / licença restritiva)
   */
  licenseVerdict(license: string | null, allowRecreation: boolean): LicenseVerdict {
    const code = (license ?? '').toUpperCase().trim()
    const hasNC = /\bNC\b/.test(code) || code.includes('-NC')
    const hasND = /\bND\b/.test(code) || code.includes('-ND')
    // "Standard Digital File License" e afins = restritiva (sem compartilhar/vender/derivar)
    const isStandardRestrictive = /STANDARD|COMMERCIAL FILE|PROPRIET/i.test(license ?? '') && !code.startsWith('BY') && code !== 'CC0'

    const can_remodel    = allowRecreation && !hasND && !isStandardRestrictive
    const can_commercial = !hasNC && !isStandardRestrictive

    if (!can_remodel) {
      return {
        level: 'red', can_remodel: false, can_commercial,
        label: 'Não pode remodelar',
        reason: isStandardRestrictive
          ? `Licença "${license}" é restritiva: não permite compartilhar, vender nem criar obra derivada.`
          : hasND
            ? `Licença ${license} é "sem derivados" (ND): não pode modificar nem remodelar.`
            : 'O criador não permite recriar/derivar este modelo (allowReCreation = não).',
      }
    }
    if (!can_commercial) {
      return {
        level: 'yellow', can_remodel: true, can_commercial: false,
        label: 'Remodelar OK, mas não comercial',
        reason: `Licença ${license} permite derivar, porém é "não comercial" (NC): pode remodelar para uso próprio, mas vender exige autorização do criador.`,
      }
    }
    return {
      level: 'green', can_remodel: true, can_commercial: true,
      label: 'Pode remodelar e vender',
      reason: license
        ? `Licença ${license} permite criar obra derivada e uso comercial.`
        : 'O criador permite recriar/derivar e não há restrição comercial detectada.',
    }
  }
}
