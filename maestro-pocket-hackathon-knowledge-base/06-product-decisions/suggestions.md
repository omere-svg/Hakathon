# Suggestions — parked ideas (NOT yet built)

> Deferred by decision on 2026-07-01 — documented here so we don't lose them. Full write-up with implementation mapping + learning-science grounding is in [../05-research/small-llm-performance-playbook.md](../05-research/small-llm-performance-playbook.md) §8.

## Pedagogical tricks to make a 1.5B teach like a professor

**Unifying principle:** a big model reasons; a small model can only *recognize (classify)* and *rephrase (NLG)*. So move every act of reasoning / creation / judgment offline (big model) or into deterministic tools, and let the small model only recognize + rephrase. Each trick is an instance — and each is unnecessary at 70B.

1. **Narrate, don't derive** — reasoning traces are authored/tool-verified; the model only voices the next verified step. It *cannot* make a math error because it never computes. *(Status: facts done; step-narration loop = next.)*
2. **Diagnosis-by-classification (Bug Library)** — author the 3–5 classic misconceptions per concept; runtime turns "diagnose" into a constrained pick-the-index, then delivers the authored remediation. *(MCQ path done; free-text classifier = next — highest-leverage.)*
3. **Representation Ladder** — pre-stock N distinct representations (analogy / worked example / ASCII-visual / counterexample); "explain another way" = serve the next unused one. *(Next — hook is `PresentationGuideline`.)*
4. **Engine-scheduled metacognition** — the policy schedules retrieval practice, self-explanation, predict-before-reveal, desirable-difficulty, spacing as beats; the model only voices them. *(Mastery-gating + spaced-rep-lite done; predict/explain-back beats = next.)*
5. **Zero-authority rendering** — the model may only rephrase grounded assertions (authored content / tool results); a claim-grounding verifier flags novel factual claims. *(Numeric grounding done; general claim-grounding = research-grade next.)*

**Recommended first two to build (biggest visible jump, no model upgrade needed):** Trick 2 (free-text bug-classifier) and Trick 3 (representation ladder).
