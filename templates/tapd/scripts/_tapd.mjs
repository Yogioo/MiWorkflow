// TAPD 工单源专用工具：tapd-cli 调用、OpenAPI 调用、令牌打码。通用的 stdin/stdout、git 在 _lib.mjs。
// 这是模板内容，复制进项目后归项目所有。
import { execFileSync } from 'node:child_process';
import { TAPD_RETRY_DELAYS } from '../source.mjs';

// ── 打码 ──────────────────────────────────────────────────────────────────
// 报错信息里不留令牌：32 位十六进制一律打码，TAPD_TOKEN 的原值也打码。
export function mask(text) {
  let s = String(text ?? '').replace(/\b[0-9a-f]{32}\b/gi, '***');
  const token = process.env.TAPD_TOKEN;
  if (token && token.length >= 4) s = s.split(token).join('***');
  return s;
}

// ── JSON ──────────────────────────────────────────────────────────────────
// 只解析第一段 JSON：`comment add` 会在 JSON 后面多一行 `已写入 /tmp/comment.log`。
export function firstJson(raw, context = 'tapd-cli') {
  const s = String(raw ?? '');
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error(mask(`${context} 没有返回 JSON：${s.trim().slice(0, 200)}`));
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch (err) {
        throw new Error(mask(`${context} 返回非法 JSON：${err.message}`), { cause: err });
      }
    }
  }
  throw new Error(mask(`${context} 返回的 JSON 不完整`));
}

// TAPD 用 status=1 表示成功；tapd-cli 自己包的命令（comment add 等）出 { ok, id }，ok=false 算失败
export function checkPayload(parsed, context) {
  const bad = parsed && typeof parsed === 'object' &&
    ((parsed.status !== undefined && Number(parsed.status) !== 1) || parsed.ok === false);
  if (bad) {
    throw new Error(mask(`${context} 失败：${parsed.info || parsed.error || JSON.stringify(parsed).slice(0, 200)}`));
  }
  return parsed;
}

