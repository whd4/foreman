// The live view — one SVG DOM, mutated on events.
//
// This is deliberately NOT the terminal renderer in a browser. The terminal redraws
// every 80ms because a terminal has no other option. A DOM does: the document is
// emitted once, motion is declared in CSS keyframes the browser owns, and JavaScript
// only writes attributes when something actually changes. A six-turn session costs a
// few dozen attribute writes instead of thousands of repaints, and an idle tab costs
// nothing at all.
//
// The rule that follows from that: no requestAnimationFrame, no setInterval, no timer
// of any kind ships in the generated page. There is a test asserting exactly that.
//
// What a host application does:
//   const html = liveDocument(pack)            // write to a file, or load as a data URL
//   view.foreman.setState("hammer")            // on a hook firing
//   view.foreman.setHud({ ctxPct: 62, costUsd: 4.10 })   // on a status-line payload

import { Frame } from "./render.js";
import { mergeRects, rectsToMarkup } from "./svg.js";
import { STATES, CTX_HAUL, CTX_STOP } from "./engine.js";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * How each state looks when the browser is doing the animating.
 *
 * The terminal states are procedural functions of elapsed time. CSS cannot run those,
 * so each state declares a pose (or a two-frame walk cycle), an optional prop, and a
 * named keyframe animation. Poses and props named here are OPTIONAL beyond the pack
 * contract — resolve() below drops anything the pack does not define, so a minimal
 * pack still renders every state.
 */
export const MOTION = {
  idle:      { pose: "stand",             anim: "breathe" },
  patrol:    { cycle: ["stepA", "stepB"], anim: "patrol" },
  doze:      { pose: "crouch",            anim: "doze",    prop: "z" },
  wake:      { pose: "stand",             anim: "rise" },
  ping:      { pose: "stand",             anim: "hop",     prop: "bang" },

  think:     { pose: "stand",             anim: "think",   prop: "q" },
  read:      { pose: "hold",              anim: "bob",     prop: "page" },
  dig:       { pose: "crouch",            anim: "dig",     prop: "shovel" },
  type:      { pose: "crouch",            anim: "type" },
  hammer:    { pose: "stand",             anim: "hammer",  prop: "hammer" },
  sprint:    { cycle: ["stepA", "stepB"], anim: "sprint" },
  haul:      { cycle: ["stepA", "stepB"], anim: "haul",    prop: "crate" },
  juggle:    { pose: "hold",              anim: "juggle",  prop: "coin" },

  summon:    { pose: "hold",              anim: "summon" },
  flip:      { pose: "crouch",            anim: "flip" },

  stopSign:  { pose: "hold",              anim: "shake",   prop: "stop" },
  stumble:   { pose: "slump",             anim: "stumble", prop: "star" },
  facepalm:  { pose: "slump",             anim: "sink" },

  flag:      { pose: "hold",              anim: "wave",    prop: "flag" },
  highFive:  { pose: "hold",              anim: "bounce",  prop: "star" },
  refute:    { pose: "slump",             anim: "sink" },
  trophy:    { pose: "hold",              anim: "lift",    prop: "trophy" },
};

/** Resolve MOTION against one pack, dropping poses and props it does not define. */
export function resolveMotion(pack) {
  const out = {};
  for (const [name, m] of Object.entries(MOTION)) {
    const cycle = (m.cycle ?? [m.pose ?? "stand"]).filter((p) => pack.poses[p]);
    out[name] = {
      cycle: cycle.length ? cycle : ["stand"],
      prop: m.prop && pack.props[m.prop] ? m.prop : null,
      anim: m.anim ?? "none",
      caption: STATES[name]?.why ?? "",
    };
  }
  return out;
}

/** Every pose and prop the resolved motion table can ask for. */
function usedArt(pack, motion) {
  const poses = new Set();
  const props = new Set();
  for (const m of Object.values(motion)) {
    for (const p of m.cycle) poses.add(p);
    if (m.prop) props.add(m.prop);
  }
  return { poses: [...poses].filter((p) => pack.poses[p]), props: [...props].filter((p) => pack.props[p]) };
}

/**
 * Which walk-cycle slot a pose occupies, or null.
 * The two frames alternate under a CSS animation, so each needs a stable hook. Position
 * among siblings will not do: poses and props are both <g> children of the actor, so
 * nth-of-type() would land on whatever happens to be second in the document.
 */
function cycleSlot(motion, name) {
  for (const m of Object.values(motion)) {
    if (m.cycle.length < 2) continue;
    const i = m.cycle.indexOf(name);
    if (i === 0) return "a";
    if (i === 1) return "b";
  }
  return null;
}

