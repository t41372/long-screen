import '../support/core.ts';
import { assertEquals } from '@std/assert';
import { core } from '../../src/core/wasm.ts';

// Source pages grow linear memory after other stages own buffers. Renewed views must still address
// the right allocation, copied exports must remain independent, and repeated cleanup must not
// free a later allocation a second time.
Deno.test('core memory: exported bytes and renewed views survive growth and repeated cleanup', () => {
  const resident = core().alloc(16), source = Uint8Array.from({ length: 16 }, (_, i) => i);
  let growth: ReturnType<ReturnType<typeof core>['alloc']> | undefined;
  try {
    resident.write(source);
    const snapshot = resident.bytes();
    assertEquals(resident.view(), source);
    growth = core().alloc(core().memoryBytes + 65536);
    assertEquals(resident.view(), source);
    resident.view()[3] = 99;
    assertEquals(snapshot, source, 'persisted bytes must not alias mutable native memory');
    assertEquals(resident.bytes()[3], 99);
    growth.free();
    growth.free();
    const later = core().alloc(16);
    try {
      later.write(source);
      growth.free();
      assertEquals(later.bytes(), source);
    } finally {
      later.free();
    }
  } finally {
    growth?.free();
    resident.free();
  }
});
