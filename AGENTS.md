# AGENTS.md

## Project

Single-file Node.js Puppeteer script that automates daily task/time registration in the Daybeat web app. Spanish-language project. The only module outside `index.js` is `lib/jira-report.js` (Atlassian/Jira daily activity).

## Commands

- **Run:** `node index.js`
- **Install:** `npm install`
- **Rescan repos:** `node index.js --rescan` or `node diagnostic-commits.js --rescan`
- **Test Jira integration:** `node test-jira.js` (optionally with a date arg `DD/MM/YYYY`)
- **Test Clockify integration:** `node test-clockify.js` (optionally with a date arg `DD/MM/YYYY`) — diagnostic against the REAL API with the configured key: shows the key owner, ALL accessible workspaces, the raw time entries per workspace for the date (marking in-progress ones), and what the module consumes (`getDailyActivity` + formatted report). Read-only, does not touch the registration flow.
- **Tests:** `npm test` (`node --test lib/*.test.js`) — 59 tests: unit (time/summary/git/clockify/Jira OAuth), smoke (carga de módulos) y un harness E2E del flujo de registro con frames mockeados (`lib/register-flow.e2e.test.js`). Sin lint ni typecheck. GOTCHA: `lib/clockify.test.js` aísla el store en un archivo temporal (`CLOCKIFY_STORE_PATH`, configurable también por env) y `lib/jira-report.test.js` usa `JIRA_TOKEN_STORE_PATH` — NO deben tocar los stores reales del usuario.

## Environment

Requires `.env` (see `.env.example`) with: `LINK_DAYBEAT`, `COMPANY`, `USERNAME_DAYBEAT`, `PASSWORD`, `ROOT_DIR`. The script exits early if any of the first four are missing. `ROOT_DIR` is the directory where the script recursively searches for git repositories to extract commit information. Accepts both Linux paths (`/home/user/repos`) and Windows UNC paths (`//wsl.localhost/distro/home/user/repos`) — auto-detects the platform and converts. Use Linux paths if running from WSL, or UNC paths if running from Windows/Git Bash. Optional: `GIT_AUTHOR_EMAIL` to filter commits by author (falls back to `git config user.email` from the first valid repo).

Optional AI configuration:
- `GEMINI_API_KEY`: API key for Google Gemini AI. If provided, enables AI-generated summaries.
- `GEMINI_MODEL`: Model to use (defaults to `gemini-3.1-flash-lite`).
- AI providers can also be configured from the script itself via menu option "6. Configuración" (see the `lib/ai-config.js` section below) — no env vars needed. `GEMINI_API_KEY` in `.env` remains a valid fallback when no `.daybeat-ai.json` config exists.

Optional Jira configuration (enables mode 5 "Con información de Jira"):
- `ATLASSIAN_ENABLED=true`: activates the module with **OAuth 2.1** — the first run opens the browser to authorize (one-time; the browser brings the identity, no email/token needed; tokens persisted in `.daybeat-jira-tokens.json` with automatic refresh; the loopback callback is stable at `127.0.0.1:17890` by default and can be changed with `ATLASSIAN_OAUTH_CALLBACK_PORT`; no org admin dependency).
- `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`: optional; when both are set, uses silent Basic auth instead of OAuth. NOTE: the official MCP server only accepts API tokens if the org admin enables that auth method — if not, MCP issues fail but REST (comments/worklogs) still works.
- `ATLASSIAN_CLOUD_ID` / `ATLASSIAN_SITE_URL`: optional overrides; by default the site is auto-detected.

Optional Clockify configuration (enables mode 6 "Con toda la información"):
- **No OAuth**: the Clockify API authenticates only with a personal API key (`X-Api-Key`), generated in Profile Settings → Advanced → API Key (`https://clockify.me/user/settings`). Configured from the script via menu "6. Configuración" → "Conectar Clockify" (guided flow for non-technical users: paste key → verified against `GET /user` + `GET /workspaces` → only persisted if valid, in `.daybeat-clockify.json`) — no env vars needed. `CLOCKIFY_API_KEY` in `.env` remains a valid fallback.
- `CLOCKIFY_WORKSPACE_ID`: optional; when absent the first workspace of the account is auto-detected.
- `CLOCKIFY_BASE_URL`: optional regional base (e.g. `https://euc1.clockify.me/api/v1`); defaults to the global `https://api.clockify.me/api/v1`. The key belongs to the person → `GET /user` resolves their own userId and only their time entries are fetched.

