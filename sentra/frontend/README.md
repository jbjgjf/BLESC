# Sentra Frontend

Next.js で構築されたフロントエンドです。
起動方法はプロジェクトルートの [README.md](../README.md) を参照してください。

## 起動コマンド
```bash
npm run dev
```
ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

## Supabase configuration

1. Create a Supabase project.
2. Apply the SQL migration in `../supabase/migrations/20260529000100_initial_sentra_backend.sql` with the Supabase CLI or the Dashboard SQL editor.
3. Enable Email provider auth in Supabase Authentication. Email/password is used; SSO is not required.
4. Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_or_publishable_key
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

Use a publishable key, or the legacy anon key during transition. Do not expose the service role key in the frontend.
