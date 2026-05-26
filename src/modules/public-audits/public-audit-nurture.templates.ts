/**
 * Templates da nutrição da Auditoria GEO (Sprint 2c).
 * 5 passos (D+0..D+10) × email (HTML) + WhatsApp (texto).
 *
 * Tom: e-Click / Silvio — direto, sem venda agressiva, educativo.
 * IMPORTANTE: NÃO usar números do piloto (649/99%/etc) até o ImpactTracker
 * fechar (após 11/06). O D+5 fala do teste em andamento de forma honesta.
 */

export type NurtureStep = 'd0' | 'd2' | 'd5' | 'd8' | 'd10'

export interface NurtureCtx {
  firstName:   string
  score:       number
  band:        'red' | 'yellow' | 'green'
  topProblems: string[]   // títulos dos 3 problemas
  resultUrl:   string
}

const DEMO_URL = 'https://eclick.app.br' // TODO: link real de demo/Calendly

function bandPhrase(band: NurtureCtx['band']): string {
  if (band === 'red') return 'sua marca está praticamente invisível pra IA'
  if (band === 'yellow') return 'sua marca aparece, mas raramente no topo'
  return 'sua marca está entre as mais bem posicionadas'
}

// ── Email (HTML) ────────────────────────────────────────────────────────

function emailShell(inner: string): string {
  return `<div style="background:#f4f4f5;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e4e7">
    <div style="background:#09090b;padding:18px 28px">
      <span style="font-size:18px;font-weight:800;color:#fafafa;letter-spacing:-0.02em">e<span style="color:#00B3CC">-</span>Click</span>
      <span style="font-size:11px;color:#a1a1aa;margin-left:8px">Inteligência Comercial</span>
    </div>
    <div style="padding:28px">${inner}</div>
    <div style="padding:16px 28px;border-top:1px solid #e4e4e7;color:#a1a1aa;font-size:12px;line-height:1.5">
      e-Click · Inteligência Comercial<br/>
      Você recebeu este email porque pediu uma Auditoria GEO gratuita. Não quer mais receber? Responda este email com "sair".
    </div>
  </div>
</div>`
}

function cta(url: string, text: string): string {
  return `<a href="${url}" style="display:inline-block;background:#00B3CC;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px;font-size:15px;margin:8px 0">${text} →</a>`
}

function problemsList(items: string[]): string {
  return `<ol style="padding-left:20px;margin:12px 0;color:#3f3f46;font-size:15px;line-height:1.7">${items.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>`
}

