export async function runWithVerifiedCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  verifyCleanup: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let workError: unknown;
  try { result = await work(); } catch (error) { workError = error; }
  await cleanup();
  await verifyCleanup();
  if (workError) throw workError;
  return result as T;
}
