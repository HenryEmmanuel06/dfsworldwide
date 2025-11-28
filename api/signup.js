import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { email, password, first_name, last_name, state, country, street, house_number, full_address } = req.body;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) return res.status(400).json({ error: error.message });

  const userId = data?.user?.id;
  if (!userId) return res.status(400).json({ error: "User ID not available" });

  const { error: infoError } = await supabase.from("users_info").insert({
    id: userId,
    first_name,
    last_name,
    state,
    country,
    street,
    house_number,
    full_address
  });

  if (infoError) return res.status(400).json({ error: infoError.message });

  res.status(200).json({ message: "Account created", data });
}