export function emailFor(step: NurtureStep, c: NurtureCtx): { subject: string; html: string } {
  const nome = escapeHtml(c.firstName)
  switch (step) {
    case 'd0':
      return {
        subject: `🎯 ${c.firstName}, sua nota GEO é ${c.score}/100`,
        html: emailShell(
          `<p style="font-size:16px;color:#18181b;margin:0 0 14px">Oi ${nome},</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:0 0 16px">Analisei o link que você enviou. Aqui está o resultado:</p>
           <div style="text-align:center;background:#f4f4f5;border-radius:12px;padding:24px;margin:0 0 16px">
             <div style="font-size:48px;font-weight:900;color:#18181b;line-height:1">${c.score}<span style="font-size:20px;color:#71717a">/100</span></div>
             <div style="font-size:13px;color:#71717a;margin-top:4px">Nota GEO</div>
           </div>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:0 0 6px">Em uma frase: <b>${bandPhrase(c.band)}</b>.</p>
           <p style="font-size:15px;color:#18181b;font-weight:700;margin:18px 0 0">Os 3 problemas mais críticos pra resolver:</p>
           ${problemsList(c.topProblems)}
           <div style="text-align:center;margin:22px 0 6px">${cta(c.resultUrl, 'Ver meu resultado completo')}</div>
           <p style="font-size:14px;color:#71717a;line-height:1.6;margin:18px 0 0">Em 2 dias te mando os 3 erros mais comuns que vejo em quase todo anúncio brasileiro (provavelmente no seu também).</p>
           <p style="font-size:14px;color:#3f3f46;margin:16px 0 0">Silvio · e-Click</p>`,
        ),
      }
    case 'd2':
      return {
        subject: 'Os 3 erros que matam sua visibilidade na IA',
        html: emailShell(
          `<p style="font-size:16px;color:#18181b;margin:0 0 14px">Oi ${nome},</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6">Os 3 erros mais comuns que a gente vê em 9 de cada 10 anúncios:</p>
           <p style="font-size:15px;color:#18181b;font-weight:700;margin:18px 0 4px">❌ Achar que "palavra-chave" ainda funciona</p>
           <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0">O paper do KDD 2024 (Princeton) provou: encher de palavra-chave PIORA a visibilidade em IA. Você precisa de dados, não de keywords.</p>
           <p style="font-size:15px;color:#18181b;font-weight:700;margin:18px 0 4px">❌ Descrição que repete o título</p>
           <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0">A IA quer profundidade: pra quem é? em qual situação? por que esse e não outro?</p>
           <p style="font-size:15px;color:#18181b;font-weight:700;margin:18px 0 4px">❌ Sem FAQ</p>
           <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0">A IA pensa em formato de pergunta. Sem responder perguntas, você não é citado nas respostas.</p>
           <p style="font-size:14px;color:#71717a;line-height:1.6;margin:18px 0 0">Daqui a 3 dias te conto o que estamos testando com anúncios reais.</p>
           <p style="font-size:14px;color:#3f3f46;margin:16px 0 0">Silvio · e-Click</p>`,
        ),
      }
    case 'd5':
      return {
        subject: 'Estamos testando GEO em anúncios reais. Te conto.',
        html: emailShell(
          `<p style="font-size:16px;color:#18181b;margin:0 0 14px">Oi ${nome},</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6">A gente não fala de GEO só na teoria. Selecionamos anúncios reais da nossa operação e aplicamos as técnicas de GEO <b>só na descrição</b> — mesma foto, mesmo preço.</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:14px 0 0">Estamos medindo o impacto em vendas num teste controlado de 30 dias. <b>Em breve compartilho os números reais</b> — sem promessa mágica, só o que o dado mostrar.</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:14px 0 0">Enquanto isso, a ciência por trás (E-GEO 2025, Columbia + MIT) já mostra uma "receita universal" do que faz a IA recomendar um produto: intenção, diferenciais, avaliações e factualidade.</p>
           <div style="text-align:center;margin:22px 0 6px">${cta(c.resultUrl, 'Rever minha auditoria')}</div>
           <p style="font-size:14px;color:#3f3f46;margin:16px 0 0">Silvio · e-Click</p>`,
        ),
      }
    case 'd8':
      return {
        subject: `${c.firstName}, que tal uma conversa de 30 min?`,
        html: emailShell(
          `<p style="font-size:16px;color:#18181b;margin:0 0 14px">Oi ${nome},</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6">Vou ser direto: o e-Click é o único sistema brasileiro que não só MEDE sua visibilidade em IA — também <b>reescreve</b> seu anúncio com IA, <b>simula o ranking</b> antes de publicar e <b>prova o impacto</b> em vendas.</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:14px 0 0">Se quiser ver funcionando no seu catálogo (na sua tela, sem demo genérica), é só responder este email ou clicar abaixo:</p>
           <div style="text-align:center;margin:22px 0 6px">${cta(DEMO_URL, 'Conhecer o e-Click')}</div>
           <p style="font-size:14px;color:#71717a;line-height:1.6;margin:14px 0 0">Sem pressão. Você decide.</p>
           <p style="font-size:14px;color:#3f3f46;margin:16px 0 0">Silvio · e-Click</p>`,
        ),
      }
    case 'd10':
      return {
        subject: 'A vitrine da IA muda toda semana. A sua acompanhou?',
        html: emailShell(
          `<p style="font-size:16px;color:#18181b;margin:0 0 14px">Oi ${nome},</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6">Nesses 10 dias, ChatGPT, Gemini e Perplexity lançaram atualizações. A "vitrine" que a IA mostra pros compradores está se reconstruindo o tempo todo.</p>
           <p style="font-size:15px;color:#3f3f46;line-height:1.6;margin:14px 0 0">Você fez a auditoria há 10 dias. Quer descobrir se algo mudou?</p>
           <div style="text-align:center;margin:22px 0 6px">${cta('https://eclick.app.br/auditoria-gratis', 'Refazer auditoria grátis')}</div>
           <p style="font-size:14px;color:#71717a;line-height:1.6;margin:14px 0 0">Ou responda este email se quiser conversar. Tô por aqui.</p>
           <p style="font-size:14px;color:#3f3f46;margin:16px 0 0">Silvio · e-Click</p>`,
        ),
      }
  }
}

// ── WhatsApp (texto) ─────────────────────────────────────────────────────

export function whatsappFor(step: NurtureStep, c: NurtureCtx): string {
  switch (step) {
    case 'd0':
      return `Oi ${c.firstName}! 🎯 Sua Nota GEO é *${c.score}/100* — ${bandPhrase(c.band)}.\n\n` +
        `Os 3 pontos mais críticos:\n${c.topProblems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n` +
        `Resultado completo: ${c.resultUrl}\n\n— Silvio, e-Click`
    case 'd2':
      return `Oi ${c.firstName}! Os 3 erros que mais matam visibilidade em IA:\n` +
        `1. Achar que palavra-chave ainda funciona (piora!)\n2. Descrição que só repete o título\n3. Não ter FAQ\n\n` +
        `Tudo isso a gente corrige no e-Click. — Silvio`
    case 'd5':
      return `Oi ${c.firstName}! Estamos testando GEO em anúncios reais (só mudando a descrição) e medindo o impacto em vendas. Em breve te mando os números reais. Sua auditoria: ${c.resultUrl} — Silvio`
    case 'd8':
      return `Oi ${c.firstName}! Quer ver o e-Click reescrevendo e simulando o ranking dos SEUS anúncios, ao vivo? 30 min, sem compromisso. Topa? — Silvio`
    case 'd10':
      return `Oi ${c.firstName}! A vitrine da IA muda toda semana. Quer refazer sua auditoria grátis e ver se mudou? https://eclick.app.br/auditoria-gratis — Silvio`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
