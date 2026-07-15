# AGENTS.md

## Project

Single-file Node.js Puppeteer script that automates daily task/time registration in the Daybeat web app. Spanish-language project.

## Commands

- **Run:** `node index.js`
- **Install:** `npm install`
- No tests, lint, typecheck, or build steps exist.

## Environment

Requires `.env` (see `.env.example`) with: `LINK_DAYBEAT`, `COMPANY`, `USERNAME_DAYBEAT`, `PASSWORD`, `ROOT_DIR`. The script exits early if any of the first four are missing. `ROOT_DIR` is the directory where the script recursively searches for git repositories to extract commit information. Optional: `GIT_AUTHOR_EMAIL` to filter commits by author (falls back to `git config user.email` from the first valid repo).

Optional AI configuration:
- `GEMINI_API_KEY`: API key for Google Gemini AI. If provided, enables AI-generated summaries.
- `GEMINI_MODEL`: Model to use (defaults to `gemini-1.5-flash`).

## Key facts

- **Interactive script** — uses `readline` for user prompts (category, transaction type, mode selection, dates, etc.). Cannot run non-interactively or in CI.
- **Puppeteer runs headed** (`headless: false`) so a user can watch and intervene.
- **Frame-based navigation** — Daybeat uses named iframes (`uno`, `tres`). Most DOM interaction targets `frame.name() === 'tres'`; menu hover targets `frame.name() === 'uno'`.
- **All logic lives in `index.js`** — no modules, no entrypoint config beyond `"main": "index.js"`.
- **`bat/`** contains a Windows `.bat` runner and Task Scheduler XML for daily 5:10pm execution. Paths inside the `.bat` must be updated after cloning.

## Automation modes

After selecting category and transaction type, the user chooses one of four modes:

1. **Auto (today's commits)**: Searches `ROOT_DIR` recursively for `.git` repos, extracts today's commits filtered by author (via `GIT_AUTHOR_EMAIL` or `git config user.email`), summarizes messages using structured rules (feat/fix/refactor/docs/test/chore), and auto-fills title/date/hours/detail. Falls back to fake mode if no commits today.
2. **Con IA (Gemini)**: Uses Google Gemini AI to generate title and detail from commits. If `GEMINI_API_KEY` is configured, sends commits to Gemini and parses the JSON response. Falls back to default method if AI fails or no API key. If no commits today, uses commits from last 3 days.
3. **Auto fake**: Uses commits from the last 7 days (filtered by author) to generate a structured summary. Reuses the last-used schedule from `.daybeat-history.json` (defaults to 0730-1630).
4. **Manual**: Original interactive flow — prompts for each field.

All auto modes show a preview and ask for confirmation before submitting. If declined, falls back to manual input.

## Bulk registration of missing days

The main menu includes option "3. Registro masivo de días sin registro" which:
1. Logs into Daybeat
2. Navigates through all projects and items to find missing registration days
3. Shows the list of business days without registrations
4. Asks user to select ONCE: section, item, category, and transaction type
5. For each missing day:
   - Gets commits from that specific day (filtered by author)
   - If no commits that day, uses commits from last 3 days before that date
   - If `GEMINI_API_KEY` is configured, uses Gemini AI to generate title and detail
   - Falls back to default commit-based summary if AI fails or no API key
   - Registers the transaction with default schedule (from `.daybeat-history.json`)
   - Handles dialog confirmation (registers listener BEFORE submit to avoid race condition)
   - Handles errors gracefully (continues with next day)
6. Shows final summary with:
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
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- **Model**: Uses `GEMINI_MODEL` env var (defaults to `gemini-1.5-flash`)
- **Prompt**: Asks for title (max 100 chars) and detail (max 500 chars) in Spanish
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

`.daybeat-history.json` stores the last-used start/end times for fake mode. Added to `.gitignore`.
