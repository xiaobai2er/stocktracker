"""Download official Taiwan exchange snapshots for same-origin static hosting."""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


SOURCES = {
    "listed": "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    "otc": "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
    "emerging": "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics",
    "listedCompanies": "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
    "otcCompanies": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
}
FUTURES_SOURCE = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"


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


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "data/market.json")
    source_data = {key: get_json(url) for key, url in SOURCES.items()}
    listed_codes = {str(row.get("公司代號", "")).strip() for row in source_data["listedCompanies"]}
    otc_codes = {str(row.get("SecuritiesCompanyCode", "")).strip() for row in source_data["otcCompanies"]}
    source_data["listed"] = [row for row in source_data["listed"] if str(row.get("Code", "")).strip() in listed_codes]
    source_data["otc"] = [row for row in source_data["otc"] if str(row.get("SecuritiesCompanyCode", "")).strip() in otc_codes]
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
    snapshot["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Saved official market snapshot: {output} ({snapshot['fetchedAt']})")


if __name__ == "__main__":
    main()