## Jira report module (`lib/jira-report.js`)

Module (the only one outside `index.js`) that fetches daily activity from Jira. Consumed by BOTH the single-registration mode 5 and the bulk registration — no duplicated logic.

- **API**: `isConfigured()`, `getDailyActivity(date)` → `{ issues, comments, worklogs }`, `formatActivityForReport(data)`, `closeConnection()`.
- **Issues via MCP**: official Atlassian Rovo MCP server. Auth is either OAuth 2.1 (`https://mcp.atlassian.com/v1/mcp/authv2`, `OAuthClientProvider` custom implementation in `lib/jira-report.js` with stable loopback redirect + DCR + auto-refresh) or Basic `base64(email:token)` (`/v1/mcp`) when `ATLASSIAN_API_TOKEN` is set. Tool `searchJiraIssuesUsingJql` with JQL `assignee = currentUser() AND (statusCategory = "In Progress" OR (statusCategory = Done AND resolutiondate >= startOfDay("YYYY-MM-DD")))` — "In Progress" issues always (status is the signal, not the date), Done only when resolved today, "To Do" never — plus `getAccessibleAtlassianResources` (cloudId) and `atlassianUserInfo` (accountId).
- **Comments & worklogs via REST**: the official MCP has NO comment/worklog-read tools, so `lib/jira-report.js` calls the Jira Cloud REST API (`/rest/api/3/issue/{key}/comment`, `/rest/api/3/issue/{key}/worklog?started=...`), filtering by the authenticated accountId and the target date. Comments use a BROADER JQL than the report issues (`assignee = currentUser() OR updated >= startOfDay("YYYY-MM-DD")`) so comments made on "To Do" issues are still found; the comment `body` comes back as an ADF object (not a string) and must be flattened via `bodyToText()`. In OAuth mode the REST calls go to `https://api.atlassian.com/ex/jira/{cloudId}` with the OAuth access token; in Basic mode they use the site URL with the personal token.
- **Free usage**: only non-beta tools are used; beta tools (`searchAtlassian`, Teamwork Graph) are avoided because they may become paid (Rovo credits).
- **Failure model**: module never throws toward the registration flow — callers catch errors and degrade gracefully (the report continues without Jira data).
- Tool call arguments are adapted to the real tool schema via `client.listTools()` (argument names vary between servers).

## Clockify module (`lib/clockify.js`)

Module (like `lib/jira-report.js` and `lib/ai-config.js`) that fetches daily activity from Clockify (time entries with exact start/end). Consumed by mode 6 (single registration) and the bulk registration — no duplicated logic.

- **API**: `isConfigured()`, `getStatus()`, `connectWithKey(apiKey)` → `{ ok, message }` (verifies against `GET /user` + `GET /workspaces` and only persists if valid), `disconnect()`, `getDailyActivity(date)` → `{ date, entries: [{id, description, projectName, taskName, start, end, startLocal, endLocal, durationMin}] }`, `formatActivityForReport(data)`, `formatDuration(minutes)`, `parseISODuration(iso)` (ISO 8601 `PT1H30M` → minutes).
- **No OAuth**: the Clockify API only accepts personal API keys (`X-Api-Key` header). The key belongs to the person → `GET /user` resolves their own userId and only their entries are fetched (`GET /workspaces/{id}/user/{userId}/time-entries?start&end&page-size=500&hydrated=true`, paginated via `page` + `Last-Page` header, cap 5 pages).
- **Entries**: `hydrated=true` inlines `project`/`task` names; in-progress entries (running timer, no `timeInterval.end`) are INCLUDED marked `inProgress: true` with `end`/`durationMin` null — they anchor activity (shown as `[HH:MM - en curso]`) but don't count in totals; the day window is local midnight→midnight (UTC instants); `duration` is ISO 8601; `startLocal`/`endLocal` are machine-local HH:MM via `isoToLocalHHMM` (same as Jira).
- **Failure model**: module never throws toward the registration flow — `connectWithKey` returns `{ok:false}` and `getDailyActivity` returns empty data; callers degrade gracefully.

