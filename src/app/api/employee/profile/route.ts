import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/employee/profile
 * Returns complete employee profile with:
 * - Basic info (name, email, username, profile picture)
 * - Total metrics across all platforms (TikTok + Instagram)
 * - Groups/campaigns the employee is assigned to
 */
export async function GET() {
  try {
    const supabase = await createClient();
    
    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile from users table
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, email, username, full_name, role, profile_picture_url, tiktok_username, instagram_username')
      .eq('id', user.id)
      .single();

    if (profileError) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    // Get total metrics from materialized view
    const { data: metrics, error: metricsError } = await supabase
      .from('employee_total_metrics')
      .select('*')
      .eq('employee_id', user.id)
      .maybeSingle();

    // Get groups/campaigns the employee is assigned to
    const { data: groups, error: groupsError } = await supabase
      .from('employee_groups')
      .select(`
        campaign_id,
        campaigns:campaign_id (
          id,
          name,
          start_date,
          end_date
        )
      `)
      .eq('employee_id', user.id);

    const groupsList = (groups || []).map((g: any) => ({
      id: g.campaigns?.id,
      name: g.campaigns?.name,
      start_date: g.campaigns?.start_date,
      end_date: g.campaigns?.end_date,
    })).filter((g: any) => g.id);

    // Get TikTok usernames from user_tiktok_usernames table
    const { data: tiktokUsernames } = await supabase
      .from('user_tiktok_usernames')
      .select('tiktok_username')
      .eq('user_id', user.id);

    const allTiktokUsernames = Array.from(new Set([
      ...(profile.tiktok_username ? [profile.tiktok_username] : []),
      ...(tiktokUsernames || []).map((u: any) => u.tiktok_username),
    ]));

    // Get Instagram usernames from user_instagram_usernames table
    const { data: instagramUsernames } = await supabase
      .from('user_instagram_usernames')
      .select('instagram_username')
      .eq('user_id', user.id);

    const allInstagramUsernames = Array.from(new Set([
      ...(profile.instagram_username ? [profile.instagram_username] : []),
      ...(instagramUsernames || []).map((u: any) => u.instagram_username),
    ]));

    return NextResponse.json({
      profile: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        full_name: profile.full_name,
        role: profile.role,
        profile_picture_url: profile.profile_picture_url,
        tiktok_usernames: allTiktokUsernames,
        instagram_usernames: allInstagramUsernames,
      },
      metrics: metrics ? {
        // TikTok
        tiktok_views: metrics.total_tiktok_views || 0,
        tiktok_likes: metrics.total_tiktok_likes || 0,
        tiktok_comments: metrics.total_tiktok_comments || 0,
        tiktok_shares: metrics.total_tiktok_shares || 0,
        tiktok_followers: metrics.total_tiktok_followers || 0,
        // Instagram
        instagram_views: metrics.total_instagram_views || 0,
        instagram_likes: metrics.total_instagram_likes || 0,
        instagram_comments: metrics.total_instagram_comments || 0,
        instagram_shares: metrics.total_instagram_shares || 0,
        instagram_followers: metrics.total_instagram_followers || 0,
        // Combined
        total_views: metrics.total_views || 0,
        total_likes: metrics.total_likes || 0,
        total_comments: metrics.total_comments || 0,
        total_shares: metrics.total_shares || 0,
        // Last updated
        last_updated: metrics.last_updated,
      } : null,
      groups: groupsList,
    });
  } catch (error: any) {
    console.error('Error fetching employee profile:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/employee/profile
 * Update employee profile (profile picture, name, etc.)
 */
export async function PATCH(req: Request) {
  try {
    const supabase = await createClient();
    
    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { profile_picture_url, full_name } = body;

    // Prepare update data
    const updateData: any = {};
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    if (full_name !== undefined) updateData.full_name = full_name;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    // Update profile
    const { error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', user.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error updating employee profile:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
