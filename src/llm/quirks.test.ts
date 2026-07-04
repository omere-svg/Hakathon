// Tests for per-model-family quirks — especially Qwen3 <think> stripping, which guards
// every downstream free-text parse (a leaked think-block would poison assess/sync JSON).

import { afterEach, describe, expect, it } from 'vitest';
import { quirksFor } from './quirks';
import { resetFlags, setFlags } from '../config/features';

afterEach(() => {
  resetFlags();
});

describe('quirksFor', () => {
  it('resolves qwen3 family for Qwen3 model ids', () => {
    expect(quirksFor('Qwen3-4B-Instruct-q4f16_1-MLC').family).toBe('qwen3');
    expect(quirksFor('qwen3-0.6b').family).toBe('qwen3');
  });

  it('resolves base for everything else (Qwen2.5 is NOT qwen3)', () => {
    expect(quirksFor('Qwen2.5-1.5B-Instruct-q4f16_1-MLC').family).toBe('base');
    expect(quirksFor('Llama-3.2-3B-Instruct').family).toBe('base');
  });
});

describe('base quirks', () => {
  const q = quirksFor('Qwen2.5-1.5B');

  it('passes output through untouched', () => {
    expect(q.cleanOutput('hello <think>x</think>')).toBe('hello <think>x</think>');
  });

  it('adds no system suffix and uses the default token budget', () => {
    expect(q.systemSuffix()).toBe('');
    expect(q.maxTokens()).toBe(280);
  });
});

describe('qwen3 quirks', () => {
  const q = quirksFor('Qwen3-4B');

  it('strips a closed <think> block', () => {
    expect(q.cleanOutput('<think>reasoning here</think>The answer is 4.')).toBe('The answer is 4.');
  });

  it('strips multiple think blocks', () => {
    expect(q.cleanOutput('<think>a</think>Hi<think>b</think> there')).toBe('Hi there');
  });

  it('strips an UNCLOSED think block (model ran out of tokens mid-thought)', () => {
    expect(q.cleanOutput('Answer first. <think>and then it started thinking and never stop')).toBe('Answer first.');
  });

  it('is case-insensitive', () => {
    expect(q.cleanOutput('<THINK>x</THINK>ok')).toBe('ok');
  });

  it('strips ECHOED soft-switch tokens (one surfaced inside a live suggestion chip)', () => {
    expect(q.cleanOutput("I'm not sure, honestly /no_think")).toBe("I'm not sure, honestly");
    expect(q.cleanOutput('/think Sure — a loop repeats.')).toBe('Sure — a loop repeats.');
    // But real words containing "think" survive.
    expect(q.cleanOutput('What do you think about loops?')).toBe('What do you think about loops?');
  });

  it('honours the thinking flag: /no_think + small budget when off', () => {
    setFlags({ thinking: false });
    expect(q.systemSuffix()).toBe(' /no_think');
    expect(q.maxTokens()).toBe(280);
  });

  it('honours the thinking flag: /think + extra headroom when on', () => {
    setFlags({ thinking: true });
    expect(q.systemSuffix()).toBe(' /think');
    expect(q.maxTokens()).toBe(1024);
  });

  it('uses the vendor non-thinking sampling (0.7/0.8) when thinking is off', () => {
    setFlags({ thinking: false });
    expect(q.sampling()).toEqual({ temperature: 0.7, topP: 0.8 });
  });

  it('uses the vendor thinking sampling (0.6/0.95) when thinking is on', () => {
    setFlags({ thinking: true });
    expect(q.sampling()).toEqual({ temperature: 0.6, topP: 0.95 });
  });

  it('never recommends greedy decoding (Qwen3 model-card prohibition)', () => {
    setFlags({ thinking: false });
    expect(q.sampling().temperature).toBeGreaterThan(0);
    setFlags({ thinking: true });
    expect(q.sampling().temperature).toBeGreaterThan(0);
  });
});
