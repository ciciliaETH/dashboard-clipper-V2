import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSSR } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/toggle-hide-user
 * Toggle is_hidden status for a user
 */
export async function POST(req: Request) {
  try {
    // Verify admin session
    const supabaseSSR = await createSSR();
    const { data: { user } } = await supabaseSSR.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const { data: me } = await supabaseSSR.from('users').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { userId, isHidden } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 });
    }

    // Use service role for update
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { error } = await supabaseAdmin
      .from('users')
      .update({ is_hidden: isHidden })
      .eq('id', userId);

    if (error) {
      console.error('Error toggling hide status:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, is_hidden: isHidden });
  } catch (e: any) {
    console.error('Toggle hide user error:', e);
    return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 });
  }
}
