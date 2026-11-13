# Cititec fork

This is Cititec's fork of [WYRE-AI/unifi-mcp](https://github.com/WYRE-AI/unifi-mcp). The upstream
project is licensed under Apache-2.0; that licence and its notices still apply to this fork.

Read this before changing anything here: it says which changes go back to Wyre and which stay
in this fork.

## Two kinds of change

| Kind of change | Branch from | Goes to |
|----------------|-------------|---------|
| Fix or improvement that is useful to everyone | Wyre's current `main` (`upstream/main`) | A PR to `WYRE-AI/unifi-mcp`, **and** the same branch merged into our `main` |
| Cititec-only: `cititec-*.yml` workflows, image labels in `Dockerfile`, this file, the note at the top of `README.md` | Our `main` | Our `main` only - never in a PR to Wyre |

Never open a PR to Wyre from our `main`: it carries the Cititec-only changes, and Wyre would have
to reject it.

## Set up once

```bash
git clone https://github.com/Cititec-Pty-Ltd/unifi-mcp.git
cd unifi-mcp
git remote add upstream https://github.com/WYRE-AI/unifi-mcp.git
```

## Send a fix to Wyre

```bash
git fetch upstream
git switch -c fix/<short-name> upstream/main
# make the change, add tests, update CHANGELOG.md
git push -u origin fix/<short-name>

# PR to Wyre
gh pr create --repo WYRE-AI/unifi-mcp --base main --head Cititec-Pty-Ltd:fix/<short-name>
# The same branch into our main, so we have the fix straight away
gh pr create --repo Cititec-Pty-Ltd/unifi-mcp --base main --head fix/<short-name>
```

Both this fork and Wyre's repository are **public**. Keep commits, tests and PR text free of
client names, hostnames, user names, organization or computer IDs and other internal details -
use made-up example values (`WS-01`, `C:\Temp\setup.msi`, a dummy GUID).

## Bring Wyre's updates in

```bash
git fetch upstream
git switch main
git pull
git merge upstream/main     # merge - never rebase
# if there are conflicts, keep Cititec's version of Cititec-only lines
git push
```

Do not rebase our `main` or force-push it. The **Protect main** ruleset blocks force-pushes and
deleting `main` on purpose, so the fork's history cannot be lost. GitHub's **Sync fork** button
only works while there are no conflicts; otherwise merge as above.


## Weekly Wyre check (automatic)

The **Cititec Wyre sync** workflow (`.github/workflows/cititec-wyre-sync.yml`) runs every
Tuesday morning (Australian time), and can also be started from the Actions tab
(**Run workflow**). It does the "Bring Wyre's updates in" steps for you, up to the PR:

- Up to date with Wyre: nothing happens.
- New Wyre commits that merge cleanly: it creates a `sync/wyre-<sha>` branch, runs install,
  build and tests on the merged code, and opens a PR into `main` with Wyre's commit list and
  the test result. **Review and merge it yourself** - nothing is merged or released
  automatically. If CI does not start on that PR, close and reopen it.
- Conflicts, Wyre changes to `.github/workflows/`, or PR creation not allowed: it opens an
  issue (or, with Issues off, fails the run so GitHub emails it) saying what to merge by hand.

After merging a sync PR, the release still needs the MCP host step below.

## After a release

Adding, renaming or removing a tool also needs a change on Cititec's MCP host, or the new tool
does not appear for anyone. Follow the internal runbook in the private Cititec-Pty-Ltd/Cititec
repository (`claude/mcp-host/README.md`), and update the `cititec-mcp-servers` skill there.

## Protection

- Ruleset **Protect main**: `main` cannot be deleted or force-pushed. Normal pushes and PR merges
  still work.
- Only organization owners can delete repositories in Cititec-Pty-Ltd.
- If Wyre deletes or privatises the upstream repository, this fork stays (only Sync fork stops).
