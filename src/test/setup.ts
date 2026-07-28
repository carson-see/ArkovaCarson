/**
 * Vitest Setup
 */

import '@testing-library/jest-dom';

// Polyfill File.arrayBuffer for jsdom
if (!File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function () {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

// Polyfill File.text for jsdom
if (!File.prototype.text) {
  File.prototype.text = function () {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };
}

// Mock crypto.subtle for tests
Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle: {
      digest: async (_algorithm: string, data: ArrayBuffer) => {
        // Simple mock that returns a consistent hash based on data length
        const hashArray = new Uint8Array(32);
        const view = new Uint8Array(data);
        for (let i = 0; i < 32; i++) {
          hashArray[i] = view[i % view.length] || 0xab;
        }
        return hashArray.buffer;
      },
    },
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
    // jsdom does not implement crypto.randomUUID(); code that mints
    // client-side idempotency keys (e.g. AdminOrganizationsPage credit
    // adjust, L2-A5) needs a real-shaped UUID for its format assertions.
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      const hex = () => Math.floor(Math.random() * 16).toString(16);
      const block = (n: number) => Array.from({ length: n }, hex).join('');
      return `${block(8)}-${block(4)}-4${block(3)}-a${block(3)}-${block(12)}`;
    },
  },
  writable: true,
});

// Mock clipboard API — only when the env has `navigator`. Node 20 (CI)
// does not define it globally; `@vitest-environment node` tests would
// crash at module load without this guard. Node 22+ and jsdom both do.
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async () => {},
      readText: async () => '',
    },
    writable: true,
    // `configurable: true` lets @testing-library/user-event reattach its own
    // clipboard stub when `userEvent.setup()` is called — otherwise it throws
    // `TypeError: Cannot redefine property: clipboard` in jsdom.
    configurable: true,
  });
}
