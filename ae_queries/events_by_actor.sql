-- Mentions per actor (last 30 days)
SELECT
  blob4 AS actor,
  COUNT() AS event_count
FROM bonk_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 = 'webhook'
  AND blob2 IN ('issue_comment', 'pull_request_review_comment', 'issues')
  AND blob4 != ''
GROUP BY actor
ORDER BY event_count DESC
LIMIT 100
