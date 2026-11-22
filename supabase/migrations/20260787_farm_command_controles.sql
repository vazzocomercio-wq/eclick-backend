-- ============================================================
-- Farm: controle remoto completo da impressora (tudo que o Bambu
-- Studio / Handy fazem via MQTT LAN). Só amplia o CHECK de
-- command_type — aditivo, nenhum dado muda.
-- ============================================================
ALTER TABLE farm_command DROP CONSTRAINT IF EXISTS farm_command_command_type_check;
ALTER TABLE farm_command ADD CONSTRAINT farm_command_command_type_check CHECK (command_type IN (
  'pause','resume','stop','print','light_on','light_off',
  'speed','nozzle_temp','bed_temp','fan','home','move','extrude',
  'ams_load','ams_unload','calibrate','clean_error','gcode'
));
