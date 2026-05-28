-- 20260658_tiktok_orders_remove_marker.sql
-- TT-5b mudou a ingestão dos pedidos TikTok: agora o espelho em `orders`
-- guarda UMA LINHA POR SKU VENDIDO (com platform_fee, shipping_cost, margem),
-- em vez de uma row marker agregada com sku='TTS-ORDER'. Esta migration limpa
-- as rows antigas — a próxima execução de importOrders/cron repopula com o
-- shape novo. Safe: zero matches a 'TTS-ORDER' em outros lugares do código.

DELETE FROM public.orders
WHERE source = 'tiktok_shop' AND sku = 'TTS-ORDER';
