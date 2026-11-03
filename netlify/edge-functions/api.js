/*
 * 밸런스 AI — Netlify 엣지 함수 (/api/* 주소를 처리)
 * 모둠 AI는 Netlify Blobs 저장소 'balance-ai-bots'에,
 * 선생님 설정(OpenAI 키, 비밀번호 해시)은 'balance-ai-settings'에,
 * 광장 댓글은 'balance-ai-comments'에 저장돼요.
 */
import { getStore } from '@netlify/blobs';
import '../../lib/shared.js';
import { createApi } from '../../lib/core.js';

const S = globalThis.FA_SHARED;
const bots = () => getStore({ name: 'balance-ai-bots', consistency: 'strong' });

const store = {
  async list() {
    const s = bots();
    const { blobs } = await s.list();
    const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: 'json' })));
    return items.filter(Boolean);
  },
  async get(id) { return (await bots().get(id, { type: 'json' })) || null; },
  async put(bot) { await bots().setJSON(bot.id, bot); },
  async remove(id) { await bots().delete(id); },
  // 실시간 새로고침용: 저장된 AI들의 이름표(etag)만 모아요. 하나라도 바뀌면 값이 달라져요.
  async version() {
    const { blobs } = await bots().list();
    return blobs.map((b) => b.key + ':' + b.etag).sort().join('|');
  }
};

const settingsBlob = () => getStore({ name: 'balance-ai-settings', consistency: 'strong' });
const settings = {
  async get() { return (await settingsBlob().get('site', { type: 'json' })) || null; },
  async put(value) { await settingsBlob().setJSON('site', value); }
};

const commentBlob = () => getStore({ name: 'balance-ai-comments', consistency: 'strong' });
const comments = {
  async keys(prefix) { const { blobs } = await commentBlob().list(prefix ? { prefix } : undefined); return blobs.map((b) => b.key); },
  async getAll(prefix) {
    const s = commentBlob();
    const { blobs } = await s.list({ prefix });
    return (await Promise.all(blobs.map((b) => s.get(b.key, { type: 'json' })))).filter(Boolean);
  },
  async get(key) { return (await commentBlob().get(key, { type: 'json' })) || null; },
  async put(key, value) { await commentBlob().setJSON(key, value); },
  async remove(key) { await commentBlob().delete(key); }
};

const readEnv = (k) => (typeof Netlify !== 'undefined' && Netlify.env ? Netlify.env.get(k) : undefined);
const api = createApi({ S, store, settings, comments, env: readEnv });

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async (req, context) => {
  const url = new URL(req.url);
  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const text = await req.text();
    if (text.length > 64 * 1024) return json(413, { error: '보낸 내용이 너무 길어요.' });
    try { body = text ? JSON.parse(text) : {}; } catch (e) { return json(400, { error: '요청 형식이 올바르지 않아요.' }); }
  }
  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  try {
    return json(200, await api.handle(req.method, url.pathname, headers, body || {}, (context && context.ip) || ''));
  } catch (e) {
    if (!e.expose) console.error(e);
    return json(e.status || 500, { error: e.expose ? e.message : '서버에서 문제가 생겼어요.', code: e.code || undefined });
  }
};

export const config = { path: '/api/*' };
