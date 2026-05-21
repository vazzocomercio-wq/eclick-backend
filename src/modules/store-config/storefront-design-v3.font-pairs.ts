/**
 * Dicionario central de pares de fontes do Store Builder v3.
 *
 * Single source of truth: `FontPair` type, `FONT_PAIRS_V3` runtime array
 * e os helpers de render (googleFontsHref/fonts) derivam DESTE objeto.
 *
 * Pra adicionar uma fonte nova: adiciona entrada aqui. Type union e
 * runtime array atualizam sozinhos.
 *
 * Cada entrada:
 *  - label:   PT-BR amigavel pro select (com hint da fonte)
 *  - heading: CSS font-family pro h1/h2
 *  - body:    CSS font-family pro texto corrido
 *  - google:  familias no formato do parametro `family` do Google Fonts CSS2
 *  - group:   agrupamento pro select (Sofisticado, Moderno, etc.)
 */

export interface FontPairDef {
  label:   string
  heading: string
  body:    string
  google:  string[]
  group:   FontGroup
}

export type FontGroup =
  | 'Sofisticado'
  | 'Moderno'
  | 'Editorial'
  | 'Casual'
  | 'Marcante'
  | 'Vintage'
  | 'Minimalista'
  | 'Criativo'

export const FONT_PAIRS_V3_DEFINITIONS = {
  // ── Sofisticado / Luxo ────────────────────────────────────────────
  elegant:   { group: 'Sofisticado', label: 'Elegante — Playfair + Lora',          heading: "'Playfair Display', Georgia, serif",   body: "'Lora', Georgia, serif",          google: ['Playfair+Display:wght@600;700', 'Lora:wght@400;500'] },
  luxe:      { group: 'Sofisticado', label: 'Luxo — Cormorant Garamond + Source',  heading: "'Cormorant Garamond', Georgia, serif", body: "'Source Sans 3', system-ui, sans-serif", google: ['Cormorant+Garamond:wght@500;700', 'Source+Sans+3:wght@400;500'] },
  royal:     { group: 'Sofisticado', label: 'Real — Cinzel + Crimson',             heading: "'Cinzel', Georgia, serif",             body: "'Crimson Text', Georgia, serif",  google: ['Cinzel:wght@600;700', 'Crimson+Text:wght@400;600'] },
  couture:   { group: 'Sofisticado', label: 'Couture — Bodoni + Lato',             heading: "'Bodoni Moda', Georgia, serif",        body: "'Lato', system-ui, sans-serif",   google: ['Bodoni+Moda:wght@600;700', 'Lato:wght@400;700'] },
  heritage:  { group: 'Sofisticado', label: 'Heritage — Italiana + Roboto',        heading: "'Italiana', Georgia, serif",           body: "'Roboto', system-ui, sans-serif", google: ['Italiana', 'Roboto:wght@400;500'] },

  // ── Moderno / Tech ────────────────────────────────────────────────
  modern:    { group: 'Moderno',     label: 'Moderna — Space Grotesk + Inter',     heading: "'Space Grotesk', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif", google: ['Space+Grotesk:wght@500;700', 'Inter:wght@400;500'] },
  tech:      { group: 'Moderno',     label: 'Tech — Sora + IBM Plex Sans',         heading: "'Sora', system-ui, sans-serif",        body: "'IBM Plex Sans', system-ui, sans-serif", google: ['Sora:wght@600;700', 'IBM+Plex+Sans:wght@400;500'] },
  sharp:     { group: 'Moderno',     label: 'Sharp — Manrope',                     heading: "'Manrope', system-ui, sans-serif",     body: "'Manrope', system-ui, sans-serif",       google: ['Manrope:wght@400;500;700;800'] },
  neo:       { group: 'Moderno',     label: 'Neo — Outfit',                        heading: "'Outfit', system-ui, sans-serif",      body: "'Outfit', system-ui, sans-serif",        google: ['Outfit:wght@400;500;700'] },
  crisp:     { group: 'Moderno',     label: 'Crisp — DM Sans',                     heading: "'DM Sans', system-ui, sans-serif",     body: "'DM Sans', system-ui, sans-serif",       google: ['DM+Sans:wght@400;500;700'] },

  // ── Editorial / Revista ──────────────────────────────────────────
  editorial: { group: 'Editorial',   label: 'Editorial — DM Serif + Inter',        heading: "'DM Serif Display', Georgia, serif",   body: "'Inter', system-ui, sans-serif",  google: ['DM+Serif+Display', 'Inter:wght@400;500'] },
  magazine:  { group: 'Editorial',   label: 'Revista — Playfair + Source Serif',   heading: "'Playfair Display', Georgia, serif",   body: "'Source Serif 4', Georgia, serif", google: ['Playfair+Display:wght@600;700', 'Source+Serif+4:wght@400;500'] },
  journal:   { group: 'Editorial',   label: 'Jornal — Spectral',                   heading: "'Spectral', Georgia, serif",           body: "'Spectral', Georgia, serif",      google: ['Spectral:wght@400;500;700'] },
  literary:  { group: 'Editorial',   label: 'Literário — Lora',                    heading: "'Lora', Georgia, serif",               body: "'Lora', Georgia, serif",          google: ['Lora:wght@400;500;700'] },

  // ── Casual / Amigável ────────────────────────────────────────────
  playful:   { group: 'Casual',      label: 'Descontraída — Poppins + Nunito',     heading: "'Poppins', system-ui, sans-serif",     body: "'Nunito Sans', system-ui, sans-serif", google: ['Poppins:wght@600;700', 'Nunito+Sans:wght@400;600'] },
  friendly:  { group: 'Casual',      label: 'Amigável — Quicksand',                heading: "'Quicksand', system-ui, sans-serif",   body: "'Quicksand', system-ui, sans-serif",   google: ['Quicksand:wght@400;500;700'] },
  warm:      { group: 'Casual',      label: 'Aconchegante — Comfortaa + Karla',    heading: "'Comfortaa', system-ui, sans-serif",   body: "'Karla', system-ui, sans-serif",       google: ['Comfortaa:wght@500;700', 'Karla:wght@400;500'] },
  cozy:      { group: 'Casual',      label: 'Acolhedora — Nunito + Open Sans',     heading: "'Nunito', system-ui, sans-serif",      body: "'Open Sans', system-ui, sans-serif",   google: ['Nunito:wght@600;800', 'Open+Sans:wght@400;500'] },

  // ── Marcante / Bold ──────────────────────────────────────────────
  bold:      { group: 'Marcante',    label: 'Marcante — Archivo Black + Inter',    heading: "'Archivo Black', 'Arial Black', sans-serif", body: "'Inter', system-ui, sans-serif", google: ['Archivo+Black', 'Inter:wght@400;600'] },
  impact:    { group: 'Marcante',    label: 'Impacto — Bebas Neue + Roboto',       heading: "'Bebas Neue', 'Arial Black', sans-serif",    body: "'Roboto', system-ui, sans-serif",  google: ['Bebas+Neue', 'Roboto:wght@400;500'] },
  statement: { group: 'Marcante',    label: 'Statement — Anton + Inter',           heading: "'Anton', 'Arial Black', sans-serif",         body: "'Inter', system-ui, sans-serif",   google: ['Anton', 'Inter:wght@400;500'] },
  striking:  { group: 'Marcante',    label: 'Striking — Oswald + Roboto',          heading: "'Oswald', 'Arial Black', sans-serif",        body: "'Roboto', system-ui, sans-serif",  google: ['Oswald:wght@500;700', 'Roboto:wght@400;500'] },

  // ── Vintage / Retro ──────────────────────────────────────────────
  classic:   { group: 'Vintage',     label: 'Clássica — Libre Baskerville + Inter', heading: "'Libre Baskerville', Georgia, serif",       body: "'Inter', system-ui, sans-serif",   google: ['Libre+Baskerville:wght@700', 'Inter:wght@400;500'] },
  vintage:   { group: 'Vintage',     label: 'Vintage — Abril Fatface + Lora',      heading: "'Abril Fatface', Georgia, serif",            body: "'Lora', Georgia, serif",           google: ['Abril+Fatface', 'Lora:wght@400;500'] },
  retro:     { group: 'Vintage',     label: 'Retrô — Righteous + Source Sans',     heading: "'Righteous', 'Arial Black', sans-serif",     body: "'Source Sans 3', system-ui, sans-serif", google: ['Righteous', 'Source+Sans+3:wght@400;500'] },

  // ── Minimalista ──────────────────────────────────────────────────
  minimal:   { group: 'Minimalista', label: 'Minimalista — Work Sans',             heading: "'Work Sans', system-ui, sans-serif",   body: "'Work Sans', system-ui, sans-serif",   google: ['Work+Sans:wght@400;500;700'] },
  clean:     { group: 'Minimalista', label: 'Clean — Public Sans',                 heading: "'Public Sans', system-ui, sans-serif", body: "'Public Sans', system-ui, sans-serif", google: ['Public+Sans:wght@400;500;700'] },
  neutral:   { group: 'Minimalista', label: 'Neutra — Mulish',                     heading: "'Mulish', system-ui, sans-serif",      body: "'Mulish', system-ui, sans-serif",      google: ['Mulish:wght@400;500;700'] },

  // ── Criativo ─────────────────────────────────────────────────────
  artisan:   { group: 'Criativo',    label: 'Artesanal — Fraunces + Inter',        heading: "'Fraunces', Georgia, serif",           body: "'Inter', system-ui, sans-serif",       google: ['Fraunces:wght@500;700', 'Inter:wght@400;500'] },
  boutique:  { group: 'Criativo',    label: 'Boutique — Cormorant + Montserrat',   heading: "'Cormorant', Georgia, serif",          body: "'Montserrat', system-ui, sans-serif",  google: ['Cormorant:wght@500;700', 'Montserrat:wght@400;500'] },
} as const satisfies Record<string, FontPairDef>

export type FontPair = keyof typeof FONT_PAIRS_V3_DEFINITIONS

/** Array runtime de todos os FontPair — pro validator e UI iterar. */
export const FONT_PAIRS_V3: readonly FontPair[] = Object.keys(FONT_PAIRS_V3_DEFINITIONS) as FontPair[]

/** Acesso tipado a uma entrada. Fallback `modern` se key invalida. */
export function getFontPairDef(pair: FontPair | string): FontPairDef {
  return (FONT_PAIRS_V3_DEFINITIONS as Record<string, FontPairDef>)[pair] ?? FONT_PAIRS_V3_DEFINITIONS.modern
}