## Key facts

- **Interactive script** — uses `readline` for user prompts (category, transaction type, mode selection, dates, etc.). Cannot run non-interactively or in CI.
- **Puppeteer runs headed** (`headless: false`, visible window) so a user can watch and intervene — unless `HEADLESS=true` is set in `.env` (launch reads `headless: process.env.HEADLESS === 'true'`). `HEADLESS=true` also suppresses the Jira OAuth `openBrowser()` (the authorization URL is printed to console instead of opening a window).
- **Frame-based navigation** — Daybeat uses named iframes (`uno`, `tres`). Most DOM interaction targets `frame.name() === 'tres'`; menu hover targets `frame.name() === 'uno'`.
- **All logic lives in `index.js`** — no entrypoint config beyond `"main": "index.js"`. The only exceptions are `lib/jira-report.js` (Jira daily activity), `lib/clockify.js` (Clockify daily activity) and `lib/ai-config.js` (AI provider config: OpenCode Zen + Gemini), each consumed by both single and bulk registration.
- **`bat/`** contains a Windows `.bat` runner and Task Scheduler XML for daily 5:10pm execution. Paths inside the `.bat` must be updated after cloning.
- **WSL/UNC repos need `-c safe.directory='*'`** — Git for Windows rejects WSL repositories with `fatal: detected dubious ownership` (files owned by another user). Every `git` invocation in `index.js` and `diagnostic-commits.js` uses the `GIT_SAFE_DIR` constant to disable the ownership check per command. GOTCHA: the flag must use DOUBLE quotes (`-c "safe.directory=*"`) — cmd.exe does not strip single quotes (git receives `''*''` literal and no exception matches), which is why single-quoted variants fail on Windows but work from WSL/bash. Some repos may have a manual `safe.directory` exception — e.g. `setup-moderno` — which is why a subset can work without the flag.
- **Items page paginates at 15/page** — `itemsint.asp` lists items with the `page` URL param (0, 1, 2, ...) and image controls `3dw.gif` (next) / `3up.gif` (prev). Sections with >15 items (common for some users, e.g. jcarvajal: 35/59/97 items) spread across multiple pages. `collectAllItems(frameTree, page)` walks ALL pages (cap `ITEM_MAX_PAGES=20`, same navigation pattern as `extractRegistrations`: detect `3dw.gif` inside an `<a>`, `location.href`, wait for `page=N` via `navigateFrameRobust`, `delay(1500)`, re-find frame `tres`, dedupe by href) and returns per item `{text, href, createHref}` — `href` = item detail (`itemsint_actualizar.asp`), `createHref` = the row's penultimate link (`transaccionesint_crear.asp`, the create form used by registration flows). `selectItemAndNavigate(frameTree, page, items, navigateToDetail)` shows the numbered menu and navigates directly by href (detail or create). Item selection now paginates in: `listAndNavigateNewTransaction`, the cached-path item step (falls back to manual if the cached item is beyond page 0), `correctRegistration`, bulk-registration item pick, and the missing-days scans (`showMissingRegistrations` / `registerBulkMissingDays`). The SECTIONS list (`requerimientos.asp`) does NOT paginate (all sections shown; the `page_req` param is ignored).
- **All frame navigation goes through `navigateFrameRobust(page, triggerFn, urlPredicate, timeoutMs)`** — the classic `click(); waitForNavigation();` pattern is fragile on fast LANs: the page loads so quickly that `waitForNavigation` misses the event (or the frame detaches mid-navigation) and crashes with a 30s `TimeoutError` (reported by users on Windows). The helper subscribes to the navigation BEFORE triggering it and, as a fallback, POLLS the frame URL until it matches the predicate (e.g. `u.includes('itemsint.asp')`, `/page_trans=[1-9]\d*/`, `u.includes('transaccionesint_crear.asp')`). `triggerFn` can be null when the navigation was already triggered (only polls). Login → `requerimientos.asp`, Consultar → `requerimientos.asp` (no `flag=resp`), search → `requerimientos.asp?flag=` (no `flag=resp`), section → `itemsint.asp`, item detail → `itemsint_actualizar.asp`, create form → `transaccionesint_crear.asp`, update form → `transaccionesint_actualizar.asp`, transactions pagination → `/page_trans=[1-9]\d*/`, items pagination → `page=N`.
- **`/rest/api/3/search` was removed by Atlassian (410 Gone, CHANGE-2046)** — the Jira Cloud REST search endpoint moved to `/rest/api/3/search/jql` (same params). `expand=comments`/`fields=comment` in search are also gone; comments must be fetched per-issue (`/rest/api/3/issue/{key}/comment`).
- **`input[type="image"]` submit must use JS click, not Puppeteer's `ft.click()`** — the real CDP click does NOT trigger form submission in headed mode (only the synthetic `btn.click()` does). This was the root cause of "no aparecen secciones para seleccionar": the search button never navigated to `requerimientos.asp?flag=`, so the section listing read the consult page (no `itemsint.asp` links) and showed an empty/absent menu. Both the main registration flow and `correctRegistration` use `frame.evaluate(() => document.querySelector('input[type="image"]').click())` for the search submit.
- **Section listing filters real section links** — `listElements(frame, 'a', 'itemsint.asp')` waits for `a[href*="itemsint.asp"]` (15s timeout) and filters out header/empty links before numbering the menu, so the user only sees real selectable sections (previously it listed table headers like "Proyecto"/"Asunto" and the empty logo link, shifting all indices).

