import {
  Injectable, Logger, BadRequestException, NotFoundException,
  ForbiddenException, HttpException, HttpStatus,
} from '@nestjs/common'
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { LlmService } from '../ai/llm.service'
import type { ImageFormat } from '../ai/types'

/**
 * AH — Ambientador IA / "Veja no seu espaço" (Loja Própria).
 *
 * O cliente da vitrine sobe uma foto do ambiente e a IA aplica o produto
 * na cena (fiel; só corrige exposição/ruído/inclinação). A função só é
 * liberada após Nome + e-mail + WhatsApp validado por OTP. Cada cliente tem
 * N gerações (default 3), cada geração produz 2 imagens.
 *
 * Este service cobre o GATE (AH1):
 *   - config()        → o que a vitrine precisa pra mostrar o botão
 *   - register()      → grava/atualiza cliente + manda OTP no WhatsApp
 *   - verify()        → confere OTP, valida, cria contato no Active, devolve token
 *
 * A geração em si (AH2) e a entrega/CRM (AH3) são adicionadas em métodos
 * próprios mais à frente.
 */

const OTP_TTL_MS        = 10 * 60 * 1000   // 10 min
const OTP_RESEND_MS     = 60 * 1000        // 1 min entre reenvios
const OTP_MAX_ATTEMPTS  = 5
const TOKEN_TTL_MS      = 24 * 60 * 60 * 1000  // token do cliente vale 24h
const DEFAULT_GENERATIONS = 3

const STOREFRONT_BUCKET = 'storefront-assets'   // público (URL direta)
const CREATIVE_BUCKET   = 'creative'            // privado (signed URL)
const IMAGES_PER_GEN    = 2                     // 2 imagens por geração
const MAX_SCENE_BYTES   = 7 * 1024 * 1024       // 7MB decodificado
const ALLOWED_MIME      = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Anti-abuso de envio de OTP por IP
const OTP_IP_WINDOW_MS      = 60 * 60 * 1000    // janela de 1h
const OTP_IP_MAX_PER_WINDOW = 8                 // máx OTPs por IP/hora

// Teto de custo de geração por org/dia (override em visualizer_settings)
const DEFAULT_DAILY_COST_CAP_USD = 15

export interface VisualizerSettings {
  enabled?:             boolean
  pipeline_id?:         string
  stage_id?:            string
  assigned_to?:         string
  coupon_code?:         string
  default_generations?: number
  prompt_extra?:        string
  button_label?:        string
  /** Teto de custo de geração por dia (USD) pra esta org. Default 15. */
  daily_cost_cap_usd?:  number
}

export interface VisualizerCustomer {
  id:                  string
  organization_id:     string
  store_slug:          string
  name:                string | null
  email:               string | null
  phone:               string
  whatsapp_validated:  boolean
  validated_at:        string | null
  active_contact_id:   string | null
  generations_allowed: number
  generations_used:    number
  last_renewed_at:     string | null
  consent_at:          string | null
  created_at:          string
  updated_at:          string
}

interface StoreRow {
  organization_id:     string
  store_slug:          string
  store_name:          string | null
  visualizer_settings: VisualizerSettings | null
}

@Injectable()
export class StorefrontVisualizerService {
  private readonly logger = new Logger(StorefrontVisualizerService.name)

  constructor(
    private readonly bridge: ActiveBridgeClient,
    private readonly llm: LlmService,
  ) {}

  // ── Helpers de identidade ──────────────────────────────────────────────

  private secret(): string {
    // Sem fallback hardcoded: o segredo público permitia forjar token de
    // cliente + bypassar OTP. Falha alto se não configurado.
    const s = process.env.STOREFRONT_VISUALIZER_SECRET ?? process.env.STOREFRONT_JWT_SECRET
    if (!s) throw new HttpException('STOREFRONT_VISUALIZER_SECRET não configurado.', HttpStatus.SERVICE_UNAVAILABLE)
    return s
  }

  /** Token leve (HMAC) que identifica o cliente validado nas chamadas
   *  seguintes (gerar imagem). Formato: base64url(payload).hmac. */
  signCustomerToken(customerId: string, orgId: string): string {
    const payload = Buffer.from(JSON.stringify({
      c: customerId, o: orgId, exp: Date.now() + TOKEN_TTL_MS,
    })).toString('base64url')
    const sig = createHmac('sha256', this.secret()).update(payload).digest('base64url')
    return `${payload}.${sig}`
  }

