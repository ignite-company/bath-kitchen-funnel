'use strict';
const { randomUUID } = require('node:crypto');

// Server-side qualification intake. No Meta Pixel or analytics SDK.
// Save consented applications to Supabase, then notify GoHighLevel.

const allowed = {
  project_type: ['kitchens','bathrooms','both','remodeling','hvac','plumbing','electrical','roofing','landscaping','junk_removal','restoration','cleaning','pest_control','garage_doors','other_home_service','roofing_siding','masonry_hardscaping','interior_remodeling','tree_service','painting','auto_detailing','pressure_washing','other_service'],
  monthly_revenue: ['under_20k','20k_50k','50k_100k','100k_plus'],
  monthly_inquiries: ['under_10','10_25','26_50','50_plus','unsure'],
  biggest_gap: ['missed_calls','slow_followup','reactivation','reviews','lead_quality','other','not_enough_leads','low_conversion','poor_follow_up','repeat_business','inconsistent_growth','online_presence','operations'],
  capacity: ['yes','limited','booked_out','unsure'],
  readiness: ['ready_now','need_details','not_ready','within_30_days','one_to_three_months','just_exploring']
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
  // The service-business quiz uses three qualifying questions. Keep older submissions compatible.
  // Legacy applications remain supported for visitors with an older page open.
  const isTimedApplication = data.readiness != null;
  if(isTimedApplication) {
    if(!allowed.readiness.includes(data.readiness)) return send(res,400,{error:'Please confirm when you are ready to get started'});
    if(!allowed.project_type.includes(data.project_type)) return send(res,400,{error:'Please select your service business type'});
  } else if(!allowed.monthly_inquiries.includes(data.monthly_inquiries)) {
    return send(res,400,{error:'Please complete the qualification questions'});
  }
  if(data.project_type != null && !allowed.project_type.includes(data.project_type)) return send(res,400,{error:'Invalid business type'});
  if(data.monthly_inquiries != null && !allowed.monthly_inquiries.includes(data.monthly_inquiries)) return send(res,400,{error:'Invalid lead volume'});
  // Allow legacy open forms to send these fields, but never require them.
  for(const key of ['monthly_revenue','capacity']) if(data[key] != null && !allowed[key].includes(data[key])) return send(res,400,{error:'Invalid qualification answer'});
  const gaps = Array.isArray(data.biggest_gaps) ? [...new Set(data.biggest_gaps)] : (typeof data.biggest_gap === 'string' ? [data.biggest_gap] : []);
  if(!gaps.length || gaps.length > allowed.biggest_gap.length || !gaps.every(value=>typeof value==='string' && allowed.biggest_gap.includes(value))){
    return send(res,400,{error:'Select at least one business challenge'});
  }
  // Support a single Name field while remaining compatible with older saved forms.
  const enteredName = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g,' ') : '';
  if(typeof data.name === 'string' && !validText(enteredName,160)) return send(res,400,{error:'Please enter your name'});
  const namePieces = enteredName ? enteredName.split(' ') : [];
  const firstName = enteredName ? namePieces.shift() : limited(data.first_name,80);
  const lastName = enteredName ? namePieces.join(' ') : limited(data.last_name,80);
  const serviceArea = limited(data.service_area,150);
  if(!validText(firstName,80) || (lastName && !validText(lastName,80)) || !validText(data.business_name,150,2)) return send(res,400,{error:'Please provide valid contact details'});
  if(data.service_area != null && serviceArea && !validText(serviceArea,150,2)) return send(res,400,{error:'Invalid service area'});
  if(!validText(data.email,200,5)|| !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return send(res,400,{error:'Please use a valid business email'});
  // Accept either a 10-digit US number or a +1-prefixed autofill value.
  const digits = limited(data.phone,30).replace(/\D/g,'');
  const nationalPhone = digits.length===11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if(!/^\d{10}$/.test(nationalPhone)) return send(res,400,{error:'Please use a valid 10-digit US phone number'});
  const normalizedPhone = '+1' + nationalPhone;
  if(data.consent !== true) return send(res,400,{error:'Contact permission is required'});
  if(data.website != null && !validText(data.website,250,0)) return send(res,400,{error:'Invalid website'});
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!url || !key) {
    console.error('Funnel application storage environment is not configured');
    return send(res,503,{error:'Application service unavailable'});
  }
  const isEdit = Boolean(data.submission_id || data.edit_token);
  const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(isEdit && (!uuidRx.test(data.submission_id||'') || !uuidRx.test(data.edit_token||''))) return send(res,400,{error:'Invalid edit session'});
  const submissionId = isEdit ? data.submission_id : randomUUID();
  const editToken = isEdit ? data.edit_token : randomUUID();
  const payload = {
    first_name:firstName,
    last_name:lastName||null,
    business_name:limited(data.business_name,150),
    email:limited(data.email,200).toLowerCase(),
    phone:normalizedPhone,
    service_area:serviceArea||null,
    website:data.website?limited(data.website,250):null,
    project_type:data.project_type??'junk_removal',monthly_revenue:data.monthly_revenue??null,monthly_inquiries:data.monthly_inquiries??null,readiness:data.readiness??null,
    biggest_gap:gaps[0],biggest_gaps:gaps,capacity:data.capacity??null,consent:true,source:'home_services_funnel',
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
        readiness: payload.readiness,
        readiness_text: {ready_now:'As soon as possible',within_30_days:'Within 30 days',one_to_three_months:'In 1–3 months',just_exploring:'Just exploring',need_details:'Open to learning more',not_ready:'Not ready right now'}[payload.readiness] || null,
        construction_type_text: {kitchens:'Kitchen Remodeling',bathrooms:'Bathroom Remodeling',both:'Kitchens & Bathrooms',roofing_siding:'Roofing / Siding',masonry_hardscaping:'Masonry / Hardscaping',interior_remodeling:'Interior Remodeling',hvac:'HVAC',other_home_service:'Other'}[payload.project_type] || null,
        service_business_type_text: {junk_removal:'Junk Removal',tree_service:'Tree Service',landscaping:'Landscaping / Lawn Care',hvac:'HVAC',plumbing:'Plumbing',electrical:'Electrical',roofing:'Roofing',remodeling:'Remodeling / Construction',cleaning:'Cleaning',painting:'Painting',auto_detailing:'Auto Detailing',pressure_washing:'Pressure Washing',restoration:'Restoration',pest_control:'Pest Control',garage_doors:'Garage Doors',other_service:'Other Service Business',kitchens:'Kitchen Remodeling',bathrooms:'Bathroom Remodeling',both:'Kitchens & Bathrooms',roofing_siding:'Roofing / Siding',masonry_hardscaping:'Masonry / Hardscaping',interior_remodeling:'Interior Remodeling',other_home_service:'Other Home Service'}[payload.project_type] || payload.project_type,
        remodeling_type_text: {kitchens:'Kitchen Remodeling',bathrooms:'Bathroom Remodeling',both:'Kitchens & Bathrooms'}[payload.project_type] || null,
        biggest_gap: payload.biggest_gap,
        biggest_gaps: payload.biggest_gaps,
        biggest_gaps_text: payload.biggest_gaps.join(', '),
        biggest_gap_display: {not_enough_leads:'Not enough leads or inquiries',missed_calls:'Missing incoming calls',slow_followup:'Slow lead follow-up',lead_quality:'Low-quality leads',low_conversion:'Not converting leads into customers',poor_follow_up:'Leads going cold',inconsistent_growth:'Inconsistent business growth',online_presence:'Weak online presence',operations:'Managing leads and operations',reviews:'Getting more reviews'}[payload.biggest_gap] || payload.biggest_gap,
        capacity: payload.capacity,
        consent: true,
        source: ['kitchens','bathrooms','both'].includes(payload.project_type) ? 'Ignite Kitchen & Bath Funnel' : 'Ignite Service Business Funnel',
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