-- Pre-popula active_assigned_to com owner do org no Active.
UPDATE ml_campaigns_config
   SET active_assigned_to = '60ad329d-c294-4ad7-b13b-7aaf4f5f76b6'
 WHERE organization_id = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
   AND active_assigned_to IS NULL;
