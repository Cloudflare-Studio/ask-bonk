-- Failures by repo with classification (last 24 hours)
-- Includes workflow failures, infra errors, and cancellations
SELECT
  index1 AS repo,
  blob1 AS event_type,
  blob3 AS status,
  blob5 AS error_code,
  COUNT() AS error_count,
  MAX(timestamp) AS last_occurrence
FROM bonk_events
WHERE blob3 IN ('error', 'failure', 'cancelled')
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY repo, event_type, status, error_code
ORDER BY error_count DESC
LIMIT 50
