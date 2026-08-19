// 可插拔 LLM 客户端，支持多 provider 全局配置 + 环境变量 fallback。
// 全局配置：~/.config/vibe-task-panel/providers.json
// {
//   "active": "deepseek",
//   "providers": [
//     { "name": "deepseek", "baseURL": "https://api.deepseek.com", "apiKey": "sk-xxx", "model": "deepseek-chat" }
//   ]
// }
// 兼容环境变量：VTP_LLM / OPENAI_API_KEY|BASE_URL|MODEL / DEEPSEEK_API_KEY / OLLAMA_HOST|MODEL

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function providersPath() {
  return path.join(os.homedir(), '.config', 'vibe-task-panel', 'providers.json');
}

export function loadEnvFile(root) {
  const home = os.homedir();
  const candidates = [
    path.join(root, '.vibe-task-panel', '.env'),
    path.join(root, '.env'),
    path.join(home, '.config', 'vibe-task-panel', '.env'),
    path.join(home, '.vibe-task-panel.env')
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch (e) { continue; }
    const lines = text.split(String.fromCharCode(10));
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}

export function loadProviders() {
  try {
    const d = JSON.parse(readFileSync(providersPath(), 'utf8'));
    return { active: d.active || '', providers: Array.isArray(d.providers) ? d.providers : [] };
  } catch (e) {
    return { active: '', providers: [] };
  }
}

export function saveProviders(cfg) {
  const p = providersPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

export function activeProvider() {
  const cfg = loadProviders();
  return (cfg.providers || []).find(function (p) { return p.name === cfg.active; }) || null;
}

export function addProvider(provider) {
  const cfg = loadProviders();
  if (!provider || !provider.name) throw new Error('需要 name');
  const list = cfg.providers || [];
  if (list.some(function (p) { return p.name === provider.name; })) throw new Error('已存在同名 provider: ' + provider.name);
  list.push({ name: provider.name, baseURL: provider.baseURL || '', apiKey: provider.apiKey || '', model: provider.model || '' });
  if (!cfg.active) cfg.active = provider.name;
  cfg.providers = list;
  saveProviders(cfg);
  return cfg;
}

export function updateProvider(name, patch) {
  const cfg = loadProviders();
  const list = cfg.providers || [];
  const idx = list.findIndex(function (p) { return p.name === name; });
  if (idx === -1) throw new Error('provider 不存在: ' + name);
  list[idx] = Object.assign({}, list[idx], patch);
  cfg.providers = list;
  saveProviders(cfg);
  return cfg;
}

export function deleteProvider(name) {
  const cfg = loadProviders();
  cfg.providers = (cfg.providers || []).filter(function (p) { return p.name !== name; });
  if (cfg.active === name) cfg.active = ((cfg.providers[0] || {}).name) || '';
  saveProviders(cfg);
  return cfg;
}

export function activateProvider(name) {
  const cfg = loadProviders();
  if (!(cfg.providers || []).some(function (p) { return p.name === name; })) throw new Error('provider 不存在: ' + name);
  cfg.active = name;
  saveProviders(cfg);
  return cfg;
}

function withTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

export function llmConfig() {
  return {
    mode: process.env.VTP_LLM || 'auto',
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:e4b-mlx',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBase: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    deepseekKey: process.env.DEEPSEEK_API_KEY || '',
    deepseekBase: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  };
}

export async function callOllama(prompt, cfg) {
  const res = await withTimeout(cfg.ollamaHost + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.ollamaModel, prompt: prompt, stream: false })
  }, 180000);
  if (!res.ok) throw new Error('ollama 调用失败: HTTP ' + res.status);
  const data = await res.json();
  return data.response || '';
}

// OpenAI 兼容调用（deepseek / 创世纪 / 中转站通用），systemPrompt 可自定义角色
export async function callOpenAI(prompt, cfg, systemPrompt) {
  if (!cfg.openaiKey) throw new Error('缺少 API Key');
  const sys = systemPrompt || '你是资深技术负责人，擅长把需求拆解为可执行的最小任务。';
  const url = cfg.openaiBase + '/chat/completions';
  let res;
  try {
    res = await withTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.openaiKey },
      body: JSON.stringify({
        model: cfg.openaiModel,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 8192
      })
    }, 60000);
  } catch (e) {
    const hint = (e && e.name === 'AbortError') ? '请求超时（60秒无响应）' : ('网络错误: ' + String((e && e.message) || e));
    throw new Error('provider[' + cfg.openaiBase + '] ' + hint + ' —— 请检查该 provider 的网络可达性或切换其它 provider');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    const hint = res.status === 401 ? 'API Key 无效' : ('HTTP ' + res.status);
    throw new Error('provider[' + cfg.openaiBase + '] ' + hint + (detail ? ' ' + detail.slice(0, 150) : ''));
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return msg ? msg.content : '';
}

export async function callLLM(prompt, systemPrompt) {
  // 1) 按顺序尝试所有 provider（active 优先，失败自动换下一个，不中断）
  const pcfg = loadProviders();
  const list = (pcfg.providers || []).slice().sort(function (a, b) {
    const ao = a.name === pcfg.active ? 0 : 1;
    const bo = b.name === pcfg.active ? 0 : 1;
    return ao - bo;
  });
  let lastErr = null;
  for (const pr of list) {
    if (!pr.apiKey || !pr.baseURL) continue;
    try {
      return await callOpenAI(prompt, {
        openaiKey: pr.apiKey,
        openaiBase: pr.baseURL,
        openaiModel: pr.model || 'deepseek-chat'
      }, systemPrompt);
    } catch (e) {
      lastErr = e;
    }
  }
  // 2) fallback 环境变量
  const cfg = llmConfig();
  const sysP = systemPrompt;
  if (cfg.mode === 'ollama') return await callOllama(prompt, cfg);
  if (cfg.mode === 'openai') return await callOpenAI(prompt, cfg, sysP);
  if (cfg.mode === 'deepseek') {
    return await callOpenAI(prompt, {
      openaiKey: cfg.deepseekKey,
      openaiBase: cfg.deepseekBase,
      openaiModel: cfg.deepseekModel
    }, sysP);
  }
  const attempts = [];
  if (cfg.deepseekKey) attempts.push(function () {
    return callOpenAI(prompt, { openaiKey: cfg.deepseekKey, openaiBase: cfg.deepseekBase, openaiModel: cfg.deepseekModel }, sysP);
  });
  if (cfg.openaiKey) attempts.push(function () { return callOpenAI(prompt, cfg, sysP); });
  attempts.push(function () { return callOllama(prompt, cfg); });
  let lastErr2 = null;
  for (const fn of attempts) {
    try { return await fn(); } catch (e) { lastErr2 = e; }
  }
  const msg1 = lastErr ? lastErr.message : '';
  const msg2 = lastErr2 ? lastErr2.message : '';
  throw new Error('所有 LLM 均失败: ' + (msg1 || msg2));
}