// ── tapd-cli ──────────────────────────────────────────────────────────────
// 不经 shell（Core §11）；工单系统故障（网络、5xx、限流）按 TAPD_RETRY_DELAYS 退避重试。
// 重试完仍是故障，抛出的错误带 transient: true，main() 据此在出参 data 里标 transient（Core §15）。
// 参数一律下划线写法（entry_id=…）：tapd-cli 会静默丢掉连字符形式，把带过滤的查询变成不带过滤的。
// 测试 / 替换：设 MIWORKFLOW_TAPD 指向一个 JS 文件，就改成 node <那个文件> 执行（参数照传）。
const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorText = (err) =>
  [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ');

const firstSentence = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// 只看 tapd-cli 的输出：err.message 里带着命令行，id=500 这类参数会被误认成状态码
const outputText = (err) =>
  [err?.stderr, err?.stdout].filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ') || String(err?.message ?? '');

// 状态码要带 HTTP 或原因短语：id=500 这类参数不算
const SERVER_ERROR = /\bHTTP[/\d.]*\s*50[0-4]\b|\b50[0-4]\s+(internal server error|bad gateway|service unavailable|gateway time-?out)/i;

export const retryable = (err) => {
  const text = outputText(err);
  return SERVER_ERROR.test(text) ||
    /network|timeout|timed out|connection|econnreset|econnrefused|etimedout|eai_again|enetunreach|ehostunreach|socket hang up|temporarily unavailable|rate limit|too many requests|something went wrong while executing your query|reset by peer|unexpected eof|\beof\b/i.test(text);
};

const missingCommand = (err) =>
  err?.code === 'ENOENT' || /\benoent\b|not recognized|不是内部或外部命令/i.test(errorText(err));

export function runTapd(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fake = process.env.MIWORKFLOW_TAPD;
  const spawn = () => {
    const bin = fake ? process.execPath : 'tapd-cli';
    const args = fake ? [fake, ...argv] : argv;
    return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  };
  const delays = opts.retryDelays ?? TAPD_RETRY_DELAYS;
  const retries = opts.retries ?? delays.length;
  for (let attempt = 0; ; attempt++) {
    try {
      return spawn();
    } catch (err) {
      if (!fake && missingCommand(err)) {
        throw new Error('找不到 tapd-cli：先装好它（见 tapd-cli 技能），或设 MIWORKFLOW_TAPD', { cause: err });
      }
      const transient = retryable(err);
      const detail = errorText(err);
      if (!transient || attempt >= retries) {
        const e = new Error(mask(`tapd-cli ${argv.join(' ')} 失败${detail ? `：${detail}` : ''}`), { cause: err });
        if (transient) e.transient = true;
        throw e;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      process.stderr.write(mask(`tapd-cli ${argv[0]} ${argv[1] ?? ''} 第 ${attempt + 1} 次重试（等 ${Math.round(wait / 1000)} 秒）：${firstSentence(outputText(err))}`) + '\n');
      sleep(wait);
    }
  }
}

// 跑 tapd-cli 并取第一段 JSON、校验 status
export function tapdJson(argv, opts = {}) {
  const context = `tapd-cli ${argv.slice(0, 2).join(' ')}`;
  return checkPayload(firstJson(runTapd(argv, opts), context), context);
}

// ── OpenAPI ───────────────────────────────────────────────────────────────
// 读评论等要直接调：`tapd-cli comment list` 会把评论的 HTML 全部剥掉。
// $TAPD_API_ENDPOINT + Authorization: Bearer $TAPD_TOKEN；测试经 TAPD_API_ENDPOINT 指到本地假服务。
export async function openApi(pathname, { query = {}, method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const endpoint = process.env.TAPD_API_ENDPOINT;
  const token = process.env.TAPD_TOKEN;
  if (!endpoint) throw new Error('缺环境变量 TAPD_API_ENDPOINT');
  if (!token) throw new Error('缺环境变量 TAPD_TOKEN');

  const url = new URL(String(pathname).replace(/^\/+/, ''), endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const what = `TAPD OpenAPI ${method} ${url.pathname}`;
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    throw Object.assign(new Error(mask(`${what} 失败：${err.message}`), { cause: err }), { transient: true });
  }
  if (!res.ok) {
    const e = new Error(mask(`${what} 失败：HTTP ${res.status} ${text.slice(0, 200)}`));
    if (res.status >= 500 || res.status === 429) e.transient = true;
    throw e;
  }
  return checkPayload(firstJson(text, what), what);
}

// ── HTML → Markdown ───────────────────────────────────────────────────────
// TAPD 的描述、评论都是富文本 HTML。转成完整 Markdown：标题、表格、列表、加粗、斜体、行内代码、代码块、链接、引用。
// <img> 交给 opts.img(src, alt) 决定写成什么；src 用宽松正则认（属性顺序不定，单 / 双引号、不带引号都认）。
export const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi;
export const imgSrcOf = (m) => decode(String(m[1] ?? m[2] ?? m[3] ?? '').trim());

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);
const DROP = new Set(['script', 'style', 'head', 'title']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', copy: '©' };

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    try { return String.fromCodePoint(code === 160 ? 32 : code); } catch { return whole; }
  }
  return ENTITIES[e.toLowerCase()] ?? whole;
});

const attrOf = (raw, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(raw);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : '';
};

function parseHtml(html) {
  const root = { tag: '#root', children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/g;
  for (const m of String(html ?? '').matchAll(re)) {
    const top = stack.at(-1);
    if (m[4] !== undefined) top.children.push({ text: m[4] });
    else if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = { tag, raw: m[0], children: [] };
      top.children.push(node);
      if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node);
    }
  }
  return root;
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'center', 'address', 'dl', 'dt', 'dd']);
const wrap = (mark, s) => {
  const t = s.trim();
  if (!t) return '';
  const lead = /^\s/.test(s) ? ' ' : '';
  const tail = /\s$/.test(s) ? ' ' : '';
  return `${lead}${mark}${t}${mark}${tail}`;
};

