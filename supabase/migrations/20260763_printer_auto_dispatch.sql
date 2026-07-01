-- ============================================================
-- Product OS — T1-C auto-dispatch (lights-out)
--
-- Quando a impressora fica ociosa, o farm pode INICIAR sozinho a próxima ordem
-- da fila que ela consegue rodar (filamento certo + .3mf). OPT-IN por impressora
-- (auto_dispatch) — ação real na máquina, então nasce desligado. Depende do
-- start remoto da Bambu (Developer Mode). 100% aditivo.
-- ============================================================
ALTER TABLE production_printer
  ADD COLUMN IF NOT EXISTS auto_dispatch BOOLEAN NOT NULL DEFAULT FALSE;
