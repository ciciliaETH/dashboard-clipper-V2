# AUDIT HASIL - Semua File yang Query Snapshot Tables

## ✅ SUDAH BENAR (Pakai Delta Calculation):
1. `/api/leaderboard` - Lines 113-192 ✅ Fixed (group by video_id, calculate delta)
2. `/api/groups/series` - Lines 273-340 ✅ Fixed (group by post id, calculate delta)  
3. SQL Function `campaign_series_v2` ✅ Fixed (akan di-update di database)

## ⚠️ AMAN (Bukan Aggregation):
- `/api/last-updated` - Hanya ambil latest created_at (AMAN)
- `/api/get-metrics` - Cuma count rows (AMAN)
- `/api/fetch-metrics/*` - UPSERT data, bukan read (AMAN)
- `/api/fetch-ig/*` - UPSERT data, bukan read (AMAN)
- `/api/cron/*` - UPSERT data untuk refresh (AMAN)
- `/api/admin/ig/sync-all` - Trigger update (AMAN)
- `/api/admin/diagnostics` - Diagnostics only (AMAN)
- `/api/groups/[id]/refresh` - UPSERT snapshots (AMAN)
- `/api/campaigns/[id]/refresh` - UPSERT snapshots (AMAN)
- `/api/campaigns/[id]/participants/[username]` - Single user query (AMAN)
- `/api/admin/ig/resolve-user-ids` - Update user_id only (AMAN)

## 🔴 KRITIS - PERLU FIX (Masih Sum Semua Snapshot):

### 1. `/api/groups/[id]/members` - Lines 241-280
**Bug**: Post Date mode sum semua row tanpa group by video_id/post_id
**Impact**: Member list di Groups page menampilkan data inflated
**Fix Needed**: Group by video_id untuk TikTok, group by id untuk Instagram

### 2. `/api/leaderboard/top-videos` - Lines 130+ dan 279+
**Perlu Dicek**: Apakah ini aggregate atau hanya filter videos?
**Kemungkinan**: AMAN jika hanya SELECT videos untuk display, BUKAN aggregation

### 3. `/api/campaigns/[id]/metrics` - Lines 153-210
**Perlu Dicek**: Posts count aggregation - apakah distinct video_id atau sum rows?
**Kemungkinan Bug**: postCount increment per row, bisa duplikat jika ada multiple snapshots

### 4. `/api/campaigns/[id]/accrual` - Lines 87-104
**Perlu Dicek**: Accrual calculation logic
**Kemungkinan**: AMAN jika sudah pakai social_metrics_history

### 5. `/api/employees/[id]/metrics` - Lines 247+ dan 322+
**Perlu Dicek**: Employee metrics aggregation
**Kemungkinan Bug**: Sum metrics tanpa group by video_id

### 6. `/api/backfill/accrual` - Lines 72-89
**Perlu Dicek**: Backfill logic
**Kemungkinan**: AMAN jika hanya read untuk comparison

## 📋 ACTION PLAN:

1. **PALING KRITIS**: Fix `/api/groups/[id]/members` (user-facing, langsung terlihat di UI)
2. **MEDIUM**: Check `/api/leaderboard/top-videos` (FYP page)
3. **MEDIUM**: Check `/api/campaigns/[id]/metrics` (posts count)
4. **LOW**: Check `/api/employees/[id]/metrics` (individual employee page)
5. **LOW**: Check other files marked as "Perlu Dicek"

## 🎯 PRIORITY:
**Fix file #1 dulu** karena langsung visible di Groups page member list.
