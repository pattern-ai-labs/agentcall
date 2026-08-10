// Unit tests for the Node bridges' stdin command-name resolution.
//
// Mirrors the intent of tests/test_bridge_stdin.py (Python) for the Node side.
// The resolver lives in its own import-safe module so it can be tested without
// spawning a real bridge / meeting. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stdinCommandName, STDIN_TYPE_ALIASES } from '../scripts/node/stdin-commands.js';

test('command shorthand passes through unchanged', () => {
  assert.equal(stdinCommandName({ command: 'tts.speak' }), 'tts.speak');
  assert.equal(stdinCommandName({ command: 'mic' }), 'mic');
  assert.equal(stdinCommandName({ command: 'leave' }), 'leave');
});

test('raw API type is accepted', () => {
  assert.equal(stdinCommandName({ type: 'tts.speak' }), 'tts.speak');
  assert.equal(stdinCommandName({ type: 'meeting.mic' }), 'mic');
});

test('raw API aliases map to the bridge shorthand', () => {
  assert.equal(stdinCommandName({ type: 'meeting.send_chat' }), 'send_chat');
  assert.equal(stdinCommandName({ type: 'meeting.raise_hand' }), 'raise_hand');
  assert.equal(stdinCommandName({ type: 'meeting.mic' }), 'mic');
  assert.equal(stdinCommandName({ type: 'meeting.leave' }), 'leave');
  assert.equal(stdinCommandName({ type: 'screenshot.take' }), 'screenshot');
});

test('command shorthand takes precedence over type', () => {
  assert.equal(stdinCommandName({ command: 'mic', type: 'leave' }), 'mic');
});

test('unknown command/type name passes through unchanged', () => {
  assert.equal(stdinCommandName({ command: 'bogus.command' }), 'bogus.command');
  assert.equal(stdinCommandName({ type: 'meeting.unknown' }), 'meeting.unknown');
});

test('missing command/type resolves to empty string', () => {
  assert.equal(stdinCommandName({}), '');
  assert.equal(stdinCommandName({ text: 'hi' }), '');
  assert.equal(stdinCommandName(null), '');
  assert.equal(stdinCommandName(undefined), '');
});

test('visual-only command names pass through unchanged (no alias)', () => {
  // bridge-visual.js commands that are bridge-only or already match their
  // backend type must resolve to themselves — guards against a stray alias.
  for (const c of [
    'screenshare.start', 'screenshare.stop', 'screenshare.swap',
    'webpage.open', 'webpage.close', 'tasks.set', 'set_state',
  ]) {
    assert.equal(stdinCommandName({ command: c }), c);
    assert.equal(stdinCommandName({ type: c }), c);
  }
});

test('alias map matches the documented raw API names', () => {
  assert.deepEqual(STDIN_TYPE_ALIASES, {
    'meeting.send_chat': 'send_chat',
    'meeting.raise_hand': 'raise_hand',
    'meeting.mic': 'mic',
    'meeting.leave': 'leave',
    'screenshot.take': 'screenshot',
  });
});
