// app.js - the Metis front-end: camera, renderer, flare routing, chronicle ribbon.
//
// This lives in its own file rather than inline in index.html for one concrete reason:
// GitNexus's HTML parser does not extract inline <script>, so while this code sat inside
// index.html the entire front-end was a bare File node with ZERO symbols in the code
// graph. `context({name:'loadGraph'})` answered "Symbol not found" for a function that
// was right there. Every question about the renderer therefore cost a full-file read.
//
// Split out 2026-08-23 after measuring that cost - see tools/probe-lookup-cost.mjs.
// Keep it a real .js file. Folding it back into the HTML would make it invisible again.

const COLORS={knowledge:'#22ccff',feedback:'#f2b85c',library:'#b888ff',projects:'#54e6a6',
  agents:'#ff3344',decisions:'#ff4d9d',output:'#4a6a8a',root:'#6a7a94',missing:'#8a3b52'};
// The FileSystem backbone is the one place on this map where colour carries KIND
// rather than location, because a folder and a file sit in the same tree and the
// whole question you ask of it is "did it open the right kind of thing".
// Chosen to stay clear of the four domain colours already in use: FOLDER is a true
// blue (vault cyan is #22ccff), FILE a leaf green (mcp mint is #54e6a6).
const FS_FOLDER='#4b8fe8', FS_FILE='#7fd964', FS_MISSING='#8a6b3b', FS_ACCENT='#ffb020';
// Ring order for the category networks — must match CAT_ORDER in lib/systems.mjs, or
// the legend lists them in a different order from the one they are drawn in.
const CAT_ORDER=['knowledge','feedback','library','projects','agents','decisions','output','root','missing'];
const isFs=n=>n.domain==='fs';
function nodeCol(n){
  if(isFs(n)) return n.exists===false?FS_MISSING:(n.kind==='file'?FS_FILE:FS_FOLDER);
  return n.domain==='vault'?(COLORS[n.group]||'#6a7a94'):(ISLAND_COL[n.domain]||'#6a7a94');
}
// square = structural, ring = hub, point = leaf. Shape carries meaning, per the reference.
const BG='#050508';   // one source of truth: the clear colour AND the occlusion halo
const $=s=>document.querySelector(s);
const cv=$('#cv'), ctx=cv.getContext('2d'), tip=$('#tip');
let G=null,POS=null,FOCAL=680,W=0,H=0,DPR=Math.min(devicePixelRatio||1,2);
let yaw=1.240,pitch=Math.PI/2,zoom=0.72,panX=0,panY=0,drag=0,lx=0,ly=0,hoverI=-1;
// HOME is Jordan's chosen top-down pose (set 2026-08-22 from a live reading), and it
// is still exactly invertible, which is the point of having a fixed pose at all.
// At pitch=+PI/2: cp=0, sp=1, so y collapses to -z0 and depth becomes the world Y axis:
//     f  = FOCAL/(FOCAL + wy) * zoom * min(W,H)/620
//     sx = W/2 + panX + ( wx*cos(yaw) - wz*sin(yaw) ) * f
//     sy = H/2 + panY - ( wx*sin(yaw) + wz*cos(yaw) ) * f
// Inverting sx,sy back to world needs wy (the depth), same as any perspective view.
// The readout in the corner prints the live pose so ANY screenshot is self-describing.
const HOME={yaw:1.240,pitch:Math.PI/2};   // orientation only — zoom/pan are fitted
let atHome=false;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const flare=new Map(); let trail=[]; let pulses=[];
// Models RESIDENT in VRAM right now (`models::<name>`). A flare answers "what was
// just touched"; this answers "what is loaded" — a state, not an event, so it holds
// steady instead of decaying. Fed by the SSE 'models' broadcasts + one seed fetch.
const LIVEM=new Set();
// Call-lines: moon -> every node that model touched this session. Persistent, not
// decaying — the point is DIAGNOSIS ("what did it read"), and a line that fades is
// a line you have to have been watching. Clears on reload; the shim transcripts
// under .hermes-transcripts\ remain the durable forensic record.
const MOONL=new Map();
// Routes are pure functions of a graph that only changes on reload, so cache them.
let routeCache=new Map();
// Constant dash patterns — setLineDash([3,4]) allocated a fresh array per link.
// Colours match the key panel swatches exactly; alpha rides ctx.globalAlpha.
const EMPTY_DASH=[], DASH_PHANTOM=[3,4], DASH_PEER=[6,5], MOON_DASH=[2,5];
let LINK_PASSES=[];
const FLARE_MS=4200,TRAIL_MS=9000,TRAIL_MAX=12;

// Nothing on this canvas is invented. There is no starfield and no particle cloud —
// both were Math.random() with no referent. The core's energy IS real: it rises on
// vault touches, tool calls and thinking, then decays.
let coreEnergy=0, coreTarget=0;

// The canvas no longer fills the viewport — the chat rail takes the right edge —
// so size from the element's own box, not innerWidth/innerHeight, or the graph
// centres on the wrong point and sits half-under the chat.
// Size from the WRAPPER, never from the canvas itself — see the #stage comment.
const stage=document.getElementById('stage');
let CY=1,SY=0,CP=1,SP=0,VS=1,RECT_L=0,RECT_T=0;   // camera basis, viewport scale, cached canvas origin
let poseDirty=true, POSE_EL=null, fFrames=0, fT0=0, fpsTxt='';

function resize(){
  const r=stage.getBoundingClientRect();
  const w=Math.max(1,Math.min(8000,Math.round(r.width)));
  const h=Math.max(1,Math.min(8000,Math.round(r.height)));
  if(w===W&&h===H) return false;
  W=w;H=h; cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  const cr=cv.getBoundingClientRect(); RECT_L=cr.left; RECT_T=cr.top;
  syncCam();
  if(atHome) fitAll();            // window changed shape — keep everything in frame
  pose(); return true;
}
addEventListener('resize',resize); resize();
if(window.ResizeObserver) new ResizeObserver(()=>resize()).observe(stage);

function syncCam(){
  CY=Math.cos(yaw);SY=Math.sin(yaw);CP=Math.cos(pitch);SP=Math.sin(pitch);
  VS=zoom*(Math.min(W,H)/620);
}
function project(p){
  const x=p[0]*CY-p[2]*SY, z0=p[0]*SY+p[2]*CY;
  const y=p[1]*CP-z0*SP; let z=p[1]*SP+z0*CP;
  let den=FOCAL+z; if(den<140)den=140;
  const f=FOCAL/den*VS;
  return [W/2+panX+x*f, H/2+panY+y*f, z, f];
}

// The core is one node: Claude. Its only variable is activity, and that is measured
// (coreEnergy), not decorative — the ring brightens and thickens while work happens.
// The whole core — ring, dot AND label — draws LAST in the frame, not first: painted
// early, every link line lands on top and the circle disappears into the weave
// (Jordan's screenshot, 2026-08-26). Top z-order plus a stronger idle floor; activity
// still modulates brightness, but on top of a ring that is always clearly there.
function drawCoreTop(){
  coreEnergy += (coreTarget-coreEnergy)*0.055;
  const c=project([0,0,0]), sc=c[3], e=coreEnergy;
  const r=26*sc;
  ctx.strokeStyle='#ff3344';
  ctx.globalAlpha=0.75+e*0.25;
  ctx.lineWidth=2.6+e*2.2;
  ctx.shadowColor='#ff3344'; ctx.shadowBlur=14+e*22;
  ctx.beginPath(); ctx.arc(c[0],c[1],r,0,6.2832); ctx.stroke();
  ctx.shadowBlur=0;
  ctx.fillStyle='#ff3344'; ctx.globalAlpha=0.7+e*0.3;
  ctx.beginPath(); ctx.arc(c[0],c[1],2.6*sc+e*2*sc,0,6.2832); ctx.fill();
  ctx.globalAlpha=1;
  ctx.font='bold 13px ui-monospace,Consolas,monospace';
  ctx.lineJoin='round';
  ctx.lineWidth=4;
  ctx.strokeStyle=BG;
  ctx.strokeText('CLAUDE',c[0]+r+8,c[1]+4);
  ctx.fillStyle=e>0.15?'#ffffff':'#dfe8f2';
  ctx.fillText('CLAUDE',c[0]+r+8,c[1]+4);
}

