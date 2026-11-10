---
description: Switch Claude Code to another saved Claude account (by email, label or id)
argument-hint: <email | label | id>
allowed-tools: Bash(__PY__:*)
---
!`__PY__ __BIN__ use "$ARGUMENTS"`

Report the result above in one or two sentences. If it succeeded, remind me that new Claude Code sessions use the new account and that this open session keeps its current login until I restart it.
