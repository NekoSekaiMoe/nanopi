import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charDelay } from './typewriter.ts';

test('charDelay rests on CJK punctuation and moves quickly otherwise', () => {
  // Punctuation ends a phrase: the longest pause.
  for (const ch of ['，', '。', '？', '！', '；', '：', '、', '—', '…']) {
    assert.ok(charDelay(ch) >= 200, `${ch} should pause the reveal`);
  }
  // Spaces are the shortest hop; ordinary characters share one cadence.
  assert.ok(charDelay(' ') < charDelay('山'));
  assert.equal(charDelay('山'), charDelay('月'));
  assert.ok(charDelay('山') > 60 && charDelay('山') < 200);
});