export function htmlToMarkdown(html, { img = (src, alt) => `![${alt}](${src})` } = {}) {
  const inline = (nodes, ctx) => nodes.map((n) => render(n, ctx)).join('');
  const block = (s) => `\n\n${s.trim()}\n\n`;
  const plainText = (n) => (n.text !== undefined ? decode(n.text) : n.tag === 'br' ? '\n' : n.children.map(plainText).join(''));

  function list(node, ctx) {
    const depth = ctx.depth ?? 0;
    const pad = '   '.repeat(depth);
    let i = Number(attrOf(node.raw, 'start')) || 1;
    const items = node.children.filter((c) => c.tag === 'li' || (c.tag && c.tag !== 'li' && /^(ul|ol)$/.test(c.tag)));
    const lines = items.map((li) => {
      if (li.tag !== 'li') return list(li, { ...ctx, depth: depth + 1 }).replace(/^\n+|\n+$/g, '');
      const marker = node.tag === 'ol' ? `${i++}.` : '-';
      const body = inline(li.children, { ...ctx, depth: depth + 1 })
        .replace(/\n{3,}/g, '\n\n').trim()
        .split('\n').map((l, k) => (k === 0 || /^\s*$/.test(l) || l.startsWith(`${pad}   `) ? l : `${pad}   ${l.trimStart()}`)).join('\n');
      return `${pad}${marker} ${body}`;
    });
    return depth ? `\n${lines.join('\n')}\n` : block(lines.join('\n'));
  }

  function table(node, ctx) {
    const rows = [];
    const walk = (n) => {
      for (const c of n.children ?? []) {
        if (c.tag === 'tr') rows.push(c.children.filter((d) => d.tag === 'td' || d.tag === 'th'));
        else if (c.tag && c.tag !== 'table') walk(c);
      }
    };
    walk(node);
    if (!rows.length) return '';
    const cell = (d) => inline(d.children, { ...ctx, cell: true }).replace(/\s*\n\s*/g, '<br>').replace(/\|/g, '\\|').replace(/^(<br>)+|(<br>)+$/g, '').trim();
    const grid = rows.map((r) => r.map(cell));
    const width = Math.max(...grid.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
    return block([line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n'));
  }

  function render(n, ctx) {
    if (n.text !== undefined) return ctx.pre ? decode(n.text) : decode(n.text).replace(/\s+/g, ' ');
    const kids = () => inline(n.children, ctx);
    switch (n.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const t = kids().replace(/\s+/g, ' ').trim();
        return t ? (ctx.cell ? `**${t}**` : block(`${'#'.repeat(Number(n.tag[1]))} ${t}`)) : '';
      }
      case 'br': return ctx.pre ? '\n' : ctx.cell ? '<br>' : '  \n';
      case 'hr': return ctx.cell ? '' : block('---');
      case 'strong': case 'b': return wrap('**', kids());
      case 'em': case 'i': return wrap('*', kids());
      case 's': case 'del': case 'strike': return wrap('~~', kids());
      case 'code': {
        if (ctx.pre) return plainText(n);
        const t = plainText(n).replace(/\s+/g, ' ');
        if (!t.trim()) return '';
        const fence = t.includes('`') ? '``' : '`';
        return `${fence}${fence.length > 1 ? ' ' : ''}${t}${fence.length > 1 ? ' ' : ''}${fence}`;
      }
      case 'pre': {
        const t = plainText(n).replace(/^\n|\n$/g, '');
        return ctx.cell ? `\`${t.replace(/\s+/g, ' ')}\`` : block(`\`\`\`\n${t}\n\`\`\``);
      }
      case 'a': {
        const text = kids().trim();
        const href = attrOf(n.raw, 'href');
        if (!href || /^javascript:/i.test(href) || href.startsWith('#')) return text;
        return text ? (text === href ? `<${href}>` : `[${text}](${href})`) : '';
      }
      case 'img': {
        const m = [...n.raw.matchAll(IMG_SRC)][0];
        const src = m ? imgSrcOf(m) : '';
        return src ? img(src, attrOf(n.raw, 'alt').replace(/[[\]]/g, '')) : '';
      }
      case 'ul': case 'ol': return ctx.cell ? n.children.map((c) => inline(c.children ?? [], ctx).trim()).filter(Boolean).join('<br>') : list(n, ctx);
      case 'table': return ctx.cell ? kids() : table(n, ctx);
      case 'blockquote': {
        const t = kids().replace(/\n{3,}/g, '\n\n').trim();
        return t ? block(t.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')) : '';
      }
      case 'li': return block(kids());
      default:
        if (DROP.has(n.tag)) return '';
        if (BLOCK.has(n.tag) && !ctx.cell) {
          const t = kids();
          return t.trim() ? block(t) : '';
        }
        return kids();
    }
  }

  return render(parseHtml(html), {})
    .split('\n').map((l) => (/\S {2}$/.test(l) ? l : l.replace(/[ \t]+$/, ''))).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
