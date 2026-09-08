import { test, expect } from "@playwright/test";
import {
  compileTheme,
  STELLAR_CYAN_EXAMPLE,
  AMBER_FORGE_EXAMPLE,
} from "../../dist/index.js";

test.describe("Starlight Fixture Live Theme Injection & Style Fidelity", () => {
  const cyanCompilation = compileTheme(STELLAR_CYAN_EXAMPLE);
  const amberCompilation = compileTheme(AMBER_FORGE_EXAMPLE);

  test("verifies live injected cyan theme matches exact computed styles of built cyan fixture", async ({ page }) => {
    await page.goto("/preview/");

    // Send postMessage to apply cyan theme in dark mode
    await page.evaluate((css) => {
      window.postMessage({ type: "tfsl:apply-theme", css, mode: "dark", revision: 1 }, "*");
    }, cyanCompilation.css);

    // Wait for theme application
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForFunction(() => !!document.getElementById("tfsl-injected-theme"));

    // 1. Canvas background: #090e17 -> rgb(9, 14, 23)
    const bodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(9, 14, 23)");

    // 2. Primary text color: #e6f1ff -> rgb(230, 241, 255)
    const textColor = await page.evaluate(() => window.getComputedStyle(document.body).color);
    expect(textColor).toBe("rgb(230, 241, 255)");

    // 3. Accent link color: #00d2ff -> rgb(0, 210, 255)
    const linkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    expect(linkColor).toBe("rgb(0, 210, 255)");

    // 4. Hairline border: #2c4263 -> rgb(44, 66, 99)
    const tableBorder = await page.evaluate(() => {
      const th = document.querySelector("th");
      return th ? window.getComputedStyle(th).borderBottomColor : null;
    });
    expect(tableBorder).toBe("rgb(44, 66, 99)");

    // 5. Card border and inline code background
    const cardBorder = await page.evaluate(() => {
      const card = document.querySelector("article.card");
      return card ? window.getComputedStyle(card).borderTopColor : null;
    });
    expect(cardBorder).toBe("rgb(44, 66, 99)");

    const inlineCodeBg = await page.evaluate(() => {
      const code = document.querySelector(":not(pre) > code");
      return code ? window.getComputedStyle(code).backgroundColor : null;
    });
    expect(inlineCodeBg).toBe("rgb(19, 29, 46)");

    // 6. Test light mode switch via live message
    await page.evaluate((css) => {
      window.postMessage({ type: "tfsl:apply-theme", css, mode: "light", revision: 2 }, "*");
    }, cyanCompilation.css);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Light canvas background: #f5f9fc -> rgb(245, 249, 252)
    const lightBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(lightBg).toBe("rgb(245, 249, 252)");

    // Light text color: #0d1522 -> rgb(13, 21, 34)
    const lightText = await page.evaluate(() => window.getComputedStyle(document.body).color);
    expect(lightText).toBe("rgb(13, 21, 34)");
  });

  test("verifies live switching from cyan to amber dynamically updates tokens", async ({ page }) => {
    await page.goto("/preview/");

    // Apply cyan
    await page.evaluate((css) => {
      window.postMessage({ type: "tfsl:apply-theme", css, mode: "dark", revision: 1 }, "*");
    }, cyanCompilation.css);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(9, 14, 23)");

    // Switch to amber: dark bg #181512 -> rgb(24, 21, 18)
    await page.evaluate((css) => {
      window.postMessage({ type: "tfsl:apply-theme", css, mode: "dark", revision: 2 }, "*");
    }, amberCompilation.css);
    const amberBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(amberBg).toBe("rgb(24, 21, 18)");

    const amberText = await page.evaluate(() => window.getComputedStyle(document.body).color);
    // #fef3c7 -> rgb(254, 243, 199)
    expect(amberText).toBe("rgb(254, 243, 199)");
  });

  test("discriminating negative control: disconnected theme style reverts to base defaults", async ({ page }) => {
    await page.goto("/preview/");

    // Apply cyan
    await page.evaluate((css) => {
      window.postMessage({ type: "tfsl:apply-theme", css, mode: "dark", revision: 1 }, "*");
    }, cyanCompilation.css);
    expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(9, 14, 23)");

    // Disconnect/remove theme style element
    await page.evaluate(() => {
      const style = document.getElementById("tfsl-injected-theme");
      style?.remove();
    });

    // Default Starlight dark background is NOT cyan's rgb(9, 14, 23)
    const disconnectedBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(disconnectedBg).not.toBe("rgb(9, 14, 23)");
  });

  test("confines navigation: external link clicks are intercepted and prevented", async ({ page }) => {
    await page.goto("/preview/");

    const currentUrl = page.url();
    // Click external Starlight docs link
    const externalLink = page.locator("a[href*='starlight.astro.build']").first();
    await externalLink.click();

    // Page URL must not change to external host
    expect(page.url()).toBe(currentUrl);
  });
});