function frame(now){
  requestAnimationFrame(frame);
  resize();
  syncCam();
  ctx.fillStyle=BG; ctx.fillRect(0,0,W,H);
  if(!G) return;
  // The graph does not spin. It only moves when Jordan moves it — a map you can
  // point at is worth more than one that drifts out from under the thing you meant.
  const t=Date.now();

  const P=new Array(G.nodes.length);
  // USED-ONLY hides a node by nulling its PROJECTION, not by adding a check to each
  // pass. Links, the backbone, the node loop and the label pass all already skip a
  // null, so one line here hides a node from every pass and they cannot disagree.
  const cull=culling();
  for(let i=0;i<G.nodes.length;i++){
    const p=(cull&&!SHOWN.has(i))?null:POS[G.nodes[i].id];
    P[i]=p?project(p):null;
  }

  // intra-network links, drawn in three batches so line-dash and colour are set
  // three times per frame instead of once per link. Alpha rides globalAlpha, so
  // no rgba() string is built per link.
  ctx.lineWidth=1;
  for(const {dash,col,base,segs} of LINK_PASSES){
    if(!segs.length) continue;
    ctx.setLineDash(dash); ctx.strokeStyle=col;
    for(let s=0;s<segs.length;s+=3){
      const a=P[segs[s]],b=P[segs[s+1]],half=segs[s+2];
      if(!a||!b) continue;
      // Depth gradient on the ink: at /2600 near and far links were within 25% of
      // each other and the whole web sat on one plane. /2000 pulls the far side back.
      const al=base-((a[2]+b[2])/2)/2000;
      if(al<=0.02) continue;
      ctx.globalAlpha=al;
      ctx.beginPath();
      if(half===0){ ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); }
      else{ const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
        if(half===1){ ctx.moveTo(a[0],a[1]); ctx.lineTo(mx,my); }
        else        { ctx.moveTo(mx,my);     ctx.lineTo(b[0],b[1]); } }
      ctx.stroke();
    }
  }
  ctx.globalAlpha=1; ctx.setLineDash(EMPTY_DASH);

  // BACKBONE — core to each island gateway. Deliberately the heaviest line on
  // screen: it is the one link that says these are separate networks.
  for(const l of G.backbone){
    const a=P[G.index[l.source]],b=P[G.index[l.target]];
    if(!a||!b) continue;
    // The spur wears the colour of whatever it terminates on. That used to be the
    // DOMAIN colour, which was fine when the only backbone targets were islands; now
    // that every vault category has its own gateway, domain would paint all nine of
    // them the same cyan. nodeCol() already answers this correctly for both.
    const col=nodeCol(G.nodes[G.index[l.target]]);
    ctx.strokeStyle=col; ctx.globalAlpha=0.30; ctx.lineWidth=2.2;
    ctx.shadowColor=col; ctx.shadowBlur=7;
    ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    ctx.shadowBlur=0; ctx.globalAlpha=1;
  }

  // CALL-LINES — moon to every node that model touched this session. Straight
  // magenta chords, faint and persistent: this layer is the diagnosis ("what did
  // ox-alpha actually read"), drawn deliberately as direct lines rather than routed
  // paths — the routed pulse already showed the journey; this shows the SET.
  if(MOONL.size){
    ctx.setLineDash(MOON_DASH); ctx.strokeStyle=ISLAND_COL.models; ctx.lineWidth=1;
    for(const {a:ai,b:bi} of MOONL.values()){
      const a=P[G.index[ai]],b=P[G.index[bi]];
      if(!a||!b) continue;
      ctx.globalAlpha=0.20;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    }
    ctx.setLineDash(EMPTY_DASH); ctx.globalAlpha=1;
  }

  // recall trail
  // RECALL TRAIL — the order notes were touched in. It is now routed through the
  // graph like the flare is, instead of cutting a straight line between two nodes that
  // may be on opposite sides of the map with no edge between them. A chord across the
  // middle of Metis was drawing a relationship that does not exist.
  trail=trail.filter(x=>t-x.at<TRAIL_MS);
  if(trail.length>1){
    ctx.lineWidth=1.5; ctx.lineCap='round';
    for(let i=0;i<trail.length-1;i++){
      const hop=route(G.index[trail[i].id],G.index[trail[i+1].id]);
      if(!hop) continue;
      const age=(t-trail[i+1].at)/TRAIL_MS, al=Math.max(0,0.9*(1-age));
      if(al<=0.01) continue;
      ctx.strokeStyle=`rgba(34,204,255,${al.toFixed(3)})`;
      ctx.shadowColor='#22ccff'; ctx.shadowBlur=9*(1-age);
      ctx.beginPath();
      let moved=false;
      for(const idx of hop){
        const q=P[idx]; if(!q){moved=false;continue;}
        if(moved) ctx.lineTo(q[0],q[1]); else { ctx.moveTo(q[0],q[1]); moved=true; }
      }
      ctx.stroke();
    }
    ctx.shadowBlur=0;
  }

  // FLARE ROUTING — a touch travels the real path from the core out to whatever it hit,
  // hop by hop, instead of simply appearing there. Running Bash now draws
  // CLAUDE -> TOOLS -> Bash along edges that exist, which is the difference between the
  // map stating a fact and the map showing a route. The node only lights when the head
  // ARRIVES, so the order you read off the screen is the order things happened in.
  if(pulses.length){
    ctx.lineCap='round';
    for(let pi=pulses.length-1;pi>=0;pi--){
      const pu=pulses[pi], prog=(t-pu.at)/pu.dur;
      if(prog>=1){
        flare.set(G.nodes[pu.path[pu.path.length-1]].id,{at:t});
        pulses.splice(pi,1); continue;
      }
      const hops=pu.path.length-1;
      const x=prog*hops, seg=Math.min(hops-1,Math.floor(x)), f=x-seg;
      const a=P[pu.path[seg]], b=P[pu.path[seg+1]];
      if(!a||!b) continue;
      const hx=a[0]+(b[0]-a[0])*f, hy=a[1]+(b[1]-a[1])*f;
      ctx.strokeStyle=pu.col; ctx.shadowColor=pu.col; ctx.shadowBlur=10; ctx.lineWidth=2.2;
      for(let k=0;k<=seg;k++){
        const u=P[pu.path[k]], v=P[pu.path[k+1]]; if(!u||!v) continue;
        const ex=k===seg?hx:v[0], ey=k===seg?hy:v[1];
        ctx.globalAlpha=0.30+0.55*((k+1)/(hops||1));   // brightest just behind the head
        ctx.beginPath(); ctx.moveTo(u[0],u[1]); ctx.lineTo(ex,ey); ctx.stroke();
      }
      ctx.globalAlpha=1; ctx.shadowBlur=18; ctx.fillStyle='#ffffff';
      ctx.beginPath(); ctx.arc(hx,hy,2.7,0,6.2832); ctx.fill();
      ctx.shadowBlur=0;
    }
    ctx.globalAlpha=1; ctx.lineWidth=1;
  }

  // nodes — EVERY node is a circle. Category is carried by which island it sits
  // on, never by shape: mixed shapes at this density occlude into a blob.
  // reuse one buffer; map/filter/sort allocated three arrays every frame
  let order=G.order; if(!order||order.length!==P.length) order=G.order=new Int32Array(P.length);
  let on=0; for(let i=0;i<P.length;i++) if(P[i]) order[on++]=i;
  const view=order.subarray(0,on); view.sort((u,v)=>P[v][2]-P[u][2]);
  const LBL=[];
  for(const i of view){
    const n=G.nodes[i];
    if(n.domain==='core') continue;              // the accretion disk is the core
    const p=P[i];
    const col=nodeCol(n);
    const fl=flare.get(n.id), age=fl?(t-fl.at)/FLARE_MS:1, hot=fl&&age<1?(1-age):0;
    // A resident model is LIT, not flaring: steady glow in its own magenta, full
    // alpha, label always on — "what is on the GPU" must be readable at a glance.
    const lv=!hot&&LIVEM.has(n.id);
    // The accent for "this is the node being accessed right now". Vault touches keep
    // their existing near-white flare; the file tree gets amber, because on the tree
    // the flare has to be legible against BOTH the blue folders and the green files.
    const acc=isFs(n)?FS_ACCENT:'#dff2ff', accGlow=isFs(n)?FS_ACCENT:'#22ccff';
    // Depth reads as SIZE, as occlusion, and as a little dimming — never as vanishing.
    // The floor is 0.55, so the furthest note in the shell is still plainly on screen.
    // Standing rule: every node visible at all times, because this graph is how Jordan
    // checks whether I pulled the right note. Nothing in this renderer culls a node —
    // with ONE opt-in exception: USED-ONLY (`used` button / u), which hides everything
    // this session did not touch. It stays honest by shouting: the button is filled
    // amber and carries the count for as long as it is on, so a filtered graph can
    // never be mistaken for the whole graph.
    const dep=Math.max(0.55,Math.min(1,1-(p[2]+330)/900));
    const gw=n.kind==='gateway';
    const base=(gw?4.2:1.9+Math.sqrt(n.degree||0)*1.15)*p[3]*(1+hot*0.8+(lv?0.45:0));
    const rad=Math.max(1.8,base);                 // floor: never smaller than a legible dot
    // Occlusion halo — a disc of the background painted FIRST, so a nearer node visibly
    // cuts the links and nodes behind it. This is the whole trick for reading depth off a
    // camera that never moves: without it, overlapping dots merge and the scene goes flat.
    ctx.globalAlpha=1; ctx.fillStyle=BG;
    ctx.beginPath(); ctx.arc(p[0],p[1],rad+1.7,0,6.2832); ctx.fill();
    ctx.globalAlpha=(hot||lv)?1:dep*(gw?1:0.92);
    if(hot||lv||i===hoverI||gw){ctx.shadowColor=hot?accGlow:col;ctx.shadowBlur=hot?12+26*hot:lv?16:gw?12:14;}
    ctx.fillStyle=hot?acc:col;
    ctx.beginPath(); ctx.arc(p[0],p[1],rad,0,6.2832); ctx.fill();
    if(gw){                                       // gateway gets a thin halo ring, not a new shape
      ctx.strokeStyle=col; ctx.globalAlpha=0.45; ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(p[0],p[1],base*2.1,0,6.2832); ctx.stroke();
    }
    ctx.shadowBlur=0; ctx.globalAlpha=1;
    // Labels are only COLLECTED here and drawn in one pass below, so a name can never
    // be painted over by a node drawn after it, and so the crowded ones can yield.
    // fs folders earn a label at a much lower degree than a vault hub does: on a tree
    // the folder NAME is the information, and an unlabelled branch tells you nothing.
    const pri=(hot>0.15||lv||i===hoverI)?3:(gw||n.kind==='moon')?2:(isFs(n)?((n.degree||0)>=2?1:0):((n.degree||0)>=9?1:0));
    if(pri) LBL.push({n,p,base,pri,dep,col,gw,lit:hot>0.15||lv||i===hoverI});
  }

  // LABELS — highest priority first, then nearest first, and a name is skipped when its
  // box would collide with one already placed. A flare or the hovered node ALWAYS keeps
  // its label; gateways and hubs give way when it is tight. Only the TEXT yields — the
  // node itself is already drawn, and nothing here removes a node.
  LBL.sort((a,b)=>b.pri-a.pri||a.p[2]-b.p[2]);
  const boxes=[];
  for(const L of LBL){
    ctx.font=(L.gw?'bold 10px':'9.5px')+' ui-monospace,Consolas,monospace';
    // the note ID, not its title — titles are full sentences and collide into noise
    // fs labels keep their real case — a path is case-preserving and SERVER.MJS is
    // not the name of the file. Everything else stays upper-case as before.
    let lbl=L.gw?L.n.title:(isFs(L.n)?String(L.n.title):String(L.n.id).split('::').pop().toUpperCase());
    if(lbl.length>26) lbl=lbl.slice(0,25)+'…';
    if(!L.gw&&L.n.domain==='vault'&&L.n.degree) lbl+='  '+L.n.degree;
    const x=L.p[0]+L.base+6, y=L.p[1]+3.2, w=ctx.measureText(lbl).width;
    if(L.pri<3){
      let hit=false;
      for(const b of boxes) if(x<b[2]&&x+w>b[0]&&y-9<b[3]&&y+3>b[1]){hit=true;break;}
      if(hit) continue;
    }
    boxes.push([x,y-9,x+w,y+3]);
    ctx.globalAlpha=Math.min(1,L.dep+0.25);
    ctx.fillStyle=L.lit?'#eaf4ff':L.gw?L.col:'rgba(200,200,208,.72)';
    ctx.fillText(lbl,x,y);
  }
  ctx.globalAlpha=1;
  drawCoreTop();
  coreTarget*=0.985;                              // energy decays back to idle
  if(hoverDirty){ hoverDirty=false; updateHover(); }
  drawChron();
  drawPose(now);
}
requestAnimationFrame(frame);

function pick(mx,my){let b=-1,bd=1e9; syncCam();
  const cull=culling();
  for(let i=0;i<G.nodes.length;i++){const q=POS[G.nodes[i].id];if(!q)continue;
    if(cull&&!SHOWN.has(i))continue;
    const p=project(q),dx=p[0]-mx,dy=p[1]-my,d=dx*dx+dy*dy; if(d<bd&&d<420){bd=d;b=i;}}
  return b;}
cv.addEventListener('pointerdown',e=>{
  // 1 = rotate (left button), 2 = pan (middle button held)
  drag = e.button===1 ? 2 : e.button===0 ? 1 : 0;
  if(!drag) return;
  if(drag===2) e.preventDefault();      // stop Chrome's middle-click autoscroll
  lx=e.clientX;ly=e.clientY;cv.setPointerCapture(e.pointerId);});
cv.addEventListener('pointerup',()=>drag=0);
cv.addEventListener('pointercancel',()=>drag=0);
cv.addEventListener('pointerleave',()=>{drag=0;tip.style.opacity=0;hoverI=-1;});
cv.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
// The event handler now only records where the mouse is. The 120-node pick and
// every DOM write happen once per frame in updateHover(), not once per event.
let HMX=0,HMY=0,HCX=0,HCY=0,hoverDirty=false,tipShown=false;
cv.addEventListener('pointermove',e=>{
  if(drag){
    // Orientation is FIXED. The graph is a map now, so either button pans it and
    // nothing can knock it off the pose the inverse formula assumes.
    panX+=e.clientX-lx; panY+=e.clientY-ly;
    lx=e.clientX;ly=e.clientY; atHome=false;
    if(tipShown){tip.style.opacity=0;tipShown=false;}
    pose(); return;
  }
  if(!G)return;
  HCX=e.clientX;HCY=e.clientY;                 // cached rect: getBoundingClientRect()
  HMX=e.clientX-RECT_L;HMY=e.clientY-RECT_T;   // per event forced a sync layout
  hoverDirty=true;
});
function updateHover(){
  const i=pick(HMX,HMY);
  if(i!==hoverI){                              // only touch innerHTML when the node changes
    hoverI=i;
    if(i>=0){const n=G.nodes[i];
      // On the file tree the useful hover answer is the FULL PATH — the whole reason
      // the tree exists is checking which file was opened, and a basename is ambiguous.
      const meta=n.domain==='vault'?`${n.group} · ${n.degree} links`
        :isFs(n)?`${esc(n.path||'')}${n.kind==='file'?'':' · '+n.degree+' children'}${n.hits?' · '+n.hits+'x':''}${n.exists===false?' · MISSING':''}`
        :`${n.domain}${n.kind==='gateway'?' · gateway':''}`;
      tip.innerHTML=`${esc(n.title||n.id)}<span class="m">${meta}${n.status?' · '+n.status:''}</span>`+(isFs(n)?'':chTimes(n.id));}
    chFocus(i>=0?G.nodes[i].id:null);
  }
  if(hoverI>=0){
    tip.style.left=Math.min(HCX+14,innerWidth-220)+'px'; tip.style.top=(HCY+12)+'px';
    if(!tipShown){tip.style.opacity=1;tipShown=true;}
  } else if(tipShown){ tip.style.opacity=0; tipShown=false; }
}
cv.addEventListener('wheel',e=>{e.preventDefault();
  zoom=Math.max(0.05,Math.min(3.4,zoom*(e.deltaY>0?0.92:1.08)));atHome=false;pose();},{passive:false});

