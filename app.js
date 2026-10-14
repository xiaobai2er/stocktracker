const $ = (s) => document.querySelector(s);
const state = { rows: [], sourceRows: { listed: [], otc: [], emerging: [] }, dates: { listed: [], otc: [], emerging: [] }, yahooQuotes: {}, yahooError: null, yahooFetchedAt: null, usRankings: { volume: [], gainers: [], losers: [] }, usRows: [], usTotals: {}, usFetchedAt: null, usMarketTime: null, usMarketState: null, usDelayMin: null, usDelayMax: null, usError: null, market: 'all', direction: 'up', session: 'post', stamp: null, commonDate: false, fetchedAt: null, lastSuccessAt: null };
const fmt = new Intl.NumberFormat('zh-TW');
let loadPromise = null;
let workerQuotePromise = null;

function taipeiNow(){ return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei'})); }
function dateStamp(d){ return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function formatDate(raw){
  if(!raw) return '—'; let s=String(raw).trim();
  if(/^\d{7}$/.test(s)){const y=Number(s.slice(0,3))+1911; return `${y}/${s.slice(3,5)}/${s.slice(5,7)}`;}
  if(/^\d{8}$/.test(s)) return `${s.slice(0,4)}/${s.slice(4,6)}/${s.slice(6,8)}`;
  const m=s.match(/^(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})$/);if(m){const y=Number(m[1])<1911?Number(m[1])+1911:Number(m[1]);return `${y}/${m[2].padStart(2,'0')}/${m[3].padStart(2,'0')}`;}
  const d=new Date(s); return Number.isNaN(+d)?s:`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function dateKey(raw){
  const s=String(raw??'').trim();
  if(/^\d{7}$/.test(s)) return String(Number(s.slice(0,3))+1911)+s.slice(3);
  if(/^\d{8}$/.test(s)) return s;
  const m=s.match(/^(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if(m){const year=Number(m[1])<1911?Number(m[1])+1911:Number(m[1]);return `${year}${m[2].padStart(2,'0')}${m[3].padStart(2,'0')}`;}
  const d=new Date(s);return Number.isNaN(+d)?'':`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function num(v){ if(typeof v==='number') return v; const s=String(v??'').replace(/[,+\s]/g,'').trim(); if(!s||s==='--'||s==='X'||s==='除權息') return null; const n=Number(s); return Number.isFinite(n)?n:null; }
function clean(v){ return String(v??'').trim(); }
function normalizeTwse(x){
  const volume=num(x.TradeVolume ?? x.TradingVolume ?? x.TradeShares); const close=num(x.ClosingPrice ?? x.Close); const change=num(x.Change);
  if(!volume || close===null) return null;
  const prev=change===null?null:close-change; return {code:clean(x.Code),name:clean(x.Name),volume:volume/1000,close,change,pct:prev>0?change/prev*100:null,market:'listed',date:clean(x.Date)};
}
function normalizeTpex(x){
  const volume=num(x.TradingShares ?? x.TradeVolume); const close=num(x.Close ?? x.ClosingPrice); const change=num(x.Change);
  if(!volume || close===null) return null;
  const prev=change===null?null:close-change; return {code:clean(x.SecuritiesCompanyCode ?? x.Code),name:clean(x.CompanyName ?? x.Name),volume:volume/1000,close,change,pct:prev>0?change/prev*100:null,market:'otc',date:clean(x.Date)};
}
function normalizeEmerging(x){
  const volume=num(x.TransactionVolume);const average=num(x.Average);const previousAverage=num(x.PreviousAveragePrice);
  if(volume===null||average===null) return null;
  const change=previousAverage!==null?average-previousAverage:null;
  const pct=previousAverage?change/previousAverage*100:null;
  return {code:clean(x.SecuritiesCompanyCode),name:clean(x.CompanyName),volume:volume/1000,close:average,change,pct,market:'emerging',date:clean(x.Date),priceBasis:'日均價'};
}
async function fetchJson(url){
  const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();
}
function taipeiTime(value){return value?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';}
function freshnessNote(){return state.market==='us'?'Yahoo 美股報價依交易所延遲約 15–20 分鐘；頁面每 60 秒檢查一次。':'Yahoo 台股報價約延遲 20 分鐘；頁面每 60 秒自動檢查，Actions 快照約每 15 分鐘更新。';}
function quoteSymbol(row){return `${row.code}.${row.market==='listed'?'TW':'TWO'}`;}
function applyYahooQuotes(quotes){
  state.yahooQuotes=quotes||{};
  for(const rows of Object.values(state.sourceRows)) for(const row of rows){
    row.dailyClose??=row.close;
    row.dailyChange??=row.change;
    row.dailyPct??=row.pct;
    const quote=state.yahooQuotes[quoteSymbol(row)];
    row.yahooAvailable=Boolean(quote&&num(quote.price)!==null&&num(quote.changePercent)!==null);
    row.close=row.yahooAvailable?num(quote.price):row.dailyClose;
    row.change=row.yahooAvailable?num(quote.change):row.dailyChange;
    row.pct=row.yahooAvailable?num(quote.changePercent):row.dailyPct;
    row.quoteTime=row.yahooAvailable?num(quote.marketTime):null;
  }
  const times=Object.values(state.yahooQuotes).map(q=>num(q?.marketTime)).filter(Boolean);
  const latest=times.length?Math.max(...times):null;
  const count=Object.values(state.sourceRows).flat().filter(row=>row.yahooAvailable).length;
  $('#quoteUpdateTime').textContent=latest?`Yahoo 最新報價時間：${taipeiTime(new Date(latest*1000).toISOString())}（台北）；${count.toLocaleString()} 檔成功`:'Yahoo 報價未取得；目前保留官方最新日價格與漲跌幅';
}
async function refreshWorkerQuotes(){
  const base=String(window.STOCKTRACKER_YAHOO_WORKER_URL||'').trim();
  if(!base||!state.fetchedAt||workerQuotePromise)return workerQuotePromise;
  const symbols=[...new Set(Object.values(state.sourceRows).flat().map(quoteSymbol))];
  if(!symbols.length)return;
  workerQuotePromise=(async()=>{
    const fresh={};
    for(let i=0;i<symbols.length;i+=100){
      const url=new URL(base,location.href);url.searchParams.set('symbols',symbols.slice(i,i+100).join(','));
      const result=await fetchJson(url.href);
      if(!Array.isArray(result.quotes))throw new Error(result.error||'Worker 回傳格式不正確');
      for(const quote of result.quotes){if(quote?.symbol)fresh[quote.symbol]=quote;}
    }
    if(Object.keys(fresh).length){
      applyYahooQuotes({...state.yahooQuotes,...fresh});render();
      const count=Object.values(state.sourceRows).flat().filter(row=>row.yahooAvailable).length;
      setStatus('Yahoo 延遲報價已更新',`${count.toLocaleString()} 檔取得 Yahoo 報價；未取得報價的個股仍顯示官方日行情作為參考。`);
    }
  })().catch(error=>{
    console.warn('Yahoo Worker refresh failed; retaining the current snapshot quotes.',error);
    setStatus('Yahoo 代理檢查失敗，保留現有報價',`${error.message}；下一次頁面檢查時會重試。`,true);
  }).finally(()=>{workerQuotePromise=null;});
  return workerQuotePromise;
}
let usRankingPromise = null;
async function refreshUSRankings(){
  const base=String(window.STOCKTRACKER_YAHOO_WORKER_URL||'').trim();
  if(!base||usRankingPromise)return usRankingPromise;
  usRankingPromise=(async()=>{
    const url=new URL(base,location.href);url.pathname=url.pathname.replace(/\/quotes\/?$/,'/us-rankings');
    const result=await fetchJson(url.href);
    if(!result.rankings||!result.fetchedAt)throw new Error(result.error||'Yahoo US screener response is invalid');
    if(result.fetchedAt===state.usFetchedAt)return;
    const convert=items=>(Array.isArray(items)?items:[]).map(q=>({
      code:String(q.symbol||''),name:String(q.name||q.symbol||''),market:'us',exchange:String(q.exchange||''),
      volume:num(q.volume)??0,close:num(q.price),change:num(q.change),pct:num(q.changePercent),
      yahooAvailable:true,quoteTime:num(q.marketTime),delayedMinutes:num(q.delayedMinutes),marketState:String(q.marketState||''),currency:'USD'
    })).filter(row=>row.code&&row.close!==null&&row.pct!==null);
    state.usRankings={volume:convert(result.rankings.volume),gainers:convert(result.rankings.gainers),losers:convert(result.rankings.losers)};
    state.usRows=[...new Map([...state.usRankings.volume,...state.usRankings.gainers,...state.usRankings.losers].map(row=>[row.code,row])).values()];
    state.usTotals=result.totals||{};state.usFetchedAt=result.fetchedAt;state.usMarketTime=num(result.marketTime);
    state.usMarketState=state.usRows.map(row=>row.marketState).find(Boolean)||null;
    state.usDelayMin=num(result.delayMin);state.usDelayMax=num(result.delayMax);state.usError=result.errors?Object.values(result.errors).join('; '):null;
    if(state.market==='us'){
      render();
      const marketStateLabel={PRE:'盤前',REGULAR:'盤中',POST:'盤後',CLOSED:'休市'}[state.usMarketState]||state.usMarketState||'狀態未提供';
      $('#sessionBadge').textContent=`Yahoo ${marketStateLabel}`;
      const time=state.usMarketTime?new Date(state.usMarketTime*1000).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}):'未提供';
      const delay=state.usDelayMin===null?'':`；Yahoo 回傳延遲 ${state.usDelayMin}${state.usDelayMax!==null&&state.usDelayMax!==state.usDelayMin?`–${state.usDelayMax}`:''} 分鐘`;
      $('#quoteUpdateTime').textContent=`Yahoo 美東行情時間 ${time} ET；Worker 抓取 ${taipeiTime(state.usFetchedAt)} 台北${delay}`;
      setStatus('美股 Yahoo 篩選榜已更新',`成交量、漲幅與跌幅榜來自 Yahoo 預設 US EQUITY screener；各榜依 Yahoo 內建條件篩選，非無條件全市場排行。${state.usError||''}`);
    }
  })().catch(error=>{
    state.usError=error.message;
    if(state.market==='us')setStatus('美股 Yahoo 報價暫時無法取得',`${error.message}；保留上次成功資料，並於下一分鐘重試。`,true);
  }).finally(()=>{usRankingPromise=null;});
  return usRankingPromise;
}
function loadData({manual=false}={}){
  if(loadPromise) return loadPromise;
  const showSpinner=manual||!state.fetchedAt;
  if(showSpinner){document.body.classList.add('loading');$('#refreshBtn').disabled=true;}
  if(manual)setStatus('正在檢查最新已部署快照',`手動重新載入會重讀同源資料快照。${state.lastSuccessAt?`上次成功檢查：${taipeiTime(state.lastSuccessAt)}。`:''}`);
  else if(!state.fetchedAt)setStatus('正在讀取官方資料快照','載入 TWSE、TPEx 股票與期交所每日行情…');
  loadPromise=(async()=>{
  try{
    const snapshot=await fetchJson(`./data/market.json?check=${Date.now()}`);
    if(!snapshot||!snapshot.fetchedAt)throw new Error('資料快照缺少更新時間');
    const checkedAt=new Date().toISOString();
    if(state.fetchedAt===String(snapshot.fetchedAt)){
      state.lastSuccessAt=checkedAt;
      setStatus('快照尚未更新',`畫面保留目前資料；上次成功檢查 ${taipeiTime(state.lastSuccessAt)}，快照擷取時間 ${taipeiTime(state.fetchedAt)}。`);
      void refreshWorkerQuotes();
      void refreshUSRankings();
      return;
    }
    const {listed:twse,otc:tpex,emerging}=snapshot;
    const twseRows=(Array.isArray(twse)?twse:[]).map(normalizeTwse).filter(Boolean);
    const tpexRows=(Array.isArray(tpex)?tpex:[]).map(normalizeTpex).filter(Boolean);
    const emergingRows=(Array.isArray(emerging)?emerging:[]).map(normalizeEmerging).filter(Boolean);
    if(!twseRows.length&&!tpexRows.length&&!emergingRows.length) throw new Error('官方資料沒有可用的成交量及價格欄位');
    state.yahooError=snapshot.yahooError||null;
    state.yahooFetchedAt=snapshot.yahooFetchedAt||null;
    state.sourceRows={listed:twseRows,otc:tpexRows,emerging:emergingRows};
    applyYahooQuotes(snapshot.yahooQuotes&&typeof snapshot.yahooQuotes==='object'?snapshot.yahooQuotes:{});
    state.dates={listed:[...new Set(twseRows.map(x=>dateKey(x.date)).filter(Boolean))].sort(),otc:[...new Set(tpexRows.map(x=>dateKey(x.date)).filter(Boolean))].sort(),emerging:[...new Set(emergingRows.map(x=>dateKey(x.date)).filter(Boolean))].sort()};
    const shared=state.dates.listed.filter(d=>state.dates.otc.includes(d)&&state.dates.emerging.includes(d)).sort();
    state.commonDate=shared.length>0;
    if(state.commonDate){state.stamp=shared.at(-1);state.rows=[...twseRows.filter(x=>dateKey(x.date)===state.stamp),...tpexRows.filter(x=>dateKey(x.date)===state.stamp),...emergingRows.filter(x=>dateKey(x.date)===state.stamp)];}
    else {state.stamp='';state.rows=[...twseRows,...tpexRows,...emergingRows];}
    state.fetchedAt=String(snapshot.fetchedAt);state.lastSuccessAt=checkedAt;
    render();
    const listedDate=state.dates.listed.at(-1)||'';const otcDate=state.dates.otc.at(-1)||'';const emergingDate=state.dates.emerging.at(-1)||'';
    const dateText=state.commonDate?formatDate(state.stamp):`上市 ${formatDate(listedDate)}｜上櫃 ${formatDate(otcDate)}｜興櫃 ${formatDate(emergingDate)}`;
    $('#reportDate').textContent=dateText; $('#sessionBadge').textContent=state.commonDate?'共同資料日':'市場資料日不同';
    const dateNotice=state.commonDate?`共同資料日：${formatDate(state.stamp)}`:`三來源目前未齊於同一資料日；各市場分別使用自己的最新日行情（上市 ${formatDate(listedDate)}、上櫃 ${formatDate(otcDate)}、興櫃 ${formatDate(emergingDate)}），跨市場合併排名不可視為同一交易日比較。`;
    setStatus('官方資料快照已載入',`${dateNotice} ・ 上市 ${twseRows.length.toLocaleString()} 檔、上櫃 ${tpexRows.length.toLocaleString()} 檔、興櫃 ${emergingRows.length.toLocaleString()} 檔 ・ 快照擷取 ${taipeiTime(state.fetchedAt)}；本頁成功檢查 ${taipeiTime(state.lastSuccessAt)}（台北）。`);
    const yahooCount=Object.values(state.sourceRows).flat().filter(row=>row.yahooAvailable).length;
    const yahooTotal=Number(snapshot.yahooSymbolCount)||0;
    if(state.yahooError||yahooCount===0)setStatus('Yahoo 個股報價目前不可用',`${state.yahooError||'尚未取得任何 Yahoo 報價。'}目前 Yahoo 報價 ${yahooCount.toLocaleString()}/${yahooTotal.toLocaleString()} 檔；畫面保留官方最新日收盤價／日均價與漲跌幅，並以官方成交量計算成交量排行。`,true);
    else if(yahooCount<yahooTotal)setStatus('Yahoo 個股報價部分可用',`目前取得 ${yahooCount.toLocaleString()}/${yahooTotal.toLocaleString()} 檔 Yahoo 報價；缺漏個股保留官方日行情，表格會標示各列資料來源。`,true);
    void refreshWorkerQuotes();
    void refreshUSRankings();
  }catch(err){
    console.error(err);
    if(state.fetchedAt){setStatus('快照檢查失敗，保留目前資料',`${err.message}。上次成功檢查 ${taipeiTime(state.lastSuccessAt)}；頁面會在 60 秒後自動重試。`,true);}
    else {setStatus('無法載入行情快照',`${err.message}。頁面會每 60 秒自動重試；請稍後再試。`,true);}
  }finally{if(showSpinner){document.body.classList.remove('loading');$('#refreshBtn').disabled=false;}}
  })().finally(()=>{loadPromise=null;});
  return loadPromise;
}
function setStatus(title,text,error=false){$('#statusTitle').textContent=title;$('#statusText').textContent=`${text} ${freshnessNote()}`;$('#statusBox').classList.toggle('error',error);}
function visibleRows(){
  if(state.market==='us') return state.usRows||[];
  if(state.market==='all') return state.rows;
  const key=state.market;
  const rows=state.sourceRows[key]||[];const latest=state.dates[key]?.at(-1);
  return rows.filter(x=>dateKey(x.date)===latest);
}
function render(){
  const rows=visibleRows();
  if(rows.length||state.market==='us'){
    if(state.market==='us'){$('#reportDate').textContent=state.usMarketTime?new Date(state.usMarketTime*1000).toLocaleDateString('zh-TW',{timeZone:'America/New_York'}):'—';$('#sessionBadge').textContent='Yahoo 資料日';}
    else if(state.market==='listed'){$('#reportDate').textContent=formatDate(state.dates.listed.at(-1));$('#sessionBadge').textContent='上市資料日';}
    else if(state.market==='otc'){$('#reportDate').textContent=formatDate(state.dates.otc.at(-1));$('#sessionBadge').textContent='上櫃資料日';}
    else if(state.market==='emerging'){$('#reportDate').textContent=formatDate(state.dates.emerging.at(-1));$('#sessionBadge').textContent='興櫃資料日';}
    else if(state.commonDate){$('#reportDate').textContent=formatDate(state.stamp);$('#sessionBadge').textContent='共同資料日';}
    else{$('#reportDate').textContent=`上市 ${formatDate(state.dates.listed.at(-1))}｜上櫃 ${formatDate(state.dates.otc.at(-1))}｜興櫃 ${formatDate(state.dates.emerging.at(-1))}`;$('#sessionBadge').textContent='市場資料日不同';}
  }
  const usMode=state.market==='us';
  const vols=(usMode?state.usRankings.volume:[...rows].sort((a,b)=>b.volume-a.volume)).slice(0,5);
  const movers=(usMode?(state.direction==='up'?state.usRankings.gainers:state.usRankings.losers):[...rows].filter(x=>x.pct!==null&&Number.isFinite(x.pct)).sort((a,b)=>state.direction==='up'?b.pct-a.pct:a.pct-b.pct)).slice(0,5);
  const scopeName={all:'全部市場',listed:'上市',otc:'上櫃',emerging:'興櫃',us:'美股｜Yahoo 篩選榜'}[state.market];
  $('#pageTitle').textContent=usMode?'美股掃描':'市場掃描';
  $('#pageSubtitle').textContent=usMode?'Yahoo 標準篩選榜：最活躍、漲幅與跌幅前五。':'用成交量與價格變動，掌握今日台股焦點。';
  $('#sidebarSourceTitle').textContent=usMode?'Yahoo Finance 美股行情':'官方市場資料';
  $('#sidebarSourceDetail').textContent=usMode?'US EQUITY Screener':'TWSE ・ TPEx';
  $('#summaryUniverseLabel').textContent=usMode?'Yahoo 篩選結果數':'Yahoo 可用報價檔數';
  $('#summaryUniverse').textContent=fmt.format(usMode?(state.usTotals.volume||0):rows.filter(x=>x.yahooAvailable).length);
  $('#volumeUnit').textContent=usMode?'股（股數）':'張・興櫃以股數換算';
  $('#volumeDescription').textContent=usMode?'Yahoo 最活躍篩選榜':'依成交股數由高至低';
  $('#volumeColumnLabel').textContent=usMode?'成交股數':'官方成交量';
  $('#changeVolumeColumnLabel').textContent=usMode?'成交股數':'官方成交量';
  $('#volumeFootnote').textContent=usMode?'Yahoo 回傳成交股數；單位：股':'成交量以股數除以 1,000 換算為張';
  $('#marketQuoteNote').textContent=usMode?'美股採 Yahoo US EQUITY 預設篩選榜；各榜依 Yahoo 內建條件選出候選股，非無條件全市場排名。':'TWSE／TPEx Yahoo 報價約延遲 20 分鐘；Yahoo 缺漏時回退官方日價，表格會標示來源。';
  $('#summaryScope').textContent=scopeName;$('#scopeCaption').textContent=scopeName;
  const volumeLeader=vols[0];
  const gainLeader=movers[0];
  $('#summaryVolumeName').textContent=volumeLeader?volumeLeader.name:'—';
  $('#summaryVolumeCode').textContent=volumeLeader?`${volumeLeader.code} ・ ${{listed:'上市',otc:'上櫃',emerging:'興櫃',us:'美股'}[volumeLeader.market]}`:'目前沒有有效行情';
  $('#summaryVolumeValue').textContent=volumeLeader?fmt.format(Math.round(volumeLeader.volume))+(usMode?' 股':' 張'):'—';
  $('#summaryMoverName').textContent=gainLeader?gainLeader.name:'—';
  $('#summaryMoverCode').textContent=gainLeader?`${gainLeader.code} ・ ${{listed:'上市',otc:'上櫃',emerging:'興櫃',us:'美股'}[gainLeader.market]} ・ ${gainLeader.yahooAvailable?'Yahoo':'官方日資料'}`:'目前沒有有效漲跌幅';
  $('#summaryMoverValue').innerHTML=gainLeader?pct(gainLeader.pct):'—';
  $('#volumeRows').innerHTML=vols.length?vols.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td>${stock(x)}</td><td><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td><td>${price(x)}</td><td>${pctWithSource(x)}</td></tr>`).join(''):empty(5);
  const max=Math.max(1,...movers.map(x=>Math.abs(x.pct)));
  $('#changeRows').innerHTML=movers.length?movers.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td>${stock(x)}</td><td>${price(x)}</td><td><div class="bar-cell"><span class="mini-bar"><i style="width:${Math.max(5,Math.abs(x.pct)/max*100)}%"></i></span>${pctWithSource(x)}</div></td><td><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td></tr>`).join(''):empty(5);
  $('#volumeCount').textContent=vols.length?`${vols.length} 檔`:'—';$('#changeCount').textContent=movers.length?`${movers.length} 檔`:'—';
  $('#changeFoot').textContent=state.direction==='up'?'依漲幅由高至低':'依跌幅由深至淺';
  const yahooCount=rows.filter(x=>x.yahooAvailable).length;
  $('#priceBasisLabel').textContent=usMode?'Yahoo Finance 延遲行情':(yahooCount===rows.length&&rows.length?'價格與漲跌幅皆採 Yahoo Finance 報價':'Yahoo 報價優先；缺漏時保留官方日價格與漲跌幅，排行為混合來源');
}
function stock(x){const marketLabel={listed:'上市',otc:'上櫃',emerging:'興櫃',us:x.exchange||'美股'}[x.market]||'';return `<span class="stock-code">${escapeHtml(x.code)}</span><span class="stock-name">${escapeHtml(x.name)}</span><span class="stock-market-tag">${escapeHtml(marketLabel)}</span>`;}
function pct(v){if(v===null||!Number.isFinite(v))return '<span class="pct flat">—</span>';const cls=v>0?'up':v<0?'down':'flat';return `<span class="pct ${cls}">${v>0?'+':''}${Number(v).toFixed(2)}%</span>`;}
function price(row){const v=row.close;return v===null||!Number.isFinite(v)?'<span class="pct flat">—</span>':`<span class="price-value">${row.currency==='USD'?'$':''}${new Intl.NumberFormat('zh-TW',{maximumFractionDigits:3}).format(v)}</span><small class="price-source ${row.yahooAvailable?'yahoo-source':'official-source'}">${row.yahooAvailable?'Yahoo':'官方日資料'}</small>`;}
function pctWithSource(row){return `${pct(row.pct)}<small class="price-source ${row.yahooAvailable?'yahoo-source':'official-source'}">${row.yahooAvailable?'Yahoo':'官方日資料'}</small>`;}
function empty(columns=4){return `<tr><td colspan="${columns}" class="empty-state">目前沒有可用排名資料</td></tr>`;}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function sessionCopy(){
  if(state.market==='us'){$('#sessionHint').textContent='美股榜使用 Yahoo 預設篩選結果，盤前/盤中/盤後狀態依 Yahoo 提供資訊；行情依交易所延遲約 15–20 分鐘。';return;}
  const copy={pre:['盤前顯示 Yahoo 最新可得個股報價（台股約延遲 20 分鐘）與官方最近日成交量，供開盤前參考。','資料不代表盤前委託或預估撮合；官方成交量日期不同時會分別標示各市場資料日。'],intra:['盤中個股價格及漲跌幅採 Yahoo 延遲報價，台股約延遲 20 分鐘；成交量排行依官方日資料。','報價更新時間依 Yahoo 個別股票提供的時間顯示；本報表不提供逐筆即時行情。'],post:['盤後以 Yahoo 最新可得價格/漲跌幅與官方日成交量呈現排行。','目前未支援歷史日期回查；官方來源交易日不同時會分別標示各市場資料日。']}[state.session];$('#sessionHint').textContent=`${copy[0]} ${copy[1]}`;
}
document.querySelectorAll('.session-tab').forEach(b=>b.addEventListener('click',()=>{state.session=b.dataset.session;document.querySelectorAll('.session-tab').forEach(t=>{t.classList.toggle('selected',t===b);t.setAttribute('aria-selected',t===b?'true':'false');});sessionCopy();}));
document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>{state.market=b.dataset.market;document.querySelectorAll('[data-market]').forEach(x=>x.classList.toggle('active',x===b));render();sessionCopy();if(state.market==='us')void refreshUSRankings();}));
document.querySelectorAll('[data-direction]').forEach(b=>b.addEventListener('click',()=>{state.direction=b.dataset.direction;document.querySelectorAll('[data-direction]').forEach(x=>x.classList.toggle('active',x===b));render();}));
$('#refreshBtn').addEventListener('click',()=>loadData({manual:true}));$('#retryBtn').addEventListener('click',()=>loadData({manual:true}));$('#todayBtn').addEventListener('click',()=>loadData({manual:true}));
$('#report-date').addEventListener('change',()=>{const v=$('#report-date').value;if(v){const current=state.commonDate?formatDate(state.stamp):`上市 ${formatDate(state.dates.listed.at(-1))}、上櫃 ${formatDate(state.dates.otc.at(-1))}、興櫃 ${formatDate(state.dates.emerging.at(-1))}`;setStatus('日期選擇提示',`官方公開端點目前提供最新日行情，尚未提供此頁歷史日期回查；報表仍顯示來源最新資料日期：${current}。`);}});
function tick(){const d=taipeiNow();$('#clock').textContent=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} TST`;}
tick();setInterval(tick,30000);sessionCopy();const d=taipeiNow();$('#report-date').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;loadData();setInterval(()=>loadData(),60000);
