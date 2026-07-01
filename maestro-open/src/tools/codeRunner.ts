// Deterministic tool: run student JS code against test cases, in a best-effort
// sandbox (Function constructor; no DOM/globals passed in). Returns ground-truth
// correctness so the engine never has to trust the LLM about code.

export interface CodeTestResult {
  passed: boolean;
  detail: string;
}

export function runCodeTests(
  studentCode: string,
  functionName: string,
  tests: { args: unknown[]; expected: unknown }[],
): CodeTestResult {
  let fn: unknown;
  try {
    // Define the student's code, then return the named function.
    // eslint-disable-next-line no-new-func
    const factory = new Function(`"use strict";\n${studentCode}\nreturn typeof ${functionName} === "function" ? ${functionName} : undefined;`);
    fn = factory();
  } catch (err) {
    return { passed: false, detail: `Code did not run: ${(err as Error).message}` };
  }
  if (typeof fn !== 'function') {
    return { passed: false, detail: `No function named ${functionName} was defined.` };
  }
  for (const t of tests) {
    let actual: unknown;
    try {
      actual = (fn as (...a: unknown[]) => unknown)(...t.args);
    } catch (err) {
      return { passed: false, detail: `Threw on ${functionName}(${t.args.join(', ')}): ${(err as Error).message}` };
    }
    if (JSON.stringify(actual) !== JSON.stringify(t.expected)) {
      return {
        passed: false,
        detail: `${functionName}(${t.args.join(', ')}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(t.expected)}.`,
      };
    }
  }
  return { passed: true, detail: 'All tests passed.' };
}
