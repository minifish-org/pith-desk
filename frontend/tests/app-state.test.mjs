import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeState } from '../src/app-state.ts';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));

test('unchanged stream collections keep their references', () => {
  const first = normalizeState(fixed);
  const next = normalizeState(fixed, first);
  assert.equal(next.workspaces, first.workspaces);
  assert.equal(next.conversations, first.conversations);
  assert.equal(next.messages, first.messages);
  assert.equal(next.runs, first.runs);
});

test('changed members are replaced while untouched members are reused', () => {
  const first = normalizeState(fixed);
  const next = normalizeState({
    ...fixed,
    conversations: fixed.conversations.map((conversation, index) => index === 0 ? { ...conversation, title: 'Changed' } : conversation),
    messages: fixed.messages.map((message, index) => index === 0 ? { ...message, text: 'Changed' } : message),
    runs: fixed.runs.map((run, index) => index === 0 ? { ...run, phase: 'retrying' } : run),
  }, first);
  assert.notEqual(next.conversations, first.conversations);
  assert.equal(next.conversations[0].title, 'Changed');
  assert.equal(next.conversations[1], first.conversations[1]);
  assert.notEqual(next.messages, first.messages);
  assert.equal(next.messages[0].text, 'Changed');
  assert.equal(next.messages[1], first.messages[1]);
  assert.notEqual(next.runs, first.runs);
  assert.equal(next.runs[1], first.runs[1]);
  assert.equal(next.workspaces, first.workspaces);
});
