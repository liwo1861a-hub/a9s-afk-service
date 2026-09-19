const express = require('express');
const puppeteer = require('puppeteer');
const cookie = require('cookie');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

const USER_COOKIE = process.env.ZENIX_COOKIE || 'session=a14673dd-da6e-437d-afb8-3f86e72a33ec; cf_clearance=y7hxCgnDQFhhKrNjZifU6y0oh1P9o5vcIXrzMCfS2UU-1789802055-1.2.1.1-I_tcS0WrUlu1DF_.9rlB2SuqLl7X.M3zZSInkP_mB45DStU42Wr943AGXxbiTsKTp8dOqs0EfirsbKVxa2HVhq9SYUUZsCq8RwQ6FckysMsrQ116GZxslZO10EaeK55InrAYWHK49eI_YaS8GhYakwcOsLWrmcsw126Dg9teW_ghevkjvL9qReroc.cO7bHm0TfgBn38sVyPmGp.rb3qEDIyy9mrvQGN9A4Aor25rX5fhb3RPpKAypTo0iT51EmwmEZh3HzsUXu9h.XIWC8WGQENskFJUbFUg.7oiybGMJrw_P03QYeYMFxPeEA6cU5Bpvsp2KS5NdR4tVwLi5fRBAmBiXyXaKOmFk9zRfXufdSvrfOpiz7Crj8qUwguG31_FCeKYEFeauRjpW79vKMTYg';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

let browser = null;
let page = null;
let pageTitle = 'Initializing';
let pageUrl = 'About:blank';
let isStarting = false;

let stats = {
  probeCount: 0,
  afkCount: 0,
  balanceCount: 0,
  lastEventTime: null,
  recentLogs: []
};

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  stats.recentLogs.push(line);
  if (stats.recentLogs.length > 30) {
    stats.recentLogs.shift();
  }
}

// 杀掉潜在残留的孤儿 Chrome 进程
function cleanOldChrome() {
  try {
    execSync('pkill -9 -f chrome || true');
    execSync('pkill -9 -f chromium || true');
  } catch (e) {
    // ignore
  }
}

// 确保 Chrome 浏览器就绪
function ensureChromeInstalled() {
  try {
    const cacheDir = path.join(__dirname, '.cache', 'puppeteer');
    if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) {
      log('Local Chrome cache not found, downloading now...');
      execSync('npx puppeteer browsers install chrome', {
        stdio: 'inherit',
        env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir }
      });
      log('Chrome download completed.');
    }
  } catch (err) {
    log(`Chrome check/install warning: ${err.message}`);
  }
}

// 1. Web 状态与探活接口
app.get('/', (req, res) => {
  res.json({
    status: browser && page ? 'running' : (isStarting ? 'starting' : 'recovering'),
    platform: 'anynines PaaS (Cloud Foundry)',
    service: 'a9s-afk-service',
    uptime: `${Math.floor(process.uptime())}s`,
    pageTitle,
    pageUrl,
    stats,
    viewLiveScreenshot: '/screenshot',
    timestamp: new Date().toISOString()
  });
});

// 2. 实时画面截图预览
app.get('/screenshot', async (req, res) => {
  try {
    if (page && !page.isClosed()) {
      const buffer = await page.screenshot({ type: 'png' });
      res.set('Content-Type', 'image/png');
      return res.send(buffer);
    }
    res.status(503).send('Browser page not ready yet.');
  } catch (err) {
    res.status(500).send(`Screenshot error: ${err.message}`);
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  log(`Web server listening on port ${PORT}`);
});

// 3. 启动无头浏览器并挂机
async function startBrowser() {
  if (isStarting) return;
  isStarting = true;

  try {
    cleanOldChrome();
    ensureChromeInstalled();

    log('Launching Robust Headless Chrome via Puppeteer (pipe mode)...');
    browser = await puppeteer.launch({
      headless: 'new',
      pipe: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--window-size=1280,800'
      ],
      defaultViewport: { width: 1280, height: 800 }
    });

    log('Headless Chrome successfully launched!');

    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // 注入页面防休眠 / 防切后台机制
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    });

    // 解析并注入 Cookie
    const parsedCookies = cookie.parse(USER_COOKIE);
    const cookiesToSet = Object.entries(parsedCookies).map(([name, value]) => ({
      name,
      value,
      domain: '.zenix.sg',
      path: '/'
    }));
    await page.setCookie(...cookiesToSet);
    log(`Injected ${cookiesToSet.length} cookies into .zenix.sg domain.`);

    // 监听网络请求和响应
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();

      if (url.includes('/api/ads/probe')) {
        stats.probeCount++;
        stats.lastEventTime = new Date().toISOString();
        log(`📡 [Probe] 探针心跳 #${stats.probeCount} (HTTP ${status})`);
      } else if (url.includes('/afk')) {
        stats.afkCount++;
        stats.lastEventTime = new Date().toISOString();
        try {
          const body = await response.text();
          log(`💰 [AFK 结算] 触发金币结算 #${stats.afkCount} (HTTP ${status}): ${body.substring(0, 100)}`);
        } catch(e) {
          log(`💰 [AFK 结算] 触发金币结算 #${stats.afkCount} (HTTP ${status})`);
        }
      } else if (url.includes('/balance')) {
        stats.balanceCount++;
        try {
          const body = await response.text();
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status}): ${body.substring(0, 100)}`);
        } catch(e) {
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status})`);
        }
      }
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.toLowerCase().includes('coin') || text.toLowerCase().includes('afk') || text.toLowerCase().includes('balance') || text.toLowerCase().includes('reward')) {
        log(`[Page Console] ${text}`);
      }
    });

    log('Navigating to https://dash.zenix.sg/dashboard/afk ...');
    // 使用 domcontentloaded 代替 networkidle2，防止长轮询导致导航超时！
    await page.goto('https://dash.zenix.sg/dashboard/afk', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    pageTitle = await page.title();
    pageUrl = page.url();
    log(`✅ Page loaded! Title: "${pageTitle}" | URL: ${pageUrl}`);
    isStarting = false;

    // 监听浏览器异常断开，自愈重连
    browser.on('disconnected', () => {
      log('⚠️ Browser disconnected, auto restarting in 5s...');
      browser = null;
      page = null;
      isStarting = false;
      setTimeout(startBrowser, 5000);
    });

  } catch (err) {
    log(`❌ Browser error: ${err.message}`);
    isStarting = false;
    if (browser) {
      try { await browser.close(); } catch(e){}
      browser = null;
      page = null;
    }
    setTimeout(startBrowser, 10000);
  }
}

// 延迟 2 秒启动
setTimeout(startBrowser, 2000);
