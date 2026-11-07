"use strict";
/* monostudy v3 — local-first. Works from file:// (data ships as scripts), optional accounts + sync via server.js. */
if(!Array.prototype.findLast)Object.defineProperty(Array.prototype,"findLast",{value(f){for(let i=this.length-1;i>=0;i--)if(f(this[i],i,this))return this[i]}});
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const h=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const dkey=(d=new Date())=>d.toLocaleDateString("en-CA");
const today=()=>dkey();
const pct=(a,b)=>b?Math.round(a/b*100):0;
const KEY="monostudy_v2",SUBJECTS=["Physics","Chemistry","Mathematics","Biology"];
const STATUSES=["Not Started","In Progress","Revised","Mastered"];
const EXAM_SUBJ={JEE:["Physics","Chemistry","Mathematics"],NEET:["Physics","Chemistry","Biology"],Both:SUBJECTS};

/* ---------- state + schema migration ---------- */
const fresh=()=>({v:2,uid:"usr_"+uid(),profile:{name:"",cls:"11",exam:"JEE",goal:180},status:{},tasks:[],notes:[],attempts:[],errors:[],cards:{},study:{},sessions:[],customPyq:[],updatedAt:0});
const SKEY="monostudy_session",AKEY="monostudy_accounts";
function readSession(){try{return JSON.parse(localStorage.getItem(SKEY))}catch{return null}}
// guests keep the original key (so v2 data is not lost); every account gets its own bucket
function storageKey(){return SESSION&&SESSION.mode!=="guest"?KEY+":"+SESSION.id:KEY}
let SESSION=readSession(),S=load(storageKey()),CH=[],CHMAP=new Map(),PYQ=[],BASE_PYQ=[],pyqNotice="";
function load(key=KEY){
  try{
    const raw=localStorage.getItem(key);
    if(raw){try{return normalize(JSON.parse(raw))}catch{try{localStorage.setItem(key+"_corrupt",raw)}catch{}}}   // keep a copy instead of silently overwriting
    if(key!==KEY)return fresh();
    // v1 -> v2 (monostudy_v1 / prepsphere_v1): kept raw until the catalog loads, then mapped to chapter ids
    const old=localStorage.getItem("monostudy_v1")||localStorage.getItem("prepsphere_v1");
    if(old){const o=JSON.parse(old),s=fresh();
      s.profile={...s.profile,name:o.profile?.name||"",cls:String(o.profile?.class||"11"),exam:o.profile?.exam||"JEE",goal:Number(o.profile?.goal)||180};
      s.tasks=(o.tasks||[]).map(t=>({id:t.id||uid(),text:t.title||t.text||"",subject:t.subject||"General",done:!!t.done,date:t.date||today()}));
      s.notes=(o.notes||[]).map(n=>({id:n.id||uid(),title:n.title||"",subject:n.subject||"General",body:n.body||"",images:[],updated:n.updated||Date.now()}));
      s.study={...(o.studyLog||{})};s._legacySyllabus=o.syllabus||{};return s}
  }catch{}
  return fresh();
}
function normalize(d){const f=fresh();const s={...f,...d,profile:{...f.profile,...(d.profile||{})}};
  ["tasks","notes","attempts","errors","sessions","customPyq"].forEach(k=>{if(!Array.isArray(s[k]))s[k]=[]});
  ["status","cards","study"].forEach(k=>{if(!s[k]||typeof s[k]!=="object"||Array.isArray(s[k]))s[k]={}});
  s.v=2;return s}
function save(){S.updatedAt=Date.now();try{localStorage.setItem(storageKey(),JSON.stringify(S))}catch{toast("Storage full — export a backup or remove note images")}scheduleSync()}
function migrateLegacy(){
  if(!S._legacySyllabus)return;
  const byTitle=new Map(CH.map(c=>[`${c.class}|${c.subject}|${c.title}`,c.id])),map={"Not Started":"Not Started","In Progress":"In Progress","Revised":"Revised","Mastered":"Mastered","Completed":"Mastered","Done":"Mastered"};
  for(const [k,v] of Object.entries(S._legacySyllabus)){const [c,,sub,title]=k.split("|");const id=byTitle.get(`${c}|${sub}|${title}`);if(id&&map[v]&&map[v]!=="Not Started")S.status[id]=map[v]}
  delete S._legacySyllabus;save();
}

/* ---------- ui helpers ---------- */
let tt;function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("show"),2600)}
function ask(title,msg){return new Promise(r=>{$("#mTitle").textContent=title;$("#mMsg").textContent=msg;const m=$("#modal");m.classList.remove("hidden");
  const done=v=>{m.classList.add("hidden");r(v)};$("#mOk").onclick=()=>done(true);$("#mCancel").onclick=()=>done(false);$("#mCancel").focus()})}
function typeset(el){try{if(window.renderMathInElement)renderMathInElement(el,{delimiters:[{left:"$$",right:"$$",display:true},{left:"$",right:"$",display:false}],throwOnError:false})}catch{}}
window.addEventListener("load",()=>typeset(document.body));
const bar=(p,c="c-pri")=>`<div class="bar"><div class="${c}" style="width:${Math.min(100,p)}%"></div></div>`;
const chapters=()=>CH.filter(c=>String(c.class)===S.profile.cls&&EXAM_SUBJ[S.profile.exam].includes(c.subject));
const stOf=id=>S.status[id]||"Not Started";
const isDone=id=>["Revised","Mastered"].includes(stOf(id));

/* ---------- derived analytics ---------- */
function chapterAcc(){const m={};for(const a of S.attempts){const x=m[a.chapterId]||(m[a.chapterId]={n:0,ok:0});x.n++;if(a.correct)x.ok++}return m}
function overallAcc(){return S.attempts.length?pct(S.attempts.filter(a=>a.correct).length,S.attempts.length):null}
const minutesOn=d=>Number(S.study[d]||0);
function activeDays(){const s=new Set(Object.entries(S.study).filter(([,m])=>m>0).map(([d])=>d));S.attempts.forEach(a=>s.add(dkey(new Date(a.ts))));S.tasks.forEach(t=>{if(t.done&&t.doneOn)s.add(t.doneOn)});return s}
// Streak with grace: one isolated missed day is forgiven; two missed days in a row break it.
function streak(){const act=activeDays(),d=new Date();let n=0,graces=0,pending=0,prevMiss=false;
  for(let i=0;i<400;i++){const k=dkey(d);
    if(act.has(k)){n++;graces+=pending;pending=0;prevMiss=false}else if(i>0){if(prevMiss)break;prevMiss=true;pending++}
    d.setDate(d.getDate()-1)}
  return {n,graces}}
function weakSpots(){const acc=chapterAcc();
  return chapters().filter(c=>c.weightage==="High").map(c=>{const a=acc[c.id];return {c,n:a?.n||0,acc:a?pct(a.ok,a.n):null}})
    .filter(x=>x.n===0?!isDone(x.c.id):(x.n>=2&&x.acc<60)).sort((a,b)=>(a.acc??-1)-(b.acc??-1))}

/* ---------- optional server sync ---------- */
const canServer=location.protocol.startsWith("http");let serverUp=false;
const FB=window.MonoFirebase||{enabled:false,ok:false};
const token=()=>SESSION&&SESSION.token||null;
const isFB=()=>!!(SESSION&&SESSION.mode==="firebase"&&FB.enabled);
const setNote=t=>{const n=$("#syncNote");if(n)n.textContent=t};
async function api(path,opt={}){
  const hd={"Content-Type":"application/json",...(token()?{Authorization:"Bearer "+token()}:{"X-User-Id":S.uid})};
  const r=await fetch(path,{...opt,headers:{...hd,...(opt.headers||{})}});
  let j=null;try{j=await r.json()}catch{}
  if(!r.ok){const e=new Error(j?.error||("Server error "+r.status));e.status=r.status;throw e}return j}
async function pingServer(){if(!canServer)return false;
  try{await api("/api/health");serverUp=true;setNote(token()?"Signed in — data syncs to the server.":"Server connected — status changes sync.")}catch{serverUp=false}return serverUp}
