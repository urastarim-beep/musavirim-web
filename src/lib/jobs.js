import { supabase } from '../supabaseClient';

export async function createJob(tip, payload = {}, firmaId = null) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Oturum yok');

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      tip,
      payload,
      user_id: user.id,
      firma_id: firmaId,
      durum: 'bekliyor',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listJobs(limit = 20) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function getJob(id) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}
