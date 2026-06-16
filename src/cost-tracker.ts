import os from 'os';
import fs from 'fs';
import path from 'path';

// Per-model API prices in USD per MILLION tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-06-16).
// NOTE: this machine runs on Amazon Bedrock, where the CLI reports costUSD: 0, so the
// figure derived here is an *API-equivalent estimate*, not the real Bedrock bill.
// Update this block when Anthropic changes published pricing.
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const MTOK = 1_000_000;

const PRICING: Record<string, ModelPrice> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

// Fallback for unknown / unlisted models: Sonnet rates.
const DEFAULT_PRICE: ModelPrice = PRICING['claude-sonnet-4-6'];

export interface CostTotals {
  total: number;
  perSession: Record<string, number>;
}

/** Current calendar month as a "YYYY-MM" prefix (local time). */
function currentMonthPrefix(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

class CostTracker {
  private home: string;
  /** pid → sessionId, cached (stable for a session's lifetime). */
  private sessionIdByPid = new Map<number, string>();
  /** sessionId → transcript path, cached once located. */
  private transcriptBySession = new Map<string, string>();
  /** Cache for monthlyCost: {result, prefix, expiresAt}. Avoids re-scanning all transcripts on every 5s tick. */
  private monthlyCache: { result: number; prefix: string; expiresAt: number } | null = null;
  private static MONTHLY_TTL_MS = 60_000;

  constructor(home: string = os.homedir()) {
    this.home = home;
  }

  /** Read ~/.claude/sessions/{pid}.json to map a live PTY pid to its CLI sessionId. */
  private resolveSessionId(pid: number): string | null {
    const cached = this.sessionIdByPid.get(pid);
    if (cached) return cached;
    try {
      const raw = fs.readFileSync(path.join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf-8');
      const sessionId = JSON.parse(raw).sessionId;
      if (typeof sessionId === 'string') {
        this.sessionIdByPid.set(pid, sessionId);
        return sessionId;
      }
    } catch { /* session file not written yet, or unreadable */ }
    return null;
  }

  /** Locate ~/.claude/projects/<encoded-cwd>/{sessionId}.jsonl by globbing on the id. */
  private transcriptPath(sessionId: string): string | null {
    const cached = this.transcriptBySession.get(sessionId);
    if (cached) return cached;
    const projectsDir = path.join(this.home, '.claude', 'projects');
    let dirs: string[];
    try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        this.transcriptBySession.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Sum API-equivalent cost (USD) over assistant messages in a transcript file.
   *
   * When `monthPrefix` (e.g. "2026-06") is given, only lines whose ISO `timestamp`
   * falls in that calendar month are counted — used for the monthly/billing view.
   *
   * `seen` deduplicates by `message.id`. The CLI logs each assistant message
   * multiple times (streaming/partial events) with identical usage, AND copies
   * prior messages into new files on resume/fork — so naive summing double-counts
   * (~2×). `message.id` is the API's per-response id, unique and stable across all
   * those copies. (NB: older transcripts also carried `requestId`, but June+ files
   * dropped it — so we must NOT require it, or dedup silently no-ops.) Passing a
   * shared Set across files (as monthlyCost does) dedups both within and across
   * transcripts, matching ccusage's method. When omitted, a per-call Set is used
   * (dedups within this single file only).
   */
  costForTranscript(filePath: string, monthPrefix?: string, seen: Set<string> = new Set()): number {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return 0; }
    let total = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (monthPrefix) {
        const ts = entry?.timestamp;
        if (typeof ts !== 'string' || !ts.startsWith(monthPrefix)) continue;
      }
      const message = entry?.message;
      const usage = message?.usage;
      if (!usage) continue;
      const model: string = message.model;
      if (!model || model === '<synthetic>') continue;

      // Skip if we've already billed this API response. Key on message.id (the
      // API's per-response id). When it's absent we can't dedup, so count the line.
      const msgId = message.id;
      if (msgId) {
        if (seen.has(msgId)) continue;
        seen.add(msgId);
      }
      const price = PRICING[model] ?? DEFAULT_PRICE;

      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      // Split cache-creation into 5m / 1h writes when the CLI provides the breakdown;
      // otherwise treat all cache-creation as 5m writes.
      const write5m = usage.cache_creation?.ephemeral_5m_input_tokens
        ?? usage.cache_creation_input_tokens ?? 0;
      const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;

      total += (
        input * price.input +
        output * price.output +
        cacheRead * price.cacheRead +
        write5m * price.cacheWrite5m +
        write1h * price.cacheWrite1h
      ) / MTOK;
    }
    return total;
  }

  /** Cost for a single CLI sessionId (0 if its transcript can't be found). */
  costForSession(sessionId: string): number {
    const file = this.transcriptPath(sessionId);
    return file ? this.costForTranscript(file) : 0;
  }

  /**
   * Sum API-equivalent cost across EVERY transcript in ~/.claude/projects, counting
   * only messages dated in the given month ("YYYY-MM", defaults to the current month).
   * This is the billing-period view — independent of which sessions are open here.
   * Result is cached for MONTHLY_TTL_MS to avoid re-scanning on every 5s tick.
   */
  monthlyCost(monthPrefix: string = currentMonthPrefix()): number {
    const now = Date.now();
    if (this.monthlyCache && this.monthlyCache.prefix === monthPrefix && now < this.monthlyCache.expiresAt) {
      return this.monthlyCache.result;
    }
    const projectsDir = path.join(this.home, '.claude', 'projects');
    let dirs: string[];
    try { dirs = fs.readdirSync(projectsDir); } catch { return 0; }
    let total = 0;
    // One Set across all files so a message duplicated by a resume/fork (copied
    // into another transcript) is billed once, not once per file it appears in.
    const seen = new Set<string>();
    for (const dir of dirs) {
      const projectPath = path.join(projectsDir, dir);
      let files: string[];
      try { files = fs.readdirSync(projectPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        total += this.costForTranscript(path.join(projectPath, file), monthPrefix, seen);
      }
    }
    this.monthlyCache = { result: total, prefix: monthPrefix, expiresAt: now + CostTracker.MONTHLY_TTL_MS };
    return total;
  }

  /**
   * Total API-equivalent cost across the given live PTY pids. Maps each pid to its
   * sessionId, de-dupes (a restored --continue session keeps its id), and sums.
   */
  totalCost(pids: number[]): CostTotals {
    const perSession: Record<string, number> = {};
    const seen = new Set<string>();
    for (const pid of pids) {
      const sessionId = this.resolveSessionId(pid);
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      perSession[sessionId] = this.costForSession(sessionId);
    }
    const total = Object.values(perSession).reduce((a, b) => a + b, 0);
    return { total, perSession };
  }
}

export default CostTracker;
