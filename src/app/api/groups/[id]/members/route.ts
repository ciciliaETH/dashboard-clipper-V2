import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerSSR } from '@/lib/supabase/server';
import { hasRequiredHashtag } from '@/lib/hashtag-filter';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds to stay safe

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
  if (!data) return false;
  return (data.role === 'admin' || data.role === 'super_admin');
}

async function canViewCampaign(campaignId: string) {
  const supabase = await createServerSSR();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single();
  const role = (data as any)?.role;
  if (role === 'admin' || role === 'super_admin') return true;
  const admin = adminClient();
  const { data: eg } = await admin
    .from('employee_groups')
    .select('employee_id')
    .eq('campaign_id', campaignId)
    .eq('employee_id', user.id)
    .maybeSingle();
  return !!eg;
}

// GET: list employees assigned to a group (campaign) with totals from campaign snapshots only
export async function GET(req: Request, context: any) {
  try {
    const { id } = await context.params;
    const allowed = await canViewCampaign(id);
    if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = adminClient();
    const { searchParams } = new URL(req.url);
    const start = searchParams.get('start');
    const end = searchParams.get('end');
    const mode = (searchParams.get('mode') || 'postdate').toLowerCase();

    // get employees assigned to this campaign
    const { data: employees } = await supabase
      .from('employee_groups')
      .select('employee_id')
      .eq('campaign_id', id);
    const employeeRows: any[] = employees || [];
    
    // Preload all assignments for this campaign (TikTok)
    const { data: allAssign } = await supabase
      .from('employee_participants')
      .select('employee_id, tiktok_username')
      .eq('campaign_id', id);
    const byEmployee = new Map<string, string[]>();
    for (const r of allAssign || []) {
      const u = String(r.tiktok_username || '').replace(/^@/, '').toLowerCase();
      if (!u) continue;
      const arr = byEmployee.get(r.employee_id) || [];
      arr.push(u);
      byEmployee.set(r.employee_id, arr);
    }

    // Instagram assignments for this campaign (optional)
    const { data: allAssignIG } = await supabase
      .from('employee_instagram_participants')
      .select('employee_id, instagram_username')
      .eq('campaign_id', id);
    const byEmployeeIG = new Map<string, string[]>();
    for (const r of allAssignIG || []) {
      const u = String((r as any).instagram_username || '').replace(/^@/, '').toLowerCase();
      if (!u) continue;
      const arr = byEmployeeIG.get((r as any).employee_id) || [];
      arr.push(u);
      byEmployeeIG.set((r as any).employee_id, arr);
    }

    // hydrate employee info
    const results: any[] = [];
    const assignmentByUsername: Record<string, { employee_id: string, name: string }> = {};
    const empIds = employeeRows.map(e => e.employee_id);
    const { data: usersMeta } = await supabase.from('users').select('id, email, full_name, tiktok_username, instagram_username, profile_picture_url').in('id', empIds);
    const metaMap = new Map<string, any>();
    for (const u of usersMeta || []) metaMap.set(u.id, u);

    // Fallback pools per employee (ensure parity with /api/employees/[id]/metrics)
    // TikTok fallbacks: user_tiktok_usernames + employee_accounts -> users.tiktok_username + users.tiktok_username profile
    const fallbackTikTok = new Map<string, string[]>();
    try {
      const { data: mapTikTok } = await supabase
        .from('user_tiktok_usernames')
        .select('user_id, tiktok_username')
        .in('user_id', empIds);
      for (const r of mapTikTok || []) {
        const uid = (r as any).user_id; const u = String((r as any).tiktok_username || '').replace(/^@/, '').toLowerCase();
        if (!u) continue;
        const arr = fallbackTikTok.get(uid) || [];
        arr.push(u); fallbackTikTok.set(uid, arr);
      }
    } catch {}
    try {
      const { data: empAcc } = await supabase
        .from('employee_accounts')
        .select('employee_id, account_user_id')
        .in('employee_id', empIds);
      const accountIds = Array.from(new Set((empAcc||[]).map((r:any)=> r.account_user_id)));
      if (accountIds.length) {
        const { data: accUsers } = await supabase
          .from('users')
          .select('id, tiktok_username')
          .in('id', accountIds);
        const accMap = new Map<string,string>();
        for (const u of accUsers || []) accMap.set(u.id, String((u as any).tiktok_username || '').replace(/^@/, '').toLowerCase());
        for (const r of empAcc || []) {
          const uid = r.employee_id; const u = accMap.get(r.account_user_id);
          if (!u) continue; const arr = fallbackTikTok.get(uid) || []; arr.push(u); fallbackTikTok.set(uid, arr);
        }
      }
    } catch {}
    // Add profile tiktok_username as lowest-priority fallback
    for (const empId of empIds) {
      const prof = metaMap.get(empId);
      const uname = String(prof?.tiktok_username || '').replace(/^@/, '').toLowerCase();
      if (uname) {
        const arr = fallbackTikTok.get(empId) || []; arr.push(uname); fallbackTikTok.set(empId, arr);
      }
    }

    // Instagram fallbacks: user_instagram_usernames + users.instagram_username
    const fallbackIG = new Map<string, string[]>();
    try {
      const { data: mapIG } = await supabase
        .from('user_instagram_usernames')
        .select('user_id, instagram_username')
        .in('user_id', empIds);
      for (const r of mapIG || []) {
        const uid = (r as any).user_id; const u = String((r as any).instagram_username || '').replace(/^@/, '').toLowerCase();
        if (!u) continue; const arr = fallbackIG.get(uid) || []; arr.push(u); fallbackIG.set(uid, arr);
      }
    } catch {}
    for (const empId of empIds) {
      const prof = metaMap.get(empId);
      const uname = String(prof?.instagram_username || '').replace(/^@/, '').toLowerCase();
      if (uname) {
        const arr = fallbackIG.get(empId) || []; arr.push(uname); fallbackIG.set(empId, arr);
      }
    }

    // Campaign-level participants (fallback source if employee has no explicit mapping)
    const { data: campTikTok } = await supabase
      .from('campaign_participants')
      .select('tiktok_username')
      .eq('campaign_id', id);
    const campaignTT = Array.from(new Set((campTikTok || []).map((r:any)=> String(r.tiktok_username||'').replace(/^@/, '').toLowerCase()).filter(Boolean)));

    const { data: campIG } = await supabase
      .from('campaign_instagram_participants')
      .select('instagram_username')
      .eq('campaign_id', id);
    const campaignIG = Array.from(new Set((campIG || []).map((r:any)=> String((r as any).instagram_username||'').replace(/^@/, '').toLowerCase()).filter(Boolean)));

    // Get campaign hashtags for filtering
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('required_hashtags')
      .eq('id', id)
      .single();
    const requiredHashtags = (campaign as any)?.required_hashtags || null;

    // If start/end supplied, aggregate dynamically
    let sumsByUsername: Record<string, { views:number, likes:number, comments:number, shares:number, saves:number, posts:number }> | null = null;
    let sumsByUsernameIG: Record<string, { views:number, likes:number, comments:number, posts:number }> | null = null;
    // Accrual per-employee totals (if requested)
    const accrualTotals = new Map<string, { views:number, likes:number, comments:number, shares:number, saves:number }>();
    const tikNeed = new Set<string>();
    const igNeed = new Set<string>();
    if (start && end) {
      if (mode === 'accrual') {
        // Build per-employee accrual from social_metrics_history deltas within window
        const prev = new Date(start+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
        const prevISO = prev.toISOString().slice(0,10);
        const { data: rows } = await supabase
          .from('social_metrics_history')
          .select('user_id, platform, views, likes, comments, shares, saves, captured_at')
          .in('user_id', empIds)
          .gte('captured_at', prevISO+'T00:00:00Z')
          .lte('captured_at', end+'T23:59:59Z')
          .order('user_id', { ascending: true })
          .order('platform', { ascending: true })
          .order('captured_at', { ascending: true });
        // Group by user_id & platform to avoid cross-platform deltas
        const byUserPlat = new Map<string, any[]>();
        for (const r of rows||[]) {
          const uid = String((r as any).user_id);
          const plat = String((r as any).platform||'');
          const key = `${uid}::${plat}`;
          const arr = byUserPlat.get(key) || []; arr.push(r); byUserPlat.set(key, arr);
        }
        for (const [key, arr] of byUserPlat.entries()) {
          const uid = key.split('::')[0];
          let prevRow: any = null;
          for (const r of arr) {
            if (!prevRow) { prevRow = r; continue; }
            const date = String((r as any).captured_at).slice(0,10);
            if (date >= start && date <= end) {
              const dv = Math.max(0, Number((r as any).views||0) - Number((prevRow as any).views||0));
              const dl = Math.max(0, Number((r as any).likes||0) - Number((prevRow as any).likes||0));
              const dc = Math.max(0, Number((r as any).comments||0) - Number((prevRow as any).comments||0));
              const ds = Math.max(0, Number((r as any).shares||0) - Number((prevRow as any).shares||0));
              const dsv = Math.max(0, Number((r as any).saves||0) - Number((prevRow as any).saves||0));
              const cur = accrualTotals.get(uid) || { views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += dv; cur.likes += dl; cur.comments += dc; cur.shares += ds; cur.saves += dsv; accrualTotals.set(uid, cur);
            }
            prevRow = r;
          }
        }
      } else {
      // collect union per-employee based on assignment, else fallbacks
      for (const empId of empIds) {
        const assignedTT = (byEmployee.get(empId) || []).filter(Boolean);
        const useTT = assignedTT.length ? assignedTT : (campaignTT.length ? campaignTT : Array.from(new Set((fallbackTikTok.get(empId) || []).filter(Boolean))));
        for (const u of useTT) tikNeed.add(u);
        const assignedIG = (byEmployeeIG.get(empId) || []).filter(Boolean);
        const useIG = assignedIG.length ? assignedIG : (campaignIG.length ? campaignIG : Array.from(new Set((fallbackIG.get(empId) || []).filter(Boolean))));
        for (const u of useIG) igNeed.add(u);
      }
      if (tikNeed.size > 0) {
        const { data: rows } = await supabase
          .from('tiktok_posts_daily')
          .select('username, play_count, digg_count, comment_count, share_count, save_count, title')
          .gte('post_date', start)
          .lte('post_date', end)
          .in('username', Array.from(tikNeed));
        const map: Record<string, { views:number, likes:number, comments:number, shares:number, saves:number, posts:number }> = {};
        for (const r of rows || []) {
          // Apply hashtag filter
          if (!hasRequiredHashtag((r as any).title, requiredHashtags)) continue;
          
          const u = String((r as any).username||''); if (!u) continue;
          const m = map[u] || { views:0, likes:0, comments:0, shares:0, saves:0, posts:0 };
          m.views += Number((r as any).play_count)||0;
          m.likes += Number((r as any).digg_count)||0;
          m.comments += Number((r as any).comment_count)||0;
          m.shares += Number((r as any).share_count)||0;
          m.saves += Number((r as any).save_count)||0;
          m.posts += 1;
          map[u] = m;
        }
        sumsByUsername = map;
      }
      if (igNeed.size > 0) {
        const { data: rowsIG } = await supabase
          .from('instagram_posts_daily')
          .select('username, play_count, like_count, comment_count, caption')
          .gte('post_date', start)
          .lte('post_date', end)
          .in('username', Array.from(igNeed));
        const mapIG: Record<string, { views:number, likes:number, comments:number, posts:number }> = {};
        for (const r of rowsIG || []) {
          // Apply hashtag filter
          if (!hasRequiredHashtag((r as any).caption, requiredHashtags)) continue;
          
          const u = String((r as any).username||''); if (!u) continue;
          const m = mapIG[u] || { views:0, likes:0, comments:0, posts:0 };
          m.views += Number((r as any).play_count)||0;
          m.likes += Number((r as any).like_count)||0;
          m.comments += Number((r as any).comment_count)||0;
          m.posts += 1;
          mapIG[u] = m;
        }
        sumsByUsernameIG = mapIG;
      }
      }
    }

    for (const er of employeeRows || []) {
      const empId = er.employee_id;
      const user = metaMap.get(empId);
      if (!user) continue;

      // Resolve usernames: prefer explicit group assignment; else fall back to employee mappings/profile
      const assignedTT: string[] = (byEmployee.get(empId) || []).filter(Boolean);
      const assignedIG: string[] = (byEmployeeIG.get(empId) || []).filter(Boolean);
      let accountUsernames: string[] = assignedTT.length ? assignedTT : (campaignTT.length ? campaignTT : Array.from(new Set((fallbackTikTok.get(empId) || []).filter(Boolean))));
      let accountIG: string[] = assignedIG.length ? assignedIG : (campaignIG.length ? campaignIG : Array.from(new Set((fallbackIG.get(empId) || []).filter(Boolean))));
      for (const u of accountUsernames) assignmentByUsername[u] = { employee_id: empId, name: user.full_name || user.email || user.tiktok_username };

      // totals: if dynamic window provided, use DB aggregation; else use campaign snapshot
      let totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 } as any;
      if (mode === 'accrual' && accrualTotals.size>0) {
        const acc = accrualTotals.get(empId) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        totals.views += acc.views; totals.likes += acc.likes; totals.comments += acc.comments; totals.shares += acc.shares; totals.saves += acc.saves;
      } else if (sumsByUsername || sumsByUsernameIG) {
        if (sumsByUsername) {
          for (const u of accountUsernames) {
            const m = (sumsByUsername as any)[u]; if (!m) continue;
            totals.views += m.views; totals.likes += m.likes; totals.comments += m.comments; totals.shares += m.shares; totals.saves += m.saves; totals.posts += m.posts;
          }
        }
        if (sumsByUsernameIG) {
          for (const u of accountIG) {
            const m = (sumsByUsernameIG as any)[u]; if (!m) continue;
            totals.views += m.views; totals.likes += m.likes; totals.comments += m.comments; totals.posts += m.posts;
          }
        }
      } else {
        if (accountUsernames.length > 0) {
          const { data: snaps } = await supabase
            .from('campaign_participants')
            .select('tiktok_username, views, likes, comments, shares, saves, posts_total')
            .eq('campaign_id', id)
            .in('tiktok_username', accountUsernames);
          for (const r of snaps || []) {
            totals.views += Number(r.views || 0);
            totals.likes += Number(r.likes || 0);
            totals.comments += Number(r.comments || 0);
            totals.shares += Number(r.shares || 0);
            totals.saves += Number(r.saves || 0);
            totals.posts += Number((r as any).posts_total || 0);
          }
        }
        if (accountIG.length > 0) {
          const { data: snapsIG } = await supabase
            .from('campaign_instagram_participants')
            .select('instagram_username, views, likes, comments, posts_total')
            .eq('campaign_id', id)
            .in('instagram_username', accountIG);
          for (const r of snapsIG || []) {
            totals.views += Number((r as any).views || 0);
            totals.likes += Number((r as any).likes || 0);
            totals.comments += Number((r as any).comments || 0);
            totals.posts += Number((r as any).posts_total || 0);
          }
        }
      }

      // No 'saves' column required anymore
      totals.saves = 0;

      // For UI consistency, expose only explicitly assigned TikTok accounts in `accounts`
      results.push({ 
        id: user.id, 
        name: user.full_name || user.email || user.tiktok_username, 
        tiktok_username: user.tiktok_username, 
        profile_picture_url: user.profile_picture_url || null,
        accounts: assignedTT, 
        accounts_ig: assignedIG, 
        totals 
      });
    }

    // also aggregate group totals
    const groupTotals = results.reduce((acc:any, r:any) => ({
      views: acc.views + (r.totals?.views||0),
      likes: acc.likes + (r.totals?.likes||0),
      comments: acc.comments + (r.totals?.comments||0),
      shares: acc.shares + (r.totals?.shares||0),
      saves: 0,
      posts: acc.posts + (r.totals?.posts||0),
    }), { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 });

    return NextResponse.json({ members: results, groupTotals, assignmentByUsername });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST: add an employee to group and/or assign participant usernames to the employee within this campaign
export async function POST(req: Request, context: any) {
  try {
    const isAdmin = await ensureAdmin();
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = adminClient();
    const { id } = (await context.params) as { id: string }; // campaign id
    const body = await req.json();
    const { employee_id, participant_usernames, participant_instagram_usernames } = body;
    if (!employee_id) return NextResponse.json({ error: 'employee_id required' }, { status: 400 });

    // upsert employee_groups
    const { error: egErr } = await supabase.from('employee_groups').upsert({ employee_id, campaign_id: id }, { onConflict: 'employee_id,campaign_id' });
    if (egErr) throw egErr;

    // Optionally assign participant usernames to employee (TikTok)
    if (Array.isArray(participant_usernames) && participant_usernames.length > 0) {
      const usernames = participant_usernames.map((u:string)=> String(u).replace(/^@/, '').toLowerCase());
      // Ensure participants exist on this campaign
      const toInsert = usernames.map(u => ({ campaign_id: id, tiktok_username: u }));
      await supabase.from('campaign_participants').upsert(toInsert, { onConflict: 'campaign_id,tiktok_username', ignoreDuplicates: true });

      // Check conflicts: username already assigned to a different employee for this campaign
      const { data: existing } = await supabase
        .from('employee_participants')
        .select('employee_id, tiktok_username')
        .eq('campaign_id', id)
        .in('tiktok_username', usernames);
      const conflicts = (existing || []).filter((r:any)=> r.employee_id !== employee_id);
      if (conflicts.length) {
        // find names
        const taken = conflicts.map((c:any)=> c.tiktok_username);
        const { data: owners } = await supabase
          .from('employee_participants')
          .select('tiktok_username, employee_id')
          .eq('campaign_id', id)
          .in('tiktok_username', taken);
        const empIds = Array.from(new Set((owners||[]).map((o:any)=> o.employee_id)));
        const { data: users } = await supabase.from('users').select('id, full_name, email, username').in('id', empIds);
        const nameMap = new Map<string,string>();
        for (const u of users || []) nameMap.set(u.id, (u.full_name || u.username || u.email));
        const detail = (owners||[]).map((o:any)=> ({ username: o.tiktok_username, owner: nameMap.get(o.employee_id) || o.employee_id }));
        return NextResponse.json({ error: 'Username sudah dimiliki karyawan lain', conflicts: detail }, { status: 409 });
      }

      // Insert mapping for requested employee (no conflict)
      const epRows = usernames.map(u => ({ employee_id, campaign_id: id, tiktok_username: u }));
      await supabase.from('employee_participants').upsert(epRows, { onConflict: 'employee_id,campaign_id,tiktok_username', ignoreDuplicates: true });
      // Mirror to user_tiktok_usernames mapping table for global consistency
      try {
        const mapRows = usernames.map(u => ({ user_id: employee_id, tiktok_username: u }));
        if (mapRows.length) await supabase.from('user_tiktok_usernames').upsert(mapRows, { onConflict: 'user_id,tiktok_username', ignoreDuplicates: true });
      } catch {}
    }

    // Optionally assign Instagram usernames to employee (Instagram)
    if (Array.isArray(participant_instagram_usernames) && participant_instagram_usernames.length > 0) {
      const usernamesIG = participant_instagram_usernames.map((u:string)=> String(u).replace(/^@/, '').toLowerCase());
      // Ensure ig participants exist on this campaign
      const toInsertIG = usernamesIG.map(u => ({ campaign_id: id, instagram_username: u }));
      await supabase.from('campaign_instagram_participants').upsert(toInsertIG, { onConflict: 'campaign_id,instagram_username', ignoreDuplicates: true });

      // Check conflicts: username already assigned to a different employee for this campaign
      const { data: existingIG } = await supabase
        .from('employee_instagram_participants')
        .select('employee_id, instagram_username')
        .eq('campaign_id', id)
        .in('instagram_username', usernamesIG);
      const conflictsIG = (existingIG || []).filter((r:any)=> r.employee_id !== employee_id);
      if (conflictsIG.length) {
        const taken = conflictsIG.map((c:any)=> c.instagram_username);
        const { data: ownersIG } = await supabase
          .from('employee_instagram_participants')
          .select('instagram_username, employee_id')
          .eq('campaign_id', id)
          .in('instagram_username', taken);
        const empIdsIG = Array.from(new Set((ownersIG||[]).map((o:any)=> o.employee_id)));
        const { data: usersIG } = await supabase.from('users').select('id, full_name, email, username').in('id', empIdsIG);
        const nameMapIG = new Map<string,string>();
        for (const u of usersIG || []) nameMapIG.set(u.id, (u.full_name || u.username || u.email));
        const detailIG = (ownersIG||[]).map((o:any)=> ({ username: o.instagram_username, owner: nameMapIG.get(o.employee_id) || o.employee_id }));
        return NextResponse.json({ error: 'Username Instagram sudah dimiliki karyawan lain', conflicts: detailIG }, { status: 409 });
      }

      // Insert mapping for requested employee (no conflict)
      const igRows = usernamesIG.map(u => ({ employee_id, campaign_id: id, instagram_username: u }));
      await supabase.from('employee_instagram_participants').upsert(igRows, { onConflict: 'employee_id,campaign_id,instagram_username', ignoreDuplicates: true });
      // Mirror to user_instagram_usernames mapping table for global consistency
      try {
        const mapRowsIG = usernamesIG.map(u => ({ user_id: employee_id, instagram_username: u }));
        if (mapRowsIG.length) await supabase.from('user_instagram_usernames').upsert(mapRowsIG, { onConflict: 'user_id,instagram_username', ignoreDuplicates: true });
      } catch {}
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE: remove a username assignment from an employee within this campaign
export async function DELETE(req: Request, context: any) {
  try {
    const isAdmin = await ensureAdmin();
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = adminClient();
    const { id } = await context.params as { id: string }; // campaign id
    const body = await req.json().catch(()=>({}));
    const { employee_id, tiktok_username, instagram_username } = body || {};
    if (!employee_id) return NextResponse.json({ error: 'employee_id required' }, { status: 400 });

    if (tiktok_username) {
      // Unassign single username
      const username = String(tiktok_username).replace(/^@/, '').toLowerCase();
      const { error } = await supabase
        .from('employee_participants')
        .delete()
        .eq('campaign_id', id)
        .eq('employee_id', employee_id)
        .eq('tiktok_username', username);
      if (error) throw error;
    } else if (instagram_username) {
      const username = String(instagram_username).replace(/^@/, '').toLowerCase();
      const { error } = await supabase
        .from('employee_instagram_participants')
        .delete()
        .eq('campaign_id', id)
        .eq('employee_id', employee_id)
        .eq('instagram_username', username);
      if (error) throw error;
    } else {
      // Remove employee from group entirely
      const { error: e1 } = await supabase
        .from('employee_participants')
        .delete()
        .eq('campaign_id', id)
        .eq('employee_id', employee_id);
      if (e1) throw e1;
      const { error: e1b } = await supabase
        .from('employee_instagram_participants')
        .delete()
        .eq('campaign_id', id)
        .eq('employee_id', employee_id);
      if (e1b) throw e1b;
      const { error: e2 } = await supabase
        .from('employee_groups')
        .delete()
        .eq('campaign_id', id)
        .eq('employee_id', employee_id);
      if (e2) throw e2;
    }

    return NextResponse.json({ success: true });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
