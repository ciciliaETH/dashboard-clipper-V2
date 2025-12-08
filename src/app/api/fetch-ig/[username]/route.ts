import { NextResponse } from 'next/server';
import { createClient as createAdmin } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { rapidApiRequest } from '@/lib/rapidapi';
import { parseMs, resolveTimestamp, resolveCounts } from './helpers';
import { fetchAllProviders, fetchProfileData, fetchLinksData, IG_HOST, IG_SCRAPER_HOST } from './providers';
import { resolveUserIdViaLink, resolveUserId } from './resolvers';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - aggregator + RapidAPI fallback

// ============================================
// AGGREGATOR API CONFIGURATION (Instagram)
// ============================================
const AGG_BASE = process.env.AGGREGATOR_BASE || 'http://202.10.44.90/api/v1';
const AGG_IG_ENABLED = (process.env.AGGREGATOR_ENABLED !== '0');
const AGG_IG_UNLIMITED = (process.env.AGGREGATOR_UNLIMITED !== '0');
const AGG_IG_MAX_PAGES = Number(process.env.AGGREGATOR_MAX_PAGES || 999);
const AGG_IG_RATE_MS = Number(process.env.AGGREGATOR_RATE_MS || 500);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

// Helper to extract caption from various API response formats
function extractCaption(media: any, node?: any): string {
  const caption = media?.caption?.text 
    || media?.caption 
    || media?.edge_media_to_caption?.edges?.[0]?.node?.text
    || node?.caption?.text
    || node?.caption
    || node?.edge_media_to_caption?.edges?.[0]?.node?.text
    || '';
  return String(caption);
}

