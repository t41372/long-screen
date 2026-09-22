import { assertEquals, assertMatch, assertNotEquals, assertThrows } from '@std/assert';
import { createId } from '../../src/core/id.ts';

Deno.test('IDs use native UUID when available and bind its receiver', () => {
  const random = { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: crypto.randomUUID.bind(crypto) };
  assertMatch(createId(random), /^[a-f0-9-]{36}$/);
});

Deno.test('IDs without randomUUID retain v4 format and secure randomness', () => {
  const random = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const a = createId(random), b = createId(random);
  assertMatch(a, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assertNotEquals(a, b);
  const zeros = { getRandomValues: <T extends ArrayBufferView | null>(bytes: T): T => bytes };
  assertEquals(createId(zeros).split('-'), ['0'.repeat(8), '0'.repeat(4), '4' + '0'.repeat(3), '8' + '0'.repeat(3), '0'.repeat(12)]);
});

Deno.test('IDs never silently fall back to Math.random', () => {
  assertThrows(() => createId({} as Crypto), Error, 'SECURE_RANDOM_UNAVAILABLE');
});
