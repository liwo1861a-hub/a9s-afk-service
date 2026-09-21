const express = require('express');
const puppeteer = require('puppeteer');
const cookie = require('cookie');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// 账号密码配置
const ZENIX_EMAIL = process.env.ZENIX_EMAIL || 'liwoniu0@gmail.com';
const ZENIX_PASSWORD = process.env.ZENIX_PASSWORD || 'Wkps0h_0FrP5n7RXoO4IPh0CaA1!';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let browser = null;
let page = null;
let pageTitle = 'Initializing';
let pageUrl = 'about:blank';
let isStarting = false;
let currentSessionCookie = null;
let currentUser = null;
let lastLoginTime = null;

let stats = {
  probeCount: 0,
  afkCount: 0,
  balanceCount: 0,
  currentCoins: 0,
  lastEventTime: null,
  loginCount: 0,
  recentLogs: []
};

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  stats.recentLogs.push(line);
  if (stats.recentLogs.length > 40) {
    stats.recentLogs.shift();
  }
}

// 杀掉潜在残留的 Chrome 进程
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
    version: '1.2.1',
    uptime: `${Math.floor(process.uptime())}s`,
    currentUser: currentUser || ZENIX_EMAIL,
    pageTitle,
    pageUrl,
    currentSession: currentSessionCookie ? `${currentSessionCookie.substring(0, 8)}...` : 'None',
    lastLoginTime,
    stats,
    viewLiveScreenshot: '/screenshot',
    forceLoginNow: '/login-now',
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

// 3. 手动触发重新登录
app.get('/login-now', async (req, res) => {
  try {
    if (page && !page.isClosed()) {
      log('Manual login requested via /login-now');
      await executeLoginFlow();
      return res.json({ status: 'success', message: 'Login flow executed', pageUrl: page.url() });
    }
    res.status(503).json({ status: 'error', message: 'Page not ready' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  log(`Web server listening on port ${PORT}`);
});

// 4. 执行自动登录流程
async function executeLoginFlow() {
  if (!page || page.isClosed()) return false;
  try {
    log(`🔑 Initiating automated login flow for ${ZENIX_EMAIL}...`);
    
    // 清除旧 cookies 确保干净登录目标账号
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');

    await page.goto('https://dash.zenix.sg/login', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await new Promise(r => setTimeout(r, 2000));

    // 等待邮箱和密码输入框就绪
    await page.waitForSelector('#email', { timeout: 15000 });
    await page.waitForSelector('#password', { timeout: 15000 });

    log(`Filling login credentials for ${ZENIX_EMAIL}...`);
    await page.click('#email', { clickCount: 3 });
    await page.type('#email', ZENIX_EMAIL, { delay: 40 });

    await page.click('#password', { clickCount: 3 });
    await page.type('#password', ZENIX_PASSWORD, { delay: 40 });

    await new Promise(r => setTimeout(r, 500));

    log('Submitting login form...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
        log(`Navigation note: ${e.message}`);
      }),
      page.click('button[type="submit"]')
    ]);

    await new Promise(r => setTimeout(r, 3000));

    const currentUrl = page.url();
    log(`Login submitted. Landed on: ${currentUrl}`);

    // 获取并保存最新 Session Cookie
    const cookies = await page.cookies();
    const sessionCookie = cookies.find(c => c.name === 'session');
    if (sessionCookie) {
      currentSessionCookie = sessionCookie.value;
      lastLoginTime = new Date().toISOString();
      stats.loginCount++;
      log(`🎉 New session captured: ${currentSessionCookie.substring(0, 10)}... (Login #${stats.loginCount})`);
    }

    // 跳转至 AFK 挂机页
    log('Navigating to AFK rewards dashboard...');
    await page.goto('https://dash.zenix.sg/dashboard/afk', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    pageTitle = await page.title();
    pageUrl = page.url();
    log(`✅ AFK page ready! Title: "${pageTitle}" | URL: ${pageUrl}`);
    return true;
  } catch (err) {
    log(`❌ Login flow error: ${err.message}`);
    return false;
  }
}

// 5. 启动无头浏览器并挂机
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

    // 注入页面防休眠 / 防切后台 / 广告探测穿透机制
    await page.evaluateOnNewDocument(() => {
      // 1. 防休眠与活跃状态伪装
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

      // 2. 绕过广告探测 DOM 测量（确保 ad-probe 判定为存在并渲染）
      const origGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = function (el, pseudo) {
        const style = origGetComputedStyle.call(window, el, pseudo);
        if (el && el.id === 'ad-probe') {
          return new Proxy(style, {
            get(target, prop) {
              if (prop === 'display') return 'block';
              if (prop === 'visibility') return 'visible';
              return target[prop];
            }
          });
        }
        return style;
      };

      const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        get() {
          if (this.id === 'ad-probe') return 1;
          return origOffsetHeight ? origOffsetHeight.get.call(this) : 1;
        }
      });

      const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        get() {
          if (this.id === 'ad-probe') return 1;
          return origClientHeight ? origClientHeight.get.call(this) : 1;
        }
      });
    });

    // 监听网络请求和响应
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();

      if (url.includes('/api/ads/probe')) {
        stats.probeCount++;
        stats.lastEventTime = new Date().toISOString();
        log(`📡 [Probe] 探针心跳 #${stats.probeCount} (HTTP ${status})`);
      } else if (url.includes('/afk') || url.includes('tickAfkCoinAction')) {
        stats.afkCount++;
        stats.lastEventTime = new Date().toISOString();
        try {
          const body = await response.text();
          log(`💰 [AFK 结算] 触发金币结算 #${stats.afkCount} (HTTP ${status}): ${body.substring(0, 120)}`);
        } catch (e) {
          log(`💰 [AFK 结算] 触发金币结算 #${stats.afkCount} (HTTP ${status})`);
        }
      } else if (url.includes('/balance')) {
        stats.balanceCount++;
        try {
          const body = await response.text();
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status}): ${body.substring(0, 100)}`);
          const match = body.match(/"coins":\s*([0-9.]+)/);
          if (match) {
            stats.currentCoins = parseFloat(match[1]);
          }
        } catch (e) {
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status})`);
        }
      }
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.toLowerCase().includes('coin') || text.toLowerCase().includes('afk') || text.toLowerCase().includes('reward') || text.toLowerCase().includes('session')) {
        log(`[Page Console] ${text}`);
      }
    });

    // 启动即直接执行全自动登录流程
    await executeLoginFlow();

    isStarting = false;

    // 监听浏览器异常断开，自愈重连
    browser.on('disconnected', () => {
      log('⚠️ Browser disconnected, auto restarting in 5s...');
      browser = null;
      page = null;
      isStarting = false;
      setTimeout(startBrowser, 5000);
    });

    // 启动常驻巡检守护循环（每 20 秒一次）
    startGuardianLoop();

  } catch (err) {
    log(`❌ Browser error: ${err.message}`);
    isStarting = false;
    if (browser) {
      try { await browser.close(); } catch (e) { }
      browser = null;
      page = null;
    }
    setTimeout(startBrowser, 10000);
  }
}

