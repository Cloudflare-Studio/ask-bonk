-- Webhook events per actor (last 30 days)
SELECT
  blob4 AS actor,
  COUNT() AS event_count
FROM bonk_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 = 'webhook'
  AND blob4 != ''
GROUP BY actor
ORDER BY event_count DESC
LIMIT 100
