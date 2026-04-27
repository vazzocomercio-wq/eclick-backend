/** Common shape every CPF-enrichment provider must return. The original
 * API response is preserved under `raw_response` so consumers can drill
 * into provider-specific fields when they need to. */
export interface EnrichmentResult {
  success:       boolean
  provider:      string
  name?:         string | null
  phone?:        string | null
  email?:        string | null
  address?:      string | null
  birth_date?:   string | null   // ISO YYYY-MM-DD when available
  gender?:       string | null
  raw_response?: Record<string, unknown>
  error?:        string
}

export interface EnrichmentProvider {
  /** Provider id matching ads_ai_settings.cpf_provider value */
  readonly id: string
  /** Look up the CPF and map the response into the common shape.
   * Must NEVER throw — return { success:false, error } on failure. */
  enrich(cpf: string, apiKey: string): Promise<EnrichmentResult>
}