// ---- HOME: snap to the canonical pose, and keep the pose readable on screen ----
// Without this the only way to say "the thing at (812,767)" is to guess the camera.
// From HOME the inverse is exact:  wx=(sx-W/2)/f, wz=(sy-H/2)/f, f=FOCAL/(FOCAL-wy)*zoom*min(W,H)/620
// pose() is called from pointer handlers, which fire at the mouse polling rate
// (500-1000Hz on a gaming mouse). It only raises a flag now; the DOM write happens
// at most once per frame. Writing innerHTML per event was the movement lag itself.
function pose(){ poseDirty=true; }
function drawPose(now){
  fFrames++;
  if(now-fT0>=500){ fpsTxt=`${Math.round(fFrames*1000/(now-fT0))}fps ${((now-fT0)/fFrames).toFixed(1)}ms`;
                    fFrames=0; fT0=now; poseDirty=true; }
  if(!poseDirty) return; poseDirty=false;
  if(!POSE_EL) POSE_EL=$('#pose');
  if(!POSE_EL) return;
  const home = atHome;
  POSE_EL.innerHTML = (home?'<b>HOME</b> · ':'') +
    `yaw ${yaw.toFixed(3)} · pitch ${pitch.toFixed(3)} · zoom ${zoom.toFixed(3)}` +
    ` · pan ${Math.round(panX)},${Math.round(panY)} · stage ${W}×${H}css · dpr ${DPR} · focal ${FOCAL}` +
    (fpsTxt?` · ${fpsTxt}`:'');
  // Test seam: window.* does not cross a browser extension's isolated world, the DOM does.
  // Anything can now read the exact camera and invert a screen position to world space.
  POSE_EL.dataset.cam=JSON.stringify({yaw,pitch,zoom,panX,panY,W,H,FOCAL,DPR,home});
}
// Fit every node on screen at the fixed orientation. Computed rather than a stored
// zoom so it still frames everything as the vault grows or an island appears.
// The canvas is full-bleed but panels float on top of it, so the area a node is
// actually visible in is smaller than the window — and it changes as the roadmap,
// key and desk open and close. Measure it rather than hard-code it: fitting into the
// wrong rectangle is what buried the core behind the key legend.
const PANELS_L=['#hud','#key','#desk','#goals'], PANELS_R=['#legend','#road'];
function clearBox(){
  const box=el=>{const e=$(el); if(!e) return null;
    const s=getComputedStyle(e);
    if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0) return null;
    const b=e.getBoundingClientRect();
    return (b.width>1&&b.height>1)?b:null;};
  let l=0,r=0;
  for(const sel of PANELS_L){const b=box(sel); if(b) l=Math.max(l,b.right+14);}
  for(const sel of PANELS_R){const b=box(sel); if(b) r=Math.max(r,W-b.left+14);}
  let top=34, bot=document.body.classList.contains('chron')?116:0;
  // On a narrow window the panels overlap and their insets can add up to more than
  // the stage. Shrink them proportionally rather than letting the clear rectangle
  // collapse — a negative width would divide the fit into a nonsense zoom.
  const cap=(a,b,lim)=>{const t=a+b; return t>lim?[a*lim/t,b*lim/t]:[a,b];};
  [l,r]=cap(l,r,W*0.6); [top,bot]=cap(top,bot,H*0.6);
  return {l,r,top,bot};
}
// `cull` defaults to whichever view is active, but a replay passes it explicitly: it
// has to frame the replayed set from the first touch, before anything else is set.
function fitAll(margin=78,cull=culling()){
  if(!G||!POS||!W||!H) return;
  zoom=1; panX=0; panY=0; syncCam();
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,n=0;
  for(let i=0;i<G.nodes.length;i++){
    if(cull&&!SHOWN.has(i)) continue;
    const p=POS[G.nodes[i].id]; if(!p) continue;
    const q=project(p), dx=q[0]-W/2, dy=q[1]-H/2;
    if(dx<minX)minX=dx; if(dx>maxX)maxX=dx;
    if(dy<minY)minY=dy; if(dy>maxY)maxY=dy; n++;
  }
  if(!n) return;
  const hx=Math.max(1,(maxX-minX)/2), hy=Math.max(1,(maxY-minY)/2);
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  // Fit into the clear rectangle and centre there, rather than into the raw window.
  const cb=clearBox();
  // Ceilings, in order of who wins:
  //  review — an overview by definition. Jordan's reference framing is zoom 0.645, so
  //           cap there and let the fit go lower as the walked set spreads out. Without
  //           the cap a short session frames its handful of notes at 1.1x, which reads
  //           as a close-up of three dots rather than "here is what it touched".
  //  n<=3   — few nodes have almost no extent, so the raw fit divides by the 1px floor
  //           above and slams into the ceiling: the camera flies into the dot.
  const fitMax = reviewing ? 0.65 : n<=1 ? 1 : n<=3 ? 1.8 : 3.4;
  zoom=Math.max(0.05,Math.min(fitMax,
    Math.min(((W-cb.l-cb.r)/2-margin)/hx,((H-cb.top-cb.bot)/2-margin)/hy)));
  panX=-cx*zoom+(cb.l-cb.r)/2; panY=-cy*zoom+(cb.top-cb.bot)/2;
  syncCam();
  // The readout and the data-cam seam are both written from the frame loop, so a
  // refit nobody flags leaves them showing the camera from before the fit. Every
  // hand-driven caller already paired fitAll() with pose(); a replay-driven one
  // cannot, so raise the flag here instead of at each call site.
  pose();
}
function goHome(){ yaw=HOME.yaw;pitch=HOME.pitch;fitAll();atHome=true;pose(); }
$('#home').addEventListener('click',goHome);

addEventListener('keydown',e=>{ if(e.key==='h'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) goHome(); });

async function loadGraph(){
  const g=await (await fetch('/api/graph')).json();
  g.index={}; g.nodes.forEach((n,i)=>g.index[n.id]=i);
  const norm=(arr,kind)=>(arr||[]).map(l=>({
      source:typeof l.source==='object'?l.source.id:l.source,
      target:typeof l.target==='object'?l.target.id:l.target, kind:l.kind||kind}))
    .filter(l=>l.source in g.index&&l.target in g.index);
  g.links=norm(g.links,'vault');
  g.systemLinks=norm(g.systemLinks,'local');
  g.backbone=norm(g.backbone,'backbone');
  // Link style is a function of static data, so bucket it once here instead of
  // rebuilding `links.concat(systemLinks)` and re-deciding phantom/peer 300x a frame.
  // Line colour comes from the CATEGORY at each end now, not from one flat palette.
  // A link inside a category is drawn in that category's colour. A link BETWEEN two
  // categories is drawn as two halves meeting at the midpoint, so the line says which
  // network it leaves and which one it arrives in.
  //
  // Two halves rather than a canvas gradient on purpose: createLinearGradient is an
  // allocation per link per frame (~600 of them), and the halves fall into the same
  // colour buckets as every other segment, so the whole pass stays batched — one
  // strokeStyle set per colour, not per line.
  const buckets=new Map();
  const push=(dash,col,base,a,b,half)=>{
    const k=dash.join('_')+'|'+col+'|'+base;
    let e=buckets.get(k); if(!e) buckets.set(k,e={dash,col,base,segs:[]});
    e.segs.push(a,b,half);            // flat triples — no object per segment
  };
  const colOf=i=>nodeCol(g.nodes[i]);
  for(const l of g.links.concat(g.systemLinks)){
    const a=g.index[l.source], b=g.index[l.target];
    const phantom=g.nodes[a].group==='missing'||g.nodes[b].group==='missing';
    const dash=phantom?DASH_PHANTOM:l.kind==='peer'?DASH_PEER:EMPTY_DASH;
    const base=l.kind==='local'?0.10:l.kind==='tree'?0.30:phantom?0.30:l.kind==='peer'?0.34:0.22;
    // The fs tree keeps ONE colour: on that island colour means kind (folder vs file),
    // not location, so colouring its edges per-endpoint would say something untrue.
    if(l.kind==='tree'){ push(dash,'#4b8fe8',base,a,b,0); continue; }
    // A gateway spoke wears its host's colour — it IS the category membership line.
    if(l.kind==='local'){ push(dash,colOf(b),base,a,b,0); continue; }
    const ca=colOf(a), cb=colOf(b);
    if(ca===cb) push(dash,ca,base,a,b,0);
    else { push(dash,ca,base,a,b,1); push(dash,cb,base,a,b,2); }
  }
  // Faintest first, so a bright intra-category line is never buried under a spoke.
  LINK_PASSES=[...buckets.values()].sort((x,y)=>x.base-y.base);
  g.linkBuckets=LINK_PASSES.length;

  // Adjacency over EVERY edge type — vault links, spokes and the backbone — so the
  // flare router can walk core -> gateway -> host the way the network actually runs.
  const adj=g.adj=Array.from({length:g.nodes.length},()=>[]);
  for(const l of g.links.concat(g.systemLinks,g.backbone)){
    const a=g.index[l.source], b=g.index[l.target];
    if(a===undefined||b===undefined||a===b) continue;
    adj[a].push(b); adj[b].push(a);
  }
  routeCache=new Map();
  g.order=null;                       // reusable draw-order buffer, allocated on first frame
  // Gateway->host spokes get their own, much fainter pass. On the tools island that is
  // 62 lines fanning out of one point, and they carry no information the layout doesn't
  // already state — membership is POSITION here. Drawn at full weight they were the
  // dandelion; at 0.09 they read as the faint web holding a cloud together.
  // Tree edges are NOT demoted the way gateway spokes are. A spoke restates what the
  // layout already says (membership = position); a tree edge IS the containment fact,
  // and it is the thing you follow to check the path Metis actually walked.
  G=g;POS=g.layout;FOCAL=g.focal||680;
  // Counts come from the server now. They used to be derived by subtracting the island
  // counts from nodes.length, which was already off by one and would have gone wrong
  // outright the moment a fourth domain (fs) started adding nodes.
  const c=g.counts||{};
  $('#f-graph').textContent=`vault ${c.vault??'—'} · mcp ${c.mcp??0} · skills ${c.skills??0} · fs ${c.fs??0} · models ${c.models??0}`;
  // legend groups by NETWORK. Each vault category is now a network in its own right
  // rather than a colour inside one big "vault" row, so it gets a top-level line —
  // and the count excludes gateways, which are routers, not notes. (The old code
  // counted them, so "vault" read 117 for a 108-note vault the moment the nine
  // category gateways appeared.)
  const isl={};
  for(const n of g.nodes){
    if(n.domain==='core'||n.kind==='gateway') continue;
    (isl[n.domain]??={n:0,groups:{}}); isl[n.domain].n++;
    if(n.domain==='vault') isl.vault.groups[n.group]=(isl.vault.groups[n.group]||0)+1;
  }
  let html='';
  // Vault categories first, in ring order, each as its own network.
  const vg=isl.vault?isl.vault.groups:{};
  for(const k of CAT_ORDER.filter(k=>vg[k]).concat(Object.keys(vg).filter(k=>!CAT_ORDER.includes(k)).sort())){
    const c2=COLORS[k]||'#6a7a94';
    html+=`<div><i style="background:${c2};box-shadow:0 0 8px ${c2}"></i><b style="color:${c2}">${k}</b><span>${vg[k]}</span></div>`;
  }
  for(const [dom,info] of Object.entries(isl)){
    if(dom==='vault') continue;
    const col=ISLAND_COL[dom]||'#6a7a94';
    html+=`<div style="margin-top:4px"><i style="background:${col};box-shadow:0 0 8px ${col}"></i><b style="color:${col}">${dom}</b><span>${info.n}</span></div>`;
    // fs is the one domain whose colour means KIND, so the legend has to say so.
    if(dom==='fs'){
      html+=`<div style="padding-left:12px;opacity:.8"><i style="background:${FS_FOLDER}"></i>folders<span>${c.fsDirs??0}</span></div>`;
      html+=`<div style="padding-left:12px;opacity:.8"><i style="background:${FS_FILE}"></i>files<span>${c.fsFiles??0}</span></div>`;
      html+=`<div style="padding-left:12px;opacity:.8"><i style="background:${FS_ACCENT}"></i>accessed<span></span></div>`;}
  }
  $('#legend').innerHTML=html;
}
const ISLAND_COL={vault:'#22ccff',mcp:'#54e6a6',skills:'#b888ff',tools:'#f2b85c',fs:'#4b8fe8',models:'#ff6ec7',core:'#ff3344'};

// Shortest path between two nodes over the real edge set. Breadth-first, because every
// edge here costs the same: this is "how would a signal get there", not "which route is
// cheapest". Unweighted BFS also means the answer is the FEWEST hops, which is the one
// that reads correctly as an animation — core, gateway, host, done.
//
// Results are memoised: the graph only changes on reload, and the same tool firing
// twenty times in a session would otherwise re-run the search twenty times.
function route(from,to){
  if(!G||!G.adj||from===undefined||to===undefined||from<0||to<0) return null;
  if(from===to) return [to];
  const key=from+'>'+to;
  if(routeCache.has(key)) return routeCache.get(key);
  const prev=new Int32Array(G.adj.length).fill(-1);
  prev[from]=from;
  const q=[from];
  let out=null;
  outer: for(let h=0;h<q.length;h++){
    const u=q[h];
    for(const v of G.adj[u]){
      if(prev[v]!==-1) continue;
      prev[v]=u;
      if(v===to){
        out=[v]; let x=u;
        while(x!==from){ out.push(x); x=prev[x]; }
        out.push(from); out.reverse();
        break outer;
      }
      q.push(v);
    }
  }
  routeCache.set(key,out);
  return out;
}

// ---------------------------------------------------------------- USED-ONLY
// "Show me only what this session actually touched." USED accumulates every id that
// ever arrived on a touch event (live, backfilled or replayed) and never expires —
// unlike `trail`, which is a 9-second decay and answers a different question.
//
// SHOWN is USED widened along route(): a used note is drawn together with the path the
// core takes to reach it, so its gateway and (for a file) its parent folders survive
// the cull. Showing a bare file with no tree above it would answer "what" while
// destroying "where", and route() is the same walk the flare already animates.
const USED=new Set();
let usedOnly=false, SHOWN=new Set(), shownDirty=true, replaying=false, reviewing=false;
// Two different questions share one cull, so SHOWN answers whichever is active:
//   used   -> Claude alone. A focus, not a filter — strip the view back to the core.
//   review -> what that session reached, plus the path route() takes to get there,
//             which is what makes "where in the vault" answerable and not only "what".
// `reviewing` outlives `replaying` on purpose: the animation stops, the answer stays.
function rebuildShown(){
  shownDirty=false; SHOWN=new Set();
  if(!G) return;
  const ci=G.index['core'];
  // The core is in every view. It is the one node both questions have in common.
  if(ci!==undefined) SHOWN.add(ci);
  if(!reviewing) return;
  for(const id of USED){
    const i=G.index[id]; if(i===undefined) continue;
    const hop=route(ci,i);
    if(hop&&hop.length) for(const k of hop) SHOWN.add(k); else SHOWN.add(i);
  }
}
// Is anything being hidden right now? Either view culls; only the set differs.
const culling=()=>usedOnly||reviewing;
const usedCount=()=>{let n=0;for(const id of USED) if(G&&(id in G.index))n++;return n;};
function usedLabel(){
  const b=$('#usedtoggle'); if(!b) return;
  b.classList.toggle('on',usedOnly);
  b.textContent=usedOnly?`used ${usedCount()}`:'used';
  // Test seam, same trick as the pose readout: window.* does not cross a browser
  // extension's isolated world, the DOM does. `touched` is what the session hit,
  // `shown` is that widened along route() — so a probe can assert the cull without
  // reading pixels, and the difference between the two numbers is the path padding.
  b.dataset.touched=usedCount();
  // A review culls with the used button off, so the seam has to report it then too —
  // otherwise the one case worth asserting reads as blank.
  b.dataset.shown=culling()?SHOWN.size:'';
  b.dataset.view=reviewing?'review':usedOnly?'used':'';
}
// New touches arrive constantly. Only pay for the rebuild while the filter is on —
// or while a replay is running, because then the camera is tracking SHOWN too.
function usedChanged(){
  shownDirty=true;
  if(!culling()) return;
  rebuildShown(); usedLabel();
  // Normally only refit at home: a refit would yank a camera the user aimed by hand.
  // A replay is the exception — keeping up with it IS the point — so it frames the
  // replayed set on every touch and zooms out as the walk reaches away from the core.
  if(replaying) fitAll(78,true);
  else if(atHome) fitAll();
}
function setUsedOnly(on){
  usedOnly=on;
  // used and review are two views of the same graph, so taking the focus drops out
  // of a review rather than the two of them fighting over the cull.
  if(on) reviewing=false;
  shownDirty=true; rebuildShown();
  usedLabel();
  try{localStorage.setItem('metis.used',on?'1':'0');}catch{}
  if(on) ev(`<b>claude</b> <em>only — session touched ${usedCount()}; review to see them</em>`);
  fitAll(); pose();
}

