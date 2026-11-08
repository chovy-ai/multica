import { expect, test, type Browser } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

interface PerfHost { open(): void; bytes: number; requests(): string[] }
declare global {
  interface Window { __verifyPerf: PerfHost; __resourceLongTasks: { start: number; duration: number }[] }
}

async function measure(browser: Browser, origin: string, name: string, open: boolean, run: number) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${origin}/e2e/perf/conversation-resources.html?theme=light`);
    const input = page.getByRole("textbox", { name: "Main draft" });
    await input.focus(); await page.keyboard.type("warmup");
    await page.evaluate(() => {
      window.__resourceLongTasks = [];
      new PerformanceObserver(list => window.__resourceLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: "longtask", buffered: false });
    });
    const started = performance.now();
    if (open) await page.evaluate(() => window.__verifyPerf.open());
    const latencies: number[] = [];
    let rendered = false;
    do {
      const start = performance.now();
      await page.keyboard.type("x");
      rendered = await page.evaluate(() => new Promise<boolean>(resolve => requestAnimationFrame(() => resolve(Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]"))))));
      latencies.push(performance.now() - start);
    } while ((performance.now() - started < 5000 || (open && !rendered)) && performance.now() - started < 20000);
    const first = await page.evaluate(() => ({
      bytes: window.__verifyPerf.bytes, requests: window.__verifyPerf.requests(),
      heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
      mountedLines: document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0,
    }));
    let reachedEnd = false;
    if (open) {
      const scroller = page.locator(".conversation-change-code-view");
      if (await scroller.count()) {
        await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect.poll(() => page.locator("diffs-container").evaluate(element => element.shadowRoot?.textContent?.includes("// 19999"))).toBe(true);
        reachedEnd = true;
        await expect(input).toBeFocused();
      }
      await expect(page.getByRole("region", { name: "View changes" }).locator("diffs-container")).toBeVisible();
    }
    const final = await page.evaluate(() => ({
      longTasks: window.__resourceLongTasks,
      mountedLinesAtEnd: document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0,
      scrollHeight: document.querySelector(".conversation-change-code-view")?.scrollHeight ?? null,
    }));
    const sorted = [...latencies].sort((a, b) => a - b);
    await page.screenshot({ path: `.tmp/chov96-perf/${run}-${name}.png` });
    return { name, rendered, reachedEnd, samples: sorted.length, p95: sorted[Math.floor(sorted.length * .95)]!, max: sorted.at(-1)!, latencies, errors, ...first, ...final };
  } finally { await page.close(); }
}

for (let run = 1; run <= Number(process.env.RESOURCE_PERF_RUNS ?? 3); run++) {
  test(`budget diff keeps typing responsive and virtualizes the last line, run ${run}`, async ({ browser, baseURL }) => {
    const baselineURL = process.env.RESOURCE_PERF_BASELINE_URL;
    if (!baselineURL || !baseURL) throw new Error("Provide RESOURCE_PERF_BASELINE_URL and PLAYWRIGHT_BASE_URL for production builds");
    await mkdir(".tmp/chov96-perf", { recursive: true });
    const baseline = await measure(browser, baselineURL, "baseline", false, run);
    const closed = await measure(browser, baseURL, "closed", false, run);
    const current = await measure(browser, baseURL, "budget", true, run);
    const limit = baseline.max + Math.max(baseline.max * .2, 50);
    await writeFile(`.tmp/chov96-perf/run-${run}.json`, JSON.stringify({ baseline, closed, current, limit }, null, 2));
    expect(current.bytes).toBe(940000);
    expect(current.rendered).toBe(true);
    expect(current.errors).toEqual([]);
    expect(closed.requests.some(path => path.includes("/resources"))).toBe(false);
    expect(current.p95).toBeLessThanOrEqual(baseline.p95 + Math.max(baseline.p95 * .2, 50));
    expect(current.max, `maximum input-to-frame delay; baseline ${baseline.max.toFixed(2)} ms`).toBeLessThanOrEqual(limit);
    expect(current.reachedEnd).toBe(true);
    expect(current.mountedLines).toBeGreaterThan(0);
    expect(current.mountedLines).toBeLessThan(1000);
    expect(current.mountedLinesAtEnd).toBeLessThan(1000);
  });
}
