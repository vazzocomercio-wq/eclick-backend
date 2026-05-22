-- Loja Própria — Analytics da Vitrine (AI1).
--
-- Eventos de comportamento da vitrine (visitas, views de produto, carrinho,
-- checkout). O funil de conversão e os insights do dashboard são montados
-- a partir daqui + storefront_orders (pedidos/pago) + whatsapp_carts (abandono).
--
-- Ingest: a vitrine dispara beacons públicos (POST /storefront/events/track).
-- session_id é anônimo (localStorage do visitante) — sem PII além do ip_hash.

CREATE TABLE IF NOT EXISTS public.storefront_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_slug       text NOT NULL,

  -- Sessão anônima do visitante (cookie/localStorage) — agrupa eventos da visita
  session_id       text NOT NULL,

  -- page_view | product_view | add_to_cart | begin_checkout | purchase
  event_type       text NOT NULL,

  product_id       uuid,            -- public.products.id (ref lógica) quando aplicável
  value            numeric,         -- valor do carrinho / total do pedido quando aplicável

  -- Origem do tráfego: utm_source, host do referrer, 'affiliate', 'direct'
  source           text,
  -- Extras livres (utm_medium/campaign, path, etc.)
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,

  client_ip_hash   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sf_events_org_time
  ON public.storefront_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_events_org_type_time
  ON public.storefront_events (organization_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_events_org_product
  ON public.storefront_events (organization_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_events_session
  ON public.storefront_events (organization_id, session_id);

COMMENT ON TABLE public.storefront_events IS
  'Eventos de comportamento da vitrine (page_view/product_view/add_to_cart/begin_checkout/purchase) pro funil de conversão e analytics da Loja Própria.';

-- Grants (criação via _admin_exec_sql não herda)
GRANT ALL ON TABLE public.storefront_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.storefront_events TO authenticated;
