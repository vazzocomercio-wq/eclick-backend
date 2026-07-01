-- Product OS — persiste o detalhamento do custo calculado no projeto.
-- Antes só o total ia pra estimated_cost; a quebra (filamento/energia/mão de obra/
-- embalagem/perda) + preços sugeridos por canal ficavam só na tela e sumiam ao
-- reabrir. Agora guardamos o resultado completo p/ exibir de novo.

alter table public.product_dev
  add column if not exists cost_breakdown jsonb;

comment on column public.product_dev.cost_breakdown is 'Último cálculo de custo (cost/inputs/target_margin_pct/suggested_prices) — exibido na aba Custo';
