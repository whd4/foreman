// fmn serve — a local dashboard where every meter runs on real session data.
//
// The point of this file is the separation Whitt asked for: the SKIN is swappable, the
// mechanics underneath are not. One data feed, six exteriors, all reading the same numbers.
// Nothing here has a slider — if a meter moves, a session moved.
//
// Zero dependencies, same as the rest of the package.

import http from "node:http";
import { listSessions, aggregate, getConfig, FRESH_MS } from "./state.js";

/**
 * How many sessions the feed carries. The page renders 14; the rest is for anyone curling
 * the API. Every live session rides along regardless, so a busy day never hides a room.
 * 2,009 sessions were on disk on 2026-09-11 — shipping them all made each poll 850 KB.
 */
const SESSION_LIMIT = 40;

/** Shape the on-disk session files into something a browser can render directly. */
export function snapshot({ now = Date.now(), limit = SESSION_LIMIT } = {}) {
  const cfg = getConfig();
  // One walk of the sessions folder feeds both the list and the totals. Not `full`: only
  // sessions that are live, current, new, or in the sweep slice touch disk (see listSessions).
  const all = listSessions({ full: false, now });
  const agg = aggregate({ sessions: all, now });
  const sessions = all.filter((s, i) => i < limit || (s.at && now - Date.parse(s.at) < FRESH_MS)).map((s) => {
    const h = s.hud ?? {};
    const t = h.totals ?? {};
    const age = s.at ? now - Date.parse(s.at) : null;
    return {
      id: s.id,
      short: s.id.slice(0, 8),
      current: Boolean(s.current),
      active: age != null && age < FRESH_MS,
      ageMs: age,
      state: s.state?.state ?? "idle",
      via: s.state?.via ?? null,
      tool: s.state?.tool ?? null,
      model: h.model ?? null,
      ctxPct: Number.isFinite(h.ctxPct) ? h.ctxPct : null,
      ctxUsed: Number(h.ctxUsed) || 0,
      ctxSize: Number(h.ctxSize) || 0,
      windowSource: h.windowSource ?? null,
      windowExceeded: Boolean(h.windowExceeded),
      costUsd: Number.isFinite(h.costUsd) ? h.costUsd : null,
      tokens: {
        input: Number(t.inputTokens) || 0,
        output: Number(t.outputTokens) || 0,
        cacheRead: Number(t.cacheReadTokens) || 0,
        cacheCreate: Number(t.cacheCreateTokens) || 0,
        messages: Number(t.messages) || 0,
      },
      subagentShare: Number(h.subagentShare) || 0,
    };
  });

  const cur = sessions.find((s) => s.current) ?? sessions.find((s) => s.active) ?? sessions[0] ?? null;

  return {
    at: new Date(now).toISOString(),
    character: cfg.character ?? "crab",
    windowTokens: cfg.windowTokens ?? null,
    priceSet: Boolean(cfg.price),
    current: cur,
    sessions,
    aggregate: agg,
  };
}

// One snapshot per SNAPSHOT_TTL_MS serves every poller. The page polls every 2 s, so 1 s
// means each poll sees fresh numbers while a burst of open tabs shares one walk.
//
// History: measured 2026-09-08 at 23 s per snapshot with the page piling requests on it,
// so the port looked dead; the TTL was 5 s then, which only meant a 23 s stall every 5 s.
// Measured 2026-09-11 with 2,009 sessions on disk: 5.0 s per snapshot before the session
// cache in state.js, ~40 ms after. The one slow walk left (every file, once) is paid in
// serve() before the port opens.
const SNAPSHOT_TTL_MS = 1000;
let _snap = { at: 0, json: null };
export function cachedSnapshotJson(now = Date.now()) {
  if (!_snap.json || now - _snap.at > SNAPSHOT_TTL_MS) _snap = { at: now, json: JSON.stringify(snapshot({ now })) };
  return _snap.json;
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const send = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    try {
      if (url === "/api/state") return send(200, "application/json; charset=utf-8", cachedSnapshotJson());
      if (url === "/" || url === "/index.html") return send(200, "text/html; charset=utf-8", PAGE);
      send(404, "text/plain; charset=utf-8", "not found");
    } catch (e) {
      send(500, "text/plain; charset=utf-8", String(e?.stack || e));
    }
  });
}

