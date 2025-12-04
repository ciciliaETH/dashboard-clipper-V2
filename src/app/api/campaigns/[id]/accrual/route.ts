import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';

export const dynamic = 'force-dynamic';

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function canView(campaignId: string) {
  const supa = await createSSR();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return false;
  const { data } = await supa.from('users').select('role').eq('id', user.id).single();
  const role = (data as any)?.role;
  if (role === 'admin' || role === 'super_admin') return true;
  const admin = adminClient();
  const { data: eg } = await admin.from('employee_groups').select('employee_id').eq('campaign_id', campaignId).eq('employee_id', user.id).maybeSingle();
  return !!eg;
}

export async function GET(req: Request, ctx: any) {
  try {
    const { id } = await ctx.params as { id: string };
    const allowed = await canView(id); if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const admin = adminClient();
    const url = new URL(req.url);
    const startISO = String(url.searchParams.get('start') || new Date(new Date().setDate(new Date().getDate()-30)).toISOString().slice(0,10));
    const endISO = String(url.searchParams.get('end') || new Date().toISOString().slice(0,10));

    // Fetch campaign required_hashtags for filtering
    const { data: campaign } = await admin
      .from('campaigns')
      .select('id, name, required_hashtags')
      .eq('id', id)
      .single();
    const requiredHashtags = campaign?.required_hashtags || null;

    // Get campaign handles and the official list of employees in this campaign
    const { data: ttParts } = await admin.from('campaign_participants').select('tiktok_username').eq('campaign_id', id);
    const ttHandles = Array.from(new Set((ttParts||[]).map((r:any)=> String(r.tiktok_username).replace(/^@/,'').toLowerCase())));
    const { data: igParts } = await admin.from('campaign_instagram_participants').select('instagram_username').eq('campaign_id', id);
    const igHandles = Array.from(new Set((igParts||[]).map((r:any)=> String(r.instagram_username).replace(/^@/,'').toLowerCase())));
    // Restrict accrual computation to employees that are in employee_groups for this campaign
    const { data: egEmployees } = await admin.from('employee_groups').select('employee_id').eq('campaign_id', id);
    const allowedEmpIds = new Set<string>((egEmployees||[]).map((r:any)=> String(r.employee_id)));

    // Map handles -> user ids
    const userIdsTT = new Set<string>();
    const userIdsIG = new Set<string>();
    if (ttHandles.length) {
      const { data: u1 } = await admin.from('users').select('id, tiktok_username').in('tiktok_username', ttHandles);
      for (const r of u1||[]) { const uid=String((r as any).id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsTT.add(uid); }
      const { data: map } = await admin.from('user_tiktok_usernames').select('user_id, tiktok_username').in('tiktok_username', ttHandles);
      for (const r of map||[]) { const uid=String((r as any).user_id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsTT.add(uid); }
    }
    if (igHandles.length) {
      const { data: u1 } = await admin.from('users').select('id, instagram_username').in('instagram_username', igHandles);
      for (const r of u1||[]) { const uid=String((r as any).id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
      const { data: map } = await admin.from('user_instagram_usernames').select('user_id, instagram_username').in('instagram_username', igHandles);
      for (const r of map||[]) { const uid=String((r as any).user_id); if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
    }
    // Fallback: if IG participants are not explicitly listed, derive IG owners from TT owners
    if (userIdsTT.size) {
      const ttOwnerIds = Array.from(userIdsTT);
      for (const uid of ttOwnerIds) { if (allowedEmpIds.size===0 || allowedEmpIds.has(uid)) userIdsIG.add(uid); }
    }

    // Helper to aggregate deltas per day from social_metrics_history with optional hashtag filtering
    const buildAccrual = async (ids: string[], platform: 'tiktok'|'instagram', userIdToHandle: Map<string, string>) => {
      if (!ids.length) return new Map<string, {views:number;likes:number;comments:number;shares:number;saves:number}>();
      
      // If hashtag filtering enabled, identify which user_ids have valid posts
      let validUserIds: Set<string> | null = null;
      if (requiredHashtags && requiredHashtags.length > 0) {
        validUserIds = new Set<string>();
        const handles = Array.from(userIdToHandle.values()).filter(Boolean);
        if (handles.length > 0) {
          if (platform === 'tiktok') {
            const { data: posts } = await admin
              .from('tiktok_posts_daily')
              .select('username, video_id, title, post_date')
              .in('username', handles)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            for (const post of posts || []) {
              const title = String((post as any).title || '');
              if (hasRequiredHashtag(title, requiredHashtags)) {
                const username = String((post as any).username).toLowerCase();
                // Find user_id for this username
                for (const [uid, handle] of userIdToHandle.entries()) {
                  if (handle === username) validUserIds.add(uid);
                }
              }
            }
          } else if (platform === 'instagram') {
            const { data: posts } = await admin
              .from('instagram_posts_daily')
              .select('username, id, caption, post_date')
              .in('username', handles)
              .gte('post_date', startISO)
              .lte('post_date', endISO);
            for (const post of posts || []) {
              const caption = String((post as any).caption || '');
              if (hasRequiredHashtag(caption, requiredHashtags)) {
                const username = String((post as any).username).toLowerCase();
                // Find user_id for this username
                for (const [uid, handle] of userIdToHandle.entries()) {
                  if (handle === username) validUserIds.add(uid);
                }
              }
            }
          }
        }
      }
      
      // include one day before start as baseline so first day's delta tidak hilang
      const prev = new Date(startISO+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
      const prevISO = prev.toISOString().slice(0,10);
      const { data: rows } = await admin
        .from('social_metrics_history')
        .select('user_id, platform, views, likes, comments, shares, saves, captured_at')
        .in('user_id', ids)
        .eq('platform', platform)
        .gte('captured_at', prevISO + 'T00:00:00Z')
        .lte('captured_at', endISO + 'T23:59:59Z')
        .order('user_id', { ascending: true })
        .order('captured_at', { ascending: true });
      const byUser = new Map<string, any[]>();
      for (const r of rows||[]) {
        const uid = String((r as any).user_id);
        // If hashtag filtering active and user has no valid posts, skip
        if (validUserIds && !validUserIds.has(uid)) continue;
        const arr = byUser.get(uid) || []; arr.push(r); byUser.set(uid, arr);
      }
      const out = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
      const add = (date:string, v:{views:number;likes:number;comments:number;shares:number;saves:number})=>{
        const cur = out.get(date) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += v.views; cur.likes += v.likes; cur.comments += v.comments; cur.shares += v.shares; cur.saves += v.saves; out.set(date, cur);
      };
      for (const [uid, arr] of byUser.entries()) {
        let prev: any = null;
        for (const r of arr) {
          if (!prev) { prev = r; continue; }
          const dv = Math.max(0, Number((r as any).views||0) - Number((prev as any).views||0));
          const dl = Math.max(0, Number((r as any).likes||0) - Number((prev as any).likes||0));
          const dc = Math.max(0, Number((r as any).comments||0) - Number((prev as any).comments||0));
          const ds = Math.max(0, Number((r as any).shares||0) - Number((prev as any).shares||0));
          const dsv = Math.max(0, Number((r as any).saves||0) - Number((prev as any).saves||0));
          const date = String((r as any).captured_at).slice(0,10);
          // hanya akumulasi untuk tanggal di dalam window (>= start)
          if (date >= startISO && date <= endISO) {
            add(date, { views: dv, likes: dl, comments: dc, shares: ds, saves: dsv });
          }
          prev = r;
        }
      }
      return out;
    };

    // Build user_id -> handle mappings for hashtag filtering
    const userIdToTikTok = new Map<string, string>();
    const userIdToInstagram = new Map<string, string>();
    if (userIdsTT.size > 0) {
      const { data: ttUsers } = await admin.from('users').select('id, tiktok_username').in('id', Array.from(userIdsTT));
      for (const u of ttUsers || []) {
        if ((u as any).tiktok_username) userIdToTikTok.set(String((u as any).id), String((u as any).tiktok_username).replace(/^@/, '').toLowerCase());
      }
      const { data: ttMap } = await admin.from('user_tiktok_usernames').select('user_id, tiktok_username').in('user_id', Array.from(userIdsTT));
      for (const r of ttMap || []) {
        const uid = String((r as any).user_id);
        if (!userIdToTikTok.has(uid)) userIdToTikTok.set(uid, String((r as any).tiktok_username).replace(/^@/, '').toLowerCase());
      }
    }
    if (userIdsIG.size > 0) {
      const { data: igUsers } = await admin.from('users').select('id, instagram_username').in('id', Array.from(userIdsIG));
      for (const u of igUsers || []) {
        if ((u as any).instagram_username) userIdToInstagram.set(String((u as any).id), String((u as any).instagram_username).replace(/^@/, '').toLowerCase());
      }
      const { data: igMap } = await admin.from('user_instagram_usernames').select('user_id, instagram_username').in('user_id', Array.from(userIdsIG));
      for (const r of igMap || []) {
        const uid = String((r as any).user_id);
        if (!userIdToInstagram.has(uid)) userIdToInstagram.set(uid, String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
      }
    }

    const ttMap = await buildAccrual(Array.from(userIdsTT), 'tiktok', userIdToTikTok);
    const igMap = await buildAccrual(Array.from(userIdsIG), 'instagram', userIdToInstagram);

    // Build zero-filled series
    const ds = new Date(startISO+'T00:00:00Z');
    const de = new Date(endISO+'T00:00:00Z');
    const seriesTikTok: any[] = []; const seriesInstagram: any[] = [];
    for (let d = new Date(ds); d <= de; d.setUTCDate(d.getUTCDate()+1)) {
      const key = d.toISOString().slice(0,10);
      const tv = ttMap.get(key) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      const iv = igMap.get(key) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      seriesTikTok.push({ date: key, ...tv });
      seriesInstagram.push({ date: key, ...iv });
    }
    const merge = new Map<string,{date:string;views:number;likes:number;comments:number;shares:number;saves:number}>();
    const push = (arr:any[])=>{ for (const s of arr) { const cur = merge.get(s.date) || { date:s.date, views:0, likes:0, comments:0, shares:0, saves:0 }; cur.views+=s.views; cur.likes+=s.likes; cur.comments+=s.comments; cur.shares+=s.shares; cur.saves+=s.saves; merge.set(s.date, cur); } };
    push(seriesTikTok); push(seriesInstagram);
    const seriesTotal = Array.from(merge.values()).sort((a,b)=> a.date.localeCompare(b.date));
    const totals = seriesTotal.reduce((a:any, s:any)=> ({ views:a.views+s.views, likes:a.likes+s.likes, comments:a.comments+s.comments, shares:a.shares+s.shares, saves:a.saves+s.saves }), { views:0, likes:0, comments:0, shares:0, saves:0 });

    return NextResponse.json({ 
      start: startISO, 
      end: endISO, 
      series_total: seriesTotal, 
      series_tiktok: seriesTikTok, 
      series_instagram: seriesInstagram, 
      totals,
      required_hashtags: requiredHashtags,
      filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0
    });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
