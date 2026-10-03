<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Nebius/NVIDIA plan logic lives in pure `src/lib/hvac/core.ts` with injected env/fetch; the server function only reads env and delegates — keeps provider/validation logic unit-testable without the runtime.
- No silent demo fallback for generation: provider, config, and validation failures surface as explicit error codes — the demo must never show fabricated inference.
- Usage limits live in database tables written only by service-role SECURITY DEFINER functions under one advisory lock; `src/lib/hvac/limits.ts` wraps them via per-call hooks — keeps limits durable, race-free and unforgeable by users, while staying unit-testable with an in-memory store.
- Plan generation requires `requireSupabaseAuth`; limit-store errors fail closed (`LIMITS_UNAVAILABLE`) — a paid model must never run unmetered.
- Demo access is an allowlist table checked inside the service-role run/reserve database functions — unapproved accounts fail before any model call or budget reservation, and the browser can't bypass it.
