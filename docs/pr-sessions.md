# Which sessions work on a pull request

`swarmail pr-sessions` answers "who has this pull request open?" from the T3 Code store on this machine. It opens the
store read-only inside one read transaction, reads link and provider metadata only, and never reads conversation
content. It prints one JSON document and exits 0; any problem prints `pr-sessions: <reason>` to standard error and exits 1.

```
swarmail pr-sessions <https://github.com/owner/repo/pull/number> --project <checkout> [--include-hidden] [--t3-home <local-profile>]
```

| Argument           | Effect                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| `--project`        | Required. The checkout a T3 project is rooted at; the lookup covers only that project |
| `--include-hidden` | Also lists links the user dismissed in T3 (`hiddenAssociations`, `hiddenLinks`)       |
| `--t3-home`        | A T3 profile directory to read instead of `~/.t3`                                     |

## Output

`matches` holds one entry per T3 conversation linked to the pull request, or whose branch T3 discovered the pull request
from: `associations` lists the links the user or T3 recorded, and `branchDiscovery` is set when only the branch matched
and no link exists. Each entry also has stacked-PR chains, the active provider conversation, the retained provider
history and `swarmail.identities`: the swarmail agents whose registration tags name that conversation (`status` is
`matched`, `unknown` or `unavailable`). `coverage` names the databases read and states the limits.

## Limits

The links are associations, not proof of who implemented the change or released a checkout. Remote environments, T3 V1
stores, non-GitHub hosts, hard-deleted conversations and unlinked sessions are not covered. Agent registrations can be
overwritten, and historical coverage is incomplete.
