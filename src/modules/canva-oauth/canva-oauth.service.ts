import { Injectable, Logger, HttpException, HttpStatus, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'

const CANVA_AUTH_URL  = 'https://www.canva.com/api/oauth/authorize'
const CANVA_TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token'
const CANVA_API_BASE  = 'https://api.canva.com/rest/v1'

/** Sprint F5-2 / Batch 1.5 — Canva Connect OAuth 2.0 conforme spec oficial.
 *
 * https://www.canva.dev/docs/connect/authentication/
 *
 * Implementa:
 *   ✓ Authorization Code Flow + PKCE com SHA-256 (obrigatório)
 *   ✓ state CSRF aleatório (96 bytes), persistido em oauth_state, validado no callback
 *   ✓ Basic Auth (Base64 client_id:client_secret) no token endpoint
 *   ✓ refresh_token rotation (cada refresh retorna novo token; salvamos atomicamente)
 *   ✓ Auto-refresh quando access_token a <5min de expirar
 *   ✓ Cron de limpeza de oauth_state (15min)
 *
 * NÃO implementa Canva Autofill / Brand Templates — exige Enterprise plan.
 *
 * Setup necessário pelo admin do SaaS:
 *   1. Registrar app em https://www.canva.com/developers
 *   2. Adicionar env vars no Railway:
 *        CANVA_CLIENT_ID
 *        CANVA_CLIENT_SECRET
 *        CANVA_REDIRECT_URI (ex: https://eclick-backend.../canva/oauth/callback)
 *   3. Habilitar scopes: asset:read asset:write design:meta:read design:content:read design:content:write
 *
 * Sem essas vars, getEnv() throw 503. */

const STORED_TOKEN_KEY = 'CANVA_OAUTH_TOKEN'

interface StoredCanvaToken {
  access_token:  string
  refresh_token: string
  expires_at:    number   // ms unix
}

@Injectable()
export class CanvaOauthService {
  private readonly logger = new Logger(CanvaOauthService.name)

  constructor(private readonly credentials: CredentialsService) {}

  // ── Env / config ────────────────────────────────────────────────────────

  private getEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
    const clientId     = process.env.CANVA_CLIENT_ID
    const clientSecret = process.env.CANVA_CLIENT_SECRET
    const redirectUri  = process.env.CANVA_REDIRECT_URI
    if (!clientId || !clientSecret || !redirectUri) {
      throw new HttpException(
        'Integração Canva não configurada pelo administrador do SaaS',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return { clientId, clientSecret, redirectUri }
  }

  private basicAuthHeader(clientId: string, clientSecret: string): string {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }

  // ── PKCE helpers ────────────────────────────────────────────────────────

  /** 96 bytes → 128 chars base64url. Spec exige 43-128, sample no upper limit
   * pra entropy máxima sem exceder. */
  private generateCodeVerifier(): string {
    return crypto.randomBytes(96).toString('base64url')
  }

  private codeChallengeFromVerifier(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url')
  }

  private generateState(): string {
    return crypto.randomBytes(96).toString('base64url')
  }

  // ── /start — gera + persiste state+verifier, monta authorize URL ────────

  /** GET /canva/oauth/start — chamada autenticada. Frontend faz
   * window.location.href = authorize_url retornado. */
  async buildAuthorizeUrl(orgId: string, userId: string, redirectTo?: string): Promise<{ authorize_url: string }> {
    const { clientId, redirectUri } = this.getEnv()

    const state         = this.generateState()
    const codeVerifier  = this.generateCodeVerifier()
    const codeChallenge = this.codeChallengeFromVerifier(codeVerifier)

    const { error } = await supabaseAdmin.from('oauth_state').insert({
      organization_id: orgId,
      user_id:         userId,
      provider:        'canva',
      state,
      code_verifier:   codeVerifier,
      redirect_to:     redirectTo ?? null,
    })
    if (error) {
      this.logger.error(`[canva.start] persist state falhou: ${error.message}`)
      throw new HttpException('Falha ao iniciar OAuth — tente novamente', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const params = new URLSearchParams({
      client_id:             clientId,
      response_type:         'code',
      code_challenge:        codeChallenge,
      code_challenge_method: 's256',
      scope:                 'asset:read asset:write design:meta:read design:content:read design:content:write',
      state,
      redirect_uri:          redirectUri,
    })
    return { authorize_url: `${CANVA_AUTH_URL}?${params.toString()}` }
  }

  // ── /callback — valida state, exchange code + verifier por tokens ───────

  /** GET /canva/oauth/callback?code=&state= — Canva chama esse após user
   * autorizar. Lê state pra recuperar code_verifier + orgId/userId originais. */
  async exchangeCode(code: string, state: string): Promise<{ ok: true; org_id: string; redirect_to: string | null }> {
    const { clientId, clientSecret, redirectUri } = this.getEnv()

    // 1. Lookup state row (CSRF + replay protection)
    const { data: row, error: selErr } = await supabaseAdmin
      .from('oauth_state')
      .select('*')
      .eq('state', state)
      .eq('provider', 'canva')
      .eq('consumed', false)
      .maybeSingle()
    if (selErr) throw new HttpException('Falha ao validar state', HttpStatus.INTERNAL_SERVER_ERROR)
    if (!row)   throw new UnauthorizedException('State inválido, já consumido ou expirado')

    if (new Date(row.expires_at as string).getTime() < Date.now()) {
      throw new UnauthorizedException('State expirado — refaça a conexão')
    }

    // 2. Mark consumed (one-shot)
    const { error: upErr } = await supabaseAdmin
      .from('oauth_state')
      .update({ consumed: true })
      .eq('id', row.id)
      .eq('consumed', false)
    if (upErr) {
      // Outro processo consumiu primeiro — race protection
      throw new UnauthorizedException('State consumido em paralelo — tente novamente')
    }

    // 3. Exchange code+verifier por tokens
    const form = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      code_verifier: row.code_verifier as string,
      redirect_uri:  redirectUri,
    })
    let tokenRes
    try {
      tokenRes = await axios.post<{
        access_token:  string
        refresh_token: string
        expires_in:    number
        token_type?:   string
      }>(CANVA_TOKEN_URL, form.toString(), {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': this.basicAuthHeader(clientId, clientSecret),
        },
        timeout: 30_000,
      })
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `HTTP ${e.response?.status} ${JSON.stringify(e.response?.data ?? {}).slice(0, 200)}` : (e as Error).message
      this.logger.warn(`[canva.exchange] token endpoint falhou: ${msg}`)
      throw new HttpException(`Canva rejeitou code: ${msg}`, HttpStatus.BAD_GATEWAY)
    }

    const { access_token, refresh_token, expires_in } = tokenRes.data
    if (!access_token || !refresh_token) {
      throw new HttpException('Canva não retornou tokens completos', HttpStatus.BAD_GATEWAY)
    }

    // 4. Persiste como JSON serializado (encriptado pelo CredentialsService)
    const stored: StoredCanvaToken = {
      access_token,
      refresh_token,
      expires_at: Date.now() + (expires_in * 1000),
    }
    await this.credentials.saveCredential(
      row.organization_id as string,
      (row.user_id as string) ?? '00000000-0000-0000-0000-000000000000',
      'canva',
      STORED_TOKEN_KEY,
      JSON.stringify(stored),
    )

    this.logger.log(`[canva.exchange] tokens salvos org=${row.organization_id} user=${row.user_id}`)
    return {
      ok:           true,
      org_id:       row.organization_id as string,
      redirect_to:  (row.redirect_to as string) ?? null,
    }
  }

  // ── Token retrieval + auto-refresh ──────────────────────────────────────

  /** Lê o token salvo (criptografado), refresca se < 5min de expirar.
   * Refresh tokens Canva são one-shot — sempre salvamos o novo refresh_token
   * que vier na resposta. */
  async getValidAccessToken(orgId: string): Promise<string | null> {
    const raw = await this.credentials.getDecryptedKey(orgId, 'canva', STORED_TOKEN_KEY).catch(() => null)
    if (!raw) return null

    let stored: StoredCanvaToken
    try {
      stored = JSON.parse(raw)
    } catch {
      this.logger.warn(`[canva.token] parse JSON falhou orgId=${orgId} — token corrompido`)
      return null
    }

    const fiveMin = 5 * 60 * 1000
    if (stored.expires_at > Date.now() + fiveMin) {
      // Ainda válido
      return stored.access_token
    }

    // Refresh
    return this.refreshAccessToken(orgId, stored.refresh_token)
  }

  private async refreshAccessToken(orgId: string, refreshToken: string): Promise<string | null> {
    const { clientId, clientSecret } = this.getEnv()
    const form = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    })
    let res
    try {
      res = await axios.post<{
        access_token:  string
        refresh_token: string
        expires_in:    number
      }>(CANVA_TOKEN_URL, form.toString(), {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': this.basicAuthHeader(clientId, clientSecret),
        },
        timeout: 30_000,
      })
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `HTTP ${e.response?.status}` : (e as Error).message
      this.logger.warn(`[canva.refresh] falhou orgId=${orgId}: ${msg} — user precisa reconectar`)
      return null
    }

    const next: StoredCanvaToken = {
      access_token:  res.data.access_token,
      refresh_token: res.data.refresh_token,   // novo refresh — one-shot rotation
      expires_at:    Date.now() + (res.data.expires_in * 1000),
    }
    // Batch 1.6 — UPDATE direto preserva user_id original do callback.
    // Antes usávamos saveCredential com placeholder UUID '0000...', que
    // podia trocar o user_id de quem realmente conectou. Agora atualiza
    // só key_value + updated_at, identificando o row pela tripla
    // (org, provider, key_name) — composta UNIQUE post-Batch 1.6.
    const encrypted = this.credentials.encrypt(JSON.stringify(next))
    const { error: upErr } = await supabaseAdmin
      .from('api_credentials')
      .update({ key_value: encrypted, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('provider', 'canva')
      .eq('key_name', STORED_TOKEN_KEY)
    if (upErr) {
      this.logger.warn(`[canva.refresh] update falhou orgId=${orgId}: ${upErr.message}`)
      return null
    }
    this.logger.log(`[canva.refresh] orgId=${orgId} rotacionado, expires_at=${new Date(next.expires_at).toISOString()}`)
    return next.access_token
  }

  /** Status pra UI: connected + expires_at humano-legível. */
  async getStatus(orgId: string): Promise<{ connected: boolean; expires_at?: string; configured: boolean }> {
    try {
      this.getEnv()
    } catch {
      return { connected: false, configured: false }
    }
    const raw = await this.credentials.getDecryptedKey(orgId, 'canva', STORED_TOKEN_KEY).catch(() => null)
    if (!raw) return { connected: false, configured: true }
    try {
      const stored = JSON.parse(raw) as StoredCanvaToken
      return { connected: true, configured: true, expires_at: new Date(stored.expires_at).toISOString() }
    } catch {
      return { connected: false, configured: true }
    }
  }

  // ── Asset upload + design creation (usa getValidAccessToken) ────────────

  async uploadAndOpenDesign(orgId: string, params: {
    imageUrl: string
    imageName?: string
    designType?: 'WhatsAppStatus' | 'InstagramPost' | 'InstagramStory'
  }): Promise<{ edit_url: string; design_id: string; asset_id: string }> {
    this.getEnv()  // 503 se admin não configurou
    const token = await this.getValidAccessToken(orgId)
    if (!token) {
      throw new HttpException(
        'Conecte sua conta Canva nas Integrações antes de usar o editor',
        HttpStatus.BAD_REQUEST,
      )
    }

    // 1. Download da imagem (Storage do Supabase, sem auth — bucket público)
    let imgBuf: Buffer
    try {
      const imgRes = await axios.get<ArrayBuffer>(params.imageUrl, {
        responseType: 'arraybuffer', timeout: 30_000,
      })
      imgBuf = Buffer.from(imgRes.data)
    } catch (e) {
      this.logger.error(`[canva.download] falhou orgId=${orgId} url=${params.imageUrl.slice(0, 80)}`)
      throw new BadRequestException(`Não foi possível baixar a imagem: ${(e as Error).message}`)
    }

    // 2. Upload pra Canva /asset-uploads
    //    Spec oficial: body = bytes RAW (octet-stream), header
    //    Asset-Upload-Metadata: { name_base64: ... }. Multipart NÃO aceito
    //    (retorna 415 Unsupported Media Type). Doc:
    //    https://www.canva.dev/docs/connect/api-reference/assets/create-asset-upload-job/
    const rawName  = (params.imageName ?? 'campaign-asset.png').slice(0, 50)
    const nameB64  = Buffer.from(rawName, 'utf8').toString('base64')
    const metadata = JSON.stringify({ name_base64: nameB64 })

    let uploadJobId: string | undefined
    let assetId:     string | undefined
    try {
      const uploadRes = await axios.post<{ job: { id: string; status: string; asset?: { id: string } } }>(
        `${CANVA_API_BASE}/asset-uploads`,
        imgBuf,
        {
          headers: {
            'Authorization':         `Bearer ${token}`,
            'Content-Type':          'application/octet-stream',
            'Asset-Upload-Metadata': metadata,
          },
          timeout:          60_000,
          maxBodyLength:    Infinity,
          maxContentLength: Infinity,
        },
      )
      uploadJobId = uploadRes.data?.job?.id
      assetId     = uploadRes.data?.job?.asset?.id  // pode vir direto se rápido
      if (!uploadJobId && !assetId) {
        this.logger.error(`[canva.asset-uploads] resposta sem job.id nem asset.id: ${JSON.stringify(uploadRes.data ?? {}).slice(0, 300)}`)
        throw new BadRequestException('Canva upload sem job.id retornado')
      }
    } catch (e) {
      this.logCanvaError('asset-uploads', e)
      throw this.canvaErrorToHttp('asset-uploads', e)
    }

    // 3. Poll job se asset não veio direto. Backoff 2,3,4,5,6,7s = 27s total max.
    if (!assetId && uploadJobId) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 2000 + i * 1000))
        try {
          const jobRes = await axios.get<{ job: { id: string; status: string; asset?: { id: string }; error?: { message?: string } } }>(
            `${CANVA_API_BASE}/asset-uploads/${uploadJobId}`,
            { headers: { 'Authorization': `Bearer ${token}` }, timeout: 10_000 },
          )
          const jobStatus = jobRes.data?.job?.status
          if (jobStatus === 'success') {
            assetId = jobRes.data?.job?.asset?.id
            break
          }
          if (jobStatus === 'failed') {
            const errMsg = jobRes.data?.job?.error?.message ?? 'desconhecido'
            this.logger.warn(`[canva.upload.poll] job ${uploadJobId} failed: ${errMsg}`)
            throw new BadRequestException(`Canva upload job falhou: ${errMsg}`)
          }
          // jobStatus === 'in_progress' → continua loop
        } catch (e) {
          if (e instanceof BadRequestException) throw e
          this.logCanvaError(`asset-uploads/${uploadJobId} (poll #${i})`, e)
          // Erro transient na consulta — segue tentando
        }
      }
    }
    if (!assetId) throw new BadRequestException('Canva upload demorou mais que 30s, tente novamente')

    // 4. Criar design vazio com asset
    const designType = params.designType ?? 'InstagramPost'
    try {
      const designRes = await axios.post<{ design: { id: string; urls: { edit_url: string } } }>(
        `${CANVA_API_BASE}/designs`,
        {
          design_type: { type: 'preset', name: designType },
          asset_id:    assetId,
        },
        {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 30_000,
        },
      )
      return {
        edit_url:  designRes.data.design.urls.edit_url,
        design_id: designRes.data.design.id,
        asset_id:  assetId,
      }
    } catch (e) {
      this.logCanvaError('designs', e)
      throw this.canvaErrorToHttp('designs', e)
    }
  }

  /** Loga erro Canva sem expor token. body trunca em 500 chars. */
  private logCanvaError(endpoint: string, e: unknown): void {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status ?? 'no-status'
      const body   = JSON.stringify(e.response?.data ?? {}).slice(0, 500)
      this.logger.error(`[canva.${endpoint}] status=${status} body=${body}`)
    } else {
      this.logger.error(`[canva.${endpoint}] erro non-axios: ${(e as Error).message}`)
    }
  }

  /** Converte erro Canva em HttpException com mensagem útil. */
  private canvaErrorToHttp(endpoint: string, e: unknown): HttpException {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status
      const data   = e.response?.data as { message?: string; error?: string; code?: string } | undefined
      const msg    = data?.message || data?.error || data?.code || 'erro desconhecido'
      return new BadRequestException(`Canva ${endpoint} ${status}: ${msg}`)
    }
    return new BadRequestException(`Canva ${endpoint}: ${(e as Error).message}`)
  }

  // ── Cron cleanup de oauth_state ─────────────────────────────────────────

  /** A cada 15min, deleta rows expirados ou consumidos há mais de 1h. */
  @Cron('*/15 * * * *', { name: 'oauthStateCleanup' })
  async cleanupOauthState(): Promise<void> {
    const cutoffConsumed = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const now            = new Date().toISOString()

    // Expirados (não consumidos)
    const { error: e1 } = await supabaseAdmin
      .from('oauth_state')
      .delete()
      .lt('expires_at', now)
    if (e1) this.logger.warn(`[oauth_state.cleanup] expired delete falhou: ${e1.message}`)

    // Consumidos antigos (>1h)
    const { error: e2 } = await supabaseAdmin
      .from('oauth_state')
      .delete()
      .eq('consumed', true)
      .lt('created_at', cutoffConsumed)
    if (e2) this.logger.warn(`[oauth_state.cleanup] consumed delete falhou: ${e2.message}`)
  }
}
