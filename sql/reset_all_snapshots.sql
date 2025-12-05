-- Hapus SEMUA data snapshot untuk reset total
-- Run di Supabase SQL Editor

-- 1. Hapus snapshot TikTok & Instagram
TRUNCATE TABLE tiktok_posts_daily;
TRUNCATE TABLE instagram_posts_daily;

-- 2. Hapus history metrics (INI YANG PENTING untuk chart Accrual mode!)
TRUNCATE TABLE social_metrics_history;

-- 3. (Optional) Reset campaign snapshots jika ada
-- TRUNCATE TABLE campaign_instagram_participants_snapshot;
-- TRUNCATE TABLE campaign_participants_snapshot;

-- Setelah ini, refresh data dari admin dashboard
