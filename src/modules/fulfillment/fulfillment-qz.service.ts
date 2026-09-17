import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { createSign } from 'node:crypto'
import * as forge from 'node-forge'
import { CredentialsService } from '../credentials/credentials.service'

const PROVIDER = 'qz_tray'
const KEY_NAME = 'QZ_KEYPAIR'

interface KeyPair { privateKey: string; certificate: string }

/**
 * Assinatura das requisições do QZ Tray (impressão direta na etiquetadora).
 *
 * Sem assinatura o QZ Tray trata o site como "não confiável" e pede "Allow" a
 * CADA ação (listar impressoras, cada impressão) — inviável na operação. Com
 * um certificado próprio instalado uma vez no QZ Tray do computador, ele passa
 * a confiar e não pergunta mais.
 *
 * Multi-tenant: cada org tem o SEU par chave/certificado, gerado sob demanda na
 * primeira vez e guardado criptografado em api_credentials (um único registro
 * JSON, pra chave e certificado nunca ficarem de pares diferentes).
 */
@Injectable()
export class FulfillmentQzService {
  private readonly logger = new Logger(FulfillmentQzService.name)

  constructor(private readonly credentials: CredentialsService) {}

  /** Certificado público (PEM) da org — cria o par se ainda não existir. */
  async certificado(orgId: string, userId: string): Promise<string> {
    return (await this.parDeChaves(orgId, userId)).certificate
  }

  /** Assina o texto que o QZ Tray manda (RSA-SHA512, base64). */
  async assinar(orgId: string, userId: string, toSign: string): Promise<string> {
    if (typeof toSign !== 'string' || !toSign) throw new BadRequestException('Nada para assinar.')
    const { privateKey } = await this.parDeChaves(orgId, userId)
    const signer = createSign('RSA-SHA512')
    signer.update(toSign)
    return signer.sign(privateKey, 'base64')
  }

  private async parDeChaves(orgId: string, userId: string): Promise<KeyPair> {
    const salvo = await this.credentials.getDecryptedKey(orgId, PROVIDER, KEY_NAME)
    if (salvo) {
      try {
        const kp = JSON.parse(salvo) as KeyPair
        if (kp.privateKey && kp.certificate) return kp
      } catch { /* registro corrompido → gera de novo */ }
    }
    const kp = gerarParAutoassinado(orgId)
    await this.credentials.saveCredential(orgId, userId, PROVIDER, KEY_NAME, JSON.stringify(kp))
    this.logger.log(`[qz] certificado de impressão criado para org=${orgId.slice(0, 8)}`)
    // relê: se duas abas criaram ao mesmo tempo, vale o que ficou gravado
    const final = await this.credentials.getDecryptedKey(orgId, PROVIDER, KEY_NAME)
    return final ? (JSON.parse(final) as KeyPair) : kp
  }
}

function gerarParAutoassinado(orgId: string): KeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8))
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)
  const attrs = [
    { name: 'commonName', value: `e-Click Etiquetas ${orgId.slice(0, 8)}` },
    { name: 'organizationName', value: 'e-Click' },
    { name: 'countryName', value: 'BR' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return {
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    certificate: forge.pki.certificateToPem(cert),
  }
}