async function pushStatus(id,status){if(!serverUp)return;try{await api(`/api/chapters/${encodeURIComponent(id)}/status`,{method:"PATCH",body:JSON.stringify({status})})}catch{}}
async function pushAttempt(a){if(!serverUp)return;try{await api("/api/v1/practice/log-attempt",{method:"POST",body:JSON.stringify({user_id:S.uid,question_id:a.qid,selected_option:"ABCD"[a.sel],is_correct:a.correct,time_taken_seconds:Math.min(7200,a.secs),confidence_rating:a.conf,error_category:a.cat||null})})}catch{}}
// one request for everything (the old loop sent 200+ requests and hit the 120/min rate limit)
async function pushAll(){if(!serverUp)return toast("Server not reachable — run `node server.js` and open http://localhost:3000");
  try{const statuses=Object.fromEntries(Object.entries(S.status).filter(([,v])=>v!=="Not Started"));
    const attempts=S.attempts.slice(-500).map(a=>({question_id:a.qid,selected_option:"ABCD"[a.sel],is_correct:a.correct,time_taken_seconds:Math.min(7200,a.secs),confidence_rating:a.conf,error_category:a.cat||null,ts:a.ts}));
    const r=await api("/api/v1/sync/bulk",{method:"POST",body:JSON.stringify({user_id:S.uid,statuses,attempts})});
    toast(`Pushed ${r.statuses} chapter statuses, ${r.attemptsAdded} new attempts${r.attemptsSkipped?` (${r.attemptsSkipped} skipped)`:""}`)}
  catch(e){toast("Push failed: "+e.message)}}
// whole-state sync for signed-in accounts (Firebase or the Node server): last write wins, compared by updatedAt
let syncT=null;
const canCloud=()=>isFB()?FB.ok:!!(token()&&serverUp);
function scheduleSync(){if(!canCloud())return;clearTimeout(syncT);syncT=setTimeout(syncUp,2500)}
function persistLocal(){try{localStorage.setItem(storageKey(),JSON.stringify(S))}catch{}}
async function syncUp(){if(!canCloud())return;
  try{if(isFB()){const r=await FB.saveState(S);if(r.trimmed)toast("Cloud copy keeps your latest 1000 attempts (document size limit)")}
    else await api("/api/v1/state",{method:"PUT",body:JSON.stringify({state:S})});
    setNote("Synced "+new Date().toLocaleTimeString())}
  catch(e){if(e.status===401||e.code==="app/not-signed-in")toast("Session expired — log in again");else if(e.status===413)toast("Cloud sync skipped: too much data (remove note images)");
    else if(e.code==="app/too-large")toast(e.message);else if(isFB())toast("Cloud sync failed: "+FB.friendly(e))}}
async function syncDown(){if(!canCloud())return false;
  try{const state=isFB()?await FB.loadState():(await api("/api/v1/state")).state;
    if(state&&(state.updatedAt||0)>(S.updatedAt||0)){S=normalize(state);S.uid=SESSION.id;persistLocal();return true}
    if(!state||(S.updatedAt||0)>(state.updatedAt||0))await syncUp()}
  catch(e){if(isFB())toast("Could not load cloud data: "+FB.friendly(e))}
  return false}
// live updates from your other devices (Firestore listener)
function watchCloud(){if(!isFB()||!FB.ok)return;
  FB.watch(state=>{if((state.updatedAt||0)>(S.updatedAt||0)){S=normalize(state);S.uid=SESSION.id;persistLocal();mergePYQ();render();toast("Updated from another device")}})}

/* ---------- login / sign-up ---------- */
const accounts=()=>{try{return JSON.parse(localStorage.getItem(AKEY))||{}}catch{return{}}};
async function hashPw(pw,salt){const enc=new TextEncoder();
  if(window.crypto?.subtle){try{const k=await crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveBits"]);
    const b=await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:100000,hash:"SHA-256"},k,256);return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}catch{}}
  let x=5381;const t=salt+pw;for(let r=0;r<2000;r++)for(let i=0;i<t.length;i++)x=((x<<5)+x+t.charCodeAt(i))|0;return "w"+(x>>>0).toString(16)}
function startSession(sess){localStorage.setItem(SKEY,JSON.stringify(sess));location.reload()}   // reload = every page starts clean with the new account's data
function initAuth(){
  let reg=false,localOtp=null;const msg=(id,m="")=>{$(id).textContent=m};
  $("#authMode").textContent=serverUp?"Connected to the server — your account and progress sync across devices.":"Offline mode — accounts are stored only in this browser. Run node server.js for synced accounts.";
  const setReg=v=>{reg=v;$("#nameGroup").classList.toggle("hidden",!v);$("#authTitle").textContent=v?"Create your account":"Welcome back";$("#emailSubmit").textContent=v?"Create account":"Log in";
    $("#toggleRegister").textContent=v?"Have an account? Log in":"New here? Create an account";$("#authPassword").autocomplete=v?"new-password":"current-password";msg("#emailErr")};
  $("#toggleRegister").onclick=()=>setReg(!reg);
  const tab=email=>{$("#tabEmailBtn").classList.toggle("active",email);$("#tabPhoneBtn").classList.toggle("active",!email);$("#emailLoginForm").classList.toggle("hidden",!email);$("#phoneLoginForm").classList.toggle("hidden",email)};
  $("#tabEmailBtn").onclick=()=>tab(true);$("#tabPhoneBtn").onclick=()=>tab(false);
  $("#authGoogleBtn").onclick=async()=>{if(serverUp){try{await api("/api/auth/google",{method:"POST",body:"{}"})}catch(e){toast(e.message)}}else toast("Google sign-in needs a Google OAuth client ID and the server — use email or guest for now")};
  $("#guestLoginBtn").onclick=()=>startSession({mode:"guest"});
  $("#emailLoginForm").onsubmit=async e=>{e.preventDefault();msg("#emailErr");
    const email=$("#authEmail").value.trim().toLowerCase(),pw=$("#authPassword").value,name=$("#authName").value.trim();
    try{
      if(serverUp){const r=await api(reg?"/api/auth/register":"/api/auth/login",{method:"POST",body:JSON.stringify({email,password:pw,name})});
        return startSession({mode:"server",id:r.user.id,name:r.user.name||name,email:r.user.email,token:r.token})}
      const acc=accounts();
      if(reg){if(pw.length<8)throw new Error("Password must be at least 8 characters");if(acc[email])throw new Error("An account with this email already exists on this device");
        const salt=uid()+uid(),id="loc_"+uid();acc[email]={id,name,salt,hash:await hashPw(pw,salt)};localStorage.setItem(AKEY,JSON.stringify(acc));return startSession({mode:"local",id,name,email})}
      const a=acc[email];if(!a||a.hash!==await hashPw(pw,a.salt))throw new Error("Wrong email or password");
      startSession({mode:"local",id:a.id,name:a.name,email})
    }catch(err){msg("#emailErr",err.message)}};
  $("#sendOtpBtn").onclick=async()=>{msg("#phoneErr");const phone=$("#authPhone").value.trim();
    if(!/^\+?[\d\s-]{10,16}$/.test(phone))return msg("#phoneErr","Enter a valid mobile number");
    try{if(serverUp){const r=await api("/api/auth/otp/send",{method:"POST",body:JSON.stringify({phone})});toast(r.devCode?`Dev OTP: ${r.devCode} (no SMS provider set up)`:"OTP sent")}
      else{localOtp=String(Math.floor(Math.random()*9000)+1000);toast(`Demo OTP: ${localOtp} (offline mode sends no SMS)`)}
      $("#otpGroup").classList.remove("hidden");$("#verifyOtpBtn").classList.remove("hidden");$("#sendOtpBtn").textContent="Resend OTP";$("#authOtp").focus()}
    catch(e){msg("#phoneErr",e.message)}};
  $("#phoneLoginForm").onsubmit=async e=>{e.preventDefault();msg("#phoneErr");const phone=$("#authPhone").value.trim(),code=$("#authOtp").value.trim();
    try{if(serverUp){const r=await api("/api/auth/otp/verify",{method:"POST",body:JSON.stringify({phone,code})});return startSession({mode:"server",id:r.user.id,name:r.user.name,email:r.user.email,token:r.token})}
      if(!localOtp||code!==localOtp)throw new Error("Wrong OTP");
      startSession({mode:"local",id:"loc_ph"+phone.replace(/\D/g,""),name:"",email:null})}
    catch(err){msg("#phoneErr",err.message)}};
  if(FB.enabled){   // Firebase replaces local/server accounts when configured
    $("#authMode").textContent="Firebase sign-in — your account and progress sync across your devices.";
    $("#forgotPw").classList.remove("hidden");
    const run=async(fn,errId)=>{msg(errId);try{const u=await fn();startSession({mode:"firebase",id:u.id,name:u.name,email:u.email,phone:u.phone})}catch(e){const t=FB.friendly(e);msg(errId,t);toast(t)}};
    $("#authGoogleBtn").onclick=()=>run(()=>FB.google(),"#emailErr");
    $("#emailLoginForm").onsubmit=e=>{e.preventDefault();const email=$("#authEmail").value.trim(),pw=$("#authPassword").value,name=$("#authName").value.trim();run(()=>reg?FB.register(email,pw,name):FB.login(email,pw),"#emailErr")};
    $("#forgotPw").onclick=async()=>{const email=$("#authEmail").value.trim();if(!email)return msg("#emailErr","Type your email above first");
      try{await FB.reset(email);msg("#emailErr");toast("If that email has an account, a reset link is on its way")}catch(e){msg("#emailErr",FB.friendly(e))}};
    $("#sendOtpBtn").onclick=async()=>{msg("#phoneErr");try{await FB.phoneSend($("#authPhone").value);toast("OTP sent by SMS");
      $("#otpGroup").classList.remove("hidden");$("#verifyOtpBtn").classList.remove("hidden");$("#sendOtpBtn").textContent="Resend OTP";$("#authOtp").focus()}catch(e){msg("#phoneErr",FB.friendly(e))}};
    $("#phoneLoginForm").onsubmit=e=>{e.preventDefault();run(()=>FB.phoneVerify($("#authOtp").value.trim()),"#phoneErr")};
  }
}
$("#logoutBtn").onclick=async()=>{clearTimeout(syncT);if(canCloud())await syncUp();if(isFB()&&FB.ok){try{await FB.signOut()}catch{}}localStorage.removeItem(SKEY);location.reload()};