export function serve({ port = 7961, host = "127.0.0.1" } = {}) {
  // Warm the session cache before the port opens: the first walk reads every session file
  // once (about 3 s with 2,000 on disk), and the first poll should be as fast as the rest.
  cachedSnapshotJson();
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(port, host, () => resolve({ server: s, url: `http://${host}:${port}/` }));
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  The page. One feed, six skins.
// ────────────────────────────────────────────────────────────────────────────
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>foreman — live</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  --ground:#141210;--raise:#1C1916;--sink:#100E0C;--line:#2E2823;--line-hi:#463E36;
  --ink:#F2EBE2;--dim:#9B9187;--faint:#6A6259;
  --mango:#E8825A;--good:#63C97C;--warn:#E5B54F;--crit:#D8543F;
  --in:#EFC65C;--out:#5FC2B4;--cache:#7E8FB8;--cachew:#A985D6;
  --mono:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace;
  --sans:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;
}
@media(prefers-color-scheme:light){:root{--ground:#F7F4EE;--raise:#FFF;--sink:#EFEAE1;
  --line:#E0D7CA;--line-hi:#C9BEAE;--ink:#1D1813;--dim:#635A50;--faint:#8A8177;
  --good:#2E9450;--warn:#9F7310;--crit:#B23A28;--in:#9A7410;--out:#1F7A6E;--cache:#3F5480;--cachew:#6E4AA0}}
/* Type scale: nothing on this page may be smaller than 13px. The whole product is an
   instrument you read at a glance, so 11px labels were a defect, not a style. */
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:17px;line-height:1.6}
.wrap{max-width:1120px;margin:0 auto;padding:26px 22px 70px;display:flex;flex-direction:column;gap:20px}
h1{font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0}
h1 em{font-style:normal;color:var(--mango)}
.sub{color:var(--dim);font-size:15px;margin:0}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--sink);
  border:1px solid var(--line);border-radius:11px;padding:12px 14px;font-family:var(--mono);font-size:14px}
.skin{font-family:var(--mono);font-size:15px;letter-spacing:.04em;color:var(--dim);background:transparent;
  border:1px solid var(--line-hi);border-radius:7px;padding:10px 16px;cursor:pointer}
.skin:hover{color:var(--ink);border-color:var(--ink)}
.skin[aria-pressed=true]{background:var(--mango);color:#1A1006;border-color:var(--mango)}
.skin:focus-visible{outline:2px solid var(--mango);outline-offset:2px}
.live{margin-left:auto;display:inline-flex;align-items:center;gap:7px;color:var(--faint)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--good);display:block}
.stage{background:var(--raise);border:1px solid var(--line);border-radius:13px;overflow:hidden}
#cv{display:block;width:100%;height:clamp(340px,46vh,520px);background:var(--sink);image-rendering:pixelated}
.read{display:flex;gap:15px;flex-wrap:wrap;align-items:center;padding:13px 16px;
  font-family:var(--mono);font-size:14.5px;color:var(--faint);border-top:1px solid var(--line)}
.read b{color:var(--ink);font-variant-numeric:tabular-nums}
.zone{margin-left:auto;text-transform:uppercase;letter-spacing:.07em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--raise);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card h2{font-family:var(--mono);font-size:13px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--faint);margin:0 0 10px}
.rows{display:flex;flex-direction:column;gap:7px;max-height:320px;overflow:auto}
.row{display:grid;grid-template-columns:10px 80px 56px 52px 1fr;gap:10px;align-items:center;
  font-family:var(--mono);font-size:14.5px;color:var(--dim)}
.row b{color:var(--ink);font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;background:var(--line-hi)}
.dot.on{background:var(--good)} .dot.cur{background:var(--mango)}
.mini{height:4px;border-radius:2px;background:var(--sink);overflow:hidden;border:1px solid var(--line)}
.mini i{display:block;height:100%;background:var(--good)}
.mini i.w{background:var(--warn)} .mini i.c{background:var(--crit)}
.tok{display:flex;flex-direction:column;gap:7px}
.tokrow{display:grid;grid-template-columns:94px 1fr 100px;gap:10px;align-items:center;
  font-family:var(--mono);font-size:14.5px;color:var(--dim)}
.tokrow b{color:var(--ink);text-align:right;font-variant-numeric:tabular-nums}
.tbar{height:11px;border-radius:3px;background:var(--sink);border:1px solid var(--line);overflow:hidden}
.tbar i{display:block;height:100%}
.note{font-size:13.5px;color:var(--faint);margin-top:9px;line-height:1.5}
.warnbox{border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:0 10px 10px 0;
  background:var(--raise);padding:12px 15px;font-size:14px;color:var(--dim)}
