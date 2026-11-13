#!/usr/bin/env node
/**
 * NMEA Web Viewer 的独立开发服务器。
 *
 * 只依赖 Node.js 标准库，做三件事：
 *  1. 提供本目录的静态文件（页面、Plotly、示例日志、可选的 sky_split.json）；
 *  2. 代理 /tiles/{source}/{z}/{x}/{y} 地图瓦片并缓存到 .cache/tiles；
 *  3. 自动检测环境变量 / Windows 系统代理（含 PAC），用代理访问 Google / OSM 瓦片。
 *
 * 地图瓦片必须由服务端代取：浏览器直连常被 CORS 拦截，ArcGIS 的 URL
 * 顺序也不是 Plotly 要求的 {z}/{x}/{y}。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CACHE_DIR = path.join(ROOT, '.cache', 'tiles');
const USER_AGENT = 'Mozilla/5.0 (NmeaWebViewer; independent static project)';

const TILE_SOURCES = {
  'arcgis-imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ext: '.jpg',
  },
  'gaode-street': {
    url: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    ext: '.png',
  },
  'gaode-satellite': {
    url: 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    ext: '.jpg',
  },
  'google-satellite': {
    url: 'https://mt1.google.com/vt/lyrs=s&hl=zh-CN&gl=cn&x={x}&y={y}&z={z}',
    ext: '.jpg',
  },
  'google-street': {
    url: 'https://mt1.google.com/vt/lyrs=m&hl=zh-CN&gl=cn&x={x}&y={y}&z={z}',
    ext: '.png',
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    ext: '.png',
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.log': 'text/plain; charset=utf-8',
  '.nmea': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const options = {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT) || 8000,
    open: false,
    proxy: null,
    noProxy: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--open') options.open = true;
    else if (arg === '--no-proxy') options.noProxy = true;
    else if (arg === '--proxy') options.proxy = argv[++i];
    else if (arg.startsWith('--proxy=')) options.proxy = arg.slice(8);
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg === '--host') options.host = argv[++i];
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node server.mjs [--host 127.0.0.1] [--port 8000] [--open] [--proxy URL] [--no-proxy]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`端口不合法: ${options.port}`);
  }
  return options;
}

function normalizeProxy(value) {
  if (!value) return null;
  let text = String(value).trim().replace(/^["']|["']$/g, '');
  if (!text || /^direct$/i.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function proxyFromEnvironment() {
  return normalizeProxy(
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy,
  );
}

function proxyReachable(proxyUrl) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      timeout: 1200,
    });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function proxyFromServerValue(value) {
  if (!value) return null;
  const parts = String(value).split(';').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (!part.includes('=')) continue;
    const [scheme, address] = part.split('=', 2);
    if (scheme.toLowerCase() === 'http' || scheme.toLowerCase() === 'https') {
      const proxy = normalizeProxy(address);
      if (proxy) return proxy;
    }
  }
  return normalizeProxy(parts[0] || '');
}

function readWindowsProxySettings() {
  if (process.platform !== 'win32') return null;
  let output;
  try {
    output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
  } catch {
    return null;
  }
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.*)$/i);
    if (match) values[match[1].toLowerCase()] = match[2].trim();
  }
  return values;
}

async function proxyFromPac(pacUrl) {
  if (!pacUrl) return null;
  const text = await new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(pacUrl);
    } catch {
      resolve('');
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Connection: 'close',
      },
      timeout: 4000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve('');
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', () => resolve(''));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(''));
  });
  if (!text) return null;
  const match = text.match(/(?:^|[^A-Za-z0-9_])(?:PROXY|HTTPS)\s+([^;\s"']+)/i);
  return match ? normalizeProxy(match[1]) : null;
}

async function detectSystemProxy() {
  const fromEnv = proxyFromEnvironment();
  if (fromEnv) return fromEnv;

  const settings = readWindowsProxySettings();
  if (!settings) return null;
  if (settings.proxyenable && !/^(0x0+|0)$/i.test(settings.proxyenable)) {
    const proxy = proxyFromServerValue(settings.proxyserver);
    if (proxy) return proxy;
  }
  return proxyFromPac(settings.autoconfigurl);
}

function relaunchWithProxy(proxy) {
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
    console.warn('[proxy] 检测到系统代理，但当前 Node.js 不支持 --use-env-proxy；请升级到 Node.js 24+，本次直连。');
    return false;
  }
  console.log(`[proxy] 检测到本地代理 ${proxy}，Google / OSM 瓦片将通过它访问`);
  const noProxy = [process.env.NO_PROXY || process.env.no_proxy, '127.0.0.1,localhost,::1']
    .filter(Boolean).join(',');
  const env = {
    ...process.env,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const child = spawn(
    process.execPath,
    ['--use-env-proxy', SCRIPT_PATH, ...process.argv.slice(2)],
    { stdio: 'inherit', env },
  );
  child.on('error', (error) => {
    console.error(`[proxy] 启动代理模式失败: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  return true;
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cacheControl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.html', '.js', '.mjs', '.css', '.json', '.log', '.nmea', '.txt']
    .includes(ext) ? 'no-store' : 'public, max-age=3600';
}

function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    'Content-Length': buffer.length,
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(buffer);
}

function sendText(res, status, text) {
  sendBuffer(res, status, Buffer.from(text, 'utf8'), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, '路径编码不正确');
    return;
  }

  let relative = decoded === '/' ? '/index.html' : decoded;
  if (relative.endsWith('/')) relative += 'index.html';

  const filePath = path.resolve(ROOT, `.${relative}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendText(res, 403, '禁止访问');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, '未找到');
    return;
  }
  if (!stat.isFile()) {
    sendText(res, 404, '未找到');
    return;
  }

  const headers = {
    'Content-Type': contentType(filePath),
    'Cache-Control': cacheControl(filePath),
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size, 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size, 'Access-Control-Allow-Origin': '*' });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sniffImage(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function serveTile(req, res, rest) {
  const parts = rest.split('/');
  if (parts.length !== 4) {
    sendText(res, 404, '瓦片路径不正确');
    return;
  }
  const [source, z, x, y] = parts;
  const meta = TILE_SOURCES[source];
  if (!meta || !/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y) || Number(z) > 20) {
    sendText(res, 404, '未知瓦片');
    return;
  }

  const cachePath = path.join(CACHE_DIR, source, z, x, `${y}${meta.ext}`);
  try {
    const data = await fsp.readFile(cachePath);
    const type = sniffImage(data);
    if (type) {
      sendBuffer(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      return;
    }
    await fsp.rm(cachePath, { force: true });
  } catch {
    // 无缓存，继续请求上游
  }

  const url = meta.url.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error(`[tile] 失败 ${source} ${z}/${x}/${y}: ${error.message}`);
    sendText(res, 502, '瓦片获取失败');
    return;
  }
  if (!response.ok) {
    console.error(`[tile] 上游 ${response.status} ${source} ${z}/${x}/${y}`);
    sendText(res, 502, `瓦片获取失败 HTTP ${response.status}`);
    return;
  }

  let data;
  try {
    data = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`[tile] 读取失败 ${source} ${z}/${x}/${y}: ${error.message}`);
    sendText(res, 502, '瓦片读取失败');
    return;
  }
  const type = sniffImage(data);
  if (!type) {
    sendText(res, 502, '瓦片内容异常');
    return;
  }

  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, data);
    await fsp.rename(temporary, cachePath);
  } catch (error) {
    // 缓存失败不影响响应
    console.error(`[tile] 缓存失败: ${error.message}`);
  }

  sendBuffer(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
}

function openBrowser(url) {
  const commands = {
    win32: ['cmd.exe', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
  };
  const command = commands[process.platform];
  if (!command) return;
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // 打不开浏览器不影响服务
  }
}

function startServer(options) {
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, '只支持 GET / HEAD');
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      sendText(res, 400, '请求路径不正确');
      return;
    }

    if (pathname.startsWith('/tiles/')) {
      if (method === 'HEAD') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      void serveTile(req, res, pathname.slice('/tiles/'.length)).catch((error) => {
        console.error(`[tile] 处理失败: ${error.message}`);
        if (!res.headersSent) sendText(res, 502, '瓦片处理失败');
        else res.destroy();
      });
      return;
    }

    void serveStatic(req, res, pathname).catch((error) => {
      console.error(`[static] 处理失败: ${error.message}`);
      if (!res.headersSent) sendText(res, 500, '读取文件失败');
      else res.destroy();
    });
  });

  server.on('error', (error) => {
    console.error(`服务器启动失败: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(options.port, options.host, () => {
    const shownHost = options.host === '0.0.0.0' ? 'localhost' : options.host;
    const url = `http://${shownHost}:${options.port}/`;
    console.log('NMEA Web Viewer');
    console.log(`  ${url}`);
    console.log('  示例数据: /nmea.log');
    console.log('  地图瓦片: /tiles/:source/:z/:x/:y');
    if (options.open) setTimeout(() => openBrowser(url), 150);
  });
}

async function bootstrap() {
  const options = parseArgs(process.argv.slice(2));
  if (process.execArgv.includes('--use-env-proxy') || options.noProxy) {
    startServer(options);
    return;
  }

  let proxy = null;
  if (options.proxy) {
    proxy = normalizeProxy(options.proxy);
    if (!proxy) console.warn(`[proxy] 无法识别代理地址: ${options.proxy}`);
  } else {
    proxy = await detectSystemProxy();
  }
  if (proxy) {
    if (!(await proxyReachable(proxy))) {
      console.warn(`[proxy] 代理 ${proxy} 无法连接，本次直连；Google / OSM 可能不可用。`);
      proxy = null;
    }
  }
  if (proxy && relaunchWithProxy(proxy)) return;
  startServer(options);
}

bootstrap().catch((error) => {
  console.error(`启动失败: ${error.stack || error.message}`);
  process.exit(1);
});
