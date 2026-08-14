# AGENTS.md

## Project

Single-file Node.js Puppeteer script that automates daily task/time registration in the Daybeat web app. Spanish-language project. The only module outside `index.js` is `lib/jira-report.js` (Atlassian/Jira daily activity).

## Commands

- **Run:** `node index.js`
- **Install:** `npm install`
- **Rescan repos:** `node index.js --rescan` or `node diagnostic-commits.js --rescan`
- **Test Jira integration:** `node test-jira.js` (optionally with a date arg `DD/MM/YYYY`)
- No tests, lint, typecheck, or build steps exist.

## Environment

Requires `.env` (see `.env.example`) with: `LINK_DAYBEAT`, `COMPANY`, `USERNAME_DAYBEAT`, `PASSWORD`, `ROOT_DIR`. The script exits early if any of the first four are missing. `ROOT_DIR` is the directory where the script recursively searches for git repositories to extract commit information. Accepts both Linux paths (`/home/user/repos`) and Windows UNC paths (`//wsl.localhost/distro/home/user/repos`) — auto-detects the platform and converts. Use Linux paths if running from WSL, or UNC paths if running from Windows/Git Bash. Optional: `GIT_AUTHOR_EMAIL` to filter commits by author (falls back to `git config user.email` from the first valid repo).

Optional AI configuration:
- `GEMINI_API_KEY`: API key for Google Gemini AI. If provided, enables AI-generated summaries.
- `GEMINI_MODEL`: Model to use (defaults to `gemini-3.1-flash-lite`).

Optional Jira configuration (enables mode 5 "Con información de Jira"):
- `ATLASSIAN_ENABLED=true`: activates the module with **OAuth 2.1** — the first run opens the browser to authorize (one-time; the browser brings the identity, no email/token needed; tokens persisted in `.daybeat-jira-tokens.json` with automatic refresh; no org admin dependency).
- `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`: optional; when both are set, uses silent Basic auth instead of OAuth. NOTE: the official MCP server only accepts API tokens if the org admin enables that auth method — if not, MCP issues fail but REST (comments/worklogs) still works.
- `ATLASSIAN_CLOUD_ID` / `ATLASSIAN_SITE_URL`: optional overrides; by default the site is auto-detected.

## Jira report module (`lib/jira-report.js`)

Module (the only one outside `index.js`) that fetches daily activity from Jira. Consumed by BOTH the single-registration mode 5 and the bulk registration — no duplicated logic.

- **API**: `isConfigured()`, `getDailyActivity(date)` → `{ issues, comments, worklogs }`, `formatActivityForReport(data)`, `closeConnection()`.
- **Issues via MCP**: official Atlassian Rovo MCP server. Auth is either OAuth 2.1 (`https://mcp.atlassian.com/v1/mcp/authv2`, `OAuthClientProvider` custom implementation in `lib/jira-report.js` with loopback redirect + DCR + auto-refresh) or Basic `base64(email:token)` (`/v1/mcp`) when `ATLASSIAN_API_TOKEN` is set. Tool `searchJiraIssuesUsingJql` with JQL `assignee = currentUser() AND (statusCategory = "In Progress" OR (statusCategory = Done AND resolutiondate >= startOfDay("YYYY-MM-DD")))` — "In Progress" issues always (status is the signal, not the date), Done only when resolved today, "To Do" never — plus `getAccessibleAtlassianResources` (cloudId) and `atlassianUserInfo` (accountId).
- **Comments & worklogs via REST**: the official MCP has NO comment/worklog-read tools, so `lib/jira-report.js` calls the Jira Cloud REST API (`/rest/api/3/issue/{key}/comment`, `/rest/api/3/issue/{key}/worklog?started=...`), filtering by the authenticated accountId and the target date. Comments use a BROADER JQL than the report issues (`assignee = currentUser() OR updated >= startOfDay("YYYY-MM-DD")`) so comments made on "To Do" issues are still found; the comment `body` comes back as an ADF object (not a string) and must be flattened via `bodyToText()`. In OAuth mode the REST calls go to `https://api.atlassian.com/ex/jira/{cloudId}` with the OAuth access token; in Basic mode they use the site URL with the personal token.
- **Free usage**: only non-beta tools are used; beta tools (`searchAtlassian`, Teamwork Graph) are avoided because they may become paid (Rovo credits).
- **Failure model**: module never throws toward the registration flow — callers catch errors and degrade gracefully (the report continues without Jira data).
- Tool call arguments are adapted to the real tool schema via `client.listTools()` (argument names vary between servers).

