export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const RATE_WINDOW_MS = 60_000;
const RATE_FRESH_MS = 15_000;

/** Counts only: no names, titles or paths ever reach a progress line. */
export class Progress {
  private files = 0;
  private bytes = 0;
  private phase = "starting";
  private showRate = true;
  private phaseStartedAt: number;
  private phaseRecords = 0;
  private phaseExpected = 0;
  private step: { current: number; total: number; noun: string; firstCurrent: number; firstAt: number } | null = null;
  private samples: { at: number; records: number }[] = [];
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 3000
  ) {
    this.startedAt = now();
    this.phaseStartedAt = this.startedAt;
  }

  /** A new stretch of work. `showRate: false` for counting, where the number of records is not progress. */
  setPhase(name: string, opts: { showRate?: boolean } = {}): void {
    this.phase = name;
    this.showRate = opts.showRate ?? true;
    this.phaseStartedAt = this.now();
    this.phaseRecords = 0;
    this.phaseExpected = 0;
    this.step = null;
    this.samples = [];
  }

  /** `current` is the 1-based number of the step being worked on, for example matter 120 of 408. */
  setStep(current: number, total: number, noun: string): void {
    if (!this.step || this.step.noun !== noun) {
      this.step = { current, total, noun, firstCurrent: current, firstAt: this.now() };
    } else {
      this.step.current = current;
      this.step.total = total;
    }
  }

  addRecords(count: number): void {
    this.phaseRecords += count;
    if (count > 0) this.samples.push({ at: this.now(), records: this.phaseRecords });
  }

  addExpected(count: number): void {
    this.phaseExpected += count;
  }

  addFile(bytes: number): void {
    this.files++;
    this.bytes += bytes;
  }

  private recentRate(): number | null {
    if (!this.showRate) return null;
    const now = this.now();
    this.samples = this.samples.filter((s) => now - s.at <= RATE_WINDOW_MS);
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (now - last.at > RATE_FRESH_MS || last.at <= first.at) return null;
    return (last.records - first.records) / ((last.at - first.at) / 1000);
  }

  private remainingSeconds(): number | null {
    const now = this.now();
    if (this.step) {
      const completed = this.step.current - this.step.firstCurrent;
      if (completed <= 0 || this.step.total <= this.step.current) return null;
      return (((now - this.step.firstAt) / 1000) / completed) * (this.step.total - this.step.current);
    }
    if (this.phaseExpected > this.phaseRecords && this.phaseRecords > 0) {
      return (((now - this.phaseStartedAt) / 1000) / this.phaseRecords) * (this.phaseExpected - this.phaseRecords);
    }
    return null;
  }

  line(): string {
    let head = this.phase;
    if (this.step) head += `: ${this.step.noun} ${this.step.current} of ${this.step.total}`;
    else if (this.phaseExpected > 0) head += `: ${this.phaseRecords} of ${this.phaseExpected} records`;
    else if (this.phaseRecords > 0) head += `: ${this.phaseRecords} records`;

    const parts = [head];
    if (this.step && this.phaseRecords > 0) parts.push(`${this.phaseRecords} records`);
    if (this.files > 0) parts.push(`${this.files} files`, formatBytes(this.bytes));
    const rate = this.recentRate();
    if (rate !== null) parts.push(`${rate.toFixed(1)} records/s`);
    parts.push(`elapsed ${formatDuration((this.now() - this.startedAt) / 1000)}`);
    const remaining = this.remainingSeconds();
    if (remaining !== null) parts.push(`remaining ~${formatDuration(remaining)}`);
    return `[export] ${parts.join(" | ")}`;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.write(this.line()), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