.warnbox b{color:var(--ink)}
</style></head><body><div class="wrap">

<div>
  <h1>foreman — <em>live</em></h1>
  <p class="sub">Every meter below is drawn from your real sessions. No sliders: if it moves, an agent moved.</p>
</div>

<div class="bar" id="skins">
  <span style="color:var(--faint);margin-right:3px">skin</span>
  <span class="live" id="liveTag"><i></i><span>polling</span></span>
</div>

<div class="stage">
  <canvas id="cv" aria-label="Live meter"></canvas>
  <div class="read" id="read"></div>
</div>

<div class="grid">
  <div class="card">
    <h2>Sessions</h2>
    <div class="rows" id="rows"></div>
    <div class="note" id="aggNote"></div>
  </div>
  <div class="card">
    <h2>Where the tokens went — all sessions</h2>
    <div class="tok" id="tok"></div>
    <div class="note" id="tokNote"></div>
  </div>
</div>

<div class="warnbox" id="priceWarn" hidden></div>

</div><script>
"use strict";
// ── sprite + palette (same grids the terminal and SVG renderers use) ──
const CRAB={
 stand:["...hhhooo...","..oooooooo..",".oooooooooo.",".ookooookoo.",".oooooooooo.",".oooooooooo.","..dddddddd..","..oo.oo.oo..","..o..o...o.."],
 stepA:["...hhhooo...","..oooooooo..",".oooooooooo.",".ookooookoo.",".oooooooooo.",".oooooooooo.","..dddddddd..","..oo.oo.oo..",".o...o....o."],
 stepB:["...hhhooo...","..oooooooo..",".oooooooooo.",".ookooookoo.",".oooooooooo.",".oooooooooo.","..dddddddd..","..oo.oo.oo..","...o...o..o."],
 hold: ["...hhhooo.o.","..oooooooo.o",".oooooooooo.",".ookooookoo.",".oooooooooo.",".oooooooooo.","..dddddddd..","..oo.oo.oo..","..o..o...o.."],
 crouch:["............","...hhhooo...","..oooooooo..",".ookooookoo.",".oooooooooo.","..dddddddd..","..oooooooo..","..o.oo.oo.o.","............"]};
const P={
 stop:{g:["..rrr..",".rrrrr.","rrrrrrr","rwwwwwr","rrrrrrr",".rrrrr.","...p..."],m:{r:"#D8543F",w:"#F4EDE2",p:"#3A322A"}},
 caution:{g:["...y...","..yyy..","..yky..",".yykyy.",".yy.yy.","yyyyyyy","...p..."],m:{y:"#E5B54F",k:"#3A322A",p:"#3A322A"}},
 go:{g:["..ggg..",".ggggg.","gwwwwwg","gwwwwwg","gwwwwwg",".ggggg.","...p..."],m:{g:"#63C97C",w:"#F4EDE2",p:"#3A322A"}},
 crate:{g:["bbbbbb","bggggb","bgbbgb","bggggb","bbbbbb"],m:{b:"#8A5F3C",g:"#7A5C3E"}},
 funnel:{g:["sssssss",".sssss.","..sss..","..sss.."],m:{s:"#B4ADA2"}}};
const D={"0":["www","w.w","w.w","w.w","www"],"1":[".w.","ww.",".w.",".w.","www"],"2":["www","..w","www","w..","www"],
 "3":["www","..w","www","..w","www"],"4":["w.w","w.w","www","..w","..w"],"5":["www","w..","www","..w","www"],
 "6":["www","w..","www","w.w","www"],"7":["www","..w","..w","..w","..w"],"8":["www","w.w","www","w.w","www"],
 "9":["www","w.w","www","..w","www"],"k":["w.w","w.w","ww.","w.w","w.w"],"M":["w.w","www","www","w.w","w.w"],".":["...","...","...","...",".w."],"%":["w.w","..w",".w.","w..","w.w"]};
const MAP={o:"#E8825A",d:"#B85F3E",h:"#F2A183",k:"#2A1C14"};
const ALT={o:"#63C97C",d:"#3E9455",h:"#8FDBA1",k:"#2A1C14"};
const LAMP=[".ww.","wwww","wwww",".ww."];
const C={steel:"#B4ADA2",steelD:"#7C766E",dark:"#3A322A",darker:"#221E1A",glass:"#1B2422",lip:"#8E9A98",
 white:"#F4EDE2",red:"#D8543F",redOff:"#4A241D",amber:"#E5B54F",amberOff:"#4A3C1C",green:"#63C97C",greenOff:"#204632",
 gold:"#EFC65C",goldD:"#C79E33",teal:"#5FC2B4",tealD:"#3B8E83",brown:"#8A5F3C"};

