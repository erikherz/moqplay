#!/bin/bash
# Show live broadcast stats with viewer counts

# Fetch broadcast data
BROADCAST_JSON=$(npx wrangler d1 execute earthseed-db --remote --command "
SELECT
  b.stream_id,
  u.name as broadcaster,
  b.geo_city || ', ' || b.geo_country as location,
  b.origin,
  strftime('%H:%M:%S', b.started_at) as started,
  strftime('%H:%M:%S', b.last_heartbeat) as heartbeat,
  (SELECT COUNT(DISTINCT COALESCE(w.user_id, '') || '|' || COALESCE(w.geo_latitude, '') || '|' || COALESCE(w.geo_longitude, ''))
   FROM watch_events w WHERE w.stream_id = b.stream_id AND w.ended_at IS NULL) as viewers
FROM broadcast_events b
LEFT JOIN users u ON b.user_id = u.id
WHERE b.ended_at IS NULL
  AND b.last_heartbeat IS NOT NULL
  AND b.last_heartbeat > datetime('now', '-15 seconds')
ORDER BY b.started_at DESC
" --json 2>/dev/null)

BROADCAST_COUNT=$(echo "$BROADCAST_JSON" | jq '.[0].results | length')

echo "📡 Live Broadcasts ($BROADCAST_COUNT)"
echo "======================="
echo "$BROADCAST_JSON" | jq -r '
  .[0].results |
  if length == 0 then "No active broadcasts"
  else
    ["STREAM", "BROADCASTER", "LOCATION", "ORIGIN", "STARTED", "HEARTBEAT", "VIEWERS"],
    ["------", "-----------", "--------", "------", "-------", "---------", "-------"],
    (.[] | [.stream_id, .broadcaster, .location, .origin, .started, .heartbeat, .viewers]) |
    @tsv
  end
' | column -t -s $'\t'

# Fetch viewer data (deduplicated by user_id + geo location)
# For logged-in users: dedupe by user_id per stream
# For anonymous users: dedupe by geo coordinates per stream
VIEWER_JSON=$(npx wrangler d1 execute earthseed-db --remote --command "
SELECT stream_id, viewer, location, started FROM (
  SELECT
    w.stream_id,
    COALESCE(u.name, 'Anonymous') as viewer,
    w.geo_city || ', ' || w.geo_country as location,
    strftime('%H:%M:%S', MAX(w.started_at)) as started,
    ROW_NUMBER() OVER (
      PARTITION BY w.stream_id,
        CASE WHEN w.user_id IS NOT NULL THEN 'user:' || w.user_id
             ELSE 'geo:' || COALESCE(w.geo_latitude,'') || ',' || COALESCE(w.geo_longitude,'')
        END
      ORDER BY w.started_at DESC
    ) as rn
  FROM watch_events w
  LEFT JOIN users u ON w.user_id = u.id
  WHERE w.ended_at IS NULL
  GROUP BY w.stream_id, w.user_id, w.geo_latitude, w.geo_longitude
) WHERE rn = 1
ORDER BY stream_id, started DESC
" --json 2>/dev/null)

VIEWER_COUNT=$(echo "$VIEWER_JSON" | jq '.[0].results | length')

echo ""
echo "👀 Current Stream Viewers ($VIEWER_COUNT)"
echo "============================"
echo "$VIEWER_JSON" | jq -r '
  .[0].results |
  if length == 0 then "No active viewers"
  else
    ["STREAM", "VIEWER", "LOCATION", "STARTED"],
    ["------", "------", "--------", "-------"],
    (.[] | [.stream_id, .viewer, .location, .started]) |
    @tsv
  end
' | column -t -s $'\t'

# Fetch unique viewers by location (deduplicated across all streams)
LOCATION_JSON=$(npx wrangler d1 execute earthseed-db --remote --command "
SELECT viewer, location, streams, started FROM (
  SELECT
    COALESCE(u.name, 'Anonymous') as viewer,
    w.geo_city || ', ' || w.geo_country as location,
    GROUP_CONCAT(DISTINCT w.stream_id) as streams,
    strftime('%H:%M:%S', MAX(w.started_at)) as started,
    ROW_NUMBER() OVER (
      PARTITION BY
        CASE WHEN w.user_id IS NOT NULL THEN 'user:' || w.user_id
             ELSE 'geo:' || COALESCE(w.geo_latitude,'') || ',' || COALESCE(w.geo_longitude,'')
        END
      ORDER BY w.started_at DESC
    ) as rn
  FROM watch_events w
  LEFT JOIN users u ON w.user_id = u.id
  WHERE w.ended_at IS NULL
  GROUP BY w.user_id, w.geo_latitude, w.geo_longitude
) WHERE rn = 1
ORDER BY started DESC
" --json 2>/dev/null)

LOCATION_COUNT=$(echo "$LOCATION_JSON" | jq '.[0].results | length')

echo ""
echo "👀 Current Location Viewers ($LOCATION_COUNT)"
echo "==============================="
echo "$LOCATION_JSON" | jq -r '
  .[0].results |
  if length == 0 then "No active viewers"
  else
    ["VIEWER", "LOCATION", "STREAMS", "STARTED"],
    ["------", "--------", "-------", "-------"],
    (.[] | [.viewer, .location, .streams, .started]) |
    @tsv
  end
' | column -t -s $'\t'