function poseGroup(pack, name, slot) {
  const grid = pack.poses[name];
  const f = new Frame(grid[0].length, grid.length);
  f.blit(grid, pack.palette, 0, 0);
  const cyc = slot ? ` data-cyc="${slot}"` : "";
  return `      <g data-pose="${esc(name)}"${cyc} style="display:none">\n${rectsToMarkup(mergeRects(f), { indent: "        " })}\n      </g>`;
}

function propGroup(pack, name, x, y) {
  const prop = pack.props[name];
  const f = new Frame(prop.grid[0].length, prop.grid.length);
  f.blit(prop.grid, { ...pack.palette, ...(prop.palette || {}) }, 0, 0);
  return `      <g data-prop="${esc(name)}" transform="translate(${x} ${y})" style="display:none">\n${rectsToMarkup(mergeRects(f), { indent: "        " })}\n      </g>`;
}

/**
 * Build the whole page. Self-contained: no external stylesheet, font, script or image,
 * so it works from a file:// URL, a data: URL, or inside a webview with a strict CSP.
 */
export function liveDocument(pack, {
  scale = 6,
  caption = true,
  meter = true,
  background = "transparent",
  state = "idle",
  title,
} = {}) {
  const [cw, ch] = pack.size;
  const [handX, handY] = pack.hand ?? [Math.ceil(cw / 2), 8];
  const motion = resolveMotion(pack);
  const art = usedArt(pack, motion);

  // Props hang off the hand; the tallest one decides how far above the head the
  // viewBox has to reach, or a raised stop sign gets clipped.
  let minY = 0;
  const propXY = {};
  for (const name of art.props) {
    const h = pack.props[name].grid.length;
    const y = ch - handY - h;
    propXY[name] = [handX, y];
    if (y < minY) minY = y;
  }

  const vx = -5, vy = minY - 4;
  const vw = cw + 10, vh = ch + 1 - vy;
  const cx = cw / 2, cy = ch; // growth pivots on the feet, not the middle

  const poses = art.poses.map((p) => poseGroup(pack, p, cycleSlot(motion, p))).join("\n");
  const props = art.props.map((p) => propGroup(pack, p, propXY[p][0], propXY[p][1])).join("\n");

  // Written without backticks or ${ } so it survives being embedded here verbatim.
  const runtime = [
    "(function(){",
    "  var root=document.getElementById('fm-root');",
    "  if(!root)return;",
    "  var poses=root.querySelectorAll('[data-pose]');",
    "  var props=root.querySelectorAll('[data-prop]');",
    "  var scaleG=document.getElementById('fm-scale');",
    "  var capEl=document.getElementById('fm-caption');",
    "  var fillEl=document.getElementById('fm-fill');",
    "  var costEl=document.getElementById('fm-cost');",
    "  var pctEl=document.getElementById('fm-pct');",
    "  var MOTION=" + JSON.stringify(motion) + ";",
    "  var HAUL=" + CTX_HAUL + ",STOP=" + CTX_STOP + ";",
    "  var hud={ctxPct:null,costUsd:null};",
    "  var want=" + JSON.stringify(state) + ";",
    "  var shown=null;",
    "  function show(list,attr,names){",
    "    for(var i=0;i<list.length;i++){",
    "      var on=names.indexOf(list[i].getAttribute(attr))>=0;",
    "      var v=on?'':'none';",
    "      if(list[i].style.display!==v)list[i].style.display=v;",
    "    }",
    "  }",
    "  function resolve(){",
    "    var s=want;",
    "    if(typeof hud.ctxPct==='number'&&isFinite(hud.ctxPct)){",
    "      if(hud.ctxPct>=STOP)s='stopSign';",
    "      else if(hud.ctxPct>=HAUL&&(s==='idle'||s==='patrol'||s==='haul'))s='haul';",
    "    }",
    "    return s;",
    "  }",
    "  function apply(){",
    "    var name=resolve();",
    "    if(name===shown)return;",
    "    shown=name;",
    "    var m=MOTION[name]||MOTION.idle;",
    "    show(poses,'data-pose',m.cycle);",
    "    show(props,'data-prop',m.prop?[m.prop]:[]);",
    "    root.setAttribute('data-state',name);",
    "    root.setAttribute('data-anim',m.anim);",
    "    root.setAttribute('data-cycle',m.cycle.length>1?'1':'0');",
    "    if(capEl){",
    "      capEl.textContent=m.caption||'';",
    "      capEl.classList.remove('fm-flash');",
    "      void capEl.offsetWidth;",  // restart the one-shot flash; no timer involved
    "      capEl.classList.add('fm-flash');",
    "    }",
    "  }",
    "  var api={",
    "    setState:function(n){",
    "      if(!MOTION[n])throw new Error(\"unknown state '\"+n+\"'\");",
    "      want=n;apply();return api;",
    "    },",
    "    setHud:function(h){",
    "      if(!h)return api;",
    "      if(typeof h.ctxPct==='number')hud.ctxPct=h.ctxPct;",
    "      if(typeof h.costUsd==='number')hud.costUsd=h.costUsd;",
    "      var p=Math.max(0,Math.min(100,hud.ctxPct||0));",
    "      if(fillEl)fillEl.style.width=p+'%';",
    "      if(pctEl)pctEl.textContent=Math.round(p)+'%';",
    "      if(costEl&&typeof hud.costUsd==='number')costEl.textContent='$'+hud.costUsd.toFixed(2);",
    "      root.setAttribute('data-pressure',p>=STOP?'stop':p>=HAUL?'warn':'ok');",
    "      if(scaleG){",
    // he grows as the window fills — full mascot means full window, never inverted
    "        var k=(0.74+0.26*(p/100)).toFixed(4);",
    "        scaleG.setAttribute('transform','translate(" + cx + " " + cy + ") scale('+k+') translate(" + -cx + " " + -cy + ")');",
    "      }",
    "      apply();return api;",
    "    },",
    "    state:function(){return resolve();},",
    "    hud:function(){return {ctxPct:hud.ctxPct,costUsd:hud.costUsd};},",
    "    states:Object.keys(MOTION)",
    "  };",
    "  window.foreman=api;",
    "  apply();",
    "})();",
  ].join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title ?? `foreman — ${pack.name}`)}</title>
