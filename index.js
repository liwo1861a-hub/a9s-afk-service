const express = require('express');
const puppeteer = require('puppeteer');
const cookie = require('cookie');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// 全局防崩溃拦截
process.on('uncaughtException', (err) => {
  console.error(`[Fatal UncaughtException] ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[Fatal UnhandledRejection] ${reason}`);
});

// 账号密码候选池
const ZENIX_EMAIL = process.env.ZENIX_EMAIL || 'liwoniu0@gmail.com';
const PASSWORDS = [
  process.env.ZENIX_PASSWORD,
  'Wkps0h_0FrP5n7RXoO4IPh0CaA1!',
  'LLHlys123...',
  'LLHLYS123...'
].filter(Boolean);

const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let browser = null;
let page = null;
let pageTitle = 'Initializing';
let pageUrl = 'about:blank';
let isStarting = false;
let isClosing = false;
let currentSessionCookie = null;
let lastLoginTime = null;
let lastActivityTime = Date.now();
let lastBalanceIncreaseTime = Date.now();
let lastRecycleTime = Date.now();
let lastRestartTime = Date.now();

let stats = {
  probeCount: 0,
  afkCount: 0,
  balanceCount: 0,
  currentCoins: 0,
  previousCoins: 0,
  lastEventTime: null,
  loginCount: 0,
  restartCount: 0,
  stallCount: 0,
  recycleCount: 0,
  recentLogs: []
};

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  stats.recentLogs.push(line);
  if (stats.recentLogs.length > 50) {
    stats.recentLogs.shift();
  }
}

// 杀掉残留的 Chrome 进程
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
  const memUsage = process.memoryUsage();
  res.json({
    status: browser && page && !page.isClosed() && !isStarting ? 'running' : (isStarting ? 'starting' : 'recovering'),
    platform: 'anynines PaaS (Cloud Foundry)',
    service: 'a9s-afk-service',
    version: '1.3.1',
    uptime: `${Math.floor(process.uptime())}s`,
    currentUser: ZENIX_EMAIL,
    pageTitle,
    pageUrl,
    currentSession: currentSessionCookie ? `${currentSessionCookie.substring(0, 8)}...` : 'None',
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
    },
    lastLoginTime,
    lastActivityAgo: `${Math.floor((Date.now() - lastActivityTime) / 1000)}s`,
    lastCoinIncreaseAgo: `${Math.floor((Date.now() - lastBalanceIncreaseTime) / 1000)}s`,
    stats,
    viewLiveScreenshot: '/screenshot',
    forceRestart: '/restart',
    forceLoginNow: '/login-now',
    timestamp: new Date().toISOString()
  });
});

// 2. 实时画面截图预览（带 6 秒超时保护）
app.get('/screenshot', async (req, res) => {
  try {
    if (page && !page.isClosed()) {
      const screenshotPromise = page.screenshot({ type: 'png' });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 6000));
      const buffer = await Promise.race([screenshotPromise, timeoutPromise]);
      res.set('Content-Type', 'image/png');
      return res.send(buffer);
    }
    res.status(503).send('Browser page not ready yet.');
  } catch (err) {
    res.status(500).send(`Screenshot error: ${err.message}`);
  }
});

