# Orange Fuji PRE licensing setup

PRE uses Supabase project `xnppcugncigaiycrvmpk`:

```text
https://xnppcugncigaiycrvmpk.supabase.co
```

## Secrets

Do not commit Stripe secrets to the repository. Store them in Supabase Edge Function secrets:

```bash
npx supabase@latest secrets set STRIPE_SECRET_KEY="sk_test_..."
npx supabase@latest secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
```

## Deploy

Because the current iMac cannot run the latest Supabase CLI binary, deploy from
GitHub Actions.

Add these repository secrets:

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_DB_PASSWORD
```

Then run:

```text
Actions -> Deploy Supabase PRE -> Run workflow
```

The workflow runs the equivalent of:

```bash
npx supabase@latest link --project-ref xnppcugncigaiycrvmpk
npx supabase@latest db push
npx supabase@latest functions deploy stripe-webhook --no-verify-jwt
npx supabase@latest functions deploy activate-license --no-verify-jwt
npx supabase@latest functions deploy validate-license --no-verify-jwt
```

## Stripe webhook

Create a test-mode Stripe webhook endpoint:

```text
https://xnppcugncigaiycrvmpk.supabase.co/functions/v1/stripe-webhook
```

Subscribe to:

```text
checkout.session.completed
```

The webhook creates or updates a license for the Checkout email.

## App behavior

- Trial starts on first local launch.
- Trial length is 30 days.
- License activation uses email only.
- Each license allows 2 active device activations.
- Active licenses are revalidated online every 7 days.
- The PRE buy link is:

```text
https://buy.stripe.com/test_00w00ka8w3Us4cb5z6bQY00
```
