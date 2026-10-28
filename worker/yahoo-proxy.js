const API = 'https://query1.finance.yahoo.com/v8/finance/spark';
const US_SCREENER_API = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
const FLOW_API = 'https://stonk.ifan.tw/api/state';
const US_TECH_SCREEN_ID = 'sec-ind_sec-largest-equities_technology';
const MAX_SYMBOLS = 100;
const SPARK_SYMBOLS = 20;
const CACHE_SECONDS = 120;
const US_CACHE_SECONDS = 60;
const US_TECH_SCREEN_COUNT = 20;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const EXTRA_SYMBOLS = new Set(['^IXIC', '^GSPC', 'SOXX']);

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

async function fetchUSTech() {
  const url = new URL(US_SCREENER_API);
  for (const [key, value] of Object.entries({
    count: String(US_TECH_SCREEN_COUNT),
    start: '0',
    scrIds: US_TECH_SCREEN_ID,
    formatted: 'false',
    lang: 'en-US',
    region: 'US',
    corsDomain: 'finance.yahoo.com'
  })) url.searchParams.set(key, value);
  const upstream = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!upstream.ok) throw new Error(`Yahoo technology screener HTTP ${upstream.status}`);
  const payload = await upstream.json();
  const result = payload?.finance?.result?.[0];
  if (!Array.isArray(result?.quotes)) throw new Error('Yahoo technology screener returned no equity rows');
  const quotes = result.quotes.flatMap(row => {
    if (row?.quoteType !== 'EQUITY' || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(row.symbol || '')) return [];
    const cap = asNumber(row.marketCap);
    const marketState = row.marketState || '';
    const sessionPrice = marketState === 'PRE' ? asNumber(row.preMarketPrice)
      : marketState === 'POST' ? asNumber(row.postMarketPrice)
      : null;
    const sessionChange = marketState === 'PRE' ? asNumber(row.preMarketChange)
      : marketState === 'POST' ? asNumber(row.postMarketChange)
      : null;
    const sessionChangePercent = marketState === 'PRE' ? asNumber(row.preMarketChangePercent)
      : marketState === 'POST' ? asNumber(row.postMarketChangePercent)
      : null;
    const price = sessionPrice ?? asNumber(row.regularMarketPrice);
    const change = sessionChange ?? asNumber(row.regularMarketChange);
    const changePercent = sessionChangePercent ?? asNumber(row.regularMarketChangePercent);
    const volume = asNumber(row.regularMarketVolume);
    if (cap === null || price === null || changePercent === null || volume === null || price <= 5) return [];
    return [{
      symbol: row.symbol,
      name: row.shortName || row.longName || row.symbol,
      exchange: row.fullExchangeName || row.exchange || '',
      marketCap: cap,
      price,
      previousClose: asNumber(row.regularMarketPreviousClose),
      change,
      changePercent,
      volume,
      marketTime: marketState === 'PRE' ? asNumber(row.preMarketTime)
        : marketState === 'POST' ? asNumber(row.postMarketTime)
        : asNumber(row.regularMarketTime),
      delayedMinutes: asNumber(row.exchangeDataDelayedBy),
      marketState,
      quoteSourceName: row.quoteSourceName || 'Yahoo Finance'
    }];
  });
  quotes.sort((a, b) => b.marketCap - a.marketCap);
  return { total: asNumber(result.total) ?? quotes.length, title: result.title || 'Largest Companies In The Technology Sector', stocks: quotes.slice(0, 20) };
}

async function fetchUSTechPayload() {
  const result = await fetchUSTech();
  const rows = result.stocks;
  const marketTimes = rows.map(row => row.marketTime).filter(Boolean);
  const delayValues = rows.map(row => row.delayedMinutes).filter(Number.isFinite);
  return {
    ...result,
    marketTime: marketTimes.length ? Math.max(...marketTimes) : null,
    delayMin: delayValues.length ? Math.min(...delayValues) : null,
    delayMax: delayValues.length ? Math.max(...delayValues) : null,
    fetchedAt: new Date().toISOString(),
    source: 'Yahoo Finance predefined technology screener',
    filters: 'US Technology sector; share price above $5; sorted by market capitalization'
  };
}

async function fetchOutflowPayload() {
  const upstream = await fetch(FLOW_API, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!upstream.ok) throw new Error(`Market flow source HTTP ${upstream.status}`);
  const payload = await upstream.json();
  const flow = payload?.flow;
  if (!Array.isArray(flow?.top_out)) throw new Error('Market flow source returned no outflow rows');
  return {
    stocks: flow.top_out.filter(row => Number.isFinite(row?.flow) && row.flow < 0).slice(0, 10),
    updatedAt: flow.last_update,
    marketOpen: Boolean(flow.market_open),
    source: 'STONK / IFAN',
    methodology: 'Intraday turnover increments weighted by price direction; an estimate, not actual institutional flow'
  };
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
    if (url.pathname.replace(/\/$/, '') === '/flow') {
      try {
        return response(await fetchOutflowPayload(), 200, request, env, 'public, max-age=15');
      } catch (error) {
        return response({ error: String(error.message || error), stocks: [] }, 502, request, env);
      }
    }
    if (url.pathname.replace(/\/$/, '') === '/us-tech') {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const cacheKey = new Request(`${url.origin}/_cache/us-tech-v1`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached && !forceRefresh) return response(await cached.json(), 200, request, env, `public, max-age=${US_CACHE_SECONDS}`);
      try {
        const payload = await fetchUSTechPayload();
        const cachedResponse = new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${US_CACHE_SECONDS}` }
        });
        ctx.waitUntil(cache.put(cacheKey, cachedResponse));
        return response(payload, 200, request, env, `public, max-age=${US_CACHE_SECONDS}`);
      } catch (error) {
        return response({ error: String(error.message || error), stocks: [] }, 502, request, env);
      }
    }
    if (url.pathname.replace(/\/$/, '') !== '/quotes') return response({ error: 'Use /quotes?symbols=...' }, 404, request, env);
    const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length || symbols.length > MAX_SYMBOLS || symbols.some(x => !(/^[A-Z0-9]{2,8}\.(TW|TWO)$/.test(x) || EXTRA_SYMBOLS.has(x)))) {
      return response({ error: `Provide 1-${MAX_SYMBOLS} valid .TW/.TWO symbols or supported market symbols` }, 400, request, env);
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