const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ev(html){const d=document.createElement('div');d.className='ev';d.innerHTML=html;
  const h=$('#hud');h.prepend(d);while(h.children.length>8)h.lastChild.remove();
  setTimeout(()=>d.remove(),11000);}

let fireT=null;
function pulse(){const el=$('#f-fire');el.classList.add('hot');el.textContent='firing';
  clearTimeout(fireT);fireT=setTimeout(()=>{el.classList.remove('hot');el.textContent='idle';},1400);}

let bfAge=0;
function onTouch(h){
  const t=Date.now(), known=(h.ids||[]).filter(id=>G&&(id in G.index));
  if(!known.length) return;
  let fresh=false;
  for(const id of known) if(!USED.has(id)){ USED.add(id); fresh=true; }
  if(fresh) usedChanged();
  if(h.backfill){ bfAge+=220; const at=t-Math.min(TRAIL_MS-400,bfAge);
    for(const id of known) trail.push({id,at}); trail.sort((a,b)=>a.at-b.at);
  } else {
    // A live touch is a signal sent from whoever DID the work. Claude's touches leave
    // the core (Earth); a touch carrying h.origin — a Hermes query attributed to a
    // model — leaves that model's moon instead, and the moon itself flares while it
    // works. If the node is unreachable, fall back to a bare flare, never to nothing.
    const srcI=(h.origin&&G.index[h.origin]!=null)?G.index[h.origin]:G.index['core'];
    if(h.origin&&G.index[h.origin]!=null){
      flare.set(h.origin,{at:t});
      for(const id of known) MOONL.set(h.origin+'>'+id,{a:h.origin,b:id});
      if(MOONL.size>400){ const k=MOONL.keys().next().value; MOONL.delete(k); }
    }
    for(const id of known){
      const path=route(srcI,G.index[id]);
      if(path&&path.length>1){
        pulses.push({path,at:t,dur:Math.max(520,270*(path.length-1)),
                     col:h.origin?ISLAND_COL.models:nodeCol(G.nodes[G.index[id]])});
      } else flare.set(id,{at:t});
      trail.push({id,at:t});
    }
    // The chronicle plots a NOTE's added/updated/accessed. A file-tree touch has no
    // such row, so feeding fs ids into it would inflate the ACCESSED lane with events
    // the other two lanes can never match. The fs record is the access log instead.
    chAccess(known.filter(id=>!String(id).startsWith('fs::')),t);
    // The core heartbeat is CLAUDE's pulse. Work done by a moon must not beat
    // Earth's heart — the moon's flare is its own heartbeat.
    if(!h.origin){ coreTarget=Math.min(1,coreTarget+0.45); pulse(); }
    const shown=known.map(id=>String(id).startsWith('fs::')?(G.nodes[G.index[id]]?.title||id):id);
    const who=h.origin?`<b style="color:${ISLAND_COL.models}">${esc(h.model||'hermes')}</b> <em>▸</em> `:'';
    ev(`${who}<b>${h.tool}</b> <em>→</em> ${shown.slice(0,3).map(esc).join(', ')}${known.length>3?` <em>+${known.length-3}</em>`:''}`);
  }
  if(trail.length>TRAIL_MAX) trail=trail.slice(-TRAIL_MAX);
}

// Key panel — remembers whether you've dismissed it.
function setKey(on){
  $('#key').classList.toggle('on',on);
  try{localStorage.setItem('metis.key',on?'1':'0');}catch{}
}
$('#keytoggle').addEventListener('click',()=>setKey(!$('#key').classList.contains('on')));
$('#keyclose').addEventListener('click',()=>setKey(false));
try{ if(localStorage.getItem('metis.key')==='0') $('#key').classList.remove('on'); }catch{}

// Forces panel — live physics tuning. Values come from /api/forces so the sliders
// always show what the server actually used; apply triggers the one sanctioned
// layout reshuffle (see index.html comment) and graph_changed repaints for us.
const FR_IDS={spread:'fr-spread',repulsion:'fr-rep',linkPull:'fr-link',collideRadius:'fr-crad',collideStrength:'fr-cstr'};
function frShow(vals){
  for(const [k,id] of Object.entries(FR_IDS)){
    $('#'+id).value=vals[k];
    $('#'+id+'-v').textContent=(k==='linkPull')?Number(vals[k]).toFixed(4):String(vals[k]);
  }
}
async function loadForces(){
  try{ const d=await(await fetch('/api/forces')).json(); frShow(d.forces); FR_DEFAULTS=d.defaults; }
  catch{ $('#fr-note').textContent='server unreachable'; }
}
let FR_DEFAULTS=null;
function setForces(on){ $('#forces').classList.toggle('on',on); if(on) loadForces(); }
async function postForces(vals){
  $('#fr-note').textContent='recomputing…';
  try{
    const d=await(await fetch('/api/forces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(vals)})).json();
    frShow(d.forces); $('#fr-note').textContent='applied';
    setTimeout(()=>{ $('#fr-note').textContent=''; },2500);
  }catch{ $('#fr-note').textContent='failed'; }
}
$('#forcestoggle').addEventListener('click',()=>setForces(!$('#forces').classList.contains('on')));
$('#fr-close').addEventListener('click',()=>setForces(false));
$('#fr-apply').addEventListener('click',()=>postForces({
  spread:Number($('#fr-spread').value),
  repulsion:Number($('#fr-rep').value), linkPull:Number($('#fr-link').value),
  collideRadius:Number($('#fr-crad').value), collideStrength:Number($('#fr-cstr').value),
}));
$('#fr-reset').addEventListener('click',()=>{ if(FR_DEFAULTS) postForces(FR_DEFAULTS); });
for(const id of Object.values(FR_IDS)){
  $('#'+id).addEventListener('input',()=>{
    $('#'+id+'-v').textContent=(id==='fr-link')?Number($('#'+id).value).toFixed(4):$('#'+id).value;
  });
}
addEventListener('keydown',e=>{
  if(e.key==='f'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) setForces(!$('#forces').classList.contains('on'));
});

$('#usedtoggle').addEventListener('click',()=>setUsedOnly(!usedOnly));
$('#sess').addEventListener('change',e=>loadSessionTouches(e.target.value));
addEventListener('keydown',e=>{
  if(e.key==='u'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) setUsedOnly(!usedOnly);
});

// Reviewing a past session replaces the answer to "what did this session touch", so
// the set starts over rather than merging a replay into whatever is already on screen.
$('#replay').addEventListener('click',async()=>{$('#replay').disabled=true;
  // Entering the review view. It owns the cull now, so the used focus lets go of it —
  // a lit 'used' button next to a graph showing the path set would contradict itself.
  reviewing=true; replaying=true;
  if(usedOnly){ usedOnly=false; try{localStorage.setItem('metis.used','0');}catch{} }
  USED.clear(); usedChanged();   // empty set -> parks on the core, then walks outward
  try{
    await fetch('/api/replay',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({file:$('#sess').value,stepMs:550})});
  }catch{ replaying=false; $('#replay').disabled=false; }});

// Metis has no chat of its own any more: it watches whichever Claude Code session
// the SessionStart hook pointed it at. "detached" means no hook has reported in, so
// it is falling back to whichever transcript was written last — which is a guess.
function setAttached(sess){
  const el=$('#t-mode'); if(!el)return;
  el.classList.toggle('on',!!sess);
  el.textContent=sess?'attached':'detached';
  el.title=sess?('following session '+String(sess.id||'').slice(0,8))
               :'no SessionStart hook has reported — following the newest transcript';}

function connect(){
  const es=new EventSource('/api/events');
  es.onerror=()=>{$('#f-live').textContent='briefing · offline';};
  es.onmessage=e=>{let d;try{d=JSON.parse(e.data);}catch{return;}
    switch(d.type){
      case 'hello': if(d.live)$('#t-sess').innerHTML=`session <b>${d.live.slice(0,8)}</b>`;
        if(d.liveFile){ LIVE_FILE=d.liveFile; loadSessions(); }
        setAttached(d.session);
        $('#f-live').textContent='briefing · live '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); break;
      case 'session': $('#t-sess').innerHTML=`session <b>${d.file.slice(0,8)}</b>`;
        if(d.path) LIVE_FILE=d.path;
        loadSessions();
        replaying=false; reviewing=false; USED.clear(); usedChanged();  // live ends a review
        if(d.pinned!==undefined)setAttached(d.pinned?{id:d.sessionId}:null); break;
      case 'touch': onTouch(d); break;
      case 'backfilled': if(d.count) ev(`<b>${d.count}</b> <em>recent touches restored</em>`); break;
      // An fs change touches no vault note, so it must not trigger the activity
      // rebuild — that walks git history for the whole vault and would run on every
      // file the agent opens.
      case 'graph_changed': if(d.scope!=='fs') loadActivity(); loadGraph().then(()=>{
        if(d.scope==='fs'){
          const add=d.added||[], rm=d.removed||[];
          if(atHome) fitAll();
          if(add.length){ const t=Date.now();
            for(const id of add) if(POS[id]) flare.set(id,{at:t});
            const nm=add.map(id=>G.nodes[G.index[id]]?.title||id);
            ev(`<b>+${add.length} fs node${add.length>1?'s':''}</b> <em>${nm.slice(0,4).map(esc).join(' / ')}</em>`);
          }
          if(rm.length) ev(`<b>-${rm.length} fs node${rm.length>1?'s':''}</b> <em>evicted, cold</em>`);
          return;
        }
        // A note written while you watch should be visible AS it appears, so flare the
        // newcomers the same way a recall touch does.
        const add=d.added||[], rm=d.removed||[];
        if(atHome) fitAll();          // a newcomer may sit outside the current frame
        if(add.length){ const t=Date.now();
          for(const id of add) if(POS[id]) flare.set(id,{at:t});
          coreTarget=1;
          ev(`<b>+${add.length} note${add.length>1?'s':''}</b> <em>${add.slice(0,3).map(esc).join(', ')}</em>`);
        } else if(rm.length){ ev(`<b>-${rm.length} note${rm.length>1?'s':''}</b> <em>${rm.slice(0,3).map(esc).join(', ')}</em>`); }
        else ev(`<b>networks updated</b> <em>${d.counts?.tools??0} tools</em>`);
      }); break;
      case 'notes': if(d.by!=='gui'&&document.activeElement!==$('#dk-notes')){
          $('#dk-notes').value=d.notes.text||''; savedStamp(d.notes.updated); } break;
      case 'focus_start': DK.focus=d.focus; DK.alerted=null; renderFocus();
        ev(`<b>focus ${mins(d.focus.minutes)}</b> <em>${esc(d.focus.label)}</em>`);
        coreTarget=1; break;
      case 'focus_stop': DK.focus=d.focus; renderFocus(); break;
      case 'focus_end': DK.focus=d.focus; renderFocus(); break;
      case 'schedule': DK.schedule=d.schedule||[]; DK.next=d.next; renderSched(); break;
      // Claude adds through the same endpoint, so a todo written from the terminal
      // appears in the panel without a reload.
      case 'todos': DK.todos=d.todos||[]; renderTodos();
        if(d.added){ const t=DK.todos.find(x=>x.id===d.added);
          if(t&&t.source==='claude') ev(`<b>todo added</b> <em>by Claude</em> ${esc(t.text.slice(0,60))}`); }
        break;
      // A marked item is worth a line in the ticker: it is the rarest and most
      // meaningful event this app sees, and it should feel like it counted.
      case 'roadmap': RD.data=d.roadmap; renderRoad();
        if(d.marked) ev(`<b>roadmap marked</b> <em>${d.marked.score}/${d.marked.max}</em> `+
          `${d.marked.passed?'passed':'resubmit'} · ${d.roadmap.count}/${d.roadmap.total}`);
        break;
      // Residency changed on the GPU. Diff against LIVEM: a newly-resident model gets
      // a pulse from the core (a load IS a signal travelling out), an unloaded one
      // just goes dark. The models panel re-renders from the same frame if it's open.
      case 'models': {
        const now=new Set((d.models||[]).filter(m=>m.loaded).map(m=>`models::${m.name}`));
        for(const id of now) if(!LIVEM.has(id)){
          LIVEM.add(id);
          const m=(d.models||[]).find(x=>`models::${x.name}`===id);
          ev(`<b>model loaded</b> <em>${esc(id.slice(8))}</em> ${m?(m.vramBytes/1073741824).toFixed(1)+' GB VRAM':''}`);
          const ni=G.index[id], coreI=G.index['core'];
          if(ni!=null&&coreI!=null){ const path=route(coreI,ni);
            if(path&&path.length>1) pulses.push({path,at:performance.now(),dur:Math.max(520,270*(path.length-1)),col:ISLAND_COL.models});
            else flare.set(id,{at:performance.now()}); }
        }
        for(const id of [...LIVEM]) if(id.startsWith('models::')&&!now.has(id)){
          LIVEM.delete(id); ev(`<b>model unloaded</b> <em>${esc(id.slice(8))}</em> — VRAM freed`);
        }
        if($('#models').classList.contains('on')){ MD.data=d; renderModels(); }
        break; }
      case 'replay_end': replaying=false; $('#replay').disabled=false;
        ev(`<b>replay done</b> <em>${d.count??0}</em>`); break;
    }};
}


