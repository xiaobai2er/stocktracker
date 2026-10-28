const $ = (s) => document.querySelector(s);
const state = { rows: [], sourceRows: { listed: [], otc: [], emerging: [] }, dates: { listed: [], otc: [], emerging: [] }, yahooQuotes: {}, yahooError: null, yahooFetchedAt: null, usTechRows: [], usFetchedAt: null, usMarketTime: null, usMarketState: null, usDelayMin: null, usDelayMax: null, usError: null, flowOutRows: [], flowOutUpdatedAt: null, flowMarketOpen: false, market: 'all', direction: 'up', stamp: null, commonDate: false, fetchedAt: null, lastSuccessAt: null };
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
function freshnessNote(){return 'Yahoo 台股報價約延遲 20 分鐘；頁面每 60 秒自動檢查，Actions 快照約每 15 分鐘更新。';}
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
  $('#quoteUpdateTime').textContent=latest?`Yahoo 約延遲 20 分鐘・更新 ${taipeiTime(new Date(latest*1000).toISOString())}`:'Yahoo 報價暫不可用・顯示官方日行情';
}
async function refreshWorkerQuotes(){
  const base=String(window.STOCKTRACKER_YAHOO_WORKER_URL||'').trim();
  if(!base||!state.fetchedAt||workerQuotePromise)return workerQuotePromise;
  const symbols=[...new Set([...Object.values(state.sourceRows).flat().map(quoteSymbol),'^IXIC','^GSPC','SOXX','0050.TW'])];
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
      renderMarketIndices(fresh);
      renderTaiwanETF(fresh);
      applyYahooQuotes({...state.yahooQuotes,...fresh});render();
    }
  })().catch(error=>{
    console.warn('Yahoo Worker refresh failed; retaining the current snapshot quotes.',error);
    setStatus('Yahoo 代理檢查失敗，保留現有報價',`${error.message}；下一次頁面檢查時會重試。`,true);
  }).finally(()=>{workerQuotePromise=null;});
  return workerQuotePromise;
}
let usTechPromise = null;
async function refreshUSTech({force=false}={}){
  const base=String(window.STOCKTRACKER_YAHOO_WORKER_URL||'').trim();
  if(!base)return;
  if(usTechPromise){await usTechPromise;if(!force)return;}
  usTechPromise=(async()=>{
    const url=new URL(base,location.href);url.pathname=url.pathname.replace(/\/quotes\/?$/,'/us-tech');if(force)url.searchParams.set('refresh','1');
    const result=await fetchJson(url.href);
    if(!Array.isArray(result.stocks)||!result.fetchedAt)throw new Error(result.error||'Yahoo technology screener response is invalid');
    if(result.fetchedAt===state.usFetchedAt)return;
    state.usTechRows=result.stocks.map(q=>({
      code:String(q.symbol||''),name:String(q.name||q.symbol||''),exchange:String(q.exchange||''),
      marketCap:num(q.marketCap),close:num(q.price),change:num(q.change),pct:num(q.changePercent),volume:num(q.volume),
      yahooAvailable:true,quoteTime:num(q.marketTime),delayedMinutes:num(q.delayedMinutes),marketState:String(q.marketState||''),currency:'USD'
    })).filter(row=>row.code&&row.marketCap!==null&&row.close!==null&&row.pct!==null)
      .sort((a,b)=>b.marketCap-a.marketCap).slice(0,5);
    state.usFetchedAt=result.fetchedAt;state.usMarketTime=num(result.marketTime);state.usMarketState=state.usTechRows.map(row=>row.marketState).find(Boolean)||null;
    state.usDelayMin=num(result.delayMin);state.usDelayMax=num(result.delayMax);state.usError=null;
    renderUSTech();
    const time=state.usMarketTime?new Date(state.usMarketTime*1000).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}):'未提供';
    const delay=state.usDelayMin===null?'':`；Yahoo 回傳延遲 ${state.usDelayMin}${state.usDelayMax!==null&&state.usDelayMax!==state.usDelayMin?`–${state.usDelayMax}`:''} 分鐘`;
    const marketStateLabel={PRE:'盤前',REGULAR:'盤中',POST:'盤後',CLOSED:'休市'}[state.usMarketState]||state.usMarketState||'狀態未提供';
    $('#usTechUpdatedAt').textContent=`Yahoo ${marketStateLabel}・行情時間 ${time} ET・抓取 ${taipeiTime(state.usFetchedAt)} 台北${delay}`;
    $('#usTechStatus').textContent=`${result.title||'Yahoo Technology Sector'}・市值由高至低；範圍為美國科技產業預設清單（股價高於 US$5）。`;
    $('#usTechCount').textContent=`${state.usTechRows.length} 檔／共 ${fmt.format(result.total||0)} 檔`;
  })().catch(error=>{
    state.usError=error.message;
    $('#usTechStatus').textContent=`Yahoo 科技股資料暫時無法取得：${error.message}。保留上次成功資料，稍後重試。`;
  }).finally(()=>{usTechPromise=null;});
  return usTechPromise;
}
async function refreshFlowOutflows(){
  const base=String(window.STOCKTRACKER_YAHOO_WORKER_URL||'').trim();
  if(!base)return;
  try{
    const url=new URL(base,location.href);url.pathname=url.pathname.replace(/\/quotes\/?$/,'/flow');
    const result=await fetchJson(url.href);
    if(!Array.isArray(result.stocks)||!result.updatedAt)throw new Error(result.error||'資金流出資料格式不正確');
    state.flowOutRows=result.stocks.filter(x=>num(x.flow)<0).sort((a,b)=>num(a.flow)-num(b.flow)).slice(0,5);
    state.flowOutUpdatedAt=num(result.updatedAt);state.flowMarketOpen=Boolean(result.marketOpen);
    renderFlowOutflows();
  }catch(error){
    $('#flowOutStatus').textContent='資料暫不可用';
    $('#flowOutRows').innerHTML=empty(5);
    console.warn('Intraday outflow estimate unavailable.',error);
  }
}
function renderFlowOutflows(){
  const stamp=state.flowOutUpdatedAt?new Date(state.flowOutUpdatedAt*1000).toISOString():null;
  $('#flowOutStatus').textContent=(state.flowMarketOpen?'盤中估算':'最近盤中估算')+(stamp?'・'+taipeiTime(stamp):'');
  const tbody=$('#flowOutRows');
  tbody.innerHTML='';
  if(!state.flowOutRows.length){tbody.innerHTML=empty(5);return;}
  state.flowOutRows.forEach((row,index)=>{
    const priceValue=num(row.price);
    const priceText=priceValue!==null?new Intl.NumberFormat('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}).format(priceValue):'—';
    const cells=[
      '<span class="rank-num '+(index<3?'top-three':'')+'">'+String(index+1).padStart(2,'0')+'</span>',
      '<span class="stock-code">'+escapeHtml(row.symbol)+'</span><span class="stock-name">'+escapeHtml(row.name)+'</span><span class="stock-market-tag">'+escapeHtml(row.sector||'上市')+'</span>',
      '<span class="price-value">'+priceText+'</span><small class="price-source flow-estimate-source">盤中估算</small>',
      pct(num(row.change_pct)),
      '<span class="pct down">−'+(Math.abs(num(row.flow))/1e8).toFixed(1)+' 億</span>'
    ];
    const tr=document.createElement('tr');
    cells.forEach((html,index)=>{const td=document.createElement('td');if(index>=2)td.className='numeric';td.innerHTML=html;tr.appendChild(td);});
    tbody.appendChild(tr);
  });
}
function renderTaiwanETF(quotes){
  const q=quotes['0050.TW'];
  const priceValue=num(q?.price), change=num(q?.change), pctValue=num(q?.changePercent);
  document.getElementById('tw0050Price').textContent=priceValue!==null?new Intl.NumberFormat('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}).format(priceValue):'暫無報價';
  const move=document.getElementById('tw0050Move'), percent=document.getElementById('tw0050Change');
  move.textContent=change!==null?`${change>0?'+':''}${new Intl.NumberFormat('zh-TW',{maximumFractionDigits:2}).format(change)}`:'—';
  move.className=`pct ${change>0?'up':change<0?'down':'flat'}`;
  percent.textContent=pctValue!==null?`${pctValue>0?'+':''}${pctValue.toFixed(2)}%`:'—';
  percent.className=`pct ${pctValue>0?'up':pctValue<0?'down':'flat'}`;
}
function renderMarketIndices(quotes){
  const items=[['^IXIC','indexNasdaq','indexNasdaqMove','indexNasdaqChange'],['^GSPC','indexSp500','indexSp500Move','indexSp500Change'],['SOXX','indexSoxx','indexSoxxMove','indexSoxxChange']];
  for(const [symbol,valueId,moveId,changeId] of items){
    const q=quotes[symbol];
    document.getElementById(valueId).textContent=q&&Number.isFinite(num(q.price))?new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(num(q.price)):'\u66ab\u7121\u5831\u50f9';
    const move=document.getElementById(moveId), percent=document.getElementById(changeId), change=num(q?.change), pctValue=num(q?.changePercent);
    move.textContent=change!==null?`${change>0?'+':''}${new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(change)}`:'\u2014';
    move.className=`pct ${change>0?'up':change<0?'down':'flat'}`;
    percent.textContent=pctValue!==null?`${pctValue>0?'+':''}${pctValue.toFixed(2)}%`:'\u2014';
    percent.className=`pct ${pctValue>0?'up':pctValue<0?'down':'flat'}`;
  }
  const times=items.map(([symbol])=>num(quotes[symbol]?.marketTime)).filter(Boolean);
  document.getElementById('indicesUpdated').textContent=times.length?`Yahoo Finance \u884c\u60c5\uff1b\u6700\u65b0\u5831\u50f9\u6642\u9593 ${taipeiTime(new Date(Math.max(...times)*1000).toISOString())}\uff08\u53f0\u5317\u6642\u9593\uff09\uff0c\u7f8e\u80a1\u884c\u60c5\u53ef\u80fd\u5ef6\u9072\u3002`:'Yahoo Finance \u884c\u60c5\uff0c\u53ef\u80fd\u5ef6\u9072\u3002';
}
function loadData({manual=false}={}){
  if(loadPromise) return loadPromise;
  const showSpinner=manual||!state.fetchedAt;
  if(showSpinner){document.body.classList.add('loading');$('#refreshBtn').disabled=true;}
  if(manual)setStatus('正在檢查最新已部署快照',`手動重新載入會重讀同源資料快照。${state.lastSuccessAt?`上次成功檢查：${taipeiTime(state.lastSuccessAt)}。`:''}`);
  else if(!state.fetchedAt)setStatus('\u6b63\u5728\u8b80\u53d6\u4e0a\u5e02\u884c\u60c5','\u8f09\u5165 TWSE \u4e0a\u5e02\u80a1\u7968\u65e5\u884c\u884c\u60c5...');
  loadPromise=(async()=>{
  try{
    const snapshot=await fetchJson(`./data/market.json?check=${Date.now()}`);
    if(!snapshot||!snapshot.fetchedAt)throw new Error('資料快照缺少更新時間');
    const checkedAt=new Date().toISOString();
    if(state.fetchedAt===String(snapshot.fetchedAt)){
      state.lastSuccessAt=checkedAt;
      setStatus('快照尚未更新',`畫面保留目前資料；上次成功檢查 ${taipeiTime(state.lastSuccessAt)}，快照擷取時間 ${taipeiTime(state.fetchedAt)}。`);
      void refreshWorkerQuotes();
      void refreshUSTech();
      return;
    }
    const {listed:twse,otc:tpex,emerging}=snapshot;
    const twseRows=(Array.isArray(twse)?twse:[]).map(normalizeTwse).filter(Boolean);
    const tpexRows=(Array.isArray(tpex)?tpex:[]).map(normalizeTpex).filter(Boolean);
    const emergingRows=(Array.isArray(emerging)?emerging:[]).map(normalizeEmerging).filter(Boolean);
    if(!twseRows.length) throw new Error('官方資料沒有可用的成交量及價格欄位');
    state.yahooError=snapshot.yahooError||null;
    state.yahooFetchedAt=snapshot.yahooFetchedAt||null;
    state.sourceRows={listed:twseRows,otc:[],emerging:[]};
    applyYahooQuotes(snapshot.yahooQuotes&&typeof snapshot.yahooQuotes==='object'?snapshot.yahooQuotes:{});
    renderMarketIndices(snapshot.yahooQuotes||{});
    renderTaiwanETF(snapshot.yahooQuotes||{});
    state.dates={listed:[...new Set(twseRows.map(x=>dateKey(x.date)).filter(Boolean))].sort(),otc:[],emerging:[]};
    state.commonDate=state.dates.listed.length>0;
    state.stamp=state.dates.listed.at(-1)||'';
    state.rows=twseRows.filter(x=>dateKey(x.date)===state.stamp);
    state.fetchedAt=String(snapshot.fetchedAt);state.lastSuccessAt=checkedAt;
    render();
    const listedDate=state.dates.listed.at(-1)||'';
    $('#reportDate').textContent=formatDate(state.stamp); $('#sessionBadge').textContent=state.commonDate?'\u4e0a\u5e02\u884c\u60c5\u65e5':'\u7b49\u5f85\u884c\u60c5';
    const dateNotice=`\u4e0a\u5e02\u80a1\u7968\u884c\u60c5\u65e5\u671f\uff1a${formatDate(listedDate)}`;
    setStatus('\u4e0a\u5e02\u884c\u60c5\u5feb\u7167\u5df2\u8f09\u5165',`${dateNotice} \u30fb TWSE ${twseRows.length.toLocaleString()} \u6a94 \u30fb \u5feb\u7167\u64f7\u53d6 ${taipeiTime(state.fetchedAt)}\uff1b\u672c\u9801\u6210\u529f\u6aa2\u67e5 ${taipeiTime(state.lastSuccessAt)}\uff08\u53f0\u5317\uff09\u3002`);
    const yahooCount=Object.values(state.sourceRows).flat().filter(row=>row.yahooAvailable).length;
    const yahooTotal=twseRows.length;
    if(state.yahooError||yahooCount===0)setStatus('Yahoo 個股報價目前不可用',`${state.yahooError||'尚未取得任何 Yahoo 報價。'}目前 Yahoo 報價 ${yahooCount.toLocaleString()}/${yahooTotal.toLocaleString()} 檔；畫面保留官方最新日收盤價／日均價與漲跌幅，並以官方成交量計算成交量排行。`,true);
    else if(yahooCount<yahooTotal)setStatus('Yahoo 個股報價部分可用',`目前取得 ${yahooCount.toLocaleString()}/${yahooTotal.toLocaleString()} 檔 Yahoo 報價；缺漏個股保留官方日行情，表格會標示各列資料來源。`,true);
    void refreshWorkerQuotes();
    void refreshUSTech();
  }catch(err){
    console.error(err);
    if(state.fetchedAt){setStatus('快照檢查失敗，保留目前資料',`${err.message}。上次成功檢查 ${taipeiTime(state.lastSuccessAt)}；頁面會在 60 秒後自動重試。`,true);}
    else {setStatus('無法載入行情快照',`${err.message}。頁面會每 60 秒自動重試；請稍後再試。`,true);}
  }finally{if(showSpinner){document.body.classList.remove('loading');$('#refreshBtn').disabled=false;}}
  })().finally(()=>{loadPromise=null;});
  return loadPromise;
}
function setStatus(title,text,error=false){if(!$('#statusBox')){if(error)console.warn(title,text);return;}$('#statusTitle').textContent=title;$('#statusText').textContent=`${text} ${freshnessNote()}`;$('#statusBox').classList.toggle('error',error);}
function visibleRows(){
  if(state.market==='all') return state.rows;
  const key=state.market;
  const rows=state.sourceRows[key]||[];const latest=state.dates[key]?.at(-1);
  return rows.filter(x=>dateKey(x.date)===latest);
}
function render(){
  const rows=visibleRows();
  if(state.rows.length){
    if(state.market==='listed'){$('#reportDate').textContent=formatDate(state.dates.listed.at(-1));$('#sessionBadge').textContent='上市資料日';}
    else if(state.market==='otc'){$('#reportDate').textContent=formatDate(state.dates.otc.at(-1));$('#sessionBadge').textContent='上櫃資料日';}
    else if(state.market==='emerging'){$('#reportDate').textContent=formatDate(state.dates.emerging.at(-1));$('#sessionBadge').textContent='興櫃資料日';}
    else if(state.commonDate){$('#reportDate').textContent=formatDate(state.stamp);$('#sessionBadge').textContent='共同資料日';}
    else{$('#reportDate').textContent=`上市 ${formatDate(state.dates.listed.at(-1))}｜上櫃 ${formatDate(state.dates.otc.at(-1))}｜興櫃 ${formatDate(state.dates.emerging.at(-1))}`;$('#sessionBadge').textContent='市場資料日不同';}
  }
  const vols=[...rows].sort((a,b)=>b.volume-a.volume).slice(0,5);
  const movers=[...rows].filter(x=>x.pct!==null&&Number.isFinite(x.pct)).sort((a,b)=>state.direction==='up'?b.pct-a.pct:a.pct-b.pct).slice(0,5);
  const scopeName='\u4e0a\u5e02\u5e02\u5834';
  $('#volumeUnit').textContent='\u4e0a\u5e02\u6210\u4ea4\u91cf\uff08\u5f35\uff09';
  $('#volumeDescription').textContent='依成交股數由高至低';
  $('#volumeColumnLabel').textContent='官方成交量';
  $('#volumeFootnote').textContent='成交量：張（股數÷1,000）・價格/漲跌幅：Yahoo';
  $('#marketQuoteNote').textContent='TWSE Yahoo \u5831\u50f9\u7d04\u5ef6\u9072 20 \u5206\u9418\uff1bYahoo \u7f3a\u6f0f\u6642\u56de\u9000\u5b98\u65b9\u65e5\u50f9\uff0c\u8868\u683c\u6703\u6a19\u793a\u4f86\u6e90\u3002';
  $('#scopeCaption').textContent=scopeName;
  const volumeLeader=vols[0];
  const gainLeader=movers[0];
  $('#summaryVolumeName').textContent=volumeLeader?volumeLeader.name:'—';
  $('#summaryVolumeCode').textContent=volumeLeader?`${volumeLeader.code} ・ ${{listed:'上市',otc:'上櫃',emerging:'興櫃'}[volumeLeader.market]}`:'目前沒有有效行情';
  $('#summaryVolumeValue').textContent=volumeLeader?fmt.format(Math.round(volumeLeader.volume))+' 張':'—';
  $('#summaryMoverName').textContent=gainLeader?gainLeader.name:'—';
  $('#summaryMoverCode').textContent=gainLeader?`${gainLeader.code} ・ ${{listed:'上市',otc:'上櫃',emerging:'興櫃'}[gainLeader.market]} ・ ${gainLeader.yahooAvailable?'Yahoo':'官方日資料'}`:'目前沒有有效漲跌幅';
  $('#summaryMoverValue').innerHTML=gainLeader?pct(gainLeader.pct):'—';
  $('#volumeRows').innerHTML=vols.length?vols.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td>${stock(x)}</td><td><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td><td>${price(x)}</td><td>${pctWithSource(x)}</td></tr>`).join(''):empty(5);
  $('#volumeCount').textContent=vols.length?String(vols.length)+' \u6a94':'\u2014';
  const yahooCount=rows.filter(x=>x.yahooAvailable).length;
  $('#priceBasisLabel').textContent=yahooCount===rows.length&&rows.length?'價格與漲跌幅皆採 Yahoo Finance 報價':'Yahoo 報價優先；缺漏時保留官方日價格與漲跌幅，排行為混合來源';
}
function renderUSTech(){
  $('#usTechRows').innerHTML=state.usTechRows.length?state.usTechRows.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="stock-code">${escapeHtml(x.code)}</span></td><td><span class="stock-name">${escapeHtml(x.name)}</span><small class="price-source yahoo-source">${escapeHtml(x.exchange)}</small></td><td class="numeric"><span class="volume-value">${usdCompact(x.marketCap)}</span></td><td class="numeric"><span class="price-value">$${new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(x.close)}</span></td><td class="numeric">${pct(x.pct)}</td><td class="numeric"><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td></tr>`).join(''):empty(7);
}
function usdCompact(value){return value>=1e12?`$${(value/1e12).toFixed(2)}T`:value>=1e9?`$${(value/1e9).toFixed(1)}B`:`$${fmt.format(value)}`;}
function stock(x){const marketLabel={listed:'上市',otc:'上櫃',emerging:'興櫃'}[x.market]||'';return `<span class="stock-code">${escapeHtml(x.code)}</span><span class="stock-name">${escapeHtml(x.name)}</span><span class="stock-market-tag">${escapeHtml(marketLabel)}</span>`;}
function pct(v){if(v===null||!Number.isFinite(v))return '<span class="pct flat">—</span>';const cls=v>0?'up':v<0?'down':'flat';return `<span class="pct ${cls}">${v>0?'+':''}${Number(v).toFixed(2)}%</span>`;}
function price(row){const v=row.close;return v===null||!Number.isFinite(v)?'<span class="pct flat">—</span>':`<span class="price-value">${row.currency==='USD'?'$':''}${new Intl.NumberFormat('zh-TW',{maximumFractionDigits:3}).format(v)}</span><small class="price-source ${row.yahooAvailable?'yahoo-source':'official-source'}">${row.yahooAvailable?'Yahoo':'官方日資料'}</small>`;}
function pctWithSource(row){return `${pct(row.pct)}<small class="price-source ${row.yahooAvailable?'yahoo-source':'official-source'}">${row.yahooAvailable?'Yahoo':'官方日資料'}</small>`;}
function empty(columns=4){return `<tr><td colspan="${columns}" class="empty-state">目前沒有可用排名資料</td></tr>`;}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
document.querySelectorAll('.insight-tab').forEach(button=>button.addEventListener('click',()=>{const showOutflow=button.id==='outflowTab';$('#themesTab').classList.toggle('active',!showOutflow);$('#outflowTab').classList.toggle('active',showOutflow);$('#themesTab').setAttribute('aria-selected',String(!showOutflow));$('#outflowTab').setAttribute('aria-selected',String(showOutflow));$('#themesPanel').hidden=showOutflow;$('#outflowPanel').hidden=!showOutflow;}));
document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-market]').forEach(x=>x.classList.toggle('active',x===b));const target=document.querySelector(b.dataset.market==='us'?'#market-indices .section-title-row':'#tw-market .section-title-row');if(target){const top=target.getBoundingClientRect().top+window.scrollY-16;window.scrollTo({top:Math.max(0,top),behavior:'smooth'});}}));
document.querySelectorAll('[data-direction]').forEach(b=>b.addEventListener('click',()=>{state.direction=b.dataset.direction;document.querySelectorAll('[data-direction]').forEach(x=>x.classList.toggle('active',x===b));render();}));
$('#refreshBtn').addEventListener('click',()=>loadData({manual:true}));$('#todayBtn').addEventListener('click',()=>loadData({manual:true}));
$('#usTechRefreshBtn').addEventListener('click',async(event)=>{const button=event.currentTarget;if(button.disabled)return;button.disabled=true;button.textContent='更新中…';try{await refreshUSTech({force:true});}finally{button.disabled=false;button.textContent='↻ 重新載入美股';}});
$('#report-date').addEventListener('change',()=>{const v=$('#report-date').value;if(v){const current=formatDate(state.stamp);setStatus('\u65e5\u671f\u9078\u64c7\u63d0\u793a',`\u5b98\u65b9\u516c\u958b\u7aef\u9ede\u76ee\u524d\u63d0\u4f9b\u6700\u65b0\u65e5\u884c\u60c5\uff0c\u5c1a\u672a\u63d0\u4f9b\u6b64\u9801\u6b77\u53f2\u65e5\u671f\u56de\u67e5\uff1b\u5831\u8868\u4ecd\u986f\u793a\u4e0a\u5e02\u8cc7\u6599\u65e5\u671f\uff1a${current}\u3002`);}});
function tick(){const d=taipeiNow();$('#clock').textContent=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} TST`;}
tick();setInterval(tick,30000);const d=taipeiNow();$('#report-date').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;loadData();void refreshUSTech();void refreshFlowOutflows();setInterval(()=>{void loadData();void refreshUSTech();void refreshFlowOutflows();},60000);
