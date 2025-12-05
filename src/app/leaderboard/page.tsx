'use client';

import { useEffect, useMemo, useState } from 'react';
import TopViralVideos from '@/components/TopViralVideos';
import EmployeeAvatar from '@/components/EmployeeAvatar';

type Row = {
  username: string;
  profile_picture_url?: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total?: number;
};

// Avatar component with gradient fallback
function Avatar({ username, profileUrl, size = 'sm' }: { username: string; profileUrl?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-8 h-8 text-sm', md: 'w-10 h-10 text-base', lg: 'w-12 h-12 text-lg' };
  const sizeClass = sizes[size];
  
  const getInitials = (name: string) => {
    if (!name) return '?';
    return name.slice(0, 2).toUpperCase();
  };
  
  const getGradient = (name: string) => {
    const colors = [
      'from-blue-500 to-cyan-500',
      'from-purple-500 to-pink-500',
      'from-orange-500 to-red-500',
      'from-green-500 to-teal-500',
      'from-indigo-500 to-purple-500',
      'from-pink-500 to-rose-500',
      'from-yellow-500 to-orange-500',
      'from-teal-500 to-blue-500',
    ];
    const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };
  
  if (profileUrl) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden border-2 border-white/20 flex-shrink-0`}>
        <img src={profileUrl} alt={username} className="w-full h-full object-cover" />
      </div>
    );
  }
  
  return (
    <div className={`${sizeClass} rounded-full bg-gradient-to-br ${getGradient(username)} flex items-center justify-center text-white font-semibold flex-shrink-0 border-2 border-white/20`}>
      {getInitials(username)}
    </div>
  );
}

export default function LeaderboardPage() {
  const [month, setMonth] = useState<string>(()=> new Date().toISOString().slice(0,7)); // YYYY-MM
  const [interval, setIntervalVal] = useState<'monthly'|'weekly'>('monthly');
  const [period, setPeriod] = useState<{ start: string | null; end: string | null } | null>(null)
  const [prizes, setPrizes] = useState<{ first_prize: number; second_prize: number; third_prize: number } | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const [weeklyStart, setWeeklyStart] = useState<string>('')
  const [weeklyEnd, setWeeklyEnd] = useState<string>('')
  const [campaignId, setCampaignId] = useState<string>('')

  const loadEmployees = async (m: string, iv: 'monthly'|'weekly', ws?: string, we?: string) => {
    setLoading(true); setError(null);
    try {
      const url = new URL('/api/leaderboard', window.location.origin);
      url.searchParams.set('scope','employees');
      if (iv === 'weekly') {
        url.searchParams.set('interval','weekly');
        if (ws) url.searchParams.set('start', ws);
        if (we) url.searchParams.set('end', we);
      } else {
        url.searchParams.set('month', m);
      }
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to load leaderboard');
      console.log('Leaderboard data:', json?.data); // Debug
      setRows(json?.data || []);
      setPrizes(json?.prizes || null);
      if (json?.campaign_id) setCampaignId(json.campaign_id);
      if ('start' in json || 'end' in json) setPeriod({ start: json.start ?? null, end: json.end ?? null });
      // seed weekly inputs if empty
      if (iv==='weekly') {
        if (!ws && json?.start) setWeeklyStart(String(json.start));
        if (!we && json?.end) setWeeklyEnd(String(json.end));
      }
    } catch(e:any) {
      setError(e?.message || 'Unknown error');
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const ws = interval==='weekly' ? (weeklyStart || undefined) : undefined;
    const we = interval==='weekly' ? (weeklyEnd || undefined) : undefined;
    loadEmployees(month, interval, ws, we);
    const t = setInterval(()=> setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [month, interval, weeklyStart, weeklyEnd])

  const format = (n:number) => new Intl.NumberFormat('id-ID').format(Math.round(n||0))
  const abbreviate = (n:number) => {
    const abs = Math.abs(n)
    if (abs >= 1e9) return (n/1e9).toFixed(1).replace(/\.0$/, '') + 'B'
    if (abs >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    if (abs >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/, '') + 'K'
    return format(n)
  }
  const sizeFor = (n:number) => {
    const len = format(n).length
    if (len >= 12) return 'text-sm'
    if (len >= 10) return 'text-base'
    if (len >= 8) return 'text-lg'
    return 'text-xl'
  }
  const withTotal = rows.map(r => ({ ...r, total: r.total ?? (r.views + r.likes + r.comments + r.shares + (r as any).saves || 0) }))
  const top3 = withTotal.slice(0,3)
  const rest = withTotal.slice(3)
  const grandTotals = useMemo(() => {
    const acc = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    for (const r of rows) {
      acc.views += Number(r.views)||0;
      acc.likes += Number(r.likes)||0;
      acc.comments += Number(r.comments)||0;
      acc.shares += Number(r.shares)||0;
      acc.saves += Number(r.saves)||0;
    }
    return acc;
  }, [rows]);

  const countdown = useMemo(() => {
    const end = period?.end ? new Date(period.end + 'T23:59:59Z').getTime() : null;
    if (!end) return null;
    const diff = Math.max(0, end - now);
    const d = Math.floor(diff / (24*60*60*1000));
    const h = Math.floor((diff % (24*60*60*1000))/(60*60*1000));
    const m = Math.floor((diff % (60*60*1000))/(60*1000));
    const s = Math.floor((diff % (60*1000))/1000);
    const pad = (x:number)=> String(x).padStart(2,'0');
    return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  }, [period, now]);

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="mb-4">
        <div className="mb-3 flex items-center gap-3 text-xs flex-wrap">
          <span className="text-white/60">Periode:</span>
          <button className={`px-2 py-1 rounded ${interval==='monthly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('monthly')}>Bulanan</button>
          <button className={`px-2 py-1 rounded ${interval==='weekly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('weekly')}>Mingguan</button>
          {interval==='monthly' && (
            <>
              <span className="text-white/60 ml-2">Bulan:</span>
              <input type="month" value={month} onChange={(e)=>setMonth(e.target.value)} className="px-2 py-1 rounded border border-white/10 bg-white/5 text-white/80" />
            </>
          )}
          {interval==='weekly' && (
            <div className="flex items-center gap-2">
              <input type="date" value={weeklyStart} onChange={(e)=> setWeeklyStart(e.target.value)} className="px-2 py-1 rounded border border-white/10 bg-white/5 text-white/80" />
              <span className="text-white/50">s/d</span>
              <input type="date" value={weeklyEnd} onChange={(e)=> setWeeklyEnd(e.target.value)} className="px-2 py-1 rounded border border-white/10 bg-white/5 text-white/80" />
            </div>
          )}
        </div>
        {/* Header section (title / period / totals) intentionally removed per request */}
      </div>

      {loading ? (
        <div className="glass rounded-2xl border border-white/10 p-6 text-white/70">Loading…</div>
      ) : error ? (
        <div className="glass rounded-2xl border border-white/10 p-6 text-red-300">{error}</div>
      ) : (
        <>
              <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap md:flex-nowrap md:items-end md:justify-center gap-4 md:gap-6">
                {top3.map((r, i) => {
                  const prize = i===0? prizes?.first_prize : i===1? prizes?.second_prize : prizes?.third_prize;
                  const podiumCls = i===0? 'podium podium-gold' : i===1? 'podium podium-silver' : 'podium podium-bronze';
                  const rankCls = i===0? 'rank-3d rank-gold' : i===1? 'rank-3d rank-silver' : 'rank-3d rank-bronze';
                  const order = i===1? 'md:order-1' : i===0? 'md:order-2' : 'md:order-3';
                  const height = i===0? 'min-h-[260px] sm:min-h-[280px] md:min-h-[320px]' : 'min-h-[220px] sm:min-h-[240px] md:min-h-[260px]';
                  const width = i===0? 'w-full max-w-[480px] md:w-[380px]' : 'w-full max-w-[420px] md:w-[320px]';
                  const levelOffset = i===0? 'md:-mt-2' : 'md:mt-6';
                  return (
                    <div key={r.username} className={`${order} ${width} mx-auto ${levelOffset}`}>
                      <div className={`relative glass rounded-2xl ${podiumCls} ${height} p-6 border flex flex-col items-center justify-between`}>
                        <div className="mt-2">
                          <div className={`${rankCls} text-5xl sm:text-6xl md:text-7xl`}>{i+1}</div>
                        </div>
                        <div className="text-center">
                          <div className="flex flex-col items-center gap-2 mb-2">
                            <Avatar username={r.username} profileUrl={r.profile_picture_url} size="lg" />
                            <div className="text-xs sm:text-sm text-white/70">{r.username}</div>
                          </div>
                          {typeof prize === 'number' && (
                            <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-white/90">
                              <span className="text-[11px] sm:text-xs">Prize</span>
                              <span className="font-semibold text-sm">Rp. {new Intl.NumberFormat('id-ID').format(prize)}</span>
                            </div>
                          )}
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3 text-[11px] sm:text-xs w-full">
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Views</div><div className={`text-white ${sizeFor(r.views)} leading-tight tracking-tight`}>{abbreviate(r.views)}</div></div>
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Likes</div><div className={`text-white ${sizeFor(r.likes)} leading-tight tracking-tight`}>{abbreviate(r.likes)}</div></div>
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Comments</div><div className={`text-white ${sizeFor(r.comments)} leading-tight tracking-tight`}>{abbreviate(r.comments)}</div></div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs sm:text-sm text-white/70 w-full">
                          <div>Shares: <span className="text-white">{format(r.shares)}</span></div>
                          <div>Total: <span className="text-white font-medium">{format(r.total!)}</span></div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {period && period.end && (
                <div className="mb-8 text-center">
                  <span className="text-white/80 mr-2">Ends in</span>
                  <span className="text-white font-semibold">{countdown}</span>
                </div>
              )}
            

          <div className="glass rounded-2xl border border-white/10 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-white/60 bg-white/5">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-4">Karyawan</th>
                  <th className="py-3 px-4">Views</th>
                  <th className="py-3 px-4">Likes</th>
                  <th className="py-3 px-4">Comments</th>
                  <th className="py-3 px-4">Shares</th>
                  {/* Saves removed */}
                  <th className="py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((r, i) => (
                  <tr key={r.username} className="border-t border-white/10 hover:bg-white/5">
                    <td className="py-2 px-4 text-white/60">{i+4}</td>
                    <td className="py-2 px-4">
                      <div className="flex items-center gap-3">
                        <Avatar username={r.username} profileUrl={r.profile_picture_url} size="sm" />
                        <span className="text-white/90">{r.username}</span>
                      </div>
                    </td>
                    <td className="py-2 px-4 text-white/80">{format(r.views)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.likes)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.comments)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.shares)}</td>
                    {/* Saves removed */}
                    <td className="py-2 px-4 text-white/90 font-medium">{format(r.total!)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td className="py-4 px-4 text-white/60" colSpan={7}>Tidak ada data.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Top Viral Videos Section */}
      {!loading && !error && campaignId && (
        <div className="mt-8">
          <TopViralVideos 
            campaignId={campaignId}
            platform="all"
            days={interval === 'weekly' ? 7 : 28}
            limit={10}
          />
        </div>
      )}
    </div>
  )
}