/* ---------- router ---------- */
const PAGES=[["dashboard","◫","Dashboard"],["syllabus","▤","Syllabus"],["pyq","✎","PYQ vault"],["cards","▭","Flashcards"],["errors","⚑","Error log"],["notes","▧","Notes"],["planner","▦","Planner"],["analytics","⌁","Analytics"],["settings","⚙","Settings"]];
const BOTTOM=["dashboard","syllabus","pyq","cards","planner"];
const built={};let cur="dashboard";
function go(id){if(!PAGES.some(p=>p[0]===id))id="dashboard";cur=id;
  $$(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+id));
  $$("[data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===id));
  $("#crumb").textContent=PAGES.find(p=>p[0]===id)[2];$("#sidebar").classList.remove("open");
  if(location.hash!=="#"+id)history.replaceState(null,"","#"+id);window.scrollTo(0,0);render()}
function render(){
  const p=S.profile,n=p.name.trim()||"Student";
  $("#sbName").textContent=n;$("#sbAvatar").textContent=n[0].toUpperCase();$("#sbSub").textContent=`${p.exam==="Both"?"JEE + NEET":p.exam} · Class ${p.cls}`;$("#sbSub").title=SESSION?.email||"";$("#logoutBtn").textContent=SESSION&&SESSION.mode!=="guest"?"Log out":"Sign in / sign up";
  const st=streak();$("#topStreak").textContent=`🔥 ${st.n} day${st.n===1?"":"s"}`;
  const pg=PG[cur];if(!built[cur]){pg.init?.($("#page-"+cur));built[cur]=true}pg.update?.($("#page-"+cur));typeset($("#page-"+cur))}
$("#pages").innerHTML=PAGES.map(p=>`<section class="page" id="page-${p[0]}"></section>`).join("");
$("#nav").innerHTML=PAGES.map(p=>`<button class="nav-item" data-nav="${p[0]}"><span>${p[1]}</span>${p[2]}</button>`).join("");
$("#bottomNav").innerHTML=BOTTOM.map(id=>{const p=PAGES.find(x=>x[0]===id);return `<button data-nav="${id}"><span>${p[1]}</span>${p[2].replace(" vault","")}</button>`}).join("");
document.addEventListener("click",e=>{const n=e.target.closest("[data-nav],[data-go]");if(n)go(n.dataset.nav||n.dataset.go)});
$("#menuBtn").onclick=()=>$("#sidebar").classList.toggle("open");
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(!$("#modal").classList.contains("hidden"))$("#mCancel").click();$("#sidebar").classList.remove("open")}});
document.addEventListener("click",e=>{const d=e.target.closest("[data-deltask]");if(d){S.tasks=S.tasks.filter(t=>t.id!==d.dataset.deltask);save();render()}});
document.addEventListener("change",e=>{const id=e.target.dataset?.task;if(!id)return;const t=S.tasks.find(x=>x.id===id);if(t){t.done=e.target.checked;t.doneOn=t.done?today():undefined;save();render()}});
const head=(eb,t,s,extra="")=>`<div class="head"><div><p class="eyebrow">${eb}</p><h1>${t}</h1><p class="sub">${s}</p></div>${extra}</div>`;
const opts=(l,sel)=>l.map(v=>`<option${v===sel?" selected":""}>${h(v)}</option>`).join("");

const PG={};
/* ---------- dashboard ---------- */
PG.dashboard={update(el){
  const list=chapters(),done=list.filter(c=>isDone(c.id)).length,sp=pct(done,list.length),m=minutesOn(today()),g=S.profile.goal;
  const tasks=S.tasks.filter(t=>t.date===today()||!t.done),td=tasks.filter(t=>t.done).length,acc=overallAcc(),st=streak(),weak=weakSpots().slice(0,3);
  const next=list.filter(c=>stOf(c.id)==="In Progress").concat(list.filter(c=>stOf(c.id)==="Not Started"&&c.weightage==="High")).slice(0,4);
  el.innerHTML=head("Your prep journey",`Let’s make today count, ${h(S.profile.name||"Student")}.`,"A focused plan today brings you closer to your target.")+
  `<div class="grid4">
   <div class="panel stat"><small>Syllabus revised/mastered</small><strong>${sp}%</strong>${bar(sp)}<small>${done} of ${list.length} chapters</small></div>
   <div class="panel stat"><small>Study time today</small><strong>${m}m</strong>${bar(pct(m,g),"c-blue")}<small>Goal ${g} min</small></div>
   <div class="panel stat"><small>Tasks completed</small><strong>${td}/${tasks.length}</strong>${bar(pct(td,tasks.length),"c-green")}<small>Open tasks carry over</small></div>
   <div class="panel stat"><small>PYQ accuracy</small><strong>${acc===null?"—":acc+"%"}</strong>${bar(acc||0,"c-orange")}<small>${S.attempts.length} attempts · 🔥 ${st.n}-day streak</small></div></div>
  <div class="grid2">
   <div class="panel"><div class="ph"><div><p class="eyebrow">Revise next</p><h2>High yield · low accuracy</h2></div><button class="link" data-go="analytics">Analytics ↗</button></div>
    <div class="list">${weak.length?weak.map(w=>`<div class="item"><span class="grow">${h(w.c.title)}</span><span class="chip">${h(w.c.subject)}</span><span class="chip ${w.acc===null?"":"w-High"}">${w.acc===null?"untested":w.acc+"%"}</span></div>`).join(""):'<div class="empty">Practice a few PYQs to surface your weak spots.</div>'}</div></div>
   <div class="panel"><div class="ph"><div><p class="eyebrow">Pick up where you left off</p><h2>Continue learning</h2></div><button class="link" data-go="syllabus">All chapters ↗</button></div>
    <div class="list">${next.length?next.map(c=>`<div class="item"><span class="grow">${h(c.title)}</span><span class="chip w-${c.weightage}">${c.weightage}</span><span class="chip">${stOf(c.id)}</span></div>`).join(""):'<div class="empty">Nothing queued. Nice work!</div>'}</div></div></div>
  <div class="panel"><div class="ph"><div><p class="eyebrow">Stay on track</p><h2>Today’s plan</h2></div><button class="link" data-go="planner">Planner ↗</button></div>
    <div class="list">${tasks.slice(0,5).map(taskRow).join("")||'<div class="empty">No tasks yet — add one in the planner.</div>'}</div></div>`}};

