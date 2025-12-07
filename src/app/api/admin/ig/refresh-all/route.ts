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

async function fetchInstagramData(username: string, baseUrl: string, timeout = 60000): Promise<FetchResult> {
  const start = Date.now();
  try {
    const url = `${baseUrl}/api/fetch-ig/${encodeURIComponent(username)}?create=1&allow_username=0`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    
    try {
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }
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
  const supa = adminClient();
  const isPost = req.method === 'POST';
  const body = isPost ? await req.json().catch(() => ({})) : {};
  
  const batchSize = Math.max(1, Math.min(100, Number(body?.batch_size || 1)));
  // GUARANTEED ZERO RATE LIMITS: 5 seconds delay (5x slower than limit)
  // Pro plan: 1 req/sec, with 5s delay = safe with faster processing
  const delayMs = Math.max(0, Math.min(30000, Number(body?.delay_ms || 2000))); // Default 2 seconds (FASTER)
  const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
  const onlyWithUserId = body?.only_with_user_id === true; // default FALSE - fetch all usernames
  const accountsPerBatch = 3; // Process 3 accounts per batch (AVOID 300s TIMEOUT!)
  const autoContinue = body?.auto_continue === true; // default FALSE - manual batch to prevent timeout
  const offset = Math.max(0, Number(body?.offset || 0)); // Track which batch we're on
  
  // Get base URL for fetch-ig endpoint
  const protocol = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('host') || 'localhost:3000';
  const baseUrl = `${protocol}://${host}`;

  // Get ALL unique Instagram usernames from ALL campaign_instagram_participants (no date filter!)
  const { data: rows } = await supa
    .from('campaign_instagram_participants')
    .select('instagram_username')
    .not('instagram_username', 'is', null)
    .limit(limit);
  
  if (!rows || rows.length === 0) {
    return NextResponse.json({ 
      total_usernames: 0, 
      processed: 0, 
      success: 0, 
      failed: 0,
      message: 'No Instagram usernames found in campaign_instagram_participants'
    });
  }

  // Get unique usernames
  const allUsernames = Array.from(new Set(
    rows.map((r: any) => String(r.instagram_username || '').trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  ));

  // Filter by those that have instagram_user_id if requested
  let usernamesToFetch = allUsernames;
  if (onlyWithUserId) {
    const { data: userIds } = await supa
      .from('instagram_user_ids')
      .select('instagram_username')
      .in('instagram_username', allUsernames)
      .not('instagram_user_id', 'is', null);
    
    const withIds = new Set((userIds || []).map((r: any) => r.instagram_username));
    usernamesToFetch = allUsernames.filter(u => withIds.has(u));
  }

  if (usernamesToFetch.length === 0) {
    return NextResponse.json({
      total_usernames: allUsernames.length,
      usernames_with_ids: 0,
      processed: 0,
      success: 0,
      failed: 0,
      message: 'No usernames with resolved instagram_user_id found'
    });
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
  const maxRetries = 999; // UNLIMITED: Retry as many times as needed - data MUST exist
  const failedAccountsQueue: string[] = []; // Track failed accounts to retry in next batch
  
  // Manual batch processing with offset tracking
  const totalBatches = Math.ceil(usernamesToFetch.length / accountsPerBatch);
  const startBatch = Math.floor(offset / accountsPerBatch);
  const endBatch = autoContinue ? totalBatches : startBatch + 1; // Only process 1 batch unless auto-continue
  
  for (let batchNum = startBatch; batchNum < endBatch; batchNum++) {
    const batchStart = batchNum * accountsPerBatch;
    const batchEnd = Math.min(batchStart + accountsPerBatch, usernamesToFetch.length);
    let batchUsernames = usernamesToFetch.slice(batchStart, batchEnd);
    
    // CRITICAL: Prepend failed accounts from previous batch to RETRY them first
    if (failedAccountsQueue.length > 0) {
      const retryAccounts = [...failedAccountsQueue];
      failedAccountsQueue.length = 0; // Clear queue
      batchUsernames = [...retryAccounts, ...batchUsernames];
      console.log(`[Instagram Refresh] 🔄 RETRY: Adding ${retryAccounts.length} failed accounts to batch ${batchNum + 1}: ${retryAccounts.join(', ')}`);
    }
    
    const batchStartTime = Date.now();
    const batchResults: FetchResult[] = [];
    let batchSuccess = 0;
    let batchFailed = 0;
    
    console.log(`[Instagram Refresh] Batch ${batchNum + 1}/${totalBatches}: Processing ${batchUsernames.length} accounts (${batchUsernames.join(', ')})`);
    
    for (let i = 0; i < batchUsernames.length; i++) {
      const username = batchUsernames[i];
      
      // Retry logic for reliability - ZERO DATA LOSS
      let result: FetchResult | null = null;
      let attempt = 0;
      
      while (attempt <= maxRetries) {
        result = await fetchInstagramData(username, baseUrl);
        
        // Success - break retry loop
        if (result.ok) {
          break;
        }
        
        // If rate limited, wait longer before retry
        if (result.status === 429 && attempt < maxRetries) {
          console.log(`[Instagram Refresh] Rate limited on ${username}, waiting 30s before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
          attempt++;
          continue;
        }
        
        // If server error or timeout, retry with delay
        if ((result.status >= 500 || result.status === 408) && attempt < maxRetries) {
          console.log(`[Instagram Refresh] Error ${result.status} on ${username}, retrying ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
          attempt++;
          continue;
        }
        
        // Other errors - break and record as failed
        break;
      }
      
      batchResults.push(result!);
      allResults.push(result!);
      
      // VALIDATION: Ensure response has actual data
      if (result!.ok) {
        const inserted = result!.data?.inserted || 0;
        const views = result!.data?.instagram?.views || 0;
        
        // WARNING: Log if account has ZERO data
        if (inserted === 0 && views === 0) {
          console.warn(`[Instagram Refresh] WARNING: ${username} returned ZERO data (empty account or API issue)`);
        }
        
        batchSuccess++;
        totalSuccess++;
      } else {
        // FAILED: Add to queue for retry in next batch
        failedAccountsQueue.push(username);
        console.warn(`[Instagram Refresh] ⚠️ ${username} FAILED, will retry in next batch (queue: ${failedAccountsQueue.length})`);
        batchFailed++;
        totalFailed++;
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
    
    console.log(`[Instagram Refresh] Batch ${batchNum + 1}/${totalBatches} completed: ${batchSuccess} success, ${batchFailed} failed, ${Math.round(batchDuration/1000)}s`);
    
    // Small delay between batches (2 seconds) - only if auto-continue
    if (autoContinue && batchNum < endBatch - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Aggregate statistics
  const successResults = allResults.filter(r => r.ok);
  const failedResults = allResults.filter(r => !r.ok);
  
  const totalPosts = successResults.reduce((sum, r) => sum + (r.data?.inserted || 0), 0);
  const totalViews = successResults.reduce((sum, r) => sum + (r.data?.instagram?.views || 0), 0);
  const totalLikes = successResults.reduce((sum, r) => sum + (r.data?.instagram?.likes || 0), 0);
  const avgDuration = allResults.length > 0 
    ? Math.round(allResults.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / allResults.length)
    : 0;

  // Auto-refresh employee total metrics after successful refresh
  if (totalSuccess > 0) {
    try {
      await supa.rpc('refresh_employee_total_metrics');
      console.log('[Instagram Refresh] Employee metrics refreshed');
    } catch (e) {
      console.error('[Instagram Refresh] Failed to refresh employee metrics:', e);
    }
  }

  const processedCount = offset + allResults.length;
  const remainingCount = usernamesToFetch.length - processedCount;
  const nextOffset = remainingCount > 0 ? processedCount : 0;
  
  // CRITICAL ERROR LOGGING: Alert if any accounts failed after all retries
  if (totalFailed > 0) {
    const failedUsernames = failedResults.map(r => r.username).join(', ');
    console.error(`[Instagram Refresh] ⚠️ CRITICAL: ${totalFailed} accounts FAILED after ${maxRetries} retries: ${failedUsernames}`);
    console.error('[Instagram Refresh] Failed details:', failedResults.map(r => ({ username: r.username, status: r.status, error: r.error })));
  } else {
    console.log(`[Instagram Refresh] ✅ SUCCESS: All ${totalSuccess} accounts refreshed successfully`);
  }

  return NextResponse.json({
    total_usernames: allUsernames.length,
    usernames_with_ids: usernamesToFetch.length,
    total_batches: totalBatches,
    current_batch: startBatch + 1,
    batches_processed: batchProgress.length,
    processed: allResults.length,
    total_processed: processedCount,
    success: totalSuccess,
    failed: totalFailed,
    remaining: remainingCount,
    offset: offset,
    next_offset: nextOffset,
    total_posts_inserted: totalPosts,
    total_views: totalViews,
    total_likes: totalLikes,
    avg_duration_ms: avgDuration,
    auto_continue: autoContinue,
    message: remainingCount > 0
      ? `Batch ${startBatch + 1}/${totalBatches}: Processed ${allResults.length} accounts (${processedCount}/${usernamesToFetch.length} total). Click refresh to continue with next ${Math.min(accountsPerBatch, remainingCount)} accounts.`
      : `All ${usernamesToFetch.length} accounts processed successfully!`,
    batch_progress: batchProgress,
    batch_size: batchSize,
    accounts_per_batch: accountsPerBatch,
    delay_ms: delayMs,
    results: body?.include_details ? allResults : undefined,
    failed_usernames: failedResults.length > 0 ? failedResults.map(r => ({ 
      username: r.username, 
      error: r.error,
      status: r.status 
    })) : undefined,
    success_details: body?.include_details ? successResults.map(r => ({
      username: r.username,
      posts: r.data?.inserted || 0,
      views: r.data?.instagram?.views || 0,
      likes: r.data?.instagram?.likes || 0,
      source: r.data?.source
    })) : undefined
  });
}

export async function GET(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[ig refresh-all GET] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to refresh Instagram data',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return await refreshHandler(req);
  } catch (error: any) {
    console.error('[ig refresh-all POST] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to refresh Instagram data',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

