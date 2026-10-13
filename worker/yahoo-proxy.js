const API = 'https://query1.finance.yahoo.com/v8/finance/spark';
const MAX_SYMBOLS = 100;
const SPARK_SYMBOLS = 20;
const CACHE_SECONDS = 120;
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

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeQuote(symbol, row) {
  const price = asNumber(row?.fulldayPrice) ?? asNumber(row?.close?.at(-1));
  const previousClose = asNumber(row?.previousClose) ?? asNumber(row?.chartPreviousClose);
  if (price === null || previousClose === null || previousClose === 0) return null;
  const change = asNumber(row?.fulldayChange) ?? price - previousClose;
  const changePercent = asNumber(row?.fulldayChangePercent) ?? change / previousClose * 100;
  const marketTime = asNumber(row?.timestamp?.at(-1)) ?? asNumber(row?.end);
  return {
    symbol,
    price,
    previousClose,
    change,
    changePercent,
    marketTime,
    exchange: symbol.endsWith('.TW') ? 'TWSE' : 'TWO',
    quoteSourceName: 'Yahoo Finance Spark'
  };
}

async function fetchSparkBatch(symbols) {
  const url = new URL(API);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('range', '1d');
  // Daily interval retains Yahoo's full-day price/change fields with a much
  // smaller response than an intraday candle series.
  url.searchParams.set('interval', '1d');
  const upstream = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!upstream.ok) throw new Error(`Yahoo Spark HTTP ${upstream.status}`);
  const payload = await upstream.json();
  return Object.entries(payload).flatMap(([symbol, row]) => {
    const quote = normalizeQuote(symbol, row);
    return quote ? [quote] : [];
  });
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
    const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length || symbols.length > MAX_SYMBOLS || symbols.some(x => !/^[A-Z0-9]{2,8}\.(TW|TWO)$/.test(x))) {
      return response({ error: `Provide 1-${MAX_SYMBOLS} valid .TW/.TWO symbols` }, 400, request, env);
    }

    const cacheKey = new Request(`${url.origin}/_cache/quotes/${encodeURIComponent(symbols.join(','))}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return response(await cached.json(), 200, request, env, `public, max-age=${CACHE_SECONDS}`);

    const quotes = [];
    const errors = [];
    // Yahoo Spark accepts at most 20 valid symbols per request. With the API's
    // 100-symbol worker limit, this uses at most five outbound subrequests.
    for (let start = 0; start < symbols.length; start += SPARK_SYMBOLS) {
      const batch = symbols.slice(start, start + SPARK_SYMBOLS);
      try {
        quotes.push(...await fetchSparkBatch(batch));
      } catch (error) {
        errors.push(`symbols ${start + 1}-${start + batch.length}: ${String(error.message || error)}`);
      }
    }

    if (!quotes.length && errors.length) return response({ error: errors.join('; '), quotes: [] }, 502, request, env);
    const payload = { quotes, fetchedAt: new Date().toISOString(), ...(errors.length ? { errors } : {}) };
    const cachedResponse = new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
    });
    ctx.waitUntil(cache.put(cacheKey, cachedResponse));
    return response(payload, 200, request, env, `public, max-age=${CACHE_SECONDS}`);
  }
};