// 3. 手动触发强制重启
app.get('/restart', async (req, res) => {
  try {
    log('Manual restart requested via /restart');
    triggerBrowserRestart('Manual restart via API', true);
    return res.json({ status: 'success', message: 'Restart triggered' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 4. 手动强制重新登录
app.get('/login-now', async (req, res) => {
  try {
    log('Manual login requested via /login-now');
    const ok = await performDirectLogin();
    if (ok) {
      triggerBrowserRestart('Re-auth via /login-now', true);
      return res.json({ status: 'success', message: 'Logged in, restarting browser session' });
    }
    return res.status(500).json({ status: 'failed', message: 'Login failed' });
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

// 5. 双模认证机制：优先 Server Action 秒级登录
async function performDirectLogin() {
  log(`🔑 [Auth Stage 1] Direct Server-Action authentication for ${ZENIX_EMAIL}...`);
  
  for (const pwd of PASSWORDS) {
    try {
      const resp = await fetch('https://dash.zenix.sg/login', {
        method: 'POST',
        headers: {
          'Next-Action': '6013174bf5bcaa2ea2f3f0417e1f6e0370071e5036',
          'Content-Type': 'text/plain;charset=UTF-8',
          'User-Agent': USER_AGENT,
          'Origin': 'https://dash.zenix.sg',
          'Referer': 'https://dash.zenix.sg/login'
        },
        body: JSON.stringify([ZENIX_EMAIL, pwd])
      });

      const bodyText = await resp.text();
      const setCookie = resp.headers.get('set-cookie');

      if (bodyText.includes('"success":true') && setCookie) {
        const match = setCookie.match(/session=([^;]+)/);
        if (match) {
          currentSessionCookie = match[1];
          lastLoginTime = new Date().toISOString();
          stats.loginCount++;
          lastActivityTime = Date.now();
          log(`🎉 Server-Action login successful! Session: ${currentSessionCookie.substring(0, 10)}... (Login #${stats.loginCount})`);
          return currentSessionCookie;
        }
      }
    } catch (e) {
      log(`Server-Action login attempt note: ${e.message}`);
    }
  }

  log('⚠️ Server-Action login did not succeed, will try DOM fallback.');
  return null;
}

// 6. DOM UI 降级登录
async function performDomUiLoginFallback() {
  if (!page || page.isClosed()) return false;
  try {
    log('🔑 [Auth Stage 2] Executing DOM UI automated login fallback...');
    await page.goto('https://dash.zenix.sg/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise(r => setTimeout(r, 2000));

    if (page.url().includes('/dashboard') && !page.url().includes('/login')) {
      log('Already inside dashboard, skipping credential input.');
      return true;
    }

    await page.waitForSelector('#email', { timeout: 15000 });
    await page.waitForSelector('#password', { timeout: 15000 });

    for (const pwd of PASSWORDS) {
      log(`Attempting DOM input for ${ZENIX_EMAIL}...`);
      await page.evaluate((em, pw) => {
        function setValue(el, val) {
          const setter = Object.getOwnPropertyDescriptor(el, 'value')?.set || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          if (setter) setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const eInput = document.querySelector('#email');
        const pInput = document.querySelector('#password');
        if (eInput) setValue(eInput, em);
        if (pInput) setValue(pInput, pw);
      }, ZENIX_EMAIL, pwd);

      await new Promise(r => setTimeout(r, 500));
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        page.click('button[type="submit"]')
      ]);

      await new Promise(r => setTimeout(r, 2000));
      if (!page.url().includes('/login')) {
        const cookies = await page.cookies();
        const sCookie = cookies.find(c => c.name === 'session');
        if (sCookie) {
          currentSessionCookie = sCookie.value;
          lastLoginTime = new Date().toISOString();
          stats.loginCount++;
          log(`🎉 DOM UI Login successful! Session: ${currentSessionCookie.substring(0, 10)}...`);
          return true;
        }
      }
    }
  } catch (err) {
    log(`[DOM UI Login Error] ${err.message}`);
  }
  return false;
}

// 7. 启动无头浏览器并进入挂机
async function startBrowser() {
  if (isStarting) return;
  isStarting = true;
  isClosing = false;
  lastRestartTime = Date.now();

  try {
    cleanOldChrome();
    ensureChromeInstalled();

    const sessionVal = await performDirectLogin();

    log('Launching Headless Chrome (Optimized Low-Memory Mode)...');
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
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=256',
        '--disk-cache-size=10485760',
        '--window-size=1280,800'
      ],
      defaultViewport: { width: 1280, height: 800 }
    });

    log('Headless Chrome successfully launched!');

    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // 注入页面防休眠 / 活跃欺骗 / 广告探针可见性直通
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

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

    // 注入 Session Cookie
    if (sessionVal) {
      await page.setCookie({
        name: 'session',
        value: sessionVal,
        domain: '.zenix.sg',
        path: '/'
      });
      log('Injected session cookie into browser.');
    }

    // 监听网络响应（严格过滤 fetch/xhr，杜绝把 HTML 主文档当成 API 报错）
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      const reqType = response.request().resourceType();

      // 仅针对 fetch / xhr 请求进行错误校验
      if (reqType === 'fetch' || reqType === 'xhr') {
        if (status === 401 || status === 403) {
          log(`⚠️ Session invalidation on ${url} (HTTP ${status}). Scheduling refresh...`);
          triggerBrowserRestart(`Session invalidation HTTP ${status}`);
          return;
        }
      }

      // 探针心跳
      if (url.includes('/api/ads/probe')) {
        stats.probeCount++;
        stats.lastEventTime = new Date().toISOString();
        lastActivityTime = Date.now();
        log(`📡 [Probe] 探针心跳 #${stats.probeCount} (HTTP ${status})`);
      } 
      // AFK 结算心跳
      else if (url.includes('tickAfkCoinAction') || url.includes('startAfkAction')) {
        stats.afkCount++;
        stats.lastEventTime = new Date().toISOString();
        lastActivityTime = Date.now();
        log(`💰 [AFK 结算] 触发心跳 #${stats.afkCount} (HTTP ${status})`);
      } 
      // 余额刷新与增长检测（Stall Detection）
      else if (url.includes('/balance')) {
        stats.balanceCount++;
        lastActivityTime = Date.now();
        try {
          const body = await response.text();
          const match = body.match(/"coins":\s*([0-9.]+)/);
          if (match) {
            const newCoins = parseFloat(match[1]);
            if (newCoins > stats.currentCoins) {
              stats.previousCoins = stats.currentCoins;
              stats.currentCoins = newCoins;
              lastBalanceIncreaseTime = Date.now();
              log(`💳 [Coin Growth] 金币余额增长至: ${newCoins} (+${newCoins - stats.previousCoins})`);
            } else {
              stats.currentCoins = newCoins;
            }
          }
        } catch (e) {}
      }
    });

    log('Navigating to https://dash.zenix.sg/dashboard/afk ...');
    await page.goto('https://dash.zenix.sg/dashboard/afk', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    pageTitle = await page.title();
    pageUrl = page.url();

    // 如果未登录且被重定向到 /login，触发 DOM 降级登录
    if (pageUrl.includes('/login')) {
      log('⚠️ Landed on login page, executing DOM UI login...');
      const domLoginOk = await performDomUiLoginFallback();
      if (domLoginOk) {
        await page.goto('https://dash.zenix.sg/dashboard/afk', { waitUntil: 'domcontentloaded', timeout: 45000 });
        pageTitle = await page.title();
        pageUrl = page.url();
      }
    }

    log(`✅ Page loaded! Title: "${pageTitle}" | URL: ${pageUrl}`);
    isStarting = false;
    lastBalanceIncreaseTime = Date.now();
    lastRecycleTime = Date.now();

    // 监听断开（仅在非主动关闭时触发）
    browser.on('disconnected', () => {
      if (!isClosing) {
        log('⚠️ Browser disconnected unexpectedly.');
        triggerBrowserRestart('Browser disconnected unexpected');
      }
    });

  } catch (err) {
    log(`❌ Browser error: ${err.message}`);
    isStarting = false;
    triggerBrowserRestart(`Launch error: ${err.message}`);
  }
}

// 8. 统一重启与轮换管理器（带冷却时间与断开监听清理）
let restartTimer = null;
function triggerBrowserRestart(reason, force = false) {
  // 重启冷却保护：距离上次重启不足 30 秒时，忽略非强制重启请求，防止 Ping-Pong 循环
  if (!force && Date.now() - lastRestartTime < 30000) {
    log(`⏳ Restart ignored due to 30s cooldown (${reason})`);
    return;
  }

  if (restartTimer) return;
  log(`🔄 Scheduling browser restart. Reason: ${reason}`);
  stats.restartCount++;
  lastRestartTime = Date.now();
  
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    isStarting = false;
    isClosing = true;

    if (browser) {
      try {
        browser.removeAllListeners('disconnected');
      } catch (e) {}
    }

    if (page) {
      try { await page.close(); } catch (e) {}
      page = null;
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
      browser = null;
    }

    cleanOldChrome();
    log('♻️ Executing fresh browser startup...');
    startBrowser();
  }, 4000);
}

// 9. 工业级多维看门狗（Watchdog）：内存防泄漏轮换 + 假死探测 + 金币停滞熔断自愈 + 弹窗清理
function startWatchdog() {
  setInterval(async () => {
    try {
      if (isStarting || isClosing) return;

      // 1. 存在性检查
      if (!browser || !page || page.isClosed()) {
        triggerBrowserRestart('Browser or page is null/closed');
        return;
      }

      // 2. 页面健康与假死探测（超时 6 秒则判定 CDP 通道卡死）
      try {
        const titlePromise = page.title();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('CDP title timeout')), 6000));
        pageTitle = await Promise.race([titlePromise, timeoutPromise]);
        pageUrl = page.url();
      } catch (e) {
        log(`🚨 [Watchdog Alert] Browser renderer is hanging (${e.message}), killing & restarting...`);
        triggerBrowserRestart('Renderer hanging', true);
        return;
      }

      // 3. Cloudflare 拦截检测与自愈
      if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare') || pageUrl.includes('cf_challenge')) {
        log('🛡️ [CF Challenge Detected] Page is blocked by Cloudflare. Auto reloading with delay...');
        await new Promise(r => setTimeout(r, 5000));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return;
      }

      // 4. 重定向登录页自愈
      if (pageUrl.includes('/login')) {
        log('⚠️ Page on /login, session lost. Triggering restart & re-auth...');
        triggerBrowserRestart('Landed on login page', true);
        return;
      }

      // 5. 精准弹窗清理与 Continue 恢复
      try {
        await page.evaluate(() => {
          const pausedCards = Array.from(document.querySelectorAll('.ops-card'));
          for (const card of pausedCards) {
            if (card.innerText && card.innerText.includes('Session Paused')) {
              const btn = card.querySelector('button');
              if (btn) btn.click();
            }
          }
          const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Close"], button.close, [data-dismiss="modal"]'));
          for (const btn of closeBtns) {
            btn.click();
          }
        });
      } catch (e) {}

      // 6. 网络静默超时检测（> 210秒无任何响应）
      const inactiveSec = Math.floor((Date.now() - lastActivityTime) / 1000);
      if (inactiveSec > 210) {
        log(`🚨 [Watchdog Alert] Network silent for ${inactiveSec}s, auto healing...`);
        triggerBrowserRestart(`Network inactivity (${inactiveSec}s)`, true);
        return;
      }

      // 7. 金币增长停滞熔断自愈（Stall Watchdog）：若超过 12 分钟金币完全没有增长，强制重置会话
      const coinStallSec = Math.floor((Date.now() - lastBalanceIncreaseTime) / 1000);
      if (coinStallSec > 720) { // 12 minutes
        stats.stallCount++;
        log(`⚠️ [Stall Alert] No coin increase for ${coinStallSec}s (exceeded 720s). Triggering auto-reset #${stats.stallCount}...`);
        lastBalanceIncreaseTime = Date.now(); // reset timer
        triggerBrowserRestart('Coin earnings stalled for >12min', true);
        return;
      }

      // 8. 内存防泄漏周期性优雅轮换（Scheduled Recycling，每 6 小时自动重置一次内存）
      const runningSec = Math.floor((Date.now() - lastRecycleTime) / 1000);
      if (runningSec > 6 * 3600) {
        stats.recycleCount++;
        log(`🧹 [Scheduled Recycling] 6-hour memory recycle interval reached. Performing graceful browser refresh #${stats.recycleCount}...`);
        lastRecycleTime = Date.now();
        triggerBrowserRestart('Scheduled 6-hour memory recycle', true);
      }

    } catch (err) {
      log(`[Watchdog Error] ${err.message}`);
    }
  }, 30 * 1000);
}

// 延迟 2 秒启动
setTimeout(() => {
  startBrowser();
  startWatchdog();
}, 2000);