## Automation modes

After selecting category and transaction type, the user chooses one of six modes (mode 5 only appears when `ATLASSIAN_ENABLED=true` or `ATLASSIAN_EMAIL` is set; mode 6 always appears but its guard offers to configure Clockify on the spot):

1. **Auto (today's commits)**: Searches `ROOT_DIR` recursively for `.git` repos, extracts today's commits filtered by author (via `GIT_AUTHOR_EMAIL` or `git config user.email`), summarizes messages using structured rules (feat/fix/refactor/docs/test/chore), and auto-fills title/date/hours/detail. Falls back to fake mode if no commits today.
2. **Con IA (Gemini)**: Uses Google Gemini AI to generate title and detail from commits. If `GEMINI_API_KEY` is configured, sends commits to Gemini and parses the JSON response. Falls back to default method if AI fails or no API key. If no commits today, uses commits from last 3 days.
3. **Auto fake**: Uses commits from the last 7 days (filtered by author) to generate a structured summary. Reuses the last-used schedule from `.daybeat-history.json` (defaults to 0730-1630).
4. **Manual**: Original interactive flow — prompts for each field.
5. **Con información de Jira**: fetches `getDailyActivity(today)` from `lib/jira-report.js`, shows the Jira activity (issues/comments/worklogs), then an interactive checkbox (`selectJiraActivityMulti`, via `@inquirer/checkbox` — ESM-only, loaded with dynamic `import()` from CommonJS; space toggles, `a` selects all, enter confirms) lets the user pick which items (grouped with `Separator`s: Incidencias / Comentarios / Worklogs) go into the context; the first option "Seleccionar todos" selects everything, otherwise only the checked ones. The selected activity is then formatted and passed as `extraContext` to `generateWithGemini` or appended to the default detail when no AI. Requires `ATLASSIAN_ENABLED=true` (or `ATLASSIAN_EMAIL`).
6. **Con toda la información (Git + Jira + Clockify)**: combines commits + Jira (if configured) + Clockify (if configured). Guard for non-technical users: if no Clockify key is configured, it asks "¿Desea configurar Clockify ahora?" and runs the guided connect flow (`connectClockifyFlow` in `lib/flows/clockify-config.js`: paste key → verify against `GET /user` + `GET /workspaces` → save only if valid); only continues in mode 6 if the verification succeeded, otherwise falls back to manual. Selection is UNIFIED via `selectActivityMulti` (generalized `selectJiraActivityMulti`, groups: Incidencias/Comentarios/Worklogs de Jira + Entradas de Clockify with `[HH:MM - HH:MM]` ranges and durations); the combined context (Jira + Clockify) feeds `generateWithGemini` or the default detail. Fallback titles: commits → first Jira issue → first Clockify entry → fake summary. Clockify entries carry EXACT start/end, so in blocks mode they are the most reliable events (`kind: 'clockify'`, weight = duration/60, min 0.5).

All auto modes show a preview and ask for confirmation before submitting. If declined, falls back to manual input. When the user picks "2: Varios bloques" (modes 1/2/5/6), the single-block confirmation is DEFERRED: the summary shows, then "BLOQUES PROPUESTOS" is displayed and asked first; the single-block "¿Desea continuar con estos datos?" is asked only if the blocks are rejected or there's not enough activity (blocks === null).

In modes 1, 2, 5 and 6 the script additionally asks how to register the day: "1: Un solo bloque" (original behavior, one transaction with the full jornada) or "2: Varios bloques según actividad" — splits the day into up to 4 contiguous blocks (GAP_MINUTES=60, MIN_BLOCK=30) based on activity timestamps (commits and, in mode 5, Jira comments/worklogs; in mode 6 also Clockify entries). Block times are computed by `buildDayBlocks(events, startTime, endTime)`: proportional allocation rounded to 30min with the last block absorbing the remainder, so blocks ALWAYS sum to the exact single-block total. Each block gets its own summary + transaction. Requires ≥2 events with valid times (fallback to a single block otherwise). Bulk registration always uses one block per day.

Key facts for the blocks flow:
- `getCommitsWithTime(repoPath, dateStr, author)` returns `{message, time}` using `git log --format="%s|%ai"`; `time` is the author-local HH:MM (substring 11,16 of the ISO string).
- Jira comment/worklog timestamps are UTC → converted with `isoToLocalHHMM` (local machine timezone); worklog weight = `parseTimeSpentHours(timeSpent)` (e.g. "2h 30m" → 2.5, min 0.5).
- The blocks loop lives in `registerNewTransaction` after the summary preview: it captures the form URL, temporarily removes the global dialog listener (`page.removeAllListeners('dialog')`), and for each block re-navigates to the form URL (`window.location.href` + `navigateFrameRobust` poll for `transaccionesint_crear.asp` + `delay(1500)` + re-find frame `tres` + `waitForSelector('select')`) for blocks after the first. Per-block dialog is awaited with `page.once('dialog')` BEFORE clicking submit (8s timeout; success = message includes "éxitosamente"). After the loop the global handler `handleGlobalDialog` is re-registered and `saveHours(first.start, last.end)` persists the jornada.
- **Block content is generated BEFORE the preview** (right after `buildDayBlocks` + free-slot adjustment), stored in `block.title`/`block.detail`, so the "BLOQUES PROPUESTOS" preview shows the EXACT title+detail that will be submitted (the loop only fills the form with those). With `GEMINI_API_KEY` in modes 2, 5 AND 6, each block gets its own `generateWithGemini` call: commits (or Jira labels, or Clockify labels, when the block has no commits) as activity source, `extraContext` = combined Jira/Clockify labels + issues (block issues go to the max-activity block) + `userExtraContext` (mode 2, first block only). Fallback without AI: `summarizeCommits`/`generateDetail` for commit blocks; `Actividad en Jira: <first label>` for jira-only blocks; `Actividad: <first label>` for clockify-only blocks; Jira/Clockify context appended to the detail. The day-wide AI summary (RESUMEN CON TODA LA INFORMACIÓN) is kept as preview even when blocks are chosen (each block still gets its own call).
- The single-block submit dialog is handled by a module-level `handleGlobalDialog(dialog, page, browser)` (extracted from the original anonymous listener) registered at the top-level flow (line ~2913); it calls `finishOrContinue` on success and closes everything on error.

Duplicate-registration guard (all individual modes 1-6, before the blocks proposal):
- `getExistingRanges(frameTree, page, dateStr, currentUser, catValue, transValue)` navigates from the creation form (`transaccionesint_crear.asp`) to the item detail (`itemsint_actualizar.asp` — SAME query params, only the script name changes), reads page 1 of the transactions table and derives each day's ranges: the "Fecha Transacción" column shows the FINAL time and "Tiempo" the minutes → `start = fin − duración`. Returns `{ranges, count}` or `null` (fail-open). Then navigates back to the form and re-selects category/transaction (the dependent select needs `delay(1500)`).
- If the target day already has registrations by the current user (`getCurrentUser`, filtered by "Usuario Transacción"), the script shows each range (`0730 - 1030 (desc)`) and asks "¿Desea registrar de todos modos? (si/no): " — NO hard block, because Daybeat's overlap check is by date AND time (registering another block with different hours is valid). If "no" → "Registro cancelado (día ya registrado)" + `finishOrContinue(page, page.browser())`.
- In blocks mode, `intersectBlocksWithFree(blocks, occupiedRanges, startTime, endTime)` reshapes the proposed blocks to the FREE slots (jornada minus occupied ranges): a block may split into pieces ≥30min, events distribute in order to the pieces, blocks fully inside occupied ranges are dropped, and if a block has fewer events than pieces it keeps only the biggest piece (avoids empty blocks). Returns null if no free slot remains → fallback to single block (already covered by the warning).
- Block-loop failure no longer kills the app: it detects `message.includes('traslapa')` for a specific message and, on any failure, calls `finishOrContinue` (back to the menu) instead of `closeConnection()/rl.close()/browser.close()`.

## Bulk registration of missing days

The main menu includes option "3. Registro masivo de días sin registro" which:
1. Logs into Daybeat
2. Asks for the period to register (1: último mes, 2: últimos 2 meses, 3: últimos 3 meses, 4: últimos 15 días, 5: últimos 7 días — `askPeriod`, shared with option 2)
3. Uses the per-user registrations cache (`.daybeat-registrations.json`) when it covers the requested period: asks each run "cache/reescan" (default cache) and skips the slow project/item walk; auto-rescans when the period starts before the cached `scannedFrom` window. First run (or rescan) walks all projects/items and persists the result.
4. Shows the list of business days without registrations
5. Asks user to select ONCE: section, item, category, and transaction type
6. If Jira is configured (either OAuth or API token), asks ONCE whether to include Jira info (issues/comments/worklogs) in the reports; same for Clockify (if no key yet, offers the guided connect flow `connectClockifyFlow` and only includes it if the verification succeeds)
7. For each missing day:
   - Gets commits from that specific day (filtered by author)
   - If no commits that day, uses commits from last 3 days before that date
   - If Jira is enabled, fetches `getDailyActivity(day)` for that specific date and passes it as `extraContext` to the AI (or appends it to the detail when no AI); if Clockify is enabled, its per-day entries are appended to the same context
   - If the AI is configured (`.daybeat-ai.json` or `GEMINI_API_KEY`), uses it to generate title and detail
   - Falls back to default commit-based summary if AI fails or no API key
   - Registers the transaction with default schedule (from `.daybeat-history.json`)
   - Handles dialog confirmation (registers listener BEFORE submit to avoid race condition)
   - Handles errors gracefully (continues with next day)
8. Shows final summary with:
   - Total days processed
   - Successfully registered days
   - Days with errors (if any)
9. Merges the successfully registered days into the registrations cache before closing, so a second run skips them without re-scanning

This feature automates filling in missing registrations, using commit-based summaries for each day.

## Missing registrations report

The main menu includes option "2. Ver días sin registro" which:
1. Logs into Daybeat
2. Asks for the period (last month / 2 / 3 months / 15 days / 7 days — `askPeriod`)
3. Uses the per-user registrations cache when it covers the period (asks "cache/reescan", default cache); otherwise navigates through all projects and items
4. Extracts transaction dates from the "Fecha Transacción" column (handles pagination automatically)
5. Compares against business days (Mon-Fri) of the selected period
6. Shows which business days have no registrations

This feature iterates through all projects and items to collect all transaction dates, which can take several minutes depending on the number of projects (skipped when the cache is used). Pagination is handled automatically when an item has more than ~15 transactions.

## Missing registrations report

The main menu includes option "2. Ver días sin registro" which:
1. Logs into Daybeat
2. Asks for the period (last month / 2 / 3 months / 15 days / 7 days — `askPeriod`)
3. Uses the per-user registrations cache when it covers the period (asks "cache/reescan", default cache); otherwise navigates through all projects and items
4. Extracts transaction dates from the "Fecha Transacción" column (handles pagination automatically)
5. Compares against business days (Mon-Fri) of the selected period
6. Shows which business days have no registrations

This feature iterates through all projects and items to collect all transaction dates, which can take several minutes depending on the number of projects (skipped when the cache is used). Pagination is handled automatically when an item has more than ~15 transactions.

## Commit summary rules

Commits are categorized by conventional commit prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). The summary is structured as: "Implementación de: X. Correcciones: Y. Refactorización: Z." Limited to 200 chars.

