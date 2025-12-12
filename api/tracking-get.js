import { createClient } from "@supabase/supabase-js";

function parseCreatedAt(tr) {
  if (tr && tr.created_at) return new Date(tr.created_at);
  const m = /DFS-(\d{12})-/.exec((tr && tr.tracking_id) || '');
  if (m) {
    const s = m[1];
    const y = +s.slice(0,4), mo = +s.slice(4,6)-1, d = +s.slice(6,8), h = +s.slice(8,10), mi = +s.slice(10,12);
    return new Date(y, mo, d, h, mi);
  }
  return null;
}

function parseDeliveryDate(tr) {
  if (tr && tr.delivery_date) return new Date(tr.delivery_date);
  if (tr && tr.estimated_delivery) return new Date(tr.estimated_delivery);
  return null;
}

function computeStage(tr) {
  const created = parseCreatedAt(tr);
  const delivery = parseDeliveryDate(tr);
  
  let activeIndex = 0;
  let hold = false;
  
  if (created && delivery) {
    const now = Date.now();
    const createdTime = created.getTime();
    const deliveryTime = delivery.getTime();
    
    // Calculate total duration from creation to delivery (in milliseconds)
    const totalDuration = Math.max(0, deliveryTime - createdTime);
    
    // Calculate elapsed time from creation to now (in milliseconds)
    const elapsedTime = Math.max(0, now - createdTime);
    
    if (totalDuration > 0) {
      // Divide the total duration into 4 equal parts
      const partDuration = totalDuration / 4;
      
      // Determine which part we're currently in (0, 1, 2, or 3)
      if (elapsedTime >= partDuration * 3) {
        activeIndex = 3;
        hold = true; // Last part is the hold state
      } else if (elapsedTime >= partDuration * 2) {
        activeIndex = 2;
      } else if (elapsedTime >= partDuration) {
        activeIndex = 1;
      } else {
        activeIndex = 0;
      }
    } else {
      // If delivery date is in the past or same as creation, set to hold state
      activeIndex = 3;
      hold = true;
    }
  } else if (created) {
    // If no delivery date, fallback to original time-based logic
    const elapsedMin = Math.max(0, (Date.now() - created.getTime())/60000);
    if (elapsedMin >= 15) {
      activeIndex = 3;
      hold = true;
    } else if (elapsedMin >= 10) {
      activeIndex = 2;
    } else if (elapsedMin >= 5) {
      activeIndex = 1;
    } else {
      activeIndex = 0;
    }
  }
  
  const progressPct = Math.min(100, Math.round((activeIndex/(4-1))*100));
  const statusHeadline = hold ? 'On Hold' : (tr.status || 'In progress');
  const statusMessage = hold ? 'On Hold' : (tr.status_message || 'In progress');
  return { activeIndex, hold, progressPct, statusHeadline, statusMessage };
}

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

  const stage = computeStage(data);
  
  return res.status(200).json({ 
    tracking: data,
    stage: stage
  });
}