// ---------------------------------------------------------------- SESSIONS
// The picker used to list every .jsonl under ~/.claude/projects, newest 40 first. On
// this machine that is 289 files against 53 real conversations, so it was about three
// quarters subagent sidechains and headless one-shot probes — and it showed them as
// bare hex, which made the noise indistinguishable from the signal. The server now
// filters to real conversations and hands back their titles; see classifySession().
//
// It also refreshes. The old version fetched once at page load, so a window left open
// listed whatever existed that morning and marked a stale session as current — which
// is exactly what it looked like when Jordan asked whether the ids were accurate.
let SESSIONS=[], LIVE_FILE=null;

function fmtWhen(ms){
  const d=new Date(ms), now=Date.now(), age=now-ms;
  if(age<864e5&&new Date().getDate()===d.getDate()) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([],{day:'2-digit',month:'short'});
}
async function loadSessions(){
  try{
    const s=await (await fetch('/api/sessions')).json();
    SESSIONS=s.sessions||[];
    const sel=$('#sess'), keep=sel.value;
    sel.innerHTML=SESSIONS.map(x=>{
      const live=LIVE_FILE&&x.file===LIVE_FILE;
      const label=`${live?'● ':''}${fmtWhen(x.mtime)}  ${(x.title||x.name.slice(0,8))}`;
      return `<option value="${esc(x.file)}"${live?' data-live="1"':''}>${esc(label.slice(0,46))}</option>`;
    }).join('');
    // Keep the user's choice across a refresh; otherwise default to the live one.
    if(keep&&SESSIONS.some(x=>x.file===keep)) sel.value=keep;
    else if(LIVE_FILE&&SESSIONS.some(x=>x.file===LIVE_FILE)) sel.value=LIVE_FILE;
    sel.title=`${s.conversations} conversations (${s.scanned} transcript files on disk — subagent and one-shot runs are hidden)`;
  }catch{}
}

// Selecting a session loads WHICH NODES IT TOUCHED into the USED set, with no replay
// animation. That is what makes "hide everything this session did not use" answerable
// for a past conversation and not only for the live one.
async function loadSessionTouches(file){
  if(!file) return;
  try{
    const r=await (await fetch('/api/session-touches?file='+encodeURIComponent(file))).json();
    if(!r||!Array.isArray(r.ids)) return;
    USED.clear();
    for(const id of r.ids) USED.add(id);
    // Picking a session asks what review asks, just without the walk — so it enters
    // the same view, otherwise choosing one changes nothing on screen.
    reviewing=true;
    if(usedOnly){ usedOnly=false; try{localStorage.setItem('metis.used','0');}catch{} }
    shownDirty=true; rebuildShown();
    usedLabel();
    fitAll(); pose();
    const known=usedCount();
    ev(`<b>${esc(r.title||'session')}</b> <em>touched</em> ${known} node${known===1?'':'s'}`);
  }catch{}
}

// ---------------------------------------------------------------- CHRONICLE
// The graph answers "what connects to what". It cannot answer "when" — so this
// ribbon plots the three timestamps a note actually has, on one shared axis:
//   ACCESSED  Claude opened it — from Metis's own recall stream, the only record
//             of it that exists (NTFS last-access is off, and would count Obsidian)
//   UPDATED   mtime, so an edit that has not been committed yet still counts
//   ADDED     the first commit that introduced the file — NOT birthtime, which a
//             rename-based save (sed -i, atomic editor writes) silently resets
// See lib/activity.mjs for why none of the three is the obvious stat() call.
//
// Density is drawn as bars: at vault scale individual ticks smear into one block.
// Hovering a node on the graph picks that one note's marks back out at full height.
const CH_LANES=[{k:'accessed',label:'ACCESSED',col:'#22ccff'},
                {k:'updated', label:'UPDATED', col:'#f2b85c'},
                {k:'added',   label:'ADDED',   col:'#54e6a6'}];
const CH_RANGES=[['24H',864e5],['7D',6048e5],['30D',2592e6],['ALL',0]];
const CH_GUTTER=76, CH_AXIS=13, CH_BUCKET=3;
const CH={cv:null,ctx:null,W:0,H:0,lanes:null,byId:null,lastAcc:null,range:6048e5,
          t0:0,t1:0,focus:null,cache:null,dirty:true,on:false};

function ago(ms){
  if(!ms) return null;
  const s=(Date.now()-ms)/1000;
  if(s<90) return 'just now';
  if(s<5400) return Math.round(s/60)+'m ago';
  if(s<172800) return Math.round(s/3600)+'h ago';
  if(s<2592000) return Math.round(s/86400)+'d ago';
  return new Date(ms).toISOString().slice(0,10);
}
const stamp=ms=>ms?new Date(ms).toLocaleString([], {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';

// The three times for one node, appended to the hover tooltip. Island nodes (mcp,
// skills, tools) have no file, so they get an access time and nothing else — which
// is the truth, not a gap to paper over with a zero.
function chTimes(id){
  const f=CH.byId?.get(id);
  const acc=f?f.accessed:CH.lastAcc?.get(id);
  if(!f&&!acc) return '';
  const bit=(lbl,v,col)=>v?`<span style="color:${col}">${lbl}</span> ${ago(v)}`:'';
  const parts=[bit('acc',acc,'#22ccff'),f?bit('upd',f.updated,'#f2b85c'):'',f?bit('add',f.added,'#54e6a6'):'']
    .filter(Boolean);
  return parts.length?`<span class="m">${parts.join(' · ')}</span>`:'';
}

async function loadActivity(){
  try{
    const d=await (await fetch('/api/activity')).json();
    CH.byId=new Map((d.files||[]).map(f=>[f.id,f]));
    CH.lastAcc=new Map();
    for(const e of d.access||[]) if(!(CH.lastAcc.get(e.id)>=e.at)) CH.lastAcc.set(e.id,e.at);
    CH.lanes={
      accessed:(d.access||[]).map(e=>({at:e.at,id:e.id})),
      updated:(d.files||[]).map(f=>({at:f.updated,id:f.id})),
      added:(d.files||[]).map(f=>({at:f.added,id:f.id})),
    };
    const uncommitted=(d.files||[]).filter(f=>!f.committed).length;
    $('#ch-counts').innerHTML=`${(d.files||[]).length} notes · ${d.tracked||0} accesses`+
      (uncommitted?` · <span style="color:#f2b85c">${uncommitted} uncommitted</span>`:'');
    CH.cache=null; CH.dirty=true;
  }catch{ CH.lanes=null; CH.dirty=true; }
}

// A live tool call is a new ACCESSED mark. Pushing it beats refetching the whole
// ledger on every touch, and the ribbon is meant to move while you watch.
function chAccess(ids,t){
  if(!CH.lanes) return;
  for(const id of ids){
    CH.lanes.accessed.push({at:t,id});
    CH.lastAcc?.set(id,t);
    const f=CH.byId?.get(id); if(f) f.accessed=t;
  }
  CH.cache=null; CH.dirty=true;
}

function chFocus(id){
  if(CH.focus===id) return;
  CH.focus=id; CH.dirty=true;
  const el=$('#ch-focus'); if(!el) return;
  if(!id){ el.innerHTML=''; return; }
  const f=CH.byId?.get(id), acc=f?f.accessed:CH.lastAcc?.get(id);
  el.innerHTML=`<b>${esc(id)}</b> <i>acc</i> ${stamp(acc)} <i>upd</i> ${f?stamp(f.updated):'—'} <i>add</i> ${f?stamp(f.added):'—'}`;
}

function chResize(){
  const wrap=$('#ch-wrap'); if(!wrap||!CH.cv) return;
  const r=wrap.getBoundingClientRect();
  const w=Math.max(1,Math.round(r.width)), h=Math.max(1,Math.round(r.height));
  if(w===CH.W&&h===CH.H) return;
  CH.W=w;CH.H=h;CH.cv.width=Math.round(w*DPR);CH.cv.height=Math.round(h*DPR);
  CH.ctx.setTransform(DPR,0,0,DPR,0,0);
  CH.cache=null; CH.dirty=true;
}

function chDomain(){
  CH.t1=Date.now();
  if(CH.range){ CH.t0=CH.t1-CH.range; return; }
  let m=CH.t1;
  for(const L of CH_LANES) for(const e of (CH.lanes?.[L.k]||[])) if(e.at&&e.at<m) m=e.at;
  CH.t0=m<CH.t1?m-(CH.t1-m)*0.03:CH.t1-6048e5;    // ALL: a little air on the left
}
const chX=t=>CH_GUTTER+((t-CH.t0)/(CH.t1-CH.t0||1))*(CH.W-CH_GUTTER-6);

function chBuckets(list){
  const n=Math.max(1,Math.floor((CH.W-6-CH_GUTTER)/CH_BUCKET));
  const b=new Array(n).fill(null); let max=0;
  const span=CH.t1-CH.t0||1;
  for(const e of list||[]){
    if(!e.at||e.at<CH.t0||e.at>CH.t1) continue;
    let i=Math.floor(((e.at-CH.t0)/span)*n); if(i<0)i=0; if(i>=n)i=n-1;
    if(!b[i]) b[i]={c:0,ids:[]};
    b[i].c++; if(b[i].ids.length<8) b[i].ids.push(e.id);
    if(b[i].c>max) max=b[i].c;
  }
  return {b,n,max:max||1};
}

// Gridlines land on local midnight at day scale — stepping from a rounded epoch
// would put every "day" label a timezone offset away from the day it names.
function chTicks(){
  const span=CH.t1-CH.t0, out=[];
  const STEPS=[36e5,216e5,432e5,864e5,1728e5,6048e5,12096e5,2592e6,7776e6,31536e6];
  let step=STEPS[STEPS.length-1];
  for(const st of STEPS) if(span/st<=7){ step=st; break; }
  const day=step>=864e5;
  let t;
  if(day){ const d=new Date(CH.t0); d.setHours(0,0,0,0); t=d.getTime(); while(t<CH.t0) t+=step; }
  else t=Math.ceil(CH.t0/step)*step;
  for(;t<=CH.t1;t+=step){
    const d=new Date(t);
    out.push({t,label:day?`${d.getDate()}/${d.getMonth()+1}`
                        :d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})});
  }
  return out;
}

function drawChron(){
  if(!CH.on||!CH.ctx) return;
  chResize();
  if(!CH.dirty) return; CH.dirty=false;
  const ctx=CH.ctx,W=CH.W,H=CH.H;
  ctx.clearRect(0,0,W,H);
  ctx.font='8.5px ui-monospace,Consolas,monospace';
  if(!CH.lanes){ ctx.fillStyle='#4a5568'; ctx.fillText('no activity yet',CH_GUTTER,H/2); return; }
  chDomain();
  const laneH=Math.max(9,(H-CH_AXIS)/CH_LANES.length);

  ctx.strokeStyle='rgba(120,160,210,.12)'; ctx.lineWidth=1; ctx.fillStyle='#4a5568';
  for(const g of chTicks()){
    const x=Math.round(chX(g.t))+0.5;
    if(x<CH_GUTTER||x>W-6) continue;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H-CH_AXIS); ctx.stroke();
    ctx.fillText(g.label,Math.min(x+3,W-40),H-3);
  }

  CH.cache={};
  CH_LANES.forEach((L,li)=>{
    const top=li*laneH, bot=top+laneH-3;
    ctx.fillStyle=L.col; ctx.globalAlpha=.8;
    ctx.fillText(L.label,6,top+laneH/2+3);
    ctx.globalAlpha=1;
    ctx.strokeStyle='rgba(120,160,210,.10)';
    ctx.beginPath(); ctx.moveTo(CH_GUTTER,Math.round(bot)+.5); ctx.lineTo(W-6,Math.round(bot)+.5); ctx.stroke();

    const bk=chBuckets(CH.lanes[L.k]); CH.cache[L.k]=bk;
    ctx.fillStyle=L.col; ctx.globalAlpha=CH.focus?.20:.62;
    for(let i=0;i<bk.n;i++){
      const k=bk.b[i]; if(!k) continue;
      const h=Math.max(2,Math.sqrt(k.c/bk.max)*(laneH-8));
      ctx.fillRect(CH_GUTTER+i*CH_BUCKET,bot-h,CH_BUCKET-1,h);
    }
    ctx.globalAlpha=1;

    if(CH.focus){                       // one note, full height, so it cannot be missed
      ctx.fillStyle=L.col; ctx.shadowColor=L.col; ctx.shadowBlur=8;
      for(const e of CH.lanes[L.k]||[]){
        if(e.id!==CH.focus||e.at<CH.t0||e.at>CH.t1) continue;
        ctx.fillRect(Math.round(chX(e.at))-1,top+2,2,laneH-7);
      }
      ctx.shadowBlur=0;
    }
  });

  const xn=Math.round(chX(CH.t1))-.5;          // now
  ctx.strokeStyle='#ff3344'; ctx.globalAlpha=.5;
  ctx.beginPath(); ctx.moveTo(xn,0); ctx.lineTo(xn,H-CH_AXIS); ctx.stroke(); ctx.globalAlpha=1;
}

