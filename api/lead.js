'use strict';

// Server-side qualification intake. No Meta Pixel, GHL webhook, or analytics SDK.
// This route stores consented applications in an insert-only Supabase table.

const allowed = {
  project_type: ['kitchens','bathrooms','both'],
  monthly_revenue: ['under_20k','20k_50k','50k_100k','100k_plus'],
  monthly_inquiries: ['under_10','10_25','26_50','50_plus','unsure'],
  biggest_gap: ['missed_calls','slow_followup','reactivation','reviews','lead_quality','other'],
  capacity: ['yes','limited','booked_out','unsure']
};

function limited(value, max) {
  return typeof value === 'string' ? value.trim().slice(0,max) : '';
}
function validText(value, max, min=1) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}
function send(res,status,result) {
  res.status(status).setHeader('Cache-Control','no-store');
  return res.json(result);
}

module.exports = async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return send(res,405,{error:'Method not allowed'});
  }
  if(!String(req.headers['content-type']||'').includes('application/json')) return send(res,415,{error:'Use JSON'});
  const length = Number(req.headers['content-length'] || 0);
  if(length > 12000) return send(res,413,{error:'Request is too large'});
  let data = req.body;
  if(typeof data === 'string') {
    try {data = JSON.parse(data);}catch {return send(res,400,{error:'Invalid request'});}
  }
  if(!data || typeof data !== 'object' || Array.isArray(data)) return send(res,400,{error:'Invalid request'});
  // Honeypot. Never create records for bots filling hidden fields.
  if(data.other_field) return send(res,201,{ok:true});
  for(const key of Object.keys(allowed)) if(!allowed[key].includes(data[key])) return send(res,400,{error:'Please complete the qualification questions'});
  if(!validText(data.first_name,80)||!validText(data.last_name,80)||!validText(data.business_name,150,2)||!validText(data.service_area,150,2)) return send(res,400,{error:'Please provide valid contact details'});
  if(!validText(data.email,200,5)|| !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return send(res,400,{error:'Please use a valid business email'});
  if(!validText(data.phone,20,10)||data.phone.replace(/\D/g,'').length<10) return send(res,400,{error:'Please use a valid phone number'});
  if(data.consent !== true) return send(res,400,{error:'Contact permission is required'});
  if(data.website != null && !validText(data.website,250,0)) return send(res,400,{error:'Invalid website'});
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!url || !key) {
    console.error('Remodel application storage environment is not configured');
    return send(res,503,{error:'Application service unavailable'});
  }
  const payload = {
    first_name:limited(data.first_name,80),
    last_name:limited(data.last_name,80),
    business_name:limited(data.business_name,150),
    email:limited(data.email,200).toLowerCase(),
    phone:limited(data.phone,20),
    service_area:limited(data.service_area,150),
    website:data.website?limited(data.website,250):null,
    project_type:data.project_type,monthly_revenue:data.monthly_revenue,monthly_inquiries:data.monthly_inquiries,
    biggest_gap:data.biggest_gap,capacity:data.capacity,consent:true,source:'kitchen_bath_funnel',
    utm_source:limited(data.utm_source,100)||null,
    utm_medium:limited(data.utm_medium,100)||null,
    utm_campaign:limited(data.utm_campaign,100)||null
  };
  try {
    const headers = {'Content-Type':'application/json','apikey':key,'Prefer':'return=minimal'};
    if(!key.startsWith('sb_publishable_'))headers.Authorization='Bearer '+key;
    const upstream = await fetch(url.replace(/\/$/,'')+'/rest/v1/remodel_funnel_leads',{
      method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(9000)
    });
    if(!upstream.ok) {
      console.error('Database insert failed, status:',upstream.status);
      return send(res,502,{error:'Unable to save application right now'});
    }
    return send(res,201,{ok:true});
  } catch(err) {
    console.error('Application submission failed:',err?.name || 'UnknownError');
    return send(res,503,{error:'Unable to save application right now'});
  }
};