let ctx,S=4,W=0,H=0;
function blit(rows,map,x0,y0,o){o=o||{};const w=rows[0].length;
 for(let y=0;y<rows.length;y++)for(let x=0;x<rows[y].length;x++){const ch=rows[y][x];
  if(ch==="."||ch===" ")continue;const c=(o.tint&&(ch==="o"||ch==="h"||ch==="d"))?o.tint[ch]:map[ch];if(!c)continue;
  ctx.fillStyle=c;ctx.fillRect(Math.round((x0+(o.flip?w-1-x:x))*S),Math.round((y0+y)*S),S,S);}}
const put=(id,x,y,o)=>{const p=P[id];if(p)blit(p.g,p.m,x,y,o||{})};
const px=(x,y,c,w=1,h=1)=>{ctx.fillStyle=c;ctx.fillRect(Math.round(x*S),Math.round(y*S),w*S,h*S)};
const body=(cx,fy,pose,o)=>{o=o||{};const r=CRAB[pose]||CRAB.stand;blit(r,MAP,cx-6,fy-r.length,{flip:o.flip,tint:o.alt?ALT:null})};
function num(s,x,y,c){let cx=x;for(const ch of s){const g=D[ch];if(g){blit(g,{w:c},cx,y);cx+=4}else cx+=2}}
const numW=s=>[...s].reduce((a,ch)=>a+(D[ch]?4:2),0)-1;
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?Math.round(n/1000)+"k":String(Math.round(n));
const sin=(t,hz)=>Math.sin(t/1000*hz*Math.PI*2);
const cl=(v,a,b)=>v<a?a:v>b?b:v;
const lump=c=>((Math.imul(c^0x9e37,2654435761)>>>24)%5)/5;

// ── live model, filled from /api/state. Never from a slider. ──
let M={pct:0,used:0,size:0,state:"idle",sessions:[],agg:null,cached:0,fresh:0,cost:null,priceSet:false};
const WARN=55,CRIT=85;
const zone=p=>p>=CRIT?"crit":p>=WARN?"warn":"good";
const zc=z=>z==="crit"?C.red:z==="warn"?C.amber:C.green;
const sign=z=>z==="crit"?"stop":z==="warn"?"caution":"go";
// pose comes from the agent's real state, not a timer
const POSE={dig:"crouch",type:"crouch",hammer:"crouch",read:"hold",think:"stand",wake:"stand",
 flag:"hold",summon:"hold",stumble:"crouch",haul:"stand",stopSign:"hold",idle:"stand"};

function gauge(cx,cy,R,pct){
 for(let a=0;a<=180;a+=0.8){const r=a*Math.PI/180,p=a/180*100;
  const col=p>=CRIT?C.red:p>=WARN?C.amber:C.green;
  px(cx-R*Math.cos(r),cy-R*Math.sin(r),col);px(cx-(R-1)*Math.cos(r),cy-(R-1)*Math.sin(r),col);}
 const nr=cl(pct,0,100)/100*180*Math.PI/180,L=R-3,col=zc(zone(pct));
 for(let i=0;i<=L*2;i++){const f=i/(L*2);px(cx-L*f*Math.cos(nr),cy-L*f*Math.sin(nr),col);}
 px(cx-1,cy-1,C.steel,3,2);}
function lamps(cx,y,z,t){
 const L=[["good",C.green,C.greenOff],["warn",C.amber,C.amberOff],["crit",C.red,C.redOff]];
 for(let i=0;i<3;i++){const[zn,on,off]=L[i],lx=cx-8+i*6,lit=zn===z;
  blit(LAMP,{w:lit?on:off},lx,y);
  if(lit){ctx.globalAlpha=.22+.15*(sin(t,zn==="crit"?2.4:.7)+1)/2;px(lx-1,y-1,on,6,6);ctx.globalAlpha=1;}}}
function strata(x,base,h,wide){ // cached vs fresh — the real split in this data
 if(h<=0)return;const fr=Math.round(h*(M.fresh/Math.max(1,M.cached+M.fresh)));
 for(let i=0;i<h;i++){const isFresh=i>=h-fr;
  px(x,base-i,i%2?(isFresh?C.gold:C.teal):(isFresh?C.goldD:C.tealD),wide||1,1);}}