function chPick(mx,my){
  if(!CH.lanes||!CH.cache) return null;
  const laneH=Math.max(9,(CH.H-CH_AXIS)/CH_LANES.length);
  const li=Math.floor(my/laneH);
  if(li<0||li>=CH_LANES.length||my>CH.H-CH_AXIS) return null;
  const L=CH_LANES[li], bk=CH.cache[L.k]; if(!bk) return null;
  const i=Math.floor((mx-CH_GUTTER)/CH_BUCKET);
  if(i<0||i>=bk.n||!bk.b[i]) return null;
  return {lane:L,k:bk.b[i],at:CH.t0+((CH.t1-CH.t0)/bk.n)*(i+.5)};
}

function chInit(){
  CH.cv=$('#chcv'); if(!CH.cv) return;
  CH.ctx=CH.cv.getContext('2d');

  $('#ch-range').innerHTML=CH_RANGES.map(([lbl,ms])=>
    `<button data-ms="${ms}"${ms===CH.range?' class="on"':''}>${lbl}</button>`).join('');
  $('#ch-range').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    CH.range=Number(b.dataset.ms);
    for(const x of $('#ch-range').children) x.classList.toggle('on',x===b);
    CH.cache=null; CH.dirty=true;
  });

  CH.cv.addEventListener('pointermove',e=>{
    const r=CH.cv.getBoundingClientRect();
    const hit=chPick(e.clientX-r.left,e.clientY-r.top);
    if(!hit){ tip.style.opacity=0; tipShown=false; return; }
    const more=hit.k.c-hit.k.ids.length;
    tip.innerHTML=`<b style="color:${hit.lane.col}">${hit.lane.label.toLowerCase()}</b> · ${hit.k.c}`+
      `<span class="m">${stamp(hit.at)}<br>${hit.k.ids.slice(0,4).map(esc).join(', ')}${more>0?` +${more}`:''}</span>`;
    tip.style.left=Math.min(e.clientX+14,innerWidth-260)+'px';
    tip.style.top=Math.max(8,e.clientY-64)+'px';
    tip.style.opacity=1; tipShown=true;
  });
  CH.cv.addEventListener('pointerleave',()=>{ tip.style.opacity=0; tipShown=false; });

  // Click a bar and the notes behind it light up on the map — the point of having
  // both views is being able to go from a moment in time to the notes it touched.
  CH.cv.addEventListener('click',e=>{
    const r=CH.cv.getBoundingClientRect();
    const hit=chPick(e.clientX-r.left,e.clientY-r.top); if(!hit) return;
    const t=Date.now(); let n=0;
    for(const id of hit.k.ids) if(G&&(id in G.index)&&POS[id]){ flare.set(id,{at:t}); n++; }
    if(n){ coreTarget=Math.min(1,coreTarget+.4);
      ev(`<b>${hit.lane.label.toLowerCase()}</b> <em>${stamp(hit.at)}</em> ${hit.k.ids.slice(0,3).map(esc).join(', ')}`); }
  });

  $('#chrontoggle').addEventListener('click',()=>setChron(!CH.on));
  $('#chronclose').addEventListener('click',()=>setChron(false));
  addEventListener('keydown',e=>{
    if(e.key==='c'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) setChron(!CH.on);
  });

  // The ribbon must re-measure on its own, not only from inside the rAF loop: rAF is
  // paused while the tab is hidden, so a window resized in the background comes back
  // with the canvas still sized for the old layout — or for a zero-width first paint,
  // which is how this was caught (the backing store stuck 1px wide).
  addEventListener('resize',chResize);
  if(window.ResizeObserver) new ResizeObserver(()=>chResize()).observe($('#ch-wrap'));

  let want=true; try{ want=localStorage.getItem('metis.chron')!=='0'; }catch{}
  setChron(want);
  // mtime moves without any SSE event when a note is edited outside the watcher's
  // debounce, and "3m ago" goes stale on its own. A slow poll keeps both honest.
  setInterval(()=>{ if(CH.on) loadActivity(); },60000);
}

function setChron(on){
  CH.on=on;
  $('#chron').classList.toggle('on',on);
  document.body.classList.toggle('chron',on);
  try{ localStorage.setItem('metis.chron',on?'1':'0'); }catch{}
  if(on){ CH.W=CH.H=0; chResize(); if(!CH.lanes) loadActivity(); CH.dirty=true; }
  if(atHome) fitAll();
}


// ---------------------------------------------------------------- DESK
// Notes, the focus timer, the day's schedule. All three live on the SERVER
// (.desk.json), not in localStorage: a note you wrote is a thing you wrote and a
// later session should be able to read it, and a 60-minute timer must survive a
// reload of the page that started it. This module renders and posts; it owns nothing.
//
// Every control here has a matching endpoint, on purpose. "set a focus session for an
// hour" typed into Claude Code and the 1h button in this panel are the same action.
const DK={focus:null,schedule:[],next:null,todos:[],saveT:null,alerted:null,ac:null};
const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body||{})}).then(r=>r.json()).catch(()=>null);
const mins=m=>m>=60?(m%60?`${Math.floor(m/60)}h${m%60}`:`${Math.floor(m/60)}h`):`${m}m`;
const clock=ms=>{const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),
  m=Math.floor(s%3600/60),ss=s%60,pad=n=>String(n).padStart(2,'0');
  return h?`${h}:${pad(m)}:${pad(ss)}`:`${pad(m)}:${pad(ss)}`;};

// The key panel's height is not a constant and neither is the window, so the desk is
// placed from measurements. A CSS gap that clears the key at 1440p overlaps it at 1080p.
function placeDesk(){
  const d=$('#desk'), hud=$('#hud');
  if(!d) return;
  if(!d.classList.contains('on')){ hud.style.maxHeight=''; return; }
  const key=$('#key'), open=key&&key.classList.contains('on');
  const bot=document.body.classList.contains('chron')?122:14;
  // The goals panel is immovable (Jordan: seen at all times, never covered). The rest
  // of the rail anchors below its measured bottom — the desk shrinks, even to nothing
  // on an absurdly short window; it never rises over the goals.
  const gl=$('#goals');
  const ceil=(gl?gl.getBoundingClientRect().bottom:44)+8;
  if(open){
    // Sit directly on top of the key panel, whose height is not a constant. A CSS gap
    // that clears it at 1440p leaves the two overlapping at 1080p.
    const b=bot+key.offsetHeight+10;
    d.style.top='auto'; d.style.transform='none'; d.style.bottom=b+'px'; d.style.maxHeight='';
    // HEIGHT, not max-height: the panel is otherwise content-sized, which leaves the
    // notes box at its 76px minimum on a screen with 500px going spare. Setting the
    // height lets the textarea's flex:1 absorb whatever room there is.
    d.style.height=Math.max(0,Math.min(620,innerHeight-b-ceil))+'px';
  } else {
    // Hang from under the goals rather than centering — a centered desk is what sat
    // on top of the goals in the first place.
    d.style.top=ceil+'px'; d.style.transform='none'; d.style.bottom='auto';
    d.style.height='';
    d.style.maxHeight=Math.max(0,innerHeight-ceil-bot)+'px';
  }
  // The desk and the event feed share the left rail. On a short window there is not
  // room for both, and the feed is the one that yields: it is transient decoration,
  // the desk is a panel being used. Capped rather than hidden, so it still shows the
  // newest event or two. Measured top, not 44: the goals panel shifts the feed down
  // while it is open (placeGoals), and a cap computed from the bar would let the
  // feed run on behind the desk.
  const ht=hud.getBoundingClientRect().top||44;
  hud.style.maxHeight=Math.max(0,d.getBoundingClientRect().top-ht-8)+'px';
}
function setDesk(on){
  $('#desk').classList.toggle('on',on);
  try{localStorage.setItem('metis.desk',on?'1':'0');}catch{}
  if(on){ placeDesk(); loadDesk(); }
}

function savedStamp(ts,pending){
  const el=$('#dk-saved'); if(!el) return;
  el.classList.toggle('ok',!pending&&!!ts);
  el.textContent=pending?'saving…':ts?'saved '+new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
}

// ---- focus
function renderFocus(){
  const f=DK.focus, d=$('#desk');
  const running=!!f&&f.state==='running'&&f.endsAt>Date.now();
  d.classList.toggle('run',running);
  d.classList.toggle('done',!!f&&!running&&f.state==='done');
  $('#dk-stop').disabled=!running;
  $('#dk-what2').textContent=f?f.label:'';
  if(!f){ $('#dk-clock').textContent='--:--'; $('#dk-bar').firstElementChild.style.width='0'; return; }
  const total=f.minutes*60000, left=Math.max(0,f.endsAt-Date.now());
  $('#dk-clock').textContent=running?clock(left):(f.state==='done'?'done':'stopped');
  $('#dk-bar').firstElementChild.style.width=Math.min(100,100*(1-left/total)).toFixed(1)+'%';
  // The SSE focus_end is the authority, but a dropped stream must not swallow the one
  // moment this whole feature exists for — so the countdown can fire it too.
  if(!running&&f.state==='done'&&DK.alerted!==f.id){ DK.alerted=f.id; focusDone(f); }
}
function focusDone(f){
  chime();
  ev(`<b>focus done</b> <em>${mins(f.minutes)}</em> ${esc(f.label)}`);
  coreTarget=1;
  try{ if(window.Notification&&Notification.permission==='granted')
    new Notification('Focus session done',{body:`${f.label} · ${mins(f.minutes)}`}); }catch{}
}
// A tone, not an audio file: no asset to ship, no 404 to debug, and it works offline.
function chime(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    const ac=DK.ac||(DK.ac=new AC());
    if(ac.state==='suspended') ac.resume();
    const t0=ac.currentTime;
    [880,1174.66,1760].forEach((hz,i)=>{
      const o=ac.createOscillator(), g=ac.createGain(), at=t0+i*0.17;
      o.type='sine'; o.frequency.value=hz;
      g.gain.setValueAtTime(0,at);
      g.gain.linearRampToValueAtTime(0.22,at+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,at+0.8);
      o.connect(g); g.connect(ac.destination); o.start(at); o.stop(at+0.85);
    });
  }catch{}
}
// Chrome will not let a page make a sound until a gesture has touched the audio
// context. The timer's whole job is to make a sound an hour later, with no gesture
// anywhere near it — so the gesture that STARTS the session unlocks it in advance.
function chimeUnlock(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    const ac=DK.ac||(DK.ac=new AC());
    if(ac.state==='suspended') ac.resume();
  }catch{}
}
function startFocus(minutes,label){
  // Permission must be asked from inside a click, so it is asked here and nowhere else.
  try{ if(window.Notification&&Notification.permission==='default') Notification.requestPermission(); }catch{}
  chimeUnlock();
  post('/api/focus/start',{minutes,label:label||$('#dk-label').value||'Focus',source:'gui'})
    .then(r=>{ if(r&&r.focus){ DK.focus=r.focus; DK.alerted=null; renderFocus(); } });
}

// ---- todos: the shared list
// Open ones first, then the done ones, each group in the order it was added. A ticked
// item stays visible until it is cleared, because "what did I already do today" is half
// of what a list like this is for.
function renderTodos(){
  const list=DK.todos||[];
  const open=list.filter(t=>!t.done), done=list.filter(t=>t.done);
  const ordered=[...open,...done];
  $('#dk-tcount').textContent=list.length?`${open.length} open${done.length?` · ${done.length} done`:''}`:'';
  $('#dk-empty').style.display=list.length?'none':'';
  $('#dk-tclear').style.display=done.length?'':'none';
  $('#dk-tlist').innerHTML=ordered.map(t=>
    `<li data-id="${esc(t.id)}" class="${t.done?'done ':''}${t.source==='claude'?'byclaude':''}">`+
    `<input type="checkbox"${t.done?' checked':''} title="done">`+
    `<span>${esc(t.text)}</span>`+
    `${t.source==='claude'?'<em>CLAUDE</em>':''}`+
    `<button type="button" title="remove">×</button></li>`).join('');
}

