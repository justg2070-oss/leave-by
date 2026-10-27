// Server function: hands the page the public Supabase settings.
// These two values are safe to share (Supabase's "anon" key is meant for browsers;
// row-level security in supabase/schema.sql is what keeps each person's data private).

export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    importEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
