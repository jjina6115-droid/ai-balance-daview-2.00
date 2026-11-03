/*
 * 밸런스 AI — 서버 동작 (Netlify 엣지 함수용)
 * - OpenAI API 키는 선생님이 웹사이트의 '선생님 설정'에서 넣어요. 키는 서버 저장소(Netlify Blobs)에만 있고 브라우저로 보내지 않아요.
 *   (Netlify 환경변수 OPENAI_API_KEY에 넣어도 돼요. 웹사이트에서 넣은 키가 먼저 쓰여요.)
 * - 입장 비밀번호를 아는 사람만 AI 훈련소와 AI 광장을 쓸 수 있어요. 선생님 비밀번호로는 키와 비밀번호를 바꿀 수 있어요.
 *   비밀번호는 그대로 저장하지 않고, 풀 수 없게 바꾼 값(해시)만 저장해요.
 * - 모둠 AI는 저장소(store)에 모두 모여서, 모든 학생이 같은 광장을 봐요.
 * - 평가는 학생이 직접 기록(0/1)해요. 서버는 "그 규칙으로 그 질문을 정말 물어봤는지"만 서명한 표(token)로 확인해요.
 * - AI가 고칠 점을 알려 주지 않아요. 학생이 데이터를 보고 스스로 고쳐요.
 */
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text)))); }
function randomHex(bytes) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);

const COMMENT_MAX = 300;