<style>
  /* Motion is declared here and owned by the browser. Nothing in this page animates
     from JavaScript, so an idle or backgrounded view costs nothing. */
  :root { --fm-ok:#63C97C; --fm-warn:#E5B54F; --fm-stop:#D8543F; --fm-dim:#9c8f83; --fm-fg:#efe7dd; }
  * { box-sizing:border-box; }
  body { margin:0; background:${esc(background)}; color:var(--fm-fg);
         font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }

  #fm-root { display:inline-flex; flex-direction:column; gap:4px; padding:6px 8px; user-select:none; }
  #fm-stage { display:block; overflow:visible; }
  #fm-stage svg, #fm-root svg { shape-rendering:crispEdges; }
  #fm-actor { transform-box:fill-box; transform-origin:50% 100%; }

  /* the strip: him, a hairline meter, a sign — everything else lives one click behind */
  #fm-hud { display:flex; align-items:center; gap:6px; font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
  /* both must be block: a span left inline ignores width and height, and the meter
     silently renders at zero size while still reporting the right colour */
  #fm-track { display:block; flex:1 1 auto; min-width:52px; height:2px; border-radius:2px; background:#00000055; overflow:hidden; }
  #fm-fill { display:block; height:100%; width:0%; background:var(--fm-ok); transition:width .3s ease, background-color .3s ease; }
  #fm-root[data-pressure="warn"] #fm-fill { background:var(--fm-warn); }
  #fm-root[data-pressure="stop"] #fm-fill { background:var(--fm-stop); }
  #fm-pct, #fm-cost { color:var(--fm-dim); font-variant-numeric:tabular-nums; }

  /* one caption, then still — a sentence beats a metaphor and needs no decoding */
  #fm-caption { min-height:1.1em; font-size:11px; color:var(--fm-dim); opacity:0; }
  #fm-caption.fm-flash { animation:fm-say 4s ease-out forwards; }
  @keyframes fm-say { 0%{opacity:0} 8%{opacity:1} 70%{opacity:1} 100%{opacity:0} }

  [data-cycle="1"] [data-cyc="a"] { animation:fm-cycA .3s steps(1) infinite; }
  [data-cycle="1"] [data-cyc="b"] { animation:fm-cycB .3s steps(1) infinite; }
  @keyframes fm-cycA { 0%,49.9%{opacity:1} 50%,100%{opacity:0} }
  @keyframes fm-cycB { 0%,49.9%{opacity:0} 50%,100%{opacity:1} }

  [data-anim="breathe"] #fm-actor { animation:fm-breathe 3.6s ease-in-out infinite; }
  [data-anim="doze"]    #fm-actor { animation:fm-breathe 5.4s ease-in-out infinite; }
  [data-anim="bob"]     #fm-actor { animation:fm-bob 1.9s ease-in-out infinite; }
  [data-anim="think"]   #fm-actor { animation:fm-bob 2.6s ease-in-out infinite; }
  [data-anim="hop"]     #fm-actor { animation:fm-hop .52s ease-in-out infinite; }
  [data-anim="bounce"]  #fm-actor { animation:fm-hop .42s ease-in-out infinite; }
  [data-anim="type"]    #fm-actor { animation:fm-tap .26s steps(2) infinite; }
  [data-anim="dig"]     #fm-actor { animation:fm-tap .62s steps(2) infinite; }
  [data-anim="hammer"]  #fm-actor { animation:fm-swing .5s ease-in infinite; }
  [data-anim="shake"]   #fm-actor { animation:fm-shake .42s ease-in-out infinite; }
  [data-anim="stumble"] #fm-actor { animation:fm-tip .9s ease-out forwards; }
  [data-anim="sink"]    #fm-actor { animation:fm-sink .8s ease-out forwards; }
  [data-anim="rise"]    #fm-actor { animation:fm-rise .9s cubic-bezier(.2,.9,.3,1) forwards; }
  [data-anim="lift"]    #fm-actor { animation:fm-lift 1.1s ease-out forwards; }
  [data-anim="wave"]    #fm-actor { animation:fm-bob 1.1s ease-in-out infinite; }
  [data-anim="summon"]  #fm-actor { animation:fm-breathe 1.8s ease-in-out infinite; }
  [data-anim="juggle"]  #fm-actor { animation:fm-bob 1.3s ease-in-out infinite; }
  [data-anim="flip"]    #fm-actor { animation:fm-flip 1s ease-in-out infinite; }
  [data-anim="patrol"]  #fm-actor { animation:fm-walk 5.2s ease-in-out infinite; }
  [data-anim="sprint"]  #fm-actor { animation:fm-walk 1.9s linear infinite; }
  [data-anim="haul"]    #fm-actor { animation:fm-walk 7.4s ease-in-out infinite; }

  @keyframes fm-breathe { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(.97) translateY(2%)} }
  @keyframes fm-bob     { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6%)} }
  @keyframes fm-hop     { 0%,100%{transform:translateY(0)} 45%{transform:translateY(-26%)} }
  @keyframes fm-tap     { 0%{transform:translateY(0)} 50%,100%{transform:translateY(-7%)} }
  @keyframes fm-swing   { 0%,54%{transform:rotate(0)} 68%{transform:rotate(9deg)} 100%{transform:rotate(0)} }
  @keyframes fm-shake   { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-7%)} 75%{transform:translateX(7%)} }
  @keyframes fm-tip     { 0%{transform:rotate(0) translateX(0)} 100%{transform:rotate(7deg) translateX(9%)} }
  @keyframes fm-sink    { 0%{transform:translateY(0)} 100%{transform:translateY(9%) scaleY(.94)} }
  @keyframes fm-rise    { 0%{transform:translateY(120%) scaleY(.7)} 100%{transform:translateY(0) scaleY(1)} }
  @keyframes fm-lift    { 0%{transform:translateY(0)} 100%{transform:translateY(-12%)} }
  @keyframes fm-flip    { 0%,100%{transform:scaleX(1)} 50%{transform:scaleX(-1)} }
  @keyframes fm-walk    { 0%,100%{transform:translateX(-26%)} 50%{transform:translateX(26%)} }

  /* motion is a message, not decoration — if it is unwelcome, the readout still works */
  @media (prefers-reduced-motion:reduce) {
    #fm-root *, #fm-root *::before, #fm-root *::after { animation:none !important; transition:none !important; }
    #fm-caption { opacity:1; }
    [data-cycle="1"] [data-cyc="b"] { display:none !important; }
  }
</style></head>
<body>
<div id="fm-root" data-state="${esc(state)}" data-anim="breathe" data-cycle="0" data-pressure="ok">
  <svg id="fm-stage" xmlns="http://www.w3.org/2000/svg"
       viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw * scale}" height="${vh * scale}" aria-hidden="true">
    <g id="fm-scale">
      <g id="fm-actor">
${poses}
${props}
      </g>
    </g>
  </svg>
${meter ? `  <div id="fm-hud">
    <span id="fm-track"><span id="fm-fill"></span></span>
    <!-- 55% and 85% are conventions chosen for actionability, not measured degradation points -->
    <span id="fm-pct" title="share of the context window in use (thresholds are conventions, not measurements)">0%</span>
    <span id="fm-cost" title="session spend so far">$0.00</span>
  </div>` : ""}
${caption ? `  <div id="fm-caption"></div>` : ""}
</div>
<script>
${runtime}
</script>
</body></html>`;
}