  verifyCustomerToken(token: string): { customerId: string; orgId: string } | null {
    const [payload, sig] = (token ?? '').split('.')
    if (!payload || !sig) return null
    const expected = createHmac('sha256', this.secret()).update(payload).digest('base64url')
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c: string; o: string; exp: number }
      if (!data.c || !data.o || Date.now() > data.exp) return null
      return { customerId: data.c, orgId: data.o }
    } catch { return null }
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(`${this.secret()}:${code}`).digest('hex')
  }

  private normalizePhone(raw: string): string {
    return (raw ?? '').replace(/\D/g, '')
  }

  // ── Resolução da loja + settings ───────────────────────────────────────

  private async resolveStore(slug: string): Promise<StoreRow> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('organization_id, store_slug, store_name, visualizer_settings')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!data) throw new NotFoundException('Loja não encontrada.')
    return data as unknown as StoreRow
  }

  /** Config pública pra vitrine decidir mostrar (ou não) o botão. */
  async config(slug: string): Promise<{ enabled: boolean; buttonLabel: string }> {
    const store = await this.resolveStore(slug)
    const s = store.visualizer_settings ?? {}
    return {
      enabled:     s.enabled === true,
      buttonLabel: (s.button_label ?? '').trim() || 'Veja no seu ambiente',
    }
  }

  // ── Registro + OTP ─────────────────────────────────────────────────────

  /** Passo 1 do gate: grava/atualiza o cliente (ainda NÃO validado) e
   *  dispara um OTP de 6 dígitos no WhatsApp dele. */
  async register(input: {
    slug:   string
    name:   string
    email:  string
    phone:  string
    consent?: boolean
    ipHash?: string | null
  }): Promise<{ ok: true; otpSent: boolean; expiresInSec: number }> {
    const store = await this.resolveStore(input.slug)
    const settings = store.visualizer_settings ?? {}
    if (settings.enabled !== true) {
      throw new ForbiddenException('Ambientador IA não está ativo nesta loja.')
    }

    const name  = (input.name ?? '').trim()
    const email = (input.email ?? '').trim().toLowerCase()
    const phone = this.normalizePhone(input.phone)
    if (!name)  throw new BadRequestException('Informe seu nome.')
    if (!email || !email.includes('@')) throw new BadRequestException('Informe um e-mail válido.')
    if (phone.length < 10) throw new BadRequestException('Informe um WhatsApp válido com DDD.')
    // LGPD — consentimento obrigatório (foto do ambiente + dados pessoais)
    if (input.consent !== true) {
      throw new BadRequestException('É necessário aceitar o uso dos seus dados e da foto para continuar.')
    }

    const orgId = store.organization_id
    const nowIso = new Date().toISOString()

    // Anti-abuso: limite de OTPs por IP (além do limite por telefone). Protege
    // contra script que dispara WhatsApp pra muitos números do mesmo IP.
    if (input.ipHash) {
      const sinceIso = new Date(Date.now() - OTP_IP_WINDOW_MS).toISOString()
      const { count } = await supabaseAdmin
        .from('storefront_visualizer_otps')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).eq('client_ip_hash', input.ipHash)
        .gte('created_at', sinceIso)
      if ((count ?? 0) >= OTP_IP_MAX_PER_WINDOW) {
        throw new HttpException('Muitas solicitações. Tente novamente mais tarde.', HttpStatus.TOO_MANY_REQUESTS)
      }
    }

    // Upsert do cliente (mantém créditos se já existe; reseta validação)
    const existing = await this.findCustomer(orgId, phone)
    let customerId: string
    if (existing) {
      customerId = existing.id
      await supabaseAdmin
        .from('storefront_visualizer_customers')
        .update({ name, email, store_slug: input.slug, consent_at: nowIso })
        .eq('id', customerId)
    } else {
      const { data, error } = await supabaseAdmin
        .from('storefront_visualizer_customers')
        .insert({
          organization_id:     orgId,
          store_slug:          input.slug,
          name, email, phone,
          generations_allowed: clampInt(settings.default_generations ?? DEFAULT_GENERATIONS, 1, 50),
          client_ip_hash:      input.ipHash ?? null,
          consent_at:          nowIso,
        })
        .select('id')
        .maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro ao registrar: ${error?.message ?? '?'}`)
      customerId = (data as { id: string }).id
    }

    // Rate-limit de reenvio: 1 OTP por minuto por telefone
    const { data: recent } = await supabaseAdmin
      .from('storefront_visualizer_otps')
      .select('created_at')
      .eq('organization_id', orgId).eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (recent && Date.now() - new Date((recent as { created_at: string }).created_at).getTime() < OTP_RESEND_MS) {
      throw new HttpException('Aguarde 1 minuto pra pedir um novo código.', HttpStatus.TOO_MANY_REQUESTS)
    }

    // Gera + grava OTP (hash)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await supabaseAdmin
      .from('storefront_visualizer_otps')
      .insert({
        organization_id: orgId,
        phone,
        code_hash:  this.hashCode(code),
        expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        client_ip_hash: input.ipHash ?? null,
      })

    // Envia o código por WhatsApp (cria contato no Active de quebra)
    const storeName = store.store_name ?? 'a loja'
    const msg =
      `🔐 Seu código de acesso para o Ambientador IA da *${storeName}* é:\n\n` +
      `*${code}*\n\n` +
      `Ele expira em 10 minutos. Se você não pediu, ignore esta mensagem.`
    const sent = await this.bridge.sendDirectMessage({
      organization_id: orgId,
      phone,
      message:   msg,
      dedup_key: `visualizer_otp:${customerId}:${code}`,
    })

    return { ok: true, otpSent: Boolean(sent.sent), expiresInSec: Math.floor(OTP_TTL_MS / 1000) }
  }

  /** Passo 2 do gate: confere o OTP, marca o cliente como validado, cria o
   *  contato no Active e devolve o token + status de créditos. */
  async verify(input: {
    slug:  string
    phone: string
    code:  string
  }): Promise<{ ok: true; token: string; customer: PublicCustomer }> {
    const store = await this.resolveStore(input.slug)
    const orgId = store.organization_id
    const phone = this.normalizePhone(input.phone)
    const code  = (input.code ?? '').replace(/\D/g, '')
    if (code.length !== 6) throw new BadRequestException('Código inválido.')

    const { data: otpRaw } = await supabaseAdmin
      .from('storefront_visualizer_otps')
      .select('*')
      .eq('organization_id', orgId).eq('phone', phone)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    const otp = otpRaw as null | {
      id: string; code_hash: string; expires_at: string; attempts: number
    }
    if (!otp) throw new BadRequestException('Nenhum código pendente. Peça um novo.')
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      throw new BadRequestException('Código expirado. Peça um novo.')
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException('Muitas tentativas. Peça um novo código.')
    }

    const ok = safeEqualHex(otp.code_hash, this.hashCode(code))
    if (!ok) {
      await supabaseAdmin
        .from('storefront_visualizer_otps')
        .update({ attempts: otp.attempts + 1 })
        .eq('id', otp.id)
      throw new BadRequestException('Código incorreto.')
    }

    // Consome o OTP
    await supabaseAdmin
      .from('storefront_visualizer_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', otp.id)

    const customer = await this.findCustomer(orgId, phone)
    if (!customer) throw new NotFoundException('Cadastro não encontrado. Recomece.')

    // Marca validado
    await supabaseAdmin
      .from('storefront_visualizer_customers')
      .update({ whatsapp_validated: true, validated_at: new Date().toISOString() })
      .eq('id', customer.id)

    // Cria/acha o contato no Active (best-effort) e guarda o id
    if (!customer.active_contact_id) {
      try {
        const res = await this.bridge.upsertContact({
          organization_id: orgId,
          name:  customer.name ?? undefined,
          email: customer.email ?? undefined,
          phone: customer.phone,
          tags:  ['ambientador-ia', 'loja-propria'],
          source: 'storefront:visualizer',
        })
        if (res.contact_id) {
          await supabaseAdmin
            .from('storefront_visualizer_customers')
            .update({ active_contact_id: res.contact_id })
            .eq('id', customer.id)
          customer.active_contact_id = res.contact_id
        }
      } catch (e) {
        this.logger.warn(`[visualizer] upsertContact falhou customer=${customer.id}: ${(e as Error).message}`)
      }
    }

    const token = this.signCustomerToken(customer.id, orgId)
    return { ok: true, token, customer: toPublic({ ...customer, whatsapp_validated: true }) }
  }

  // ── Geração da ambientação (AH2) ───────────────────────────────────────

  /** Gera 2 imagens do produto aplicado na foto do ambiente do cliente.
   *  Debita 1 geração do saldo (devolve se a IA falhar). */
  async generate(input: {
    token:            string
    productId:        string
    productName?:     string
    sceneImageBase64: string
    sceneWidth?:      number
    sceneHeight?:     number
  }): Promise<GenerationResult> {
    const parsed = this.verifyCustomerToken(input.token)
    if (!parsed) throw new ForbiddenException('Sessão inválida ou expirada. Refaça o cadastro.')
    const { orgId, customerId } = parsed

    const customer = await this.getCustomerById(orgId, customerId)
    if (!customer) throw new NotFoundException('Cliente não encontrado.')
    if (!customer.whatsapp_validated) throw new ForbiddenException('Valide seu WhatsApp primeiro.')
    const left = customer.generations_allowed - customer.generations_used
    if (left <= 0) {
      throw new ForbiddenException('Você usou todas as suas ambientações. Faça uma compra pra ganhar mais!')
    }
    if (!input.productId) throw new BadRequestException('Produto não informado.')

    const store = await this.resolveStore(customer.store_slug)
    const settings = store.visualizer_settings ?? {}

    // 0. Teto de custo diário por org (anti-runaway). Soma o custo das gerações
    //    de hoje; se passou do limite, recusa sem debitar crédito.
    const cap = Number(settings.daily_cost_cap_usd ?? DEFAULT_DAILY_COST_CAP_USD)
    if (Number.isFinite(cap) && cap > 0) {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      const { data: todays } = await supabaseAdmin
        .from('storefront_visualizer_generations')
        .select('cost_usd')
        .eq('organization_id', orgId)
        .gte('created_at', dayStart.toISOString())
      const spent = (todays ?? []).reduce((s, r) => s + Number((r as { cost_usd: number | null }).cost_usd ?? 0), 0)
      if (spent >= cap) {
        throw new ForbiddenException('O limite diário de gerações desta loja foi atingido. Tente novamente amanhã.')
      }
    }

    // 1. Valida + decodifica a foto da cena
    const { buffer, mime } = this.decodeImage(input.sceneImageBase64)

    // 2. Resolve refs do produto (imagem-modelo do criativo → fotos do anúncio)
    const product = await this.resolveProductRefs(orgId, input.productId)
    const productName = (input.productName ?? product.name ?? 'o produto').trim()

    // 3. Sobe a cena (precisa de URL https pro generateImage)
    const sceneUrl = await this.uploadImage(orgId, 'scene', buffer, mime)

    // 4. Reserva 1 crédito (otimista) antes de chamar a IA
    await supabaseAdmin
      .from('storefront_visualizer_customers')
      .update({ generations_used: customer.generations_used + 1 })
      .eq('id', customerId)

    // 5. Grava a geração (processing)
    const { data: genRow } = await supabaseAdmin
      .from('storefront_visualizer_generations')
      .insert({
        organization_id: orgId,
        customer_id:     customerId,
        store_slug:      customer.store_slug,
        product_id:      input.productId,
        product_name:    productName,
        scene_image_url: sceneUrl,
        status:          'processing',
      })
      .select('id')
      .maybeSingle()
    const genId = (genRow as { id: string } | null)?.id ?? null

    // 6. Chama a IA (Nano Banana → fallback gpt-image-1 edits)
    const format = pickFormat(input.sceneWidth, input.sceneHeight)
    const prompt = buildRoomPrompt(productName, settings.prompt_extra)
    try {
      const out = await this.llm.generateImage({
        orgId,
        feature:         'storefront_room_compose',
        prompt,
        sourceImageUrls: [sceneUrl, ...product.refs].slice(0, 5),
        format,
        n:               IMAGES_PER_GEN,
      })

      const urls: string[] = []
      for (const img of out.images) {
        if (img.url && img.url.startsWith('http')) { urls.push(img.url); continue }
        if (img.b64) {
          const u = await this.uploadImage(orgId, 'out', Buffer.from(img.b64, 'base64'), 'image/png')
          urls.push(u)
        }
      }
      if (!urls.length) throw new Error('A IA não retornou imagens.')

      if (genId) {
        await supabaseAdmin
          .from('storefront_visualizer_generations')
          .update({ status: 'done', output_urls: urls, cost_usd: out.costUsd })
          .eq('id', genId)
      }

      // 7. Entrega no WhatsApp + card no funil de atendimento (best-effort)
      await this.deliverGeneration({
        orgId, store, settings, customer,
        generationId: genId, productId: input.productId, productName,
        sceneUrl, images: urls,
      }).catch(e => this.logger.warn(`[visualizer] entrega falhou: ${(e as Error).message}`))

      const updated = await this.getCustomerById(orgId, customerId)
      const remaining = updated
        ? Math.max(0, updated.generations_allowed - updated.generations_used)
        : Math.max(0, left - 1)
      return { ok: true, generationId: genId, images: urls, generationsLeft: remaining }
    } catch (e) {
      // Devolve o crédito + marca falha
      await supabaseAdmin
        .from('storefront_visualizer_customers')
        .update({ generations_used: customer.generations_used })
        .eq('id', customerId)
      if (genId) {
        await supabaseAdmin
          .from('storefront_visualizer_generations')
          .update({ status: 'failed', error: (e as Error).message.slice(0, 300) })
          .eq('id', genId)
      }
      this.logger.warn(`[visualizer] geração falhou customer=${customerId}: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu gerar agora. Seu crédito foi devolvido — tente de novo em instantes.')
    }
  }

  /** Provador de cor/acabamento (PV2): recolore o produto numa cena JÁ
   *  ambientada pela variante escolhida. Reusa a mesma cota, teto diário,
   *  ledger e entrega do Ambientador. Parte da última cena gerada do cliente
   *  pra esse produto base. */
  async recolor(input: {
    token:            string
    baseProductId:    string
    variantProductId: string
  }): Promise<GenerationResult> {
    const parsed = this.verifyCustomerToken(input.token)
    if (!parsed) throw new ForbiddenException('Sessão inválida ou expirada. Refaça o cadastro.')
    const { orgId, customerId } = parsed

    const customer = await this.getCustomerById(orgId, customerId)
    if (!customer) throw new NotFoundException('Cliente não encontrado.')
    if (!customer.whatsapp_validated) throw new ForbiddenException('Valide seu WhatsApp primeiro.')
    const left = customer.generations_allowed - customer.generations_used
    if (left <= 0) throw new ForbiddenException('Você usou todas as suas ambientações. Faça uma compra pra ganhar mais!')
    if (!input.baseProductId || !input.variantProductId) throw new BadRequestException('Produto/variante não informado.')

    const store = await this.resolveStore(customer.store_slug)
    const settings = store.visualizer_settings ?? {}

    // Teto de custo diário (igual ao generate)
    const cap = Number(settings.daily_cost_cap_usd ?? DEFAULT_DAILY_COST_CAP_USD)
    if (Number.isFinite(cap) && cap > 0) {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      const { data: todays } = await supabaseAdmin
        .from('storefront_visualizer_generations')
        .select('cost_usd')
        .eq('organization_id', orgId)
        .gte('created_at', dayStart.toISOString())
      const spent = (todays ?? []).reduce((s, r) => s + Number((r as { cost_usd: number | null }).cost_usd ?? 0), 0)
      if (spent >= cap) throw new ForbiddenException('O limite diário de gerações desta loja foi atingido. Tente novamente amanhã.')
    }

    // Variante precisa estar vinculada ao produto base
    const { data: link } = await supabaseAdmin
      .from('storefront_product_variants')
      .select('id')
      .eq('organization_id', orgId)
      .eq('base_product_id', input.baseProductId)
      .eq('variant_product_id', input.variantProductId)
      .maybeSingle()
    if (!link) throw new BadRequestException('Essa variante não está disponível para este produto.')

    // Cena de origem = última geração concluída do cliente pra esse produto base
    const { data: lastGen } = await supabaseAdmin
      .from('storefront_visualizer_generations')
      .select('scene_image_url, output_urls')
      .eq('organization_id', orgId)
      .eq('customer_id', customerId)
      .eq('product_id', input.baseProductId)
      .eq('status', 'done')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const composed = ((lastGen as { output_urls?: string[] } | null)?.output_urls ?? [])[0]
    const roomUrl  = (lastGen as { scene_image_url?: string } | null)?.scene_image_url ?? null
    if (!composed) throw new BadRequestException('Gere a ambientação deste produto primeiro pra poder trocar a cor.')

    // Referência da variante (imagem-modelo do criativo → fotos do anúncio)
    const variant = await this.resolveProductRefs(orgId, input.variantProductId)
    const variantName = (variant.name ?? 'a variante').trim()

    // Reserva 1 crédito (otimista)
    await supabaseAdmin
      .from('storefront_visualizer_customers')
      .update({ generations_used: customer.generations_used + 1 })
      .eq('id', customerId)

    const { data: genRow } = await supabaseAdmin
      .from('storefront_visualizer_generations')
      .insert({
        organization_id:    orgId,
        customer_id:        customerId,
        store_slug:         customer.store_slug,
        product_id:         input.baseProductId,
        variant_product_id: input.variantProductId,
        product_name:       variantName,
        kind:               'recolor',
        scene_image_url:    roomUrl ?? composed,
        status:             'processing',
      })
      .select('id')
      .maybeSingle()
    const genId = (genRow as { id: string } | null)?.id ?? null

    const prompt = buildRecolorPrompt(variantName, settings.prompt_extra)
    try {
      const out = await this.llm.generateImage({
        orgId,
        feature:         'storefront_room_recolor',
        prompt,
        sourceImageUrls: [composed, ...variant.refs].slice(0, 5),
        format:          'square',
        n:               IMAGES_PER_GEN,
      })
      const urls: string[] = []
      for (const img of out.images) {
        if (img.url && img.url.startsWith('http')) { urls.push(img.url); continue }
        if (img.b64) {
          const u = await this.uploadImage(orgId, 'out', Buffer.from(img.b64, 'base64'), 'image/png')
          urls.push(u)
        }
      }
      if (!urls.length) throw new Error('A IA não retornou imagens.')

      if (genId) {
        await supabaseAdmin
          .from('storefront_visualizer_generations')
          .update({ status: 'done', output_urls: urls, cost_usd: out.costUsd })
          .eq('id', genId)
      }

      await this.deliverGeneration({
        orgId, store, settings, customer,
        generationId: genId, productId: input.variantProductId, productName: variantName,
        sceneUrl: roomUrl ?? composed, images: urls,
      }).catch(e => this.logger.warn(`[visualizer] entrega recolor falhou: ${(e as Error).message}`))

      const updated = await this.getCustomerById(orgId, customerId)
      const remaining = updated
        ? Math.max(0, updated.generations_allowed - updated.generations_used)
        : Math.max(0, left - 1)
      return { ok: true, generationId: genId, images: urls, generationsLeft: remaining }
    } catch (e) {
      await supabaseAdmin
        .from('storefront_visualizer_customers')
        .update({ generations_used: customer.generations_used })
        .eq('id', customerId)
      if (genId) {
        await supabaseAdmin
          .from('storefront_visualizer_generations')
          .update({ status: 'failed', error: (e as Error).message.slice(0, 300) })
          .eq('id', genId)
      }
      this.logger.warn(`[visualizer] recolor falhou customer=${customerId}: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu trocar a cor agora. Seu crédito foi devolvido — tente de novo.')
    }
  }

  /** Entrega a ambientação: manda as imagens no WhatsApp do cliente (com
   *  link do produto + cupom) e abre um card no funil de atendimento da loja
   *  (cria o funil se preciso). Best-effort — nunca lança. */
  private async deliverGeneration(args: {
    orgId:        string
    store:        StoreRow
    settings:     VisualizerSettings
    customer:     VisualizerCustomer
    generationId: string | null
    productId:    string
    productName:  string
    sceneUrl:     string
    images:       string[]
  }): Promise<void> {
    const { orgId, store, settings, customer, generationId, productId, productName, sceneUrl, images } = args

    // 1. Resolve funil de destino (config do lojista → senão cria o padrão)
    let pipelineId = settings.pipeline_id
    let stageId    = settings.stage_id
    if (!pipelineId || !stageId) {
      const res = await this.bridge.ensureServicePipeline({ organization_id: orgId })
      if (res.pipeline_id && res.default_stage_id) {
        pipelineId = res.pipeline_id
        stageId    = res.default_stage_id
        // cacheia os ids na config da loja pra não recriar/buscar toda vez
        try {
          await supabaseAdmin
            .from('store_config')
            .update({ visualizer_settings: { ...settings, pipeline_id: pipelineId, stage_id: stageId } })
            .eq('store_slug', store.store_slug)
        } catch { /* ignore */ }
      }
    }

    // 2. Monta a legenda (link do produto + cupom de incentivo)
    const base = (process.env.STOREFRONT_PUBLIC_URL ?? 'https://eclick.app.br').replace(/\/+$/, '')
    const productUrl = `${base}/loja/${store.store_slug}/produto/${productId}`
    const lines = [
      `✨ Olha como o *${productName}* fica no seu ambiente!`,
      `Geramos essas imagens especialmente pra você. 😍`,
    ]
    if (settings.coupon_code?.trim()) {
      lines.push(`\n🎁 Use o cupom *${settings.coupon_code.trim()}* e garanta um desconto na sua compra.`)
    }
    lines.push(`\n👉 Ver o produto: ${productUrl}`)
    const caption = lines.join('\n')

    // 3. Envia no WhatsApp do cliente (as 2 imagens + legenda)
    let sentOk = false
    try {
      const sent = await this.bridge.sendDirectMessage({
        organization_id: orgId,
        phone:           customer.phone,
        message:         caption,
        image_urls:      images,
        dedup_key:       `visualizer_gen:${generationId ?? randomUUID()}`,
      })
      sentOk = Boolean(sent.sent)
    } catch (e) {
      this.logger.warn(`[visualizer] WhatsApp falhou: ${(e as Error).message}`)
    }

    // 4. Abre card + tarefa no funil de atendimento
    let dealId: string | null = null
    if (pipelineId && stageId) {
      try {
        const card = await this.bridge.createCampaignCard({
          organization_id: orgId,
          pipeline_id:     pipelineId,
          stage_id:        stageId,
          assigned_to:     settings.assigned_to,
          contact_id:      customer.active_contact_id ?? undefined,
          title:           `${customer.name ?? 'Cliente'} — ambientou ${productName}`,
          task_title:      `Dar retorno: cliente ambientou "${productName}" no espaço dele`,
          tags:            ['ambientador-ia', 'loja-propria'],
          metadata: {
            source:        'storefront:visualizer',
            product_id:    productId,
            product_name:  productName,
            scene_image:   sceneUrl,
            output_images: images,
            customer_phone: customer.phone,
            customer_email: customer.email,
          },
          dedup_key: `visualizer_gen:${generationId ?? productId}`,
        })
        dealId = card.deal_id ?? null
      } catch (e) {
        this.logger.warn(`[visualizer] card falhou: ${(e as Error).message}`)
      }
    }

    // 5. Marca a entrega na geração
    if (generationId) {
      await supabaseAdmin
        .from('storefront_visualizer_generations')
        .update({ whatsapp_sent: sentOk, active_deal_id: dealId })
        .eq('id', generationId)
        .then(undefined, () => undefined)
    }
  }

  /** Decodifica base64/data-URL → buffer validado (formato + tamanho). */
  private decodeImage(raw: string): { buffer: Buffer; mime: string } {
    if (!raw || typeof raw !== 'string') throw new BadRequestException('Imagem ausente.')
    let mime = 'image/jpeg'
    let b64 = raw
    const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s)
    if (m) { mime = m[1].toLowerCase(); b64 = m[2] }
    if (!ALLOWED_MIME.has(mime)) throw new BadRequestException('Formato inválido. Envie JPG, PNG ou WEBP.')
    let buffer: Buffer
    try { buffer = Buffer.from(b64, 'base64') } catch { throw new BadRequestException('Imagem inválida.') }
    if (buffer.length < 1024) throw new BadRequestException('Imagem muito pequena ou corrompida.')
    if (buffer.length > MAX_SCENE_BYTES) throw new BadRequestException('Imagem muito grande (máx. 7MB).')
    return { buffer, mime }
  }

  /** Sobe um buffer no bucket público e devolve a URL. */
  private async uploadImage(orgId: string, kind: 'scene' | 'out', buffer: Buffer, mime: string): Promise<string> {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    const path = `${orgId}/visualizer/${kind}/${randomUUID()}.${ext}`
    const { error } = await supabaseAdmin.storage
      .from(STOREFRONT_BUCKET)
      .upload(path, buffer, { contentType: mime, upsert: false })
    if (error) throw new BadRequestException(`Falha ao salvar imagem: ${error.message}`)
    const { data } = supabaseAdmin.storage.from(STOREFRONT_BUCKET).getPublicUrl(path)
    if (!data?.publicUrl) throw new BadRequestException('Falha ao obter URL da imagem.')
    return data.publicUrl
  }

  /** Resolve as imagens-modelo do produto: imagem inicial do criativo
   *  (creative_products.main_image_storage_path) → fallback fotos do anúncio
   *  (products.photo_urls). Valida que o produto é da org e está na vitrine. */
  private async resolveProductRefs(orgId: string, productId: string): Promise<{ name: string | null; refs: string[] }> {
    const { data: prodRaw } = await supabaseAdmin
      .from('products')
      .select('id, name, photo_urls, storefront_visible, organization_id')
      .eq('id', productId).eq('organization_id', orgId)
      .maybeSingle()
    const prod = prodRaw as null | { name: string | null; photo_urls: string[] | null; storefront_visible: boolean }
    if (!prod) throw new NotFoundException('Produto não encontrado nesta loja.')

    // Imagem-modelo do IA Criativo (preferencial)
    const { data: cpRaw } = await supabaseAdmin
      .from('creative_products')
      .select('main_image_storage_path')
      .eq('organization_id', orgId).eq('product_id', productId)
      .order('updated_at', { ascending: false })
      .limit(1).maybeSingle()
    const modelPath = (cpRaw as { main_image_storage_path: string | null } | null)?.main_image_storage_path

    const refs: string[] = []
    if (modelPath) {
      const { data: signed } = await supabaseAdmin.storage
        .from(CREATIVE_BUCKET)
        .createSignedUrl(modelPath, 600)
      if (signed?.signedUrl) refs.push(signed.signedUrl)
    }
    // Fallback (ou complemento): fotos do anúncio
    if (refs.length === 0) {
      for (const u of (prod.photo_urls ?? [])) {
        if (typeof u === 'string' && u.startsWith('http')) refs.push(u)
        if (refs.length >= 3) break
      }
    }
    if (refs.length === 0) {
      throw new BadRequestException('Este produto não tem imagem cadastrada para ambientar.')
    }
    return { name: prod.name, refs }
  }

  // ── Acesso ao cliente (usado por AH2/AH3) ──────────────────────────────

  async findCustomer(orgId: string, phone: string): Promise<VisualizerCustomer | null> {
    const { data } = await supabaseAdmin
      .from('storefront_visualizer_customers')
      .select('*')
      .eq('organization_id', orgId).eq('phone', this.normalizePhone(phone))
      .maybeSingle()
    return (data as unknown as VisualizerCustomer | null) ?? null
  }

  async getCustomerById(orgId: string, customerId: string): Promise<VisualizerCustomer | null> {
    const { data } = await supabaseAdmin
      .from('storefront_visualizer_customers')
      .select('*')
      .eq('organization_id', orgId).eq('id', customerId)
      .maybeSingle()
    return (data as unknown as VisualizerCustomer | null) ?? null
  }

  /** Status público do cliente (créditos restantes). Requer token. */
  async me(token: string): Promise<PublicCustomer> {
    const parsed = this.verifyCustomerToken(token)
    if (!parsed) throw new ForbiddenException('Sessão inválida ou expirada.')
    const customer = await this.getCustomerById(parsed.orgId, parsed.customerId)
    if (!customer) throw new NotFoundException('Cliente não encontrado.')
    return toPublic(customer)
  }

  // ── Lojista (dashboard) ────────────────────────────────────────────────

  private async getStoreByOrg(orgId: string): Promise<{ store_slug: string; visualizer_settings: VisualizerSettings }> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('store_slug, visualizer_settings')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) throw new NotFoundException('Loja não configurada.')
    const row = data as { store_slug: string; visualizer_settings: VisualizerSettings | null }
    return { store_slug: row.store_slug, visualizer_settings: row.visualizer_settings ?? {} }
  }

  /** Visão do dashboard: config + stats + gerações recentes + clientes. */
  async ownerView(orgId: string): Promise<{
    settings:    VisualizerSettings
    stats:       { customers: number; generations: number; whatsappSent: number }
    generations: Array<Record<string, unknown>>
    customers:   Array<Record<string, unknown>>
  }> {
    const store = await this.getStoreByOrg(orgId)

    const [{ data: gens }, { count: custCount }, { data: custs }, { count: genDone }, { count: sentCount }] = await Promise.all([
      supabaseAdmin.from('storefront_visualizer_generations')
        .select('id, customer_id, product_name, scene_image_url, output_urls, status, whatsapp_sent, active_deal_id, created_at')
        .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(60),
      supabaseAdmin.from('storefront_visualizer_customers')
        .select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      supabaseAdmin.from('storefront_visualizer_customers')
        .select('id, name, email, phone, whatsapp_validated, generations_allowed, generations_used, last_renewed_at, created_at')
        .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100),
      supabaseAdmin.from('storefront_visualizer_generations')
        .select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'done'),
      supabaseAdmin.from('storefront_visualizer_generations')
        .select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('whatsapp_sent', true),
    ])

    return {
      settings:    store.visualizer_settings,
      stats:       { customers: custCount ?? 0, generations: genDone ?? 0, whatsappSent: sentCount ?? 0 },
      generations: (gens ?? []) as Array<Record<string, unknown>>,
      customers:   (custs ?? []) as Array<Record<string, unknown>>,
    }
  }

  /** Atualiza a config do Ambientador (merge no store_config.visualizer_settings). */
  async ownerUpdateSettings(orgId: string, patch: Partial<VisualizerSettings>): Promise<VisualizerSettings> {
    const store = await this.getStoreByOrg(orgId)
    const next: VisualizerSettings = { ...store.visualizer_settings }
    if (patch.enabled !== undefined)             next.enabled = Boolean(patch.enabled)
    if (patch.button_label !== undefined)        next.button_label = String(patch.button_label).slice(0, 60)
    if (patch.coupon_code !== undefined)         next.coupon_code = String(patch.coupon_code).trim().slice(0, 40) || undefined
    if (patch.prompt_extra !== undefined)        next.prompt_extra = String(patch.prompt_extra).slice(0, 600) || undefined
    if (patch.default_generations !== undefined) next.default_generations = clampInt(Number(patch.default_generations), 1, 50)
    if (patch.daily_cost_cap_usd !== undefined)  next.daily_cost_cap_usd = clampInt(Number(patch.daily_cost_cap_usd), 1, 500)
    if (patch.pipeline_id !== undefined)         next.pipeline_id = patch.pipeline_id || undefined
    if (patch.stage_id !== undefined)            next.stage_id = patch.stage_id || undefined
    if (patch.assigned_to !== undefined)         next.assigned_to = patch.assigned_to || undefined

    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ visualizer_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao salvar: ${error.message}`)
    return next
  }

  /** Concede créditos extras a um cliente (aumenta generations_allowed). */
  async grantCredits(orgId: string, customerId: string, amount: number): Promise<{ ok: true; generationsLeft: number }> {
    const n = clampInt(Number(amount), 1, 100)
    const customer = await this.getCustomerById(orgId, customerId)
    if (!customer) throw new NotFoundException('Cliente não encontrado.')
    const allowed = customer.generations_allowed + n
    const { error } = await supabaseAdmin
      .from('storefront_visualizer_customers')
      .update({ generations_allowed: allowed })
      .eq('id', customerId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true, generationsLeft: Math.max(0, allowed - customer.generations_used) }
  }
}

