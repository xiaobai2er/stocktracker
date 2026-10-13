"""Download official Taiwan exchange snapshots for same-origin static hosting."""

import json
import os
import sys
import time
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl
from urllib.request import Request, build_opener, HTTPCookieProcessor, urlopen


SOURCES = {
    "listed": "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    "otc": "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
    "emerging": "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics",
    "listedCompanies": "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
    "otcCompanies": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
}
FUTURES_SOURCE = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"
YAHOO_CRUMB_SOURCE = "https://query1.finance.yahoo.com/v1/test/getcrumb"
YAHOO_QUOTE_SOURCE = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_BATCH_SIZE = 100
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"


def get_json(url: str) -> list:
    for attempt in range(3):
        request = Request(
            url,
            headers={
                "User-Agent": "stocktracker-market-brief/1.0",
                "Accept": "application/json",
                "Accept-Encoding": "identity",
            },
        )
        try:
            with urlopen(request, timeout=45) as response:
                payload = json.loads(response.read())
            if not isinstance(payload, list):
                raise ValueError(f"Expected a JSON array from {url}")
            return payload
        except Exception as error:
            if attempt == 2:
                raise RuntimeError(f"Official endpoint failed after 3 attempts: {url}: {error}") from error
            print(f"Request attempt {attempt + 1} failed for {url}; retrying: {error}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"Could not fetch {url}")


def yahoo_request_json(opener, url: str, token: str = "") -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    with opener.open(request, timeout=30) as response:
        payload = json.loads(response.read())
    if not isinstance(payload, dict):
        raise ValueError("Expected a Yahoo quote JSON object")
    return payload


def add_query(url: str, params: dict) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update(params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def extract_quote_rows(payload: dict) -> list:
    if isinstance(payload.get("quotes"), list):
        return payload["quotes"]
    return payload.get("quoteResponse", {}).get("result", [])


def fetch_yahoo_quotes(symbols: list[str]) -> tuple[dict, str]:
    """Fetch Yahoo delayed quotes in batches. A configured Worker URL is optional."""
    proxy_url = os.environ.get("YAHOO_PROXY_URL", "").strip()
    proxy_token = os.environ.get("YAHOO_PROXY_TOKEN", "").strip()
    quote_map = {}
    errors = []

    if proxy_url:
        opener = build_opener()
        crumb = ""
    else:
        jar = CookieJar()
        opener = build_opener(HTTPCookieProcessor(jar))
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        # Yahoo currently issues the cookie/crumb pair used by its quote endpoint.
        try:
            opener.open(Request("https://fc.yahoo.com", headers=headers), timeout=20).read()
        except Exception:
            # fc.yahoo.com commonly responds with HTTP 404 while setting cookies.
            pass
        with opener.open(Request(YAHOO_CRUMB_SOURCE, headers=headers), timeout=20) as response:
            crumb = response.read().decode("utf-8").strip()
        if not crumb:
            return {}, "Yahoo Finance did not provide an API crumb"

    for start in range(0, len(symbols), YAHOO_BATCH_SIZE):
        batch = symbols[start : start + YAHOO_BATCH_SIZE]
        if proxy_url:
            url = add_query(proxy_url.rstrip("/"), {"symbols": ",".join(batch)})
        else:
            url = add_query(YAHOO_QUOTE_SOURCE, {"symbols": ",".join(batch), "crumb": crumb})
        try:
            payload = yahoo_request_json(opener, url, proxy_token)
            rows = extract_quote_rows(payload)
            if not rows and payload.get("quoteResponse", {}).get("error"):
                raise RuntimeError(str(payload["quoteResponse"]["error"]))
            for quote in rows:
                symbol = str(quote.get("symbol", "")).strip()
                price = quote.get("regularMarketPrice")
                previous = quote.get("regularMarketPreviousClose")
                change = quote.get("regularMarketChange")
                pct = quote.get("regularMarketChangePercent")
                if not symbol or not isinstance(price, (int, float)):
                    continue
                quote_map[symbol] = {
                    "price": price,
                    "previousClose": previous,
                    "change": change,
                    "changePercent": pct,
                    "marketTime": quote.get("regularMarketTime"),
                    "exchange": quote.get("exchange"),
                    "quoteSourceName": quote.get("quoteSourceName"),
                }
        except Exception as error:
            errors.append(f"batch {start // YAHOO_BATCH_SIZE + 1}: {error}")
            print(f"Warning: Yahoo quote batch failed ({start + 1}-{start + len(batch)}): {error}", flush=True)
        if start + YAHOO_BATCH_SIZE < len(symbols):
            time.sleep(0.25)

    return quote_map, "; ".join(errors)


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "data/market.json")
    source_data = {key: get_json(url) for key, url in SOURCES.items()}
    listed_codes = {str(row.get("公司代號", "")).strip() for row in source_data["listedCompanies"]}
    otc_codes = {str(row.get("SecuritiesCompanyCode", "")).strip() for row in source_data["otcCompanies"]}
    source_data["listed"] = [row for row in source_data["listed"] if str(row.get("Code", "")).strip() in listed_codes]
    source_data["otc"] = [row for row in source_data["otc"] if str(row.get("SecuritiesCompanyCode", "")).strip() in otc_codes]
    yahoo_symbols = sorted({
        f"{str(row.get('Code', '')).strip()}.TW" for row in source_data["listed"] if str(row.get("Code", "")).strip()
    } | {
        f"{str(row.get('SecuritiesCompanyCode', '')).strip()}.TWO" for row in source_data["otc"] if str(row.get("SecuritiesCompanyCode", "")).strip()
    } | {
        f"{str(row.get('SecuritiesCompanyCode', '')).strip()}.TWO" for row in source_data["emerging"] if str(row.get("SecuritiesCompanyCode", "")).strip()
    })
    snapshot = {
        "listed": source_data["listed"],
        "otc": source_data["otc"],
        "emerging": source_data["emerging"],
    }
    snapshot["futures"] = []
    snapshot["futuresError"] = None
    try:
        snapshot["futures"] = get_json(FUTURES_SOURCE)
    except Exception as error:
        snapshot["futuresError"] = str(error)
        print(f"Warning: futures endpoint unavailable; keeping stock snapshot: {error}", flush=True)
    try:
        snapshot["yahooQuotes"], snapshot["yahooError"] = fetch_yahoo_quotes(yahoo_symbols)
    except Exception as error:
        # Yahoo's unofficial quote API must never block the official market snapshot.
        snapshot["yahooQuotes"] = {}
        snapshot["yahooError"] = f"Yahoo quote fetch failed: {type(error).__name__}: {error}"
        print(f"Warning: Yahoo quote setup failed; keeping official market data: {error}", flush=True)
    snapshot["yahooFetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    snapshot["yahooQuoteCount"] = len(snapshot["yahooQuotes"])
    snapshot["yahooSymbolCount"] = len(yahoo_symbols)
    snapshot["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Saved official market snapshot: {output} ({snapshot['fetchedAt']})")


if __name__ == "__main__":
    main()