function crew(fy){ // one mini per live session
 const live=M.sessions.filter(s=>s.active).slice(0,6);
 live.forEach((s,i)=>{const cx=8+i*10;
  blit(["..oooo..",".oooooo.",".okoooko",".oooooo.","..dddd..","..o..o.."],
   {o:s.current?"#E8825A":"#7E8FB8",d:s.current?"#B85F3E":"#5B6A8C",k:"#2A1C14"},cx-4,fy-6,{});});
 return live.length;}

// ── the six skins. Same data, different exterior. ──
const SKINS={
 strip:{label:"strip",note:"What actually ships: 64px, him, a hairline meter, a sign.",
  draw(t){const fy=H-2,z=zone(M.pct);
   px(0,0,C.darker,W,1);px(0,0,zc(z),Math.max(1,Math.round(M.pct/100*W)),1);
   const pose=POSE[M.state]||"stand";
   body(Math.round(W/2),fy,pose);put(sign(z),Math.round(W/2)+5,fy-16);}},

 vault:{label:"vault",note:"Vault grows with what's held. Lamps match the sign; dial is the exact count.",
  draw(t){const fy=H-2,z=zone(M.pct),f=M.pct/100;
   if(z==="crit"){ctx.globalAlpha=.09+.05*(sin(t,1.5)+1)/2;ctx.fillStyle=C.red;ctx.fillRect(0,0,W*S,H*S);ctx.globalAlpha=1;}
   const vW=Math.round(16+f*(Math.round(W*.70)-16)),vH=Math.round(13+f*(H-7-13));
   const vR=W-3,vL=vR-vW,vT=fy-vH;
   px(vL,vT,C.darker,vW,vH);px(vL,vT,C.steelD,vW,1);px(vL,fy,C.steelD,vW,1);px(vL,vT,C.steelD,1,vH);
   const wL=vL+8,wR=vR-3,wT=vT+3,wB=fy-9,wW=Math.max(2,wR-wL),wH=Math.max(2,wB-wT);
   px(wL-1,wT-1,C.steelD,wW+2,wH+2);px(wL,wT,C.glass,wW,wH);
   for(let i=0;i<wH;i++)strata(wL,wB-1-i,1,wW);
   const lz=[["crit",C.red,C.redOff],["warn",C.amber,C.amberOff],["good",C.green,C.greenOff]];
   for(let i=0;i<3;i++){const[zn,on,off]=lz[i],ly=vT+3+i*5;if(ly+4>fy-1)break;
    blit(LAMP,{w:zn===z?on:off},vL+2,ly);
    if(zn===z){ctx.globalAlpha=.2+.14*(sin(t,zn==="crit"?2.4:.7)+1)/2;px(vL+1,ly-1,on,6,6);ctx.globalAlpha=1;}}
   const lbl=fmt(M.used),lw=numW(lbl);
   if(lw+4<vW-8){px(vL+Math.round((vW-lw)/2)-2,fy-8,"#0B0A09",lw+4,7);num(lbl,vL+Math.round((vW-lw)/2),fy-7,zc(z));}
   put("funnel",vL+Math.round(vW/2)-3,vT-4);
   const runR=vL-8,pose=POSE[M.state]||"stand";
   if(z==="crit"){const j=Math.round(Math.abs(sin(t,2.7))*5);body(Math.max(9,runR-2),fy-j,"hold");put("stop",Math.max(9,runR-2)+4,fy-16-j);}
   else{body(Math.max(9,Math.round(runR/2)),fy,pose);put(sign(z),Math.max(9,Math.round(runR/2))+5,fy-16);}
   crew(fy);}},

 scale:{label:"scale",note:"Needle sweeps the dial; the pan sinks under load. Lamps on the plinth.",
  draw(t){const fy=H-2,z=zone(M.pct),f=M.pct/100;
   if(z==="crit"){ctx.globalAlpha=.09;ctx.fillStyle=C.red;ctx.fillRect(0,0,W*S,H*S);ctx.globalAlpha=1;}
   const sx=Math.round(W*.64),R=14,cy=fy-14,bL=sx-R-5,bW=(R+5)*2,bT=cy-R-3;
   px(bL,bT,C.darker,bW,fy-bT);px(bL,bT,C.steelD,bW,1);px(bL,fy,C.steelD,bW,1);
   gauge(sx,cy,R,M.pct);
   const lbl=fmt(M.used),lw=numW(lbl);
   px(sx-Math.round(lw/2)-2,cy+2,"#0B0A09",lw+4,7);num(lbl,sx-Math.round(lw/2),cy+3,zc(z));
   lamps(sx,cy+10,z,t);
   const sink=Math.round(f*5),pY=bT-16+sink,pW=34,pL=sx-17;
   for(let y=pY+2;y<bT;y+=2)px(sx-2,y,C.steelD,5,1);
   px(sx-1,pY+1,C.steel,3,bT-pY);px(pL,pY,C.steel,pW,2);
   for(let c=1;c<pW-1;c++){const m=Math.sin(c/(pW-2)*Math.PI);
    strata(pL+c,pY-1,Math.round(f*11*(.45+m*.75)));}
   const runR=bL-9,pose=POSE[M.state]||"stand";
   body(Math.max(8,Math.round(runR/2)),fy,pose);put(sign(z),Math.max(8,Math.round(runR/2))+5,fy-16);
   crew(fy);}},

 barrels:{label:"barrels",note:"Two barrels on a platform; he gets squeezed between them as they fill.",
  draw(t){const fy=H-2,z=zone(M.pct),f=M.pct/100;
   const sx=Math.round(W/2),R=13,cy=fy-14,bT=cy-R-3;
   px(sx-19,bT,C.darker,38,fy-bT);px(sx-19,bT,C.steelD,38,1);px(sx-19,fy,C.steelD,38,1);
   gauge(sx,cy,R,M.pct);
   const lbl=fmt(M.used),lw=numW(lbl);
   px(sx-Math.round(lw/2)-2,cy+2,"#0B0A09",lw+4,7);num(lbl,sx-Math.round(lw/2),cy+3,zc(z));
   lamps(sx,cy+10,z,t);
   const pY=bT-7+Math.round(f*5),pL=4,pR=W-5,pW=pR-pL;
   px(pL,pY,C.steel,pW,2);
   const grow=pW*.72,share=M.cached/Math.max(1,M.cached+M.fresh);
   const lW=Math.round(7+f*share*grow),rW=Math.round(7+f*(1-share)*grow);
   const maxBH=Math.min(22,bT-10);
   const bar=(bx,bw,bh,ca,cb)=>{if(bw<3||bh<2)return;
    px(bx,pY-bh,C.glass,bw,bh);
    for(let i=0;i<bh-1;i++)px(bx+1,pY-1-i,i%2?ca:cb,Math.max(1,bw-2),1);
    px(bx,pY-bh,C.lip,bw,1);px(bx,pY-bh,C.lip,1,bh);px(bx+bw-1,pY-bh,C.lip,1,bh);};
   bar(pL+1,lW,Math.min(maxBH,Math.round(6+f*share*2*(maxBH-6))),C.teal,C.tealD);
   bar(pR-1-rW,rW,Math.min(maxBH,Math.round(6+f*(1-share)*2*(maxBH-6))),C.gold,C.goldD);
   const runL=pL+lW+1,runR=pR-1-rW,run=Math.max(0,runR-runL-12);
   const pose=POSE[M.state]||"stand";
   if(z==="crit"||run<3){const j=Math.round(Math.abs(sin(t,2.7))*5),cx=Math.round((runL+runR)/2);
    body(cx,pY-j,"hold");put("stop",cx+4,pY-16-j);}
   else{const cx=Math.round(runL+6+run/2);body(cx,pY,pose);put(sign(z),cx+5,pY-16);}}},

 runway:{label:"runway",note:"Piles close in from both ends and eat his floor. Pinned means full.",
  draw(t){const fy=H-2,z=zone(M.pct),f=M.pct/100,maxH=H-6;
   const half=W/2,reach=f*(half-7),lE=Math.round(reach),rE=Math.round(W-reach);
   for(let c=0;c<W;c++){let d=0;
    if(c<lE)d=1-c/Math.max(1,lE);else if(c>rE)d=1-(W-1-c)/Math.max(1,W-1-rE);
    if(d<=0)continue;strata(c,fy,Math.max(1,Math.round(maxH*Math.pow(d,.75)*.92+lump(c)*2)));}
   const runL=lE+7,runR=rE-7,run=runR-runL,pose=POSE[M.state]||"stand";
   if(run<4||z==="crit"){const j=Math.round(Math.abs(sin(t,2.7))*6),cx=Math.round((runL+runR)/2);
    body(cx,fy-j,"hold");put("stop",cx+4,fy-16-j);
    ctx.globalAlpha=.09+.06*(sin(t,1.5)+1)/2;ctx.fillStyle=C.red;ctx.fillRect(0,0,W*S,H*S);ctx.globalAlpha=1;}
   else{body(Math.round(runL+run/2),fy,pose);put(sign(z),Math.round(runL+run/2)+5,fy-16);}
   px(2,1,C.dark,W-4,1);px(2,1,zc(z),Math.max(0,Math.round(run/Math.max(1,W-14)*(W-4))),1);}},

 mountain:{label:"mountain",note:"The pile grows with the window. Height tracks context linearly.",
  draw(t){const fy=H-1,maxH=H-5,f=M.pct/100,z=zone(M.pct);
   if(!SKINS.mountain._h||SKINS.mountain._h.length!==W)SKINS.mountain._h=new Array(W).fill(0);
   const hs=SKINS.mountain._h,dx=Math.round(W*.44);
   const target=f*f*(W*maxH*.62);let vol=0;for(const v of hs)vol+=v;
   const rate=Math.max(1,Math.min(14,Math.ceil(Math.abs(vol-target)/30)));
   if(vol<target)for(let n=0;n<rate;n++){let c=dx;
    for(let g=0;g<60;g++){const l=hs[c-1]??1e9,r=hs[c+1]??1e9;
     if(hs[c]-l>1&&l<=r)c--;else if(hs[c]-r>1)c++;else break;}
    if(hs[c]<maxH)hs[c]++;}
   else if(vol>target)for(let n=0;n<rate;n++){let b=-1,bh=-1;
    for(let c=0;c<W;c++)if(hs[c]>bh){bh=hs[c];b=c}if(b>=0&&hs[b]>0)hs[b]--;}
   for(let c=0;c<W;c++)if(hs[c])strata(c,fy,hs[c]);
   const stX=cl(dx+16,8,W-8),stY=fy-(hs[Math.round(stX)]||0);
   body(Math.round(stX),stY,POSE[M.state]||"stand");
   if(z==="crit")put("stop",Math.round(stX)+4,stY-16);
   for(let x=0;x<W;x+=3)px(x,fy-maxH,z==="crit"?C.red:"#6A6259",1,1);}},
};

