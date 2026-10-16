'use strict';
const { randomUUID } = require('node:crypto');

// Server-side qualification intake. No Meta Pixel or analytics SDK.
// Save consented applications to Supabase, then notify GoHighLevel.

const allowed = {
  project_type: ['kitchens','bathrooms','both','remodeling','hvac','plumbing','electrical','roofing','landscaping','junk_removal','restoration','cleaning','pest_control','garage_doors','other_home_service'],
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
  for(const key of Object.keys(allowed).filter(key=>key !== 'biggest_gap')) if(!allowed[key].includes(data[key])) return send(res,400,{error:'Please complete the qualification questions'});
  const gaps = Array.isArray(data.biggest_gaps) ? [...new Set(data.biggest_gaps)] : (typeof data.biggest_gap === 'string' ? [data.biggest_gap] : []);
  if(!gaps.length || gaps.length > allowed.biggest_gap.length || !gaps.every(value=>typeof value==='string' && allowed.biggest_gap.includes(value))){
    return send(res,400,{error:'Select at least one business challenge'});
  }
  if(!validText(data.first_name,80)||!validText(data.last_name,80)||!validText(data.business_name,150,2)||!validText(data.service_area,150,2)) return send(res,400,{error:'Please provide valid contact details'});
  if(!validText(data.email,200,5)|| !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return send(res,400,{error:'Please use a valid business email'});
  if(!validText(data.phone,20,10)||data.phone.replace(/\D/g,'').length<10) return send(res,400,{error:'Please use a valid phone number'});
  if(data.consent !== true) return send(res,400,{error:'Contact permission is required'});
  if(data.website != null && !validText(data.website,250,0)) return send(res,400,{error:'Invalid website'});
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!url || !key) {
    console.error('Home services application storage environment is not configured');
    return send(res,503,{error:'Application service unavailable'});
  }
  const isEdit = Boolean(data.submission_id || data.edit_token);
  const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(isEdit && (!uuidRx.test(data.submission_id||'') || !uuidRx.test(data.edit_token||''))) return send(res,400,{error:'Invalid edit session'});
  const submissionId = isEdit ? data.submission_id : randomUUID();
  const editToken = isEdit ? data.edit_token : randomUUID();
  const payload = {
    first_name:limited(data.first_name,80),
    last_name:limited(data.last_name,80),
    business_name:limited(data.business_name,150),
    email:limited(data.email,200).toLowerCase(),
    phone:limited(data.phone,20),
    service_area:limited(data.service_area,150),
    website:data.website?limited(data.website,250):null,
    project_type:data.project_type,monthly_revenue:data.monthly_revenue,monthly_inquiries:data.monthly_inquiries,
    biggest_gap:gaps[0],biggest_gaps:gaps,capacity:data.capacity,consent:true,source:'home_services_funnel',
    utm_source:limited(data.utm_source,100)||null,
    utm_medium:limited(data.utm_medium,100)||null,
    utm_campaign:limited(data.utm_campaign,100)||null
  };
  try {
    const headers = {'Content-Type':'application/json','apikey':key,'Prefer':'return=minimal'};
    if(!key.startsWith('sb_publishable_'))headers.Authorization='Bearer '+key;
    const endpoint = url.replace(/\/$/,'') + (isEdit ? '/rest/v1/rpc/update_remodel_funnel_application' : '/rest/v1/remodel_funnel_leads');
    const body = isEdit
      ? {p_id:submissionId,p_token:editToken,p_data:payload}
      : {...payload,id:submissionId,edit_token:editToken};
    const upstream = await fetch(endpoint,{
      method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(9000)
    });
    if(!upstream.ok) {
      console.error('Database write failed, status:',upstream.status);
      return send(res,502,{error:'Unable to save application right now'});
    }
    if(isEdit && (await upstream.text()).trim() !== 'true') {
      return send(res,409,{error:'This editing session expired. Please refresh and submit again.'});
    }

    // A GoHighLevel incoming webhook is a server-to-server integration.
    // Keep its URL out of the public webpage and never send the edit token.
    const webhookUrl = process.env.GHL_LEAD_WEBHOOK_URL;
    if(webhookUrl) {
      const webhookPayload = {
        event_type: isEdit ? 'application_updated' : 'application_submitted',
        submission_id: submissionId,
        first_name: payload.first_name,
        last_name: payload.last_name,
        name: [payload.first_name,payload.last_name].filter(Boolean).join(' '),
        email: payload.email,
        phone: payload.phone,
        company_name: payload.business_name,
        business_name: payload.business_name,
        service_area: payload.service_area,
        website: payload.website,
        project_type: payload.project_type,
        monthly_revenue: payload.monthly_revenue,
        monthly_inquiries: payload.monthly_inquiries,
        biggest_gap: payload.biggest_gap,
        biggest_gaps: payload.biggest_gaps,
        biggest_gaps_text: payload.biggest_gaps.join(', '),
        capacity: payload.capacity,
        consent: true,
        source: 'Ignite Home Services Funnel',
        utm_source: payload.utm_source,
        utm_medium: payload.utm_medium,
        utm_campaign: payload.utm_campaign
      };
      try {
        const hookResponse = await fetch(webhookUrl,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(webhookPayload),
          signal:AbortSignal.timeout(6000)
        });
        if(!hookResponse.ok) console.error('GoHighLevel webhook delivery returned:',hookResponse.status);
      } catch (hookError) {
        console.error('GoHighLevel webhook delivery failed:',hookError?.name || 'UnknownError');
      }
    } else {
      console.error('GoHighLevel webhook environment variable not configured');
    }

    return send(res,isEdit?200:201,{ok:true,submission_id:submissionId,edit_token:editToken});
  } catch(err) {
    console.error('Application submission failed:',err?.name || 'UnknownError');
    return send(res,503,{error:'Unable to save application right now'});
  }
};