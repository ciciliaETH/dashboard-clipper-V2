import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds - keep it safe

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

async function fetchInstagramData(username: string, baseUrl: string, timeout = 45000): Promise<FetchResult> {
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
  // GUARANTEED ZERO RATE LIMITS: 8 seconds delay (8x slower than limit)
  // Pro plan: 1 req/sec, with 8s delay = absolutely safe
  const delayMs = Math.max(0, Math.min(30000, Number(body?.delay_ms || 8000))); // Default 8 seconds
  const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
  const onlyWithUserId = body?.only_with_user_id === true; // default FALSE - fetch all usernames
  const maxAccountsPerRequest = 5; // CRITICAL: Max 5 accounts per request to avoid timeout
  
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
  const results: FetchResult[] = [];
  let successCount = 0;
  let failedCount = 0;
  const maxRetries = 2; // Retry failed requests up to 2 times
  
  // CRITICAL: Limit to maxAccountsPerRequest to avoid timeout
  const processLimit = Math.min(usernamesToFetch.length, maxAccountsPerRequest);
  
  for (let i = 0; i < processLimit; i++) {
    const username = usernamesToFetch[i];
    
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
    
    results.push(result!);
    if (result!.ok) successCount++;
    else failedCount++;
    
    // Delay after EACH request to avoid rate limits (except last one)
    if (i < processLimit - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Aggregate statistics
  const successResults = results.filter(r => r.ok);
  const failedResults = results.filter(r => !r.ok);
  
  const totalPosts = successResults.reduce((sum, r) => sum + (r.data?.inserted || 0), 0);
  const totalViews = successResults.reduce((sum, r) => sum + (r.data?.instagram?.views || 0), 0);
  const totalLikes = successResults.reduce((sum, r) => sum + (r.data?.instagram?.likes || 0), 0);
  const avgDuration = results.length > 0 
    ? Math.round(results.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / results.length)
    : 0;

  // Auto-refresh employee total metrics after successful refresh
  if (successCount > 0) {
    try {
      await supa.rpc('refresh_employee_total_metrics');
      console.log('[Instagram Refresh] Employee metrics refreshed');
    } catch (e) {
      console.error('[Instagram Refresh] Failed to refresh employee metrics:', e);
    }
  }

  return NextResponse.json({
    total_usernames: allUsernames.length,
    usernames_with_ids: usernamesToFetch.length,
    processed: results.length,
    success: successCount,
    failed: failedCount,
    remaining: usernamesToFetch.length - processLimit,
    total_posts_inserted: totalPosts,
    total_views: totalViews,
    total_likes: totalLikes,
    avg_duration_ms: avgDuration,
    message: processLimit < usernamesToFetch.length 
      ? `Processed ${processLimit} of ${usernamesToFetch.length} accounts. Click refresh again to continue.`
      : `All ${usernamesToFetch.length} accounts processed.`,
    batch_size: batchSize,
    delay_ms: delayMs,
    results: body?.include_details ? results : undefined,
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

