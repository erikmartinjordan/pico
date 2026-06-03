# Orange Fuji PRO licensing setup

PRO uses Supabase project `lfckwzwhaqujmibicxeg` and your Stripe live-mode account:

```text
https://lfckwzwhaqujmibicxeg.supabase.co
```

## Supabase project

Create or select the production Supabase project. The PRO deploy workflow reuses
the existing Supabase account token from PRE:

```text
SUPABASE_ACCESS_TOKEN
```

No PRO-specific Supabase deploy secret is required right now. No database
password is required here unless the Supabase CLI later asks for one.

`SUPABASE_PROJECT_REF_PRO` is the production project ref from the Supabase URL:

```text
https://lfckwzwhaqujmibicxeg.supabase.co
```

## Stripe secrets

Do not commit Stripe secrets to the repository. Store them in the production Supabase project Edge Function secrets:

```bash
npx supabase@latest secrets set STRIPE_SECRET_KEY="sk_live_..." --project-ref lfckwzwhaqujmibicxeg
npx supabase@latest secrets set STRIPE_WEBHOOK_SECRET="whsec_..." --project-ref lfckwzwhaqujmibicxeg
```

## Deploy

Run:

```text
Actions -> Deploy Supabase PRO -> Run workflow
```

The workflow runs the equivalent of:

```bash
npx supabase@latest link --project-ref lfckwzwhaqujmibicxeg
npx supabase@latest db push
npx supabase@latest functions deploy stripe-webhook --project-ref "<project-ref>"
npx supabase@latest functions deploy activate-license --project-ref "<project-ref>"
npx supabase@latest functions deploy validate-license --project-ref "<project-ref>"
```

## Stripe webhook

Create a live-mode Stripe webhook endpoint:

```text
https://lfckwzwhaqujmibicxeg.supabase.co/functions/v1/stripe-webhook
```

Subscribe to:

```text
checkout.session.completed
```

The webhook creates or updates a license for the Checkout email.

## PRO app build

Set `ORANGE_FUJI_LICENSE_TARGET` as a repository variable before packaging a
PRO release. Set the remaining values as repository variables or secrets:

```text
ORANGE_FUJI_LICENSE_TARGET=pro
ORANGE_FUJI_PRO_BUY_LICENSE_URL=https://buy.stripe.com/00w00ka8w3Us4cb5z6bQY00
ORANGE_FUJI_PRO_LICENSE_API_BASE_URL=https://lfckwzwhaqujmibicxeg.supabase.co/functions/v1
ORANGE_FUJI_PRO_SUPABASE_PUBLISHABLE_KEY=<production publishable key>
```

Then run:

```bash
npm run configure-license
npm run build:desktop
```

## App behavior

- Trial starts on first local launch.
- Trial length is 30 days.
- License activation uses email only.
- Each license allows 2 active device activations.
- Active licenses are revalidated online every 7 days.