export interface PublicCustomer {
  id:                 string
  name:               string | null
  whatsappValidated:  boolean
  generationsAllowed: number
  generationsUsed:    number
  generationsLeft:    number
}

export interface GenerationResult {
  ok:              true
  generationId:    string | null
  images:          string[]
  generationsLeft: number
}

function toPublic(c: VisualizerCustomer): PublicCustomer {
  return {
    id:                 c.id,
    name:               c.name,
    whatsappValidated:  c.whatsapp_validated,
    generationsAllowed: c.generations_allowed,
    generationsUsed:    c.generations_used,
    generationsLeft:    Math.max(0, c.generations_allowed - c.generations_used),
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')) }
  catch { return false }
}

/** Escolhe o formato de saída mais próximo das proporções da foto da cena
 *  (enquadramento proporcional). Default quadrado quando não há dimensões. */
function pickFormat(w?: number, h?: number): ImageFormat {
  if (!w || !h || w <= 0 || h <= 0) return 'square'
  const ratio = w / h
  if (ratio >= 1.3) return 'wide'
  if (ratio <= 0.78) return 'story'
  return 'square'
}

/** Prompt de fidelidade: insere o produto na cena SEM mudar ambiente nem
 *  produto, só corrigindo exposição/ruído/inclinação. */
function buildRoomPrompt(productName: string, extra?: string): string {
  const base = [
    `Você é um compositor fotográfico profissional. A PRIMEIRA imagem é a FOTO REAL DO AMBIENTE de um cliente. As imagens seguintes são o PRODUTO a ser inserido: "${productName}".`,
    `TAREFA: inserir o produto de forma fotorrealista no ambiente da primeira imagem, como se ele já estivesse fisicamente ali.`,
    `REGRAS ESTRITAS (obrigatórias):`,
    `1. NÃO altere o ambiente: mantenha paredes, piso, móveis, janelas, objetos, cores e a perspectiva EXATAMENTE como na foto original.`,
    `2. NÃO altere o produto: reproduza com fidelidade total a forma, cor, material, textura, proporções e detalhes do produto de referência.`,
    `3. Posicione o produto em escala e perspectiva corretas para o ambiente, com sombras, reflexos e iluminação coerentes com a cena.`,
    `4. Melhore SUTILMENTE a qualidade da foto: se estiver escura, clareie; se houver ruído ou sujeira, limpe; se estiver torta, alinhe. Sem exageros e SEM mudar o conteúdo do ambiente.`,
    `5. Enquadramento proporcional ao ambiente original. Resultado realista de catálogo, sem texto, sem marca d'água, sem bordas, sem colagem artificial.`,
  ]
  if (extra && extra.trim()) base.push(`Contexto adicional do lojista: ${extra.trim()}`)
  return base.join('\n')
}

/** Prompt do provador: troca SÓ a cor/acabamento do produto numa cena pronta,
 *  mantendo ambiente + posição idênticos. */
function buildRecolorPrompt(variantName: string, extra?: string): string {
  const base = [
    `A PRIMEIRA imagem é uma CENA PRONTA: o ambiente de um cliente com um produto já inserido. As imagens seguintes são a VARIANTE de cor/acabamento desejada do MESMO produto: "${variantName}".`,
    `TAREFA: gerar a MESMA cena, trocando APENAS a cor/acabamento do produto pra bater fielmente com a referência da variante.`,
    `REGRAS ESTRITAS:`,
    `1. NÃO altere o ambiente: paredes, piso, móveis, objetos, perspectiva e iluminação EXATAMENTE iguais à primeira imagem.`,
    `2. NÃO mova nem redimensione o produto: mesma posição, escala, ângulo e sombras.`,
    `3. Mude SOMENTE a cor/material/acabamento do produto pra corresponder fielmente à variante de referência (textura e brilho coerentes).`,
    `4. Resultado fotorrealista de catálogo, sem texto, sem marca d'água, sem bordas, sem colagem artificial.`,
  ]
  if (extra && extra.trim()) base.push(`Contexto adicional do lojista: ${extra.trim()}`)
  return base.join('\n')
}
