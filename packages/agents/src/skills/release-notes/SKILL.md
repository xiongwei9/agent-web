---
name: release-notes
description: Use when the user asks to write, draft, or format release notes / a changelog from a list of merged changes, commits, or pull requests.
---

# Release notes

Turn a list of changes into clean, user-facing release notes.

## Steps

1. Group the changes into these sections, dropping any that are empty:
   - **Features** — new user-visible capabilities
   - **Improvements** — enhancements to existing behavior
   - **Fixes** — bug fixes
   - **Breaking changes** — anything requiring user action (call these out first)
2. Rewrite each entry from the user's perspective: lead with the benefit, not
   the implementation. Drop internal refactors and chore commits.
3. Keep each bullet to one sentence. Link issue/PR numbers when provided.
4. Use the structure in `references/release-notes-template.md` as the output
   shape.

## Style

- Present tense, active voice ("Adds dark mode", not "Added dark mode support").
- No marketing language; be concrete about what changed.
- Date the release as `YYYY-MM-DD` when a date is known.
