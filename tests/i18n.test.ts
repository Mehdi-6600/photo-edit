import { describe, expect, it } from "vitest";
import { dictionaries, parseLang, textDirection, translate } from "@/lib/i18n";
import { TASKS } from "@/lib/workflow";
import { TEAM_ROLES } from "@/lib/team";

describe("English and Persian copy", () => {
  it("has the same keys in both languages, with no empty strings", () => {
    const enKeys = Object.keys(dictionaries.en).sort();
    const faKeys = Object.keys(dictionaries.fa).sort();
    expect(faKeys).toEqual(enKeys);
    for (const key of enKeys) {
      expect(dictionaries.en[key as keyof typeof dictionaries.en].trim(), key).not.toBe("");
      expect(dictionaries.fa[key as keyof typeof dictionaries.fa].trim(), key).not.toBe("");
    }
  });

  it("translates every workflow task title and team role label", () => {
    for (const task of TASKS) {
      expect(task.title.fa.trim().length, task.id).toBeGreaterThan(0);
      expect(task.title.en.trim().length, task.id).toBeGreaterThan(0);
    }
    for (const role of TEAM_ROLES) {
      expect(dictionaries.fa[role.labelKey as keyof typeof dictionaries.fa], role.id).toBeTruthy();
    }
  });

  it("interpolates placeholders and falls back to English", () => {
    expect(translate("en", "runs.progress", { done: 2, total: 5 })).toBe("2 of 5 tasks done");
    expect(translate("fa", "runs.progress", { done: 2, total: 5 })).toContain("2");
  });

  it("uses right-to-left layout only for Persian", () => {
    expect(textDirection("fa")).toBe("rtl");
    expect(textDirection("en")).toBe("ltr");
    expect(parseLang("fa")).toBe("fa");
    expect(parseLang("de")).toBe("en");
    expect(parseLang(undefined)).toBe("en");
  });
});