// ---- schedule
const inWords=m=>m>=60?`${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}`:`${m}m`;
function renderSched(){
  const n=DK.next;
  $('#dk-next').innerHTML=n
    ? `<b>${esc(n.at)}</b> ${esc(n.label)} <i>· ${mins(n.minutes)} · in ${inWords(n.inMin)}</i>`
    : 'nothing scheduled';
  $('#dk-list').innerHTML=DK.schedule.map(b=>
    `<li data-id="${esc(b.id)}"><b>${esc(b.at)}</b><span>${esc(b.label)}</span>`+
    `<i>${mins(b.minutes)}</i><button type="button" title="remove">×</button></li>`).join('');
}

async function loadDesk(){
  try{
    const d=await (await fetch('/api/desk')).json();
    if(document.activeElement!==$('#dk-notes')) $('#dk-notes').value=d.notes?.text||'';
    savedStamp(d.notes?.updated);
    DK.focus=d.focus; DK.schedule=d.schedule||[]; DK.next=d.next; DK.todos=d.todos||[];
    // Don't chime for a session that ended while the page was shut.
    if(d.focus&&d.focus.state!=='running') DK.alerted=d.focus.id;
    renderFocus(); renderSched(); renderTodos();
  }catch{}
}

function deskInit(){
  $('#desktoggle').addEventListener('click',()=>setDesk(!$('#desk').classList.contains('on')));
  $('#deskclose').addEventListener('click',()=>setDesk(false));
  addEventListener('keydown',e=>{
    if(e.key==='n'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))
      setDesk(!$('#desk').classList.contains('on'));
    if(e.key==='Escape'&&document.activeElement===$('#dk-notes')) $('#dk-notes').blur();
  });

  $('#dk-notes').addEventListener('input',()=>{
    savedStamp(0,true);
    clearTimeout(DK.saveT);
    DK.saveT=setTimeout(async()=>{
      const r=await post('/api/notes',{text:$('#dk-notes').value,by:'gui'});
      savedStamp(r&&r.notes&&r.notes.updated);
    },700);
  });

  const addTodo=async()=>{
    const el=$('#dk-tnew'), text=el.value.trim();
    if(!text) return;
    el.value='';
    const r=await post('/api/todos/add',{text,source:'jordan'});
    if(r&&r.ok){ DK.todos=r.todos; renderTodos(); }
    else { el.value=text; ev(`<b>todo</b> <em>${esc((r&&r.error)||'rejected')}</em>`); }
  };
  $('#dk-tadd').addEventListener('click',addTodo);
  $('#dk-tnew').addEventListener('keydown',e=>{ if(e.key==='Enter') addTodo(); });
  $('#dk-tlist').addEventListener('click',async e=>{
    const li=e.target.closest('li'); if(!li) return;
    const id=li.dataset.id;
    let r=null;
    if(e.target.type==='checkbox') r=await post('/api/todos/toggle',{id,done:e.target.checked});
    else if(e.target.tagName==='BUTTON') r=await post('/api/todos/remove',{id});
    if(r&&r.todos){ DK.todos=r.todos; renderTodos(); }
  });
  $('#dk-tclear').addEventListener('click',async()=>{
    const r=await post('/api/todos/clear-done');
    if(r&&r.todos){ DK.todos=r.todos; renderTodos(); }
  });

  // Notes and todos are two pages of one sliding track — Jordan's ask, in two steps:
  // first tabs (the desk, squeezed under the immovable goals panel, let the notes box
  // paint over focus/schedule), then "swipe like Instagram pictures". The ‹ › buttons
  // and the swipe do the same thing; the page survives a reload.
  const setPage=p=>{
    $('#desk').classList.toggle('page-notes',p==='notes');
    try{ localStorage.setItem('metis.deskPage',p); }catch{}
    placeDesk();
  };
  for(const b of document.querySelectorAll('.dk-flip'))
    b.addEventListener('click',()=>setPage($('#desk').classList.contains('page-notes')?'todos':'notes'));
  let pg='todos'; try{ pg=localStorage.getItem('metis.deskPage')||'todos'; }catch{}
  setPage(pg);

  // The swipe. Pointer events cover mouse and touch alike. Touch drags from anywhere
  // (with intent detection so vertical list scrolling wins a vertical gesture); a
  // mouse only drags from a non-interactive spot — a mouse-drag on the textarea is
  // text selection, and the ‹ › button is right there. While dragging, the track
  // follows the pointer 1:1 and rubber-bands to a third past the ends; release snaps
  // at 20% of the width, else springs back. Clearing the inline transform on release
  // hands the animation back to the CSS transition from wherever the finger left off.
  const pager=$('#dk-pager'), track=$('#dk-track');
  let dg=null;
  pager.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&(e.button!==0||e.target.closest('input,textarea,button,select,a,li,label'))) return;
    dg={x:e.clientX,y:e.clientY,w:pager.clientWidth||1,on:false,id:e.pointerId};
  });
  pager.addEventListener('pointermove',e=>{
    if(!dg||e.pointerId!==dg.id) return;
    const dx=e.clientX-dg.x, dy=e.clientY-dg.y;
    if(!dg.on){
      if(Math.abs(dx)<9||Math.abs(dx)<=Math.abs(dy)){ if(Math.abs(dy)>14) dg=null; return; }
      dg.on=true; track.classList.add('drag');
      try{ pager.setPointerCapture(dg.id); }catch{}
    }
    e.preventDefault();
    const notes=$('#desk').classList.contains('page-notes');
    const base=notes?-dg.w:0;
    // no page beyond either end — give a third of the pull, like a real carousel edge
    const off=((dx<0&&notes)||(dx>0&&!notes))?dx/3:dx;
    track.style.transform=`translateX(${base+off}px)`;
  });
  const dgEnd=e=>{
    if(!dg) return;
    if(dg.on){
      const dx=e.clientX-dg.x, notes=$('#desk').classList.contains('page-notes');
      track.classList.remove('drag'); track.style.transform='';
      if(dx<-dg.w*0.2&&!notes) setPage('notes');
      else if(dx>dg.w*0.2&&notes) setPage('todos');
    }
    dg=null;
  };
  pager.addEventListener('pointerup',dgEnd);
  pager.addEventListener('pointercancel',dgEnd);

  $('#dk-presets').addEventListener('click',e=>{
    const b=e.target.closest('button[data-min]'); if(b) startFocus(Number(b.dataset.min));
  });
  $('#dk-label').addEventListener('keydown',e=>{ if(e.key==='Enter') startFocus(60); });
  $('#dk-stop').addEventListener('click',()=>post('/api/focus/stop')
    .then(r=>{ if(r&&'focus' in r){ DK.focus=r.focus; renderFocus(); } }));

  $('#dk-add').addEventListener('click',async()=>{
    const r=await post('/api/schedule/add',{at:$('#dk-add-at').value,
      minutes:Number($('#dk-add-min').value)||60, label:$('#dk-add-what').value||'Focus'});
    if(r&&r.ok){ DK.schedule=r.schedule; DK.next=r.next; renderSched(); $('#dk-add-what').value=''; }
    else ev(`<b>schedule</b> <em>${esc((r&&r.error)||'rejected')}</em>`);
  });
  $('#dk-list').addEventListener('click',async e=>{
    const li=e.target.closest('li'); if(!li||e.target.tagName!=='BUTTON') return;
    const r=await post('/api/schedule/remove',{id:li.dataset.id});
    if(r){ DK.schedule=r.schedule; DK.next=r.next; renderSched(); }
  });

  addEventListener('resize',placeDesk);
  // 1Hz is enough for a clock that counts in seconds, and "in 43m" on the next block
  // goes stale on its own even when nothing at all happens.
  setInterval(()=>{ if($('#desk').classList.contains('on')){ renderFocus(); renderSched(); } },1000);

  // Open unless dismissed, same contract as the key panel. A panel you asked for
  // should be on screen without going looking for the button that reveals it.
  let want=true; try{ want=localStorage.getItem('metis.desk')!=='0'; }catch{}
  setDesk(want);
}

// ---------------------------------------------------------------- ROADMAP
// The long game. The desk answers "what am I doing today"; this answers "where does
// today sit in the nine months". Curriculum comes from data/roadmap.json, ticks are
// stored server-side (.roadmap.json) — a checkbox that forgets itself on reload is
// worse than no checkbox, because you stop trusting the ones that do work.
const RD={data:null,open:null};

// Collapsed except the phase you are on. Six phases expanded is the whole document,
// which he already has as markdown — the panel's job is the ONE phase in front of him.
function renderRoad(){
  const d=RD.data; if(!d) return;
  $('#rd-pct').textContent=d.total?`${d.count}/${d.total} · ${d.pct}%`:'—';
  $('#rd-bar').firstElementChild.style.width=(d.pct||0)+'%';
  $('#rd-budget').textContent=d.budget||'';
  $('#rd-lock').textContent=d.grading||'';
  $('#rd-src').textContent=d.source?`source · ${d.source}`:'';
  if(RD.open===null) RD.open=d.currentId;
  $('#rd-list').innerHTML=(d.phases||[]).map(p=>{
    const open=p.id===RD.open;
    const cls=['ph',p.complete?'done':(p.id===d.currentId?'cur':''),open?'open':''].filter(Boolean).join(' ');
    const items=(p.items||[]).map(i=>{
      // Hollow = not attempted, amber score = marked but under the pass mark,
      // green tick = passed. Never an input — see the note in lib/roadmap.mjs.
      const mk=i.mark
        ? (i.mark.passed?'<span class="rd-mk pass">✓</span>'
                        :`<span class="rd-mk fail">${esc(String(i.mark.score??'!'))}</span>`)
        : '<span class="rd-mk"></span>';
      return `<li data-id="${esc(i.id)}" class="${i.kind==='gate'?'gate ':''}${i.kind==='project'?'project ':''}${i.done?'done':''}" title="open the instructions">`+
      `${mk}<span>${esc(i.text)}</span><span class="go">›</span></li>`;
    }).join('');
    const notes=(p.outcomes||[]).map(o=>`<div class="rd-note">— ${esc(o)}</div>`).join('');
    const links=(p.links||[]).map(l=>
      `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('');
    return `<li class="${cls}" data-ph="${esc(p.id)}">`+
      `<div class="rd-head"><span class="rd-n">${p.n}</span>`+
      `<span class="rd-t">${esc(p.title)}</span>`+
      `<span class="rd-cnt">${p.count}/${p.total}</span>`+
      `<span class="rd-wk">${esc(p.weeks||'')}</span></div>`+
      `<div class="rd-body"><div class="rd-goal">${esc(p.goal||'')}</div>`+
      `<ul class="rd-items">${items}</ul>${notes}`+
      `${links?`<div class="rd-links">${links}</div>`:''}</div></li>`;
  }).join('');
}

// The legend above it grows a row per category, so a hard-coded top is right once and
// wrong the next time a network is added. Measure it instead — same reason placeDesk
// exists for the key panel on the other rail.
function placeRoad(){
  const r=$('#road'); if(!r||!r.classList.contains('on')) return;
  const lg=$('#legend');
  const top=(lg&&lg.offsetHeight?lg.getBoundingClientRect().bottom:44)+26;
  const bot=document.body.classList.contains('chron')?122:14;
  r.style.top=top+'px';
  r.style.maxHeight=Math.max(220,innerHeight-top-bot)+'px';
}

async function loadRoad(){
  try{ RD.data=await (await fetch('/api/roadmap')).json(); renderRoad(); placeRoad(); }catch{}
}

function setRoad(on){
  $('#road').classList.toggle('on',on);
  $('#roadtoggle').classList.toggle('on',on);
  try{localStorage.setItem('metis.road',on?'1':'0');}catch{}
  if(on){ loadRoad(); placeRoad(); setModels(false); }   // shares the rail with #models — tabs, not a stack
}

// ---- the instructions screen
// Everything here comes from the item's `brief` in data/roadmap.json. An item without
// one still opens — it says so rather than rendering an empty shell, because a blank
// panel reads as broken and a missing brief is just work not done yet.
function openBrief(id){
  const d=RD.data; if(!d) return;
  let item=null,phase=null;
  for(const p of d.phases||[]){ const hit=(p.items||[]).find(i=>i.id===id); if(hit){ item=hit; phase=p; break; } }
  if(!item) return;
  const b=item.brief||{};
  $('#brief-kind').textContent=item.kind==='gate'?'cold gate':item.kind;
  $('#brief-kind').className=item.kind;
  $('#brief-phase').textContent=`Phase ${phase.n} · ${phase.title}`;
  $('#brief-title').textContent=item.text;
  $('#brief-what').textContent=b.what||'No brief written for this item yet — ask Claude to add one.';
  const fill=(sel,arr)=>$(sel).innerHTML=(arr||[]).map(s=>`<li>${esc(s)}</li>`).join('');
  fill('#brief-steps',b.steps); fill('#brief-done',b.done); fill('#brief-scored',b.scored);
  $('#brief-links').innerHTML=(phase.links||[]).map(l=>
    `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('');

  const m=item.mark, mk=$('#brief-mark');
  mk.className=m?('on '+(m.passed?'pass':'fail')):'';
  if(m){
    $('#brief-score').textContent=m.score===null?'Not scored':`${m.score} / ${m.max}${m.passed?'  — passed':'  — under the pass mark, resubmit'}`;
    $('#brief-fb').textContent=m.feedback||'';
    $('#brief-when').textContent=`marked by ${m.by} · ${new Date(m.at).toLocaleString()}`;
  }
  $('#brief-how').textContent=d.grading||'';
  $('#brief').classList.add('on');
}
function closeBrief(){ $('#brief').classList.remove('on'); }

function roadInit(){
  $('#roadtoggle').addEventListener('click',()=>setRoad(!$('#road').classList.contains('on')));
  $('#roadclose').addEventListener('click',()=>setRoad(false));
  addEventListener('keydown',e=>{
    if(e.key==='r'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))
      setRoad(!$('#road').classList.contains('on'));
  });

  $('#rd-list').addEventListener('click',e=>{
    // One handler for the whole list: an item row opens its instructions, a phase
    // header folds that phase. Accordion, not multi-open — see renderRoad.
    const li=e.target.closest('li[data-id]');
    if(li){ openBrief(li.dataset.id); return; }
    const head=e.target.closest('.rd-head'); if(!head) return;
    const ph=head.closest('li.ph'); if(!ph) return;
    RD.open=RD.open===ph.dataset.ph?null:ph.dataset.ph;
    renderRoad();
  });

  $('#brief-close').addEventListener('click',closeBrief);
  // Backdrop only — a click inside the card must not close the thing you are reading.
  $('#brief').addEventListener('click',e=>{ if(e.target.id==='brief') closeBrief(); });
  addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('#brief').classList.contains('on')) closeBrief(); });
  addEventListener('resize',placeRoad);

  // Closed by default: this is a reference you open on purpose, not a heads-up display.
  let want=false; try{ want=localStorage.getItem('metis.road')==='1'; }catch{}
  setRoad(want);
}