/* ---------- syllabus ---------- */
let sylSub="All";
PG.syllabus={init(el){el.innerHTML=head("Know your next step","Syllabus tracker","Status: Not Started → In Progress → Revised → Mastered.",
  `<div class="row"><select id="sylCls" aria-label="Class">${opts(["11","12"],S.profile.cls)}</select><select id="sylEx" aria-label="Exam">${opts(["JEE","NEET","Both"],S.profile.exam)}</select></div>`)+
  `<div class="filters" id="sylFilters"></div><div class="panel" id="sylSum" style="margin-bottom:14px"></div><div id="sylList"></div>
  <p class="tiny">Weightage and frequency bands are provisional planning estimates, not audited counts.</p>`;
  $("#sylCls").onchange=e=>{S.profile.cls=e.target.value;sylSub="All";save();render()};
  $("#sylEx").onchange=e=>{S.profile.exam=e.target.value;sylSub="All";save();render()};
  el.addEventListener("click",e=>{const b=e.target.closest("[data-sub]");if(b){sylSub=b.dataset.sub;render()}});
  el.addEventListener("change",e=>{const s=e.target.closest("[data-ch]");if(!s)return;S.status[s.dataset.ch]=s.value;save();pushStatus(s.dataset.ch,s.value);render()})},
 update(){const subs=EXAM_SUBJ[S.profile.exam];if(sylSub!=="All"&&!subs.includes(sylSub))sylSub="All";
  $("#sylCls").value=S.profile.cls;$("#sylEx").value=S.profile.exam;
  $("#sylFilters").innerHTML=["All",...subs].map(s=>`<button class="pill${s===sylSub?" active":""}" data-sub="${s}">${s}</button>`).join("");
  const all=chapters(),d=all.filter(c=>isDone(c.id)).length;
  $("#sylSum").innerHTML=`<span class="muted">Class ${S.profile.cls} · ${S.profile.exam}</span><h2>${pct(d,all.length)}% revised or mastered</h2>${bar(pct(d,all.length))}<small class="muted">${d} of ${all.length} chapters</small>`;
  if(!CH.length){$("#sylList").innerHTML='<div class="panel empty">Chapter catalog not loaded. Serve this folder over http (e.g. <code>node server.js</code>) — browsers block fetch() on file:// pages.</div>';return}
  $("#sylList").innerHTML=subs.filter(s=>sylSub==="All"||s===sylSub).map(s=>{const l=all.filter(c=>c.subject===s);
   return `<div class="panel" style="margin-bottom:14px"><div class="ph"><h2>${s}</h2><span class="muted">${l.filter(c=>isDone(c.id)).length}/${l.length}</span></div><div class="list">${l.map(c=>{const f=c.past10YearQuestionFrequency||{};
    return `<div class="item"><span class="grow"><strong>${h(c.title)}</strong><br><span class="chip w-${c.weightage}">${c.weightage} weightage</span> <span class="chip w-${f.marker||"Medium"}">${f.marker||"Medium"} 10-yr frequency (est.)</span></span>
    <select data-ch="${h(c.id)}" aria-label="Status of ${h(c.title)}">${opts(STATUSES,stOf(c.id))}</select></div>`}).join("")}</div></div>`}).join("")}};

/* ---------- PYQ vault ---------- */
const F={q:"",subject:"",chapter:"",difficulty:"",exam:"",tag:""},qStart=new Map();
PG.pyq={init(el){el.innerHTML=head("Past-paper practice","PYQ vault","Search and filter questions, then log how confident you were.")+
  `<div class="panel" style="margin-bottom:14px"><div class="row"><input id="fq" placeholder="Search questions or tags…" style="flex:1;min-width:180px" aria-label="Search">
  <select id="fs" data-f="subject"></select><select id="fc" data-f="chapter"></select><select id="fd" data-f="difficulty"></select><select id="fe" data-f="exam"></select><select id="ft" data-f="tag"></select></div>
  <p class="tiny" id="pyqNote" style="margin-top:8px"></p></div><div id="pyqList"></div>`;
  $("#fq").oninput=e=>{F.q=e.target.value;list()};
  el.addEventListener("change",e=>{const f=e.target.dataset.f;if(f){F[f]=e.target.value;list()}});
  el.addEventListener("click",e=>{
   const o=e.target.closest("[data-opt]");if(o)return answer(o.closest(".q").dataset.id,+o.dataset.opt,o.closest(".q"));
   const c=e.target.closest("[data-cat]");if(c){const a=S.attempts.findLast(x=>x.qid===c.dataset.q);if(a)a.cat=c.dataset.cat;const er=S.errors.find(x=>x.qid===c.dataset.q);if(er)er.cat=c.dataset.cat;save();toast("Error category saved")}});
  function list(){const l=PYQ.filter(x=>(!F.subject||x.subject===F.subject)&&(!F.chapter||x.chapterId===F.chapter)&&(!F.difficulty||x.difficulty===F.difficulty)&&(!F.exam||x.exam===F.exam)&&(!F.tag||x.tags.includes(F.tag))&&(!F.q||(x.q+" "+x.tags.join(" ")).toLowerCase().includes(F.q.toLowerCase())));
   $("#pyqList").innerHTML=l.length?l.map(qHTML).join(""):'<div class="panel empty">No questions match these filters.</div>';l.forEach(x=>{if(!qStart.has(x.id))qStart.set(x.id,performance.now())});typeset($("#pyqList"))}
  PG.pyq.list=list},
 update(){const tags=[...new Set(PYQ.flatMap(x=>x.tags))].sort(),chs=[...new Set(PYQ.map(x=>x.chapterId))].filter(Boolean);
  const fill=(id,label,vals,cur,fmt=v=>v)=>{$(id).innerHTML=`<option value="">${label}</option>`+vals.map(v=>`<option value="${h(v)}"${v===cur?" selected":""}>${h(fmt(v))}</option>`).join("")};
  fill("#fs","All subjects",SUBJECTS,F.subject);fill("#fc","All chapters",chs,F.chapter,id=>CHMAP.get(id)?.title||id);fill("#fd","Any difficulty",["Easy","Medium","Hard"],F.difficulty);fill("#fe","Any exam",["JEE","NEET"],F.exam);fill("#ft","Any concept tag",tags,F.tag);
  $("#pyqNote").textContent=pyqNotice||"";PG.pyq.list()}};
const answered=new Map();   // qid -> {sel,ok,secs}: results survive re-renders (they used to vanish and could be re-answered)
const CATS=["Concept gap","Calculation","Silly mistake","Ran out of time"];
const resultHTML=(x,r)=>`<div class="box"><strong>${r.ok?"✓ Correct":"✗ Not quite — added to your Error Log"}</strong> · ${r.secs}s<br>${h(x.explain)}</div>`+
  (r.ok?"":`<div class="row" style="margin-top:8px"><span class="tiny">Why did you miss it?</span>${CATS.map(c=>`<button class="pill" data-q="${h(x.id)}" data-cat="${c}">${c}</button>`).join("")}</div>`);
