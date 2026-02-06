-- Mentions per actor (last 7 days)
-- track events fire when a GitHub Action confirms an @mention and starts a workflow
SELECT
  blob4 AS actor,
  COUNT() AS event_count
FROM bonk_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'track'
  AND blob4 != ''
GROUP BY actor
ORDER BY event_count DESC
LIMIT 100
