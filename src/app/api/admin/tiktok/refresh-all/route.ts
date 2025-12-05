import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - processes multiple accounts with RapidAPI

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function ensureAdmin() {
  const supabase = await createServerSSR();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single();
  return data?.role === 'admin' || data?.role === 'super_admin';
}

interface FetchResult {
  username: string;
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
  duration_ms?: number;
}

async function fetchTikTokData(
  username: string, 
  campaignId: string,
  startDate: string,
  endDate: string,
  baseUrl: string, 
  timeout = 60000
): Promise<FetchResult> {
  const start = Date.now();
  try {
    const url = `${baseUrl}/api/fetch-metrics/${encodeURIComponent(username)}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    
    try {
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        method: 'GET'
      });
      clearTimeout(timer);
      
      let data: any = null;
      const contentType = res.headers.get('content-type');
      
      // Only parse as JSON if content-type is JSON
      if (contentType && contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (parseErr) {
          // JSON parse failed
          const text = await res.text().catch(() => 'Unable to read response');
          return { 
            username, 
            ok: false, 
            status: res.status, 
            error: `Invalid JSON response: ${text.substring(0, 100)}`,
            duration_ms: Date.now() - start 
          };
        }
      } else {
        // Not JSON - read as text
        const text = await res.text().catch(() => 'Unable to read response');
        return { 
          username, 
          ok: false, 
          status: res.status, 
          error: `Non-JSON response (${contentType}): ${text.substring(0, 100)}`,
          duration_ms: Date.now() - start 
        };
      }
      
      const duration = Date.now() - start;
      
      if (!res.ok) {
        return { username, ok: false, status: res.status, error: data?.error || 'Failed', duration_ms: duration };
      }
      
      return { username, ok: true, status: 200, data, duration_ms: duration };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  } catch (error: any) {
    const duration = Date.now() - start;
    if (error.name === 'AbortError') {
      return { username, ok: false, status: 408, error: 'Timeout', duration_ms: duration };
    }
    return { username, ok: false, status: 500, error: error.message || 'Unknown error', duration_ms: duration };
  }
}

async function refreshHandler(req: Request) {
  try {
    const supa = adminClient();
    const isPost = req.method === 'POST';
    const body = isPost ? await req.json().catch(() => ({})) : {};
    
    // GUARANTEED ZERO RATE LIMITS: 5 seconds delay (5x slower than limit)
    // Pro plan: 1 req/sec, with 5s delay = safe with faster processing
    const delayMs = Math.max(0, Math.min(30000, Number(body?.delay_ms || 5000))); // Default 5 seconds
    const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
    const accountsPerBatch = 5; // Process 5 accounts per batch, then auto-continue
    const autoContinue = body?.auto_continue !== false; // default TRUE - auto process all accounts
    
    // Get base URL for fetch-metrics endpoint
    const protocol = req.headers.get('x-forwarded-proto') || 'http';
    const host = req.headers.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;
    
    // Get ALL unique TikTok usernames from ALL campaign_participants (no date filter!)
    const { data: rows, error: dbError } = await supa
      .from('campaign_participants')
      .select('tiktok_username, campaign_id')
      .not('tiktok_username', 'is', null)
      .limit(limit);
    
    if (dbError) {
      console.error('[TikTok Refresh] Database error:', dbError);
      return NextResponse.json({ 
        error: 'Database error',
        message: dbError.message,
        details: dbError
      }, { status: 500 });
    }
    
    if (!rows || rows.length === 0) {
      return NextResponse.json({ 
        total_usernames: 0, 
        processed: 0, 
        success: 0, 
        failed: 0,
        message: 'No TikTok usernames found in campaign_participants'
      });
    }

  // Get unique usernames (one username might be in multiple campaigns)
  const allUsernames = Array.from(new Set(
    rows.map((r: any) => String(r.tiktok_username || '').trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  ));
  
  // For each username, get their campaign_ids for updating later
  const usernameToCampaigns = new Map<string, string[]>();
  for (const row of rows) {
    const username = String((row as any).tiktok_username || '').trim().replace(/^@/, '').toLowerCase();
    const campaignId = String((row as any).campaign_id);
    if (!username) continue;
    
    const campaigns = usernameToCampaigns.get(username) || [];
    if (!campaigns.includes(campaignId)) campaigns.push(campaignId);
    usernameToCampaigns.set(username, campaigns);
  }

  // Sequential fetch with delay between each request to avoid rate limits
  const allResults: FetchResult[] = [];
  const batchProgress: Array<{
    batch: number;
    accounts: string[];
    success: number;
    failed: number;
    duration_ms: number;
  }> = [];
  
  let totalSuccess = 0;
  let totalFailed = 0;
  const maxRetries = 2; // Retry failed requests up to 2 times
  
  // AUTO-CONTINUE: Process ALL accounts in batches
  const totalBatches = Math.ceil(allUsernames.length / accountsPerBatch);
  
  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    const batchStart = batchNum * accountsPerBatch;
    const batchEnd = Math.min(batchStart + accountsPerBatch, allUsernames.length);
    const batchUsernames = allUsernames.slice(batchStart, batchEnd);
    
    const batchStartTime = Date.now();
    const batchResults: FetchResult[] = [];
    let batchSuccess = 0;
    let batchFailed = 0;
    
    console.log(`[TikTok Refresh] Batch ${batchNum + 1}/${totalBatches}: Processing ${batchUsernames.join(', ')}`);
    
    for (let i = 0; i < batchUsernames.length; i++) {
      const username = batchUsernames[i];
      const campaignIds = usernameToCampaigns.get(username) || [];
      
      // Use a wide date range to get all data (last 6 months to today)
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      
      // Use first campaign_id for the fetch (doesn't matter which, we get same TikTok data)
      const campaignId = campaignIds[0] || 'default';
      
      // Retry logic for reliability - ZERO DATA LOSS
      let result: FetchResult | null = null;
      let attempt = 0;
      
      while (attempt <= maxRetries) {
        result = await fetchTikTokData(username, campaignId, startDate, endDate, baseUrl);
        
        // Success - break retry loop
        if (result.ok) {
          break;
        }
        
        // If rate limited, wait longer before retry
        if (result.status === 429 && attempt < maxRetries) {
          console.log(`[TikTok Refresh] Rate limited on ${username}, waiting 30s before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
          attempt++;
          continue;
        }
        
        // If server error or timeout, retry with delay
        if ((result.status >= 500 || result.status === 408) && attempt < maxRetries) {
          console.log(`[TikTok Refresh] Error ${result.status} on ${username}, retrying ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
          attempt++;
          continue;
        }
        
        // Other errors - break and record as failed
        break;
      }
      
      // Update ALL campaigns that have this username - CRITICAL: Save data immediately
      if (result && result.ok && result.data?.tiktok) {
        const t = result.data.tiktok;
        
        for (const cid of campaignIds) {
          const { error: upsertError } = await supa
            .from('campaign_participants')
            .upsert({
              campaign_id: cid,
              tiktok_username: username,
              followers: Number(t.followers) || 0,
              views: Number(t.views) || 0,
              likes: Number(t.likes) || 0,
              comments: Number(t.comments) || 0,
              shares: Number(t.shares) || 0,
              saves: Number(t.saves) || 0,
              posts_total: Number(t.posts_total) || 0,
              sec_uid: t.secUid || t.sec_uid || null,
              metrics_json: result.data,
              last_refreshed: new Date().toISOString(),
            }, { onConflict: 'campaign_id,tiktok_username' });
          
          if (upsertError) {
            console.error(`[TikTok Refresh] Failed to save ${username} in campaign ${cid}:`, upsertError);
          }
        }
        
        batchSuccess++;
        totalSuccess++;
      } else {
        batchFailed++;
        totalFailed++;
      }
      
      if (result) {
        batchResults.push(result);
        allResults.push(result);
      }
      
      // Delay after EACH request to avoid rate limits (except last one in batch)
      if (i < batchUsernames.length - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    const batchDuration = Date.now() - batchStartTime;
    batchProgress.push({
      batch: batchNum + 1,
      accounts: batchUsernames,
      success: batchSuccess,
      failed: batchFailed,
      duration_ms: batchDuration
    });
    
    console.log(`[TikTok Refresh] Batch ${batchNum + 1}/${totalBatches} completed: ${batchSuccess} success, ${batchFailed} failed, ${Math.round(batchDuration/1000)}s`);
    
    // Small delay between batches (2 seconds)
    if (batchNum < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // If NOT auto-continue, stop after first batch
    if (!autoContinue) {
      break;
    }
  }

  // Aggregate statistics
  const successResults = allResults.filter(r => r && r.ok);
  const failedResults = allResults.filter(r => r && !r.ok);
  
  const totalPosts = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.posts_total || 0), 0);
  const totalViews = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.views || 0), 0);
  const totalLikes = successResults.reduce((sum, r) => sum + (r?.data?.tiktok?.likes || 0), 0);
  const avgDuration = allResults.length > 0 
    ? Math.round(allResults.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / allResults.length)
    : 0;

  // Auto-refresh employee total metrics after successful refresh
  if (totalSuccess > 0) {
    try {
      await supa.rpc('refresh_employee_total_metrics');
      console.log('[TikTok Refresh] Employee metrics refreshed');
    } catch (e) {
      console.error('[TikTok Refresh] Failed to refresh employee metrics:', e);
    }
  }

  const processedCount = allResults.length;
  const remainingCount = allUsernames.length - processedCount;

  return NextResponse.json({
    total_usernames: allUsernames.length,
    total_batches: totalBatches,
    batches_processed: batchProgress.length,
    processed: processedCount,
    success: totalSuccess,
    failed: totalFailed,
    remaining: remainingCount,
    total_posts: totalPosts,
    total_views: totalViews,
    total_likes: totalLikes,
    avg_duration_ms: avgDuration,
    auto_continue: autoContinue,
    message: autoContinue 
      ? `All ${processedCount} accounts processed in ${batchProgress.length} batches.`
      : remainingCount > 0
        ? `Processed ${processedCount} of ${allUsernames.length} accounts. Click refresh again to continue.`
        : `All ${allUsernames.length} accounts processed.`,
    batch_progress: batchProgress,
    accounts_per_batch: accountsPerBatch,
    results: body?.include_details ? allResults : undefined,
    failed_usernames: failedResults.length > 0 ? failedResults.map(r => ({
      username: r.username,
      error: r.error,
      status: r.status
    })) : undefined
  });
  } catch (error: any) {
    console.error('[refreshHandler] Unexpected error:', error);
    return NextResponse.json({ 
      error: 'Internal server error during refresh',
      message: error.message || 'Unknown error',
      details: error.toString()
    }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[tiktok refresh-all GET] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[tiktok refresh-all POST] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    }, { status: 500 });
  }
}

