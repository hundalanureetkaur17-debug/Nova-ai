import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const need = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY'];
const missing = need.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing in .env: ' + missing.join(', ')); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYS = 'You are NOVA AI, a helpful, concise, friendly assistant for productivity, writing, learning and planning.';
const app = express();
app.use(express.json({ limit: '100kb' }));

app.get('/api/config', (_, res) => res.json({ url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY }));

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = data.user; next();
}
async function allowed(u) {
  const { data: p } = await sb.from('profiles').select('plan,lang').eq('id', u.id).single();
  const limit = p?.plan === 'pro' ? 200 : 20;
  const day = new Date().toISOString().slice(0, 10);
  const { data: r } = await sb.from('usage').select('count').eq('user_id', u.id).eq('day', day).maybeSingle();
  const n = r?.count || 0;
  if (n >= limit) return { ok: false, limit };
  await sb.from('usage').upsert({ user_id: u.id, day, count: n + 1 });
  return { ok: true, lang: p?.lang || 'English' };
}
const aiError = e => { console.error(e?.message); return 'The AI is unavailable right now. Please try again shortly.'; };

app.post('/api/chat', auth, async (req, res) => {
  const { conversationId, message } = req.body || {};
  if (!conversationId || !message?.trim()) return res.status(400).json({ error: 'Please type a message.' });
  const { data: conv } = await sb.from('conversations').select('id').eq('id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const gate = await allowed(req.user);
  if (!gate.ok) return res.status(429).json({ error: `Daily AI limit reached (${gate.limit}). Try again tomorrow or upgrade.` });
  try {
    const { data: hist } = await sb.from('messages').select('role,content').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(20);
    const msgs = [{ role: 'system', content: SYS + ` Reply in ${gate.lang} unless asked otherwise.` }, ...(hist || []).reverse(), { role: 'user', content: message }];
    const out = await ai.chat.completions.create({ model: MODEL, messages: msgs });
    const reply = out.choices[0].message.content;
    await sb.from('messages').insert([{ user_id: req.user.id, conversation_id: conv.id, role: 'user', content: message }, { user_id: req.user.id, conversation_id: conv.id, role: 'assistant', content: reply }]);
    await sb.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);
    res.json({ reply });
  } catch (e) { res.status(502).json({ error: aiError(e) }); }
});

app.post('/api/generate', auth, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt?.trim()) return res.status(400).json({ error: 'Please enter a prompt.' });
  const gate = await allowed(req.user);
  if (!gate.ok) return res.status(429).json({ error: `Daily AI limit reached (${gate.limit}).` });
  try {
    const out = await ai.chat.completions.create({ model: MODEL, messages: [{ role: 'system', content: SYS + ` Reply in ${gate.lang}.` }, { role: 'user', content: prompt }] });
    res.json({ text: out.choices[0].message.content });
  } catch (e) { res.status(502).json({ error: aiError(e) }); }
});

app.delete('/api/account', auth, async (req, res) => {
  const { error } = await sb.auth.admin.deleteUser(req.user.id);
  if (error) return res.status(500).json({ error: 'Could not delete the account. Please try again.' });
  res.json({ ok: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
app.get('/', (_, res) => res.sendFile(path.join(here, 'index.html')));
app.listen(process.env.PORT || 3000, () => console.log('NOVA AI running on port ' + (process.env.PORT || 3000)));
