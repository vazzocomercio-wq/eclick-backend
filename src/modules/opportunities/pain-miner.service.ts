import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { OpportunitiesService } from './opportunities.service'
import { MineResult, OppReviewRow, PainQuote } from './opportunities.types'

/** Reviews 5★ só entram se tiverem ressalva ("porém", "só faltou"…). */
const CAVEAT_RE = /\b(por[eé]m|mas |s[oó] (que|faltou|n[aã]o)|faltou|pena que|poderia|infelizmente|n[aã]o (tem|veio|acompanha|encaixa|fica)|dif[ií]cil)\b/i
/** Máximo de reviews mandadas pra IA (custo/contexto). */
const MAX_REVIEWS = 250
/** Corte de caracteres por review. */
const MAX_CHARS = 400
/** ≥3 citações validadas = DOR; abaixo = HIPÓTESE (regra dura anti-alucinação). */
const MIN_QUOTES_FOR_DOR = 3

/**
 * Radar de Encaixe — Peça 3: minerar DORES nas avaliações com IA.
 *
 * A IA lê as reviews reais (prioridade 2-4★) e agrupa queixas RECORRENTES
 * que um acessório impresso em 3D poderia resolver. Regra dura: toda citação
 * devolvida é VALIDADA contra o texto original (substring) — citação
 * inventada é descartada; dor sem ≥3 citações validadas vira "hipótese".
 */
@Injectable()
export class PainMinerService {
  private readonly logger = new Logger(PainMinerService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly opp: OpportunitiesService,
  ) {}

  async mineForHost(orgId: string, hostId: string): Promise<MineResult> {
    const host = await this.opp.getHost(orgId, hostId)

    // corpus: todas ≤4★ com texto + 5★ com ressalva
    const { data, error } = await supabaseAdmin.from('opp_review')
      .select('id,external_id,rate,title,content,likes')
      .eq('organization_id', orgId).eq('host_id', hostId)
      .not('content', 'is', null)
      .order('rate', { ascending: true })
      .limit(1200)
    if (error) throw new BadRequestException(`opp_review: ${error.message}`)
    const all = (data ?? []) as Pick<OppReviewRow, 'id' | 'external_id' | 'rate' | 'title' | 'content' | 'likes'>[]
    const low  = all.filter(r => r.rate <= 4)
    const high = all.filter(r => r.rate === 5 && CAVEAT_RE.test(r.content ?? ''))
    const corpus = [...low, ...high].slice(0, MAX_REVIEWS)
    if (corpus.length < 5) {
      throw new BadRequestException(
        `Só ${corpus.length} avaliações com texto útil no cache — clique "Puxar avaliações" primeiro (ou o produto tem poucas queixas).`,
      )
    }

    const lines = corpus.map(r =>
      `[${r.external_id}] ${r.rate}★ ${(r.content ?? '').replace(/\s+/g, ' ').slice(0, MAX_CHARS)}`,
    ).join('\n')

    const systemPrompt = [
      'Você é um designer industrial especializado em acessórios impressos em 3D (FDM, PLA/PETG, mesa 256mm).',
      'Sua tarefa: ler avaliações REAIS de consumidores de um produto e agrupar QUEIXAS RECORRENTES que um acessório externo impresso em 3D poderia resolver (suporte, organizador, tampa, guia de fio, adaptador, protetor…).',
      'REGRAS INEGOCIÁVEIS:',
      '1. Só reporte dores presentes nos textos. NUNCA invente.',
      '2. Cada citação (excerpt) deve ser um trecho LITERAL copiado do texto da avaliação, com o review_id de onde veio (o código entre colchetes).',
      '3. Ignore queixas que acessório externo NÃO resolve: defeito de fábrica, entrega, atendimento, durabilidade interna, desempenho elétrico.',
      '4. Agrupe formulações diferentes da MESMA dor (ex: "não tem onde guardar" + "fica jogado na gaveta" = 1 dor de armazenamento).',
      '5. Responda SÓ o JSON pedido, em PT-BR.',
    ].join('\n')

    const userPrompt = [
      `Produto: ${host.title ?? host.anchor_item_id}${host.brand ? ` (marca ${host.brand})` : ''}`,
      `Categoria: ${host.category_name ?? '?'} · ${corpus.length} avaliações abaixo (formato: [review_id] estrelas★ texto)`,
      '',
      lines,
      '',
      'Devolva JSON: {"pains":[{"label":"frase curta da dor","description":"1-2 frases explicando + que tipo de acessório resolveria","quotes":[{"review_id":"…","excerpt":"trecho literal"}],"confidence":0.0}]}',
      'Ordene da dor mais recorrente pra menos. Máximo 8 dores.',
    ].join('\n')

    const out = await this.llm.generateText({
      orgId,
      feature:      'opportunity_pain_mining',
      systemPrompt,
      userPrompt,
      jsonMode:     true,
      maxTokens:    8000,
      temperature:  0.2,
    })

    let parsed: { pains?: Array<{ label?: string; description?: string; confidence?: number; quotes?: Array<{ review_id?: string; excerpt?: string }> }> }
    try {
      // tolera cerca markdown e prosa em volta do objeto
      const cleaned = out.text.replace(/```json/gi, '').replace(/```/g, '').trim()
      const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
      parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned) as typeof parsed
    } catch {
      this.logger.warn(`[opp.mine] resposta não-JSON da IA (model=${out.model}): ${out.text.slice(0, 300)}`)
      throw new BadRequestException('A IA devolveu um formato inesperado — rode a mineração de novo.')
    }

