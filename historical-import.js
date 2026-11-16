(function(root){
 'use strict';
 const E=typeof module==='object'&&module.exports?require('./journal-engine.js'):root.JournalEngine;
 const format='trading-journal-historical-import';
 const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 function signature(t){return canonical([t.title,t.symbol,t.entryDate,t.legacySummary?.exitDate||null,t.legacySummary?.pnl??null]);}
 function plan(bundle,accountId,existing=[]){
  if(bundle?.format!==format||bundle.version!==1||!Array.isArray(bundle.records)||!bundle.records.length||bundle.records.length>500||!accountId)throw Error('Invalid historical import file or account.');
  const trades=[],actions=[],duplicates=[],seen=new Set();let closedPnl=0,closed=0,open=0;
  for(const r of bundle.records){
   if(!r||typeof r.key!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(r.key)||seen.has(r.key))throw Error('Repeated or invalid source record key.');seen.add(r.key);
   const data=r.trade;if(!data||typeof data!=='object'||Object.keys(data).some(k=>k.startsWith('_')))throw Error('Invalid historical trade.');
   const id='sheet-import-'+r.key;
   const t={};for(const k of ['title','symbol','entryDate','mode','side','structure','multiplier','contractsPerPackage','strike','expiry','width','strategy','confidence','entryEmotions','exitEmotions','mistakes','notes','legacyType','legacySummary','legacyOriginal'])if(Object.hasOwn(data,k))t[k]=data[k];
   Object.assign(t,{id,accountId,manual:true,historicalImport:{key:r.key,source:bundle.source,originalRows:JSON.parse(JSON.stringify(r.sourceRows))}});
   const aa=(r.actions||[]).map((a,i)=>({...a,id:id+'-execution-'+i,tradeId:id}));
   if(aa.some(a=>Object.keys(a).some(k=>k.startsWith('_'))))throw Error('Invalid historical execution.');
   if(t.legacySummary){const s=t.legacySummary;if(!Number.isFinite(s.pnl)||!(s.pct===null||Number.isFinite(s.pct))||aa.length)throw Error('Invalid closed historical summary.');E.date(s.exitDate);if(s.exitDate<t.entryDate)throw Error('Exit precedes entry.');closed++;closedPnl+=s.pnl;}
   else{if(aa.length!==1||aa[0].kind!=='open')throw Error('An open source position requires its recorded opening.');open++;}
   E.summarize(t,[],aa);
   if(JSON.stringify(t).length>40000)throw Error('Historical record is too large.');
   const previous=existing.find(x=>x.id===id||x.historicalImport?.key===r.key);
   if(previous){if(canonical(previous.historicalImport?.originalRows)!==canonical(r.sourceRows))throw Error('A previously imported source record changed. Review it before importing again.');duplicates.push(id);continue;}
   const overlap=existing.filter(x=>!x._deleted&&signature(x)===signature(t));
   if(overlap.length)throw Error('Possible overlap with an existing trade: '+t.title+'. Review before importing.');
   trades.push(t);actions.push(...aa);
  }
  return{trades,actions,duplicates,closed,open,closedPnl:Math.round(closedPnl*100)/100};
 }
 const api={format,plan};if(typeof module==='object'&&module.exports)module.exports=api;else root.HistoricalImport=api;
})(typeof window!=='undefined'?window:globalThis);