export async function GET(req: Request, context: any) {
  const { username } = await context.params as { username: string };
  if (!username) return NextResponse.json({ error: 'username required' }, { status: 400 });
  
  const norm = String(username).replace(/^@/, '').toLowerCase();
  const url = new URL(req.url);
  const cleanup = String(url.searchParams.get('cleanup')||'');
  const debug = url.searchParams.get('debug') === '1';
  const allowUsernameFallback = (process.env.FETCH_IG_ALLOW_USERNAME_FALLBACK === '1') || (url.searchParams.get('allow_username') === '1');

  const supa = admin();
  const upserts: any[] = [];
  let source = 'aggregator';
  let fetchTelemetry: any = null;
  
  try {
    // ============================================
    // STEP 1: Try AGGREGATOR FIRST (UNLIMITED PAGINATION)
    // ============================================
    if (AGG_BASE && AGG_IG_ENABLED) {
      try {
        console.log(`[IG Fetch] 🎯 Starting Aggregator unlimited fetch for @${norm}`);
        
        const allReels: any[] = [];
        const seenIds = new Set<string>();
        let currentCursor: string | null = null;
        let pageNum = 0;
        let consecutiveSameCursor = 0;
        let lastCursor: string | null = null;
        
        // Unlimited pagination loop
        while (pageNum < AGG_IG_MAX_PAGES) {
          pageNum++;
          
          // Build URL with cursor if available
          let aggUrl = `${AGG_BASE}/instagram/reels?username=${encodeURIComponent(norm)}`;
          if (currentCursor) {
            aggUrl += `&end_cursor=${encodeURIComponent(currentCursor)}`;
          }
          
          console.log(`[IG Fetch] 📄 Page ${pageNum}: Fetching from Aggregator...`);
          
          const aggController = new AbortController();
          const aggTimeout = setTimeout(() => aggController.abort(), 30000);
          
          const aggResp = await fetch(aggUrl, { 
            signal: aggController.signal,
            headers: { 'Content-Type': 'application/json' }
          });
          clearTimeout(aggTimeout);
          
          if (!aggResp.ok) {
            console.log(`[IG Fetch] ✗ Aggregator HTTP ${aggResp.status} on page ${pageNum}`);
            break;
          }
          
          const aggData = await aggResp.json();
          const aggReels = aggData?.data?.reels || [];
          const pageInfo = aggData?.data?.page_info || {};
          const hasNextPage = pageInfo?.has_next_page || pageInfo?.more_available || false;
          const nextCursor = pageInfo?.end_cursor || null;
          
          // Process reels from this page
          let newReelsCount = 0;
          for (const reel of aggReels) {
            const id = String(reel?.id || '');
            if (!id || seenIds.has(id)) continue;
            
            seenIds.add(id);
            newReelsCount++;
            
            const code = String(reel?.code || '');
            const takenAt = Number(reel?.taken_at || 0);
            if (!takenAt) continue;
            
            const post_date = new Date(takenAt * 1000).toISOString().slice(0, 10);
            const caption = String(reel?.caption || '');
            const play = Number(reel?.play_count || reel?.ig_play_count || 0);
            const like = Number(reel?.like_count || 0);
            const comment = Number(reel?.comment_count || 0);
            
            allReels.push({ 
              id, 
              code: code || null, 
              caption: caption || null, 
              username: norm, 
              post_date, 
              play_count: play, 
              like_count: like, 
              comment_count: comment 
            });
          }
          
          console.log(`[IG Fetch] ✓ Page ${pageNum}: +${newReelsCount} new reels (total: ${allReels.length})`);
          
          // Check for termination conditions
          if (!hasNextPage || !nextCursor) {
            console.log(`[IG Fetch] ✅ Completed: No more pages (hasNextPage=${hasNextPage}, cursor=${nextCursor})`);
            break;
          }
          
          // Same cursor detection (prevent infinite loops)
          if (nextCursor === lastCursor) {
            consecutiveSameCursor++;
            if (consecutiveSameCursor >= 2) {
              console.log(`[IG Fetch] ⚠️ Same cursor detected ${consecutiveSameCursor} times, stopping`);
              break;
            }
          } else {
            consecutiveSameCursor = 0;
          }
          
          lastCursor = currentCursor;
          currentCursor = nextCursor;
          
          // Rate limiting
          await sleep(AGG_IG_RATE_MS);
        }
        
        if (allReels.length > 0) {
          console.log(`[IG Fetch] ✅ Aggregator COMPLETE: ${allReels.length} reels, ${pageNum} pages`);
          
          upserts.push(...allReels);
          source = 'aggregator';
          fetchTelemetry = {
            source: 'aggregator',
            totalReels: allReels.length,
            pagesProcessed: pageNum,
            success: true
          };
          
          // Save to database
          if (upserts.length > 0) {
            await supa.from('instagram_posts_daily').upsert(upserts, { onConflict: 'id,post_date' });
            return NextResponse.json({ 
              success: true, 
              source, 
              username: norm, 
              inserted: upserts.length, 
              total_views: upserts.reduce((s, u) => s + u.play_count, 0),
              telemetry: fetchTelemetry
            });
          }
        } else {
          console.log(`[IG Fetch] ⚠️ Aggregator returned 0 reels after ${pageNum} pages, trying RapidAPI fallback...`);
        }
      } catch (aggErr: any) {
        if (aggErr.name === 'AbortError') {
          console.log(`[IG Fetch] ✗ Aggregator timeout, trying RapidAPI fallback...`);
        } else {
          console.warn(`[IG Fetch] ✗ Aggregator error:`, aggErr.message);
        }
        fetchTelemetry = {
          source: 'aggregator',
          error: aggErr.message,
          success: false
        };
      }
    }

    // ============================================
    // STEP 2: FALLBACK to RapidAPI
    // ============================================
    console.log(`[fetch-ig] Trying RapidAPI fallback for @${norm}...`);
    let userId = await resolveUserIdViaLink(norm, supa);
    let edges: any[] = [];

    if (!userId) {
      const infoEndpoints = [
        `https://${IG_HOST}/api/instagram/user?username=${encodeURIComponent(norm)}`,
        `https://${IG_HOST}/api/instagram/userinfo?username=${encodeURIComponent(norm)}`,
        `https://${IG_HOST}/api/instagram/username?username=${encodeURIComponent(norm)}`,
      ];
      for (const u of infoEndpoints) {
        try {
          const ij = await rapidApiRequest<any>({ url: u, method: 'GET', rapidApiHost: IG_HOST, timeoutMs: 15000 });
          const cand = ij?.result?.user || ij?.user || ij?.result || {};
          const pk = cand?.pk || cand?.id || cand?.pk_id || ij?.result?.pk || ij?.result?.id;
          if (pk) { userId = String(pk); break; }
        } catch {}
      }
    }

    if (userId) {
      try { 
        await supa.from('instagram_user_ids').upsert({ 
          instagram_username: norm, 
          instagram_user_id: String(userId), 
          created_at: new Date().toISOString() 
        }, { onConflict: 'instagram_username' }); 
      } catch {}

      const results = await fetchAllProviders(userId);
      const scraperResult = results.find(r => r.source === 'scraper' && r.items.length > 0);
      const anySuccessful = results.find(r => r.items.length > 0);
      const bestResult = scraperResult || anySuccessful;
      
      if (bestResult && bestResult.items.length > 0) {
        if (bestResult.source === 'scraper') {
          for (const it of bestResult.items) {
            const id = String(it?.id || it?.code || ''); 
            const code = String(it?.code || '');
            if (!id) continue;
            
            const ms = parseMs(it?.taken_at) || parseMs(it?.device_timestamp) || parseMs(it?.taken_at_timestamp) || parseMs(it?.timestamp) || parseMs(it?.taken_at_ms) || parseMs(it?.created_at) || parseMs(it?.created_at_utc) || null;
            if (!ms) continue;
            
            const post_date = new Date(ms).toISOString().slice(0,10);
            const caption = String(it?.caption?.text || it?.caption || '');
            let play = Number(it?.play_count ?? it?.ig_play_count ?? it?.view_count ?? it?.video_view_count ?? 0) || 0;
            let like = Number(it?.like_count ?? 0) || 0;
            let comment = Number(it?.comment_count ?? 0) || 0;
            
            if ((play + like + comment) === 0) {
              try {
                const cj = await rapidApiRequest<any>({ 
                  url: `https://${IG_HOST}/api/instagram/media_info?id=${encodeURIComponent(id)}`, 
                  method: 'GET', 
                  rapidApiHost: IG_HOST, 
                  timeoutMs: 15000,
                  maxPerKeyRetries: 2
                });
                const m = cj?.result?.items?.[0] || cj?.result?.media || cj?.result || cj?.item || cj;
                play = Number(m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
                like = Number(m?.like_count || m?.edge_liked_by?.count || 0) || 0;
                comment = Number(m?.comment_count || m?.edge_media_to_comment?.count || 0) || 0;
              } catch {}
            }
            
            upserts.push({ id, code: code || null, caption: caption || null, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
          }
          source = 'rapidapi:scraper:fallback';
        } else if (bestResult.source === 'best') {
          for (const it of bestResult.items) {
            const media = it;
            const code = String(media?.code || '');
            const pid = String(media?.id || media?.pk || code || ''); 
            if (!pid) continue;
            
            const ms = parseMs(media?.taken_at) || parseMs(media?.device_timestamp) || parseMs(media?.taken_at_timestamp) || parseMs(media?.timestamp) || null;
            if (!ms) continue;
            
            const post_date = new Date(ms).toISOString().slice(0,10);
            const caption = String(media?.caption?.text || media?.caption || media?.edge_media_to_caption?.edges?.[0]?.node?.text || '');
            let play = Number(media?.play_count || media?.view_count || media?.video_view_count || 0) || 0;
            let like = Number(media?.like_count || 0) || 0;
            let comment = Number(media?.comment_count || 0) || 0;
            
            if ((play + like + comment) === 0) {
              const counts = await resolveCounts(media, { id: pid, code });
              if (counts) { play = counts.play; like = counts.like; comment = counts.comment; }
            }
            
            upserts.push({ id: pid, code: code || null, caption: caption || null, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
          }
          source = 'rapidapi:best:fallback';
        } else {
          edges = bestResult.items;
          source = `rapidapi:${bestResult.source}:fallback`;
        }
      }
    }

    if (allowUsernameFallback && upserts.length === 0) {
      const medias = await fetchProfileData(norm);
      for (const m of medias) {
        const id = String(m?.id || m?.shortcode || ''); 
        const code = String(m?.shortcode || '');
        const caption = extractCaption(m);
        if (!id) continue;
        const ms = parseMs(m?.timestamp) || parseMs(m?.taken_at) || null; 
        if (!ms) continue;
        const post_date = new Date(ms).toISOString().slice(0,10);
        let play = Number(m?.video_views || m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
        let like = Number(m?.like || m?.like_count || 0) || 0;
        let comment = Number(m?.comment_count || 0) || 0;
        if ((play + like + comment) === 0) {
          const counts = await resolveCounts({ id, code }, { id, code });
          if (counts) { play = counts.play; like = counts.like; comment = counts.comment; }
        }
        if ((play + like + comment) === 0) continue;
        upserts.push({ id, code: code || null, caption: caption || null, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
      }
      if (upserts.length > 0) source = 'profile1:username';
    }

    if (!Array.isArray(edges)) edges = [];
    const linksMap = new Map<string, number>();
    
    const linksArr = await fetchLinksData(`https://www.instagram.com/${norm}/reels/`);
    for (const it of linksArr) {
      const sc = String(it?.shortcode || it?.meta?.shortcode || '');
      const ts = parseMs(it?.takenAt || it?.meta?.takenAt);
      if (sc && ts) linksMap.set(sc, ts);
    }
    
    const telemetry = { edges: 0, linkMatches: 0, detailResolves: 0, skippedNoTimestamp: 0, fallbackLinksUsed: 0 } as any;
    for (const e of edges) {
      const node = e?.node || e?.media || e;
      const media = node?.media || node;
      const id = String(media?.pk || media?.id || media?.code || '');
      if (!id) continue;
      telemetry.edges += 1;
      
      let ms = parseMs(media?.taken_at) || parseMs(media?.taken_at_ms) || parseMs(media?.device_timestamp) || parseMs(media?.timestamp) || parseMs(node?.taken_at) || parseMs(node?.caption?.created_at) || parseMs(node?.caption?.created_at_utc);
      
      if (!ms) {
        const code = String(media?.code || node?.code || '');
        if (code && linksMap.has(code)) { 
          ms = linksMap.get(code)!; 
          telemetry.linkMatches += 1; 
        }
        if (!ms) {
          ms = await resolveTimestamp(media, node);
          if (ms) telemetry.detailResolves += 1;
        }
        if (!ms) { 
          telemetry.skippedNoTimestamp += 1; 
          continue; 
        }
      }
      
      const d = new Date(ms!);
      const post_date = d.toISOString().slice(0,10);
      const code = String(media?.code || node?.code || '');
      const caption = extractCaption(media, node);
      let play = Number(media?.play_count ?? media?.view_count ?? media?.video_view_count ?? 0) || 0;
      let like = Number(media?.like_count ?? media?.edge_liked_by?.count ?? 0) || 0;
      let comment = Number(media?.comment_count ?? media?.edge_media_to_comment?.count ?? 0) || 0;
      
      if ((play + like + comment) === 0) {
        const fixed = await resolveCounts(media, node);
        if (fixed) { 
          play = fixed.play; 
          like = fixed.like; 
          comment = fixed.comment; 
        }
      }
      if ((play + like + comment) === 0) continue;
      upserts.push({ id, code: code || null, caption: caption || null, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
    }

    if (allowUsernameFallback && upserts.length === 0 && linksMap.size > 0) {
      const urls = [
        `https://www.instagram.com/${norm}/reels/`,
        `https://www.instagram.com/${norm}/reels`,
        `https://www.instagram.com/${norm}/`
      ];
      let arr: any[] = [];
      for (const p of urls) {
        const tmp = await fetchLinksData(p);
        if (Array.isArray(tmp) && tmp.length) { 
          arr = tmp; 
          break; 
        }
      }
      for (const it of arr) {
        const sc = String(it?.shortcode || it?.meta?.shortcode || '');
        const ts = parseMs(it?.takenAt || it?.meta?.takenAt);
        if (!sc || !ts) continue;
        const post_date = new Date(ts).toISOString().slice(0,10);
        let views = Number(it?.playCount || it?.viewCount || 0) || 0;
        let likes = Number(it?.likeCount || 0) || 0;
        let comments = Number(it?.commentCount || 0) || 0;
        if ((views + likes + comments) === 0) {
          const counts = await resolveCounts({ code: sc }, { code: sc });
          if (counts) { 
            views = counts.play; 
            likes = counts.like; 
            comments = counts.comment; 
          }
        }
        if ((views + likes + comments) === 0) continue;
        upserts.push({ id: sc, code: sc, caption: null, username: norm, post_date, play_count: views, like_count: likes, comment_count: comments });
        telemetry.fallbackLinksUsed += 1;
      }
    }

    if (allowUsernameFallback && upserts.length === 0) {
      const urls = [`https://www.instagram.com/${norm}/`, `https://instagram.com/${norm}/`];
      let arr: any[] = [];
      for (const p of urls) {
        const tmp = await fetchLinksData(p);
        if (Array.isArray(tmp) && tmp.length) { 
          arr = tmp; 
          break; 
        }
      }
      for (const it of arr) {
        const sc = String(it?.shortcode || it?.meta?.shortcode || ''); 
        if (!sc) continue;
        let ms = parseMs(it?.takenAt || it?.meta?.takenAt) || null;
        
        if (!ms) {
          try {
            const info = await rapidApiRequest<any>({ 
              url: `https://${IG_HOST}/api/instagram/post_info?code=${encodeURIComponent(sc)}`, 
              method: 'GET', 
              rapidApiHost: IG_HOST, 
              timeoutMs: 15000 
            });
            const m = info?.result?.items?.[0] || info?.result?.media || info?.result || info?.item || info;
            ms = parseMs(m?.taken_at) || parseMs(m?.taken_at_ms) || null;
            const post_date = ms ? new Date(ms).toISOString().slice(0,10) : null;
            const caption = extractCaption(m);
            let views = Number(m?.play_count || m?.view_count || m?.video_view_count || 0) || 0;
            let likes = Number(m?.like_count || m?.edge_liked_by?.count || 0) || 0;
            let comments = Number(m?.comment_count || m?.edge_media_to_comment?.count || 0) || 0;
            if ((views + likes + comments) === 0) {
              const counts = await resolveCounts({ code: sc }, { code: sc });
              if (counts) { 
                views = counts.play; 
                likes = counts.like; 
                comments = counts.comment; 
              }
            }
            if (post_date && (views + likes + comments) > 0) {
              upserts.push({ 
                id: sc, 
                code: sc,
                caption: caption || null,
                username: norm, 
                post_date, 
                play_count: views, 
                like_count: likes, 
                comment_count: comments 
              });
            }
          } catch {}
        } else {
          const post_date = new Date(ms).toISOString().slice(0,10);
          let views = Number(it?.playCount || it?.viewCount || 0) || 0;
          let likes = Number(it?.likeCount || 0) || 0;
          let comments = Number(it?.commentCount || 0) || 0;
          if ((views + likes + comments) === 0) {
            const counts = await resolveCounts({ code: sc }, { code: sc });
            if (counts) { 
              views = counts.play; 
              likes = counts.like; 
              comments = counts.comment; 
            }
          }
          if ((views + likes + comments) === 0) continue;
          upserts.push({ id: sc, code: sc, caption: null, username: norm, post_date, play_count: views, like_count: likes, comment_count: comments });
        }
      }
    }

    if (upserts.length === 0) {
      const userId2 = userId || await resolveUserId(norm, supa);
      if (userId2) {
        const sj = await rapidApiRequest<any>({ 
          url: `https://${IG_SCRAPER_HOST}/get_instagram_reels_details_from_id?user_id=${encodeURIComponent(userId2)}`, 
          method: 'GET', 
          rapidApiHost: IG_SCRAPER_HOST, 
          timeoutMs: 20000 
        });
        const reels: any[] = (sj?.data?.reels || sj?.reels || sj?.data?.items || sj?.items || []) as any[];
        for (const it of reels) {
          const id = String(it?.id || it?.code || ''); 
          if (!id) continue;
          const ms = parseMs(it?.taken_at) || parseMs(it?.device_timestamp) || null; 
          if (!ms) continue;
          const post_date = new Date(ms).toISOString().slice(0,10);
          let play = Number(it?.play_count ?? it?.ig_play_count ?? 0) || 0;
          let like = Number(it?.like_count ?? 0) || 0;
          let comment = Number(it?.comment_count ?? 0) || 0;
          if ((play + like + comment) === 0) {
            const counts = await resolveCounts({ id, code: it?.code }, { id, code: it?.code });
            if (counts) { 
              play = counts.play; 
              like = counts.like; 
              comment = counts.comment; 
            }
          }
          if ((play + like + comment) === 0) continue;
          const code = String(it?.code || '');
          const caption = extractCaption(it);
          upserts.push({ id, code: code || null, caption: caption || null, username: norm, post_date, play_count: play, like_count: like, comment_count: comment });
        }
        if (upserts.length > 0) source = 'scraper:user_id';
      }
    }

    if (upserts.length) {
      if (cleanup === 'today') {
        const today = new Date().toISOString().slice(0,10);
        try { 
          await supa.from('instagram_posts_daily').delete().eq('username', norm).eq('post_date', today); 
        } catch {}
      }
      const chunk = 500;
      for (let i=0; i<upserts.length; i+=chunk) {
        const part = upserts.slice(i, i+chunk);
        await supa.from('instagram_posts_daily').upsert(part, { onConflict: 'id' });
      }
    }

    const totals = upserts.reduce((a, r)=>({
      views: a.views + (r.play_count||0),
      likes: a.likes + (r.like_count||0),
      comments: a.comments + (r.comment_count||0),
      posts_total: a.posts_total + 1,
    }), { views:0, likes:0, comments:0, posts_total:0 });

    const allowCreateUser = (process.env.FETCH_IG_CREATE_USER === '1') || (url.searchParams.get('create') === '1');
    let ownerUserId: string | null = null;
    
    const { data: u1 } = await supa.from('users').select('id').eq('instagram_username', norm).maybeSingle();
    if (u1?.id) ownerUserId = u1.id;
    
    if (!ownerUserId) {
      const { data: u2 } = await supa.from('user_instagram_usernames').select('user_id').eq('instagram_username', norm).maybeSingle();
      if (u2?.user_id) ownerUserId = u2.user_id as string;
    }
    
    if (!ownerUserId) {
      const { data: emp } = await supa.from('employee_instagram_participants').select('employee_id').eq('instagram_username', norm).limit(1);
      if (emp && emp.length > 0 && emp[0].employee_id) ownerUserId = emp[0].employee_id as string;
    }
    
    if (!ownerUserId && allowCreateUser) {
      const newId = randomUUID();
      // CRITICAL: Only set instagram_username, do NOT overwrite username field
      // username field should remain NULL for auto-created accounts
      const { error: upErr } = await supa.from('users').upsert({ 
        id: newId, 
        email: `${norm}@example.com`, 
        role: 'umum', 
        instagram_username: norm 
      }, { onConflict: 'id' });
      if (!upErr) ownerUserId = newId;
    }

    let metricsInserted = false;
    let metricsError: string | null = null;
    let aggregatedMetrics: any = null;
    
    if (ownerUserId) {
      try {
        const handles = new Set<string>();
        handles.add(norm);
        
        const { data: u1 } = await supa.from('users').select('instagram_username').eq('id', ownerUserId).maybeSingle();
        if (u1?.instagram_username) handles.add(String(u1.instagram_username).replace(/^@/, '').toLowerCase());
        
        const { data: u2 } = await supa.from('user_instagram_usernames').select('instagram_username').eq('user_id', ownerUserId);
        for (const r of u2||[]) handles.add(String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
        
        const { data: u3 } = await supa.from('employee_instagram_participants').select('instagram_username').eq('employee_id', ownerUserId);
        for (const r of u3||[]) handles.add(String((r as any).instagram_username).replace(/^@/, '').toLowerCase());
        
        if (handles.size > 0) {
          const all = Array.from(handles);
          const winDays = 60;
          const start = new Date();
          start.setUTCDate(start.getUTCDate()-winDays+1);
          const startISO = start.toISOString().slice(0,10);
          
          const { data: rows } = await supa
            .from('instagram_posts_daily')
            .select('play_count, like_count, comment_count, username, post_date')
            .in('username', all)
            .gte('post_date', startISO);
            
          const agg = (rows||[]).reduce((a:any,r:any)=>({
            views: a.views + (Number(r.play_count)||0),
            likes: a.likes + (Number(r.like_count)||0),
            comments: a.comments + (Number(r.comment_count)||0),
          }), { views:0, likes:0, comments:0 });
          
          aggregatedMetrics = { ...agg, handles: all, postsCount: rows?.length || 0 };
          const nowIso = new Date().toISOString();
          
          await supa.from('social_metrics').upsert({
            user_id: ownerUserId,
            platform: 'instagram',
            followers: 0,
            likes: agg.likes,
            views: agg.views,
            comments: agg.comments,
            shares: 0,
            saves: 0,
            last_updated: nowIso,
          }, { onConflict: 'user_id,platform' });
          
          await supa.from('social_metrics_history').insert({
            user_id: ownerUserId,
            platform: 'instagram',
            followers: 0,
            likes: agg.likes,
            views: agg.views,
            comments: agg.comments,
            shares: 0,
            saves: 0,
            captured_at: nowIso,
          });
          
          metricsInserted = true;
        }
      } catch (e) {
        metricsError = (e as any)?.message || String(e);
        console.warn('[fetch-ig] social_metrics upsert failed:', metricsError);
      }
    }

    return NextResponse.json({ 
      instagram: totals, 
      inserted: upserts.length, 
      user_id: userId, 
      owner_user_id: ownerUserId,
      metrics_inserted: metricsInserted,
      metrics_error: metricsError,
      aggregated: debug ? aggregatedMetrics : undefined,
      source, 
      telemetry: debug ? telemetry : undefined 
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
