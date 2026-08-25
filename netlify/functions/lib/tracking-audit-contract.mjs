export const AUDIT_INDUSTRIES = ["professional_services","education_training","ecommerce_dtc","real_estate","other"];
export const AUDIT_ROLES = ["founder_ceo","marketing_lead","growth_performance","operations_commercial","other"];
export const AUDIT_DECISION_INFLUENCE = ["final_decision_maker","strong_influence","contributor","researching"];
export const AUDIT_AD_SPEND_BANDS = ["paused_or_not_spending","under_1500","1500_2999","3000_5999","6000_14999","15000_plus","not_sure"];
export const AUDIT_PAID_CHANNELS = ["meta_ads","google_ads","microsoft_ads","linkedin_ads","tiktok_ads","other","none_currently"];
export const AUDIT_TRACKING_MATURITY = ["not_sure","basic","partial","disconnected","confident"];
export const AUDIT_PRIMARY_CONVERSIONS = ["lead_form","booked_call_appointment","whatsapp_message","ecommerce_purchase","application_enrolment","other"];
export const AUDIT_MEASUREMENT_PROBLEMS = ["unclear_campaign_performance","conflicting_numbers","missing_conversion_tracking","leads_without_attribution","browser_server_signal_gap","other"];
export const AUDIT_URGENCY = ["before_scaling","within_30_days","one_to_three_months","exploring"];

const asTrimmedString = (value) => typeof value === "string" ? value.trim() : "";
const unique = (values) => [...new Set(values)];
const LEGACY_CHANNEL_MAP = {
  "Meta Ads":"meta_ads",
  "Google Ads":"google_ads",
  "Microsoft Ads":"microsoft_ads",
  "LinkedIn Ads":"linkedin_ads",
  "TikTok Ads":"tiktok_ads",
  Other:"other",
  "None currently":"none_currently",
};
const canonicalSet = (values) => new Set(values);
const INDUSTRIES=canonicalSet(AUDIT_INDUSTRIES),ROLES=canonicalSet(AUDIT_ROLES),DECISIONS=canonicalSet(AUDIT_DECISION_INFLUENCE),SPEND_BANDS=canonicalSet(AUDIT_AD_SPEND_BANDS),CHANNELS=canonicalSet(AUDIT_PAID_CHANNELS),MATURITY=canonicalSet(AUDIT_TRACKING_MATURITY),CONVERSIONS=canonicalSet(AUDIT_PRIMARY_CONVERSIONS),PROBLEMS=canonicalSet(AUDIT_MEASUREMENT_PROBLEMS),URGENCY=canonicalSet(AUDIT_URGENCY);

export const normalizeAuditChannels = (value) => {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]+/) : [];
  return unique(raw.map(asTrimmedString).filter(Boolean).map((item)=>CHANNELS.has(item)?item:LEGACY_CHANNEL_MAP[item]||"").filter(Boolean));
};

const hasCanonicalFields=(data)=>["company","industry","role","decisionInfluence","trackingMaturity","primaryConversionType","measurementProblem","urgency"].every((key)=>asTrimmedString(data[key]).length>0)&&(asTrimmedString(data.monthlyAdSpendBand).length>0||asTrimmedString(data.monthlyAdSpend).length>0);

export const normalizeTrackingAuditApplication=(input)=>{
  if(!input||typeof input!=="object")return{ok:false,errors:["invalid_payload"]};
  const data=input;
  const websiteUrl=asTrimmedString(data.websiteUrl),company=asTrimmedString(data.company),channels=normalizeAuditChannels(data.adPlatforms),canonical=hasCanonicalFields(data);
  if(!websiteUrl)return{ok:false,errors:["websiteUrl"]};
  if(!canonical){
    const legacySpend=asTrimmedString(data.monthlyAdSpend);
    if(!legacySpend||channels.length===0)return{ok:false,errors:[!legacySpend?"monthlyAdSpend":"",channels.length===0?"adPlatforms":""].filter(Boolean)};
    return{ok:true,value:{mode:"legacy",company,websiteUrl,industry:"",role:"",decisionInfluence:"",monthlyAdSpendBand:"",legacyMonthlyAdSpend:legacySpend,adPlatforms:channels,trackingMaturity:"",primaryConversionType:"",measurementProblem:"",urgency:""}};
  }
  const industry=asTrimmedString(data.industry),role=asTrimmedString(data.role),decisionInfluence=asTrimmedString(data.decisionInfluence),monthlyAdSpendBand=asTrimmedString(data.monthlyAdSpendBand)||asTrimmedString(data.monthlyAdSpend),trackingMaturity=asTrimmedString(data.trackingMaturity),primaryConversionType=asTrimmedString(data.primaryConversionType),measurementProblem=asTrimmedString(data.measurementProblem),urgency=asTrimmedString(data.urgency);
  const errors=[!company?"company":"",!INDUSTRIES.has(industry)?"industry":"",!ROLES.has(role)?"role":"",!DECISIONS.has(decisionInfluence)?"decisionInfluence":"",!SPEND_BANDS.has(monthlyAdSpendBand)?"monthlyAdSpendBand":"",channels.length===0?"adPlatforms":"",!MATURITY.has(trackingMaturity)?"trackingMaturity":"",!CONVERSIONS.has(primaryConversionType)?"primaryConversionType":"",!PROBLEMS.has(measurementProblem)?"measurementProblem":"",!URGENCY.has(urgency)?"urgency":""].filter(Boolean);
  if(errors.length)return{ok:false,errors};
  return{ok:true,value:{mode:"canonical",company,websiteUrl,industry,role,decisionInfluence,monthlyAdSpendBand,legacyMonthlyAdSpend:"",adPlatforms:channels,trackingMaturity,primaryConversionType,measurementProblem,urgency}};
};

export const auditLifecycleAttributes=(audit,timestamp)=>({
  ...(audit.company?{COMPANY:audit.company}:{}),
  WEBSITE_URL:audit.websiteUrl,
  ...(audit.industry?{AUDIT_INDUSTRY:audit.industry}:{}),
  ...(audit.role?{AUDIT_ROLE:audit.role}:{}),
  ...(audit.decisionInfluence?{AUDIT_DECISION_INFLUENCE:audit.decisionInfluence}:{}),
  ...(audit.monthlyAdSpendBand?{AUDIT_AD_SPEND_BAND:audit.monthlyAdSpendBand}:{}),
  ...(audit.adPlatforms.length?{AUDIT_PAID_CHANNELS:audit.adPlatforms}:{}),
  ...(audit.trackingMaturity?{AUDIT_TRACKING_MATURITY:audit.trackingMaturity}:{}),
  ...(audit.primaryConversionType?{AUDIT_PRIMARY_CONVERSION:audit.primaryConversionType}:{}),
  ...(audit.measurementProblem?{AUDIT_MEASUREMENT_PROBLEM:audit.measurementProblem}:{}),
  ...(audit.urgency?{AUDIT_URGENCY:audit.urgency}:{}),
  AUDIT_STATUS:audit.mode==="canonical"?"Applied":"Manual Review",
  AUDIT_HANDOFF_STATUS:"No Sales Handoff",
  AUDIT_APPLIED_AT:timestamp,
  ...(audit.mode==="legacy"?{AUDIT_REVIEW_OUTCOME:"Manual Review",AUDIT_REVIEW_RATIONALE:"Legacy pre-v1.0 Tracking Audit application payload; structured qualification fields require review."}:{}),
});