## Key facts

- **Interactive script** — uses `readline` for user prompts (category, transaction type, mode selection, dates, etc.). Cannot run non-interactively or in CI.
- **Puppeteer runs headed** (`headless: false`, visible window) so a user can watch and intervene — unless `HEADLESS=true` is set in `.env` (launch reads `headless: process.env.HEADLESS === 'true'`). `HEADLESS=true` also suppresses the Jira OAuth `openBrowser()` (the authorization URL is printed to console instead of opening a window).
- **Frame-based navigation** — Daybeat uses named iframes (`uno`, `tres`). Most DOM interaction targets `frame.name() === 'tres'`; menu hover targets `frame.name() === 'uno'`.
- **All logic lives in `index.js`** — no entrypoint config beyond `"main": "index.js"`. The only exception is `lib/jira-report.js` (Jira daily activity), consumed by both single and bulk registration.
- **`bat/`** contains a Windows `.bat` runner and Task Scheduler XML for daily 5:10pm execution. Paths inside the `.bat` must be updated after cloning.
- **WSL/UNC repos need `-c safe.directory='*'`** — Git for Windows rejects WSL repositories with `fatal: detected dubious ownership` (files owned by another user). Every `git` invocation in `index.js` and `diagnostic-commits.js` uses the `GIT_SAFE_DIR` constant to disable the ownership check per command. GOTCHA: the flag must use DOUBLE quotes (`-c "safe.directory=*"`) — cmd.exe does not strip single quotes (git receives `''*''` literal and no exception matches), which is why single-quoted variants fail on Windows but work from WSL/bash. Some repos may have a manual `safe.directory` exception — e.g. `setup-moderno` — which is why a subset can work without the flag.
- **`/rest/api/3/search` was removed by Atlassian (410 Gone, CHANGE-2046)** — the Jira Cloud REST search endpoint moved to `/rest/api/3/search/jql` (same params). `expand=comments`/`fields=comment` in search are also gone; comments must be fetched per-issue (`/rest/api/3/issue/{key}/comment`).

## Automation modes

After selecting category and transaction type, the user chooses one of five modes (mode 5 only appears when `ATLASSIAN_ENABLED=true` or `ATLASSIAN_EMAIL` is set):

