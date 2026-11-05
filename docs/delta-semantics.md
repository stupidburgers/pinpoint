# Audit delta semantics

`delta.fixed` means **no longer detected by a completed, comparable check**. It is not proof that the same DOM element was repaired: removal can also make a finding absent. Distinguishing removal from repair remains outside this change.

Audit results add `rules_covered: string[]`: rules for which execution and complete finding reporting succeeded. `stats.checked` still records attempted rules and counts, including zero eligible elements. A rule error excludes that rule from coverage; an engine-global finalization error or engine finding-list truncation makes coverage empty. This is intentionally conservative even if some individual rules might have completed.

At both persistence and Desktop delta boundaries:

- An absent old open finding becomes fixed only if its rule has usable execution coverage and the result has a usable findings array (including a valid empty array). Missing/non-array findings or entries without a nonblank string ID are rejected before persistent-store or Desktop saved-state mutation; invalid entries are never silently dropped to establish absence.
- Optional `errors` and `limits` default to empty arrays only when absent. Explicit nulls, non-array containers, error entries without nonblank string rules, or non-string/blank limit entries invalidate coverage. Such reports retain absent old pins as not rechecked rather than interpreting malformed metadata as successful execution.
- Missing/malformed coverage, an unexecuted rule, a matching rule error, engine-global error, or truncated finding output cannot establish absence. The old pin stays open and its ID appears in additive `delta.not_rechecked` and `delta.unresolved` arrays.
- Legacy incoming results can use a valid numeric `stats.checked` map (after excluding errors); neither requested `rules` nor the rules of returned findings establish coverage. An explicitly supplied invalid `rules_covered` is not repaired by falling back to another field.
- Old persisted finding rows need no migration: the finding's rule, or its stable ID prefix, identifies the rule to recheck. Unknown incoming scope remains conservative.
- A successful comparable recheck after a real repair still closes the pin.

Desktop-only state retains unresolved old findings in memory, local storage, overlay input and the open list, including after local-state restore. They remain separate from `AuditResult.findings`; the latest score/counts describe checks actually run, not a fabricated full-page recheck. Dismissed findings are not treated as open. The SQLite store still caps pins at 200 per URL, prioritizing previously unresolved pins over newly observed pins during pruning; this is bounded retention, not unlimited history.

These guards do not establish complete WCAG coverage or solve every unmeasurable-target/skip condition. Other engine `limits` (such as contrast background limitations) are not generally mapped to per-target comparable scope here. Tool response presentation slicing happens **after** persistence; engine finding-list truncation happens before persistence and must block absence-based fixes.
