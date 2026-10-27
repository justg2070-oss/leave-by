# Leave By

Know exactly when to leave, with live traffic.

Leave By is a commute-aware day planner. It looks at your classes and shifts, works out the drive between each place, and tells you when to walk out the door — using live traffic from TomTom.

## How it's built

| Piece | What it does |
| --- | --- |
| `index.html` | The whole app: home screen, week/month views, menu, splash |
| `platform.js` | Connects the app to accounts (Supabase) and live traffic (our server) |
| `api/tomtom.js` | Server function that calls TomTom with a secret key |
| `api/config.js` | Server function that gives the page its public Supabase settings |
| `api/transit.js` | Server function that finds bus and train options with Google's Routes API (signed-in users only) |
| `api/import.js` | Server function that reads a schedule screenshot with Claude (signed-in users only) |
| `supabase/schema.sql` | Database table with row-level security, so each person only sees their own data |

Hosting: Vercel. Accounts and storage: Supabase with Sign in with Google. Traffic: TomTom.

## Setup

You need free accounts at GitHub, Vercel, Supabase, Google Cloud, and TomTom Developer.

### 1. TomTom key
1. Sign up at developer.tomtom.com.
2. Open your dashboard and copy your API key.

### 2. Supabase project
1. At supabase.com, create a new project (any name, pick a region near you, save the database password somewhere).
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 3. Deploy on Vercel
1. At vercel.com, choose **Add New → Project**, import the `leave-by` GitHub repo.
2. Before deploying, open **Environment Variables** and add:
   - `TOMTOM_KEY` — your TomTom key
   - `SUPABASE_URL` — your Supabase Project URL
   - `SUPABASE_ANON_KEY` — your Supabase anon public key
   - `ANTHROPIC_API_KEY` — optional; turns on screenshot import (set a monthly spend limit in the Claude Console)
   - `GOOGLE_MAPS_KEY` — optional; turns on car vs. transit comparison (Routes API, restricted to that API, with a daily quota)
3. Click **Deploy**. Copy your new address (like `leave-by.vercel.app`).

### 4. Google sign-in
1. At console.cloud.google.com, create a project called Leave By.
2. **APIs & Services → OAuth consent screen**: choose **External**, app name "Leave By", your email for support and developer contact. Save. Then click **Publish app** so anyone can sign in.
3. **Credentials → Create credentials → OAuth client ID** → **Web application**.
   - Authorized redirect URI: `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (Supabase shows this exact URL on its Google provider page).
4. Copy the **Client ID** and **Client secret**.
5. In Supabase: **Authentication → Providers → Google**, turn it on, paste both, save.
6. In Supabase: **Authentication → URL Configuration**, set **Site URL** to your Vercel address and add it under **Redirect URLs** too.

Open your Vercel address, tap **☰ → Profile → Sign in with Google**, and you're live.

## Shift sync (Google Calendar)
In Google Cloud, enable the **Google Calendar API** and add the `calendar.readonly` scope under **Google Auth Platform → Data Access**. Until Google verifies the app, people connecting their calendar see an "unverified app" screen and the app is limited to 100 users.

To keep people connected (instead of reconnecting every hour), run the `calendar_tokens` part of `supabase/schema.sql` and add these Vercel env vars: `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API Keys → secret key), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (the same OAuth client used for Google sign-in). `api/calendar-token.js` stores Google's refresh token server-side and renews access in the background.
