# CLAUDE.md — AGENT

## Environment Overview

This project runs in an Anthropic-hosted cloud environment (Ubuntu Linux). Git operations route through a local proxy on `127.0.0.1:62100` — there is no direct access to `github.com`. The `gh` CLI is **not available**. All commits are automatically signed via a custom SSH mechanism.

## Bootstrap

```bash
# Verify proxy connectivity
git ls-remote origin

# Verify signing works
git log --show-signature -1 2>/dev/null || true
```

## External Tool Configuration

### GitHub (via Local Proxy)

#### Connection

All git operations route through a **local proxy** — never directly to `github.com`.

- **Remote URL:** `http://local_proxy@127.0.0.1:62100/git/mjpensa/AGENT`
- The proxy intercepts push, fetch, and pull.
- Direct `github.com` URLs will **not** work.

> **Important:** The `gh` CLI is NOT available in this environment. Use `git` commands only.

#### Authentication

Proxy handles auth transparently. No tokens in git config.

```ini
[http]
    proxyAuthMethod = basic
```

#### Identity & Signing

```ini
[user]
    name = Claude
    email = noreply@anthropic.com
    signingkey = /home/claude/.ssh/commit_signing_key.pub
[gpg]
    format = ssh
[gpg "ssh"]
    program = /tmp/code-sign
[commit]
    gpgsign = true
```

All commits are automatically signed. The signing program at `/tmp/code-sign` is a custom wrapper (not standard `ssh-keygen`).

#### Access Policies

- Push **only** to `claude/*` branches (with a valid session ID suffix).
- Pushes to other branches (e.g., `main` directly) will be rejected with a **403**.
- A GitHub Actions workflow automatically merges `claude/*` branches into `main` on every push. See **CI / CD Hooks**.

**Pre-push checklist:**

```bash
git branch --show-current | grep -q "^claude/" && echo "✔ branch OK" || echo "✗ must be claude/*"
git remote get-url origin | grep -q "127.0.0.1:62100" && echo "✔ remote OK" || echo "✗ must use proxy"
```

#### Smoke Test

```bash
git ls-remote origin && echo "✔ proxy OK" || echo "✗ proxy unreachable"
git log --show-signature -1 2>/dev/null | grep -q "Good" && echo "✔ signing OK" || echo "⚠ not verified yet"
```

#### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403` on push | Wrong branch | Use `claude/<session-id>` |
| `403` on push | Pushing to `main` | Use `claude/*`; auto-merge handles `main` |
| `repository not found` | Wrong proxy URL | Check `remote.origin.url` matches `127.0.0.1:62100` |
| `gh: command not found` | Not in cloud env | Use `git` only — `gh` is not available here |
| Unsigned commit | Missing key/program | Verify `/home/claude/.ssh/commit_signing_key.pub` and `/tmp/code-sign` exist |

## CI / CD Hooks

### Auto-Merge Workflow

File: `.github/workflows/auto-merge-claude.yml`

This workflow runs in **GitHub Actions** (not in the cloud environment). On every push to a `claude/**` branch, it automatically merges that branch into `main`.

- **Trigger:** `push` to `claude/**`
- **Action:** Checks out `main`, merges the pushed branch, pushes `main`
- **Actor:** `github-actions[bot]`

You do not need to create or modify this workflow — it was set up during initial project creation.

## Troubleshooting

- **No network access to external URLs:** This environment cannot reach arbitrary internet hosts. Git traffic goes through the local proxy only.
- **Cannot install packages with Homebrew:** Homebrew is not available. Use `apt` if packages are needed.
- **Environment resets between sessions:** Do not rely on local state persisting. Always pull latest from the repo at session start.
