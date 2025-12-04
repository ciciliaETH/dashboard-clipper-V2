-- Patch campaigns functions and constraints
-- Date: 2025-10-24

BEGIN;

-- Ensure uniqueness of participants within the same campaign
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_campaign_participants_campaign_username'
  ) THEN
    CREATE UNIQUE INDEX uq_campaign_participants_campaign_username
      ON public.campaign_participants(campaign_id, tiktok_username);
  END IF;
END $$;

-- Drop old functions if they exist
DROP FUNCTION IF EXISTS public.campaign_series(UUID, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.campaign_participant_totals(UUID, DATE, DATE);

-- Recreate with new names to avoid schema cache issues
CREATE OR REPLACE FUNCTION public.campaign_series_v2(
  campaign UUID,
  start_date DATE,
  end_date DATE,
  p_interval TEXT DEFAULT 'daily'
)
RETURNS TABLE(
  bucket_date DATE,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT
)
LANGUAGE sql
STABLE
AS $$
WITH usernames AS (
  SELECT LOWER(tiktok_username) AS username
  FROM public.campaign_participants
  WHERE campaign_id = campaign
), posts AS (
  SELECT p.post_date::date AS d,
         p.play_count::bigint AS views,
         p.digg_count::bigint AS likes,
         p.comment_count::bigint AS comments,
         p.share_count::bigint AS shares,
         p.save_count::bigint AS saves
  FROM public.tiktok_posts_daily p
  JOIN usernames u ON u.username = p.username
  WHERE p.post_date BETWEEN start_date AND end_date
)
SELECT
  CASE
    WHEN p_interval = 'weekly' THEN date_trunc('week', d)::date
    WHEN p_interval = 'monthly' THEN date_trunc('month', d)::date
    ELSE d
  END AS bucket_date,
  SUM(views) AS views,
  SUM(likes) AS likes,
  SUM(comments) AS comments,
  SUM(shares) AS shares,
  SUM(saves) AS saves
FROM posts
GROUP BY 1
ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.campaign_participant_totals_v2(
  campaign UUID,
  start_date DATE,
  end_date DATE
)
RETURNS TABLE(
  username TEXT,
  views BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  saves BIGINT
)
LANGUAGE sql
STABLE
AS $$
SELECT p.username,
       SUM(p.play_count)::bigint AS views,
       SUM(p.digg_count)::bigint AS likes,
       SUM(p.comment_count)::bigint AS comments,
       SUM(p.share_count)::bigint AS shares,
       SUM(p.save_count)::bigint AS saves
FROM public.tiktok_posts_daily p
JOIN public.campaign_participants cp ON LOWER(cp.tiktok_username) = p.username
WHERE cp.campaign_id = campaign
  AND p.post_date BETWEEN start_date AND end_date
GROUP BY p.username
ORDER BY views DESC;
$$;

GRANT EXECUTE ON FUNCTION public.campaign_series_v2(UUID, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_participant_totals_v2(UUID, DATE, DATE) TO authenticated;

COMMIT;
