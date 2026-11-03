#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const {
  fetchUserRepos,
  homepagesFromRepos,
  siteDirectoryName,
} = require("./lib/repos");

const program = new Command();

function collect(value, previous) {
  return [...(Array.isArray(previous) ? previous : []), value];
}

function requireDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 120) {
    throw new Error("--delay must be a number of seconds from 0 to 120");
  }
  return Math.round(number * 1000);
}

function requireInteger(value, flag, min, max) {
  if (!/^\d+$/.test(String(value).trim())) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  const number = Number(value);
  if (number < min || number > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function resolveHideSelectors(values) {
  if (!values || values.length === 0) return ["#modal"];
  const selectors = values.map((value) => String(value).trim()).filter(Boolean);
  if (selectors.some((selector) => selector.toLowerCase() === "none")) return [];
  return selectors;
}

program
  .name("repo-screenshot")
  .description(
    "Capture desktop and mobile screenshots of GitHub repository homepages."
  )
  .requiredOption("-n, --name <username>", "GitHub username")
  .option("-o, --output <dir>", "directory for screenshots", "screenshots")
  .option("-d, --delay <seconds>", "seconds to wait after each page loads", "1")
  .option("-q, --quality <1-100>", "JPEG quality", "80")
  .option("--timeout <seconds>", "navigation timeout per page", "45")
  .option("--limit <count>", "capture at most this many homepages")
  .option("--token <token>", "GitHub token (defaults to GITHUB_TOKEN or GH_TOKEN)")
  .option(
    "--hide <selector>",
    "CSS selector to hide before capture. Repeat to replace the default #modal. Pass none to hide nothing.",
    collect
  )
  .option("--full-page", "capture the full scrollable page")
  .option("--dry-run", "list homepages and exit without opening a browser")
  .addHelpText(
    "after",
    `
Examples:
  $ repo-screenshot -n lucwx
  $ repo-screenshot -n lucwx --dry-run
  $ GITHUB_TOKEN=... repo-screenshot -n lucwx -o ./shots
`
  );

function readOptions(argv) {
  program.parse(argv);

  const options = program.opts();
  return {
    name: options.name.trim(),
    outputDir: path.resolve(process.cwd(), options.output),
    delayMs: requireDelay(options.delay),
    quality: requireInteger(options.quality, "--quality", 1, 100),
    timeoutMs: requireInteger(options.timeout, "--timeout", 1, 180) * 1000,
    token: options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    hide: resolveHideSelectors(options.hide),
    limit: options.limit === undefined ? null : requireInteger(options.limit, "--limit", 1, 1000),
    fullPage: Boolean(options.fullPage),
    dryRun: Boolean(options.dryRun),
  };
}

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
    const filePath = path.join(
      directoryPath,
      `${directoryName}_${target.name}.jpeg`
    );
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

async function main(argv = process.argv) {
  const options = readOptions(argv);
  if (!options.name) {
    throw new Error("GitHub username is required");
  }

  const { repos, truncated } = await fetchUserRepos(options.name, {
    token: options.token,
  });
  if (truncated) {
    console.error(
      "Stopped after 1000 repositories. Some homepages may be missing."
    );
  }

  let sites = homepagesFromRepos(repos, options.name);
  console.error(`Found ${sites.length} homepage(s) for ${options.name}.`);
  if (options.limit !== null && sites.length > options.limit) {
    const verb = options.dryRun ? "Listing" : "Capturing";
    console.error(
      `${verb} the first ${options.limit} of ${sites.length} homepage(s).`
    );
    sites = sites.slice(0, options.limit);
  }

  if (options.dryRun) {
    for (const site of sites) console.log(site);
    return { saved: 0, failed: 0, sites };
  }

  if (sites.length === 0) return { saved: 0, failed: 0, sites };

  const puppeteer = require("puppeteer");
  const targets = viewportTargets(puppeteer);
  const browser = await puppeteer.launch({ headless: "new" });
  let saved = 0;
  let failed = 0;

  try {
    for (const url of sites) {
      for (const target of targets) {
        try {
          const filePath = await captureViewport(browser, url, target, options);
          console.log(filePath);
          saved += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Failed ${target.name} ${url}: ${message}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.error(`Saved ${saved} screenshot(s). Failed: ${failed}.`);
  if (failed > 0) process.exitCode = 1;
  return { saved, failed, sites };
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = { main };
