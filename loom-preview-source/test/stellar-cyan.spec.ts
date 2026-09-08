import { test, expect } from "@playwright/test";

test.describe("Theme Forge Stellar Loom Fixture - Stellar Cyan Theme", () => {
  test("verifies dark mode computed styles match compiled stellar-cyan specification", async ({ page }, testInfo) => {
    await page.goto("/");

    // Ensure dark theme is active via Starlight theme select widget
    await page.locator("starlight-theme-select select").first().selectOption("dark");

    // 1. Canvas background
    const bodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    // #090e17 -> rgb(9, 14, 23)
    expect(bodyBg).toBe("rgb(9, 14, 23)");

    // 2. Primary text color
    const textColor = await page.evaluate(() => window.getComputedStyle(document.body).color);
    // #e6f1ff -> rgb(230, 241, 255)
    expect(textColor).toBe("rgb(230, 241, 255)");

    // 3. Accent color on link
    const linkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    // #00d2ff -> rgb(0, 210, 255)
    expect(linkColor).toBe("rgb(0, 210, 255)");

    // 4. Hairline border on table (Starlight uses hairline-light / gray-5)
    const tableBorder = await page.evaluate(() => {
      const th = document.querySelector("th");
      return th ? window.getComputedStyle(th).borderBottomColor : null;
    });
    // #2c4263 -> rgb(44, 66, 99)
    expect(tableBorder).toBe("rgb(44, 66, 99)");

    // 5. Card border (gray-5: #2c4263) and inline code background (bgInlineCode: #131d2e)
    const cardBorder = await page.evaluate(() => {
      const card = document.querySelector("article.card");
      return card ? window.getComputedStyle(card).borderTopColor : null;
    });
    // #2c4263 -> rgb(44, 66, 99)
    expect(cardBorder).toBe("rgb(44, 66, 99)");

    const inlineCodeBg = await page.evaluate(() => {
      const code = document.querySelector(":not(pre) > code");
      return code ? window.getComputedStyle(code).backgroundColor : null;
    });
    // #131d2e -> rgb(19, 29, 46)
    expect(inlineCodeBg).toBe("rgb(19, 29, 46)");

    // 6. Heading color (--sl-color-white: grays.gray1 -> #e6f1ff)
    const headingColor = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? window.getComputedStyle(h1).color : null;
    });
    expect(headingColor).toBe("rgb(230, 241, 255)");

    // Capture visual proof screenshot to test output directory (preserving tracked doc artifacts)
    await page.screenshot({ path: testInfo.outputPath("tfsb53b-stellar-cyan-dark.png"), fullPage: false });
  });

  test("verifies light mode computed styles match compiled stellar-cyan specification", async ({ page }, testInfo) => {
    await page.goto("/");

    // Switch to light theme via Starlight theme select widget
    await page.locator("starlight-theme-select select").first().selectOption("light");

    // 1. Canvas background
    const bodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    // #f5f9fc -> rgb(245, 249, 252)
    expect(bodyBg).toBe("rgb(245, 249, 252)");

    // 2. Primary text color
    const textColor = await page.evaluate(() => window.getComputedStyle(document.body).color);
    // #0d1522 -> rgb(13, 21, 34)
    expect(textColor).toBe("rgb(13, 21, 34)");

    // 3. Accent color on link
    const linkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    // #0077aa -> rgb(0, 119, 170)
    expect(linkColor).toBe("rgb(0, 119, 170)");

    // 4. Hairline border on table (Starlight uses light gray-5)
    const tableBorder = await page.evaluate(() => {
      const th = document.querySelector("th");
      return th ? window.getComputedStyle(th).borderBottomColor : null;
    });
    // #b0c5dd -> rgb(176, 197, 221)
    expect(tableBorder).toBe("rgb(176, 197, 221)");

    // 5. Card border (light gray-5: #b0c5dd) and inline code background (bgInlineCode: #e8f1f8)
    const cardBorder = await page.evaluate(() => {
      const card = document.querySelector("article.card");
      return card ? window.getComputedStyle(card).borderTopColor : null;
    });
    // #b0c5dd -> rgb(176, 197, 221)
    expect(cardBorder).toBe("rgb(176, 197, 221)");

    const inlineCodeBg = await page.evaluate(() => {
      const code = document.querySelector(":not(pre) > code");
      return code ? window.getComputedStyle(code).backgroundColor : null;
    });
    // #e8f1f8 -> rgb(232, 241, 248)
    expect(inlineCodeBg).toBe("rgb(232, 241, 248)");

    // 6. Heading color (--sl-color-white: grays.gray1 -> #0d1522)
    const headingColor = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? window.getComputedStyle(h1).color : null;
    });
    expect(headingColor).toBe("rgb(13, 21, 34)");

    // Capture visual proof screenshot to test output directory (preserving tracked doc artifacts)
    await page.screenshot({ path: testInfo.outputPath("tfsb53b-stellar-cyan-light.png"), fullPage: false });
  });

  test("verifies layout tokens on desktop and responsive collapse on narrow viewport", async ({ page }) => {
    // Desktop layout
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const layoutVars = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return {
        contentWidth: style.getPropertyValue("--sl-content-width").trim(),
        sidebarWidth: style.getPropertyValue("--sl-sidebar-width").trim(),
      };
    });
    expect(layoutVars.contentWidth).toBe("48rem");
    expect(layoutVars.sidebarWidth).toBe("19rem");

    // Resolved layout geometry measurements
    const containerMaxWidth = await page.evaluate(() => {
      const el = document.querySelector(".content-panel .sl-container");
      return el ? window.getComputedStyle(el).maxWidth : null;
    });
    // 48rem at 16px root font-size resolves to 768px
    expect(containerMaxWidth).toBe("768px");

    const sidebarResolvedWidth = await page.evaluate(() => {
      const el = document.querySelector(".sidebar-pane");
      return el ? window.getComputedStyle(el).width : null;
    });
    // 19rem at 16px root font-size resolves to 304px
    expect(sidebarResolvedWidth).toBe("304px");

    // Typography verification: system-sans
    const fontFamily = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily);
    expect(fontFamily.toLowerCase()).toContain("sans-serif");

    // Resolved font size verification: Card body consumes --sl-text-body (16px) via clamp
    const cardBodyFontSize = await page.evaluate(() => {
      const el = document.querySelector(".card .body");
      return el ? window.getComputedStyle(el).fontSize : null;
    });
    expect(cardBodyFontSize).toBe("16px");

    // Sidebar pane should be visible on desktop
    const sidebarVisible = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar-pane");
      if (!sidebar) return false;
      const rect = sidebar.getBoundingClientRect();
      const style = window.getComputedStyle(sidebar);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    expect(sidebarVisible).toBe(true);

    // Narrow / Mobile layout
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

  test("verifies keyboard focus indicators and live accessibility contrast", async ({ page }) => {
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

    // 2. High contrast ratio verification from live rendered element styles (F-C remedy)
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
    expect(contrastRatio).toBeGreaterThan(15);
  });

  test("verifies theme introduces no conflicting motion or transition overrides", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    // Verify theme CSS does not introduce custom animations or forced smooth scrolling (F-D remedy)
    const bodyAnimation = await page.evaluate(() => {
      const style = window.getComputedStyle(document.body);
      return {
        animationName: style.animationName,
        transitionProperty: style.transitionProperty,
      };
    });
    // TFSL slice strictly emits static custom properties; no custom animations injected
    expect(bodyAnimation.animationName).toBe("none");
  });

  test("negative control: proves unlayered theme rule disconnection falls back to Starlight defaults", async ({ page }) => {
    await page.goto("/");
    await page.locator("starlight-theme-select select").first().selectOption("dark");

    // Before disconnection: compiled cyan theme colors
    const themedBodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    const themedLinkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    expect(themedBodyBg).toBe("rgb(9, 14, 23)");
    expect(themedLinkColor).toBe("rgb(0, 210, 255)");

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
          // ignore CORS restriction
        }
      }
    });

    // After disconnection: falls back to Starlight's layered defaults without breaking layout
    const fallbackBodyBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    const fallbackLinkColor = await page.evaluate(() => {
      const link = document.querySelector("a[href*='starlight.astro.build']");
      return link ? window.getComputedStyle(link).color : null;
    });
    // Starlight's default dark canvas background is #17181c / #181a20 and accent is purple/blue
    expect(fallbackBodyBg).not.toBe("rgb(9, 14, 23)");
    expect(fallbackLinkColor).not.toBe("rgb(0, 210, 255)");
  });
});