// ── plumbing ──
const cv=document.getElementById("cv"),cx2=cv.getContext("2d");cx2.imageSmoothingEnabled=false;
// Default to the skin with the character in it. "vault" was an abstract meter, so a
// first-time visitor landed on a page with no mascot and no obvious way to find one.
let skin=localStorage.getItem("fmn.skin")||"strip";
const bar=document.getElementById("skins");
const btns={};
for(const k of Object.keys(SKINS)){
 const b=document.createElement("button");b.className="skin";b.type="button";b.textContent=SKINS[k].label;
 b.addEventListener("click",()=>{skin=k;localStorage.setItem("fmn.skin",k);paintSkins();
  if(typeof draw==="function")draw();});
 bar.insertBefore(b,document.getElementById("liveTag"));btns[k]=b;}
function paintSkins(){for(const k in btns)btns[k].setAttribute("aria-pressed",String(k===skin));}
paintSkins();

function fit(){const r=cv.getBoundingClientRect();if(r.width<2)return;
 const dpr=Math.min(devicePixelRatio||1,2);
 cv.width=Math.round(r.width*dpr);cv.height=Math.round(r.height*dpr);
 cx2.setTransform(dpr,0,0,dpr,0,0);cx2.imageSmoothingEnabled=false;
 W=Math.floor(r.width/4);H=Math.floor(r.height/4);}
