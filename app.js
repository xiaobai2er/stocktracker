const $ = (s) => document.querySelector(s);
const state = { rows: [], sourceRows: { listed: [], otc: [], emerging: [] }, dates: { listed: [], otc: [], emerging: [] }, market: 'all', direction: 'up', session: 'post', stamp: null, commonDate: false };
const fmt = new Intl.NumberFormat('zh-TW');

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
async function loadData(){
  document.body.classList.add('loading'); $('#refreshBtn').disabled=true; setStatus('正在連線至官方資料來源','讀取 TWSE、TPEx 上櫃及 TPEx 興櫃最新日行情…');
  try{
    const snapshot=await fetchJson('./data/market.json');
    const {listed:twse,otc:tpex,emerging}=snapshot;
    const twseRows=(Array.isArray(twse)?twse:[]).map(normalizeTwse).filter(Boolean);
    const tpexRows=(Array.isArray(tpex)?tpex:[]).map(normalizeTpex).filter(Boolean);
    const emergingRows=(Array.isArray(emerging)?emerging:[]).map(normalizeEmerging).filter(Boolean);
    if(!twseRows.length&&!tpexRows.length&&!emergingRows.length) throw new Error('官方資料沒有可用的成交量及價格欄位');
    state.sourceRows={listed:twseRows,otc:tpexRows,emerging:emergingRows};
    state.dates={listed:[...new Set(twseRows.map(x=>dateKey(x.date)).filter(Boolean))].sort(),otc:[...new Set(tpexRows.map(x=>dateKey(x.date)).filter(Boolean))].sort(),emerging:[...new Set(emergingRows.map(x=>dateKey(x.date)).filter(Boolean))].sort()};
    const shared=state.dates.listed.filter(d=>state.dates.otc.includes(d)&&state.dates.emerging.includes(d)).sort();
    state.commonDate=shared.length>0;
    if(state.commonDate){state.stamp=shared.at(-1);state.rows=[...twseRows.filter(x=>dateKey(x.date)===state.stamp),...tpexRows.filter(x=>dateKey(x.date)===state.stamp),...emergingRows.filter(x=>dateKey(x.date)===state.stamp)];}
    else {state.stamp='';state.rows=[...twseRows,...tpexRows,...emergingRows];}
    render();
    const listedDate=state.dates.listed.at(-1)||'';const otcDate=state.dates.otc.at(-1)||'';const emergingDate=state.dates.emerging.at(-1)||'';
    const dateText=state.commonDate?formatDate(state.stamp):`上市 ${formatDate(listedDate)}｜上櫃 ${formatDate(otcDate)}｜興櫃 ${formatDate(emergingDate)}`;
    $('#reportDate').textContent=dateText; $('#sessionBadge').textContent=state.commonDate?'共同資料日':'市場資料日不同';
    const dateNotice=state.commonDate?`共同資料日：${formatDate(state.stamp)}`:`三來源目前未齊於同一資料日；各市場分別使用自己的最新日行情（上市 ${formatDate(listedDate)}、上櫃 ${formatDate(otcDate)}、興櫃 ${formatDate(emergingDate)}），跨市場合併排名不可視為同一交易日比較。`;
    const fetchedAt=snapshot.fetchedAt?new Date(snapshot.fetchedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',month:'2-digit',day:'2-digit',hour12:false}):'—';
    setStatus('官方資料快照已載入',`${dateNotice} ・ 上市 ${twseRows.length.toLocaleString()} 檔、上櫃 ${tpexRows.length.toLocaleString()} 檔、興櫃 ${emergingRows.length.toLocaleString()} 檔 ・ 抓取時間 ${fetchedAt}（台北；由 GitHub Actions 定期更新）`);
  }catch(err){
    console.error(err); state.rows=[]; render(); $('#reportDate').textContent='暫無資料'; $('#sessionBadge').textContent='連線失敗';
    setStatus('無法取得官方日行情',`${err.message}。請確認網路或稍後重試；若以 file:// 開啟時瀏覽器阻擋跨來源請求，請在本機啟動簡易 HTTP 伺服器。`,true);
  }finally{document.body.classList.remove('loading');$('#refreshBtn').disabled=false;}
}
function setStatus(title,text,error=false){$('#statusTitle').textContent=title;$('#statusText').textContent=text;$('#statusBox').classList.toggle('error',error);}
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
  $('#volumeRows').innerHTML=vols.length?vols.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td>${stock(x)}</td><td><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td><td>${pct(x.pct)}</td></tr>`).join(''):empty();
  const max=Math.max(1,...movers.map(x=>Math.abs(x.pct)));
  $('#changeRows').innerHTML=movers.length?movers.map((x,i)=>`<tr><td><span class="rank-num ${i<3?'top-three':''}">${String(i+1).padStart(2,'0')}</span></td><td>${stock(x)}</td><td><div class="bar-cell"><span class="mini-bar"><i style="width:${Math.max(5,Math.abs(x.pct)/max*100)}%"></i></span>${pct(x.pct)}</div></td><td><span class="volume-value">${fmt.format(Math.round(x.volume))}</span></td></tr>`).join(''):empty();
  $('#volumeCount').textContent=vols.length?`${vols.length} 檔`:'—';$('#changeCount').textContent=movers.length?`${movers.length} 檔`:'—';
  $('#changeFoot').textContent=state.direction==='up'?'依漲幅由高至低':'依跌幅由深至淺';
  $('#priceBasisLabel').textContent=state.market==='all'?'跨市場漲跌幅：上市／上櫃依收盤價；興櫃依日均價':state.market==='emerging'?'興櫃漲跌幅以日均價／前日均價計算':`${state.market==='listed'?'上市':'上櫃'}漲跌幅依收盤價計算`;
}
function stock(x){const marketLabel={listed:'上市',otc:'上櫃',emerging:'興櫃'}[x.market]||'';return `<span class="stock-code">${escapeHtml(x.code)}</span><span class="stock-name">${escapeHtml(x.name)}</span><span class="stock-market-tag">${marketLabel}</span>`;}
function pct(v){if(v===null||!Number.isFinite(v))return '<span class="pct flat">—</span>';const cls=v>0?'up':v<0?'down':'flat';return `<span class="pct ${cls}">${v>0?'+':''}${Number(v).toFixed(2)}%</span>`;}
function empty(){return '<tr><td colspan="4" class="empty-state">目前沒有可用排名資料</td></tr>';}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function sessionCopy(){
  const copy={pre:['盤前顯示官方最新可取得的已完成交易日行情，供開盤前參考。','盤前參考：不代表今日盤前委託或預估撮合；各市場日期若不同，請依各市場資料日解讀。興櫃漲跌幅按日均價計算。'],intra:['盤中顯示官方最新可取得的日行情快照；資料可能延遲或尚未更新，並非即時行情。','盤中限制：本報表不提供逐筆或即時報價；跨市場日期可能不同。興櫃價格以日均價計算漲跌幅。'],post:['盤後以官方最新可取得日行情計算成交量及漲跌幅排名。','盤後說明：歷史日期回查尚未支援；來源交易日不同時會分別標示各市場資料日。興櫃漲跌幅採日均價相對前日均價。']}[state.session];$('#sessionHint').textContent=copy[0];$('#sessionNote').lastElementChild.textContent=copy[1];
}
document.querySelectorAll('.session-tab').forEach(b=>b.addEventListener('click',()=>{state.session=b.dataset.session;document.querySelectorAll('.session-tab').forEach(t=>{t.classList.toggle('selected',t===b);t.setAttribute('aria-selected',t===b?'true':'false');});sessionCopy();}));
document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>{state.market=b.dataset.market;document.querySelectorAll('[data-market]').forEach(x=>x.classList.toggle('active',x===b));render();}));
document.querySelectorAll('[data-direction]').forEach(b=>b.addEventListener('click',()=>{state.direction=b.dataset.direction;document.querySelectorAll('[data-direction]').forEach(x=>x.classList.toggle('active',x===b));render();}));
$('#refreshBtn').addEventListener('click',loadData);$('#retryBtn').addEventListener('click',loadData);$('#todayBtn').addEventListener('click',loadData);
$('#report-date').addEventListener('change',()=>{const v=$('#report-date').value;if(v){const current=state.commonDate?formatDate(state.stamp):`上市 ${formatDate(state.dates.listed.at(-1))}、上櫃 ${formatDate(state.dates.otc.at(-1))}、興櫃 ${formatDate(state.dates.emerging.at(-1))}`;setStatus('日期選擇提示',`官方公開端點目前提供最新日行情，尚未提供此頁歷史日期回查；報表仍顯示來源最新資料日期：${current}。`);}});
function tick(){const d=taipeiNow();$('#clock').textContent=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} TST`;}
tick();setInterval(tick,30000);sessionCopy();const d=taipeiNow();$('#report-date').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;loadData();
