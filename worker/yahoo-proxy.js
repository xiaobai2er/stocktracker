const API = 'https://query1.finance.yahoo.com';
const MAX_SYMBOLS = 100;
const CACHE_SECONDS = 60;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function unauthorized(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return false;
  if (!env.PROXY_TOKEN) return false;
  return request.headers.get('Authorization') !== `Bearer ${env.PROXY_TOKEN}`;
}

function response(payload, status, request, env, cache = 'no-store') {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || allowed;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(allowed === '*' || origin === allowed ? origin : allowed),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache
    }
  });
}

function cookieHeader(headers) {
  const getSetCookie = headers.getSetCookie?.bind(headers);
  const values = getSetCookie ? getSetCookie() : [headers.get('Set-Cookie') || ''];
  return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

async function fetchYahoo(symbols) {
  const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
  let cookies = '';
  try {
    const cookieResponse = await fetch('https://fc.yahoo.com', { headers, redirect: 'manual' });
    cookies = cookieHeader(cookieResponse.headers);
  } catch (_) {
    // Yahoo may issue the cookies with a 404 response; the crumb request is still attempted.
  }
  const crumbResponse = await fetch(`${API}/v1/test/getcrumb`, {
    headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) }
  });
  if (!crumbResponse.ok) throw new Error(`Yahoo crumb HTTP ${crumbResponse.status}`);
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb) throw new Error('Yahoo did not return an API crumb');
  const crumbCookies = cookieHeader(crumbResponse.headers);
  if (crumbCookies) cookies = [cookies, crumbCookies].filter(Boolean).join('; ');
  const url = new URL(`${API}/v7/finance/quote`);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('crumb', crumb);
  const quoteResponse = await fetch(url, {
    headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) }
  });
  if (!quoteResponse.ok) throw new Error(`Yahoo quote HTTP ${quoteResponse.status}`);
  const payload = await quoteResponse.json();
  if (payload.quoteResponse?.error) throw new Error('Yahoo returned a quote error');
  return (payload.quoteResponse?.result || []).map(quote => ({
    symbol: quote.symbol,
    price: quote.regularMarketPrice ?? null,
    previousClose: quote.regularMarketPreviousClose ?? null,
    change: quote.regularMarketChange ?? null,
    changePercent: quote.regularMarketChangePercent ?? null,
    marketTime: quote.regularMarketTime ?? null,
    exchange: quote.exchange ?? null,
    quoteSourceName: quote.quoteSourceName ?? null
  }));
}

export default {
  async fetch(request, env, ctx) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
    }
    if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405, request, env);
    if (unauthorized(request, env)) return response({ error: 'Unauthorized' }, 401, request, env);

    const url = new URL(request.url);
    if (url.pathname.replace(/\/$/, '') !== '/quotes') return response({ error: 'Use /quotes?symbols=...' }, 404, request, env);
    const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map(x => x.trim()).filter(Boolean))];
    if (!symbols.length || symbols.length > MAX_SYMBOLS || symbols.some(x => !/^[A-Z0-9]{2,8}\.(TW|TWO)$/i.test(x))) {
      return response({ error: `Provide 1-${MAX_SYMBOLS} valid .TW/.TWO symbols` }, 400, request, env);
    }

    const cacheKey = new Request(`${url.origin}/_cache/quotes/${encodeURIComponent(symbols.join(','))}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      return response(body, 200, request, env, `public, max-age=${CACHE_SECONDS}`);
    }
    try {
      const payload = { quotes: await fetchYahoo(symbols), fetchedAt: new Date().toISOString() };
      const cachedResponse = new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
      });
      ctx.waitUntil(cache.put(cacheKey, cachedResponse));
      return response(payload, 200, request, env, `public, max-age=${CACHE_SECONDS}`);
    } catch (error) {
      return response({ error: String(error.message || error) }, 502, request, env);
    }
  }
};
