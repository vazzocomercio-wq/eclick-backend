import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import axios, { AxiosError, AxiosInstance } from 'axios'

/**
 * Cliente HTTP da API Icarus (Pennacorp). Doc: https://www.pennacorp.com.br/mobile/api/public/apidoc/
 *
 * Sessão 2026-05-14 (Fase 1) — sem token real ainda; cliente já valida shape
 * de resposta e cacheia request_token em memória até a Pennacorp confirmar
 * TTL real (esperado: ~24h via JWT).
 *
 * Auth em 2 etapas:
 *   1. POST /generate/:access_token  → { request_token: "<jwt>" }
 *   2. Toda chamada subsequente usa :request_token na URL
 *
 * Sem webhook — só polling. Endpoints suportam dtAlteracao (YYYYMMDD) pra
 * incremental, o que torna polling barato.
 */

const DEFAULT_BASE_URL = 'https://www.pennacorp.com.br/mobile/api/public'
const DEFAULT_TIMEOUT_MS = 30_000

/** Tempo que confiamos no request_token cacheado em memória antes de regenerar.
 *  Conservador (1h) até Pennacorp confirmar TTL real. */
const REQUEST_TOKEN_TTL_MS = 60 * 60 * 1000

export interface IcarusProduct {
  pt_code:        string
  pt_descr:       string
  pt_obs?:        string
  pt_unid?:       string
  dt_alteracao?:  string         // dd/mm/aa
  pack?:          string         // string com decimal "3.000"
  pb_codbar?:     string         // GTIN
  pt_codegroup?:  string         // produto similar
  fa_nome?:       string         // família
  pt_multiplo?:   string         // venda mínima
  pb_altura?:     string
  pb_largura?:    string
  pb_comprim?:    string
  pb_peso?:       string         // peso bruto
  pt_pesoliq?:    string         // peso líquido
  pt_preco?:      string         // preço fixo (sem margem)
  pt_qtd?:        string         // físico − reservas (disponível)
  pt_reserva?:    string
  pt_custo?:      string         // ⚠️ custo deles — ignorar pra dropship
  pt_imagem?:     string
  pt_marg_flag?:  boolean        // promo ativa?
  margemp?:       string         // margem quando promo ativa
  preco_final?:   string         // valor final (inclui promo) — PREFERIR este
}

export interface IcarusStockItem {
  pt_code:  string
  pt_descr: string
  estoque:  string             // string com decimal "12.000"
}

export interface IcarusProductsFilters {
  search?:       'PT_CODE' | 'PT_DESCR' | 'PT_OBS'
  text?:         string
  iFam?:         number
  bPromo?:       boolean
  iFor?:         number
  sCodFor?:      string
  sMarca?:       string
  sMercado?:     string
  sSerial?:      string
  bBloq?:        boolean       // outlet
  eComm?:        boolean       // só ativos no e-commerce
  dtAlteracao?:  string        // YYYYMMDD
  bSaldo?:       boolean       // só com saldo > 0
}

interface IcarusListResponse<T> {
  data:   T[]
  total:  number
  status: string
}

export interface IcarusClientConfig {
  baseUrl?:        string
  timeoutMs?:      number
  // Override config — usado se o ambiente do fornecedor for diferente
}

interface CachedToken {
  token:      string
  expires_at: number
}

@Injectable()
export class IcarusApiClient {
  private readonly log = new Logger(IcarusApiClient.name)
  // Cache por access_token → request_token (1 client compartilhado entre supplier_integrations)
  private tokenCache = new Map<string, CachedToken>()

