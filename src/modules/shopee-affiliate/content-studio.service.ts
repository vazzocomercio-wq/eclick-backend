import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { LinkStudioService } from './link-studio.service'

/** F18 F2.6 — Content Studio Afiliado.
 *
 *  Gera roteiro/legenda de venda por canal via Copiloto Sonnet (LlmService),
 *  com CTA + link rastreável injetado (Link Studio F2.4). O conteúdo final
 *  vai pro Social AI Studio do Active pra agendar/publicar (Shopee Video/
 *  Live como destinos — integração cross-repo). Aqui só GERAMOS.
 *
 *  T3 do roadmap: NÃO duplica o Social AI; produz o copy pronto pra ele. */
@Injectable()
export class ContentStudioService {
  private readonly logger = new Logger(ContentStudioService.name)

  constructor(
    private readonly llm:        LlmService,
    private readonly linkStudio: LinkStudioService,
  ) {}

  /** Gera conteúdo de afiliado pra uma oferta + canal. Cria um link
   *  rastreável (sub_id por canal) e injeta no copy. */
  async generate(args: {
    orgId:   string
    itemId:  number
    channel: string
    tone?:   string
  }): Promise<ContentResult> {
    // Busca a oferta pra contexto
    const { data: offer } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_offers')
      .select('item_id, name, category, price_cents, commission_rate, rating')
      .eq('organization_id', args.orgId)
      .eq('item_id', args.itemId)
      .maybeSingle()
    if (!offer) throw new BadRequestException('Oferta não encontrada nesta org')
    const o = offer as {
      item_id: number; name: string | null; category: string | null
      price_cents: number | null; commission_rate: number; rating: number | null
    }

    // Gera link rastreável pra injetar no copy (cria registro + sub_id)
    const link = await this.linkStudio.generate({
      orgId:   args.orgId,
      itemId:  args.itemId,
      channel: args.channel,
    })

    const priceBRL = o.price_cents != null
      ? (o.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : 'consultar'

    const channelBrief = CHANNEL_BRIEFS[args.channel] ?? CHANNEL_BRIEFS.whatsapp

    const systemPrompt =
      'Você é um copywriter especialista em afiliados Shopee no Brasil. ' +
      'Escreve copy de venda persuasivo, direto, com gatilhos de urgência e ' +
      'prova social, sempre em PT-BR coloquial. NUNCA inventa características ' +
      'do produto além do informado. Sempre inclui o link fornecido no CTA. ' +
      'Pico de conversão no Brasil é 19h-22h — assuma esse contexto.'

    const userPrompt = [
      `Produto: ${o.name ?? `Item ${o.item_id}`}`,
      `Categoria: ${o.category ?? 'iluminação'}`,
      `Preço: ${priceBRL}`,
      o.rating != null ? `Avaliação: ${o.rating.toFixed(1)} estrelas` : null,
      `Comissão de afiliado: ${(o.commission_rate * 100).toFixed(0)}%`,
      `Link rastreável (use no CTA): ${link.short_url}`,
      args.tone ? `Tom desejado: ${args.tone}` : null,
      '',
      `Canal: ${args.channel}. ${channelBrief}`,
      '',
      'Gere o conteúdo pronto pra publicar. Sem preâmbulo, sem explicação — ' +
      'só o texto final que vai ao ar.',
    ].filter(Boolean).join('\n')

    let text: string
    try {
      const out = await this.llm.generateText({
        orgId:        args.orgId,
        feature:      'shopee_affiliate_content',
        systemPrompt,
        userPrompt,
        maxTokens:    700,
        temperature:  0.8,
      })
      text = out.text.trim()
    } catch (e) {
      this.logger.error(`[content-studio] LLM falhou: ${(e as Error)?.message}`)
      throw new BadRequestException('Falha ao gerar conteúdo. Verifique config de IA em Configurações.')
    }

    return {
      item_id:    args.itemId,
      name:       o.name,
      channel:    args.channel,
      content:    text,
      short_url:  link.short_url,
      sub_id:     link.sub_id,
      link_id:    link.id,
    }
  }
}

/** Briefing por canal — formato + tamanho + estilo do copy. */
const CHANNEL_BRIEFS: Record<string, string> = {
  whatsapp:
    'Mensagem curta de WhatsApp (3-5 linhas), tom de amigo indicando, ' +
    '1-2 emojis no máximo, link no final com CTA claro tipo "Garante o seu: {link}".',
  instagram:
    'Legenda de post/reel do Instagram: hook forte na 1ª linha, 3-4 linhas ' +
    'de benefício, 4-6 hashtags relevantes no fim, CTA com link.',
  tiktok:
    'Roteiro de vídeo TikTok de 15-30s: HOOK (0-3s) + 2-3 BENEFÍCIOS rápidos ' +
    '+ CTA. Formato em blocos [HOOK]/[CORPO]/[CTA]. Linguagem jovem e ágil.',
  shopee_video:
    'Roteiro de Shopee Video curto: gancho de oferta + demonstração de uso + ' +
    'CTA "compre pelo link". Estrutura em cenas numeradas.',
  shopee_live:
    'Bullets pro apresentador da Shopee Live: 4-6 pontos de fala persuasivos ' +
    'sobre o produto + frase de fechamento com senso de urgência.',
  blog:
    'Parágrafo de blog (4-6 linhas) review-style, tom editorial honesto, ' +
    'com link de afiliado natural no meio do texto.',
}

export interface ContentResult {
  item_id:   number
  name:      string | null
  channel:   string
  content:   string
  short_url: string
  sub_id:    string
  link_id:   string
}