1. **Auto (today's commits)**: Searches `ROOT_DIR` recursively for `.git` repos, extracts today's commits filtered by author (via `GIT_AUTHOR_EMAIL` or `git config user.email`), summarizes messages using structured rules (feat/fix/refactor/docs/test/chore), and auto-fills title/date/hours/detail. Falls back to fake mode if no commits today.
2. **Con IA (Gemini)**: Uses Google Gemini AI to generate title and detail from commits. If `GEMINI_API_KEY` is configured, sends commits to Gemini and parses the JSON response. Falls back to default method if AI fails or no API key. If no commits today, uses commits from last 3 days.
3. **Auto fake**: Uses commits from the last 7 days (filtered by author) to generate a structured summary. Reuses the last-used schedule from `.daybeat-history.json` (defaults to 0730-1630).
4. **Manual**: Original interactive flow — prompts for each field.
5. **Con información de Jira**: fetches `getDailyActivity(today)` from `lib/jira-report.js`, shows the Jira activity (issues/comments/worklogs), then an interactive checkbox (`selectJiraActivityMulti`, via `@inquirer/checkbox` — ESM-only, loaded with dynamic `import()` from CommonJS; space toggles, `a` selects all, enter confirms) lets the user pick which items (grouped with `Separator`s: Incidencias / Comentarios / Worklogs) go into the context; the first option "Seleccionar todos" selects everything, otherwise only the checked ones. The selected activity is then formatted and passed as `extraContext` to `generateWithGemini` or appended to the default detail when no AI. Requires `ATLASSIAN_ENABLED=true` (or `ATLASSIAN_EMAIL`).

All auto modes show a preview and ask for confirmation before submitting. If declined, falls back to manual input. When the user picks "2: Varios bloques" (modes 1/2/5), the single-block confirmation is DEFERRED: the summary shows, then "BLOQUES PROPUESTOS" is displayed and asked first; the single-block "¿Desea continuar con estos datos?" is asked only if the blocks are rejected or there's not enough activity (blocks === null).

In modes 1, 2 and 5 the script additionally asks how to register the day: "1: Un solo bloque" (original behavior, one transaction with the full jornada) or "2: Varios bloques según actividad" — splits the day into up to 4 contiguous blocks (GAP_MINUTES=60, MIN_BLOCK=30) based on activity timestamps (commits and, in mode 5, Jira comments/worklogs). Block times are computed by `buildDayBlocks(events, startTime, endTime)`: proportional allocation rounded to 30min with the last block absorbing the remainder, so blocks ALWAYS sum to the exact single-block total. Each block gets its own summary + transaction. Requires ≥2 events with valid times (fallback to a single block otherwise). Bulk registration always uses one block per day.

Key facts for the blocks flow:
- `getCommitsWithTime(repoPath, dateStr, author)` returns `{message, time}` using `git log --format="%s|%ai"`; `time` is the author-local HH:MM (substring 11,16 of the ISO string).
- Jira comment/worklog timestamps are UTC → converted with `isoToLocalHHMM` (local machine timezone); worklog weight = `parseTimeSpentHours(timeSpent)` (e.g. "2h 30m" → 2.5, min 0.5).
- The blocks loop lives in `registerNewTransaction` after the summary preview: it captures the form URL, temporarily removes the global dialog listener (`page.removeAllListeners('dialog')`), and for each block re-navigates to the form URL (`window.location.href` + `waitForNavigation` + `delay(1500)` + re-find frame `tres` + `waitForSelector('select')`) for blocks after the first. Per-block dialog is awaited with `page.once('dialog')` BEFORE clicking submit (8s timeout; success = message includes "éxitosamente"). After the loop the global handler `handleGlobalDialog` is re-registered and `saveHours(first.start, last.end)` persists the jornada.
- **Block content is generated BEFORE the preview** (right after `buildDayBlocks` + free-slot adjustment), stored in `block.title`/`block.detail`, so the "BLOQUES PROPUESTOS" preview shows the EXACT title+detail that will be submitted (the loop only fills the form with those). With `GEMINI_API_KEY` in modes 2 AND 5, each block gets its own `generateWithGemini` call: commits (or Jira labels when the block has no commits) as activity source, `extraContext` = combined Jira labels + issues (block issues go to the max-activity block) + `userExtraContext` (mode 2, first block only). Fallback without AI: `summarizeCommits`/`generateDetail` for commit blocks; `Actividad en Jira: <first label>` for jira-only blocks; Jira context appended to the detail. The day-wide AI summary (RESUMEN CON JIRA) is kept as preview even when blocks are chosen (each block still gets its own call).
- The single-block submit dialog is handled by a module-level `handleGlobalDialog(dialog, page, browser)` (extracted from the original anonymous listener) registered at the top-level flow (line ~2913); it calls `finishOrContinue` on success and closes everything on error.

Duplicate-registration guard (all individual modes 1-5, before the blocks proposal):
- `getExistingRanges(frameTree, page, dateStr, currentUser, catValue, transValue)` navigates from the creation form (`transaccionesint_crear.asp`) to the item detail (`itemsint_actualizar.asp` — SAME query params, only the script name changes), reads page 1 of the transactions table and derives each day's ranges: the "Fecha Transacción" column shows the FINAL time and "Tiempo" the minutes → `start = fin − duración`. Returns `{ranges, count}` or `null` (fail-open). Then navigates back to the form and re-selects category/transaction (the dependent select needs `delay(1500)`).
- If the target day already has registrations by the current user (`getCurrentUser`, filtered by "Usuario Transacción"), the script shows each range (`0730 - 1030 (desc)`) and asks "¿Desea registrar de todos modos? (si/no): " — NO hard block, because Daybeat's overlap check is by date AND time (registering another block with different hours is valid). If "no" → "Registro cancelado (día ya registrado)" + `finishOrContinue(page, page.browser())`.
- In blocks mode, `intersectBlocksWithFree(blocks, occupiedRanges, startTime, endTime)` reshapes the proposed blocks to the FREE slots (jornada minus occupied ranges): a block may split into pieces ≥30min, events distribute in order to the pieces, blocks fully inside occupied ranges are dropped, and if a block has fewer events than pieces it keeps only the biggest piece (avoids empty blocks). Returns null if no free slot remains → fallback to single block (already covered by the warning).
- Block-loop failure no longer kills the app: it detects `message.includes('traslapa')` for a specific message and, on any failure, calls `finishOrContinue` (back to the menu) instead of `closeConnection()/rl.close()/browser.close()`.

## Bulk registration of missing days

The main menu includes option "3. Registro masivo de días sin registro" which:
1. Logs into Daybeat
2. Navigates through all projects and items to find missing registration days
3. Shows the list of business days without registrations
4. Asks user to select ONCE: section, item, category, and transaction type
5. If Jira is configured (either OAuth or API token), asks ONCE whether to include Jira info (issues/comments/worklogs) in the reports
6. For each missing day:
   - Gets commits from that specific day (filtered by author)
   - If no commits that day, uses commits from last 3 days before that date
   - If Jira is enabled, fetches `getDailyActivity(day)` for that specific date and passes it as `extraContext` to Gemini (or appends it to the detail when no AI)
   - If `GEMINI_API_KEY` is configured, uses Gemini AI to generate title and detail
   - Falls back to default commit-based summary if AI fails or no API key
   - Registers the transaction with default schedule (from `.daybeat-history.json`)
   - Handles dialog confirmation (registers listener BEFORE submit to avoid race condition)
   - Handles errors gracefully (continues with next day)
7. Shows final summary with:
   - Total days processed
   - Successfully registered days
   - Days with errors (if any)

This feature automates filling in missing registrations for the last month, using commit-based summaries for each day.

## Missing registrations report

The main menu includes option "2. Ver días sin registro" which:
1. Logs into Daybeat
2. Navigates through all projects and items
3. Extracts transaction dates from the "Fecha Transacción" column (handles pagination automatically)
4. Compares against business days (Mon-Fri) from the last 30 days
5. Shows which business days have no registrations

This feature iterates through all projects and items to collect all transaction dates, which can take several minutes depending on the number of projects. Pagination is handled automatically when an item has more than ~15 transactions.

## Missing registrations report

The main menu includes option "2. Ver días sin registro" which:
1. Logs into Daybeat
2. Navigates through all projects and items
3. Extracts transaction dates from the "Fecha Transacción" column (handles pagination automatically)
4. Compares against business days (Mon-Fri) from the last 30 days
5. Shows which business days have no registrations

This feature iterates through all projects and items to collect all transaction dates, which can take several minutes depending on the number of projects. Pagination is handled automatically when an item has more than ~15 transactions.

## Commit summary rules

Commits are categorized by conventional commit prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). The summary is structured as: "Implementación de: X. Correcciones: Y. Refactorización: Z." Limited to 200 chars.

