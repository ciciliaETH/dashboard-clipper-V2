import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60; // 60 seconds to stay safe

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const all = searchParams.get('all') === '1' ? '1' : ''
    const limit = searchParams.get('limit') || ''
    const concurrency = searchParams.get('concurrency') || ''

    // Call Supabase Edge Function tiktok-refresh, which updates campaign_participants snapshots
    const fn = process.env.SUPABASE_FUNCTION_TIKTOK_REFRESH || 'tiktok-refresh'
    const funcUrl = new URL(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${fn}`)
    if (all) funcUrl.searchParams.set('all', '1')
    if (limit) funcUrl.searchParams.set('limit', limit)
    if (concurrency) funcUrl.searchParams.set('concurrency', concurrency)

    const headers = {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
    }
    const res = await fetch(funcUrl.toString(), { headers })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json?.error || 'tiktok-refresh failed')

    // AUTO-TRIGGER ACCRUAL BACKFILL after TikTok refresh
    try {
      const cronSecret = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
      const url = new URL(req.url)
      const accrualUrl = new URL(`${url.protocol}//${url.host}/api/backfill/accrual`)
      const accrualRes = await fetch(accrualUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: 28 }) // Backfill 28 days for accrual mode
      })
      const accrualJson = await accrualRes.json().catch(() => ({}))
      console.log('[tiktok-refresh] Accrual backfill triggered:', accrualJson)
    } catch (e: any) {
      console.warn('[tiktok-refresh] Failed to trigger accrual backfill:', e?.message)
    }

    return NextResponse.json(json)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
