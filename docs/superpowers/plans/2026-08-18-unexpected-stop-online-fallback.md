# Unexpected Stop Online Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Try the explicitly configured Codex Spark model online first for unexpected-stop classification, then use a configured local tiny model only when the online attempt fails.

**Architecture:** Keep the existing `classifyUnexpectedStop()` public contract. Add a separate fallback setting whose value is a local tiny-memory model key. Online responses that successfully parse as YES/NO or an ambiguous result remain final; only thrown/request-level failures enter the local fallback path. Existing local-primary configurations continue to classify locally without an online attempt.

**Tech Stack:** TypeScript, Vitest, existing `Settings` schema, `ModelRegistry`, `tinyModelClient`, `@oh-my-pi/pi-ai`.

---

### Task 1: Add explicit fallback setting and resolver contract

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts:5247-5260`
- Modify: `packages/coding-agent/src/session/unexpected-stop-classifier.ts:64-84`

- [ ] **Step 1: Extend settings schema**

Add `providers.unexpectedStopFallbackModel` immediately after `providers.unexpectedStopModel`, using the same `TINY_MEMORY_MODEL_VALUES` enum but defaulting to the local `qwen2.5-1.5b` key. Its UI condition remains `unexpectedStopDetection`; label it `Unexpected Stop Fallback Model`; describe that it is used only when online classification fails, and local-primary configurations do not need it.

- [ ] **Step 2: Preserve local-primary behavior and add online fallback**

Refactor `classifyUnexpectedStop()` so it reads both settings. Keep the current local-primary branch unchanged. For `backend === ONLINE_MEMORY_MODEL_KEY`, call `classifyOnline()` inside a try/catch; on an exception, log the online failure and call `classifyLocal(text, fallbackModel, deps)` only when the fallback setting is a valid local model key. Do not fallback for an ambiguous successful response (`undefined`). Do not catch/replace an abort as a normal fallback if the signal is aborted; let the existing outer error handling return `undefined`.

- [ ] **Step 3: Run typecheck for the touched package**

Run the repository’s existing targeted TypeScript check for `packages/coding-agent` (use the package script discovered from its package manifest). Expected result: no new type errors.

### Task 2: Add focused classifier regression tests

**Files:**
- Modify: `packages/coding-agent/test/unexpected-stop-classifier.test.ts:105-149`

- [ ] **Step 1: Add online-success test**

Mock `completeSimple` to return `YES`, configure the online backend and local fallback, invoke `classifyUnexpectedStop()`, and assert `true`; assert the local client was not called.

- [ ] **Step 2: Add online-failure fallback test**

Mock `completeSimple` to reject, mock `tinyModelClient.complete` to return `NO`, configure online plus `qwen2.5-1.5b` fallback, and assert `false`; assert the local client received the fallback key.

- [ ] **Step 3: Add ambiguous-online-no-fallback test**

Mock an online response with text `maybe`, configure a valid local fallback, and assert `undefined`; assert the local client was not called.

- [ ] **Step 4: Add fallback-failure test**

Make both online and local classification fail and assert `undefined`, with no uncaught exception.

- [ ] **Step 5: Run the focused test file**

Run the existing Vitest command for `packages/coding-agent/test/unexpected-stop-classifier.test.ts`. Expected result: all tests pass.

### Task 3: Verify the real configuration path

**Files:**
- Inspect only the touched source and settings files; no further source changes unless the focused tests expose a contract mismatch.

- [ ] **Step 1: Exercise the classifier through its existing test seam**

Run the focused classifier test again from a clean process and confirm the online-success and online-failure paths select the intended backend in the final output.

- [ ] **Step 2: Inspect the scoped diff**

Review only `settings-schema.ts`, `unexpected-stop-classifier.ts`, and `unexpected-stop-classifier.test.ts`. Confirm no unrelated files, generated artifacts, secrets, or formatting drift were introduced.

- [ ] **Step 3: Report evidence**

Report the exact changed paths, test command/output, compatibility behavior, and any real-path limitation if live Codex Spark credentials are unavailable.