## AI integration (Gemini)

When `GEMINI_API_KEY` is configured, the script can use Google Gemini AI to generate more natural and detailed summaries:

- **Function**: `generateWithGemini(commits)` sends commits to Gemini API and parses JSON response
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/interactions` (uses `x-goog-api-key` header)
- **Model**: Uses `GEMINI_MODEL` env var (defaults to `gemini-3.1-flash-lite`)
- **Prompt**: Asks for title (max 100 chars) and detail (max 500 chars) in Spanish
- **Retry logic**: Implements exponential backoff retry (up to 4 attempts) for 503 errors and timeouts
- **Fallback**: If AI fails or no API key, falls back to default rule-based summary
- **Usage**: 
  - Available as option 2 "Con IA (Gemini)" in single registration mode
  - Used automatically in bulk registration if API key is present
  - Shows "✓ Generado con Gemini AI" or "✗ IA falló, usando método por defecto" in console

## Commit retrieval functions

- **`getTodayCommits(repoPath, author)`**: Gets commits from today (since 00:00:00).
- **`getRecentCommits(repoPath, days, author)`**: Gets commits from the last N days (calculated from today).
- **`getCommitsForDate(repoPath, dateStr, author)`**: Gets commits from a specific date (DD/MM/YYYY format).
- **`getRecentCommitsBeforeDate(repoPath, dateStr, days, author)`**: Gets commits from N days before a specific date. Used as fallback when no commits exist on the target date.
- **`getRecentCommitsBeforeDate(repoPath, dateStr, days, author)`**: Gets commits from N days before a specific date. Used as fallback when no commits exist on the target date.

## Persistence

- `.daybeat-history.json`: stores the last-used start/end times for fake mode.
- `.daybeat-repos.json`: caches discovered git repositories (auto-refresh after 7 days). Supports `--rescan` flag to force refresh. Added to `.gitignore`.
- `.daybeat-path.json`: caches the daily registration path (section, item, category, transaction type). Auto-updates after each successful registration. Prompts user to reuse cached path on next registration. Added to `.gitignore`.
- `.daybeat-jira-tokens.json`: persists the OAuth 2.1 tokens of the Jira module (client info, tokens, discovery state). Auto-refresh on every run; interactive re-auth only when the refresh fails. Added to `.gitignore`.
- `holidays.json`: stores holidays for the current year (format: `{ "year": 2026, "holidays": ["DD/MM/YYYY", ...] }`). Auto-prompts for update when year changes. Shared between users (not in `.gitignore`).

## Main menu

The main menu includes:
1. Registrar actividad
2. Ver días sin registro
3. Registro masivo de días sin registro
4. **Corregir / mover registro**
5. Re-escanear repositorios
6. Salir

## Corregir / mover registro (menu option 4)

Daybeat does NOT expose transaction deletion in its UI (verified against the real app: no delete button/link in `itemsint_actualizar.asp` or `transaccionesint_actualizar.asp`, no `*_eliminar.asp`/`*_borrar.asp` scripts, no hidden delete params). The only server-supported mutation besides create is the **UPDATE** of `transaccionesint_actualizar.asp` (POST `transaccionesint_actualizar2.asp`). "Eliminar" a registration = correct or move it (e.g. change the date to free a wrongly-registered day).

Flow of `correctRegistration(page, browser, ...)` (menu option 4):
1. Logs into Daybeat (own login, like options 2/3) and gets the current user (`getCurrentUser`) to filter the listing.
2. Navigates Requerimientos -> Consultar -> section -> item (reuses the cached path with confirmation). The item's NAME link goes to the detail page (`itemsint_actualizar.asp`), unlike the registration flow which uses the create-transaction link.
3. Asks for the target date (DD/MM/AAAA, default today) and lists that day's transactions via `parseTransactionTable` (start - end + description).
4. User picks one; the script navigates to its update form (`row.updateHref`, captured from the UPD link `upd_trans=1&id2=N`), reads the current values with `readTransactionForm`, and prompts per editable field (Enter keeps the current value): category, transaction type, description, date, start/end time, detail.
5. Shows a changes preview, asks for confirmation, and submits with `updateTransaction` (dialog handled with the same `page.once('dialog')` pattern as the blocks loop; success = message contains "exitosamente").

Reusable pieces:
- `parseTransactionTable(frameTree, targetDate, currentUser)` — parses the transactions table of the item detail page; returns `[{start, end, desc, id2, updateHref}]`. Also used by `getExistingRanges` (duplicate-guard in the registration flow) — no contract change (extra fields are harmless).
- `readTransactionForm(frameTree)` — reads the current state of the update form (selected category/type, text fields, option lists).
- `updateTransaction(frameTree, page, updateHref = null, fields)` — core: navigates to the update form (if href given) and applies only the `fields` present (`category`, `transactionType`, `descripcion`, `fecha` DDMMYYYY, `horaini`, `horafin`, `detalle`), leaving the rest unchanged; submits with dialog handling; returns `{success, message}` without closing anything. Field order mirrors the create form: category first (dependent select, 1500ms delay), then type, then text fields.

Notes:
- If the new date/time overlaps another transaction, Daybeat rejects with a "traslapa" alert: reported and the user can retry.
- `parseTransactionTable` reads page 1 of the transactions table (like `getExistingRanges`); the target date is usually the first row (descending order).
