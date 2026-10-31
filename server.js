// Monostudy server: Node built-ins only. Serves the frontend + REST/GraphQL API.
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const catalog=require("./chapter-data.json"),pyq=require("./pyq-data.json");
const PORT=Number(process.env.PORT||3000),ROOT=__dirname;
const STATUS_FILE=path.join(ROOT,"chapter-status.json"),ATTEMPTS_FILE=path.join(ROOT,"attempts.json");
const VALID=new Set(["Not Started","In Progress","Revised","Mastered"]);
const MIME={".html":"text/html",".css":"text/css",".js":"text/javascript",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"};
const PUBLIC=new Set(["index.html","style.css","app.js","manifest.json","service-worker.js","chapter-data.json","pyq-data.json","icons/icon.svg"]);
const readJSON=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return d}};
const writeJSON=(f,v)=>{fs.writeFileSync(f+".tmp",JSON.stringify(v,null,2));fs.renameSync(f+".tmp",f)};
const HEAD={"Access-Control-Allow-Origin":process.env.CORS_ORIGIN||"*","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS","Access-Control-Allow-Headers":"Content-Type","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const send=(res,code,body)=>{res.writeHead(code,{...HEAD,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(code===204?"":JSON.stringify(body))};
// simple per-IP rate limit (120 req/min) to survive traffic spikes / abuse
const hits=new Map();
setInterval(()=>hits.clear(),60000).unref();
const limited=ip=>{const n=(hits.get(ip)||0)+1;hits.set(ip,n);return n>120};
const bodyOf=req=>new Promise((ok,bad)=>{let d="",n=0;req.on("data",c=>{n+=c.length;if(n>1e6){bad(new Error("Body too large"));req.destroy()}else d+=c});req.on("end",()=>{try{ok(d?JSON.parse(d):{})}catch{bad(new Error("Invalid JSON body"))}});req.on("error",bad)});
const view=(c,s)=>({...c,status:s[c.id]||"Not Started"});
function serveStatic(req,res,pathname){
  const rel=pathname==="/"?"index.html":decodeURIComponent(pathname.slice(1));
  if(!PUBLIC.has(rel))return send(res,404,{error:"Not found"});
  fs.readFile(path.join(ROOT,rel),(e,buf)=>{
    if(e)return send(res,404,{error:"Not found"});
    res.writeHead(200,{"Content-Type":(MIME[path.extname(rel)]||"application/octet-stream")+"; charset=utf-8","Cache-Control":rel==="service-worker.js"?"no-cache":"public, max-age=3600","X-Content-Type-Options":"nosniff"});
    res.end(buf);
  });
}
function accuracyFor(attempts,chapterId){
  const l=attempts.filter(a=>a.chapter_id===chapterId);
  return {attempts:l.length,accuracy:l.length?Math.round(l.filter(a=>a.is_correct).length/l.length*100):null};
}
async function handle(req,res){
  if(req.method==="OPTIONS")return send(res,204);
  const ip=req.socket.remoteAddress||"?";
  if(limited(ip))return send(res,429,{error:"Too many requests"});
  const url=new URL(req.url,"http://localhost"),p=url.pathname;
  if(req.method==="GET"&&!p.startsWith("/api/")&&p!=="/graphql")return serveStatic(req,res,p);
  if(req.method==="GET"&&p==="/api/health")return send(res,200,{ok:true,service:"monostudy-api"});
  if(req.method==="GET"&&p==="/api/chapters"){
    let l=catalog.chapters;const c=url.searchParams.get("class"),s=url.searchParams.get("subject");
    if(c)l=l.filter(x=>x.class===Number(c));if(s)l=l.filter(x=>x.subject.toLowerCase()===s.toLowerCase());
    const st=readJSON(STATUS_FILE,{});return send(res,200,{schemaVersion:catalog.schemaVersion,total:l.length,chapters:l.map(x=>view(x,st))});
  }
  if(req.method==="GET"&&p==="/api/status")return send(res,200,{statuses:readJSON(STATUS_FILE,{})});
  const m=p.match(/^\/api\/chapters\/([^/]+)\/status$/);
  if(req.method==="PATCH"&&m){
    const id=decodeURIComponent(m[1]),ch=catalog.chapters.find(c=>c.id===id);
    if(!ch)return send(res,404,{error:"Chapter not found"});
    let b;try{b=await bodyOf(req)}catch(e){return send(res,400,{error:e.message})}
    if(!VALID.has(b.status))return send(res,400,{error:"status must be one of: "+[...VALID].join(", ")});
    const st=readJSON(STATUS_FILE,{});st[id]=b.status;writeJSON(STATUS_FILE,st);
    return send(res,200,{chapter:view(ch,st),updated:true});
  }
  if(req.method==="GET"&&p==="/api/pyq"){
    const q=url.searchParams;let l=pyq.questions;
    for(const [k,f] of [["subject","subject"],["chapterId","chapterId"],["difficulty","difficulty"],["exam","exam"]]){const v=q.get(k);if(v)l=l.filter(x=>String(x[f]).toLowerCase()===v.toLowerCase())}
    const tag=q.get("tag");if(tag)l=l.filter(x=>x.tags.some(t=>t.toLowerCase()===tag.toLowerCase()));
    const s=q.get("q");if(s)l=l.filter(x=>(x.q+" "+x.tags.join(" ")).toLowerCase().includes(s.toLowerCase()));
    return send(res,200,{notice:pyq.notice,total:l.length,questions:l});
  }
  if(req.method==="POST"&&p==="/api/v1/practice/log-attempt"){
    let b;try{b=await bodyOf(req)}catch(e){return send(res,400,{error:e.message})}
    const qn=pyq.questions.find(x=>x.id===b.question_id);
    const err=[];
    if(typeof b.user_id!=="string"||!b.user_id||b.user_id.length>64)err.push("user_id");
    if(!qn)err.push("question_id");
    if(typeof b.is_correct!=="boolean")err.push("is_correct");
    if(!Number.isInteger(b.time_taken_seconds)||b.time_taken_seconds<0||b.time_taken_seconds>7200)err.push("time_taken_seconds");
    if(!["LOW","MEDIUM","HIGH"].includes(b.confidence_rating))err.push("confidence_rating");
    if(err.length)return send(res,400,{error:"Invalid fields: "+err.join(", ")});
    const all=readJSON(ATTEMPTS_FILE,[]);
    all.push({user_id:b.user_id,question_id:b.question_id,chapter_id:qn.chapterId,selected_option:String(b.selected_option||"").slice(0,2),is_correct:b.is_correct,time_taken_seconds:b.time_taken_seconds,confidence_rating:b.confidence_rating,error_category:b.error_category?String(b.error_category).slice(0,40):null,ts:new Date().toISOString()});
    writeJSON(ATTEMPTS_FILE,all.slice(-20000));
    return send(res,201,{logged:true,chapter_id:qn.chapterId,analytics:accuracyFor(all.filter(a=>a.user_id===b.user_id),qn.chapterId)});
  }
  if(req.method==="POST"&&p==="/graphql"){
    let b;try{b=await bodyOf(req)}catch(e){return send(res,400,{errors:[{message:e.message}]})}
    const query=String(b.query||""),v=b.variables||{},st=readJSON(STATUS_FILE,{});
    if(/\bupdateChapterStatus\b/.test(query)){
      const id=v.id??(query.match(/\bid\s*:\s*"([^"]+)"/)||[])[1],status=v.status??(query.match(/\bstatus\s*:\s*"([^"]+)"/)||[])[1];
      const ch=catalog.chapters.find(c=>c.id===id);
      if(!ch)return send(res,200,{errors:[{message:"Chapter not found"}]});
      if(!VALID.has(status))return send(res,200,{errors:[{message:"Invalid status"}]});
      st[id]=status;writeJSON(STATUS_FILE,st);return send(res,200,{data:{updateChapterStatus:view(ch,st)}});
    }
    if(/\bchapters\b/.test(query)){
      let l=catalog.chapters;const c=v.class??(query.match(/\bclass\s*:\s*(\d+)/)||[])[1],s=v.subject??(query.match(/\bsubject\s*:\s*"([^"]+)"/)||[])[1];
      if(c)l=l.filter(x=>x.class===Number(c));if(s)l=l.filter(x=>x.subject.toLowerCase()===String(s).toLowerCase());
      return send(res,200,{data:{chapters:l.map(x=>view(x,st))}});
    }
    return send(res,400,{errors:[{message:"Supported: chapters, updateChapterStatus"}]});
  }
  return send(res,404,{error:"Not found"});
}
http.createServer((q,r)=>handle(q,r).catch(()=>send(r,500,{error:"Internal server error"}))).listen(PORT,()=>console.log(`monostudy on http://localhost:${PORT}`));
