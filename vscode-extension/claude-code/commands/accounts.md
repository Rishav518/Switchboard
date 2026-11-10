---
description: Show every Claude account's 5-hour/weekly usage, which one Claude Code uses, and session context
allowed-tools: Bash(__PY__:*)
---
!`__PY__ __BIN__ status`

Summarise the account table above in a compact list: which account is live, each account's 5-hour and weekly usage with reset times, and whether auto-switch is on. If the live account is close to the threshold, say which saved account it would switch to. Mention `/switch-account <email>` to switch manually.
