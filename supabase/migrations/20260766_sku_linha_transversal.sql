-- ============================================================
-- Product OS — Linha vira COLEÇÃO TRANSVERSAL
--
-- Antes: Linha era um nível preso à Sub-categoria (parent = sub). Agora a Linha é
-- uma coleção de LANÇAMENTO independente (ex: "Ella") que reúne produtos de
-- QUALQUER categoria — vira nível de TOPO (parent = null), como Marca.
-- Característica continua DENTRO da Linha (única por linha — inalterado).
-- SKU segue MARCA+CATEGORIA+SUB+LINHA+CARACTERISTICA-COR; só a Linha muda de nível.
--
-- Esta migração é SEGURA: recodifica só as linhas que colidiriam ao virar topo
-- (preserva o código das demais → SKUs existentes não mudam) e regenera sku_base
-- + SKUs de variante de forma idempotente.
-- ============================================================

DO $$
DECLARE r RECORD; maxc INT; base TEXT; cand TEXT; n INT;
BEGIN
  -- (1) colisão de CÓDIGO entre linhas da mesma org (mantém a mais antiga, recodifica as outras)
  FOR r IN
    SELECT id, organization_id FROM (
      SELECT id, organization_id,
             row_number() OVER (PARTITION BY organization_id, code ORDER BY created_at, id) AS rn
      FROM sku_taxonomy WHERE kind = 'linha'
    ) q WHERE q.rn > 1
  LOOP
    SELECT COALESCE(MAX((code)::int), 0) INTO maxc
      FROM sku_taxonomy WHERE kind = 'linha' AND organization_id = r.organization_id;
    UPDATE sku_taxonomy SET code = lpad((maxc + 1)::text, 2, '0') WHERE id = r.id;
  END LOOP;

  -- (2) colisão de NOME entre linhas da mesma org (mantém a mais antiga, sufixa as outras)
  FOR r IN
    SELECT id, organization_id, label FROM (
      SELECT id, organization_id, label,
             row_number() OVER (PARTITION BY organization_id, lower(label) ORDER BY created_at, id) AS rn
      FROM sku_taxonomy WHERE kind = 'linha'
    ) q WHERE q.rn > 1
  LOOP
    n := 2; base := r.label;
    LOOP
      cand := base || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM sku_taxonomy WHERE kind = 'linha' AND organization_id = r.organization_id AND lower(label) = lower(cand)
      );
      n := n + 1;
    END LOOP;
    UPDATE sku_taxonomy SET label = cand WHERE id = r.id;
  END LOOP;

  -- (3) promove a Linha a nível de TOPO (independente de sub)
  UPDATE sku_taxonomy SET parent_id = NULL, updated_at = now() WHERE kind = 'linha' AND parent_id IS NOT NULL;
END $$;

-- (4) regenera sku_base dos projetos com classificação completa (idempotente)
UPDATE product_dev pd
SET sku_base = m.code || c.code || s.code || l.code || ch.code, updated_at = now()
FROM sku_taxonomy m, sku_taxonomy c, sku_taxonomy s, sku_taxonomy l, sku_taxonomy ch
WHERE pd.sku_marca_id = m.id AND pd.sku_categoria_id = c.id AND pd.sku_sub_id = s.id
  AND pd.sku_linha_id = l.id AND pd.sku_caracteristica_id = ch.id
  AND pd.sku_base IS NOT NULL;

-- (5) regenera os SKUs de variante (base-cor)
UPDATE product_dev_sku_variant v
SET sku = pd.sku_base || '-' || cor.code, updated_at = now()
FROM product_dev pd, sku_taxonomy cor
WHERE v.product_dev_id = pd.id AND v.cor_id = cor.id AND pd.sku_base IS NOT NULL;
