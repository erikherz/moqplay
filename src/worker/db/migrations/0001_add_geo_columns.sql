-- Add geolocation columns to broadcast_events
ALTER TABLE broadcast_events ADD COLUMN geo_country TEXT;
ALTER TABLE broadcast_events ADD COLUMN geo_city TEXT;
ALTER TABLE broadcast_events ADD COLUMN geo_region TEXT;
ALTER TABLE broadcast_events ADD COLUMN geo_latitude TEXT;
ALTER TABLE broadcast_events ADD COLUMN geo_longitude TEXT;
ALTER TABLE broadcast_events ADD COLUMN geo_timezone TEXT;

-- Add geolocation columns to watch_events
ALTER TABLE watch_events ADD COLUMN geo_country TEXT;
ALTER TABLE watch_events ADD COLUMN geo_city TEXT;
ALTER TABLE watch_events ADD COLUMN geo_region TEXT;
ALTER TABLE watch_events ADD COLUMN geo_latitude TEXT;
ALTER TABLE watch_events ADD COLUMN geo_longitude TEXT;
ALTER TABLE watch_events ADD COLUMN geo_timezone TEXT;
