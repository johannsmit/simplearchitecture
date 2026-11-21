---
name: work-refined-issue
description: Take the oldest open GitHub issue labelled "refined", build it on a branch, check it, and open a pull request for review. Use when asked to work the next refined issue, or from a scheduled run.
---

# Work the next refined issue

An issue labelled `refined` is approved for work. This skill takes one such issue, builds it on its own branch, checks it, and opens a pull request that merges itself into `main` once CI passes. Nothing reaches `main` without passing CI.

Work on **one issue per run**. Stop after the pull request is open.

## 1. Pick the issue

1. If any open issue has the label `in-progress` or `in-review`, stop: the previous issue isn't finished. Say which issue is waiting and do nothing else.
2. List open issues labelled `refined`, oldest first: `gh issue list --label refined --state open --json number,title,createdAt --jq 'sort_by(.createdAt)'`.
3. If there are none, stop: there's nothing to do. Don't comment anywhere.
4. Take the oldest. Read the issue and all its comments (`gh issue view <N> --comments`).
5. If it isn't clear what's wanted or how to tell it's done, don't guess. Comment with your questions, swap the label `refined` for `needs-refinement`, and stop.
6. Otherwise, swap `refined` for `in-progress` and comment: "Picked up. A pull request will follow."

## 2. Plan before you build

- Read `README.md`, the `guide/` pages the issue touches, and the code around the change.
- Write down, for yourself, the goal and the acceptance criteria as the issue states them. If the issue lists none, derive them from its text and put them in the pull request so they can be checked.
- Keep it small. Build only what the issue asks: no extra features, no unrelated refactoring. If the work turns out to be much larger than the issue suggests, stop at step 5 of "Pick the issue": comment why, set `needs-refinement`, remove `in-progress`.

## 3. Build

Create a branch from the latest `main`: `issue-<N>-<short-slug>`.

Follow the rules in `CLAUDE.md` at the repository root. Every agent gets them too.

Use the agents in `.claude/agents/`. You coordinate and don't build or test the items yourself:

- **ui-designer**, first, when the issue changes what users see or do. Ask for a short spec with acceptance criteria. It goes in the pull request body, not in the repository.
- **senior-engineer** builds the change with its unit and integration tests.
- **qa-specialist** runs the checks in step 4 and reports the results. Defects go back to the senior engineer until the checks pass, or until a defect is out of the issue's scope.

Each brief names the issue number, the branch, the acceptance criteria, and says which files to read. Agents don't commit or push: you do that in step 5.

## 4. Check

The qa-specialist runs each once. The senior engineer fixes what fails:

- lint, typecheck, `npm test`, the build, and `npm run check:links`;
- add regression tests for the new behaviour (a test that fails without the change);
- use the browser (Playwright) only for what jsdom can't check, such as layout, overlap or pointer behaviour, with a few targeted checks;
- read the docs the change touches and confirm they say what the code now does.

Some tests need `THROWAWAY_DATABASE_URL` and are skipped without it. CI runs them. Say in the pull request that they were skipped.

If a check still fails and you can't fix it within the issue's scope, open the pull request as a **draft** and say exactly what fails.

## 5. Open the pull request

- Commit in small, clear steps. Messages describe the change in the user's terms and end with `(#<N>)`.
- Push the branch and open a pull request against `main`:
  - title: the change in a few words;
  - body: `Closes #<N>`, what changed for the user, the acceptance criteria with how each was checked, the checks actually run with their results (test count included), anything skipped or left open, and what the maintainer should try by hand.
- Before you open the pull request, set its version as `CLAUDE.md` says (minor for a feature, patch for fixes only), with its release notes. Then run `npm install --package-lock-only` with npm 11 to check that the lockfile agrees. Give the new version in the pull request body.
- Turn on auto-merge for the pull request (merge commit), so it merges once CI passes. Don't do this for a draft. Don't merge by hand, tag, or push to `main`.
- On the issue, swap `in-progress` for `in-review` and comment with the pull request link.

Then stop.
