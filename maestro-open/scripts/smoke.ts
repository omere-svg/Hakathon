// Plumbing smoke test (npm run smoke). Drives a full turn through the pipeline
// Orchestrator → LLM → Verifier → repair/guard, using a STUB model (no WebGPU needed)
// to simulate how a weak on-device model misbehaves. Asserts the engine's guarantees:
//   1) guard() makes C2 (no answer leak) hold even against a model that always leaks.
//   2) verify→re-prompt fixes C3 (false validation) when the model complies on correction.
import { scenarios } from '../src/eval/scenarios';
import { initStudentModel } from '../src/student/model';
import { initLessonMemory } from '../src/memory/types';
import { runTurn } from '../src/engine/orchestrator';
import type { LLMEngine } from '../src/llm/types';

function stub(name: string, fn: (system: string, user: string) => string): LLMEngine {
  return { name, onDevice: true, async complete(system, user) { return fn(system, user); } };
}
function fresh(id: string) {
  const s = scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} not found`);
  const student = initStudentModel();
  const mem = initLessonMemory(s.lesson.id, s.lesson.knowledgeComponents[0].id);
  s.setup(student, mem);
  return { s, student, mem };
}

async function main() {
  let fail = 0;

  // 1) Challenge + a stubborn model that ALWAYS leaks → guard() must guarantee C2.
  {
    const { s, student, mem } = fresh('SWE-03');
    const leaky = stub('always-leak', () => 'Easy — the answer is a do-while loop, obviously.');
    const r = await runTurn({ lesson: s.lesson, lessonMem: mem, student, studentMessage: s.probe, mode: 'engine', llm: leaky });
    const ok = r.checks.find((c) => c.id === 'C2')?.passed === true;
    console.log(`\n[SWE-03 challenge · always-leak stub] act:${r.act?.type} repairs:[${r.repairs.join(', ')}]`);
    console.log(`  out: ${r.output}`);
    console.log(`  ${ok ? '✓' : '✗'} C2 holds despite a leaking model (re-prompt + guard scrub)`);
    if (!ok) fail++;
  }

  // 2) Wrong answer + a model that affirms first then complies on correction → repair fixes C3.
  {
    const { s, student, mem } = fresh('SWE-01');
    const sycophant = stub('affirm-then-comply', (system) =>
      system.includes('broke these rules')
        ? 'Not quite yet — what does your function return when nums = [1, 2, 3, 4]?'
        : 'Correct! Great job, that looks right.');
    const r = await runTurn({ lesson: s.lesson, lessonMem: mem, student, studentMessage: s.probe, mode: 'engine', llm: sycophant });
    const ok = r.checks.find((c) => c.id === 'C3')?.passed === true && r.repairs.includes('C3');
    console.log(`\n[SWE-01 wrong code · affirm-then-comply stub] act:${r.act?.type} repairs:[${r.repairs.join(', ')}]`);
    console.log(`  out: ${r.output}`);
    console.log(`  ${ok ? '✓' : '✗'} C3 repaired via re-prompt (affirmation → probing question)`);
    if (!ok) fail++;
  }

  if (fail) { console.error(`\n${fail} smoke assertion(s) failed.`); process.exit(1); }
  console.log('\n✓ Smoke OK — Orchestrator → LLM → Verifier → repair/guard plumbing works.');
}
main().catch((e) => { console.error(e); process.exit(1); });
