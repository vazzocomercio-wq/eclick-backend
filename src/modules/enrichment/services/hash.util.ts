import { createHash } from 'crypto'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Mask a sensitive identifier for safe logging.
 * cpf 12345678900    → 123.456.789-** (last 2 digits hidden? no — keep 2)
 * Actually: keep first 3 + last 2, mask middle. */
export function maskIdentifier(type: string, value: string): string {
  if (!value) return ''
  const v = value.toString()
  switch (type) {
    case 'cpf': {
      const d = v.replace(/\D/g, '')
      if (d.length < 8) return '***'
      return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`
    }
    case 'cnpj': {
      const d = v.replace(/\D/g, '')
      if (d.length < 8) return '***'
      return `${d.slice(0, 2)}.***.***/****-${d.slice(-2)}`
    }
    case 'phone':
    case 'whatsapp': {
      const d = v.replace(/\D/g, '')
      if (d.length < 6) return '***'
      return `${d.slice(0, 4)}****${d.slice(-2)}`
    }
    case 'email': {
      const at = v.indexOf('@')
      if (at < 0) return '***'
      const local = v.slice(0, at)
      const domain = v.slice(at)
      return `${local.slice(0, 2)}***${domain}`
    }
    case 'cep': {
      const d = v.replace(/\D/g, '')
      return `${d.slice(0, 2)}***-${d.slice(-2)}`
    }
    default:
      return v.length > 4 ? `${v.slice(0, 2)}***${v.slice(-2)}` : '***'
  }
}

export function normalizeIdentifier(type: string, value: string): string {
  const v = (value ?? '').toString()
  switch (type) {
    case 'cpf':
    case 'cnpj':
    case 'phone':
    case 'whatsapp':
    case 'cep':
      return v.replace(/\D/g, '')
    case 'email':
      return v.trim().toLowerCase()
    default:
      return v.trim()
  }
}
