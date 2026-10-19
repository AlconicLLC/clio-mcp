import { describe, it, expect } from "vitest";
import { Progress, formatDuration, formatBytes } from "../progress.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("Progress line", () => {
  it("shows the phase and a step counter with ids and counts only", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("documents");
    p.setStep(120, 408, "matter");
    expect(p.line()).toBe("[export] documents: matter 120 of 408 | elapsed 00:00:00");
  });

  it("estimates the time left from the steps finished in this run, not from the matter number", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("documents");
    p.setStep(101, 400, "matter");
    c.advance(10_000);
    p.setStep(111, 400, "matter");
    expect(p.line()).toContain("matter 111 of 400");
    expect(p.line()).toContain("remaining ~00:04:49");
  });

  it("never shows records/s or 'records 0' while matters go by without new records", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("documents");
    for (let matter = 1; matter <= 40; matter++) {
      p.setStep(matter, 408, "matter");
      c.advance(15_000);
      const line = p.line();
      expect(line).not.toMatch(/records\/s/);
      expect(line).not.toMatch(/records 0|\b0 records/);
    }
    expect(p.line()).toContain("matter 40 of 408");
  });

  it("shows the speed while records are arriving and drops it once they stop", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("contacts");
    p.addExpected(1000);
    p.addRecords(200);
    c.advance(2000);
    p.addRecords(200);
    c.advance(2000);
    p.addRecords(200);
    expect(p.line()).toContain("contacts: 600 of 1000 records");
    expect(p.line()).toContain("100.0 records/s");
    expect(p.line()).toContain("remaining ~00:00:03");

    c.advance(20_000);
    expect(p.line()).not.toContain("records/s");
  });

  it("does not show a speed in counting phases", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("counting documents", { showRate: false });
    p.setStep(3, 408, "matter");
    p.addRecords(50);
    c.advance(1000);
    p.addRecords(50);
    expect(p.line()).toContain("counting documents: matter 3 of 408");
    expect(p.line()).not.toContain("records/s");
  });

  it("starts a phase from zero and shows file totals only once there are files", () => {
    const c = clock();
    const p = new Progress(() => {}, c.now);
    p.setPhase("users");
    p.addRecords(5);
    p.setPhase("documents");
    expect(p.line()).toBe("[export] documents | elapsed 00:00:00");
    p.addFile(2048);
    expect(p.line()).toContain("1 files | 2.0 KB");
  });

  it("writes a line on its timer", async () => {
    const lines: string[] = [];
    const p = new Progress((l) => lines.push(l), Date.now, 5);
    p.setPhase("matters");
    p.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    p.stop();
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^\[export\] matters/);
  });

  it("formats durations and sizes", () => {
    expect(formatDuration(3725)).toBe("01:02:05");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
