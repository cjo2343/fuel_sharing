import { assertStagingUrl, STAGING_URL } from "./staging-target.mjs";

export function createStagingApi(config, fetchImpl = fetch) {
  assertStagingUrl(config.SUPABASE_URL);
  if (!config.STAGING_SECRET_KEY?.startsWith("sb_secret_") ||
      !config.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_")) {
    throw new Error("Staging requires a server secret key and a client publishable key.");
  }

  async function request(route, { body, token, admin = false } = {}) {
    let response;
    let json;
    try {
      response = await fetchImpl(`${STAGING_URL}${route}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          apikey: admin ? config.STAGING_SECRET_KEY : config.SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Staging API request failed or returned an invalid response. No automatic retry was attempted; rerun to reconcile state.");
    }
    if (!response.ok) {
      // Only known machine codes are useful in reports; never echo response text.
      const candidate = json?.code ?? json?.error_code;
      const code = typeof candidate === "string" && (/^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(candidate) ||
        ["email_exists", "user_already_exists"].includes(candidate)) ? candidate : undefined;
      const error = new Error(`Staging API ${route.split("?")[0]} returned HTTP ${response.status}${code ? ` (${code})` : ""}.`);
      error.status = response.status;
      error.code = code;
      throw error;
    }
    return json;
  }

  return {
    listUsers: () => request("/auth/v1/admin/users?page=1&per_page=100", { admin: true }),
    createUser: (user) => request("/auth/v1/admin/users", {
      admin: true,
      body: {
        email: user.email, password: user.password, email_confirm: true,
        user_metadata: { name: user.name }, app_metadata: { fixture: "vehlo-native-qa-v1" },
      },
    }),
    signIn: (user) => request("/auth/v1/token?grant_type=password", {
      body: { email: user.email, password: user.password },
    }),
    rpc: (token, name, body = {}) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid staging RPC name.");
      return request(`/rest/v1/rpc/${name}`, { token, body });
    },
    rows: (token, table, parameters) => {
      if (!["ledgers", "ledger_members", "settlement_periods", "car_bookings", "trips", "fuel_payments"].includes(table)) {
        throw new Error("Unsupported staging fixture table.");
      }
      return request(`/rest/v1/${table}?${new URLSearchParams(parameters)}`, { token });
    },
  };
}