// fit() bails when the canvas has no layout yet, which is the normal state on the very
// first run of an inline script. It used to be called exactly once here, so losing that
// race left the backing store at the HTML default of 300x150 while CSS stretched it to
// full width — a ~3.6x upscale of a low-res buffer, permanently blurry, with no event
// that would ever retry. Measured on a real load: 300x150 painted into 1074x300, i.e.
// 8% of the pixels it should have had. A ResizeObserver fires once layout exists and
// again on every size change, so the race cannot be lost and cannot go unrecovered.
addEventListener("resize",fit);
if(typeof ResizeObserver==="function"){new ResizeObserver(()=>{fit();draw();}).observe(cv);}
fit();

// One draw. Kept separate from the rAF loop because rAF is PAUSED in a background tab
// while setInterval keeps polling — so without this the numbers advance and the picture
// silently freezes, and you come back to a stale frame that looks current.
function draw(now){
 ctx=cx2;S=4;cx2.clearRect(0,0,cv.width,cv.height);
 try{SKINS[skin].draw(now??performance.now())}catch(e){if(!draw.w){draw.w=1;console.error("skin",skin,e)}}}
window.__draw=draw;
function frame(now){draw(now);requestAnimationFrame(frame);}
requestAnimationFrame(frame);
// repaint the moment the tab comes back, and whenever the skin changes
document.addEventListener("visibilitychange",()=>{if(!document.hidden){fit();draw();}});

