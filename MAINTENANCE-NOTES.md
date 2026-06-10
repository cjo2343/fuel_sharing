# Maintenance notes

## Current architecture

The app is mostly frontend-driven and uses Supabase for authentication, storage, realtime sync, and row-level security. `server.py` serves static files and handles push-notification endpoints that require server-side secrets.

`app.js` still contains most application behavior. Pure formatting/date/number helpers have been extracted to `utils.js`; keep that file free of DOM, Supabase, and application state dependencies.

## Security model

- Supabase Auth identifies the signed-in user.
- `ledger_members.email` maps an auth email to a ledger member.
- RLS policies use helper functions such as `is_ledger_member`, `is_ledger_admin`, `can_manage_trip`, and `can_manage_fuel_payment`.
- Admins can manage the ledger broadly.
- Normal members can read ledger data but should only write records they are allowed to manage.

## Known legacy compromise

`car_share_ledgers` remains a broad JSON backup/state table. Ledger members can update it for compatibility with the current app architecture. The normalized tables now have stricter RLS than this legacy JSON state.

Long-term goal: move fully to normalized tables and either remove `car_share_ledgers` writes from normal app flows or make that table admin-only.

## Safe refactor order

Refactor in small commits with validation after each step:

1. Extract constants/config helpers.
2. Continue extracting pure formatting/date/money helpers into `utils.js` as small, behavior-preserving moves.
3. Extract Supabase read/write helpers.
4. Extract trip form/render logic.
5. Extract fuel form/render logic.
6. Extract settlement logic.
7. Extract admin/diagnostics logic.
8. Extract notification helpers.

After each step, run:

```sh
node --check utils.js
node --check app.js
python3 -m py_compile server.py
python3 -m json.tool ledger-data.json
node tools/check-app-references.mjs
```

## Files that should not be committed

- `__pycache__/`
- `*.pyc`
- `.env`
- service-role keys
- private VAPID keys
- one-off local backup files