// 6. 常驻巡检守护循环（自动点击恢复按钮、检测会话失效、防卡死）
function startGuardianLoop() {
  setInterval(async () => {
    try {
      if (!page || page.isClosed()) return;

      pageTitle = await page.title();
      pageUrl = page.url();

      // 1. 如果掉到登录页，自动登录
      if (pageUrl.includes('/login')) {
        log('⚠️ Session expired (page on /login). Auto logging in...');
        await executeLoginFlow();
        return;
      }

      // 2. 如果不在 AFK 页面，自动跳转回去
      if (!pageUrl.includes('/dashboard/afk')) {
        log(`⚠️ Not on AFK page (currently ${pageUrl}), redirecting to /dashboard/afk...`);
        await page.goto('https://dash.zenix.sg/dashboard/afk', { waitUntil: 'domcontentloaded', timeout: 30000 });
        return;
      }

      // 3. 自动查找并点击页面上的 "Continue"、"Start"、"Check Again"、"Retry" 按钮
      const clicked = await page.evaluate(() => {
        let actionDone = false;
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.innerText || '').trim().toLowerCase();
          if (text.includes('continue') || text.includes('check again') || text.includes('resume') || text.includes('retry') || text.includes('start')) {
            btn.click();
            actionDone = true;
          }
        }
        return actionDone;
      });

      if (clicked) {
        log('🔘 Auto-clicked resume/continue/retry button on page.');
      }

    } catch (e) {
      log(`[Guardian Note] ${e.message}`);
    }
  }, 20 * 1000);
}

// 延迟 2 秒启动
setTimeout(startBrowser, 2000);
