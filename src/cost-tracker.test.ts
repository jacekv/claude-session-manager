import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import CostTracker from './cost-tracker';

// Builds a throwaway fake ~/.claude tree so the tracker reads real files.
function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracker-'));
}

function writeSessionFile(home: string, pid: number, sessionId: string): void {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/x' }));
}

function writeTranscript(home: string, encodedCwd: string, sessionId: string, lines: object[]): void {
  const dir = path.join(home, '.claude', 'projects', encodedCwd);
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);
}

const assistant = (model: string, usage: object) => ({ type: 'assistant', message: { model, usage } });
const dated = (timestamp: string, model: string, usage: object) =>
  ({ type: 'assistant', timestamp, message: { model, usage } });
// With a message id, so duplicate-line dedup applies.
const withId = (id: string, model: string, usage: object, timestamp?: string) =>
  ({ type: 'assistant', timestamp, message: { id, model, usage } });

describe('CostTracker', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('prices output tokens at the published opus rate ($25/MTok)', () => {
    writeTranscript(home, '-proj', 'sid1', [
      assistant('claude-opus-4-8', { input_tokens: 0, output_tokens: 1_000_000 }),
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sid1')).toBeCloseTo(25, 6);
  });

  it('sums input, output, cache-read and cache-write at per-model rates', () => {
    // Sonnet 4.6: input 3, output 15, cacheRead 0.3, 5m write 3.75 (all per MTok).
    writeTranscript(home, '-proj', 'sid2', [
      assistant('claude-sonnet-4-6', {
        input_tokens: 1_000_000,           // $3
        output_tokens: 1_000_000,          // $15
        cache_read_input_tokens: 1_000_000, // $0.30
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 }, // $3.75
      }),
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sid2')).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });

  it('bills 1h cache writes at the higher rate', () => {
    // Opus 4.8: 5m write 6.25, 1h write 10 (per MTok).
    writeTranscript(home, '-proj', 'sid3', [
      assistant('claude-opus-4-8', {
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sid3')).toBeCloseTo(6.25 + 10, 6);
  });

  it('falls back to flat cache_creation_input_tokens as 5m writes when no breakdown', () => {
    writeTranscript(home, '-proj', 'sid4', [
      assistant('claude-opus-4-8', { cache_creation_input_tokens: 1_000_000 }), // 6.25
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sid4')).toBeCloseTo(6.25, 6);
  });

  it('skips <synthetic> and unparseable lines', () => {
    const dir = path.join(home, '.claude', 'projects', '-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sid5.jsonl'),
      JSON.stringify(assistant('<synthetic>', { output_tokens: 1_000_000 })) + '\n' +
      'not json at all\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
      JSON.stringify(assistant('claude-opus-4-8', { output_tokens: 1_000_000 })) + '\n');
    const t = new CostTracker(home);
    expect(t.costForSession('sid5')).toBeCloseTo(25, 6); // only the real opus line counts
  });

  it('prices unknown models at the Sonnet fallback rate', () => {
    writeTranscript(home, '-proj', 'sid6', [
      assistant('claude-future-9', { output_tokens: 1_000_000 }), // sonnet output = 15
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sid6')).toBeCloseTo(15, 6);
  });

  it('returns 0 for a session with no transcript', () => {
    const t = new CostTracker(home);
    expect(t.costForSession('missing')).toBe(0);
  });

  it('maps pids -> sessionId -> cost and totals across sessions', () => {
    writeSessionFile(home, 111, 'sidA');
    writeSessionFile(home, 222, 'sidB');
    writeTranscript(home, '-a', 'sidA', [assistant('claude-opus-4-8', { output_tokens: 1_000_000 })]); // 25
    writeTranscript(home, '-b', 'sidB', [assistant('claude-sonnet-4-6', { output_tokens: 1_000_000 })]); // 15
    const t = new CostTracker(home);
    const { total, perSession } = t.totalCost([111, 222]);
    expect(perSession['sidA']).toBeCloseTo(25, 6);
    expect(perSession['sidB']).toBeCloseTo(15, 6);
    expect(total).toBeCloseTo(40, 6);
  });

  it('de-dupes pids that resolve to the same sessionId', () => {
    writeSessionFile(home, 111, 'dup');
    writeSessionFile(home, 222, 'dup');
    writeTranscript(home, '-a', 'dup', [assistant('claude-opus-4-8', { output_tokens: 1_000_000 })]); // 25
    const t = new CostTracker(home);
    const { total } = t.totalCost([111, 222]);
    expect(total).toBeCloseTo(25, 6); // counted once, not 50
  });

  it('ignores pids with no session file', () => {
    const t = new CostTracker(home);
    expect(t.totalCost([999]).total).toBe(0);
  });

  it('counts only lines dated in the given month when monthPrefix is passed', () => {
    writeTranscript(home, '-proj', 'sidM', [
      dated('2026-06-01T10:00:00.000Z', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // in: $25
      dated('2026-05-31T23:59:00.000Z', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // out: skipped
      assistant('claude-opus-4-8', { output_tokens: 1_000_000 }), // no timestamp: skipped
    ]);
    const t = new CostTracker(home);
    const file = path.join(home, '.claude', 'projects', '-proj', 'sidM.jsonl');
    expect(t.costForTranscript(file, '2026-06')).toBeCloseTo(25, 6);
  });

  it('sums monthly cost across every project transcript, ignoring open-session scope', () => {
    // Two different projects, neither needs a session file — monthly is history-wide.
    writeTranscript(home, '-projA', 'sidA', [
      dated('2026-06-10T10:00:00.000Z', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // $25
    ]);
    writeTranscript(home, '-projB', 'sidB', [
      dated('2026-06-12T10:00:00.000Z', 'claude-sonnet-4-6', { output_tokens: 1_000_000 }), // $15
      dated('2026-04-01T10:00:00.000Z', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // other month: skipped
    ]);
    const t = new CostTracker(home);
    expect(t.monthlyCost('2026-06')).toBeCloseTo(40, 6);
  });

  it('monthlyCost is 0 when projects dir is absent', () => {
    const t = new CostTracker(home);
    expect(t.monthlyCost('2026-06')).toBe(0);
  });

  it('dedups repeated lines sharing a message.id (CLI logs each message many times)', () => {
    // The CLI writes the same assistant message several times (streaming/partial
    // events) with identical usage; without dedup this would bill ~2x.
    writeTranscript(home, '-proj', 'sidDup', [
      withId('msg_1', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // $25
      withId('msg_1', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // dup, skipped
      withId('msg_1', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // dup, skipped
      withId('msg_2', 'claude-opus-4-8', { output_tokens: 1_000_000 }), // $25
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sidDup')).toBeCloseTo(50, 6); // 2 distinct messages, not 4
  });

  it('still counts lines that have no message.id (cannot dedup)', () => {
    writeTranscript(home, '-proj', 'sidNoId', [
      assistant('claude-opus-4-8', { output_tokens: 1_000_000 }),
      assistant('claude-opus-4-8', { output_tokens: 1_000_000 }),
    ]);
    const t = new CostTracker(home);
    expect(t.costForSession('sidNoId')).toBeCloseTo(50, 6);
  });

  it('dedups a message duplicated across transcript files (resume/fork) in monthlyCost', () => {
    // Same message.id copied into a second project's transcript on resume.
    writeTranscript(home, '-projA', 'sidA', [
      withId('msg_shared', 'claude-opus-4-8', { output_tokens: 1_000_000 }, '2026-06-10T10:00:00Z'),
    ]);
    writeTranscript(home, '-projB', 'sidB', [
      withId('msg_shared', 'claude-opus-4-8', { output_tokens: 1_000_000 }, '2026-06-11T10:00:00Z'), // copy
      withId('msg_new', 'claude-sonnet-4-6', { output_tokens: 1_000_000 }, '2026-06-12T10:00:00Z'), // $15
    ]);
    const t = new CostTracker(home);
    expect(t.monthlyCost('2026-06')).toBeCloseTo(25 + 15, 6); // shared message billed once
  });
});