// ---- local models: what is eating the card
// A live view over Ollama via /api/models — nothing cached, because the question is
// always "now". Day mode: unload whatever the fallback lane left in VRAM so building
// and testing get the whole card. Night mode: warm a model before handing Hermes a
// batch. Polls only while open — a hidden panel costs nothing.
const MD={data:null,timer:null,busy:false};

function fmtGB(b){ return b? (b/1073741824).toFixed(1)+' GB' : '—'; }

function renderModels(){
  const d=MD.data; if(!d) return;
  const list=$('#md-list'); list.innerHTML='';
  $('#md-count').textContent=d.up? `${d.models.filter(m=>m.loaded).length} loaded / ${d.models.length}` : 'ollama down';
  if(d.gpu){
    const pct=Math.min(100,Math.round(d.gpu.usedMB/d.gpu.totalMB*100));
    const bar=$('#md-bar i'); bar.style.width=pct+'%';
    bar.classList.toggle('hot',pct>=90);          // the spill line
    $('#md-vram').textContent=`${d.gpu.name} · ${(d.gpu.usedMB/1024).toFixed(1)} / ${(d.gpu.totalMB/1024).toFixed(1)} GB VRAM (${pct}%)`;
  } else $('#md-vram').textContent='no nvidia-smi — VRAM bar unavailable';
  for(const m of d.models){
    const li=document.createElement('li');
    // spill = resident but bigger than its VRAM share: the KV cache ran off the card.
    const spill=m.loaded&&m.totalBytes>m.vramBytes*1.05;
    li.className=(m.loaded?'live':'')+(spill?' spill':'');
    const until=m.until? new Date(m.until) : null;
    const mins=until? Math.max(0,Math.round((until-Date.now())/60000)) : 0;
    li.innerHTML=
      `<div class="md-row"><span class="md-name">${m.name}</span>`+
      `<span class="md-size">${fmtGB(m.diskBytes)}</span></div>`+
      `<div class="md-sub">`+
      (m.loaded
        ? `<span>${spill?'SPILLED ':''}${fmtGB(m.vramBytes)} VRAM`+
          `${spill?` + ${fmtGB(m.totalBytes-m.vramBytes)} RAM`:''}`+
          `${m.context?` · ctx ${(m.context/1024)|0}k`:''} · ~${mins}m left</span>`+
          `<span class="grow"></span><button data-act="unload" data-name="${m.name}">unload</button>`
        : `<span>on disk</span><span class="grow"></span>`+
          `<button data-act="load" data-name="${m.name}">warm</button>`)+
      `</div>`;
    list.appendChild(li);
  }
  $('#md-note').textContent=d.up
    ? 'unload frees VRAM now (disk untouched) · warm pre-loads for ~5 min · install/delete stay in the terminal'
    : 'Ollama is not answering on 127.0.0.1:11434 — start the Ollama app.';
}

async function loadModels(){
  try{ MD.data=await (await fetch('/api/models')).json(); renderModels(); }catch{}
}

async function modelAct(act,name){
  if(MD.busy) return; MD.busy=true;
  try{
    // Warming a cold model genuinely takes a while — say so instead of freezing.
    ev(`<b>${act==='unload'?'unloading':'warming'}</b> ${name}…`);
    const r=await fetch(`/api/models/${act==='unload'?'unload':'load'}`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json();
    if(d.ok){ MD.data=d; renderModels(); ev(`<b>${name}</b> ${act==='unload'?'unloaded — VRAM freed':'warm'}`); }
    else ev(`<b>models</b> ${d.error||'failed'}`);
  }catch{ ev('<b>models</b> request failed'); }
  MD.busy=false;
}

function setModels(on){
  $('#models').classList.toggle('on',on);
  $('#modelstoggle').classList.toggle('on',on);
  try{localStorage.setItem('metis.models',on?'1':'0');}catch{}
  if(on){
    setRoad(false);                              // the other half of the tab pair
    loadModels();
    // 5 s: fast enough to watch an unload land, slow enough to be free.
    if(!MD.timer) MD.timer=setInterval(loadModels,5000);
    const r=$('#road'); $('#models').style.top=getComputedStyle(r).top;   // share placeRoad's slot
  } else if(MD.timer){ clearInterval(MD.timer); MD.timer=null; }
}

function modelsInit(){
  $('#modelstoggle').addEventListener('click',()=>setModels(!$('#models').classList.contains('on')));
  $('#modelsclose').addEventListener('click',()=>setModels(false));
  addEventListener('keydown',e=>{
    if(e.key==='m'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))
      setModels(!$('#models').classList.contains('on'));
  });
  $('#md-list').addEventListener('click',e=>{
    const b=e.target.closest('button[data-act]'); if(!b) return;
    modelAct(b.dataset.act,b.dataset.name);
  });
  // Closed by default, like the roadmap: a control room, not a dashboard.
  let want=false; try{ want=localStorage.getItem('metis.models')==='1'; }catch{}
  if(want) setModels(true);
  // Seed residency once regardless of the panel: the GRAPH shows loaded models lit,
  // and a model loaded before this page opened must not render cold until it changes.
  fetch('/api/models').then(r=>r.json()).then(d=>{
    for(const m of d.models||[]) if(m.loaded) LIVEM.add(`models::${m.name}`);
  }).catch(()=>{});
}

// ---------------------------------------------------------------- pad
// The paste-anything tab. Same toggle contract as every other panel, but it covers
// the stage like #brief does — a page you switch to, not a rail widget. The text
// lives in a real file through /api/scratchpad; this code only ferries it.
// Autosave is debounced, then flushed with sendBeacon on pagehide/hidden: a tab
// left by alt-tabbing away must not lose the last second of typing.
const PAD={open:false,last:null,timer:null};
function padStat(cls,txt){ const el=$('#pad-saved'); el.className=cls; el.textContent=txt; }
function padMeter(){ $('#pad-count').textContent=`${$('#pad-ta').value.length} ch`; }
async function padLoad(){
  try{
    const d=await (await fetch('/api/scratchpad')).json();
    // Reseed only when the textarea holds nothing the file doesn't: never clobber
    // typing that beat the response in.
    if(PAD.last===null||$('#pad-ta').value===PAD.last){ $('#pad-ta').value=d.text||''; PAD.last=$('#pad-ta').value; }
    $('#pad-file').textContent=d.file||''; padStat('ok','saved'); padMeter();
  }catch{ padStat('err','load failed'); }
}
async function padSave(){
  const v=$('#pad-ta').value;
  if(v===PAD.last) return;
  padStat('','saving…');
  const r=await post('/api/scratchpad',{text:v});
  if(r&&r.ok){ PAD.last=v; padStat('ok','saved'); }
  else padStat('err','save failed — will retry on the next keystroke');
}
// sendBeacon, not fetch: it is the one request the browser promises to finish
// after the page is already going away.
function padBeacon(){
  const v=$('#pad-ta').value;
  if(v===PAD.last) return;
  try{
    navigator.sendBeacon('/api/scratchpad',new Blob([JSON.stringify({text:v})],{type:'application/json'}));
    PAD.last=v;
  }catch{}
}
function setPad(on){
  PAD.open=on;
  $('#pad').classList.toggle('on',on); $('#padtoggle').classList.toggle('on',on);
  try{ localStorage.setItem('metis.pad',on?'1':'0'); }catch{}
  if(on){ padLoad().then(()=>$('#pad-ta').focus()); } else { clearTimeout(PAD.timer); padSave(); }
}
function padInit(){
  const ta=$('#pad-ta');
  $('#padtoggle').addEventListener('click',()=>setPad(!PAD.open));
  $('#padclose').addEventListener('click',()=>setPad(false));
  addEventListener('keydown',e=>{
    if(e.key==='p'&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) setPad(!PAD.open);
    // First Escape steps out of the textarea (the desk notes contract), the next
    // one leaves the tab. #brief sits above the pad (z 40 vs 30), so it owns
    // Escape while it is open.
    if(e.key==='Escape'&&document.activeElement===ta){ ta.blur(); return; }
    if(e.key==='Escape'&&PAD.open&&!$('#brief').classList.contains('on')) setPad(false);
  });
  ta.addEventListener('input',()=>{ padMeter(); padStat('','·'); clearTimeout(PAD.timer); PAD.timer=setTimeout(padSave,600); });
  ta.addEventListener('keydown',e=>{
    // Ctrl+S = flush now. The browser's own save dialog is never what this means here.
    if((e.ctrlKey||e.metaKey)&&e.key==='s'){ e.preventDefault(); clearTimeout(PAD.timer); padSave(); }
  });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) padBeacon(); });
  addEventListener('pagehide',padBeacon);
  // Reload lands back on the pad if that is where you were — it is a tab, and a
  // browser reopens the tab you were on.
  let want=false; try{ want=localStorage.getItem('metis.pad')==='1'; }catch{}
  if(want) setPad(true);
}

// ---------------------------------------------------------------- GOALS
// Always on screen, by request: no toggle, no close, nothing may cover it. Content
// is the vault note knowledge/people/jordan-goals.md via /api/goals — one source of
// truth; the panel is a window onto it, refetched every 10 minutes so an edited
// note arrives without a reload (the PWA runs for days). The left rail stacks BELOW
// it: placeGoals sets the feed's ceiling, placeDesk anchors the desk under the
// goals' measured bottom — overlap is impossible by geometry, not discouraged by z.
function renderGoals(text,updated){
  $('#gl-upd').textContent=updated?new Date(updated).toLocaleDateString('en-CA'):'—';
  // The note opens with a provenance paragraph for vault readers; the panel starts
  // at the first heading — Jordan wants the goals in front of him, not the sourcing.
  const lines=String(text||'').split(/\r?\n/);
  const s=lines.findIndex(l=>/^##\s/.test(l));
  $('#gl-body').innerHTML=(s>=0?lines.slice(s):lines).map(l=>{
    if(/^##\s/.test(l)) return `<div class="gl-h">${esc(l.replace(/^##\s+/,''))}</div>`;
    if(/^-\s/.test(l))  return `<div class="gl-i">${esc(l.replace(/^-\s+/,''))}</div>`;
    return l.trim()?`<div class="gl-i">${esc(l)}</div>`:'';
  }).join('');
}
function placeGoals(){
  const g=$('#goals'), hud=$('#hud');
  // The feed yields, same contract it has with the desk: it starts under the goals,
  // and placeDesk caps it from its measured top.
  hud.style.top=(g.getBoundingClientRect().bottom+8)+'px';
  placeDesk();
}
async function loadGoals(){
  try{ const d=await (await fetch('/api/goals')).json(); renderGoals(d.text,d.updated); }
  catch{ renderGoals('- could not read the goals note',null); }
  placeGoals();   // sync, right after render: correct even where frame callbacks pause
}
function goalsInit(){
  // Belt and braces: direct calls after render/resize (correct in hidden tabs, where
  // layout reads work but frame callbacks pause) plus a ResizeObserver that corrects
  // any late layout shift the moment a real frame runs. All idempotent.
  new ResizeObserver(placeGoals).observe($('#goals'));
  addEventListener('resize',placeGoals);
  loadGoals();
  setInterval(loadGoals,600000);   // an edited note lands without a reload
}

(async function(){
  await loadGraph();
  chInit();                       // ribbon first: goHome() fits around it
  deskInit();
  roadInit();
  modelsInit();
  padInit();
  goalsInit();
  await loadActivity();
  goHome();                       // fixed orientation + fit: the only view there is
  await loadSessions();
  try{ if(localStorage.getItem('metis.used')==='1') setUsedOnly(true); else usedLabel(); }catch{ usedLabel(); }
  // A window is left open for days here. Without this the picker silently describes
  // yesterday, which is indistinguishable from describing today incorrectly.
  setInterval(loadSessions,60000);
  connect();
})();
