import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const tid = (req.query.tid || req.query.id || '').toString().trim();
  if (!tid) return res.status(400).json({ error: 'Missing tid' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const { data, error } = await supabase
    .from('tracking')
    .select('*')
    .ilike('tracking_id', tid)
    .single();

  if (error) return res.status(404).json({ error: 'Tracking ID not found' });

  return res.status(200).json({ tracking: data });
}
