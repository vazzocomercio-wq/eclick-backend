/** Common shape every enrichment provider returns. Providers MUST NEVER
 * throw — failures are surfaced via { success:false, quality:'error', error }. */
export interface EnrichmentResult {
  success: boolean
  quality: 'full' | 'partial' | 'empty' | 'error'
  data: {
    // Pessoa Física
    full_name?:   string
    cpf?:         string
    birth_date?:  string
    gender?:      'M' | 'F' | 'O'
    mother_name?: string

    // Pessoa Jurídica
    cnpj?:         string
    company_name?: string
    trade_name?:   string
    legal_status?: string

    // Contato
    phones?: Array<{ number: string; is_whatsapp?: boolean; is_active?: boolean }>
    emails?: Array<{ address: string; is_valid?: boolean; is_corporate?: boolean }>

    // Endereço
    address?: {
      cep:           string
      street:        string
      number:        string
      complement?:   string
      neighborhood:  string
      city:          string
      state:         string
    }

    // Score
    credit_score?: number
    risk_level?:   'low' | 'medium' | 'high'
  }
  raw_response?: Record<string, unknown>
  error?:        string
  cost_cents:    number
  duration_ms:   number
}

/** Empty defaults for providers that return nothing useful. */
export const EMPTY_RESULT: EnrichmentResult = {
  success: false, quality: 'empty', data: {}, cost_cents: 0, duration_ms: 0,
}

/** Provider credentials, passed to enrich* methods so the orchestrator
 * can drive any provider with a single signature. */
export interface ProviderCreds {
  api_key:     string | null
  api_secret?: string | null
  base_url?:   string | null
}

/** Every provider implements all 6 methods. Methods unsupported by a
 * given provider should return { success:false, quality:'empty' } so
 * the orchestrator falls through to the next fallback in the cascade. */
export abstract class BaseEnrichmentProvider {
  abstract readonly code: string
  abstract enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult>
  abstract enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult>
  abstract enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult>
  abstract validateEmail(email: string, creds: ProviderCreds): Promise<EnrichmentResult>
  abstract validateWhatsApp(phone: string, creds: ProviderCreds): Promise<EnrichmentResult>
  abstract enrichCEP(cep: string, creds: ProviderCreds): Promise<EnrichmentResult>
}

/** Cheap timing helper: returns ms elapsed since `t0`. */
export const elapsed = (t0: number) => Date.now() - t0