function qHTML(x){const ch=CHMAP.get(x.chapterId),r=answered.get(x.id);
  return `<div class="panel q" data-id="${h(x.id)}"${r?' data-done="1"':""}><div class="row"><span class="chip">${h(x.exam)}${x.year?" "+h(x.year):" · practice"}</span><span class="chip">${h(x.subject)}</span><span class="chip">${h(x.difficulty)}</span><span class="chip">${h(ch?.title||"")}</span>${x.tags.map(t=>`<span class="chip">#${h(t)}</span>`).join("")}</div>
  <h3>${h(x.q)}</h3><div class="row tiny">Confidence: ${["LOW","MEDIUM","HIGH"].map(c=>`<label><input type="radio" name="cf-${h(x.id)}" value="${c}"${c==="MEDIUM"?" checked":""}> ${c[0]+c.slice(1).toLowerCase()}</label>`).join(" ")}</div>
  ${x.options.map((o,i)=>`<button class="opt${r?(i===x.answer?" ok":i===r.sel?" bad":""):""}" data-opt="${i}"${r?" disabled":""}>${"ABCD"[i]}. ${h(o)}</button>`).join("")}<div class="ans">${r?resultHTML(x,r):""}</div></div>`}
function answer(id,sel,box){const x=PYQ.find(q=>q.id===id);if(!x||box.dataset.done)return;box.dataset.done=1;
  const ok=sel===x.answer,secs=Math.min(7200,Math.max(1,Math.round((performance.now()-(qStart.get(id)||performance.now()))/1000))),conf=($$("input[type=radio]",box).find(r=>r.checked)||{}).value||"MEDIUM";
  const a={id:uid(),qid:id,chapterId:x.chapterId,subject:x.subject,sel,correct:ok,secs,conf,ts:new Date().toISOString()};S.attempts.push(a);
  if(!ok&&!S.errors.some(e=>e.qid===id&&!e.resolved))S.errors.push({id:uid(),qid:id,ts:a.ts,resolved:false,cat:""});
  if(ok)S.errors.forEach(e=>{if(e.qid===id)e.resolved=true});save();pushAttempt(a);answered.set(id,{sel,ok,secs});
  $$(".opt",box).forEach((b,i)=>{b.disabled=true;if(i===x.answer)b.classList.add("ok");else if(i===sel)b.classList.add("bad")});
  $(".ans",box).innerHTML=resultHTML(x,{ok,secs});typeset(box);render2()}
const render2=()=>{const st=streak();$("#topStreak").textContent=`🔥 ${st.n} day${st.n===1?"":"s"}`};

/* ---------- flashcards ---------- */
const DECK=[
 {id:"f1",s:"Physics",t:"Equations of motion",b:"$v=u+at$, $\\;s=ut+\\tfrac12at^2$, $\\;v^2=u^2+2as$"},
 {id:"f2",s:"Physics",t:"Projectile range",b:"$R=\\dfrac{u^2\\sin2\\theta}{g}$, maximum at $\\theta=45^\\circ$"},
 {id:"f3",s:"Physics",t:"Work–energy theorem",b:"$W_{net}=\\Delta K=\\tfrac12mv^2-\\tfrac12mu^2$"},
 {id:"f4",s:"Physics",t:"Resistors in parallel",b:"$\\dfrac1{R_{eq}}=\\dfrac1{R_1}+\\dfrac1{R_2}+\\cdots$"},
 {id:"f5",s:"Physics",t:"Faraday’s law",b:"$\\varepsilon=-\\dfrac{d\\Phi_B}{dt}$"},
 {id:"f6",s:"Chemistry",t:"First-order half-life",b:"$t_{1/2}=\\dfrac{0.693}{k}$; $k$ has unit $\\text{s}^{-1}$"},
 {id:"f7",s:"Chemistry",t:"Nernst equation (298 K)",b:"$E=E^\\circ-\\dfrac{0.0591}{n}\\log Q$"},
 {id:"f8",s:"Chemistry",t:"Ideal gas law",b:"$PV=nRT$"},
 {id:"f9",s:"Mathematics",t:"Quadratic formula",b:"$x=\\dfrac{-b\\pm\\sqrt{b^2-4ac}}{2a}$; sum of roots $=-b/a$"},
 {id:"f10",s:"Mathematics",t:"Euler’s formula",b:"$e^{i\\theta}=\\cos\\theta+i\\sin\\theta$"},
 {id:"f11",s:"Mathematics",t:"Powers of i",b:"$i^2=-1,\\; i^3=-i,\\; i^4=1$ (cycle of 4)"},
 {id:"f12",s:"Biology",t:"Five-kingdom system",b:"Monera, Protista, Fungi, Plantae, Animalia — Monera holds all prokaryotes."},
 {id:"f13",s:"Biology",t:"Site of fertilisation (human)",b:"Ampullary region of the fallopian tube."},
 {id:"f14",s:"Biology",t:"Double fertilisation",b:"One male gamete + egg → zygote; the other + two polar nuclei → triploid primary endosperm nucleus."}];
let cardSub="",cardI=0,flip=false;
const deck=()=>DECK.filter(c=>!cardSub||c.s===cardSub);
PG.cards={init(el){el.innerHTML=head("Quick revision","Flashcards","Tap to flip. Swipe right = knew it, swipe left = review again.",`<select id="cSub" aria-label="Subject"></select>`)+
  `<div id="cardArea"></div>`;
  $("#cSub").onchange=e=>{cardSub=e.target.value;cardI=0;flip=false;render()};
  const area=$("#cardArea");let x0=null,moved=false;
  area.addEventListener("pointerdown",e=>{if(e.target.closest(".card3d")){x0=e.clientX;moved=false}});
  area.addEventListener("pointermove",e=>{if(x0!==null){const dx=e.clientX-x0;if(Math.abs(dx)>10)moved=true;const c=$(".card3d",area);if(c)c.style.transform=`translateX(${dx}px) rotate(${dx/25}deg)`}});
  area.addEventListener("pointerup",e=>{if(x0===null)return;const dx=e.clientX-x0;x0=null;const c=$(".card3d",area);if(c)c.style.transform="";
    if(dx>70)mark("known");else if(dx<-70)mark("review");else if(!moved){flip=!flip;render()}});
  area.addEventListener("pointercancel",()=>{x0=null;const c=$(".card3d",area);if(c)c.style.transform=""});
  area.addEventListener("click",e=>{const b=e.target.closest("[data-m]");if(b)mark(b.dataset.m)});
  document.addEventListener("keydown",e=>{if(cur!=="cards"||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
    if(e.key===" "){e.preventDefault();flip=!flip;render()}else if(e.key==="ArrowRight")mark("known");else if(e.key==="ArrowLeft")mark("review")})},
 update(){$("#cSub").innerHTML=`<option value="">All subjects</option>`+opts(SUBJECTS,cardSub);$("#cSub").value=cardSub;
  const d=deck(),c=d[cardI%Math.max(d.length,1)],known=d.filter(x=>S.cards[x.id]==="known").length;
  $("#cardArea").innerHTML=!c?'<div class="panel empty">No cards.</div>':`<div class="row tiny" style="margin-bottom:8px"><span>Card ${cardI%d.length+1} of ${d.length}</span><span>· ${known} known</span></div>
  <div class="card3d" tabindex="0" aria-label="Flashcard — press space to flip"><div><span class="lbl">${flip?"ANSWER":c.s.toUpperCase()}</span><div class="face">${flip?c.b:h(c.t)}</div></div></div>
  <div class="row center" style="margin-top:14px"><button class="btn" data-m="review">↺ Review again</button><button class="btn p" data-m="known">✓ Knew it</button></div>
  <p class="tiny center" style="margin-top:8px">Cards are bundled with the app and work offline once cached.</p>`}};
function mark(m){const d=deck(),c=d[cardI%d.length];if(!c)return;S.cards[c.id]=m;save();cardI=(cardI+1)%d.length;flip=false;render()}

/* ---------- error log ---------- */
let errShow="open";
PG.errors={init(el){el.innerHTML=head("Learn from mistakes","Error log vault","Questions you got wrong during practice.",`<div class="row"><button class="pill active" data-ef="open">Open</button><button class="pill" data-ef="resolved">Resolved</button></div>`)+`<div id="errList"></div>`;
  el.addEventListener("click",e=>{const f=e.target.closest("[data-ef]");if(f){errShow=f.dataset.ef;render();return}
   const r=e.target.closest("[data-res]"),d=e.target.closest("[data-del]");
   if(r){const x=S.errors.find(z=>z.id===r.dataset.res);if(x){x.resolved=!x.resolved;save();render()}}
   if(d){S.errors=S.errors.filter(z=>z.id!==d.dataset.del);save();render()}})},
 update(el){$$("[data-ef]",el).forEach(b=>b.classList.toggle("active",b.dataset.ef===errShow));
  const l=S.errors.filter(e=>errShow==="open"?!e.resolved:e.resolved).reverse();
  $("#errList").innerHTML=l.length?l.map(e=>{const x=PYQ.find(q=>q.id===e.qid);if(!x)return"";
   return `<div class="panel q"><div class="row"><span class="chip">${x.subject}</span><span class="chip">${h(CHMAP.get(x.chapterId)?.title||"")}</span>${e.cat?`<span class="chip w-High">${h(e.cat)}</span>`:""}<span class="tiny">${new Date(e.ts).toLocaleDateString()}</span></div>
   <h3>${h(x.q)}</h3><div class="box"><strong>Answer: ${"ABCD"[x.answer]}. ${h(x.options[x.answer])}</strong><br>${h(x.explain)}</div>
   <div class="row" style="margin-top:10px"><button class="btn sm" data-res="${e.id}">${e.resolved?"Reopen":"Mark resolved"}</button><button class="btn sm danger" data-del="${e.id}">Remove</button></div></div>`}).join(""):`<div class="panel empty">${errShow==="open"?"No open errors. Wrong answers in the PYQ vault land here.":"Nothing resolved yet."}</div>`}};

/* ---------- notes (markdown + images) ---------- */
let curNote=null,preview=false,noteQ="";
function md(src){let t=h(src);const lines=t.split("\n");let out="",ul=false;
  for(let l of lines){l=l.replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/(^|[^*])\*([^*]+)\*/g,"$1<i>$2</i>");
   let m;if(m=l.match(/^(#{1,3})\s+(.*)/)){if(ul){out+="</ul>";ul=false}out+=`<h${m[1].length}>${m[2]}</h${m[1].length}>`}
   else if(m=l.match(/^\s*[-*]\s+(.*)/)){if(!ul){out+="<ul>";ul=true}out+=`<li>${m[1]}</li>`}
   else{if(ul){out+="</ul>";ul=false}out+=l.trim()?`<p>${l}</p>`:""}}
  return out+(ul?"</ul>":"")}
const note=()=>S.notes.find(n=>n.id===curNote);
PG.notes={init(el){el.innerHTML=head("Personal knowledge base","Notes &amp; formulas","Markdown supported. Use $…$ for formulas. Attach images for diagrams.",`<button class="btn p" id="newNote">＋ New note</button>`)+
  `<div class="notes-layout"><div class="panel"><input id="nSearch" placeholder="Search notes…" style="width:100%" aria-label="Search notes"><div class="list" id="nList" style="margin-top:8px"></div></div>
  <div class="panel"><div id="nEmpty" class="empty">Select a note or create a new one.</div><div id="nForm" class="hidden">
   <div class="ph"><span class="eyebrow">Personal note</span><div class="row"><button class="link" id="nPrev">Preview</button><button class="link danger" id="nDel">Delete</button></div></div>
   <input id="nTitle" class="ntitle" placeholder="Untitled note" aria-label="Title"><div class="row"><select id="nSub">${opts([...SUBJECTS,"General"],"General")}</select><label class="btn sm">＋ Image<input id="nImg" type="file" accept="image/*" hidden></label><span class="tiny" id="nSaved"></span></div>
   <textarea id="nBody" class="nbody" placeholder="Write a formula, concept or revision note…" aria-label="Body" style="margin-top:10px"></textarea><div id="nMd" class="md hidden"></div><div class="thumbs" id="nThumbs"></div></div></div></div>`;
  const sv=()=>{const n=note();if(!n)return;n.title=$("#nTitle").value;n.subject=$("#nSub").value;n.body=$("#nBody").value;n.updated=Date.now();save();$("#nSaved").textContent="Saved";listN()};
  const mk=()=>{const n={id:uid(),title:"",subject:"General",body:"",images:[],updated:Date.now()};S.notes.push(n);save();curNote=n.id;preview=false;render();$("#nTitle").focus()};
  $("#newNote").onclick=mk;$("#nEmpty").onclick=mk;
  ["#nTitle","#nSub","#nBody"].forEach(s=>$(s).addEventListener("input",sv));
  $("#nSearch").oninput=e=>{noteQ=e.target.value.toLowerCase();listN()};
  $("#nList").onclick=e=>{const b=e.target.closest("[data-n]");if(b){curNote=b.dataset.n;preview=false;render()}};
  $("#nPrev").onclick=()=>{preview=!preview;render()};
  $("#nDel").onclick=async()=>{if(await ask("Delete this note?","This cannot be undone.")){S.notes=S.notes.filter(n=>n.id!==curNote);curNote=null;save();render()}};
  $("#nThumbs").onclick=e=>{const b=e.target.closest("[data-rm]");if(b){const n=note();n.images.splice(+b.dataset.rm,1);save();render()}};
  $("#nImg").onchange=async e=>{const f=e.target.files[0],n=note();e.target.value="";if(!f||!n)return;if((n.images||[]).length>=6)return toast("Max 6 images per note");
    try{n.images.push(await shrink(f));save();render()}catch{toast("Could not read that image")}};
  window.listN=listN;function listN(){const l=S.notes.filter(n=>!noteQ||(n.title+" "+n.body).toLowerCase().includes(noteQ)).sort((a,b)=>b.updated-a.updated);
   $("#nList").innerHTML=l.length?l.map(n=>`<button class="item" data-n="${n.id}" style="text-align:left;${n.id===curNote?"outline:2px solid var(--pri)":""}"><span class="grow"><strong>${h(n.title||"Untitled note")}</strong><br><small class="muted">${h(n.subject)} · ${h(n.body.slice(0,40))}</small></span></button>`).join(""):'<div class="empty">No notes.</div>'}},
 update(){const n=note();$("#nEmpty").classList.toggle("hidden",!!n);$("#nForm").classList.toggle("hidden",!n);window.listN();if(!n)return;
  if(document.activeElement!==$("#nTitle"))$("#nTitle").value=n.title;if(document.activeElement!==$("#nBody"))$("#nBody").value=n.body;$("#nSub").value=n.subject;
  $("#nBody").classList.toggle("hidden",preview);$("#nMd").classList.toggle("hidden",!preview);$("#nPrev").textContent=preview?"Edit":"Preview";
  if(preview)$("#nMd").innerHTML=md(n.body);
  $("#nThumbs").innerHTML=(n.images||[]).map((s,i)=>`<div><img src="${h(s)}" alt="Attachment ${i+1}"><button data-rm="${i}" aria-label="Remove image">×</button></div>`).join("")}};
function shrink(file){return new Promise((ok,bad)=>{const r=new FileReader();r.onerror=bad;r.onload=()=>{const im=new Image();im.onerror=bad;im.onload=()=>{const k=Math.min(1,800/Math.max(im.width,im.height)),c=document.createElement("canvas");c.width=Math.max(1,Math.round(im.width*k));c.height=Math.max(1,Math.round(im.height*k));const g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);g.drawImage(im,0,0,c.width,c.height);ok(c.toDataURL("image/jpeg",.7))};im.src=r.result};r.readAsDataURL(file)})}

/* ---------- planner + pomodoro ---------- */
const taskRow=t=>`<div class="item${t.done?" done":""}"><input type="checkbox" data-task="${t.id}" ${t.done?"checked":""} aria-label="Complete"><span class="grow">${h(t.text)}</span><span class="chip">${h(t.subject)}</span><button class="x" data-deltask="${t.id}" aria-label="Delete task">✕</button></div>`;
let tMin=25,tLeft=1500,tId=null,tEnd=0,sound=true;
function beep(){if(!sound)return;try{const c=new (window.AudioContext||window.webkitAudioContext)();[0,.3,.6].forEach(o=>{const s=c.createOscillator(),g=c.createGain();s.frequency.value=880;g.gain.value=.15;s.connect(g);g.connect(c.destination);s.start(c.currentTime+o);s.stop(c.currentTime+o+.2)})}catch{}}
function logStudy(m,tag){const d=today();S.study[d]=(S.study[d]||0)+m;S.sessions.push({id:uid(),date:d,m,tag:tag||"Untagged"});save()}
const mmss=s=>String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
PG.planner={init(el){el.innerHTML=head("Make time for what matters","Study planner","Plan your day, tag your focus sessions, hit your goal.")+
  `<div class="grid2"><div class="panel"><div class="ph"><div><p class="eyebrow">Daily checklist</p><h2>Your tasks</h2></div><button class="link" id="clr">Clear completed</button></div>
   <div class="row" style="margin-bottom:12px"><input id="tIn" placeholder="e.g. Revise Newton’s laws" style="flex:1;min-width:140px" aria-label="New task"><select id="tSub">${opts([...SUBJECTS,"General"],"General")}</select><button class="btn p" id="tAdd">Add</button></div><div class="list" id="tList"></div></div>
   <div><div class="panel center"><p class="eyebrow">Focus session</p><h2>Pomodoro timer</h2><input id="tTag" placeholder="Tag, e.g. 50m • Electrostatics PYQs" style="width:100%;margin-top:8px" aria-label="Session tag">
    <div class="timer"><div><strong id="tDisp">25:00</strong><small id="tSt">READY TO FOCUS</small></div></div>
    <div class="row center"><button class="btn p" id="tGo">Start focus</button><button class="btn" id="tRs">Reset</button><label class="tiny"><input type="checkbox" id="tSnd" checked> sound</label></div>
    <div class="row center" style="margin-top:10px" id="pre">${[25,45,50,60].map(m=>`<button class="pill${m===25?" active":""}" data-m="${m}">${m} min</button>`).join("")}</div></div>
   <div class="panel" style="margin-top:14px"><p class="eyebrow">Daily target</p><h2>Study goal</h2><div class="row" style="margin-top:8px"><input id="gIn" type="number" min="15" max="900" step="15" aria-label="Goal minutes"><span class="muted">min/day</span><button class="ib" id="gSave" aria-label="Save goal">✓</button></div><div id="gBar"></div><button class="link" id="gLog">＋ Log 25 minutes manually</button></div></div></div>`;
  const add=()=>{const v=$("#tIn").value.trim();if(!v)return toast("Type a task first");S.tasks.push({id:uid(),text:v.slice(0,120),subject:$("#tSub").value,done:false,date:today()});$("#tIn").value="";save();render()};
  $("#tAdd").onclick=add;$("#tIn").onkeydown=e=>{if(e.key==="Enter")add()};
  $("#clr").onclick=()=>{S.tasks=S.tasks.filter(t=>!t.done);save();render()};
  $("#tSnd").onchange=e=>sound=e.target.checked;
  $("#gSave").onclick=()=>{const v=+$("#gIn").value;if(!(v>=15&&v<=900))return toast("Goal must be 15–900 minutes");S.profile.goal=v;save();render();toast("Goal saved")};
  $("#gLog").onclick=()=>{logStudy(25,$("#tTag").value.trim());render();toast("25 minutes logged")};
  $("#tGo").onclick=()=>{if(tId){clearInterval(tId);tId=null;tLeft=Math.max(0,Math.round((tEnd-Date.now())/1000));$("#tGo").textContent="Resume";$("#tSt").textContent="PAUSED";return}
    tEnd=Date.now()+tLeft*1000;$("#tGo").textContent="Pause";$("#tSt").textContent="FOCUSING";
    tId=setInterval(()=>{tLeft=Math.max(0,Math.round((tEnd-Date.now())/1000));$("#tDisp").textContent=mmss(tLeft);
     if(!tLeft){clearInterval(tId);tId=null;logStudy(tMin,$("#tTag").value.trim());beep();toast(`Session complete — ${tMin} min logged`);tLeft=tMin*60;$("#tGo").textContent="Start focus";$("#tSt").textContent="SESSION COMPLETE";$("#tDisp").textContent=mmss(tLeft);render()}},500)};
  const reset=()=>{clearInterval(tId);tId=null;tLeft=tMin*60;$("#tDisp").textContent=mmss(tLeft);$("#tGo").textContent="Start focus";$("#tSt").textContent="READY TO FOCUS"};
  $("#tRs").onclick=reset;$("#pre").onclick=e=>{const b=e.target.closest("[data-m]");if(!b)return;tMin=+b.dataset.m;$$("#pre .pill").forEach(x=>x.classList.toggle("active",x===b));reset()};
},
 update(){$("#tList").innerHTML=S.tasks.length?S.tasks.map(taskRow).join(""):'<div class="empty">No tasks yet. Add one small, clear task.</div>';
  const m=minutesOn(today()),g=S.profile.goal;if(document.activeElement!==$("#gIn"))$("#gIn").value=g;$("#gBar").innerHTML=bar(pct(m,g),"c-blue")+`<p class="muted">${m} of ${g} minutes today</p>`}};

/* ---------- analytics ---------- */
const lastN=n=>[...Array(n)].map((_,i)=>{const d=new Date();d.setDate(d.getDate()-(n-1-i));return d});
PG.analytics={update(el){
  const acc=chapterAcc(),list=chapters(),days=lastN(7),mins=days.map(d=>minutesOn(dkey(d))),mx=Math.max(S.profile.goal,...mins,1),st=streak(),weak=weakSpots();
  const tags={};S.sessions.filter(s=>days.some(d=>dkey(d)===s.date)).forEach(s=>tags[s.tag]=(tags[s.tag]||0)+s.m);
  el.innerHTML=head("Measure what you practise","Performance analytics","Based only on activity saved in this browser.",`<button class="btn p" id="wkCard">⬇ Weekly summary card</button>`)+
  `<div class="grid4"><div class="panel stat"><small>Attempts</small><strong>${S.attempts.length}</strong></div><div class="panel stat"><small>Accuracy</small><strong>${overallAcc()===null?"—":overallAcc()+"%"}</strong></div>
   <div class="panel stat"><small>Minutes logged</small><strong>${Object.values(S.study).reduce((a,b)=>a+b,0)}</strong></div><div class="panel stat"><small>Streak (1 grace day)</small><strong>🔥 ${st.n}</strong><small>${st.graces?`${st.graces} grace day(s) used`:"no grace used"}</small></div></div>
  <div class="grid2"><div class="panel"><h2>Weak-spot heatmap</h2><p class="tiny">Accuracy per chapter · grey = no attempts</p><div class="heat" style="margin-top:8px">${list.map(c=>{const a=acc[c.id],p=a?pct(a.ok,a.n):null,k=p===null?0:p<40?1:p<60?2:p<80?3:4;return `<div class="cell h${k}" title="${h(c.title)}"><b>${p===null?"—":p+"%"}</b>${h(c.title.length>26?c.title.slice(0,25)+"…":c.title)}</div>`}).join("")}</div></div>
   <div class="panel"><h2>High yield • low accuracy</h2><p class="tiny">High-weightage chapters scoring under 60%, or not yet revised.</p><div class="list" style="margin-top:8px">${weak.length?weak.slice(0,8).map(w=>`<div class="item"><span class="grow">${h(w.c.title)}</span><span class="chip">${h(w.c.subject)}</span><span class="chip w-High">${w.acc===null?"untested":w.acc+"%"}</span></div>`).join(""):'<div class="empty">No weak spots detected yet.</div>'}</div></div></div>
  <div class="grid2"><div class="panel"><h2>Study time vs goal (7 days)</h2><div class="bars">${mins.map((m,i)=>`<div class="col">${m}<i style="height:${m/mx*100}%"></i>${days[i].toLocaleDateString(undefined,{weekday:"short"})}</div>`).join("")}<div class="goalline" style="bottom:${S.profile.goal/mx*100}%"></div></div><p class="tiny">Dashed line = daily goal (${S.profile.goal} min).</p></div>
   <div class="panel"><h2>Focus sessions by tag</h2><div class="list" style="margin-top:8px">${Object.entries(tags).sort((a,b)=>b[1]-a[1]).map(([t,m])=>`<div class="item"><span class="grow">${h(t)}</span><span class="chip">${m} min</span></div>`).join("")||'<div class="empty">Tag a Pomodoro session to see it here.</div>'}</div></div></div>`;
  $("#wkCard").onclick=weeklyCard}};
function weeklyCard(){const days=lastN(7),keys=days.map(d=>dkey(d)),mins=keys.reduce((a,k)=>a+minutesOn(k),0),at=S.attempts.filter(a=>keys.includes(dkey(new Date(a.ts)))),ok=at.filter(a=>a.correct).length,st=streak();
  const c=document.createElement("canvas");c.width=900;c.height=500;const x=c.getContext("2d"),g=x.createLinearGradient(0,0,900,500);g.addColorStop(0,"#1b1647");g.addColorStop(1,"#0b1020");x.fillStyle=g;x.fillRect(0,0,900,500);
  x.fillStyle="#7c6cff";x.font="bold 22px system-ui";x.fillText("monostudy · WEEKLY SUMMARY",50,70);x.fillStyle="#fff";x.font="bold 42px system-ui";x.fillText(S.profile.name||"Student",50,130);
  x.fillStyle="#8f9bc4";x.font="20px system-ui";x.fillText(`${days[0].toLocaleDateString()} – ${days[6].toLocaleDateString()}`,50,165);
  [["Minutes studied",mins],["PYQs attempted",at.length],["Accuracy",at.length?pct(ok,at.length)+"%":"—"],["Streak",st.n+" days"]].forEach(([l,v],i)=>{const px=50+(i%2)*420,py=230+Math.floor(i/2)*115;x.fillStyle="#141b33";x.fillRect(px,py,380,95);x.fillStyle="#8f9bc4";x.font="18px system-ui";x.fillText(l,px+20,py+32);x.fillStyle="#fff";x.font="bold 36px system-ui";x.fillText(String(v),px+20,py+75)});
  c.toBlob(b=>{const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="monostudy-weekly-summary.png";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500)});toast("Summary card downloaded")}

/* ---------- file access helpers ---------- */
function download(name,text,type="application/json"){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1500)}
const SAMPLE_Q={id:"my_phy_001",exam:"JEE",year:null,subject:"Physics",chapterId:"class-11-physics-02",difficulty:"Easy",tags:["kinematics"],q:"A car accelerates from rest at $2\\,\\text{m/s}^2$ for $5\\,\\text{s}$. Final speed?",options:["5 m/s","10 m/s","15 m/s","20 m/s"],answer:1,explain:"$v=u+at=10\\,\\text{m/s}$."};
function mergePYQ(){const m=new Map(BASE_PYQ.map(q=>[q.id,q]));S.customPyq.forEach(q=>m.set(q.id,q));PYQ=[...m.values()]}
// strict whitelist: imported files are untrusted input
function cleanQuestions(raw){const ok=[];let bad=0;const str=(v,n)=>typeof v==="string"?v.slice(0,n):"";
  for(const r of raw){const o=r&&typeof r==="object"?r:{};
    const valid=typeof o.id==="string"&&o.id&&o.id.length<=64&&str(o.q,1).trim()&&Array.isArray(o.options)&&o.options.length>=2&&o.options.length<=4&&o.options.every(x=>typeof x==="string"&&x.trim())&&Number.isInteger(o.answer)&&o.answer>=0&&o.answer<o.options.length&&SUBJECTS.includes(o.subject);
    if(!valid){bad++;continue}
    ok.push({id:o.id,exam:["JEE","NEET"].includes(o.exam)?o.exam:"JEE",year:Number.isInteger(o.year)?o.year:null,subject:o.subject,chapterId:CHMAP.has(o.chapterId)?o.chapterId:"",
      difficulty:["Easy","Medium","Hard"].includes(o.difficulty)?o.difficulty:"Medium",tags:(Array.isArray(o.tags)?o.tags:[]).filter(t=>typeof t==="string").slice(0,8).map(t=>t.slice(0,30)),
      q:str(o.q,2000),options:o.options.map(x=>x.slice(0,300)),answer:o.answer,explain:str(o.explain,1500),custom:true})}
  return {ok,bad}}
async function importQuestions(f){if(!f)return;if(f.size>5e6)return toast("File too large (max 5 MB)");
  let d;try{d=JSON.parse(await f.text())}catch{return toast("That file is not valid JSON")}
  const raw=Array.isArray(d)?d:d&&d.questions;if(!Array.isArray(raw))return toast('Expected a list, or an object with a "questions" list');
  const {ok,bad}=cleanQuestions(raw);if(!ok.length)return toast(`No valid questions found (${bad} rejected)`);
  const m=new Map(S.customPyq.map(q=>[q.id,q]));ok.forEach(q=>m.set(q.id,q));S.customPyq=[...m.values()];save();mergePYQ();render();
  toast(`Imported ${ok.length} question(s)${bad?`, ${bad} rejected`:""}`)}

/* ---------- settings ---------- */
let deferred=null;
PG.settings={init(el){el.innerHTML=head("Your space, your goals","Profile &amp; settings","Saved locally on this device.")+
  `<div class="grid2"><div class="panel"><h2>Student profile</h2><form class="form" id="pf" style="margin-top:12px"><label>Display name<input id="pName" maxlength="40"></label>
   <label>Class<select id="pCls">${opts(["11","12"])}</select></label><label>Target exam<select id="pEx">${opts(["JEE","NEET","Both"])}</select></label>
   <label>Daily goal (minutes)<input id="pGoal" type="number" min="15" max="900" step="15"></label><button class="btn p" type="submit">Save profile</button></form></div>
   <div class="panel"><h2>Sync &amp; backup</h2><p class="muted" style="margin:6px 0 10px">Optional: push chapter statuses and recent attempts to the Node API. Accounts are not part of this build, so data is keyed to an anonymous device id.</p>
   <div class="row"><button class="btn" id="push">Push local data to server</button><button class="btn" id="inst" hidden>Install app</button></div>
   <div class="row" style="margin-top:12px"><button class="btn" id="exp">Export backup</button><label class="btn">Import backup<input type="file" id="imp" accept="application/json" hidden></label></div>
   <div class="row" style="margin-top:12px"><label class="btn">Import questions (.json)<input type="file" id="impQ" accept="application/json,.json" hidden></label><button class="btn" id="expQ">Question file template</button><button class="btn" id="clrQ">Remove imported</button></div>
   <p class="tiny" id="qInfo" style="margin-top:6px"></p>
   <p class="muted" style="margin:16px 0 8px">Reset removes everything saved in this browser.</p><button class="btn danger-bg" id="rst">Reset all local data</button></div></div>`;
  $("#pf").onsubmit=e=>{e.preventDefault();const g=+$("#pGoal").value;if(!(g>=15&&g<=900))return toast("Goal must be 15–900");S.profile={name:$("#pName").value.trim(),cls:$("#pCls").value,exam:$("#pEx").value,goal:g};save();render();toast("Profile saved")};
  $("#push").onclick=pushAll;
  $("#impQ").onchange=e=>{importQuestions(e.target.files[0]);e.target.value=""};
  $("#expQ").onclick=()=>download("monostudy-questions-template.json",JSON.stringify({notice:"My own practice questions",questions:[SAMPLE_Q]},null,2));
  $("#clrQ").onclick=async()=>{if(S.customPyq.length&&await ask("Remove imported questions?","Your attempts stay, but those questions disappear from the vault.")){S.customPyq=[];save();mergePYQ();render()}};
  $("#exp").onclick=()=>download("monostudy-backup.json",JSON.stringify(S,null,2));
  $("#imp").onchange=e=>{const f=e.target.files[0];if(!f)return;if(f.size>12e6){e.target.value="";return toast("Backup too large (max 12 MB)")}const r=new FileReader();r.onload=()=>{try{const d=JSON.parse(r.result);if(!d||typeof d!=="object"||Array.isArray(d))throw 0;S=normalize(d);S.uid=SESSION&&SESSION.mode!=="guest"?SESSION.id:(S.uid||"usr_"+uid());answered.clear();mergePYQ();save();toast("Backup imported");render()}catch{toast("Invalid backup file")}e.target.value=""};r.readAsText(f)};
  $("#rst").onclick=async()=>{if(await ask("Reset all data?","Progress, notes, attempts and tasks in this browser will be deleted.")){S=fresh();if(SESSION&&SESSION.mode!=="guest")S.uid=SESSION.id;answered.clear();mergePYQ();save();curNote=null;render();toast("Data reset")}};
  $("#inst").onclick=async()=>{if(!deferred)return;deferred.prompt();await deferred.userChoice;deferred=null;$("#inst").hidden=$("#installBtn").hidden=true}},
 update(){const p=S.profile;$("#qInfo").textContent=`${S.customPyq.length} imported question(s) · ${BASE_PYQ.length} built in`;if(document.activeElement.closest?.("#pf"))return;$("#pName").value=p.name;$("#pCls").value=p.cls;$("#pEx").value=p.exam;$("#pGoal").value=p.goal;$("#inst").hidden=!deferred}};
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferred=e;$("#installBtn").hidden=false;if(built.settings)$("#inst").hidden=false});
$("#installBtn").onclick=async()=>{if(!deferred)return;deferred.prompt();await deferred.userChoice;deferred=null;$("#installBtn").hidden=true};
window.addEventListener("appinstalled",()=>{deferred=null;$("#installBtn").hidden=true});

/* ---------- boot ---------- */
function applyCatalog(d){CH=Array.isArray(d?.chapters)?d.chapters:[];CHMAP=new Map(CH.map(c=>[c.id,c]));migrateLegacy()}
function applyPYQ(d){BASE_PYQ=Array.isArray(d?.questions)?d.questions:[];pyqNotice=d?.notice||"";mergePYQ()}
async function boot(){
  $("#year").textContent=new Date().getFullYear();
  await pingServer();
  if(FB.enabled){   // restore the Firebase session (or finish a Google redirect) before deciding what to show
    let u=null,failed=false;try{u=await FB.init()}catch{failed=true}      // failed = SDK unreachable (offline first run): keep working locally
    if(!failed){
      if(u&&(!SESSION||(SESSION.mode==="firebase"&&SESSION.id!==u.id)))return startSession({mode:"firebase",id:u.id,name:u.name,email:u.email,phone:u.phone});
      if(!u&&SESSION&&SESSION.mode==="firebase"){localStorage.removeItem(SKEY);return location.reload()}   // signed out elsewhere / expired
    }
  }
  if("serviceWorker" in navigator&&(location.protocol==="https:"||location.hostname==="localhost"))navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  if(!SESSION){initAuth();$("#authScreen").classList.remove("hidden");return}      // signed out: only the login screen is active
  if(SESSION.mode!=="guest"){S.uid=SESSION.id;if(!S.profile.name&&SESSION.name)S.profile.name=SESSION.name}
  // 1) data embedded via <script> — works on file:// and offline
  applyCatalog(window.MONO_CHAPTERS);applyPYQ(window.MONO_PYQ);
  go(location.hash.slice(1)||"dashboard");
  // 2) over http, refresh from the server copy if it is newer / editable
  if(canServer){const get=u=>fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.json():Promise.reject());
    try{applyCatalog(await get("chapter-data.json"))}catch{}try{applyPYQ(await get("pyq-data.json"))}catch{}}
  if(await syncDown()){mergePYQ()}
  render();watchCloud();
  if(!CH.length)toast("Chapter data failed to load — check that chapter-data.js sits next to index.html");
}
window.addEventListener("hashchange",()=>{if(SESSION)go(location.hash.slice(1))});
boot();
