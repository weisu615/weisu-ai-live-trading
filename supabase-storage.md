# Supabase storage setup

This project can persist the paper-live account state in Supabase while the Render web service stays on the free plan.

## 1. Create the table

Open Supabase SQL Editor and run:

```sql
create table if not exists public.weisu_bot_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

## 2. Copy Supabase values

In Supabase, open Project Settings -> API and copy:

- Project URL
- service_role key

Use the service role key only in Render environment variables. Do not put it in frontend code, GitHub, screenshots, or chat messages.

## 3. Set Render environment variables

In Render -> your web service -> Environment, add:

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role key |
| `SUPABASE_STATE_TABLE` | `weisu_bot_state` |
| `SUPABASE_STATE_ID` | `paper-live-btcusdt` |

Keep the existing variables:

- `NODE_ENV=production`
- `SYMBOL=BTCUSDT`
- `RMB_PER_USDT=7.2`
- `MAX_STAKE_USDT=8`

## 4. Redeploy and verify

Deploy the latest commit in Render, then open:

```txt
https://weisu.pw/api/state
```

Confirm:

```json
"storage": {
  "provider": "supabase",
  "stateId": "paper-live-btcusdt"
}
```

If it says `"local-file"`, one of the Supabase environment variables is missing or the table name is invalid.

## Notes

- The app stores one JSON state row, not individual trade rows.
- The JSON state includes balance, order history, the open order, rolling trade sequence, and recent review notes.
- The app still keeps a local fallback file, but Supabase is the source of truth whenever the Supabase variables are configured.
- The app keeps the latest 100 trades only. When trade 101 is saved, the oldest retained trade is dropped and the next sequence continues forward.
