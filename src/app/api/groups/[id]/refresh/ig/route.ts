import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createSSR } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function ensureAdmin() {
  const supabase = await createSSR()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!data) return false
  return (data.role === 'admin' || data.role === 'super_admin')
}

function norm(u: any) {
  if (!u) return ''
  return String(u).replace(/^@/, '').toLowerCase()
}

export async function POST(req: Request, context: any) {
  try {
    const { id } = await context.params
    const isAdmin = await ensureAdmin()
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await req.json().catch(()=> ({}))
    const startISO: string | null = body?.start || null
    const endISO: string | null = body?.end || null
    const cleanup = body?.cleanup || null
    const supabaseAdmin = adminClient()

    // Gather IG usernames: explicit input OR derive from group participants -> user mappings
    const setIG = new Set<string>()
    // Accept explicit instagram_usernames in body
    try {
      const items: string[] = Array.isArray(body?.instagram_usernames) ? body.instagram_usernames : []
      for (const u of items) if (u) setIG.add(norm(u))
    } catch {}

    // Collect from group participants' owning users (via user_tiktok_usernames and users table)
    try {
      const { data: parts } = await supabaseAdmin
        .from('group_participants')
        .select('tiktok_username')
        .eq('group_id', id)
      const tiktoks = (parts || []).map((p:any) => norm(p.tiktok_username)).filter(Boolean)
      if (tiktoks.length) {
        const ownerIds = new Set<string>()
        try {
          const { data: alias } = await supabaseAdmin.from('user_tiktok_usernames').select('user_id').in('tiktok_username', tiktoks)
          for (const a of alias || []) ownerIds.add(String((a as any).user_id))
        } catch {}
        try {
          const { data: owners } = await supabaseAdmin.from('users').select('id, instagram_username, tiktok_username').in('tiktok_username', tiktoks)
          for (const o of owners || []) {
            if ((o as any).id) ownerIds.add(String((o as any).id))
            if ((o as any).instagram_username) setIG.add(norm((o as any).instagram_username))
          }
        } catch {}
        if (ownerIds.size) {
          const ids = Array.from(ownerIds)
          try {
            const { data: igmap } = await supabaseAdmin.from('user_instagram_usernames').select('instagram_username, user_id').in('user_id', ids)
            for (const r of igmap || []) if ((r as any).instagram_username) setIG.add(norm((r as any).instagram_username))
          } catch {}
        }
      }
    } catch (e) { console.warn('[group refresh ig] gather error', e) }

    const igUsernames = Array.from(setIG).filter(Boolean)
    if (!igUsernames.length) return NextResponse.json({ updated: 0, results: [], message: 'No Instagram usernames found' })

    // Call the deployed Edge Function `ig-refresh` with service role key
    const funcUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/ig-refresh`
    const headers: any = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    }

    const concurrency = Number(process.env.GROUP_REFRESH_CONCURRENCY || '4')
    const results: any[] = []

    async function callChunk(chunk: string[]) {
      try {
        const bodyPayload: any = { usernames: chunk }
        if (cleanup) bodyPayload.cleanup = cleanup
        const res = await fetch(funcUrl, { method: 'POST', headers, body: JSON.stringify(bodyPayload) })
        const j = await res.json().catch(()=>null)
        return j || { error: 'no-response' }
      } catch (e:any) { return { error: String(e?.message || e) } }
    }

    for (let i = 0; i < igUsernames.length; i += concurrency) {
      const chunk = igUsernames.slice(i, i + concurrency)
      const r = await callChunk(chunk)
      results.push(r)
    }

    // Aggregate totals from instagram_posts_daily for the requested time window (if provided)
    const totalsByUser: Record<string, { views:number, likes:number, comments:number, posts:number }> = {}
    try {
      const usernamesLc = igUsernames.map(u => String(u).replace(/^@/, '').toLowerCase())
      const q = supabaseAdmin.from('instagram_posts_daily').select('username, play_count, like_count, comment_count, post_date').in('username', usernamesLc)
      if (startISO) q.gte('post_date', startISO)
      if (endISO) q.lte('post_date', endISO)
      const { data: rows } = await q
      for (const r of rows || []) {
        const user = norm((r as any).username)
        const cur = totalsByUser[user] || { views:0, likes:0, comments:0, posts:0 }
        cur.views += Number((r as any).play_count) || 0
        cur.likes += Number((r as any).like_count) || 0
        cur.comments += Number((r as any).comment_count) || 0
        cur.posts += 1
        totalsByUser[user] = cur
      }
    } catch (e) { console.warn('[group refresh ig] aggregate error', e) }

    return NextResponse.json({ updated: igUsernames.length, ig_usernames: igUsernames, results, totals: totalsByUser })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
