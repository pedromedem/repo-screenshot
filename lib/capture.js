const fs = require("fs");
const path = require("path");
const { siteDirectoryName } = require("./repos");

async function hideSelectors(page, selectors) {
  if (!selectors.length) return;
  await page.evaluate((candidates) => {
    for (const selector of candidates) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        node.style.setProperty("display", "none", "important");
      }
    }
  }, selectors);
}

function viewportTargets(puppeteer) {
  const iphone = puppeteer.KnownDevices["iPhone X"];
  if (!iphone || !iphone.viewport) {
    throw new Error("Puppeteer device profile iPhone X is not available");
  }

  return [
    {
      name: "desktop",
      setup: (page) =>
        page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 }),
    },
    {
      name: "mobile",
      setup: async (page) => {
        await page.emulate(iphone);
        await page.setViewport({ ...iphone.viewport, deviceScaleFactor: 1 });
      },
    },
  ];
}

function isTimeout(error) {
  return error instanceof Error && /timeout/i.test(error.message);
}

async function openPage(page, url, timeoutMs) {
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
  } catch (error) {
    if (!isTimeout(error)) throw error;
    const ready = await page.evaluate(() => document.readyState).catch(() => "");
    if (ready !== "interactive" && ready !== "complete") throw error;
  }
}

async function captureViewport(browser, url, target, options) {
  const page = await browser.newPage();
  try {
    await target.setup(page);
    await openPage(page, url, options.timeoutMs);
    await hideSelectors(page, options.hide);
    if (options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    const directoryName = siteDirectoryName(url);
    const directoryPath = path.join(options.outputDir, directoryName);
    fs.mkdirSync(directoryPath, { recursive: true });
    const filePath = path.join(directoryPath, `${directoryName}_${target.name}.jpeg`);
    await page.screenshot({
      path: filePath,
      type: "jpeg",
      quality: options.quality,
      fullPage: options.fullPage,
    });
    return filePath;
  } finally {
    await page.close().catch(() => {});
  }
}

async function captureSites(urls, options) {
  const puppeteer = require("puppeteer");
  const targets = viewportTargets(puppeteer);
  const browser = await puppeteer.launch({ headless: "new" });
  const results = [];

  try {
    for (const url of urls) {
      const item = { url, files: {}, errors: {} };
      for (const target of targets) {
        try {
          item.files[target.name] = await captureViewport(browser, url, target, options);
        } catch (error) {
          item.errors[target.name] = error instanceof Error ? error.message : String(error);
        }
      }
      results.push(item);
      if (typeof options.onProgress === "function") {
        await options.onProgress(item);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

module.exports = {
  captureSites,
  captureViewport,
  viewportTargets,
};
