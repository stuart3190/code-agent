import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {Readable, pipeline} from 'node:stream';
import {createGunzip, createInflate, createBrotliDecompress} from 'node:zlib';

// Internal transport: callers must supply their validated DNS snapshot. HTTPS
// still verifies the original hostname; only connection address selection is pinned.
export function pinnedHttpsTransport(url, init = {}, {addresses, requestImpl = httpsRequest} = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('HTTPS URL required');
  const pinned = (addresses || []).map(row => ({address:row.address, family:isIP(row.address)}));
  if (!pinned.length || pinned.some(row => !row.family)) throw new Error('Validated DNS addresses required');
  if (init.body != null && typeof init.body !== 'string' && !ArrayBuffer.isView(init.body)) throw new Error('Unsupported runtime request body');
  const headers = new Headers(init.headers);
  headers.set('host', target.host); // URL authority also governs TLS identity.
  if (!headers.has('accept-encoding')) headers.set('accept-encoding','identity');
  return new Promise((resolve,reject) => {
    const req = requestImpl(target, {
      method:init.method || 'GET', headers:Object.fromEntries(headers), signal:init.signal,
      // Never reuse a global-agent socket or consult proxy/environment routing.
      agent:false,
      lookup(host, options, callback) {
        if (host.toLowerCase() !== target.hostname.toLowerCase()) return callback(new Error('Unexpected DNS hostname'));
        const selected = options?.family ? pinned.filter(row=>row.family===Number(options.family)) : pinned;
        if (!selected.length) return callback(new Error('No validated address for requested family'));
        if (options?.all) callback(null,selected.map(row=>({...row})));
        else callback(null,selected[0].address,selected[0].family);
      },
    }, incoming => {
      try {
        const responseHeaders = new Headers();
        for (let i=0;i<incoming.rawHeaders.length;i+=2) responseHeaders.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        const status = incoming.statusCode;
        const empty = init.method === 'HEAD' || [204,205,304].includes(status);
        let stream = incoming;
        if (empty) incoming.resume();
        else {
          const encoding = String(responseHeaders.get('content-encoding') || '').trim().toLowerCase();
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
            : encoding === 'br' ? createBrotliDecompress() : null;
          if (encoding && encoding !== 'identity' && !decoder) throw new Error('Unsupported runtime response encoding');
          if (decoder) { pipeline(incoming,decoder,()=>{});stream=decoder; }
        }
        const response = new Response(empty ? null : Readable.toWeb(stream), {status,statusText:incoming.statusMessage,headers:responseHeaders});
        Object.defineProperty(response,'url',{value:target.href});
        resolve(response);
      } catch(error) {incoming.destroy();reject(error);}
    });
    req.on('error',reject);
    req.end(init.body ?? undefined);
  });
}
