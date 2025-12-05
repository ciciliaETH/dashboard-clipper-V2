import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function GET(req: Request) {
  try {
    const supa = adminClient();
    const url = new URL(req.url);
    const interval = (url.searchParams.get('interval') || 'daily').toLowerCase() as 'daily'|'weekly'|'monthly';
    const mode = (url.searchParams.get('mode')||'accrual').toLowerCase();
    let startISO = url.searchParams.get('start');
    let endISO = url.searchParams.get('end');
    if (!startISO || !endISO) {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate()-30);
      startISO = start.toISOString().slice(0,10);
      endISO = end.toISOString().slice(0,10);
    }

    // Accrual mode: aggregate from social_metrics_history deltas across all employees
    if (mode === 'accrual') {
      const start = startISO!; const end = endISO!;
      // keys (daily)
      const keys:string[] = []; const ds=new Date(start+'T00:00:00Z'); const de=new Date(end+'T00:00:00Z'); for (let d=new Date(ds); d<=de; d.setUTCDate(d.getUTCDate()+1)) keys.push(d.toISOString().slice(0,10));
      // baseline day before start
      const prev = new Date(start+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1); const prevISO = prev.toISOString().slice(0,10);
      // all employees
      const { data: emps } = await supa.from('users').select('id').eq('role','karyawan');
      const allEmpIds = (emps||[]).map((u:any)=> String(u.id));

      const calcSeries = async (ids:string[]) => {
        const totalMap = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        const add = (date:string, v:any)=>{ if (date < start || date > end) return; const cur = totalMap.get(date) || { views:0, likes:0, comments:0, shares:0, saves:0 }; cur.views+=v.views; cur.likes+=v.likes; cur.comments+=v.comments; cur.shares+=v.shares; cur.saves+=v.saves; totalMap.set(date, cur); };
        const buildPlat = async (plat:'tiktok'|'instagram')=>{
          if (!ids.length) return;
          const { data: rows } = await supa
            .from('social_metrics_history')
            .select('user_id, views, likes, comments, shares, saves, captured_at')
            .in('user_id', ids)
            .eq('platform', plat)
            .gte('captured_at', prevISO+'T00:00:00Z')
            .lte('captured_at', end+'T23:59:59Z')
            .order('user_id', { ascending: true })
            .order('captured_at', { ascending: true });
          const byUser = new Map<string, any[]>();
          for (const r of rows||[]) { const uid=String((r as any).user_id); const arr=byUser.get(uid)||[]; arr.push(r); byUser.set(uid, arr); }
          for (const [, arr] of byUser.entries()) {
            let prevRow:any=null; for (const r of arr) { if (!prevRow) { prevRow=r; continue; } const dv=Math.max(0, Number((r as any).views||0)-Number((prevRow as any).views||0)); const dl=Math.max(0, Number((r as any).likes||0)-Number((prevRow as any).likes||0)); const dc=Math.max(0, Number((r as any).comments||0)-Number((prevRow as any).comments||0)); const ds=Math.max(0, Number((r as any).shares||0)-Number((prevRow as any).shares||0)); const dsv=Math.max(0, Number((r as any).saves||0)-Number((prevRow as any).saves||0)); const date=String((r as any).captured_at).slice(0,10); add(date, { views: dv, likes: dl, comments: dc, shares: ds, saves: dsv }); prevRow=r; }
          }
        };
        await buildPlat('tiktok'); await buildPlat('instagram');
        return keys.map(k=> ({ date:k, ...(totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      };

      // platform-separated series across all employees (for legend sync)
      const calcSeriesPlatform = async (ids:string[], plat:'tiktok'|'instagram') => {
        const map = new Map<string,{views:number;likes:number;comments:number;shares:number;saves:number}>();
        if (ids.length) {
          const { data: rows } = await supa
            .from('social_metrics_history')
            .select('user_id, views, likes, comments, shares, saves, captured_at')
            .in('user_id', ids)
            .eq('platform', plat)
            .gte('captured_at', prevISO+'T00:00:00Z')
            .lte('captured_at', end+'T23:59:59Z')
            .order('user_id', { ascending: true })
            .order('captured_at', { ascending: true });
          const byUser = new Map<string, any[]>();
          for (const r of rows||[]) { const uid=String((r as any).user_id); const arr=byUser.get(uid)||[]; arr.push(r); byUser.set(uid, arr); }
          for (const [, arr] of byUser.entries()) {
            let prevRow:any=null; for (const r of arr) { if (!prevRow) { prevRow=r; continue; }
              const dv=Math.max(0, Number((r as any).views||0)-Number((prevRow as any).views||0));
              const dl=Math.max(0, Number((r as any).likes||0)-Number((prevRow as any).likes||0));
              const dc=Math.max(0, Number((r as any).comments||0)-Number((prevRow as any).comments||0));
              const ds=Math.max(0, Number((r as any).shares||0)-Number((prevRow as any).shares||0));
              const dsv=Math.max(0, Number((r as any).saves||0)-Number((prevRow as any).saves||0));
              const date=String((r as any).captured_at).slice(0,10);
              if (date >= start && date <= end) {
                const cur = map.get(date) || { views:0, likes:0, comments:0, shares:0, saves:0 };
                cur.views+=dv; cur.likes+=dl; cur.comments+=dc; cur.shares+=ds; cur.saves+=dsv; map.set(date, cur);
              }
              prevRow=r;
            }
          }
        }
        return keys.map(k => ({ date:k, ...(map.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 }) }));
      };

      // total across all employees
      const total = await calcSeries(allEmpIds);
      const totals = total.reduce((acc:any, s:any)=>({ views:acc.views+s.views, likes:acc.likes+s.likes, comments:acc.comments+s.comments, shares:acc.shares+s.shares, saves:acc.saves+s.saves }), { views:0, likes:0, comments:0, shares:0, saves:0 });

      // platform totals across all employees for UI legend
      const total_tiktok = await calcSeriesPlatform(allEmpIds, 'tiktok');
      const total_instagram = await calcSeriesPlatform(allEmpIds, 'instagram');

      // per-campaign breakdown
      const { data: campaigns } = await supa.from('campaigns').select('id, name').order('start_date', { ascending: true });
      const groups:any[] = [];
      if (campaigns && campaigns.length) {
        const { data: empGroups } = await supa.from('employee_groups').select('campaign_id, employee_id').in('campaign_id', campaigns.map((c:any)=> c.id));
        const byCamp = new Map<string, string[]>();
        for (const r of empGroups||[]) { const cid=String((r as any).campaign_id); const uid=String((r as any).employee_id); const arr=byCamp.get(cid)||[]; arr.push(uid); byCamp.set(cid, arr); }
        for (const camp of campaigns) {
          const ids = byCamp.get(camp.id) || [];
          const series = await calcSeries(ids);
          const series_tiktok = await calcSeriesPlatform(ids, 'tiktok');
          const series_instagram = await calcSeriesPlatform(ids, 'instagram');
          groups.push({ id: camp.id, name: camp.name || camp.id, series, series_tiktok, series_instagram });
        }
      }

      return NextResponse.json({ interval: 'daily', start, end, groups, total, total_tiktok, total_instagram, totals, mode:'accrual' });
    }

    // get all campaigns (groups) for post date series
    const { data: campaigns, error: cErr } = await supa
      .from('campaigns')
      .select('id, name')
      .order('start_date', { ascending: true });
    if (cErr) throw cErr;

    const groups: Array<{ id: string; name: string; series: Array<{date:string; views:number; likes:number; comments:number; shares:number; saves:number}>, series_tiktok?: Array<{date:string; views:number; likes:number; comments:number; shares:number; saves:number}>, series_instagram?: Array<{date:string; views:number; likes:number; comments:number}> }>=[];

    // accumulate total by date across groups
    const totalMap = new Map<string, { views:number; likes:number; comments:number; shares:number; saves:number }>();
    // also keep platform-separated totals for legend sync
    const totalTTMap = new Map<string, { views:number; likes:number; comments:number; shares:number; saves:number }>();
    const totalIGMap = new Map<string, { views:number; likes:number; comments:number }>();

    // helpers for zero-fill keys
    const buildKeys = (mode: 'daily'|'weekly'|'monthly', s: string, e: string): string[] => {
      const keys: string[] = [];
      const ds = new Date(s+'T00:00:00Z');
      const de = new Date(e+'T00:00:00Z');
      if (mode === 'daily') {
        for (let d = new Date(ds); d <= de; d.setUTCDate(d.getUTCDate()+1)) keys.push(d.toISOString().slice(0,10));
      } else if (mode === 'weekly') {
        const d = new Date(ds);
        const day = d.getUTCDay();
        const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
        for (let w = new Date(monday); w <= de; w.setUTCDate(w.getUTCDate()+7)) keys.push(w.toISOString().slice(0,10));
      } else {
        const mStart = new Date(Date.UTC(ds.getUTCFullYear(), ds.getUTCMonth(), 1));
        const mEnd = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1));
        for (let d = new Date(mStart); d <= mEnd; d.setUTCMonth(d.getUTCMonth()+1)) keys.push(d.toISOString().slice(0,10));
      }
      return keys;
    };
    const keys = buildKeys(interval, startISO!, endISO!);

    const deriveIGUsernames = async (campaignId: string): Promise<string[]> => {
      // 1) Prefer explicit campaign IG participants
      try {
        const { data: igParts } = await supa
          .from('campaign_instagram_participants')
          .select('instagram_username')
          .eq('campaign_id', campaignId);
        const arr = (igParts||[]).map((r:any)=> String(r.instagram_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (arr.length) return Array.from(new Set(arr));
      } catch {}
      // 2) Fallback to employee_instagram_participants
      try {
        const { data: empIg } = await supa
          .from('employee_instagram_participants')
          .select('instagram_username')
          .eq('campaign_id', campaignId);
        const arr = (empIg||[]).map((r:any)=> String(r.instagram_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (arr.length) return Array.from(new Set(arr));
      } catch {}
      // 3) Derive from TikTok participants' owners → IG usernames
      try {
        const { data: ttParts } = await supa
          .from('campaign_participants')
          .select('tiktok_username')
          .eq('campaign_id', campaignId);
        const ttHandles = (ttParts||[]).map((r:any)=> String(r.tiktok_username||'')
          .trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
        if (ttHandles.length) {
          const owners = new Set<string>();
          // explicit mapping table user_tiktok_usernames
          try {
            const { data: mapRows } = await supa
              .from('user_tiktok_usernames')
              .select('user_id, tiktok_username')
              .in('tiktok_username', ttHandles);
            for (const r of mapRows||[]) owners.add(String((r as any).user_id));
          } catch {}
          // users.tiktok_username direct
          try {
            const { data: userRows } = await supa
              .from('users')
              .select('id')
              .in('tiktok_username', ttHandles);
            for (const r of userRows||[]) owners.add(String((r as any).id));
          } catch {}
          if (owners.size) {
            const ids = Array.from(owners);
            const set = new Set<string>();
            try {
              const { data: igMap } = await supa
                .from('user_instagram_usernames')
                .select('instagram_username, user_id')
                .in('user_id', ids);
              for (const r of igMap||[]) {
                const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
                if (u) set.add(u);
              }
            } catch {}
            try {
              const { data: igUsers } = await supa
                .from('users')
                .select('instagram_username, id')
                .in('id', ids);
              for (const r of igUsers||[]) {
                const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
                if (u) set.add(u);
              }
            } catch {}
            if (set.size) return Array.from(set);
          }
        }
      } catch {}
      // 4) Last fallback: employees in this campaign (employee_groups) → IG aliases/profiles
      try {
        const { data: eg } = await supa
          .from('employee_groups')
          .select('employee_id')
          .eq('campaign_id', campaignId);
        const empIds = Array.from(new Set((eg||[]).map((r:any)=> String(r.employee_id))));
        if (empIds.length) {
          const set = new Set<string>();
          try {
            const { data: igMap } = await supa
              .from('user_instagram_usernames')
              .select('instagram_username, user_id')
              .in('user_id', empIds);
            for (const r of igMap||[]) {
              const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
              if (u) set.add(u);
            }
          } catch {}
          try {
            const { data: igUsers } = await supa
              .from('users')
              .select('instagram_username, id')
              .in('id', empIds);
            for (const r of igUsers||[]) {
              const u = String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase();
              if (u) set.add(u);
            }
          } catch {}
          if (set.size) return Array.from(set);
        }
      } catch {}
      return [];
    };

    const aggInstagramSeries = async (handles: string[], startISO: string, endISO: string, interval: 'daily'|'weekly'|'monthly') => {
      if (!handles.length) return new Map<string, { views:number; likes:number; comments:number }>();
      
      // Fetch all snapshots
      const base = supa.from('instagram_posts_daily')
        .select('id, username, post_date, play_count, like_count, comment_count')
        .in('username', handles)
        .gte('post_date', startISO)
        .lte('post_date', endISO)
        .order('id')
        .order('post_date');
      const { data: rows } = await base;
      
      // Group snapshots by post id
      const postMap = new Map<string, any[]>();
      for (const r of rows||[]) {
        const postId = String((r as any).id);
        if (!postMap.has(postId)) postMap.set(postId, []);
        postMap.get(postId)!.push(r);
      }
      
      // Calculate accrual per post (delta from first to last snapshot)
      const map = new Map<string, { views:number; likes:number; comments:number }>();
      for (const [postId, snapshots] of postMap.entries()) {
        if (snapshots.length === 0) continue;
        
        snapshots.sort((a: any, b: any) => new Date(a.post_date).getTime() - new Date(b.post_date).getTime());
        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        
        // Calculate accrual (delta)
        const accrualViews = snapshots.length === 1
          ? Number(last.play_count || 0)
          : Math.max(0, Number(last.play_count || 0) - Number(first.play_count || 0));
        const accrualLikes = snapshots.length === 1
          ? Number(last.like_count || 0)
          : Math.max(0, Number(last.like_count || 0) - Number(first.like_count || 0));
        const accrualComments = snapshots.length === 1
          ? Number(last.comment_count || 0)
          : Math.max(0, Number(last.comment_count || 0) - Number(first.comment_count || 0));
        
        // Determine bucket date from last snapshot
        let key: string;
        const dStr = String(last.post_date);
        if (interval === 'monthly') {
          const d = new Date(dStr+'T00:00:00Z');
          key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0,10);
        } else if (interval === 'weekly') {
          const d = new Date(dStr+'T00:00:00Z');
          const day = d.getUTCDay();
          const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day+6)%7));
          key = monday.toISOString().slice(0,10);
        } else {
          key = dStr;
        }
        
        // Add accrual to bucket
        const cur = map.get(key) || { views:0, likes:0, comments:0 };
        cur.views += accrualViews;
        cur.likes += accrualLikes;
        cur.comments += accrualComments;
        map.set(key, cur);
      }
      
      return map;
    };

    for (const camp of campaigns || []) {
      // TikTok series via RPC
      const { data: seriesRows } = await supa
        .rpc('campaign_series_v2', {
          campaign: camp.id,
          start_date: startISO,
          end_date: endISO,
          p_interval: interval,
        } as any);
      const ttRaw = (seriesRows || []).map((r:any)=>({
        date: String(r.bucket_date),
        views: Number(r.views)||0,
        likes: Number(r.likes)||0,
        comments: Number(r.comments)||0,
        shares: Number(r.shares)||0,
        saves: Number(r.saves)||0,
      }));
      const ttMap = new Map(ttRaw.map(s=>[s.date, s] as const));

      // Instagram series aggregated from instagram_posts_daily for this campaign
      const igHandles = await deriveIGUsernames(camp.id);
      const igMap = await aggInstagramSeries(igHandles, startISO!, endISO!, interval);

      // zero-fill per date key and merge TT + IG
      const series = keys.map(k => {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        return {
          date: k,
          views: tt.views + ig.views,
          likes: tt.likes + ig.likes,
          comments: tt.comments + ig.comments,
          shares: tt.shares, // IG shares not tracked here
          saves: tt.saves,   // IG saves not tracked here
        };
      });
      // Platform-separated series for this campaign (for consistent UI legends)
      const series_tiktok = keys.map(k => {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        return { date: k, views: tt.views, likes: tt.likes, comments: tt.comments, shares: tt.shares, saves: tt.saves };
      });
      const series_instagram = keys.map(k => {
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        return { date: k, views: ig.views, likes: ig.likes, comments: ig.comments } as any;
      });

      groups.push({ id: camp.id, name: camp.name || camp.id, series, series_tiktok, series_instagram });
      for (const s of series) {
        const cur = totalMap.get(s.date) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += s.views; cur.likes += s.likes; cur.comments += s.comments; cur.shares += s.shares; cur.saves += s.saves;
        totalMap.set(s.date, cur);
      }
      // accumulate platform-separated totals
      for (const k of keys) {
        const tt = ttMap.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
        const ig = igMap.get(k) || { views:0, likes:0, comments:0 };
        const ttCur = totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        ttCur.views += tt.views; ttCur.likes += tt.likes; ttCur.comments += tt.comments; ttCur.shares += tt.shares; ttCur.saves += tt.saves;
        totalTTMap.set(k, ttCur);
        const igCur = totalIGMap.get(k) || { views:0, likes:0, comments:0 };
        igCur.views += ig.views; igCur.likes += ig.likes; igCur.comments += ig.comments;
        totalIGMap.set(k, igCur);
      }
    }

    // Build total series with zero-fill to ensure full range
    const totalFilled = keys.map(k => {
      const v = totalMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      return { date: k, ...v };
    });
    const totalTT = keys.map(k => {
      const v = totalTTMap.get(k) || { views:0, likes:0, comments:0, shares:0, saves:0 };
      return { date: k, ...v };
    });
    const totalIG = keys.map(k => {
      const v = totalIGMap.get(k) || { views:0, likes:0, comments:0 };
      return { date: k, views: v.views, likes: v.likes, comments: v.comments, shares: 0, saves: 0 };
    });

    // Totals summary computed from series for consistency with chart
    const totals = totalFilled.reduce((acc:any, s:any)=>({
      views: acc.views + (s.views||0),
      likes: acc.likes + (s.likes||0),
      comments: acc.comments + (s.comments||0),
      shares: acc.shares + (s.shares||0),
      saves: acc.saves + (s.saves||0),
    }), { views:0, likes:0, comments:0, shares:0, saves:0 });

    return NextResponse.json({ interval, start: startISO, end: endISO, groups, total: totalFilled, total_tiktok: totalTT, total_instagram: totalIG, totals });
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