## AI integration (`lib/ai-config.js`)

Central module (like `lib/jira-report.js`) that manages AI providers for title/detail generation. Consumed by `generateWithGemini` in `index.js` (same signature, same prompt, same JSON parsing) — no duplicated logic.

- **Providers**: `opencode` (OpenCode Zen, free `*-free` models via the free opencode account) and `gemini` (Google Gemini). One is ACTIVE at a time; `isAIEnabled()` replaces all `process.env.GEMINI_API_KEY` checks.
- **Store**: `.daybeat-ai.json` (gitignored) — `{ activeProvider, providers: { opencode: {apiKey, model, source}, gemini: {apiKey, model} } }`. If no store exists, `GEMINI_API_KEY`/`GEMINI_MODEL` from `.env` keep working as before (fallback to gemini provider).
- **OpenCode Zen login** (menu "6. Configuración" → "2. Conectar OpenCode Zen"): `detectOpenCodeKey()` reads the CLI's `~/.local/share/opencode/auth.json` (Windows: `%USERPROFILE%\.local\share\opencode\auth.json`) and imports `opencode.key` (fallback `opencode-go.key`); if absent, opens `https://opencode.ai/auth` (`openBrowser`, respects `HEADLESS`) and asks to paste the key. There is NO OAuth — Zen authenticates with an API key.
- **Zen endpoint**: OpenAI-compatible `POST https://opencode.ai/zen/v1/chat/completions` with `Authorization: Bearer <key>` → `data.choices[0].message.content`. The model list is fetched LIVE from `GET https://opencode.ai/zen/v1/models` (`getZenModels`, cached 24h in `.daybeat-ai.json` as `modelsCache`, fallback to hardcoded `ZEN_FREE_MODELS`); free models are identified by the `-free` suffix (`isFreeModel`). Free models (default `deepseek-v4-flash-free`): `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `laguna-s-2.1-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `big-pickle`. NOTE: free models rate-limit per account (`FreeUsageLimitError` 429); retries happen, but switching models may be needed.
- **Gemini endpoint**: unchanged `https://generativelanguage.googleapis.com/v1beta/interactions` (`x-goog-api-key`).
- **Retry**: `fetchWithRetry` — up to 4 attempts, exponential backoff, for 503/429 and network timeouts. Returns the model's RAW text; `generateWithGemini` parses the JSON `{title, detail}` and truncates (unchanged).
- **Failure model**: module never throws toward the registration flow — `callAI`/`testConnection` return null/`{ok:false}` and callers fall back to rule-based summaries.
- **Menu "6. Configuración"** (before "Salir", no Daybeat login needed): change active provider, connect OpenCode Zen, set Gemini key, change model, test connection, connect/disconnect Jira (`connectJiraFlow`/`disconnectJiraFlow`, OAuth/API token without starting a registration), and connect Clockify (guided API key flow `connectClockifyFlow`).

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
- `.daybeat-ai.json`: persists the AI provider config (active provider, API keys, models, opencode key source). Created/edited from menu "6. Configuración". Added to `.gitignore`.
- `.daybeat-clockify.json`: persists the Clockify API key + resolved profile (workspaceId, userId, names). Created from menu "6. Configuración" → "Conectar Clockify" or the mode-6/bulk guards (`connectWithKey` only persists after verifying against the API). `CLOCKIFY_API_KEY` in `.env` remains a valid fallback. Added to `.gitignore`.
- `.daybeat-registrations.json`: caches per user (keyed by the detected Daybeat user) the dates that already have registrations, with `scannedFrom` (start of the scanned window) and `lastScan`. Used by options 2 and 3 to skip the slow project/item walk on repeat runs — asks each run "cache/reescan" (default cache), auto-rescans when the requested period starts before `scannedFrom`, and is updated after every full scan and after successful bulk registrations. Added to `.gitignore`.
- `holidays.json`: stores holidays for the current year (format: `{ "year": 2026, "holidays": ["DD/MM/YYYY", ...] }`). Auto-prompts for update when year changes. Shared between users (not in `.gitignore`).

