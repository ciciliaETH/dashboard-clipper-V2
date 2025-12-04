import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for Vercel Pro

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
        cache: 'no-store'
      });
      clearTimeout(timer);
      
      const data = await res.json();
      const duration = Date.now() - start;
      
      if (!res.ok) {
        return { username, ok: false, status: res.status, error: data.error || 'Failed', duration_ms: duration };
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

export async function POST(req: Request) {
  try {
    const ok = await ensureAdmin();
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const supa = adminClient();
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.max(1, Math.min(100, Number(body?.batch_size || 1)));
    const delayMs = Math.max(0, Math.min(10000, Number(body?.delay_ms || 8000)));
    const limit = Math.max(1, Math.min(10000, Number(body?.limit || 1000)));
    const campaignId = body?.campaign_id;
    
    if (!campaignId) {
      return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
    }
    
    // Get campaign window
    const { data: campaign } = await supa
      .from('campaigns')
      .select('start_date, end_date')
      .eq('id', campaignId)
      .single();
    
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }
    
    const startDate = campaign.start_date;
    const endDate = campaign.end_date || new Date().toISOString().slice(0, 10);
    
    // Get base URL for fetch-metrics endpoint
    const protocol = req.headers.get('x-forwarded-proto') || 'http';
    const host = req.headers.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;

    // 1) Get ALL TikTok usernames from campaign_participants
    let query = supa
      .from('campaign_participants')
      .select('tiktok_username')
      .eq('campaign_id', campaignId)
      .limit(limit);
    
    const { data: rows } = await query;
    
    if (!rows || rows.length === 0) {
      return NextResponse.json({ 
        total_usernames: 0, 
        processed: 0, 
        success: 0, 
        failed: 0,
        message: 'No TikTok usernames found in campaign_participants'
      });
    }

    // Get unique usernames
    const allUsernames = Array.from(new Set(
      rows.map((r: any) => String(r.tiktok_username || '').trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean)
    ));

    // 2) Sequential fetch with delay between each request to avoid rate limits
    const results: FetchResult[] = [];
    let successCount = 0;
    let failedCount = 0;
    
    for (let i = 0; i < allUsernames.length; i++) {
      const username = allUsernames[i];
      
      // Fetch ONE account at a time (sequential, not parallel)
      const result = await fetchTikTokData(username, campaignId, startDate, endDate, baseUrl);
      
      // Update campaign_participants with results
      if (result.ok && result.data?.tiktok) {
        const t = result.data.tiktok;
        await supa
          .from('campaign_participants')
          .upsert({
            campaign_id: campaignId,
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
      }
      
      results.push(result);
      if (result.ok) successCount++;
      else failedCount++;
      
      // Delay after EACH request to avoid rate limits (except last one)
      if (i < allUsernames.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // 3) Aggregate statistics
    const successResults = results.filter(r => r.ok);
    const failedResults = results.filter(r => !r.ok);
    
    const totalPosts = successResults.reduce((sum, r) => sum + (r.data?.tiktok?.posts_total || 0), 0);
    const totalViews = successResults.reduce((sum, r) => sum + (r.data?.tiktok?.views || 0), 0);
    const totalLikes = successResults.reduce((sum, r) => sum + (r.data?.tiktok?.likes || 0), 0);
    const avgDuration = results.length > 0 
      ? Math.round(results.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / results.length)
      : 0;

    return NextResponse.json({
      total_usernames: allUsernames.length,
      processed: results.length,
      success: successCount,
      failed: failedCount,
      total_posts: totalPosts,
      total_views: totalViews,
      total_likes: totalLikes,
      avg_duration_ms: avgDuration,
      results: body?.include_details ? results : undefined,
      failed_usernames: failedResults.length > 0 ? failedResults.map(r => ({
        username: r.username,
        error: r.error,
        status: r.status
      })) : undefined
    });
  } catch (error: any) {
    console.error('[tiktok refresh-all] Error:', error);
    return NextResponse.json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    }, { status: 500 });
  }
}
