# Arkova Local Source Of Truth

Last updated: 2026-05-15

## Canonical Local Checkout

The canonical local Arkova checkout is:

```bash
/Volumes/Extreme/Arkova/arkova-mvpcopy-main
```

This checkout should be the normal place to run `git status`, create branches, install dependencies, run tests, and prepare commits. It is the local source of truth for the Arkova repository on this Mac.

Expected clean state:

```bash
cd /Volumes/Extreme/Arkova/arkova-mvpcopy-main
git status --short --branch
# ## main...origin/main
```

Remote:

```bash
origin  https://github.com/carson-see/ArkovaCarson.git
```

## Not Source Of Truth

Do not treat these locations as canonical:

- `/Users/carson/Desktop/*`
- `/Users/carson/Arkova/*`
- `/Volumes/Extreme/Arkova/_desktop_archive/*`
- `/Volumes/Extreme/Arkova/_legacy/*`
- `/Volumes/Extreme/Arkova/worktrees/*`
- `/Volumes/Crucial X9/*`

Those locations are archives, backups, scratch worktrees, or older local copies. They may preserve useful evidence, stashes, or branch work, but they must not replace the canonical checkout without an explicit recovery decision.

## Worktrees

PR and task worktrees live under:

```bash
/Volumes/Extreme/Arkova/worktrees
```

Worktrees are branch-specific working directories, not independent repositories. Before removing any worktree, check it from the canonical checkout:

```bash
cd /Volumes/Extreme/Arkova/arkova-mvpcopy-main
git worktree list
git -C /Volumes/Extreme/Arkova/worktrees/<name> status --short --branch
```

Remove only clean, merged, or intentionally abandoned worktrees:

```bash
git worktree remove /Volumes/Extreme/Arkova/worktrees/<name>
git worktree prune
```

If a worktree has changed files, untracked evidence, a detached commit, or a matching open PR, preserve it until that branch is resolved.

## Backups

The Crucial X9 SSD is a backup target, not an editing location:

```bash
/Volumes/Crucial X9/Arkova
```

The backup should be refreshed from `/Volumes/Extreme/Arkova` after the canonical checkout and archives are in the desired state. Do not edit or run Git operations from the Crucial X9 backup.

## Recovery Rule

When in doubt, trust this order:

1. GitHub remote: `https://github.com/carson-see/ArkovaCarson.git`
2. Canonical local checkout: `/Volumes/Extreme/Arkova/arkova-mvpcopy-main`
3. Preserved worktrees: `/Volumes/Extreme/Arkova/worktrees`
4. Dated archives and backups

If the canonical checkout and an archive disagree, inspect Git history, branch names, stashes, and file timestamps before copying anything over the canonical checkout.