    // validação anti-alucinação: excerpt tem que EXISTIR na review citada
    const byExternal = new Map(corpus.map(r => [r.external_id, r]))
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
    const rows: Array<Record<string, unknown>> = []
    let dores = 0, hipoteses = 0
    for (const p of parsed.pains ?? []) {
      if (!p.label) continue
      const validated: PainQuote[] = []
      for (const q of p.quotes ?? []) {
        const src = q.review_id ? byExternal.get(q.review_id) : undefined
        if (!src || !q.excerpt) continue
        if (norm(src.content ?? '').includes(norm(q.excerpt))) {
          validated.push({ review_id: q.review_id as string, rate: src.rate, excerpt: q.excerpt })
        }
      }
      if (validated.length === 0) continue  // dor sem NENHUMA evidência real não entra
      const kind = validated.length >= MIN_QUOTES_FOR_DOR ? 'dor' : 'hipotese'
      if (kind === 'dor') dores++; else hipoteses++
      rows.push({
        organization_id: orgId,
        host_id:         hostId,
        kind,
        label:           String(p.label).slice(0, 200),
        description:     p.description ? String(p.description).slice(0, 1000) : null,
        quote_count:     validated.length,
        quotes:          validated,
        confidence:      typeof p.confidence === 'number' ? Math.min(1, Math.max(0, p.confidence)) : null,
        ai_model:        out.model,
        status:          'nova',
      })
    }

    // re-mineração substitui só o que ainda está 'nova' (decisões manuais ficam)
    await supabaseAdmin.from('opp_pain').delete()
      .eq('organization_id', orgId).eq('host_id', hostId).eq('status', 'nova')
    if (rows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('opp_pain').insert(rows)
      if (insErr) throw new BadRequestException(`opp_pain insert: ${insErr.message}`)
    }
    await supabaseAdmin.from('opp_host').update({
      mined_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('organization_id', orgId).eq('id', hostId)

    this.logger.log(`[opp.mine] host=${hostId} corpus=${corpus.length} pains=${rows.length} (${dores} dores / ${hipoteses} hipóteses)`)
    return { reviews_considered: corpus.length, pains: rows.length, dores, hipoteses }
  }
}
