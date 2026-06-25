/**
 * Fundação multi-fonte do Product OS.
 *
 * Cada banco de modelos 3D (MakerWorld, Thingiverse, Cults3D, Thangs…) é um
 * PROVEDOR que implementa `ModelSourceProvider` e devolve o shape normalizado
 * `SourceModel`. Importar/Radar/Porteiro NÃO conhecem plataforma — falam só com
 * o registry. Adicionar plataforma = 1 classe nova + register, zero no motor.
 *
 * A semântica de licença varia por plataforma (allowReCreation no MakerWorld,
 * CC no Thingiverse, licença comercial vendável no Cults3D…). Por isso cada
 * provedor calcula os flags (derivar? vender?) e chama `buildVerdict` — o
 * veredito verde/amarelo/vermelho fica IGUAL pra todas, e o porteiro (Peça 2)
 * confia no veredito gravado no import, sem reparsear licença.
 */

export interface LicenseVerdict {
  level:          'green' | 'yellow' | 'red'
  can_remodel:    boolean   // permite criar obra derivada?
  can_commercial: boolean   // permite uso comercial (vender)?
  label:          string    // rótulo curto PT-BR
  reason:         string    // explicação PT-BR
}

export interface SourceModel {
  platform:           string   // 'makerworld' | 'thingiverse' | 'cults3d' | 'thangs' | …
  source_url:         string
  external_id:        string
  title:              string
  license:            string | null
  license_title:      string | null
  allow_recreation:   boolean  // flag "derivar" normalizado (compat c/ coluna existente)
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
  // métricas de fabricação (quando a plataforma expõe — slicer/perfil de impressão)
  weight_g:           number | null
  print_time_minutes: number | null
  material_count:     number | null
  need_ams:           boolean
  is_remix:           boolean
  price:              number | null   // > 0 = modelo pago (Cults3D etc); null/0 = grátis
  verdict:            LicenseVerdict
  raw:                Record<string, unknown>
}

/** Contrato de um banco de modelos 3D. */
export interface ModelSourceProvider {
  /** chave estável da plataforma (igual ao SourceModel.platform) */
  readonly platform: string
  /** rótulo legível pra UI (ex "MakerWorld") */
  readonly label: string
  /** a URL pertence a esta plataforma? (resolução por link) */
  matchUrl(input: string): boolean
  /** está pronto pra uso? (false = adapter dormente esperando credencial) */
  isConfigured(): boolean
  /** lê um modelo por URL ou ID e normaliza */
  fetchModel(input: string): Promise<SourceModel>
  /** lista os modelos de um criador, ordenados por popularidade (se suportado) */
  listByCreator?(handle: string, limit?: number): Promise<SourceModel[]>
  /** feed de descoberta / "em alta" (se suportado) */
  discover?(opts?: DiscoverOpts): Promise<SourceModel[]>
  /** árvore de categorias da plataforma (se suportado) */
  listCategories?(): Promise<SourceCategory[]>
}

export interface DiscoverOpts {
  commercialOnly?: boolean   // só modelos com licença comercial (vendáveis)
  categorySlug?:   string    // filtra por categoria (ex 'home-decor', 'vases')
  limit?:          number
  offset?:         number
}

export interface SourceCategory {
  slug:      string
  name:      string          // já vem com prefixo do pai quando é subcategoria (ex "Home › Vases")
  children?: SourceCategory[]
}

/** Monta o veredito verde/amarelo/vermelho a partir dos flags normalizados.
 *  Núcleo compartilhado — todas as plataformas convergem aqui. */
export function buildVerdict(o: {
  license: string | null
  allowsDerivative: boolean
  allowsCommercial: boolean
  restrictiveReason?: string | null
  commercialReason?: string | null
  greenReason?: string | null
}): LicenseVerdict {
  const lic = o.license ? `Licença ${o.license}` : 'A licença'
  if (!o.allowsDerivative) {
    return { level: 'red', can_remodel: false, can_commercial: o.allowsCommercial,
      label: 'Não pode remodelar',
      reason: o.restrictiveReason ?? `${lic} não permite criar obra derivada (remodelar).` }
  }
  if (!o.allowsCommercial) {
    return { level: 'yellow', can_remodel: true, can_commercial: false,
      label: 'Remodelar OK, mas não comercial',
      reason: o.commercialReason ?? `${lic} permite derivar, porém não permite uso comercial — vender exige autorização do criador.` }
  }
  return { level: 'green', can_remodel: true, can_commercial: true,
    label: 'Pode remodelar e vender',
    reason: o.greenReason ?? `${lic} permite criar obra derivada e uso comercial.` }
}
