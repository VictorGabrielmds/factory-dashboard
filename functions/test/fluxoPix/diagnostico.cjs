const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const page = await browser.newPage();
  page.on('pageerror', error => console.log('PAGEERROR', error.stack || error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log('CONSOLE', message.type(), message.text()); });
  await page.goto('http://127.0.0.1:5187/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 2000));
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
