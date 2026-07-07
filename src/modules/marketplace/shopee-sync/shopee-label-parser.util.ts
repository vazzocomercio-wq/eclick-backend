/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse')

/** Extrai o DESTINATÁRIO aberto do PDF da etiqueta Shopee (SPX BR).
 *
 *  A API mascara nome/endereço em todo lugar (get_order_detail e
 *  get_shipping_document_data_info → recipient_address_info=null), mas o PDF
 *  da etiqueta carrega tudo impresso COM camada de texto extraível — validado
 *  ao vivo 2026-07-07 (Vazzo, pedido 2607073H18ABK6).
 *
 *  Estratégia ancorada no template do AWB: bloco entre os cabeçalhos
 *  DESTINATÁRIO e REMETENTE = [nome, endereço..., Bairro:, CEP:, Pedido:].
 *  Trava de segurança: o "Pedido:" do bloco TEM que bater com o order_sn
 *  esperado (garante que não enxertamos dados de outra etiqueta).
 *
 *  ⚠️ Partes da MESMA linha se juntam SEM espaço (o PDF quebra no meio da
 *  palavra: "DESTINA"+"TÁRIO", "A"+"venida"); linhas diferentes do endereço
 *  se juntam COM espaço ("... Minas" + "Gerais").
 */
export async function parseShopeeLabelRecipient(
  pdf: Buffer,
  expectedOrderSn: string,
): Promise<{ name: string; full_address: string; district?: string; zip_code?: string } | null> {
  const items: Array<{ s: string; x: number; y: number }> = []
  try {
    await pdfParse(pdf, {
      pagerender: (page: any) => page.getTextContent().then((tc: any) => {
        for (const i of tc.items ?? []) {
          items.push({ s: String(i.str), x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) })
        }
        return ''
      }),
    })
  } catch {
    return null
  }
  if (!items.length) return null

  // agrupa por linha (mesmo y ±2)
  const rowKeys: number[] = []
  const rows = new Map<number, Array<{ s: string; x: number }>>()
  for (const it of items) {
    let key = rowKeys.find(y => Math.abs(y - it.y) <= 2)
    if (key === undefined) { key = it.y; rowKeys.push(key); rows.set(key, []) }
    rows.get(key)!.push({ s: it.s, x: it.x })
  }
  const lines = [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([y, parts]) => ({ y, text: parts.sort((a, b) => a.x - b.x).map(p => p.s).join('').trim() }))

  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  const iDest = lines.findIndex(l => norm(l.text).startsWith('DESTINATARIO'))
  const iRem  = lines.findIndex(l => norm(l.text).startsWith('REMETENTE'))
  if (iDest < 0 || iRem <= iDest) return null
  const block = lines.slice(iDest + 1, iRem)

  // trava: a etiqueta é DESTE pedido
  const pedidoLine = block.find(l => /pedido:/i.test(l.text))
  const sn = pedidoLine ? pedidoLine.text.replace(/.*pedido:\s*/i, '').trim() : null
  if (!sn || sn !== expectedOrderSn) return null

  const labelIdx = block.findIndex(l => /^(bairro|cep|pedido):/i.test(l.text))
  if (labelIdx < 1) return null
  const name = block[0].text
  const address = block.slice(1, labelIdx).map(l => l.text).join(' ').trim()
  const get = (re: RegExp) => { const l = block.find(b => re.test(b.text)); return l ? l.text.replace(re, '').trim() : '' }
  const bairro = get(/^bairro:\s*/i)
  const cep    = get(/^cep:\s*/i)
  if (!name || !address) return null
  return {
    name,
    full_address: [address, bairro, cep ? `CEP ${cep}` : ''].filter(Boolean).join(', '),
    ...(bairro ? { district: bairro } : {}),
    ...(cep ? { zip_code: cep } : {}),
  }
}