## Main menu

The main menu includes:
1. Registrar actividad
2. Ver días sin registro
3. Registro masivo de días sin registro
4. **Corregir / mover registro**
5. Re-escanear repositorios
6. **Configuración**
7. Salir

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

## Lección: frames obsoletos tras navegar dentro del flujo (bug "nunca termina")

Bug real (usuario jcarvajal): tras confirmar "sí" en el registro con Jira, el script quedaba "nunca termina" y el formulario mostraba texto residual (`ée`, `ééo ééo`). Causas y la regla que hay que respetar:

1. **Los objetos Frame de Puppeteer se recrean en cada navegación del iframe.** `getExistingRanges` navega frame tres (formulario → detalle → formulario). El `frameTree` que tenía el caller queda OBSOLETO. Escribir sobre él falla en silencio. **Regla: tras cualquier función que navegue un frame dentro del flujo, re-adquirir el frame** (`frameTree = page.frames().find(f => f.name() === 'tres')`) **y esperar el formulario** (`waitForSelector('select')`) antes de seguir.
2. **No usar `frame.type` para rellenar campos de texto.** Agrega texto (no reemplaza) y es frágil con Unicode/saltos de línea. Usar `setFieldValue(frame, selector, value)` (lib/daybeat.js): setter por DOM (`$eval` con `input`+`change`), reemplaza el contenido y maneja acentos/newlines. Es el mismo patrón que `updateTransaction`.
3. **Toda llamada a un flujo asíncrono de menú debe tener `await` + `try/catch`.** La llamada inicial a `registerNewTransaction` en `index.js` no tenía `await`, así que cualquier rechazo (p. ej. escribir sobre un frame muerto) quedaba oculto y parecía que el "sí" se tragaba la ejecución.

Harness de prevención: `lib/register-flow.e2e.test.js` mockea `page`/`frames` (page.frames() devuelve un array mutable), reemplaza solo `getExistingRanges` (simula la navegación reemplazando el frame 'tres' por uno nuevo), `getCurrentUser` y `delay`, y corre el flujo real de `register.js` con `setFieldValue` real. Verifica: (a) tras el guard se escribe en el frame NUEVO y nunca en el viejo, (b) se usa `setFieldValue` y jamás `frame.type`, (c) el valor reemplaza contenido residual (no agrega), (d) se envía el formulario. Si se reintroduce el bug (quitar la re-adquisición o volver a `type`), el test falla.
