// FF 서버 관리 - Cloudflare Worker (KV 필요)
// 플러그인이 10초마다 /plugin/sync 로 접속해 설정/편집 요청을 받아가고 플레이어 스탯을 올려줍니다.
const SCHEMA = {
  'reward-rate': [0, 10, '몹 처치 골드 배율 (체력 × 값)'],
  'streak-timeout-seconds': [1, 300, '연속 처치 유지 시간(초)'],
  'streak-bonus-percent': [0, 100, '연속 킬당 추가 보너스(%)'],
  'streak-bonus-max-percent': [0, 1000, '연속 보너스 상한(%)'],
  'death-loss-percent': [0, 100, '사망 시 골드 손실(%)'],
  'boss-spawn-chance-per-minute': [0, 1, '보스 출현 확률 (1분당, 0~1)'],
  'boss-multiplier': [0, 100, '보스 보상 배율'],
  'boss-top-bonus': [0, 10, 'MVP 추가 골드 비율'],
  'boss-max-players': [1, 100, '보스장 최대 인원'],
  'boss-reenter-cooldown-seconds': [0, 3600, '보스장 재입장 쿨타임(초)'],
};
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sign(env, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode('ff:' + env.ADMIN_PASSWORD + env.SERVER_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store', ...h } });
async function authed(req, env) {
  const m = (req.headers.get('cookie') || '').match(/sess=(\d+)\.([0-9a-f]+)/);
  return !!m && +m[1] > Date.now() && (await sign(env, m[1])) === m[2];
}
const kget = async (env, k, d) => JSON.parse((await env.KV.get(k)) || 'null') ?? d;
const kput = (env, k, v) => env.KV.put(k, JSON.stringify(v));
const int = v => Number.isInteger(v) && v >= 0 && v <= 2147483647;

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    const body = async () => req.json().catch(() => ({}));

    if (p === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' } });

    // ---- 플러그인 연동 (서버 키 인증) ----
    if (p === '/plugin/sync' && req.method === 'POST') {
      if (req.headers.get('x-server-key') !== env.SERVER_KEY) return J({ error: 'forbidden' }, 403);
      const b = await body();
      if (Array.isArray(b.players)) await kput(env, 'players', { at: Date.now(), list: b.players.slice(0, 2000) });
      const c = await kget(env, 'cfg', { ver: 0, config: {} });
      const ops = await kget(env, 'ops', []);
      if (ops.length) await kput(env, 'ops', []);
      return J({ ver: c.ver, config: +b.ver < c.ver ? c.config : null, ops });
    }

    // ---- 로그인 (5회 실패 시 15분 잠금) ----
    if (p === '/api/login' && req.method === 'POST') {
      const fk = 'fail:' + (req.headers.get('cf-connecting-ip') || 'x');
      const n = +((await env.KV.get(fk)) || 0);
      if (n >= 5) return J({ error: '시도 횟수 초과. 15분 후 다시 시도하세요.' }, 429);
      const b = await body();
      if (String(b.password) !== String(env.ADMIN_PASSWORD)) {
        await env.KV.put(fk, String(n + 1), { expirationTtl: 900 });
        return J({ error: '비밀번호가 틀렸습니다.' }, 401);
      }
      await env.KV.delete(fk);
      const exp = Date.now() + 43200000;
      return J({ ok: 1 }, 200, { 'set-cookie': 'sess=' + exp + '.' + (await sign(env, String(exp))) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200' });
    }

    // ---- 관리자 API ----
    if (p.startsWith('/api/')) {
      if (!(await authed(req, env))) return J({ error: '로그인이 필요합니다.' }, 401);
      if (p === '/api/state') {
        const c = await kget(env, 'cfg', { ver: 0, config: {} });
        const pl = await kget(env, 'players', { at: 0, list: [] });
        return J({ schema: SCHEMA, config: c.config, ver: c.ver, players: pl.list, seen: pl.at, pending: (await kget(env, 'ops', [])).length, now: Date.now() });
      }
      if (p === '/api/config' && req.method === 'POST') {
        const b = (await body()).config || {};
        for (const [k, v] of Object.entries(b)) {
          const s = SCHEMA[k];
          if (!s || typeof v !== 'number' || !isFinite(v) || v < s[0] || v > s[1]) return J({ error: '잘못된 값: ' + k + ' (' + (s ? s[0] + '~' + s[1] : '허용되지 않는 항목') + ')' }, 400);
        }
        const c = await kget(env, 'cfg', { ver: 0, config: {} });
        await kput(env, 'cfg', { ver: c.ver + 1, config: { ...c.config, ...b } });
        return J({ ok: 1 });
      }
      if (p === '/api/player' && req.method === 'POST') {
        const b = await body();
        if (!/^[0-9a-f-]{36}$/.test(b.uuid || '')) return J({ error: 'UUID 오류' }, 400);
        const op = { uuid: b.uuid };
        if (b.gold !== undefined) { if (!int(b.gold)) return J({ error: '골드는 0 이상의 정수' }, 400); op.gold = b.gold; }
        if (b.kills !== undefined) { if (!int(b.kills)) return J({ error: '보스 킬은 0 이상의 정수' }, 400); op.kills = b.kills; }
        const ops = await kget(env, 'ops', []);
        ops.push(op);
        await kput(env, 'ops', ops.slice(-500));
        return J({ ok: 1 });
      }
    }
    return J({ error: 'not found' }, 404);
  },
};

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FF 서버 관리</title>
<style>
:root{--bg:#e6eaed;--panel:#f7f9fa;--ink:#1c2228;--mute:#5d6b76;--line:#c5cdd3;--acc:#0e7c8a;--bad:#b3412e;--ok:#2f8f4e}
@media(prefers-color-scheme:dark){:root{--bg:#161b1f;--panel:#1f262b;--ink:#e4eaee;--mute:#93a1ac;--line:#33404a;--acc:#4cc3d2;--bad:#e8806c;--ok:#5fcf86}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif}
[hidden]{display:none!important}main{max-width:880px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:0 0 12px}
.bar{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.st{color:var(--mute);font-size:13px}.st b{color:var(--ink)}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:16px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px 16px}
label{display:block;font-size:13px;color:var(--mute)}
input{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:7px 9px}
input:focus,button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
button{font:inherit;font-weight:600;background:var(--acc);color:#fff;border:0;border-radius:4px;padding:8px 16px;cursor:pointer}
@media(prefers-color-scheme:dark){button{color:#08262b}}
button.s{padding:5px 12px;font-size:13px}.row{display:flex;gap:10px;align-items:center;margin-top:14px}
.msg{font-size:13px}.msg.e{color:var(--bad)}.msg.o{color:var(--ok)}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:560px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}th{font-size:13px;color:var(--mute);font-weight:500}
td input{width:110px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--line);margin-right:7px}.dot.on{background:var(--ok)}
#login{max-width:320px;margin:18vh auto 0;padding:0 16px}#login input{margin:14px 0 10px;font-size:20px;letter-spacing:6px;text-align:center}#login button{width:100%}
</style></head><body>
<div id="login" hidden><h1>FF 서버 관리</h1><input id="pw" type="password" inputmode="numeric" autocomplete="current-password" placeholder="비밀번호"><button id="go">입장</button><div class="msg e" id="le"></div></div>
<main id="panel" hidden>
<div class="bar"><h1>FF 서버 관리</h1><div class="st" id="st"></div></div>
<section><h2>서버 설정</h2><div class="grid" id="cfg"></div>
<div class="row"><button id="sc">설정 저장</button><span class="msg" id="cm"></span></div></section>
<section><h2>플레이어</h2><div class="tw"><table><thead><tr><th>플레이어</th><th>골드</th><th>보스 킬</th><th></th></tr></thead><tbody id="pl"></tbody></table></div><div class="msg" id="pm"></div></section>
</main>
<script>
var $=function(s){return document.querySelector(s)},S=null;
function api(u,b){return fetch(u,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{}).then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(r.status===401&&u!=='/api/login'){view(0)}if(!r.ok)throw new Error(d.error||'오류');return d})})}
function view(on){$('#login').hidden=!!on;$('#panel').hidden=!on;if(!on)$('#pw').focus()}
function note(el,t,ok){el.textContent=t;el.className='msg '+(ok?'o':'e')}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
$('#go').onclick=function(){api('/api/login',{password:$('#pw').value}).then(function(){S=null;load()}).catch(function(e){$('#le').textContent=e.message})};
$('#pw').onkeydown=function(e){if(e.key==='Enter')$('#go').click()};
function load(){api('/api/state').then(function(d){view(1);draw(d)}).catch(function(){})}
function draw(d){
 var ago=Math.round((d.now-d.seen)/1000),live=d.seen&&ago<60;
 $('#st').innerHTML=(live?'<b>서버 연결됨</b> · '+ago+'초 전 동기화':'<b>서버 연결 없음</b>')+(d.pending?' · 반영 대기 '+d.pending+'건':'');
 if(!S){S=1;var h='';Object.keys(d.schema).forEach(function(k){var s=d.schema[k],v=d.config[k];h+='<div><label for="c_'+k+'">'+s[2]+'</label><input id="c_'+k+'" data-k="'+k+'" type="number" step="any" min="'+s[0]+'" max="'+s[1]+'" placeholder="서버 기본값 사용"'+(v!==undefined?' value="'+v+'"':'')+'></div>'});$('#cfg').innerHTML=h}
 if(!$('#pl').contains(document.activeElement)){
  var r='';d.players.sort(function(a,b){return b.online-a.online||b.gold-a.gold}).forEach(function(p){
   r+='<tr data-u="'+p.uuid+'"><td><span class="dot'+(p.online?' on':'')+'"></span>'+esc(p.name)+'</td><td><input type="number" min="0" step="1" value="'+p.gold+'" class="g"></td><td><input type="number" min="0" step="1" value="'+p.kills+'" class="k"></td><td><button class="s">저장</button></td></tr>'});
  $('#pl').innerHTML=r||'<tr><td colspan="4" class="st">서버가 연결되면 플레이어가 표시됩니다.</td></tr>'}
}
$('#sc').onclick=function(){var c={},bad=0;document.querySelectorAll('#cfg input').forEach(function(i){if(i.value!=='')c[i.dataset.k]=Number(i.value)});
 api('/api/config',{config:c}).then(function(){note($('#cm'),'저장했습니다. 서버에 곧 반영됩니다.',1)}).catch(function(e){note($('#cm'),e.message)})};
$('#pl').onclick=function(e){if(e.target.tagName!=='BUTTON')return;var tr=e.target.closest('tr');
 api('/api/player',{uuid:tr.dataset.u,gold:Number(tr.querySelector('.g').value),kills:Number(tr.querySelector('.k').value)}).then(function(){note($('#pm'),'저장 요청을 보냈습니다. 서버에 곧 반영됩니다.',1);load()}).catch(function(x){note($('#pm'),x.message)})};
load();setInterval(function(){if(!$('#panel').hidden)load()},5000);
</script></body></html>`;
