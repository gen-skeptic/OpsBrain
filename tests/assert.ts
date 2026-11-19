// Minimal assertions so tests run without fetching extra modules.
export function assert(cond: unknown, msg = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `Expected ${e}\n     got ${a}`);
}

export function assertStringIncludes(actual: string, expected: string, msg?: string) {
  if (!actual.includes(expected)) throw new Error(msg ?? `Expected text to include ${JSON.stringify(expected)}\n${actual.slice(0, 400)}`);
}

export async function assertRejects(fn: () => Promise<unknown>, includes?: string) {
  try {
    await fn();
  } catch (err) {
    if (includes && !String((err as Error).message).includes(includes)) {
      throw new Error(`Expected error containing "${includes}", got "${(err as Error).message}"`);
    }
    return;
  }
  throw new Error("Expected the call to fail");
}
