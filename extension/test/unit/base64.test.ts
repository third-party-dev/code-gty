// The page's base64 (atob/btoa) must agree with Node's Buffer, which the
// extension host uses, so both hosts decode images and notifications alike.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBase64Portable, encodeBase64Portable } from '../../src/shared/base64';

test('portable base64 matches Buffer', () => {
  const samples = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([255, 254]), new Uint8Array([1, 2, 3])];
  const big = new Uint8Array(200_001);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  samples.push(big);
  for (const s of samples) {
    const enc = encodeBase64Portable(s);
    assert.equal(enc, Buffer.from(s).toString('base64'));
    assert.deepEqual(decodeBase64Portable(enc), new Uint8Array(Buffer.from(enc, 'base64')));
  }
  // Leniency: unpadded, URL-safe, whitespace, junk, a dangling character.
  for (const text of ['aGk', 'aGk=', 'a G\nk=', '-_-_', 'aGk=junk!', 'aGkx2', '', '====', 'YQ']) {
    assert.deepEqual(decodeBase64Portable(text), new Uint8Array(Buffer.from(text, 'base64')), JSON.stringify(text));
  }
});
