# OrbiterX — Beta Test Plan

Run the app with `./start.sh` (desktop) or `./start.sh --web` (browser on
`http://localhost:3000`). Hard-refresh (`Cmd/Ctrl+Shift+R`) after any rebuild.
For each item: mark ✅ pass / ❌ fail, and if it fails, copy the bug template
at the bottom into a new chat with the console errors attached.

Priority: **P0** = must work before release · **P1** = important · **P2** = polish.

---

## 1. Authentication & Access (P0)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1.1 | Open `/` in a browser with no token | Landing page shows (hero, orbit visual, Features, How it works, CTA) | |
| 1.2 | Click **Sign in** (nav / hero / bottom CTA) | Hosted login opens in the browser (system browser on desktop, new tab in web) | |
| 1.3 | Complete login in the browser | App auto-logs-in and redirects to the workspace (web mode auto; desktop after returning) | |
| 1.4 | Open `/login` and use the access-token form with a bad token | Shows "Invalid token" error, stays on login | |
| 1.5 | Login with a valid Web Service token | Enters the workspace | |
| 1.6 | While logged out, open `/workspace` or `/settings/*` directly | Redirects to `/login` instantly (no app content flashes) | |
| 1.7 | Settings → **Sign out** (bottom of sidebar) → confirm | Settings window AND the main session window flip to the login page at the same time | |
| 1.8 | After sign-out, close and reopen the app / Settings | Still on the login page (not "already logged in") | |
| 1.9 | Sign in from one window while another is on `/login` | The other window follows to the workspace automatically | |
| 1.10 | Desktop app, first launch (never signed out) | Goes straight to the workspace (no login) | |

## 2. Workspace & Chat Basics (P0)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 2.1 | New session | Welcome panel with time-based greeting animation and blinking caret | |
| 2.2 | Welcome tabs | **Developer** active; **Office** and **Scientific** dimmed with lock icon | |
| 2.3 | Hover Office / Scientific | Tooltip shows "Beta coming soon" | |
| 2.4 | Send a normal message | Send button works, live thoughts/tool calls stream in | |
| 2.5 | Send button states | Disabled while empty, shows spinner state while sending, small round arrow icon | |
| 2.6 | Close and reopen the session | User message present, turns identical, no duplicates, no missing messages | |
| 2.7 | Sidebar | Session rows are title-only (no icons, no status dots) | |

## 3. Diffs & Files (P0)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 3.1 | Natural prompt: "Make a small Python file demo_edit.py… then improve it…" (no tool hints) | File Change cards appear live with green/red diffs | |
| 3.2 | After completion | "New files" / "Files changed" section shows with `+N -N` counts | |
| 3.3 | New-file card | Inline diff visible (green) without expanding anything | |
| 3.4 | Changed-file card | Red (removed) + green (added) lines with left accent bars; View diff opens it in a side tab | |
| 3.5 | Open created file | Opens in an editor tab (no "Failed to open local file" error) | |
| 3.6 | Close and reopen the session | Diff cards and Files changed section persist | |

## 4. Sub-Agent Workflows (P0)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 4.1 | Ask the main agent to spawn a sub-agent | Sub-agent capsule appears; its thoughts/tool calls/messages stream live | |
| 4.2 | Spawn 2–3 sub-agents in parallel | All run in parallel, each with its own distinct name (from backend, e.g. Leibniz/Volta/Dewey) | |
| 4.3 | Click a sub-agent capsule/card | Session opens instantly in a right-side tab (no extra click needed) | |
| 4.4 | Sub-agent edits files | Diffs appear inline in the main conversation at the end | |
| 4.5 | Close and reopen the parent session | User message present, sub-agent names distinct, no duplicates/triples | |

## 5. Settings (P1)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 5.1 | Settings sidebar | Clean rows, no **Agents** entry | |
| 5.2 | Visit `/settings/agents` directly | Redirects to the default settings page | |
| 5.3 | Appearance | Light/dark/system + all theme colors apply app-wide (incl. editor) | |
| 5.4 | MCP | Enabled Apps list contains only **OrbiterX**; no "Load failed: invalid JSON" error | |
| 5.5 | Web Service | Start server, copy token / QR, open address | |
| 5.6 | Web Service token login | From another browser/device, `/login` with that token enters the workspace | |
| 5.7 | Skills / Experts / Office Tools / Science | Settings open and save without errors | |
| 5.8 | Shortcuts, Version Control, Chat Channels, Logs, System | Each opens; changes persist | |

## 6. Reliability & Console (P1)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 6.1 | Open DevTools console during a full session (login → chat → sub-agent → diffs → logout) | No `acp-connections Failed to persist status`, no `t.raw` errors, no `MISSING_MESSAGE` | |
| 6.2 | Restart the app mid-session | Reconnect works; no white screen; session restores | |
| 6.3 | Network blip while connected | "Reconnecting" dialog, auto-recovery | |

## 7. Localization (P2)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 7.1 | Switch locale | Landing/login/settings labels follow the locale; no missing-key errors | |
| 7.2 | Arabic locale | RTL layout renders without breakage | |

---

## Bug Report Template

Paste this into a new chat when something fails:

```text
Feature: <e.g. Login / Sub-agent / Diff>
Steps:
1.
2.
Expected: <what should happen>
Actual: <what happened>
Console errors (if any): <paste>
Screenshot: <attach>
```
