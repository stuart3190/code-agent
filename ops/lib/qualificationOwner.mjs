// Operator qualification must never borrow whichever customer's credential was updated last.
export async function resolveQualificationOwner({client,requestedOwner,retainedOwner=null}) {
  const normalize=value=>String(value||'').trim().toLowerCase();
  const requested=normalize(requestedOwner),retained=normalize(retainedOwner);
  if(requested&&retained&&requested!==retained)throw new Error('Qualification owner differs from the retained evidence owner');
  const owner=requested||retained;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner)) {
    throw new Error('Set THRALLO_QUALIFICATION_OWNER to the authorized account UUID before starting qualification');
  }
  const read=async(query,label)=>{const result=await query;if(result.error)throw new Error(`${label}: ${result.error.message}`);return result.data};
  const preference=await read(client.from('ca_ai_preferences').select('owner,active_provider,routing_mode,preferred_model')
    .eq('owner',owner).maybeSingle(),'Qualification preference');
  if(!preference||normalize(preference.owner)!==owner||preference.active_provider!=='codex')throw new Error('The selected qualification account must have Codex active');
  const credential=await read(client.from('ca_ai_credentials').select('owner,status,provider,auth_mode')
    .eq('owner',owner).eq('provider','codex').eq('status','connected').maybeSingle(),'Qualification credential');
  if(!credential||normalize(credential.owner)!==owner||credential.provider!=='codex'||credential.status!=='connected')throw new Error('The selected qualification account needs its own connected Codex credential');
  return {owner,preference,credential};
}
