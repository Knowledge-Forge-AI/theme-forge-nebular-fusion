import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const studio = readFileSync("src/styles/studio.css", "utf8");
const vector = readFileSync("src/features/vector-graphics/styles.css", "utf8");

function rule(source: string, selector: string): string {
  const start = source.indexOf(selector + " {");
  if (start < 0) throw new Error("Required selected-state rule is missing");
  return source.slice(start, source.indexOf("}", start));
}

describe("application selection roles", () => {
  it.each([
    [studio, ".destination-tab.active"],
    [studio, ".button-group button.active"],
    [vector, ".layer-item.selected"],
    [vector, ".packet-item.selected"],
  ])("retains a shape cue and readable fill/text pairing for selected rule %#", (source, selector) => {
    const selected = rule(source, selector);
    expect(selected).toMatch(/box-shadow:\s*inset[^;]*var\(--ring/);
    expect(selected).toMatch(/font-weight:\s*700/);
    expect(selected).toMatch(/background:\s*var\(--tf-appearance-selection,/);
    expect(selected).toMatch(/color:\s*var\(--tf-appearance-selection-text,/);
  });

  it("uses the action foreground role for active tab text instead of the selection fill", () => {
    const active = rule(studio, ".tab-button.active");
    expect(active).toMatch(/color:\s*var\(--primary,/);
    expect(active).not.toMatch(/color:\s*var\(--tf-appearance-selection,/);
  });
});
