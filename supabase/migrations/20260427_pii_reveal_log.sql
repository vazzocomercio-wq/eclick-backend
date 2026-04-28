-- LGPD audit trail — toda revelação manual de PII (CPF/phone/email)
-- via <MaskedField> no frontend é registrada aqui.
-- O frontend posta fire-and-forget pra /user-preferences/audit-reveal.

CREATE TABLE IF NOT EXISTS pii_reveal_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  customer_id  UUID,
  field        TEXT NOT NULL CHECK (field IN ('cpf','cnpj','phone','email')),
  ip           TEXT,
  user_agent   TEXT,
  revealed_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pii_reveal_user_date
  ON pii_reveal_log(user_id, revealed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pii_reveal_customer
  ON pii_reveal_log(customer_id, revealed_at DESC) WHERE customer_id IS NOT NULL;

ALTER TABLE pii_reveal_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON pii_reveal_log TO service_role;
DROP POLICY IF EXISTS srv_pii_reveal ON pii_reveal_log;
CREATE POLICY srv_pii_reveal ON pii_reveal_log FOR ALL TO service_role USING (true) WITH CHECK (true);
