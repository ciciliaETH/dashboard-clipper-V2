import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { hasRequiredHashtag } from '@/lib/hashtag-filter'

export const dynamic = 'force-dynamic'

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const campaignId = url.searchParams.get('campaign_id') || ''
    const platform = (url.searchParams.get('platform') || 'all').toLowerCase() // all, tiktok, instagram
    const daysParam = Number(url.searchParams.get('days') || '7')
    const windowDays = ([7, 28] as number[]).includes(daysParam) ? daysParam : 7
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || '10')))

    if (!campaignId) {
      return NextResponse.json({ error: 'campaign_id required' }, { status: 400 })
    }

    const supabase = supabaseAdmin()
    
    // Get campaign info including required hashtags
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, name, required_hashtags')
      .eq('id', campaignId)
      .single()
    
    const requiredHashtags = campaign?.required_hashtags || null
    
    // Calculate date window
    const endISO = new Date().toISOString().slice(0, 10)
    const startDate = new Date()
    startDate.setUTCDate(startDate.getUTCDate() - (windowDays - 1))
    const startISO = startDate.toISOString().slice(0, 10)

    // Get employee list for this campaign
    const { data: employees } = await supabase
      .from('employee_groups')
      .select('employee_id')
      .eq('campaign_id', campaignId)
    
    if (!employees || employees.length === 0) {
      return NextResponse.json({ 
        videos: [], 
        campaign_id: campaignId,
        required_hashtags: requiredHashtags,
        platform, 
        start: startISO, 
        end: endISO, 
        days: windowDays 
      })
    }

    const employeeIds = employees.map((e: any) => e.employee_id)

    // Get usernames mapping
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, username, tiktok_username, instagram_username')
      .in('id', employeeIds)
      .eq('is_hidden', false)
    
    const userMap = new Map<string, any>()
    for (const u of users || []) {
      userMap.set(u.id, {
        name: u.full_name || u.username || u.tiktok_username || u.instagram_username || u.id,
        tiktok_username: u.tiktok_username,
        instagram_username: u.instagram_username
      })
    }

    const videos: any[] = []

    // === TIKTOK VIDEOS ===
    if (platform === 'all' || platform === 'tiktok') {
      // Get TikTok usernames ONLY from employees in THIS campaign who are not hidden
      const tiktokUsernames: string[] = []
      
      // From users table (main tiktok_username)
      for (const u of users || []) {
        if (u.tiktok_username) {
          tiktokUsernames.push(u.tiktok_username.toLowerCase().replace(/^@+/, ''))
        }
      }
      
      // From employee_participants - MUST be for THIS campaign AND employee must be visible
      const { data: ttParticipants } = await supabase
        .from('employee_participants')
        .select('employee_id, tiktok_username')
        .eq('campaign_id', campaignId)
        .in('employee_id', employeeIds)
      
      for (const p of ttParticipants || []) {
        // Only include if employee is visible (exists in userMap)
        const employeeInfo = userMap.get(p.employee_id)
        if (employeeInfo && p.tiktok_username) {
          tiktokUsernames.push(p.tiktok_username.toLowerCase().replace(/^@+/, ''))
        }
      }
      
      const uniqueTikTokUsernames = Array.from(new Set(tiktokUsernames))

      if (uniqueTikTokUsernames.length > 0) {
        // Query tiktok_posts_daily for videos in window
        const { data: tiktokPosts } = await supabase
          .from('tiktok_posts_daily')
          .select('video_id, username, post_date, title, play_count, digg_count, comment_count, share_count, save_count')
          .in('username', uniqueTikTokUsernames)
          .gte('post_date', startISO)
          .lte('post_date', endISO)
          .order('play_count', { ascending: false })
          .limit(limit * 10) // Get more for hashtag filtering

        // Group by video_id and calculate accrual (delta from first to last snapshot)
        const videoMap = new Map<string, any[]>()
        for (const post of tiktokPosts || []) {
          const vid = String(post.video_id)
          if (!videoMap.has(vid)) videoMap.set(vid, [])
          videoMap.get(vid)!.push(post)
        }

        // Calculate accrual for each video
        for (const [videoId, snapshots] of videoMap.entries()) {
          // Sort by date
          snapshots.sort((a, b) => a.post_date.localeCompare(b.post_date))
          
          const first = snapshots[0]
          const last = snapshots[snapshots.length - 1]
          
          // Filter by hashtag if required
          if (!hasRequiredHashtag(last.title, requiredHashtags)) {
            continue;
          }
          
          // Accrual = final - initial (or use final if only one snapshot)
          const views = snapshots.length === 1 
            ? Number(last.play_count || 0)
            : Math.max(0, Number(last.play_count || 0) - Number(first.play_count || 0))
          const likes = snapshots.length === 1
            ? Number(last.digg_count || 0)
            : Math.max(0, Number(last.digg_count || 0) - Number(first.digg_count || 0))
          const comments = snapshots.length === 1
            ? Number(last.comment_count || 0)
            : Math.max(0, Number(last.comment_count || 0) - Number(first.comment_count || 0))
          const shares = snapshots.length === 1
            ? Number(last.share_count || 0)
            : Math.max(0, Number(last.share_count || 0) - Number(first.share_count || 0))
          const saves = snapshots.length === 1
            ? Number(last.save_count || 0)
            : Math.max(0, Number(last.save_count || 0) - Number(first.save_count || 0))

          // Find owner user
          let ownerName = last.username
          let ownerId = null
          for (const [uid, info] of userMap.entries()) {
            if (info.tiktok_username?.toLowerCase().replace(/^@+/, '') === last.username.toLowerCase()) {
              ownerName = info.name
              ownerId = uid
              break
            }
          }

          videos.push({
            platform: 'tiktok',
            video_id: videoId,
            username: last.username,
            owner_name: ownerName,
            owner_id: ownerId,
            post_date: last.post_date,
            link: `https://www.tiktok.com/@${last.username}/video/${videoId}`,
            metrics: {
              views,
              likes,
              comments,
              shares,
              saves,
              total_engagement: likes + comments + shares + saves
            },
            snapshots_count: snapshots.length
          })
        }
      }
    }

    // === INSTAGRAM VIDEOS ===
    if (platform === 'all' || platform === 'instagram') {
      // Get Instagram usernames ONLY from employees in THIS campaign who are not hidden
      const instagramUsernames: string[] = []
      
      // From users table (main instagram_username)
      for (const u of users || []) {
        if (u.instagram_username) {
          instagramUsernames.push(u.instagram_username.toLowerCase().replace(/^@+/, ''))
        }
      }

      // From employee_instagram_participants - MUST be for THIS campaign AND employee must be visible
      const { data: igParticipants } = await supabase
        .from('employee_instagram_participants')
        .select('employee_id, instagram_username')
        .eq('campaign_id', campaignId)
        .in('employee_id', employeeIds)
      
      for (const p of igParticipants || []) {
        // Only include if employee is visible (exists in userMap)
        const employeeInfo = userMap.get(p.employee_id)
        if (employeeInfo && p.instagram_username) {
          instagramUsernames.push(p.instagram_username.toLowerCase().replace(/^@+/, ''))
        }
      }

      const uniqueIgUsernames = Array.from(new Set(instagramUsernames))

      if (uniqueIgUsernames.length > 0) {
        // Query instagram_posts_daily for posts in window
        const { data: igPosts } = await supabase
          .from('instagram_posts_daily')
          .select('id, code, username, post_date, caption, play_count, like_count, comment_count')
          .in('username', uniqueIgUsernames)
          .gte('post_date', startISO)
          .lte('post_date', endISO)
          .order('play_count', { ascending: false })
          .limit(limit * 10) // Get more for hashtag filtering

        // Group by id and calculate accrual
        const videoMap = new Map<string, any[]>()
        for (const post of igPosts || []) {
          const vid = String(post.id)
          if (!videoMap.has(vid)) videoMap.set(vid, [])
          videoMap.get(vid)!.push(post)
        }

        // Calculate accrual for each post
        for (const [postId, snapshots] of videoMap.entries()) {
          snapshots.sort((a, b) => a.post_date.localeCompare(b.post_date))
          
          const first = snapshots[0]
          const last = snapshots[snapshots.length - 1]
          
          // Filter by hashtag if required
          if (!hasRequiredHashtag(last.caption, requiredHashtags)) {
            continue;
          }
          
          const views = snapshots.length === 1
            ? Number(last.play_count || 0)
            : Math.max(0, Number(last.play_count || 0) - Number(first.play_count || 0))
          const likes = snapshots.length === 1
            ? Number(last.like_count || 0)
            : Math.max(0, Number(last.like_count || 0) - Number(first.like_count || 0))
          const comments = snapshots.length === 1
            ? Number(last.comment_count || 0)
            : Math.max(0, Number(last.comment_count || 0) - Number(first.comment_count || 0))

          // Find owner user
          let ownerName = last.username
          let ownerId = null
          for (const [uid, info] of userMap.entries()) {
            if (info.instagram_username?.toLowerCase().replace(/^@+/, '') === last.username.toLowerCase()) {
              ownerName = info.name
              ownerId = uid
              break
            }
          }

          videos.push({
            platform: 'instagram',
            video_id: postId,
            username: last.username,
            owner_name: ownerName,
            owner_id: ownerId,
            post_date: last.post_date,
            link: `https://www.instagram.com/reel/${last.code || postId}/`,
            metrics: {
              views,
              likes,
              comments,
              shares: 0,
              saves: 0,
              total_engagement: likes + comments
            },
            snapshots_count: snapshots.length
          })
        }
      }
    }

    // Sort by views descending and limit
    videos.sort((a, b) => b.metrics.views - a.metrics.views)
    const topVideos = videos.slice(0, limit)

    return NextResponse.json({
      videos: topVideos,
      campaign_id: campaignId,
      required_hashtags: requiredHashtags,
      platform,
      start: startISO,
      end: endISO,
      days: windowDays,
      total_found: videos.length,
      showing: topVideos.length,
      filtered_by_hashtag: requiredHashtags && requiredHashtags.length > 0
    })
  } catch (e: any) {
    console.error('[top-videos] error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