export function createApi({ S, store, settings: settingsStore, comments: commentStore, env: readEnv }) {
  const env = (k, d) => { const v = readEnv(k); return v !== undefined && v !== null && v !== '' ? v : d; };
  const model = () => env('OPENAI_MODEL', 'gpt-5.6-luna');
  const openaiUrl = () => env('SITE_KEY_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
  const minScore = () => Math.max(0, Math.min(100, parseInt(env('PUBLISH_MIN_SCORE', '0'), 10) || 0));
  const minTests = () => Math.max(1, parseInt(env('PUBLISH_MIN_TESTS', String(S.LIMITS.minTests)), 10) || S.LIMITS.minTests);
  // 한 반 학생들은 학교 인터넷 주소(IP)가 같아서, 기본값을 넉넉하게 잡아요.
  const rateLimit = () => Math.max(1, parseInt(env('RATE_LIMIT_PER_MIN', '600'), 10) || 600);

  // ---------- 사이트 설정 (선생님이 웹사이트에서 넣은 키·비밀번호) ----------
  let cfgCache = null, cfgAt = 0;
  async function cfg(fresh) {
    if (!settingsStore) return {};
    if (!fresh && cfgCache && Date.now() - cfgAt < 10000) return cfgCache;
    cfgCache = (await settingsStore.get()) || {};
    cfgAt = Date.now();
    return cfgCache;
  }
  async function saveCfg(next) {
    if (!settingsStore) throw httpError(500, '설정을 저장할 곳이 없어요.');
    next.updatedAt = new Date().toISOString();
    await settingsStore.put(next);
    cfgCache = next; cfgAt = Date.now();
  }
  const secret = async () => env('TOKEN_SECRET', '') || (await cfg()).secret || 'balance-ai:' + env('OPENAI_API_KEY', 'no-key');

  // 비밀번호는 PBKDF2로 바꾼 값만 저장해요
  const pwMemo = new Map();
  async function pwHash(pw, salt) {
    const memoKey = await sha(salt + '\u0000' + pw);
    if (pwMemo.has(memoKey)) return pwMemo.get(memoKey);
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const h = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 20000 }, key, 256));
    if (pwMemo.size > 500) pwMemo.clear();
    pwMemo.set(memoKey, h);
    return h;
  }
  async function makePw(pw) { const salt = randomHex(16); return { salt, hash: await pwHash(pw, salt) }; }
  async function checkPw(pw, rec) { return !!(pw && rec && rec.hash) && (await pwHash(pw, rec.salt)) === rec.hash; }
  function needPw(v, label) {
    const p = String(v == null ? '' : v).trim();
    if (p.length < 4) throw httpError(400, label + '는 4글자 이상으로 정해 주세요.');
    if (p.length > 64) throw httpError(400, label + '가 너무 길어요. 64글자까지 쓸 수 있어요.');
    return p;
  }

  // 웹사이트에서 넣은 키가 먼저, 없으면 Netlify 환경변수의 키
  async function keyInfo() {
    const c = await cfg();
    if (c.openaiKey) return { key: c.openaiKey, base: openaiUrl(), from: 'site' };
    const k = env('OPENAI_API_KEY', '');
    if (k) return { key: k, base: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''), from: 'netlify' };
    return { key: '', base: '', from: null };
  }
  async function testKey(raw) {
    const key = String(raw || '').trim();
    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) throw httpError(400, 'OpenAI API 키는 sk-로 시작하는 긴 글자예요. 빈칸 없이 그대로 붙여 넣어 주세요.');
    try {
      const r = await fetch(openaiUrl() + '/models', { headers: { Authorization: 'Bearer ' + key } });
      if (r.status === 401) throw httpError(400, 'OpenAI가 이 키를 받아 주지 않았어요. 키를 다시 복사해서 넣어 주세요.');
    } catch (e) { if (e.expose) throw e; /* 잠깐 연결이 안 되는 것은 넘어가요 */ }
    return key;
  }

  // ---------- 접근 제어 ----------
  const buckets = new Map(), fails = new Map();
  function rate(ip) {
    const now = Date.now();
    const key = ip || 'unknown';
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + 60000 }; buckets.set(key, b); }
    b.count += 1;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    if (b.count > rateLimit()) throw httpError(429, '요청이 너무 많아요. 1분 뒤에 다시 해 주세요.');
    const f = fails.get(key);
    if (f && now < f.reset && f.count >= 60) throw httpError(429, '비밀번호를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.');
  }
  function failed(ip) {
    const now = Date.now(), key = ip || 'unknown';
    let f = fails.get(key);
    if (!f || now > f.reset) { f = { count: 0, reset: now + 600000 }; fails.set(key, f); }
    f.count += 1;
    if (fails.size > 5000) for (const [k, v] of fails) if (now > v.reset) fails.delete(k);
  }
  async function adminSet() { return !!((await cfg()).admin || env('TEACHER_CODE', '')); }
  async function accessSet() { return !!((await cfg()).access || env('ACCESS_CODE', '')); }
  async function isTeacher(headers) {
    const code = String(headers['x-teacher-code'] || '').trim();
    if (!code) return false;
    const t = env('TEACHER_CODE', '');
    if (t && code === t) return true;
    return checkPw(code, (await cfg()).admin);
  }
  async function hasAccess(headers) {
    if (!(await accessSet())) return true;
    const code = String(headers['x-access-code'] || '').trim();
    if (code) {
      const envCode = env('ACCESS_CODE', '');
      if (envCode && code === envCode) return true;
      if (await checkPw(code, (await cfg()).access)) return true;
    }
    return isTeacher(headers);
  }
  async function guard(headers, ip, method) {
    // 읽기(GET)는 실시간 새로고침 때문에 자주 오므로 횟수 제한에서 빼요. OpenAI를 부르는 요청과 쓰기만 세요.
    if (method !== 'GET') rate(ip);
    else { const f = fails.get(ip || 'unknown'); if (f && Date.now() < f.reset && f.count >= 60) throw httpError(429, '비밀번호를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.'); }
    if (!(await hasAccess(headers))) {
      if (headers['x-access-code'] || headers['x-teacher-code']) failed(ip);
      const e = httpError(401, '입장 비밀번호가 맞지 않아요. 선생님께 받은 비밀번호를 넣어 주세요.');
      e.code = 'locked';
      throw e;
    }
  }

  async function health() {
    const k = await keyInfo(), admin = await adminSet();
    return {
      ok: true, engine: 'openai', model: model(), keySet: !!k.key, keyFrom: k.from,
      needsSetup: !admin, accessCode: await accessSet(), teacher: admin,
      minScore: minScore(), minTests: minTests()
    };
  }

  // ---------- OpenAI ----------
  async function complete(messages, json) {
    const k = await keyInfo();
    if (!k.key) throw httpError(500, 'OpenAI API 키가 아직 없어요. 선생님이 오른쪽 위 연결 상태 버튼 → 선생님 설정에서 키를 넣어 주세요.');
    const body = { model: model(), messages };
    if (json) body.response_format = { type: 'json_object' };
    let r;
    try {
      r = await fetch(k.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k.key },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw httpError(504, 'OpenAI에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || 'HTTP ' + r.status;
      console.error('[openai]', r.status, msg);
      if (r.status === 401) throw httpError(502, 'OpenAI API 키가 올바르지 않아요. 선생님 설정에서 키를 다시 넣어 주세요.');
      if (r.status === 429) throw httpError(503, 'OpenAI 사용 한도에 걸렸어요. 잠시 뒤 다시 시도하거나 결제 한도를 확인해 주세요.');
      if (r.status === 404) throw httpError(502, '모델 "' + model() + '"을(를) 쓸 수 없어요. OPENAI_MODEL 환경변수를 확인해 주세요.');
      throw httpError(502, 'OpenAI 오류: ' + msg);
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw httpError(502, 'AI가 빈 답을 보냈어요. 다시 시도해 주세요.');
    return text;
  }

  function botMessages(compiled, history, question) {
    const msgs = [{ role: 'system', content: S.PLATFORM_RULES }, { role: 'system', content: '[모둠이 쓴 규칙]\n' + compiled }];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') msgs.push({ role: h.role, content: clean(h.content, 3000) });
      }
    }
    msgs.push({ role: 'user', content: question });
    return msgs;
  }
  function needRules(body) {
    const rules = clean(body.prompt, S.LIMITS.prompt);
    const flow = S.cleanFlow(body.flow);
    const compiled = S.compileRules(rules, flow);
    if (compiled.length < S.LIMITS.minPrompt) throw httpError(400, '규칙이나 순서도를 ' + S.LIMITS.minPrompt + '자 이상 써 주세요.');
    return { rules, flow, compiled };
  }
  function needMessage(v) {
    const m = clean(v, S.LIMITS.message);
    if (!m) throw httpError(400, '보낼 말을 적어 주세요.');
    return m;
  }

  // ---------- 평가 표(token): 이 규칙으로 이 질문을 서버에서 실제로 물어봤다는 표시 ----------
  async function makeToken(compiled, question) {
    const payload = (await sha(compiled)).slice(0, 32) + '.' + (await sha(question)).slice(0, 32);
    return payload + '.' + (await hmac(await secret(), payload)).slice(0, 40);
  }
  async function readEvaluation(compiled, evaluation) {
    const want = (await sha(compiled)).slice(0, 32);
    const sec = await secret();
    const byQuestion = {};
    for (const e of Array.isArray(evaluation) ? evaluation.slice(0, 40) : []) {
      if (!e || !S.isLabeled(e.labels)) continue;
      const parts = String(e.token || '').split('.');
      if (parts.length !== 3 || parts[0] !== want) continue;
      if (parts[1] !== (await sha(clean(e.question, S.LIMITS.message))).slice(0, 32)) continue;
      if ((await hmac(sec, parts[0] + '.' + parts[1])).slice(0, 40) !== parts[2]) continue;
      byQuestion[parts[1]] = { labels: e.labels.map(Number) };
    }
    return S.labelStats(Object.keys(byQuestion).map((k) => byQuestion[k]));
  }

  async function botFields(body) {
    const name = clean(body.name, S.LIMITS.name);
    const author = clean(body.author, S.LIMITS.author);
    if (!name) throw httpError(400, 'AI 이름을 적어 주세요.');
    if (!author) throw httpError(400, '만든 모둠을 적어 주세요.');
    const { rules, flow, compiled } = needRules(body);
    const st = await readEvaluation(compiled, body.evaluation);
    if (st.count < minTests()) throw httpError(400, '지금 규칙과 순서도로 편향된 질문 ' + minTests() + '개를 물어보고 0/1 기록을 모두 마쳐야 올릴 수 있어요. (확인된 기록 ' + st.count + '개)');
    if (st.score < minScore()) throw httpError(400, '기준 충족률이 ' + minScore() + '% 이상이어야 광장에 올릴 수 있어요. 지금은 ' + st.score + '%예요.');
    return {
      name, author, prompt: rules, flow, score: st.score, tests: st.count, rates: st.rates,
      description: clean(body.description, S.LIMITS.description),
      emoji: S.EMOJIS.indexOf(body.emoji) >= 0 ? body.emoji : S.EMOJIS[0]
    };
  }
  const publicView = (b, counts) => ({
    id: b.id, name: b.name, emoji: b.emoji, author: b.author, description: b.description,
    prompt: b.prompt, flow: b.flow || [], score: b.score, tests: b.tests || 0,
    likes: b.likes || 0, dislikes: b.dislikes || 0, chats: b.chats || 0, createdAt: b.createdAt, updatedAt: b.updatedAt,
    comments: counts ? counts.comments : 0, improves: counts ? counts.improves : 0
  });

  // ---------- 댓글 ----------
  // 댓글은 하나씩 따로 저장해요 (키: AI아이디/댓글아이디). 댓글아이디 끝의 -i는 '개선' 댓글이라는 표시예요.
  // 그래서 여러 학생이 동시에 달아도 서로 덮어쓰지 않고, 개수는 키 목록만 보고 셀 수 있어요.
  async function commentCounts(prefix) {
    const counts = {};
    if (!commentStore) return counts;
    for (const key of await commentStore.keys(prefix || '')) {
      const [botId, cid] = key.split('/');
      if (!botId || !cid) continue;
      const c = counts[botId] || (counts[botId] = { comments: 0, improves: 0 });
      c.comments += 1;
      if (/-i$/.test(cid)) c.improves += 1;
    }
    return counts;
  }
  const publicComment = (c) => ({ id: c.id, author: c.author, text: c.text, improve: !!c.improve, createdAt: c.createdAt });
  async function removeComments(botId) {
    if (!commentStore) return;
    for (const key of await commentStore.keys(botId + '/')) await commentStore.remove(key);
  }

  // ---------- 주소별 처리 ----------
  async function handle(method, pathname, headers, body, ip) {
    if (pathname === '/api/health') return health();

    // 처음 설정: 선생님 비밀번호가 아직 없을 때 한 번만
    if (pathname === '/api/setup' && method === 'POST') {
      rate(ip);
      const c = await cfg(true);
      if (c.admin || env('TEACHER_CODE', '')) throw httpError(409, '이미 처음 설정을 마쳤어요. 선생님 설정에서 바꿀 수 있어요.');
      const adminPw = needPw(body.adminPassword, '선생님 비밀번호');
      const accessPw = needPw(body.accessPassword, '입장 비밀번호');
      if (adminPw === accessPw) throw httpError(400, '선생님 비밀번호와 입장 비밀번호는 서로 다르게 정해 주세요.');
      const next = Object.assign({}, c, { admin: await makePw(adminPw), access: await makePw(accessPw), secret: c.secret || randomHex(32) });
      if (String(body.apiKey || '').trim()) next.openaiKey = await testKey(body.apiKey);
      else if (!(await keyInfo()).key) throw httpError(400, 'OpenAI API 키를 넣어 주세요.');
      await saveCfg(next);
      return health();
    }

    await guard(headers, ip, method);

    // 실시간 새로고침용: 광장의 AI나 댓글이 바뀌었는지만 짧게 알려 줘요 (내용은 안 보냄)
    if (pathname === '/api/stamp' && method === 'GET') {
      const b = store.version ? await store.version() : String(Date.now());
      const c = commentStore ? (await commentStore.keys('')).sort().join('|') : '';
      return { bots: (await sha(b)).slice(0, 16), comments: (await sha(c)).slice(0, 16) };
    }

    // 입장 비밀번호 확인 (guard를 통과했으면 맞는 거예요)
    if (pathname === '/api/enter' && method === 'POST') return { ok: true };

    // 선생님 설정: 키 넣기·바꾸기, 비밀번호 바꾸기 (선생님 비밀번호가 있어야 해요)
    if (pathname === '/api/admin' && method === 'POST') {
      if (!(await isTeacher(headers))) { failed(ip); throw httpError(403, '선생님 비밀번호가 맞지 않아요.'); }
      const c = Object.assign({}, await cfg(true));
      let changed = false;
      if (String(body.apiKey || '').trim()) { c.openaiKey = await testKey(body.apiKey); changed = true; }
      else if (body.removeKey && c.openaiKey) { delete c.openaiKey; changed = true; }
      if (String(body.accessPassword || '').trim()) { c.access = await makePw(needPw(body.accessPassword, '입장 비밀번호')); changed = true; }
      if (String(body.adminPassword || '').trim()) { c.admin = await makePw(needPw(body.adminPassword, '선생님 비밀번호')); changed = true; }
      if (changed) { if (!c.secret) c.secret = randomHex(32); await saveCfg(c); }
      const now = await cfg();
      return Object.assign(await health(), { saved: changed, keyHint: now.openaiKey ? 'sk-…' + now.openaiKey.slice(-4) : null });
    }

    if (pathname === '/api/try' && method === 'POST') {
      const { compiled } = needRules(body);
      return { answer: await complete(botMessages(compiled, body.history, needMessage(body.question))) };
    }

    if (pathname === '/api/exam' && method === 'POST') {
      const { compiled } = needRules(body);
      const question = needMessage(body.question);
      const answer = await complete(botMessages(compiled, [], question));
      return { answer, token: await makeToken(compiled, question) };
    }

    // 선생님 비밀번호 확인 (맞으면 광장에서 '내리기' 버튼이 선생님에게도 보여요)
    if (pathname === '/api/teacher' && method === 'POST') {
      if (!(await isTeacher(headers))) { failed(ip); throw httpError(403, '선생님 비밀번호가 맞지 않아요.'); }
      return { ok: true };
    }

    // 댓글: /api/bots/:id/comments (목록·달기), /api/bots/:id/comments/:cid (지우기)
    const cm = pathname.match(/^\/api\/bots\/([a-f0-9]{6,40})\/comments(?:\/([a-z0-9-]{6,40}))?$/);
    if (cm) {
      if (!commentStore) throw httpError(500, '댓글을 저장할 곳이 없어요.');
      const bot = await store.get(cm[1]);
      if (!bot) throw httpError(404, '이 AI를 찾을 수 없어요. 광장에서 내려갔을 수 있어요.');
      if (!cm[2] && method === 'GET') {
        const list = (await commentStore.getAll(bot.id + '/')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return { comments: list.map(publicComment) };
      }
      if (!cm[2] && method === 'POST') {
        const author = clean(body.author, S.LIMITS.author);
        const text = clean(body.text, COMMENT_MAX);
        if (!author) throw httpError(400, '쓴 사람(이름이나 모둠)을 적어 주세요.');
        if (!text) throw httpError(400, '댓글 내용을 적어 주세요.');
        const improve = body.improve === true;
        const id = Date.now().toString(36) + '-' + randomHex(4) + (improve ? '-i' : '-c');
        const deleteKey = randomHex(12);
        const c = { id, botId: bot.id, author, text, improve, createdAt: new Date().toISOString(), deleteKeyHash: await sha(deleteKey) };
        await commentStore.put(bot.id + '/' + id, c);
        return { comment: publicComment(c), deleteKey };
      }
      if (cm[2] && method === 'DELETE') {
        const key = bot.id + '/' + cm[2];
        const c = await commentStore.get(key);
        if (!c) throw httpError(404, '이 댓글은 이미 지워졌어요.');
        const dk = headers['x-delete-key'];
        const writer = dk && (await sha(dk)) === c.deleteKeyHash;
        if (!writer && !(await isTeacher(headers))) throw httpError(403, '이 댓글을 지울 권한이 없어요. 댓글을 쓴 기기나 선생님만 지울 수 있어요.');
        await commentStore.remove(key);
        return { ok: true };
      }
      throw httpError(405, '지원하지 않는 요청이에요.');
    }

    const m = pathname.match(/^\/api\/bots(?:\/([a-f0-9]{6,40}))?(?:\/(chat|rate))?$/);
    if (!m) throw httpError(404, '없는 주소예요.');
    const id = m[1], action = m[2];

    if (!id) {
      if (method === 'GET') {
        const counts = await commentCounts('');
        return { bots: (await store.list()).map((b) => publicView(b, counts[b.id])) };
      }
      if (method === 'POST') {
        const fields = await botFields(body);
        const editKey = randomHex(16);
        const now = new Date().toISOString();
        const bot = Object.assign({ id: randomHex(5), likes: 0, dislikes: 0, chats: 0, createdAt: now, updatedAt: now, editKeyHash: await sha(editKey) }, fields);
        await store.put(bot);
        return { bot: publicView(bot), editKey };
      }
      throw httpError(405, '지원하지 않는 요청이에요.');
    }

    const bot = await store.get(id);
    if (!bot) throw httpError(404, '이 AI를 찾을 수 없어요. 광장에서 내려갔을 수 있어요.');

    if (!action) {
      if (method === 'GET') return { bot: publicView(bot, (await commentCounts(bot.id + '/'))[bot.id]) };
      if (method === 'PUT') {
        if (!body.editKey || (await sha(body.editKey)) !== bot.editKeyHash) throw httpError(403, '이 AI를 고칠 권한이 없어요. 처음 올린 기기에서만 고칠 수 있어요.');
        Object.assign(bot, await botFields(body), { updatedAt: new Date().toISOString() });
        await store.put(bot);
        return { bot: publicView(bot) };
      }
      if (method === 'DELETE') {
        const key = headers['x-edit-key'];
        const owner = key && (await sha(key)) === bot.editKeyHash;
        if (!owner && !(await isTeacher(headers))) throw httpError(403, '이 AI를 내릴 권한이 없어요.');
        await store.remove(id);
        await removeComments(id);
        return { ok: true };
      }
      throw httpError(405, '지원하지 않는 요청이에요.');
    }

    if (action === 'chat' && method === 'POST') {
      const answer = await complete(botMessages(S.compileRules(bot.prompt, bot.flow), body.history, needMessage(body.message)));
      bot.chats = (bot.chats || 0) + 1;
      await store.put(bot);
      return { answer };
    }
    if (action === 'rate' && method === 'POST') {
      if (body.value === -1) bot.dislikes = (bot.dislikes || 0) + 1; else bot.likes = (bot.likes || 0) + 1;
      await store.put(bot);
      return { likes: bot.likes, dislikes: bot.dislikes };
    }
    throw httpError(405, '지원하지 않는 요청이에요.');
  }

  return { handle, health };
}
