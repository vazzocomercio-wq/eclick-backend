-- Sessão 2026-05-27 — Registra o épico Blog GEO + Motor de Conteúdo IA no
-- roadmap (/dashboard/roadmap). O épico vive em OUTROS repos (eclick-frontend
-- = blog público + Sanity; eclick-active = motor de IA), mas o founder
-- acompanha tudo por aqui. Só popula roadmap_phases + roadmap_items pra Vazzo.
--
-- Detalhes completos da arquitetura/commits em memory/project_blog_geo.md
--
-- Phase F15: Blog GEO + Motor de Conteúdo IA — 11 entregues + 5 pendentes.

DO $$
DECLARE
  vazzo_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  INSERT INTO public.roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
  VALUES (
    vazzo_org,
    'F15',
    'Blog GEO + Motor de Conteúdo IA',
    'Blog público eclick.app.br/blog (Next.js + Sanity CMS) + motor de conteúdo com IA no e-Click Active: a IA escreve artigos GEO-otimizados (cita fontes/estatísticas/FAQ pra ser citada por ChatGPT/Gemini/Perplexity), gera capa + imagens inline, sugere pautas, gera em lote, agenda e publica no Sanity — fila humano-no-loop (IA cria → você aprova → publica). Estúdio do Blog (voz da marca, prompts editáveis, base de conhecimento, seletor de 36 fontes). Núcleo entregue e em produção; faltam extras de distribuição.',
    'wip',
    90,
    15
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_phase_id;

  IF v_phase_id IS NULL THEN
    SELECT id INTO v_phase_id
    FROM public.roadmap_phases
    WHERE organization_id = vazzo_org AND num = 'F15';
  END IF;

  DELETE FROM public.roadmap_items WHERE phase_id = v_phase_id;

  -- ── ENTREGUES (em produção) ──────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'Blog público eclick.app.br/blog (Sanity CMS + Next.js)',
    'done', 0,
    'Sprint 1 (eclick-frontend, PR #20). Home/[slug]/categoria/autor/tag + Portable Text com blocks (callout/paperQuote/stat/comparison/ctaInline) + SEO/GEO (sitemap, rss.xml, robots, llms.txt, JSON-LD BlogPosting/FAQPage/BreadcrumbList). CMS = Sanity (project 9haxd4s5, dataset production, ACL público). 7 pilares editoriais + autor seedados. Fonte de título configurável (ver item de fontes).'),
  (vazzo_org, v_phase_id,
    'Motor de IA: gera artigo GEO + capa (fila de revisão)',
    'done', 0,
    'Sprint 2 Fase 1 (eclick-active, módulo blog-ai, migration 079). LlmService(json_mode) com prompt GEO → JSON estruturado → Portable Text → capa via ImageGenerationService (DALL·E) → status review. Publica no Sanity via cliente de escrita (fetch, sem dep @sanity/client). Tela /blog-ia (grupo Marketing da sidebar).'),
  (vazzo_org, v_phase_id,
    'Ideação de pautas por IA',
    'done', 0,
    'Sprint 2 Fase 2. POST /blog-ai/ideate: a IA propõe N pautas (title/pillar/angle/why/aiPrompts) ancoradas nos 7 pilares + GEO + lacunas (não repete títulos do pipeline). Botão "Sugerir pautas" + "Gerar" 1-clique.'),
  (vazzo_org, v_phase_id,
    'Agendamento + worker de publicação automática',
    'done', 0,
    'Sprint 2 Fase 3. Agenda data/hora; worker (tick 60s) publica sozinho no horário no Sanity. UI: datetime picker + Agendar/Publicar agora/Desagendar. Desligável via env.'),
  (vazzo_org, v_phase_id,
    'Lote / autopilot de conteúdo',
    'done', 0,
    'Sprint 2 Fase 4. POST /blog-ai/generate-batch: IA sugere N pautas → cria N rascunhos → gera em background → fila de revisão. UI "Gerar em lote" + polling.'),
  (vazzo_org, v_phase_id,
    'Revalidação on-demand (post aparece na hora)',
    'done', 0,
    'eclick-frontend /api/revalidate (POST {secret,slug} → revalidatePath). O Active chama best-effort ao publicar/agendar → post entra na home/sitemap na hora, sem esperar o ISR.'),
  (vazzo_org, v_phase_id,
    'Voz da marca (tom injetado nos prompts)',
    'done', 0,
    'Migration 080 blog_settings.voice_guidelines. Painel "Voz da marca" no /blog-ia: define tom/diretrizes → a IA segue ao gerar artigos e sugerir pautas. Conteúdo sai consistente com a marca.'),
  (vazzo_org, v_phase_id,
    'Imagens inline no corpo do artigo',
    'done', 0,
    'A IA pode inserir até 2 ilustrações conceituais no corpo (além da capa), geradas via ImageGenerationService. No publish, sobem como asset durável no Sanity. Front renderiza por url.'),
  (vazzo_org, v_phase_id,
    'Estúdio do Blog: prompts editáveis + base de conhecimento',
    'done', 0,
    'Migration 081. /blog-ia/estudio: edita os system prompts (artigo/pautas) com "Restaurar padrão" + "✨ Gerar com IA"; base de conhecimento (URLs raspadas + notas) injetada na geração como referência factual. Esparso (código = fallback).'),
  (vazzo_org, v_phase_id,
    'Calendário editorial visual',
    'done', 0,
    'Toggle Lista/Calendário no /blog-ia: grid de mês com posts agendados (âmbar) e publicados (verde) por dia.'),
  (vazzo_org, v_phase_id,
    'Seletor de fontes do blog (36 fontes) + override por artigo',
    'done', 0,
    'Migration 082. Estúdio: dropdown agrupado (Moderno/Serifa/Marcante/Casual) de 36 fontes de título (Google Fonts, estilo loja) com preview ao vivo; fonte padrão do blog espelhada no Sanity siteSettings. Cada artigo pode ter fonte própria (dropdown na lista). Logo do header aumentada.'),

  -- ── PENDENTES (extras) ───────────────────────────────────────────────
  (vazzo_org, v_phase_id,
    'Studio hospedado do Sanity (pendência externa)',
    'planned', 2,
    'Deploy do Sanity Studio precisa de `sanity login` interativo (robot token não tem grant deployStudio). Pendência do Silvio: cd studio && npx sanity login && npm run deploy. Não bloqueia o motor de IA (que publica via API).'),
  (vazzo_org, v_phase_id,
    'Rotacionar tokens Sanity (segurança)',
    'planned', 1,
    '2 tokens Sanity (Editor + admin) foram colados no chat durante a entrega. Recomendado rotacionar em Sanity → API → Tokens e atualizar SANITY_WRITE_TOKEN no Railway do active-api.'),
  (vazzo_org, v_phase_id,
    'Distribuição automática (LinkedIn / Twitter)',
    'planned', 4,
    'Schema do Sanity já tem campo socialDistribution (linkedin-personal/company, twitter), mas o backend de postar automático ao publicar NÃO foi construído. Cross-post do artigo nas redes ao publicar.'),
  (vazzo_org, v_phase_id,
    'Newsletter signup do blog (backend)',
    'planned', 4,
    'O signup do blog posta em /public/blog/newsletter/signup — endpoint/persistência NÃO construídos. Captura de email + integração com disparo.'),
  (vazzo_org, v_phase_id,
    'Editor manual rico do corpo do artigo (opcional)',
    'planned', 5,
    'Hoje o fluxo é IA cria → humano aprova → publica (sem edição manual do texto na tela do Active; ajustes finos via Sanity Studio). Se quiser, construir um editor inline (Portable Text) na tela do post pra editar à mão antes de publicar.');

END $$;
