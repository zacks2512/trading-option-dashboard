(function(root){
 'use strict';
 const E=typeof module==='object'&&module.exports?require('./journal-engine.js'):root.JournalEngine;
 const format='trading-journal-workbook-import';
 const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 const clean=x=>JSON.parse(JSON.stringify(x));
 function plan(bundle,accountId,existing=[]){
  if(bundle?.format!==format||bundle.version!==1||!accountId||!Array.isArray(bundle.records)||!bundle.records.length||bundle.records.length>500)throw Error('Invalid workbook import.');
  const result={trades:[],legs:[],actions:[],quotes:[],duplicates:[],closed:0,open:0,closedPnl:0},seen=new Set(),ids=new Set();
  for(const record of bundle.records){
   if(!record||typeof record.sourceId!=='string'||record.sourceId!==record.trade?.id||seen.has(record.sourceId))throw Error('Invalid or repeated source trade.');seen.add(record.sourceId);
   const sourceAccount=record.trade.accountId;
   if(!bundle.sourceAccounts?.some(a=>a.id===sourceAccount))throw Error('Source account is missing.');
   const mapId=id=>typeof id==='string'?id.split(sourceAccount).join(accountId):id;
   const t=clean(record.trade);t.id=mapId(t.id);t.accountId=accountId;
   if(t.rollFromId)t.rollFromId=mapId(t.rollFromId);
   const groups={legs:[],actions:[],quotes:[]};
   for(const table of Object.keys(groups)){
    if(!Array.isArray(record[table]))throw Error('Missing source '+table+'.');
    for(const original of record[table]){
     if(original.tradeId!==record.sourceId)throw Error('Source child belongs to another trade.');
     const r=clean(original);r.id=mapId(r.id);r.tradeId=t.id;
     if(r.unitId)r.unitId=mapId(r.unitId);
     if(r.fills)r.fills=r.fills.map(f=>({...f,unitId:mapId(f.unitId)}));
     groups[table].push(r);
    }
   }
   for(const [table,rows] of Object.entries({trades:[t],...groups}))for(const r of rows){
    if(typeof r.id!=='string'||!r.id||r.id.length>200||Object.keys(r).some(k=>k.startsWith('_'))||JSON.stringify(r).length>40000)throw Error('Invalid source '+table+' record.');
    const key=table+':'+r.id;if(ids.has(key))throw Error('Repeated source record.');ids.add(key);
   }
   const fingerprint=canonical(record);
   // Keep a lossless source fingerprint for replay detection, without importing old audit IDs.
   t.workbookImport={sourceId:record.sourceId,source:bundle.source,fingerprint};
   if(JSON.stringify(t).length>40000)throw Error('Source trade and provenance are too large.');
   const s=E.summarize(t,groups.legs,groups.actions,groups.quotes,{feeRate:bundle.sourceFeeRate});
   if(!Number.isFinite(s.realized))throw Error('Invalid realized result.');
   if(s.status==='closed')result.closed++;else if(s.status==='open')result.open++;else throw Error('Source trade has no opening execution.');
   result.closedPnl+=s.realized;
   const prior=existing.find(x=>x.id===t.id||x.workbookImport?.sourceId===record.sourceId);
   if(prior){if(prior.workbookImport?.fingerprint!==fingerprint)throw Error('An existing source trade differs. Review before importing: '+t.title);result.duplicates.push(t.id);continue;}
   const oldSummary=existing.find(x=>!x._deleted&&x.historicalImport&&x.symbol===t.symbol&&x.entryDate===t.entryDate);
   if(oldSummary)throw Error('History from the older file is already present. Reconcile it before importing: '+t.title);
   const overlap=existing.find(x=>!x._deleted&&x.symbol===t.symbol&&x.entryDate===t.entryDate&&x.expiry===t.expiry&&String(x.strike)===String(t.strike)&&x.side===t.side&&x.mode===t.mode);
   if(overlap)throw Error('Possible existing position overlap. Review before importing: '+t.title);
   result.trades.push(t);for(const table of Object.keys(groups))result[table].push(...groups[table]);
  }
  result.closedPnl=Math.round(result.closedPnl*100)/100;return result;
 }
 const api={format,plan};if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbookImport=api;
})(typeof window!=='undefined'?window:globalThis);