  /** Builda axios instance pra um access_token específico.
   *  baseUrl/timeout vêm de config (override por supplier_integration). */
  private buildAxios(config: IcarusClientConfig): AxiosInstance {
    return axios.create({
      baseURL: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Gera (ou usa cache de) request_token a partir do access_token. */
  async getRequestToken(accessToken: string, config: IcarusClientConfig = {}): Promise<string> {
    if (!accessToken || accessToken.trim() === '') {
      throw new BadRequestException('access_token vazio')
    }
    const cached = this.tokenCache.get(accessToken)
    if (cached && cached.expires_at > Date.now()) {
      return cached.token
    }

    const ax = this.buildAxios(config)
    try {
      const res = await ax.post<{ request_token?: string }>(
        `/generate/${encodeURIComponent(accessToken)}`,
      )
      const requestToken = res.data?.request_token
      if (!requestToken || typeof requestToken !== 'string') {
        throw new HttpException(
          `Icarus retornou shape inesperado em /generate: ${JSON.stringify(res.data).slice(0, 200)}`,
          HttpStatus.BAD_GATEWAY,
        )
      }
      this.tokenCache.set(accessToken, {
        token:      requestToken,
        expires_at: Date.now() + REQUEST_TOKEN_TTL_MS,
      })
      return requestToken
    } catch (e) {
      this.handleAxiosError(e, '/generate')
    }
  }

  /** Smoke test — apenas garante que o access_token gera request_token.
   *  Usado pelo endpoint /suppliers/:id/integrations/icarus/test. */
  async ping(accessToken: string, config: IcarusClientConfig = {}): Promise<{
    ok:               true
    base_url:         string
    request_token_preview: string
  }> {
    const token = await this.getRequestToken(accessToken, config)
    return {
      ok:                    true,
      base_url:              (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      request_token_preview: token.slice(0, 24) + '…',
    }
  }

  /**
   * POST /produtos/:request_token — busca produtos com filtros.
   *
   * Atenção: a doc não menciona paginação. Pra catálogos grandes (>5k itens)
   * use `iFam` (família) ou `dtAlteracao` (incremental) pra fragmentar.
   */
  async listProducts(
    accessToken: string,
    filters: IcarusProductsFilters = {},
    config: IcarusClientConfig = {},
  ): Promise<IcarusListResponse<IcarusProduct>> {
    const requestToken = await this.getRequestToken(accessToken, config)
    const ax = this.buildAxios(config)
    const params: Record<string, string | number | boolean> = {}
    if (filters.search)      params.search      = filters.search
    if (filters.text)        params.text        = filters.text
    if (filters.iFam   != null) params.iFam     = filters.iFam
    if (filters.bPromo != null) params.bPromo   = filters.bPromo ? 1 : 0
    if (filters.iFor   != null) params.iFor     = filters.iFor
    if (filters.sCodFor)     params.sCodFor     = filters.sCodFor
    if (filters.sMarca)      params.sMarca      = filters.sMarca
    if (filters.sMercado)    params.sMercado    = filters.sMercado
    if (filters.sSerial)     params.sSerial     = filters.sSerial
    if (filters.bBloq  != null) params.bBloq    = filters.bBloq ? 1 : 0
    if (filters.eComm  != null) params.eComm    = filters.eComm ? 1 : 0
    if (filters.bSaldo != null) params.bSaldo   = filters.bSaldo ? 1 : 0
    if (filters.dtAlteracao) params.dtAlteracao = filters.dtAlteracao

    try {
      const res = await ax.post<IcarusListResponse<IcarusProduct>>(
        `/produtos/${encodeURIComponent(requestToken)}`,
        null,
        { params },
      )
      return this.normalizeListResponse(res.data)
    } catch (e) {
      this.handleAxiosError(e, '/produtos')
    }
  }

  /**
   * POST /estoque/:request_token?dtAlteracao=YYYYMMDD — busca só os SKUs
   * com saldo alterado desde a data. Ideal pra cron incremental.
   */
  async listStockChanges(
    accessToken: string,
    dtAlteracao: string,                     // YYYYMMDD
    options: { eComm?: boolean } = {},
    config: IcarusClientConfig = {},
  ): Promise<IcarusListResponse<IcarusStockItem>> {
    if (!/^\d{8}$/.test(dtAlteracao)) {
      throw new BadRequestException(`dtAlteracao deve ser YYYYMMDD (8 dígitos), recebi: ${dtAlteracao}`)
    }
    const requestToken = await this.getRequestToken(accessToken, config)
    const ax = this.buildAxios(config)
    const params: Record<string, string | number> = { dtAlteracao }
    if (options.eComm != null) params.eComm = options.eComm ? 1 : 0

    try {
      const res = await ax.post<IcarusListResponse<IcarusStockItem>>(
        `/estoque/${encodeURIComponent(requestToken)}`,
        null,
        { params },
      )
      return this.normalizeListResponse(res.data)
    } catch (e) {
      this.handleAxiosError(e, '/estoque')
    }
  }

  /** Invalida cache do request_token (útil pra forçar regenerar após erro 401). */
  invalidateToken(accessToken: string): void {
    this.tokenCache.delete(accessToken)
  }

  // ── private ─────────────────────────────────────────────────────────────

  private normalizeListResponse<T>(raw: unknown): IcarusListResponse<T> {
    if (!raw || typeof raw !== 'object') {
      throw new HttpException('Icarus respondeu corpo inválido', HttpStatus.BAD_GATEWAY)
    }
    const obj = raw as Partial<IcarusListResponse<T>>
    return {
      data:   Array.isArray(obj.data) ? obj.data : [],
      total:  typeof obj.total === 'number' ? obj.total : (Array.isArray(obj.data) ? obj.data.length : 0),
      status: typeof obj.status === 'string' ? obj.status : 'unknown',
    }
  }

  private handleAxiosError(e: unknown, endpoint: string): never {
    const err = e as AxiosError
    if (err.response) {
      const body = typeof err.response.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response.data ?? {})
      throw new HttpException(
        `Icarus ${endpoint} respondeu ${err.response.status}: ${body.slice(0, 300)}`,
        err.response.status >= 400 && err.response.status < 600 ? err.response.status : HttpStatus.BAD_GATEWAY,
      )
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new HttpException(`Icarus ${endpoint} timeout`, HttpStatus.GATEWAY_TIMEOUT)
    }
    throw new HttpException(
      `Icarus ${endpoint} falha de rede: ${(err as Error).message}`,
      HttpStatus.BAD_GATEWAY,
    )
  }
}