const el=id=>document.getElementById(id);
async function poll(){
 try{
  const r=await fetch("/api/state",{cache:"no-store"});if(!r.ok)return;
  const j=await r.json();
  const c=j.current;
  M.pct=c?.ctxPct??0;M.used=c?.ctxUsed??0;M.size=c?.ctxSize??0;M.state=c?.state??"idle";
  M.sessions=j.sessions||[];M.cost=j.aggregate?.costUsd??null;M.priceSet=j.priceSet;
  const T=j.aggregate?.totals||{};
  M.cached=(T.cacheReadTokens||0)+(T.cacheCreateTokens||0);
  M.fresh=(T.inputTokens||0)+(T.outputTokens||0);
  const z=zone(M.pct),zv=z==="crit"?"var(--crit)":z==="warn"?"var(--warn)":"var(--good)";
  el("read").innerHTML=
   '<span>ctx <b style="color:'+zv+'">'+Math.round(M.pct)+'%</b></span>'+
   '<span>'+fmt(M.used)+' / '+fmt(M.size)+'</span>'+
   '<span>state <b>'+M.state+'</b></span>'+
   '<span>'+(c?.model||'—')+'</span>'+
   '<span>'+(M.cost!=null?'<b>$'+M.cost.toFixed(2)+'</b> est':'<span style="color:var(--warn)">no price set</span>')+'</span>'+
   '<span class="zone" style="color:'+zv+'">'+(z==="crit"?"start a fresh window":z==="warn"?"getting tight":"room to work")+'</span>';
  el("read").title=SKINS[skin].note;

  el("rows").innerHTML=(j.sessions||[]).slice(0,14).map(s=>{
   const p=s.ctxPct??0,k=p>=CRIT?"c":p>=WARN?"w":"";
   const age=s.ageMs==null?"—":s.ageMs<60000?Math.round(s.ageMs/1000)+"s":s.ageMs<3600000?Math.round(s.ageMs/60000)+"m":Math.round(s.ageMs/3600000)+"h";
   return '<div class="row"><span class="dot '+(s.current?"cur":s.active?"on":"")+'"></span>'+
    '<b>'+s.short+'</b><span>'+age+'</span><b>'+Math.round(p)+'%</b>'+
    '<span class="mini"><i class="'+k+'" style="width:'+cl(p,0,100)+'%"></i></span></div>';}).join("");
  const a=j.aggregate||{};
  el("aggNote").textContent=a.sessions+" sessions tracked · "+a.live+" active in the last 5 min. Each one only ever shows you its own share.";

  const rows=[["input",T.inputTokens||0,"var(--in)"],["output",T.outputTokens||0,"var(--out)"],
   ["cache read",T.cacheReadTokens||0,"var(--cache)"],["cache write",T.cacheCreateTokens||0,"var(--cachew)"]];
  const mx=Math.max(1,...rows.map(r=>r[1]));
  el("tok").innerHTML=rows.map(([n,v,col])=>
   '<div class="tokrow"><span>'+n+'</span><span class="tbar"><i style="width:'+
   (Math.log10(v+1)/Math.log10(mx+1)*100).toFixed(1)+'%;background:'+col+'"></i></span><b>'+v.toLocaleString()+'</b></div>').join("");
  el("tokNote").textContent="Log scale — cache reads outweigh fresh output by roughly "+
   Math.round((T.cacheReadTokens||0)/Math.max(1,T.outputTokens||1))+"×, which linear bars can't show.";

  const pw=el("priceWarn");
  if(!j.priceSet){pw.hidden=false;
   pw.innerHTML="<b>No price set</b>, so every dollar figure is blank by design — a guessed rate is worse than nothing. Set one with <code>fmn set price &lt;preset&gt;</code> once you've checked the rate against a dated source.";}
  else pw.hidden=true;
  // paint once per poll so a backgrounded tab never shows numbers newer than its picture
  if(document.hidden&&typeof draw==="function")draw();
 }catch(e){}
}
poll();setInterval(poll,2000);
</script></body></html>`;
