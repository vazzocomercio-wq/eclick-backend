import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../../common/supabase'
import { FULFILLMENT_BUCKET } from './fulfillment-labels.service'
// pdfkit é CommonJS e exporta o construtor direto — ver comentário em dropship.service.
import PDFDocument = require('pdfkit')

/**
 * DANFE — o "espelho" em papel da NF-e (F2b-8).
 *
 * Não é a nota: a nota é o XML autorizado. O DANFE é a representação impressa
 * que acompanha a mercadoria e que o comprador reconhece. Geramos a partir do
 * XML guardado (nunca de dados soltos do banco) — assim o papel é sempre fiel
 * ao que a SEFAZ autorizou.
 *
 * Layout enxuto e legível, com os blocos que a legislação exige: identificação
 * do emitente, chave + código de barras, protocolo, destinatário, totais,
 * itens e dados adicionais.
 */
@Injectable()
export class FulfillmentDanfeService {
  private readonly logger = new Logger(FulfillmentDanfeService.name)
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true })

  /** Devolve o PDF do DANFE. Gera na hora se ainda não existir e guarda no
   *  storage (o mesmo DANFE serve pra reimpressão). */
  async gerarDanfe(orgId: string, invoiceId: string): Promise<{ buffer: Buffer; filename: string; storagePath: string }> {
    const { data } = await supabaseAdmin
      .from('fulfillment_invoices')
      .select('id, access_key, number, status, xml_url, proc_xml_url')
      .eq('organization_id', orgId).eq('id', invoiceId).maybeSingle()
    const inv = data as { access_key: string | null; number: string | null; status: string; xml_url: string | null; proc_xml_url: string | null } | null
    if (!inv?.access_key) throw new NotFoundException('Nota não encontrada.')

    const chave = inv.access_key
    const base = `${orgId}/invoices/${chave}`
    const pdfPath = `${base}-danfe.pdf`

    const xml = await this.lerXmlDaNota(orgId, chave, inv.proc_xml_url, inv.xml_url)
    if (!xml) throw new BadRequestException('XML da nota não encontrado no arquivo — não consigo gerar o DANFE.')

    const buffer = await this.desenhar(xml, { cancelada: inv.status === 'cancelled' })
    await supabaseAdmin.storage.from(FULFILLMENT_BUCKET)
      .upload(pdfPath, buffer, { contentType: 'application/pdf', upsert: true })
    this.logger.log(`[danfe] NF ${inv.number} chave=${chave} (${buffer.length} bytes)`)
    return { buffer, filename: `DANFE-${chave}.pdf`, storagePath: pdfPath }
  }

  /** Lê o XML da nota do storage. Prefere o procNFe (tem o protocolo); cai pro
   *  assinado + retorno quando a nota é anterior ao procNFe automático. */
  private async lerXmlDaNota(orgId: string, chave: string, procUrl: string | null, xmlUrl: string | null): Promise<string | null> {
    const tentar = async (p: string): Promise<string | null> => {
      const { data } = await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).download(p)
      return data ? await data.text() : null
    }
    const base = `${orgId}/invoices/${chave}`
    const proc = await tentar(procUrl ?? `${base}-procNFe.xml`)
    if (proc) return proc
    // nota antiga: junta a assinada com o protocolo pra ter o mesmo conteúdo
    const nfe = await tentar(xmlUrl ?? `${base}-nfe.xml`)
    if (!nfe) return null
    const ret = await tentar(`${base}-prot.xml`)
    const prot = ret ? /<protNFe[\s\S]*?<\/protNFe>/.exec(ret)?.[0] : null
    return prot ? `<nfeProc versao="4.00">${nfe.replace(/^<\?xml[^>]*\?>/, '')}${prot}</nfeProc>` : nfe
  }

  // ── desenho ───────────────────────────────────────────────────────────────

  private async desenhar(xml: string, opts: { cancelada: boolean }): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = this.parser.parse(xml)
    const proc = j?.nfeProc ?? j
    const nfe = proc?.NFe ?? proc?.nfe ?? j?.NFe
    const inf = nfe?.infNFe
    if (!inf) throw new BadRequestException('XML da nota em formato inesperado.')

    const ide = inf.ide ?? {}, emit = inf.emit ?? {}, dest = inf.dest ?? {}
    const eEnd = emit.enderEmit ?? {}, dEnd = dest.enderDest ?? {}
    const tot = inf.total?.ICMSTot ?? {}
    const det = Array.isArray(inf.det) ? inf.det : inf.det ? [inf.det] : []
    const protInf = proc?.protNFe?.infProt ?? {}
    const chave = String(inf['@_Id'] ?? '').replace(/\D/g, '')
    const homolog = String(ide.tpAmb) === '2'

    const dinheiro = (v: unknown) => `R$ ${Number(v ?? 0).toFixed(2).replace('.', ',')}`
    const dataBr = (s: unknown) => { const d = new Date(String(s ?? '')); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR') }
    const doc = (o: Record<string, unknown>) => String(o.CNPJ ?? o.CPF ?? '')

    return new Promise<Buffer>((resolve, reject) => {
      try {
        const pdf = new PDFDocument({ size: 'A4', margin: 28 })
        const chunks: Buffer[] = []
        pdf.on('data', (c: Buffer) => chunks.push(c))
        pdf.on('end', () => resolve(Buffer.concat(chunks)))
        pdf.on('error', reject)

        const L = 28, R = pdf.page.width - 28, W = R - L
        const cinza = '#666666', preto = '#111111'
        let y = L

        const caixa = (altura: number, titulo?: string) => {
          pdf.roundedRect(L, y, W, altura, 3).lineWidth(0.7).strokeColor('#999999').stroke()
          if (titulo) pdf.fontSize(6).fillColor(cinza).text(titulo.toUpperCase(), L + 6, y + 4)
          return y
        }
        const campo = (rotulo: string, valor: string, x: number, yy: number, largura: number, tamanho = 8) => {
          pdf.fontSize(5.5).fillColor(cinza).text(rotulo.toUpperCase(), x, yy, { width: largura })
          pdf.fontSize(tamanho).fillColor(preto).text(valor || '—', x, yy + 7, { width: largura, ellipsis: true })
        }

        // ── cabeçalho: emitente | DANFE | chave ──────────────────────────
        caixa(96)
        pdf.fontSize(12).fillColor(preto).text(String(emit.xNome ?? ''), L + 8, y + 10, { width: W * 0.42 })
        pdf.fontSize(7).fillColor(cinza).text(
          [String(eEnd.xLgr ?? ''), String(eEnd.nro ?? ''), String(eEnd.xBairro ?? '')].filter(Boolean).join(', ') +
          `\n${eEnd.xMun ?? ''} / ${eEnd.UF ?? ''} — CEP ${eEnd.CEP ?? ''}` +
          `\nCNPJ ${doc(emit)}   IE ${emit.IE ?? ''}`,
          L + 8, y + 28, { width: W * 0.42 },
        )

        const cx = L + W * 0.46
        pdf.fontSize(16).fillColor(preto).text('DANFE', cx, y + 10, { width: W * 0.2, align: 'center' })
        pdf.fontSize(5.5).fillColor(cinza).text('Documento Auxiliar da\nNota Fiscal Eletrônica', cx, y + 30, { width: W * 0.2, align: 'center' })
        pdf.fontSize(9).fillColor(preto).text(`Nº ${String(ide.nNF ?? '')}   SÉRIE ${String(ide.serie ?? '')}`, cx, y + 52, { width: W * 0.2, align: 'center' })
        pdf.fontSize(7).fillColor(cinza).text(`${String(ide.tpNF) === '1' ? '1 - SAÍDA' : '0 - ENTRADA'}`, cx, y + 66, { width: W * 0.2, align: 'center' })

        // chave + código de barras (Code128-C) — é por ele que a nota é lida
        const bx = L + W * 0.68, bw = W * 0.3
        this.barcode128c(pdf, chave, bx, y + 10, bw, 26)
        pdf.fontSize(5.5).fillColor(cinza).text('CHAVE DE ACESSO', bx, y + 40, { width: bw })
        pdf.fontSize(7).fillColor(preto).text(chave.replace(/(\d{4})/g, '$1 ').trim(), bx, y + 48, { width: bw })
        pdf.fontSize(5.5).fillColor(cinza).text('PROTOCOLO DE AUTORIZAÇÃO', bx, y + 70, { width: bw })
        pdf.fontSize(7).fillColor(preto).text(`${protInf.nProt ?? '—'}  ${dataBr(protInf.dhRecbto)}`, bx, y + 78, { width: bw })
        y += 96 + 6

        // avisos que mudam o valor legal do papel
        if (homolog || opts.cancelada) {
          const aviso = opts.cancelada ? 'NF-e CANCELADA' : 'AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL'
          pdf.roundedRect(L, y, W, 20, 3).fillColor(opts.cancelada ? '#fdecec' : '#fff8e1').fill()
          pdf.fontSize(10).fillColor(opts.cancelada ? '#b91c1c' : '#a16207').text(aviso, L, y + 6, { width: W, align: 'center' })
          y += 26
        }

        // ── natureza da operação ────────────────────────────────────────
        caixa(26)
        campo('Natureza da operação', String(ide.natOp ?? ''), L + 8, y + 4, W * 0.6)
        campo('Emissão', dataBr(ide.dhEmi), L + W * 0.7, y + 4, W * 0.25)
        y += 26 + 6

        // ── destinatário ────────────────────────────────────────────────
        caixa(60, 'Destinatário / Remetente')
        campo('Nome', String(dest.xNome ?? ''), L + 8, y + 14, W * 0.55)
        campo('CPF / CNPJ', doc(dest), L + W * 0.62, y + 14, W * 0.35)
        campo('Endereço', [String(dEnd.xLgr ?? ''), String(dEnd.nro ?? ''), String(dEnd.xCpl ?? '')].filter(Boolean).join(', '), L + 8, y + 34, W * 0.55)
        campo('Bairro / Município / UF', `${dEnd.xBairro ?? ''} — ${dEnd.xMun ?? ''}/${dEnd.UF ?? ''}`, L + W * 0.62, y + 34, W * 0.35, 7)
        y += 60 + 6

        // ── totais ──────────────────────────────────────────────────────
        caixa(34, 'Cálculo do imposto')
        const cols = [
          ['Valor dos produtos', dinheiro(tot.vProd)],
          ['Frete', dinheiro(tot.vFrete)],
          ['Desconto', dinheiro(tot.vDesc)],
          ['Total da nota', dinheiro(tot.vNF)],
        ]
        cols.forEach(([r, v], i) => {
          const cw = W / cols.length
          campo(r, v, L + 8 + i * cw, y + 12, cw - 10, i === cols.length - 1 ? 10 : 8)
        })
        y += 34 + 6

        // ── itens ───────────────────────────────────────────────────────
        pdf.fontSize(6).fillColor(cinza).text('PRODUTOS / SERVIÇOS', L + 2, y); y += 10
        const colX = [L, L + 52, L + W * 0.56, L + W * 0.64, L + W * 0.70, L + W * 0.78, L + W * 0.88]
        const cab = ['CÓDIGO', 'DESCRIÇÃO', 'NCM', 'CFOP', 'QTD', 'V. UNIT', 'V. TOTAL']
        pdf.fontSize(5.5).fillColor(cinza)
        cab.forEach((c, i) => pdf.text(c, colX[i] + 2, y, { width: (colX[i + 1] ?? R) - colX[i] - 4, align: i >= 4 ? 'right' : 'left' }))
        y += 9
        pdf.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#cccccc').stroke(); y += 3

        for (const d of det) {
          const p = d.prod ?? {}
          if (y > pdf.page.height - 130) { pdf.addPage(); y = L }
          const linha = [
            String(p.cProd ?? ''), String(p.xProd ?? ''), String(p.NCM ?? ''), String(p.CFOP ?? ''),
            String(Number(p.qCom ?? 0).toFixed(0)), dinheiro(p.vUnCom), dinheiro(p.vProd),
          ]
          const alturaDesc = pdf.fontSize(7).heightOfString(linha[1], { width: colX[2] - colX[1] - 6 })
          pdf.fillColor(preto)
          linha.forEach((c, i) => pdf.fontSize(7).text(c, colX[i] + 2, y, { width: (colX[i + 1] ?? R) - colX[i] - 4, align: i >= 4 ? 'right' : 'left' }))
          y += Math.max(alturaDesc, 10) + 4
          pdf.moveTo(L, y - 2).lineTo(R, y - 2).lineWidth(0.3).strokeColor('#eeeeee').stroke()
        }

        // ── dados adicionais ────────────────────────────────────────────
        y += 6
        if (y > pdf.page.height - 90) { pdf.addPage(); y = L }
        caixa(60, 'Dados adicionais')
        const infCpl = String(inf.infAdic?.infCpl ?? '')
        const intermed = inf.infIntermed ? `Venda intermediada por marketplace (CNPJ ${inf.infIntermed.CNPJ}).` : ''
        // frase obrigatória do Simples/MEI (CRT 1 e 4). Em regime normal (3) não vai.
        const crt = String(emit.CRT ?? '')
        const fraseSimples = crt === '1' || crt === '4'
          ? 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE ICMS E DE ISS.'
          : ''
        pdf.fontSize(7).fillColor(preto).text(
          [infCpl, intermed, fraseSimples].filter(Boolean).join(' '),
          L + 8, y + 16, { width: W - 16 },
        )
        y += 60

        pdf.fontSize(5.5).fillColor('#999999').text(
          `Consulte a autenticidade em www.nfe.fazenda.gov.br/portal — gerado pelo e-Click em ${new Date().toLocaleString('pt-BR')}`,
          L, pdf.page.height - 40, { width: W, align: 'center' },
        )
        pdf.end()
      } catch (e) { reject(e as Error) }
    })
  }

  /** Código de barras CODE-128C da chave de acesso (44 dígitos = 22 pares).
   *  Desenhado com retângulos porque o repo não tem lib de barcode — e o DANFE
   *  sem código de barras não é lido nos postos de fiscalização. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private barcode128c(pdf: any, digitos: string, x: number, y: number, largura: number, altura: number): void {
    const d = digitos.replace(/\D/g, '')
    if (d.length % 2 !== 0) return
    const START_C = 105, STOP = 106
    const valores: number[] = [START_C]
    for (let i = 0; i < d.length; i += 2) valores.push(Number(d.slice(i, i + 2)))
    let soma = START_C
    for (let i = 1; i < valores.length; i++) soma += valores[i] * i
    valores.push(soma % 103, STOP)

    const modulos: number[] = []
    for (const v of valores) {
      const padrao = CODE128[v]
      if (!padrao) return
      for (const ch of padrao) modulos.push(Number(ch))
    }
    const totalModulos = modulos.reduce((s, m) => s + m, 0)
    const unidade = largura / totalModulos
    let cursor = x
    modulos.forEach((m, i) => {
      const w = m * unidade
      if (i % 2 === 0) pdf.rect(cursor, y, w, altura).fillColor('#000000').fill()   // par = barra
      cursor += w
    })
  }
}

/** Tabela de padrões do Code 128 (larguras de barra/espaço), índices 0..106. */
const CODE128: string[] = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112').split(/\s+/)
