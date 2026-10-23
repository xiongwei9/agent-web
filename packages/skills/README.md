# Skills

The agent's [Agent Skills](https://agentskills.io/specification). Each folder
is one skill: a `SKILL.md` (YAML frontmatter with `name` and `description`, then
the instructions) plus optional `references/`, `scripts/` and `assets/`. The
`name` matches the folder name.

`agui-server` loads this directory by default (see `SKILLS_DIRS`). New or
changed skills take effect when the server restarts.

The model loads a skill on its own when a request matches its `description`;
the user can also start a message with `/<name>` to activate it.
