import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { type ModelSourceProvider, type SourceModel, type LicenseVerdict, buildVerdict } from './model-sources/source.types'

/**
 * MakerWorld (Bambu) — provedor de modelos via API by-id (não-oficial).
 *
 * NÃO existe API pública oficial; o endpoint por-id responde anônimo (HTTP 200,
 * rico) mas pode mudar sem aviso. O arquivo binário (.3mf/.stl) NÃO vem pela
 * API — só metadados + capa. Busca/ranking é travada por login.
 *
 * LANDMINE de licença: muito modelo é não-comercial / sem-derivados. A API
 * expõe `license` + `allowReCreation` → calculamos o veredito (derivar? vender?)
 * que o porteiro (Peça 2) usa pra bloquear o portfólio. Aqui só LEMOS.
 */

const API_HOSTS = [
  'https://makerworld.com/api/v1/design-service/design',
  'https://api.bambulab.com/v1/design-service/design', // espelho
]
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

@Injectable()
export class MakerworldService implements ModelSourceProvider {
  readonly platform = 'makerworld'
  readonly label = 'MakerWorld'
  private readonly logger = new Logger(MakerworldService.name)

  /** Anônimo — sempre pronto, sem credencial. */
  isConfigured(): boolean { return true }

  matchUrl(input: string): boolean {
    return /makerworld\.com|bambulab\.com/i.test(input ?? '')
  }

  /** Extrai o ID do design de uma URL MakerWorld (vários formatos) ou ID cru. */
  parseId(input: string): string {
    const raw = (input ?? '').trim()
    if (!raw) throw new BadRequestException('Informe o link ou o ID do modelo MakerWorld.')
    if (/^\d{2,}$/.test(raw)) return raw
    const m = raw.match(/(?:models|design)\/(\d+)/i)
    if (m) return m[1]
    const q = raw.match(/[?&]id=(\d+)/i)
    if (q) return q[1]
    throw new BadRequestException('Link MakerWorld inválido. Cole a URL do modelo (ex: makerworld.com/en/models/1234567) ou o ID.')
  }

  /** Busca o design por ID, tentando o host principal e o espelho. */
  async fetchModel(input: string): Promise<SourceModel> {
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

  private normalize(id: string, j: Record<string, any>): SourceModel {
    const inst = Array.isArray(j.instances) && j.instances.length ? j.instances[0] : null
    const license: string | null = j.license || null
    const allow = j.allowReCreation === true
    const tags: string[] = Array.isArray(j.tags) ? j.tags.filter((t: unknown) => typeof t === 'string') : []
    const categories: string[] = Array.isArray(j.categories)
      ? j.categories.map((c: any) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
      : []
    const predictionSec = Number(inst?.prediction ?? inst?.time ?? 0)

    return {
      platform:           'makerworld',
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
      price:              null,
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

  /** Veredito de licença do MakerWorld. `allowReCreation` é a flag autoritativa
   *  pra derivar; o código CC refina comercial (NC) e derivados (ND). */
  licenseVerdict(license: string | null, allowRecreation: boolean): LicenseVerdict {
    const code = (license ?? '').toUpperCase().trim()
    const hasNC = /\bNC\b/.test(code) || code.includes('-NC')
    const hasND = /\bND\b/.test(code) || code.includes('-ND')
    const isStandardRestrictive = /STANDARD|COMMERCIAL FILE|PROPRIET/i.test(license ?? '') && !code.startsWith('BY') && code !== 'CC0'
    return buildVerdict({
      license,
      allowsDerivative: allowRecreation && !hasND && !isStandardRestrictive,
      allowsCommercial: !hasNC && !isStandardRestrictive,
      restrictiveReason: isStandardRestrictive
        ? `Licença "${license}" é restritiva: não permite compartilhar, vender nem criar obra derivada.`
        : hasND
          ? `Licença ${license} é "sem derivados" (ND): não pode modificar nem remodelar.`
          : 'O criador não permite recriar/derivar este modelo (allowReCreation = não).',
      commercialReason: `Licença ${license} permite derivar, porém é "não comercial" (NC): pode remodelar para uso próprio, mas vender exige autorização do criador.`,
    })
  }
}
