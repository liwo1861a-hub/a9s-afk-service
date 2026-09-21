const express = require('express');
const puppeteer = require('puppeteer');
const cookie = require('cookie');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

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
let currentSessionCookie = null;
let lastLoginTime = null;
let lastActivityTime = Date.now();

let stats = {
  probeCount: 0,
  afkCount: 0,
  balanceCount: 0,
  currentCoins: 0,
  lastEventTime: null,
  loginCount: 0,
  restartCount: 0,
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
  res.json({
    status: browser && page && !page.isClosed() ? 'running' : (isStarting ? 'starting' : 'recovering'),
    platform: 'anynines PaaS (Cloud Foundry)',
    service: 'a9s-afk-service',
    version: '1.2.2',
    uptime: `${Math.floor(process.uptime())}s`,
    currentUser: ZENIX_EMAIL,
    pageTitle,
    pageUrl,
    currentSession: currentSessionCookie ? `${currentSessionCookie.substring(0, 8)}...` : 'None',
    lastLoginTime,
    lastActivityAgo: `${Math.floor((Date.now() - lastActivityTime) / 1000)}s`,
    stats,
    viewLiveScreenshot: '/screenshot',
    forceRestart: '/restart',
    timestamp: new Date().toISOString()
  });
});

// 2. 实时画面截图预览（带 5 秒超时保护）
app.get('/screenshot', async (req, res) => {
  try {
    if (page && !page.isClosed()) {
      const screenshotPromise = page.screenshot({ type: 'png' });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 5000));
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
    triggerBrowserRestart('Manual restart via API');
    return res.json({ status: 'success', message: 'Restart triggered' });
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

// 4. 通过 Next.js Server Action 登录并获取最新 Session
async function performDirectLogin() {
  log(`🔑 Authenticating for ${ZENIX_EMAIL}...`);
  
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
          log(`🎉 Login successful! Session captured: ${currentSessionCookie.substring(0, 10)}... (Login #${stats.loginCount})`);
          return currentSessionCookie;
        }
      }
    } catch (e) {
      log(`Login attempt error: ${e.message}`);
    }
  }

  log('❌ Authentication failed for all credentials in pool.');
  return null;
}

// 5. 启动无头浏览器并进入挂机
async function startBrowser() {
  if (isStarting) return;
  isStarting = true;

  try {
    cleanOldChrome();
    ensureChromeInstalled();

    // 1. 登录并获取 Session
    const sessionVal = await performDirectLogin();

    log('Launching Headless Chrome via Puppeteer (pipe mode)...');
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

    // 2. 注入页面防休眠与广告探测直通机制
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

    // 3. 注入 Session Cookie
    if (sessionVal) {
      await page.setCookie({
        name: 'session',
        value: sessionVal,
        domain: '.zenix.sg',
        path: '/'
      });
      log('Injected session cookie into browser.');
    }

    // 4. 监听网络事件
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();

      if (url.includes('/api/ads/probe')) {
        stats.probeCount++;
        stats.lastEventTime = new Date().toISOString();
        lastActivityTime = Date.now();
        log(`📡 [Probe] 探针心跳 #${stats.probeCount} (HTTP ${status})`);
      } else if (url.includes('/afk') || url.includes('tickAfkCoinAction') || url.includes('startAfkAction')) {
        stats.afkCount++;
        stats.lastEventTime = new Date().toISOString();
        lastActivityTime = Date.now();
        try {
          const body = await response.text();
          log(`💰 [AFK 结算] 触发心跳 #${stats.afkCount} (HTTP ${status}): ${body.substring(0, 100)}`);
        } catch (e) {
          log(`💰 [AFK 结算] 触发心跳 #${stats.afkCount} (HTTP ${status})`);
        }
      } else if (url.includes('/balance')) {
        stats.balanceCount++;
        lastActivityTime = Date.now();
        try {
          const body = await response.text();
          const match = body.match(/"coins":\s*([0-9.]+)/);
          if (match) {
            stats.currentCoins = parseFloat(match[1]);
          }
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status}): coins=${stats.currentCoins}`);
        } catch (e) {
          log(`💳 [Balance] 刷新余额 #${stats.balanceCount} (HTTP ${status})`);
        }
      }
    });

    log('Navigating to https://dash.zenix.sg/dashboard/afk ...');
    await page.goto('https://dash.zenix.sg/dashboard/afk', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    pageTitle = await page.title();
    pageUrl = page.url();
    log(`✅ Page loaded! Title: "${pageTitle}" | URL: ${pageUrl}`);

    isStarting = false;

    // 监听浏览器异常断开
    browser.on('disconnected', () => {
      log('⚠️ Browser disconnected event received.');
      triggerBrowserRestart('Browser disconnected');
    });

  } catch (err) {
    log(`❌ Browser error: ${err.message}`);
    isStarting = false;
    triggerBrowserRestart(`Launch error: ${err.message}`);
  }
}

// 6. 统一重启管理器（防抖重启）
let restartTimer = null;
function triggerBrowserRestart(reason) {
  if (restartTimer) return;
  log(`🔄 Scheduling browser restart. Reason: ${reason}`);
  stats.restartCount++;
  
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    isStarting = false;
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

// 7. 高鲁棒看门狗（Watchdog）：每 30 秒探测一次，杜绝假死与卡顿
function startWatchdog() {
  setInterval(async () => {
    try {
      if (isStarting) return;

      // 1. 如果浏览器或页面不存在，触发重启
      if (!browser || !page || page.isClosed()) {
        triggerBrowserRestart('Browser or page is null/closed');
        return;
      }

      // 2. 页面健康探测（如果 5 秒内无法获取 title，说明渲染线程假死卡住）
      try {
        const titlePromise = page.title();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('CDP title timeout')), 6000));
        pageTitle = await Promise.race([titlePromise, timeoutPromise]);
        pageUrl = page.url();
      } catch (e) {
        log(`🚨 [Watchdog Alert] Browser renderer is hanging (${e.message}), killing & restarting...`);
        triggerBrowserRestart('Renderer hanging');
        return;
      }

      // 3. 检查是否重定向到登录页
      if (pageUrl.includes('/login')) {
        log('⚠️ Page is on /login, session expired. Triggering restart & re-auth...');
        triggerBrowserRestart('Landed on login page');
        return;
      }

      // 4. 精准恢复：仅在存在“Session Paused”卡片时，精准点击卡片内的 Continue 按钮（绝不全局瞎点）
      try {
        const resumeClicked = await page.evaluate(() => {
          const pausedCards = Array.from(document.querySelectorAll('.ops-card'));
          for (const card of pausedCards) {
            if (card.innerText && card.innerText.includes('Session Paused')) {
              const btn = card.querySelector('button');
              if (btn) {
                btn.click();
                return true;
              }
            }
          }
          return false;
        });
        if (resumeClicked) {
          log('🔘 Precision-clicked Continue on Session Paused card.');
        }
      } catch (e) {
        // ignore evaluate error
      }

      // 5. 活跃超时检测：如果超过 3.5 分钟没有收到任何网络心跳事件，说明挂机静默中断，自动重启自愈
      const inactiveSec = Math.floor((Date.now() - lastActivityTime) / 1000);
      if (inactiveSec > 210) {
        log(`🚨 [Watchdog Alert] No activity for ${inactiveSec}s (exceeded 210s threshold), auto healing...`);
        triggerBrowserRestart(`Inactivity timeout (${inactiveSec}s)`);
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
