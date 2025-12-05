-- CRITICAL FIX: Correct Post Date vs Accrual Mode Logic
-- Date: 2025-12-06
-- 
-- POST DATE MODE: Shows metrics from videos POSTED within date range
--   - Video posted Aug 1 with 5M views → counts ALL 5M if posted in range
--   - Video posted before range → does NOT count
--
-- ACCRUAL MODE: Shows GROWTH/DELTA within date range (regardless of post date)
--   - Video posted Aug 1: had 2M on start date, now 5M → counts +3M growth
--   - Old video goes viral in last 7 days: +2M → counts the +2M
--   - Shows: Last snapshot - First snapshot in the timeframe

-- ============================================================================
-- 1. FIX: campaign_participant_totals_v2 (TikTok)
-- ============================================================================
CREATE OR REPLACE FUNCTION campaign_participant_totals_v2(
  p_campaign_id TEXT,
  p_start_date TEXT,
  p_end_date TEXT,
  p_mode TEXT DEFAULT 'post_date'
)
RETURNS TABLE (
  tiktok_username TEXT,
  total_views BIGINT,
  total_likes BIGINT,
  total_comments BIGINT,
  total_shares BIGINT,
  total_saves BIGINT,
  video_count BIGINT
) AS $$
BEGIN
  IF p_mode = 'accrual' THEN
    -- ACCRUAL MODE: Calculate GROWTH (delta between first and last snapshot in range)
    RETURN QUERY
    WITH snapshot_deltas AS (
      SELECT 
        s.tiktok_username,
        s.aweme_id,
        -- Get first and last snapshot values in the date range
        FIRST_VALUE(s.play_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC) as first_views,
        LAST_VALUE(s.play_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_views,
        FIRST_VALUE(s.digg_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC) as first_likes,
        LAST_VALUE(s.digg_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_likes,
        FIRST_VALUE(s.comment_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC) as first_comments,
        LAST_VALUE(s.comment_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_comments,
        FIRST_VALUE(s.share_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC) as first_shares,
        LAST_VALUE(s.share_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_shares,
        FIRST_VALUE(s.save_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC) as first_saves,
        LAST_VALUE(s.save_count) OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_saves,
        ROW_NUMBER() OVER (PARTITION BY s.tiktok_username, s.aweme_id ORDER BY s.snapshot_date DESC) as rn
      FROM campaign_participants_snapshot s
      WHERE s.campaign_id = p_campaign_id
        AND s.snapshot_date >= p_start_date::date
        AND s.snapshot_date <= p_end_date::date
    )
    SELECT 
      sd.tiktok_username,
      SUM(GREATEST(0, sd.last_views - sd.first_views))::bigint as total_views,
      SUM(GREATEST(0, sd.last_likes - sd.first_likes))::bigint as total_likes,
      SUM(GREATEST(0, sd.last_comments - sd.first_comments))::bigint as total_comments,
      SUM(GREATEST(0, sd.last_shares - sd.first_shares))::bigint as total_shares,
      SUM(GREATEST(0, sd.last_saves - sd.first_saves))::bigint as total_saves,
      COUNT(DISTINCT sd.aweme_id)::bigint as video_count
    FROM snapshot_deltas sd
    WHERE sd.rn = 1 -- Only process each video once
    GROUP BY sd.tiktok_username;
    
  ELSE
    -- POST DATE MODE: Sum metrics from videos POSTED within date range
    RETURN QUERY
    SELECT 
      s.tiktok_username,
      SUM(s.play_count)::bigint as total_views,
      SUM(s.digg_count)::bigint as total_likes,
      SUM(s.comment_count)::bigint as total_comments,
      SUM(s.share_count)::bigint as total_shares,
      SUM(s.save_count)::bigint as total_saves,
      COUNT(DISTINCT s.aweme_id)::bigint as video_count
    FROM campaign_participants_snapshot s
    WHERE s.campaign_id = p_campaign_id
      AND s.create_time::date >= p_start_date::date
      AND s.create_time::date <= p_end_date::date
      -- Use only the LATEST snapshot for each video to get current totals
      AND s.snapshot_date = (
        SELECT MAX(s2.snapshot_date)
        FROM campaign_participants_snapshot s2
        WHERE s2.campaign_id = s.campaign_id
          AND s2.tiktok_username = s.tiktok_username
          AND s2.aweme_id = s.aweme_id
      )
    GROUP BY s.tiktok_username;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 2. FIX: campaign_instagram_participant_totals_v2 (Instagram)
-- ============================================================================
CREATE OR REPLACE FUNCTION campaign_instagram_participant_totals_v2(
  p_campaign_id TEXT,
  p_start_date TEXT,
  p_end_date TEXT,
  p_mode TEXT DEFAULT 'post_date'
)
RETURNS TABLE (
  instagram_username TEXT,
  total_views BIGINT,
  total_likes BIGINT,
  total_comments BIGINT,
  post_count BIGINT
) AS $$
BEGIN
  IF p_mode = 'accrual' THEN
    -- ACCRUAL MODE: Calculate GROWTH (delta between first and last snapshot in range)
    RETURN QUERY
    WITH snapshot_deltas AS (
      SELECT 
        s.instagram_username,
        s.shortcode,
        -- Get first and last snapshot values in the date range
        FIRST_VALUE(s.play_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC) as first_views,
        LAST_VALUE(s.play_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_views,
        FIRST_VALUE(s.like_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC) as first_likes,
        LAST_VALUE(s.like_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_likes,
        FIRST_VALUE(s.comment_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC) as first_comments,
        LAST_VALUE(s.comment_count) OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_comments,
        ROW_NUMBER() OVER (PARTITION BY s.instagram_username, s.shortcode ORDER BY s.snapshot_date DESC) as rn
      FROM campaign_instagram_participants_snapshot s
      WHERE s.campaign_id = p_campaign_id
        AND s.snapshot_date >= p_start_date::date
        AND s.snapshot_date <= p_end_date::date
    )
    SELECT 
      sd.instagram_username,
      SUM(GREATEST(0, sd.last_views - sd.first_views))::bigint as total_views,
      SUM(GREATEST(0, sd.last_likes - sd.first_likes))::bigint as total_likes,
      SUM(GREATEST(0, sd.last_comments - sd.first_comments))::bigint as total_comments,
      COUNT(DISTINCT sd.shortcode)::bigint as post_count
    FROM snapshot_deltas sd
    WHERE sd.rn = 1 -- Only process each post once
    GROUP BY sd.instagram_username;
    
  ELSE
    -- POST DATE MODE: Sum metrics from posts POSTED within date range
    RETURN QUERY
    SELECT 
      s.instagram_username,
      SUM(s.play_count)::bigint as total_views,
      SUM(s.like_count)::bigint as total_likes,
      SUM(s.comment_count)::bigint as total_comments,
      COUNT(DISTINCT s.shortcode)::bigint as post_count
    FROM campaign_instagram_participants_snapshot s
    WHERE s.campaign_id = p_campaign_id
      AND s.taken_at::date >= p_start_date::date
      AND s.taken_at::date <= p_end_date::date
      -- Use only the LATEST snapshot for each post to get current totals
      AND s.snapshot_date = (
        SELECT MAX(s2.snapshot_date)
        FROM campaign_instagram_participants_snapshot s2
        WHERE s2.campaign_id = s.campaign_id
          AND s2.instagram_username = s.instagram_username
          AND s2.shortcode = s.shortcode
      )
    GROUP BY s.instagram_username;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VERIFICATION QUERIES (Run these to test)
-- ============================================================================

-- Test 1: Compare Post Date vs Accrual for a campaign
-- SELECT * FROM campaign_participant_totals_v2('your-campaign-id', '2025-11-01', '2025-11-30', 'post_date');
-- SELECT * FROM campaign_participant_totals_v2('your-campaign-id', '2025-11-01', '2025-11-30', 'accrual');

-- Test 2: Verify single video delta calculation
-- SELECT 
--   tiktok_username,
--   aweme_id,
--   snapshot_date,
--   play_count,
--   LAG(play_count) OVER (PARTITION BY aweme_id ORDER BY snapshot_date) as prev_views,
--   play_count - LAG(play_count) OVER (PARTITION BY aweme_id ORDER BY snapshot_date) as view_delta
-- FROM campaign_participants_snapshot
-- WHERE campaign_id = 'your-campaign-id'
--   AND tiktok_username = 'test-user'
-- ORDER BY aweme_id, snapshot_date;
