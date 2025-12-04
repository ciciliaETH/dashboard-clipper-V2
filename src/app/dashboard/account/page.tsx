"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FiLock, FiEye, FiEyeOff, FiCheckCircle, FiAlertCircle } from "react-icons/fi";
import { format, parseISO } from 'date-fns';
import { id as localeID } from 'date-fns/locale';

export default function AccountPage() {
  const supabase = createClient();
  const [email, setEmail] = useState<string>("");
  const [nextPwd, setNextPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myGroups, setMyGroups] = useState<Array<{id:string;name:string;start_date?:string|null;end_date?:string|null}>>([]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) setEmail(user.email);
      try {
        const r = await fetch('/api/employee/groups', { cache: 'no-store' });
        const j = await r.json();
        if (r.ok) setMyGroups(j.groups || []);
      } catch {}
    })();
  }, []);

  const strength = useMemo(() => {
    const s = nextPwd;
    let score = 0;
    if (s.length >= 6) score++;
    if (/[A-Z]/.test(s)) score++;
    if (/[a-z]/.test(s)) score++;
    if (/[0-9]/.test(s)) score++;
    if (/[^A-Za-z0-9]/.test(s)) score++;
    const labels = ["Sangat Lemah", "Lemah", "Cukup", "Bagus", "Kuat"];
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#22c55e", "#16a34a"];
    return { score, label: score ? labels[Math.min(score-1,4)] : "", color: colors[Math.min(score-1,4)] };
  }, [nextPwd]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null); setError(null);
    if (!nextPwd || nextPwd.length < 6) { setError("Password minimal 6 karakter"); return; }
    if (nextPwd !== confirm) { setError("Konfirmasi password tidak sama"); return; }
    setLoading(true);
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password: nextPwd });
      if (updErr) throw updErr;
      setMessage("Password berhasil diubah");
      setNextPwd(""); setConfirm("");
    } catch (e: any) {
      setError(e?.message || "Gagal mengubah password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-xl bg-blue-500/15 border border-blue-400/20 text-blue-300">
          <FiLock size={18} />
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight bg-gradient-to-r from-blue-600 to-sky-500 dark:from-white dark:to-white/70 bg-clip-text text-transparent">Akun</h1>
      </div>

      <div className="glass rounded-2xl border border-white/10 max-w-2xl mx-auto overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 className="text-white font-medium">Ubah Password</h2>
            <p className="text-white/60 text-xs">Pastikan password kuat dan unik.</p>
          </div>
        </div>
        <div className="p-5">
          {message && (
            <div className="mb-4 flex items-center gap-2 text-green-300 bg-green-500/10 border border-green-500/30 rounded-lg p-3">
              <FiCheckCircle /> <span>{message}</span>
            </div>
          )}
          {error && (
            <div className="mb-4 flex items-center gap-2 text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
              <FiAlertCircle /> <span>{error}</span>
            </div>
          )}
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-sm text-white/70 mb-1">Email</label>
                <input value={email} readOnly className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white opacity-70" />
              </div>
              <div>
                <label className="block text-sm text-white/70 mb-1">Password baru</label>
                <div className="relative">
                  <input type={showNew?"text":"password"} value={nextPwd} onChange={(e)=>setNextPwd(e.target.value)} className="w-full pr-10 px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required minLength={6} placeholder="Minimal 6 karakter" />
                  <button type="button" onClick={()=>setShowNew(v=>!v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white">
                    {showNew ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
                {nextPwd && (
                  <div className="mt-2">
                    <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full" style={{ width: `${(strength.score/5)*100}%`, background: strength.color }} />
                    </div>
                    <p className="text-xs text-white/60 mt-1">Kekuatan: <span style={{ color: strength.color }}>{strength.label}</span></p>
                  </div>
                )}
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm text-white/70 mb-1">Konfirmasi password baru</label>
                <div className="relative">
                  <input type={showConf?"text":"password"} value={confirm} onChange={(e)=>setConfirm(e.target.value)} className="w-full pr-10 px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required minLength={6} placeholder="Ulangi password baru" />
                  <button type="button" onClick={()=>setShowConf(v=>!v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white">
                    {showConf ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
                {confirm && nextPwd !== confirm && (
                  <p className="text-xs text-red-300 mt-1">Konfirmasi tidak cocok.</p>
                )}
              </div>
            </div>
            <div className="pt-2 flex justify-end">
              <button type="submit" disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 text-white disabled:opacity-60">
                {loading && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}<span>Simpan</span>
              </button>
            </div>
          </form>
        </div>
      </div>
      {/* My Groups */}
      <div className="glass rounded-2xl border border-white/10 max-w-2xl mx-auto overflow-hidden mt-6">
        <div className="px-5 py-4 border-b border-white/10"><h2 className="text-white font-medium">Group Saya</h2></div>
        <div className="p-5">
          {myGroups.length === 0 ? (
            <div className="text-white/60 text-sm">Belum tergabung ke Group manapun.</div>
          ) : (
            <ul className="space-y-2">
              {myGroups.map(g => (
                <li key={g.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-white/10 bg-white/5">
                  <div className="text-white">{g.name}</div>
                  {(g.start_date) && (
                    <div className="text-xs text-white/60">
                      {format(parseISO(g.start_date as string), 'd MMM yyyy', { locale: localeID })}
                      {g.end_date ? ` — ${format(parseISO(g.end_date as string), 'd MMM yyyy', { locale: localeID })}` : ''}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-4 text-xs text-white/50 max-w-2xl mx-auto">Catatan: Password disimpan aman di Supabase Auth dan tidak terlihat oleh admin. Admin hanya bisa mereset password Anda, bukan melihat isinya.</p>
      </div>
    </div>
  );
}
