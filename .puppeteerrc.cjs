const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // 固化缓存目录为应用内的 .cache/puppeteer，彻底杜绝 staging 与 runtime 路径不一致问题
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
