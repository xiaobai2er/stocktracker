# 台股盤勢排名

這是無 build step 的靜態網站。頁面提供台灣上市、上櫃及興櫃市場的成交量與漲跌幅前五名，以及獨立期貨商品成交口數排行，可切換股票市場、漲幅／跌幅與盤前／盤中／盤後說明。

## 資料來源與計算

- 上市 TWSE：[`STOCK_DAY_ALL`](https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL)，使用 `Date`、`Code`、`Name`、`TradeVolume`、`ClosingPrice`、`Change`。
- 上櫃 TPEx：[`tpex_mainboard_daily_close_quotes`](https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes)，使用 `Date`、`SecuritiesCompanyCode`、`CompanyName`、`TradingShares`、`Close`、`Change`。
- 興櫃 TPEx：[`tpex_esb_latest_statistics`](https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics)，使用 `Date`、`SecuritiesCompanyCode`、`CompanyName`、`PreviousAveragePrice`、`Average`、`TransactionVolume`。興櫃是議價交易，漲跌幅按「日均價相對前日均價」計算；日均價缺值或前日均價為零時不列入漲跌幅排行。成交量統一以股數除以 1,000 換算成張數呈現。
- 上市／上櫃日行情會分別以 TWSE `t187ap03_L`、TPEx `mopsfin_t187ap03_O` 官方公司名單篩選代碼，排除 ETF、權證等非公司股票標的；興櫃來源為專屬興櫃股票行情端點。公司代碼清單和行情快照都在每次資料抓取時更新。
- 以上是官方最新日行情快照，不是逐筆或即時報價。若三個市場都有共同資料日，跨市場排名使用最新共同日；否則各市場使用自己的最新日期，並分別標示資料日，跨市場排名不代表同一交易日比較。歷史日期回查目前未支援。
- 期貨使用期交所 [`DailyMarketReportFut`](https://openapi.taifex.com.tw/v1/DailyMarketReportFut) 每日行情，按 `Contract` 加總最新資料日的所有 `ContractMonth(Week)` 與 `TradingSession` `Volume`（含一般及盤後時段），另列前五商品，不併入股票排名。此資料不是逐筆即時行情。若期貨端點抓取失敗，快照會保留錯誤欄位及空期貨清單，股票資料仍會部署並正常呈現。

## GitHub Pages

官方 API 沒有提供瀏覽器跨來源讀取所需的 CORS 標頭，因此 GitHub Actions 會在伺服器端抓取官方資料，產生同源的 `data/market.json`，再部署靜態頁面。Actions 排程為台灣時間平日 08:50、09:00–13:45 每 15 分鐘，以及 14:00；GitHub 排程可能延遲。頁面每 60 秒以時間戳 query parameter 和 `no-store` 檢查已部署快照；快照時間未變時不重繪排行。頁面的「更新資料」按鈕也只會重讀已部署快照，不會直接請求官方 API。檢查失敗會保留上次成功載入的畫面，並在下一個 60 秒週期重試。故此盤中資料不保證即時，實際行情時間依官方來源發布時間為準。

首次啟用：在 GitHub repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。之後 `main` 有 push、手動執行 workflow，或到排程時間時會抓取資料並部署。這份本機修改不會自動啟用 Pages，也不會推送或發布網站。

## 本機預覽

需使用 HTTP 伺服器以載入同源 JSON。先執行 `python scripts/fetch_market_data.py` 下載官方快照，再於 repo 根目錄執行 `python -m http.server 8000`，瀏覽 `http://localhost:8000`。也可以直接開啟 `index.html`，但瀏覽器可能會阻擋 `file://` 對本機 JSON 的讀取。

## Yahoo Finance 個股價格與漲跌幅

- 上市代碼加 `.TW`、上櫃及興櫃代碼加 `.TWO`，由 Yahoo Finance quote API 取最新可用價格、前收、漲跌額、漲跌幅與行情時間。官方成交量與期貨排行仍採原有 TWSE、TPEx、TAIFEX 日行情資料。
- Yahoo 官方交易所資料表列出台灣 TWSE（`.TW`）及 Taiwan OTC（`.TWO`）報價延遲 20 分鐘。興櫃亦以 `.TWO` 試取；是否有報價取決於 Yahoo 個別代碼收錄。取得 Yahoo 報價時以 Yahoo 價格和漲跌幅排序；缺漏時保留並標示官方最新收盤價／興櫃日均價與官方漲跌幅，故報價不完整時排行會混用來源。[Yahoo 交易所與資料延遲表](https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html)
- Yahoo 未提供穩定公開開發者 API 或服務保證；目前使用 Yahoo Finance 網站使用的 quote 介面，cookie、crumb、欄位或限流政策變動都可能令價格快照暫時失敗。這時官方成交量、期貨排行仍可使用。報價不代表即時行情，也不適合作為下單依據。
- Actions 約每 15 分鐘更新靜態快照；若部署自有 Cloudflare Worker，頁面每 60 秒可向 Worker 檢查最新 Yahoo 價格。Yahoo 資料本身約延遲 20 分鐘，因此 60 秒是頁面檢查頻率，不是即時行情或上游更新承諾。
- 此 repo 的 GitHub Actions runner 目前直連 Yahoo v7 quote 得到 HTTP 406；未設定自有 Worker 時，快照仍會發布官方行情，但 Yahoo 價格可能為零筆。頁面會明確顯示此狀態並回退顯示官方日行情。自有 Worker 的 v7 cookie/crumb 流程尚需在使用者 Cloudflare 帳戶部署後確認可否取得報價。

### Cloudflare Worker

Yahoo quote proxy 已暫時部署在 `https://stocktracker-yahoo-proxy.romantic-honey.workers.dev/quotes`，並設好 `ALLOWED_ORIGIN=https://xiaobai2er.github.io`。網站管理者已提供 Cloudflare claim link，請在連結有效期限內（60 分鐘）認領部署。前端 `config.js` 已指向此 Worker；瀏覽器請求由允許的 Pages origin 放行，不使用或暴露 `PROXY_TOKEN`。

頁面每 60 秒以最多 100 個代碼一批向 Worker 更新 Yahoo 報價；Actions 靜態快照仍會保存官方日行情，Yahoo 直連目前若回 HTTP 406，則快照中的 Yahoo 報價為空並由官方日價回退。認領後若 Worker URL 改變，請更新 `config.js` 的 `window.STOCKTRACKER_YAHOO_WORKER_URL` 並重新部署 Pages。Worker 原始碼仍在 `worker/yahoo-proxy.js`；如需改用自己的 Worker，請部署該檔並設定允許的 Pages origin。
