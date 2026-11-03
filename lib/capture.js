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

async function launchBrowser() {
  if (process.env.VERCEL) {
    const fs = require("fs");
    const path = require("path");
    const chromium = require("@sparticuz/chromium");
    const puppeteer = require("puppeteer-core");
    const lambdafs = require("@sparticuz/chromium/build/lambdafs").default;
    const { setupLambdaEnvironment } = require("@sparticuz/chromium/build/helper");
    const bin = path.join(path.dirname(require.resolve("@sparticuz/chromium/package.json")), "bin");
    const libDir = "/tmp/al2023/lib";
    setupLambdaEnvironment(libDir);
    if (!fs.existsSync(path.join(libDir, "libnss3.so"))) {
      fs.rmSync("/tmp/al2023", { recursive: true, force: true });
      await lambdafs.inflate(path.join(bin, "al2023.tar.br"));
    }
    process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
    chromium.setGraphicsMode = false;
    try {
      return {
        puppeteer,
        browser: await puppeteer.launch({
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(bin),
          headless: chromium.headless,
          env: process.env,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nlibnss3=${fs.existsSync(path.join(libDir, "libnss3.so"))} LD_LIBRARY_PATH=${process.env.LD_LIBRARY_PATH}`
      );
    }
  }

  const puppeteer = require("puppeteer");
  return {
    puppeteer,
    browser: await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }),
  };
}

async function captureSites(urls, options) {
  const { puppeteer, browser } = await launchBrowser();
  const targets = viewportTargets(puppeteer);
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
