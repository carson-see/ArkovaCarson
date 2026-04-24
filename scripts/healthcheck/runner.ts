export type Check = {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
  remediation?: string;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  remediation?: string;
};

export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      const start = Date.now();
      try {
        const { ok, detail } = await c.run();
        return {
          name: c.name,
          ok,
          detail,
          durationMs: Date.now() - start,
          remediation: ok ? undefined : c.remediation,
        };
      } catch (err) {
        return {
          name: c.name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
          remediation: c.remediation,
        };
      }
    }),
  );
}
