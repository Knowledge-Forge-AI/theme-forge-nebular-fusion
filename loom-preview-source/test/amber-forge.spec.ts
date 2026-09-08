import { test, expect } from "@playwright/test";

test.describe("Theme Forge Stellar Loom Fixture - Amber Forge Theme", () => {
  test("verifies dark mode computed styles match compiled amber-forge specification", async ({ page }, testInfo) => {
    await page.goto("/");

    // Ensure dark theme is active via Starlight theme select widget
    await page.locator("starlight-theme-select select").first().selectOption("dark");

    // 1. Canvas background: #181512 -> rgb(24, 21, 18)
    const bodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(24, 21, 18)");

    // 2. Primary text color: #fef3c7 -> rgb(254, 243, 199)
    const textColor = await page.evaluate(() => window.getComputedStyle(document.body).color);
    expect(textColor).toBe("rgb(254, 243, 199)");

    // 3. Accent color on link: #f59e0b -> rgb(245, 158, 11)
    const linkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    expect(linkColor).toBe("rgb(245, 158, 11)");

    // 4. Hairline border on table (Starlight uses hairline-light / gray-5: #4d4332)
    const tableBorder = await page.evaluate(() => {
      const th = document.querySelector("th");
      return th ? window.getComputedStyle(th).borderBottomColor : null;
    });
    expect(tableBorder).toBe("rgb(77, 67, 50)");

    // 5. Card border and inline code background: #2a241e -> rgb(42, 36, 30)
    const inlineCodeBg = await page.evaluate(() => {
      const code = document.querySelector(":not(pre) > code");
      return code ? window.getComputedStyle(code).backgroundColor : null;
    });
    expect(inlineCodeBg).toBe("rgb(42, 36, 30)");

    // 6. Heading color (--sl-color-white: grays.gray1 -> #fef3c7)
    const headingColor = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? window.getComputedStyle(h1).color : null;
    });
    expect(headingColor).toBe("rgb(254, 243, 199)");

    // Capture visual proof screenshot to test output directory (preserving tracked doc artifacts)
    await page.screenshot({ path: testInfo.outputPath("tfsb53b-amber-forge-dark.png"), fullPage: false });
  });

  test("verifies light mode computed styles match compiled amber-forge specification", async ({ page }, testInfo) => {
    await page.goto("/");

    // Switch to light theme via Starlight theme select widget
    await page.locator("starlight-theme-select select").first().selectOption("light");

    // 1. Canvas background: #fffbf5 -> rgb(255, 251, 245)
    const bodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(255, 251, 245)");

    // 2. Primary text color: #261c14 -> rgb(38, 28, 20)
    const textColor = await page.evaluate(() => window.getComputedStyle(document.body).color);
    expect(textColor).toBe("rgb(38, 28, 20)");

    // 3. Accent color on link: #b45309 -> rgb(180, 83, 9)
    const linkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    expect(linkColor).toBe("rgb(180, 83, 9)");

    // 4. Hairline border on table (Starlight uses hairline-light / light gray-5: #ccbba8)
    const tableBorder = await page.evaluate(() => {
      const th = document.querySelector("th");
      return th ? window.getComputedStyle(th).borderBottomColor : null;
    });
    expect(tableBorder).toBe("rgb(204, 187, 168)");

    // 5. Inline code background: #f5eee1 -> rgb(245, 238, 225)
    const inlineCodeBg = await page.evaluate(() => {
      const code = document.querySelector(":not(pre) > code");
      return code ? window.getComputedStyle(code).backgroundColor : null;
    });
    expect(inlineCodeBg).toBe("rgb(245, 238, 225)");

    // 6. Heading color (--sl-color-white: grays.gray1 -> #261c14)
    const headingColor = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? window.getComputedStyle(h1).color : null;
    });
    expect(headingColor).toBe("rgb(38, 28, 20)");

    // Capture visual proof screenshot to test output directory (preserving tracked doc artifacts)
    await page.screenshot({ path: testInfo.outputPath("tfsb53b-amber-forge-light.png"), fullPage: false });
  });

  test("verifies amber-forge typography and layout tokens", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    // Typography: system-serif body font
    const fontFamily = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily);
    expect(fontFamily.toLowerCase()).toContain("serif");

    // Layout: content width 52rem, sidebar width 20rem
    const layoutVars = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return {
        contentWidth: style.getPropertyValue("--sl-content-width").trim(),
        sidebarWidth: style.getPropertyValue("--sl-sidebar-width").trim(),
      };
    });
    expect(layoutVars.contentWidth).toBe("52rem");
    expect(layoutVars.sidebarWidth).toBe("20rem");

    // Resolved layout geometry measurements
    const containerMaxWidth = await page.evaluate(() => {
      const el = document.querySelector(".content-panel .sl-container");
      return el ? window.getComputedStyle(el).maxWidth : null;
    });
    // 52rem at 16px root font-size resolves to 832px
    expect(containerMaxWidth).toBe("832px");

    const sidebarResolvedWidth = await page.evaluate(() => {
      const el = document.querySelector(".sidebar-pane");
      return el ? window.getComputedStyle(el).width : null;
    });
    // 20rem at 16px root font-size resolves to 320px
    expect(sidebarResolvedWidth).toBe("320px");

    // Resolved font size verification: Card body consumes --sl-text-body (17px) via clamp
    const cardBodyFontSize = await page.evaluate(() => {
      const el = document.querySelector(".card .body");
      return el ? window.getComputedStyle(el).fontSize : null;
    });
    expect(cardBodyFontSize).toBe("17px");

    // Sidebar pane should be visible on desktop
    const sidebarVisible = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar-pane");
      if (!sidebar) return false;
      const rect = sidebar.getBoundingClientRect();
      const style = window.getComputedStyle(sidebar);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    expect(sidebarVisible).toBe(true);

    // Narrow / Mobile layout responsive collapse
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();

    // On narrow viewport, mobile menu toggle button exists and is visible
    const mobileMenuBtnVisible = await page.evaluate(() => {
      const btn = document.querySelector("button.sl-menu-button");
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      return rect.width > 0 && rect.height > 0 && style.display !== "none";
    });
    expect(mobileMenuBtnVisible).toBe(true);
  });

  test("verifies keyboard focus indicators on skip link in amber-forge", async ({ page }) => {
    await page.goto("/");

    // 1. Tab to the skip link
    await page.keyboard.press("Tab");
    const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
    expect(activeTagName).toBe("A");

    const isSkipLink = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? (el.getAttribute("href") === "#_top" || el.classList.contains("sl-skip-link")) : false;
    });
    expect(isSkipLink).toBe(true);

    // Verify focus indicator is visible
    const focusOutline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = window.getComputedStyle(el);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });
    expect(focusOutline?.outlineStyle).not.toBe("none");
  });

  test("verifies accessibility contrast on live amber-forge elements", async ({ page }) => {
    await page.goto("/");

    const contrastRatio = await page.evaluate(() => {
      function parseRgb(colorStr: string): [number, number, number] {
        const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return [0, 0, 0];
        return [Number(match[1]), Number(match[2]), Number(match[3])];
      }
      function luminance(r: number, g: number, b: number) {
        const a = [r, g, b].map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }
      const bodyStyle = window.getComputedStyle(document.body);
      const [r1, g1, b1] = parseRgb(bodyStyle.color);
      const [r2, g2, b2] = parseRgb(bodyStyle.backgroundColor);
      const l1 = luminance(r1, g1, b1);
      const l2 = luminance(r2, g2, b2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    });
    // Amber text (#fef3c7) on amber bg (#181512) has contrast ratio > 12:1 (exceeds WCAG AAA 7:1)
    expect(contrastRatio).toBeGreaterThan(12);
  });

  test("negative control: proves unlayered theme rule disconnection falls back to Starlight defaults and differs from cyan", async ({ page }) => {
    await page.goto("/");
    await page.locator("starlight-theme-select select").first().selectOption("dark");

    // Before disconnection: amber theme values
    const themedBodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    const themedLinkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });

    // Differ from stellar-cyan theme values (#090e17 = rgb(9, 14, 23), #00d2ff = rgb(0, 210, 255))
    expect(themedBodyBg).toBe("rgb(24, 21, 18)");
    expect(themedLinkColor).toBe("rgb(245, 158, 11)");
    expect(themedBodyBg).not.toBe("rgb(9, 14, 23)");
    expect(themedLinkColor).not.toBe("rgb(0, 210, 255)");

    // Disconnect unlayered theme CSSRules live in browser
    await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
            const rule = sheet.cssRules[i];
            if (rule instanceof CSSStyleRule && (rule.selectorText.includes(":root") || rule.selectorText.includes("::backdrop"))) {
              sheet.deleteRule(i);
            }
          }
        } catch {
          // ignore CORS
        }
      }
    });

    // After disconnection: falls back to Starlight's layered defaults
    const fallbackBodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    const fallbackLinkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    expect(fallbackBodyBg).not.toBe("rgb(24, 21, 18)");
    expect(fallbackLinkColor).not.toBe("rgb(245, 158, 11)");
  });
});
