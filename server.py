#!/usr/bin/env python3
import base64
import json
import argparse
import re
import gzip
import hmac
import os
import secrets
import socket
import sys
import time
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import jwt

try:
    from pywebpush import WebPushException, webpush
except Exception:  # pywebpush is optional for local development until notifications are enabled
    WebPushException = Exception
    webpush = None

ROOT = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("FUEL_LEDGER_DATA_FILE", ROOT / "ledger-data.json")).expanduser()

DEFAULT_STATE = {
    "currency": "DKK",
    "members": ["Christian", "Emilie", "Jonas", "Marie"],
    "memberProfiles": {
        "Christian": {"email": "", "role": "admin"},
        "Emilie": {"email": "", "role": "member"},
        "Jonas": {"email": "", "role": "member"},
        "Marie": {"email": "", "role": "member"},
    },
    "trips": [],
    "bookings": [],
    "fuel": [],
    "paymentStatuses": {},
    "closedPeriods": [],
    "lastOdometer": "",
    "fuelType": "diesel",
    "fuelConsumption": 5.3,
    "fuelTankCapacity": 55,
    "fuelFallbackPrice": 14.5,
    "fuelWarningThreshold": 70,
    "carSettingsVersion": 2,
}


def read_state():
    if not DATA_FILE.exists():
        return DEFAULT_STATE

    try:
        with DATA_FILE.open("r", encoding="utf-8") as handle:
            saved = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return DEFAULT_STATE

    state = {**DEFAULT_STATE, **saved}
    if not isinstance(state.get("members"), list) or not state["members"]:
        state["members"] = DEFAULT_STATE["members"]
    for key in ("trips", "bookings", "fuel", "closedPeriods"):
        if not isinstance(state.get(key), list):
            state[key] = []
    if not isinstance(state.get("paymentStatuses"), dict):
        state["paymentStatuses"] = {}
    return state


def write_state(state):
    merged = {**DEFAULT_STATE, **state}
    temp_file = DATA_FILE.with_suffix(".json.tmp")
    with temp_file.open("w", encoding="utf-8") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp_file.replace(DATA_FILE)


def env_value(name, fallback=""):
    return os.environ.get(name, fallback).strip()




def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def ledger_api_secret():
    return env_value("FUEL_LEDGER_API_SECRET") or env_value("LEDGER_API_SECRET")


def ledger_api_auth_required():
    # Local development and Playwright use the JSON API without a secret by default.
    # Hosted deployments should set FUEL_LEDGER_API_SECRET; Render also enables
    # protection automatically so a missing secret fails closed instead of exposing
    # the JSON ledger.
    return bool(
        ledger_api_secret()
        or env_flag("FUEL_LEDGER_REQUIRE_API_AUTH")
        or env_value("RENDER")
        or env_value("RENDER_SERVICE_ID")
    )


def bearer_token(header_value):
    value = (header_value or "").strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return ""


def authorize_ledger_api(handler):
    if not ledger_api_auth_required():
        return True

    secret = ledger_api_secret()
    if not secret:
        handler.send_error(503, "Ledger API auth is required but FUEL_LEDGER_API_SECRET is not configured")
        return False

    supplied = (
        handler.headers.get("X-Ledger-Api-Secret")
        or bearer_token(handler.headers.get("Authorization"))
        or ""
    ).strip()
    if supplied and hmac.compare_digest(supplied, secret):
        return True

    handler.send_error(401, "Invalid ledger API secret")
    return False


def supabase_url():
    return env_value("SUPABASE_URL")


def supabase_key():
    return env_value("SUPABASE_SERVICE_ROLE_KEY") or env_value("SUPABASE_ANON_KEY")


def supabase_anon_key():
    return env_value("SUPABASE_ANON_KEY") or env_value("SUPABASE_SERVICE_ROLE_KEY")


class SettingsSchemaMissingError(RuntimeError):
    pass


SETTINGS_SAVE_SUPABASE_TIMEOUT = 5
SETTINGS_MEMBER_SYNC_TIMEOUT = 4


def request_json(url, method="GET", body=None, token=None, prefer=None, api_key=None, timeout=20):
    key = api_key or supabase_key()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {token or key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else None


def fetch_fuel_price(path):
    parsed = urllib.parse.urlparse(path)
    query = urllib.parse.parse_qs(parsed.query)
    wanted = (query.get("fuelType", ["95"])[0] or "95").lower()
    if wanted in ("diesel", "dieselolie"):
        match_terms = ("diesel",)
        label = "Diesel"
        fallback_price = 14.50
    else:
        match_terms = ("95", "miles 95", "benzin 95", "petrol 95")
        label = "Petrol 95"
        fallback_price = 15.50

    try:
        request = urllib.request.Request(
            "https://api.circlek.com/eu/prices/v1/fuel/countries/DK",
            headers={
                "X-App-Name": "PRICES",
                "Accept": "application/json",
                # Avoid compressed bytes that some minimal urllib environments do
                # not decode automatically. If the server still compresses, handle
                # gzip explicitly below.
                "Accept-Encoding": "identity",
                "User-Agent": "FuelLedger/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                raw = gzip.decompress(raw)
            data = json.loads(raw.decode("utf-8-sig", errors="replace"))

        prices = []
        last_updated = ""
        for site in data.get("sites", []):
            for price in site.get("fuelPrices", []) or []:
                name = str(price.get("displayName", "")).lower()
                if any(term in name for term in match_terms):
                    try:
                        value = float(price.get("price"))
                    except (TypeError, ValueError):
                        continue
                    if value > 0:
                        prices.append(value)
                        last_updated = max(last_updated, str(price.get("lastUpdated") or ""))

        if prices:
            # Use the median so one unusually cheap/expensive station does not skew the sanity check.
            prices.sort()
            median = prices[len(prices) // 2]
            return {
                "ok": True,
                "fuelType": wanted,
                "label": label,
                "price": round(median, 2),
                "currency": "DKK",
                "volumeUnit": "LITER",
                "stationCount": len(prices),
                "lastUpdated": last_updated,
                "source": "Circle K/INGO public DK fuel price API",
            }
    except Exception as error:
        return {
            "ok": False,
            "fuelType": wanted,
            "label": label,
            "price": fallback_price,
            "currency": "DKK",
            "volumeUnit": "LITER",
            "message": f"Live fuel price unavailable; using fallback price ({type(error).__name__}).",
            "source": "Configured fallback",
        }

    return {
        "ok": False,
        "fuelType": wanted,
        "label": label,
        "price": fallback_price,
        "currency": "DKK",
        "volumeUnit": "LITER",
        "message": "No matching Danish fuel price found; using fallback price.",
        "source": "Configured fallback",
    }


def configured_supabase_origin():
    return (supabase_url() or "").rstrip("/")


def configured_supabase_realtime_origin():
    origin = configured_supabase_origin()
    if origin.startswith("https://"):
        return "wss://" + origin[len("https://"):]
    if origin.startswith("http://"):
        return "ws://" + origin[len("http://"):]
    return ""


def content_security_policy():
    # Keep this CSP compatible with the static PWA, Supabase Auth/PostgREST/Realtime,
    # the locally vendored Supabase client, Overpass station search,
    # service workers, and browser notification flows. Broad table Realtime remains
    # off in the app; this only permits the narrow ledger_events channel when active.
    connect_sources = [
        "'self'",
        "https://overpass-api.de",
    ]
    supabase_origin = configured_supabase_origin()
    supabase_realtime = configured_supabase_realtime_origin()
    if supabase_origin:
        connect_sources.append(supabase_origin)
    if supabase_realtime:
        connect_sources.append(supabase_realtime)

    directives = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "manifest-src 'self'",
        "worker-src 'self'",
        "connect-src " + " ".join(dict.fromkeys(connect_sources)),
        "upgrade-insecure-requests",
    ]
    return "; ".join(directives)


def security_headers():
    return {
        "Content-Security-Policy": content_security_policy(),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Origin-Agent-Cluster": "?1",
        "X-Permitted-Cross-Domain-Policies": "none",
    }


RATE_LIMIT_POLICIES = {
    # Per signed-in user + ledger where possible. Limits are intentionally
    # conservative for heavy admin tools and generous for normal writes so
    # double-clicks and broken loops are stopped without blocking normal use.
    "state-load": {"limit": 90, "window": 60},
    "write-context": {"limit": 90, "window": 60},
    "write": {"limit": 60, "window": 60},
    "settings-save": {"limit": 30, "window": 300},
    "vehicle-lookup": {"limit": 20, "window": 300},
    "admin": {"limit": 20, "window": 300},
    "admin-heavy": {"limit": 8, "window": 300},
    "admin-health": {"limit": 30, "window": 60},
    "json-backup": {"limit": 12, "window": 300},
}
RATE_LIMIT_BUCKETS = {}


def rate_limit_disabled():
    return env_flag("FUEL_LEDGER_DISABLE_RATE_LIMITS")


def rate_limit_env_int(scope, field, fallback):
    env_name = f"FUEL_LEDGER_RATE_LIMIT_{scope.replace('-', '_').upper()}_{field.upper()}"
    try:
        value = int(env_value(env_name, ""))
        return value if value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def rate_limit_policy(scope):
    policy = RATE_LIMIT_POLICIES.get(scope) or RATE_LIMIT_POLICIES["write"]
    return {
        "limit": rate_limit_env_int(scope, "limit", int(policy["limit"])),
        "window": rate_limit_env_int(scope, "window", int(policy["window"])),
    }


def rate_limit_identity(handler, user=None, ledger_id=""):
    email = str((user or {}).get("email") or "").strip().lower()
    client_ip = str(getattr(handler, "client_address", [""])[0] or "unknown")
    ledger = str(ledger_id or "global").strip() or "global"
    return f"{email or client_ip}:{ledger}"


def check_backend_rate_limit(handler, scope, user=None, ledger_id=""):
    if rate_limit_disabled():
        return True
    policy = rate_limit_policy(scope)
    limit = int(policy["limit"])
    window = int(policy["window"])
    now = time.time()
    key = (scope, rate_limit_identity(handler, user=user, ledger_id=ledger_id))
    cutoff = now - window
    bucket = [stamp for stamp in RATE_LIMIT_BUCKETS.get(key, []) if stamp >= cutoff]
    if len(bucket) >= limit:
        retry_after = max(1, int(window - (now - bucket[0])))
        handler.send_response(429, "Too Many Requests")
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Retry-After", str(retry_after))
        handler.end_headers()
        handler.wfile.write(json.dumps({
            "ok": False,
            "error": "rate_limited",
            "scope": scope,
            "limit": limit,
            "windowSeconds": window,
            "retryAfterSeconds": retry_after,
        }).encode("utf-8"))
        return False
    bucket.append(now)
    RATE_LIMIT_BUCKETS[key] = bucket
    # Opportunistically prune old empty buckets so long-lived Render workers do
    # not keep stale identities forever.
    if len(RATE_LIMIT_BUCKETS) > 1000:
        for old_key, values in list(RATE_LIMIT_BUCKETS.items()):
            fresh = [stamp for stamp in values if stamp >= cutoff]
            if fresh:
                RATE_LIMIT_BUCKETS[old_key] = fresh
            else:
                RATE_LIMIT_BUCKETS.pop(old_key, None)
    return True

def read_request_body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def get_bearer_token(handler):
    value = handler.headers.get("Authorization", "")
    if value.lower().startswith("bearer "):
        return value.split(" ", 1)[1].strip()
    return ""


def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8"))
        data = json.loads(decoded.decode("utf-8"))
        exp = data.get("exp")
        if exp and int(exp) < int(time.time()):
            return None
        email = data.get("email") or data.get("user_metadata", {}).get("email")
        if not email:
            return None
        return {"email": email}
    except Exception:
        return None


# Legacy HS256 projects may still set this in Render. New Supabase projects can
# sign access tokens with asymmetric keys such as ECC/P-256; those must be
# verified through the public JWKS endpoint instead of a shared JWT secret.
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")
SUPABASE_JWKS_CACHE = {"fetched_at": 0, "keys": []}
SUPABASE_JWKS_CACHE_TTL_SECONDS = 300


def expected_supabase_issuer():
    url = (supabase_url() or "").rstrip("/")
    return f"{url}/auth/v1" if url else None


def supabase_jwks_url():
    configured = env_value("SUPABASE_JWKS_URL")
    if configured:
        return configured
    url = (supabase_url() or "").rstrip("/")
    return f"{url}/auth/v1/.well-known/jwks.json" if url else ""


def fetch_supabase_jwks(force=False):
    now = time.time()
    cached_keys = SUPABASE_JWKS_CACHE.get("keys") or []
    fetched_at = float(SUPABASE_JWKS_CACHE.get("fetched_at") or 0)
    if cached_keys and not force and now - fetched_at < SUPABASE_JWKS_CACHE_TTL_SECONDS:
        return cached_keys

    url = supabase_jwks_url()
    if not url:
        return []
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=8) as response:
        raw = response.read().decode("utf-8")
    data = json.loads(raw) if raw else {}
    keys = data.get("keys") if isinstance(data, dict) else []
    if not isinstance(keys, list):
        keys = []
    SUPABASE_JWKS_CACHE["keys"] = keys
    SUPABASE_JWKS_CACHE["fetched_at"] = now
    return keys


def jwk_for_token(token):
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    alg = header.get("alg")
    if not kid or not alg:
        return None, header
    keys = fetch_supabase_jwks(force=False)
    key = next((item for item in keys if item.get("kid") == kid), None)
    if key:
        return key, header
    # A missing kid can mean Supabase rotated signing keys. Refresh once before
    # rejecting so long-lived Render workers pick up new public keys safely.
    keys = fetch_supabase_jwks(force=True)
    key = next((item for item in keys if item.get("kid") == kid), None)
    return key, header


def verified_user_from_claims(claims):
    if not isinstance(claims, dict):
        return None
    email = claims.get("email") or claims.get("user_metadata", {}).get("email")
    subject = claims.get("sub")
    if not email or not subject:
        return None
    return {"email": email, "id": subject}


def verify_supabase_user_via_jwks(token):
    if not token:
        return None
    key_data, header = jwk_for_token(token)
    if not key_data:
        print("Supabase JWKS verification failed: signing key not found for token kid")
        return None
    alg = header.get("alg") or key_data.get("alg")
    # Supabase asymmetric projects commonly use ES256/ECC P-256. Keep this list
    # explicit so an attacker cannot downgrade us to an unexpected algorithm.
    allowed_algs = ["ES256", "RS256"]
    if alg not in allowed_algs:
        print(f"Supabase JWKS verification rejected unsupported alg: {alg}")
        return None
    public_key = jwt.PyJWK.from_dict(key_data).key
    decode_kwargs = {"algorithms": [alg], "audience": "authenticated"}
    issuer = expected_supabase_issuer()
    if issuer:
        decode_kwargs["issuer"] = issuer
    claims = jwt.decode(token, public_key, **decode_kwargs)
    return verified_user_from_claims(claims)


def verify_supabase_user_via_legacy_secret(token):
    if not SUPABASE_JWT_SECRET or not token:
        return None
    header = jwt.get_unverified_header(token)
    if header.get("alg") != "HS256":
        return None
    claims = jwt.decode(
        token,
        SUPABASE_JWT_SECRET,
        algorithms=["HS256"],
        audience="authenticated",
    )
    return verified_user_from_claims(claims)


def verify_supabase_user_via_network(token):
    # Emergency compatibility escape hatch only. The stable Render auth path is
    # local verification through Supabase JWKS/public keys. Enable this during an
    # incident with SUPABASE_AUTH_NETWORK_FALLBACK=1 if Supabase changes JWKS
    # behavior before the backend has been patched.
    if not env_flag("SUPABASE_AUTH_NETWORK_FALLBACK"):
        return None
    url = supabase_url()
    if not url or not token:
        return None
    try:
        user = request_json(f"{url}/auth/v1/user", token=token, api_key=supabase_anon_key())
        if user and user.get("email"):
            return user
    except Exception as error:
        print(f"Supabase emergency network user verification failed: {error}")
    return None


def current_supabase_user(handler):
    token = get_bearer_token(handler)
    if not token:
        return None

    try:
        # ECC/P-256 and other asymmetric Supabase access tokens are verified
        # locally with Supabase public JWKS keys. This avoids 401s caused by
        # trying to validate ES256 tokens with the old SUPABASE_JWT_SECRET flow.
        user = verify_supabase_user_via_jwks(token)
        if user:
            return user

        # Keep legacy HS256 support for older Supabase projects, but do not use
        # the shared secret for ES256/ECC tokens.
        user = verify_supabase_user_via_legacy_secret(token)
        if user:
            return user

        return verify_supabase_user_via_network(token)
    except jwt.ExpiredSignatureError:
        print("Supabase access token has expired")
        return None
    except jwt.InvalidTokenError as error:
        print(f"Supabase JWT verification failed: {error}")
        return verify_supabase_user_via_network(token)
    except Exception as error:
        print(f"Supabase auth verification error: {error}")
        return verify_supabase_user_via_network(token)



def active_ledger_members_by_email(*emails):
    """Return active ledger member rows keyed by lowercase email using service-role Supabase access."""
    wanted = {str(email or "").strip().lower() for email in emails if str(email or "").strip()}
    if not wanted or not supabase_url() or not supabase_key():
        return {}
    try:
        rows = request_json(
            f"{supabase_url()}/rest/v1/ledger_members?select=ledger_id,email,role,is_active&is_active=eq.true"
        ) or []
    except Exception:
        return {}
    result = {}
    for row in rows:
        email = str(row.get("email") or "").strip().lower()
        if email in wanted:
            result[email] = row
    return result


def can_send_push_to(sender_email, target_email):
    """Allow push only between active members of the same ledger."""
    sender = str(sender_email or "").strip().lower()
    target = str(target_email or "").strip().lower()
    if not sender or not target:
        return False
    members = active_ledger_members_by_email(sender, target)
    sender_row = members.get(sender)
    target_row = members.get(target)
    if not sender_row or not target_row:
        return False
    return sender_row.get("ledger_id") == target_row.get("ledger_id")


def public_origin(handler):
    proto = handler.headers.get("X-Forwarded-Proto") or "http"
    host = handler.headers.get("Host") or f"localhost:{os.environ.get('PORT', '4175')}"
    return f"{proto}://{host}"


PAYMENT_STATUSES = {"open", "requested", "paid"}


def normalize_payment_status(value):
    value = str(value or "open").strip().lower()
    return value if value in PAYMENT_STATUSES else "open"


def normalize_audit_entry(entry):
    if not isinstance(entry, dict):
        entry = {}
    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    return {
        "id": str(entry.get("id") or f"server-audit-{int(time.time() * 1000)}"),
        "createdAt": str(entry.get("createdAt") or now),
        "actor": str(entry.get("actor") or "Server"),
        "type": str(entry.get("type") or "change"),
        "entityType": str(entry.get("entityType") or "payment"),
        "entityId": str(entry.get("entityId") or ""),
        "summary": str(entry.get("summary") or "Payment action"),
        "detail": str(entry.get("detail") or ""),
        "metadata": entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {},
    }


def prepend_audit(entries, entry):
    existing = entries if isinstance(entries, list) else []
    return [normalize_audit_entry(entry), *existing][:250]


def parse_payment_key(payment_key):
    """Parse keys like period-id:Marie->Christian:DKK without trusting them for access control."""
    raw = str(payment_key or "").strip()
    parts = raw.split(":")
    if len(parts) < 3 or "->" not in parts[-2]:
        return {"periodId": "", "from": "", "to": "", "currency": "DKK"}
    payer, receiver = parts[-2].split("->", 1)
    return {
        "periodId": ":".join(parts[:-2]),
        "from": payer.strip(),
        "to": receiver.strip(),
        "currency": parts[-1].strip() or "DKK",
    }


def format_backend_money(amount, currency="DKK"):
    try:
        value = float(amount)
    except (TypeError, ValueError):
        value = 0
    return f"{value:.2f} {currency or 'DKK'}"


def payment_audit_entries(entries, payment_key, entry_type=None):
    result = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        if entry.get("entityType") != "payment" or str(entry.get("entityId") or "") != str(payment_key):
            continue
        if entry_type and entry.get("type") != entry_type:
            continue
        result.append(entry)
    return result


def parse_timestamp(value):
    try:
        if not value:
            return 0
        if isinstance(value, (int, float)):
            return float(value)
        text = str(value).strip()
        if not text:
            return 0
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def audit_entry_timestamp(entry):
    return parse_timestamp(entry.get("createdAt") if isinstance(entry, dict) else None)


def closed_payment_fallback_requested_at(period, settlement):
    if isinstance(settlement, dict):
        for key in ("requestedAt", "requested_at", "paymentRequestedAt"):
            parsed = parse_timestamp(settlement.get(key))
            if parsed:
                return parsed
    if isinstance(period, dict):
        for key in ("closedAt", "createdAt", "endedAt", "endDate", "periodEnd", "updatedAt"):
            parsed = parse_timestamp(period.get(key))
            if parsed:
                return parsed
    return 0


def reminder_settings(state):
    return {
        "enabled": state.get("paymentRemindersEnabled") is not False,
        "afterDays": max(0, int(state.get("paymentReminderAfterDays") if state.get("paymentReminderAfterDays") is not None else 3)),
        "repeatDays": max(1, int(state.get("paymentReminderRepeatDays") or 3)),
        "maxCount": max(1, int(state.get("paymentReminderMaxCount") if state.get("paymentReminderMaxCount") is not None else 3)),
    }


def payment_reminder_due_info(entries, payment_key, settings, now_ts=None, fallback_requested_at=0):
    if not settings.get("enabled"):
        return {"due": False, "reason": "disabled"}
    now_ts = now_ts or time.time()
    requested_entries = payment_audit_entries(entries, payment_key, "payment_requested")
    requested_at = max([audit_entry_timestamp(entry) for entry in requested_entries] or [0])
    inferred_requested_at = False
    if not requested_at and fallback_requested_at:
        requested_at = float(fallback_requested_at)
        inferred_requested_at = True
    if not requested_at:
        return {"due": False, "reason": "missing-request-time"}
    reminder_entries = payment_audit_entries(entries, payment_key, "payment_reminder_sent")
    if settings["maxCount"] > 0 and len(reminder_entries) >= settings["maxCount"]:
        return {"due": False, "reason": "max-reminders"}
    last_reminder_at = max([audit_entry_timestamp(entry) for entry in reminder_entries] or [0])
    due_at = last_reminder_at + settings["repeatDays"] * 86400 if last_reminder_at else requested_at + settings["afterDays"] * 86400
    is_due = now_ts >= due_at
    reason = "due" if is_due else ("repeat-window" if last_reminder_at else "waiting-after-request")
    return {
        "due": is_due,
        "reason": reason,
        "requestedAt": requested_at,
        "inferredRequestedAt": inferred_requested_at,
        "lastReminderAt": last_reminder_at,
        "reminderCount": len(reminder_entries),
        "dueAt": due_at,
    }


def create_backend_stable_hash(value):
    text = str(value or "payment")
    hash_value = 2166136261
    for char in text:
        hash_value ^= ord(char)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if hash_value == 0:
        encoded = "0"
    else:
        encoded = ""
        current = hash_value
        while current:
            current, remainder = divmod(current, 36)
            encoded = alphabet[remainder] + encoded
    return encoded.rjust(6, "0")[:6]


def create_backend_payment_ref(scope, payment_key, settlement):
    # Keep refs stable when a current payment is archived into a closed period.
    raw = f"{payment_key or ''}:{settlement.get('from') or ''}:{settlement.get('to') or ''}:{settlement.get('amount') or 0}"
    return f"#P{create_backend_stable_hash(raw)}"


def format_backend_payment_ref(payment_ref):
    compact = str(payment_ref or "").strip().lstrip("#")
    if compact.upper().startswith("PAY"):
        compact = compact[3:]
    elif compact.upper().startswith("P"):
        compact = compact[1:]
    return f"pay-{compact}" if compact else "pay-unknown"


def make_backend_payment_url(payment_ref, scope="", period_id=""):
    compact = str(payment_ref or "").strip().lstrip("#")
    if not compact:
        return "/"
    params = {"payment": compact}
    if scope:
        params["scope"] = scope
    if period_id:
        params["period"] = period_id
    return "/#" + urllib.parse.urlencode(params)


def member_email(state, member_name):
    profiles = state.get("memberProfiles") if isinstance(state.get("memberProfiles"), dict) else {}
    profile = profiles.get(str(member_name or ""), {})
    return str(profile.get("email") or "").strip().lower() if isinstance(profile, dict) else ""


def push_unavailable(reason):
    return {"attempted": False, "sent": 0, "failed": 0, "reason": reason}


def send_backend_payment_reminder_push(state, settlement, payment_ref="", scope="current", period_id=""):
    target_email = member_email(state, settlement.get("from"))
    if not target_email:
        return push_unavailable("missing-payer-email")
    if not webpush:
        return push_unavailable("pywebpush-not-installed")
    if not env_value("VAPID_PUBLIC_KEY") or not env_value("VAPID_PRIVATE_KEY"):
        return push_unavailable("vapid-missing")
    if not supabase_url() or not supabase_key():
        return push_unavailable("supabase-missing")

    encoded_email = urllib.parse.quote(target_email, safe="")
    try:
        subscriptions = request_json(
            f"{supabase_url()}/rest/v1/push_subscriptions?user_email=eq.{encoded_email}&select=id,user_email,subscription"
        ) or []
    except Exception as error:
        return {"attempted": True, "sent": 0, "failed": 1, "reason": f"subscription-lookup-failed:{type(error).__name__}"}

    amount_text = format_backend_money(settlement.get("amount"), settlement.get("currency") or state.get("currency") or "DKK")
    payment_ref = str(payment_ref or "").strip()
    display_ref = format_backend_payment_ref(payment_ref)
    title = f"Payment reminder {display_ref}".strip()
    body = f"{display_ref + ' · ' if payment_ref else ''}{settlement.get('to', 'Someone')} reminded you to pay {amount_text} for shared car fuel."
    sent = 0
    failed = 0
    for row in subscriptions:
        subscription = row.get("subscription")
        if not subscription:
            continue
        try:
            webpush(
                subscription_info=subscription,
                data=json.dumps({"title": title, "body": body, "url": make_backend_payment_url(payment_ref, scope, period_id), "tag": f"fuel-ledger:payment:{settlement.get('from')}:{settlement.get('to')}:{payment_ref}:reminder"}),
                vapid_private_key=env_value("VAPID_PRIVATE_KEY"),
                vapid_claims={"sub": env_value("VAPID_SUBJECT", "mailto:notifications@fuel-ledger.local")},
            )
            sent += 1
        except WebPushException as error:
            failed += 1
            status = getattr(getattr(error, "response", None), "status_code", None)
            if status in (404, 410):
                row_id = urllib.parse.quote(str(row.get("id", "")), safe="")
                if row_id:
                    try:
                        request_json(f"{supabase_url()}/rest/v1/push_subscriptions?id=eq.{row_id}", method="DELETE")
                    except Exception:
                        pass
        except Exception:
            failed += 1
    return {"attempted": True, "sent": sent, "failed": failed, "reason": "" if sent else "no-active-subscription"}


def build_backend_reminder_audit_entry(state, payment_key, settlement, due_info, scope="current", period_id=""):
    currency = settlement.get("currency") or state.get("currency") or "DKK"
    amount_text = format_backend_money(settlement.get("amount"), currency)
    payment_ref = create_backend_payment_ref(scope, payment_key, settlement)
    push_result = send_backend_payment_reminder_push(state, settlement, payment_ref, scope, period_id)
    sent = int(push_result.get("sent") or 0)
    if sent > 0:
        delivery_text = f"Mobile notification sent to {sent} device{'s' if sent != 1 else ''}"
    elif push_result.get("attempted"):
        delivery_text = "No active mobile notification subscription was reached"
    else:
        delivery_text = "Reminder recorded by scheduled backend job; mobile notification was not available"
    detail_suffix = "Scheduled backend reminder for closed settlement" if scope == "closed" else "Scheduled backend reminder"
    metadata = {
        "from": settlement.get("from") or "Someone",
        "to": settlement.get("to") or "someone",
        "amount": float(settlement.get("amount") or 0),
        "currency": currency,
        "reminderSent": sent,
        "reminderFailed": int(push_result.get("failed") or 0),
        "reminderAttempted": bool(push_result.get("attempted")),
        "reminderReason": push_result.get("reason") or "",
        "automatic": True,
        "backendScheduled": True,
        "reminderCount": int(due_info.get("reminderCount") or 0) + 1,
        "paymentRef": payment_ref,
        "paymentUrl": make_backend_payment_url(payment_ref, scope, period_id),
    }
    if period_id:
        metadata["periodId"] = period_id
    return normalize_audit_entry({
        "actor": "Scheduled reminder job",
        "type": "payment_reminder_sent",
        "entityType": "payment",
        "entityId": payment_key,
        "summary": f"{format_backend_payment_ref(payment_ref)} · {settlement.get('to') or 'Someone'} reminded {settlement.get('from') or 'someone'} · {amount_text}",
        "detail": f"{format_backend_payment_ref(payment_ref)} · {settlement.get('from') or 'Someone'} pays {settlement.get('to') or 'someone'} · {amount_text} · {delivery_text} · {detail_suffix}",
        "metadata": metadata,
    })


def current_settlement_from_audit_or_key(state, payment_key):
    requested_entries = payment_audit_entries(state.get("auditLog"), payment_key, "payment_requested")
    metadata = requested_entries[0].get("metadata", {}) if requested_entries else {}
    parsed = parse_payment_key(payment_key)
    return {
        "from": metadata.get("from") or parsed.get("from") or "Someone",
        "to": metadata.get("to") or parsed.get("to") or "someone",
        "amount": metadata.get("amount") or 0,
        "currency": metadata.get("currency") or parsed.get("currency") or state.get("currency") or "DKK",
    }


def iso_from_timestamp(value):
    try:
        if not value:
            return ""
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return ""


def add_reminder_skip(diagnostics, reason):
    key = str(reason or "unknown")
    diagnostics["skippedReasons"][key] = diagnostics["skippedReasons"].get(key, 0) + 1


def add_reminder_sample(diagnostics, sample):
    if len(diagnostics["samples"]) < 20:
        diagnostics["samples"].append(sample)


def run_scheduled_payment_reminders(state, now_ts=None, dry_run=False):
    settings = reminder_settings(state)
    now_ts = now_ts or time.time()
    due_items = []
    changed = False
    diagnostics = {
        "settings": settings,
        "now": iso_from_timestamp(now_ts),
        "scannedCurrentPayments": 0,
        "scannedClosedPayments": 0,
        "requestedCurrentPayments": 0,
        "requestedClosedPayments": 0,
        "dueCurrentPayments": 0,
        "dueClosedPayments": 0,
        "skippedReasons": {},
        "samples": [],
    }

    if not settings.get("enabled"):
        add_reminder_skip(diagnostics, "disabled")
    else:
        statuses = state.get("paymentStatuses") if isinstance(state.get("paymentStatuses"), dict) else {}
        for payment_key, status in list(statuses.items()):
            diagnostics["scannedCurrentPayments"] += 1
            normalized_status = normalize_payment_status(status)
            if normalized_status != "requested":
                add_reminder_skip(diagnostics, f"current-{normalized_status or 'open'}")
                continue
            diagnostics["requestedCurrentPayments"] += 1
            due = payment_reminder_due_info(state.get("auditLog"), payment_key, settings, now_ts)
            settlement = current_settlement_from_audit_or_key(state, payment_key)
            add_reminder_sample(diagnostics, {
                "scope": "current",
                "paymentKey": payment_key,
                "status": normalized_status,
                "reason": due.get("reason"),
                "dueAt": iso_from_timestamp(due.get("dueAt")),
                "requestedAt": iso_from_timestamp(due.get("requestedAt")),
                "lastReminderAt": iso_from_timestamp(due.get("lastReminderAt")),
                "reminderCount": due.get("reminderCount") or 0,
                "from": settlement.get("from"),
                "to": settlement.get("to"),
            })
            if not due.get("due"):
                add_reminder_skip(diagnostics, due.get("reason"))
                continue
            diagnostics["dueCurrentPayments"] += 1
            due_items.append({"scope": "current", "paymentKey": payment_key, "settlement": settlement})
            if not dry_run:
                state["auditLog"] = prepend_audit(state.get("auditLog"), build_backend_reminder_audit_entry(state, payment_key, settlement, due))
                changed = True

        for period in state.get("closedPeriods", []) or []:
            settlements = period.get("settlements") if isinstance(period.get("settlements"), list) else []
            period_id = str(period.get("id") or "")
            for index, settlement in enumerate(settlements):
                diagnostics["scannedClosedPayments"] += 1
                normalized_status = normalize_payment_status(settlement.get("status"))
                if normalized_status != "requested":
                    add_reminder_skip(diagnostics, f"closed-{normalized_status or 'open'}")
                    continue
                diagnostics["requestedClosedPayments"] += 1
                stable_payment_key = str(settlement.get("paymentKey") or "").strip()
                fallback_payment_key = f"{period_id}:{settlement.get('from')}->{settlement.get('to')}:{settlement.get('currency') or state.get('currency') or 'DKK'}"
                payment_key = stable_payment_key or fallback_payment_key
                fallback_requested_at = closed_payment_fallback_requested_at(period, settlement)
                due = payment_reminder_due_info(period.get("auditLog"), payment_key, settings, now_ts, fallback_requested_at=fallback_requested_at)
                add_reminder_sample(diagnostics, {
                    "scope": "closed",
                    "periodId": period_id,
                    "settlementIndex": index,
                    "paymentKey": payment_key,
                    "stablePaymentKeyUsed": bool(stable_payment_key),
                    "generatedClosedPaymentKey": fallback_payment_key,
                    "status": normalized_status,
                    "reason": due.get("reason"),
                    "dueAt": iso_from_timestamp(due.get("dueAt")),
                    "requestedAt": iso_from_timestamp(due.get("requestedAt")),
                    "inferredRequestedAt": bool(due.get("inferredRequestedAt")),
                    "lastReminderAt": iso_from_timestamp(due.get("lastReminderAt")),
                    "reminderCount": due.get("reminderCount") or 0,
                    "from": settlement.get("from"),
                    "to": settlement.get("to"),
                })
                if not due.get("due"):
                    add_reminder_skip(diagnostics, due.get("reason"))
                    continue
                diagnostics["dueClosedPayments"] += 1
                due_items.append({"scope": "closed", "periodId": period_id, "settlementIndex": index, "paymentKey": payment_key, "settlement": settlement})
                if not dry_run:
                    period["auditLog"] = prepend_audit(period.get("auditLog"), build_backend_reminder_audit_entry(state, payment_key, settlement, due, scope="closed", period_id=period_id))
                    changed = True

    if not dry_run:
        state["lastReminderJobRun"] = {
            "createdAt": iso_from_timestamp(now_ts),
            "dueCount": len(due_items),
            "changed": changed,
            "diagnostics": diagnostics,
        }

    return {
        "ok": True,
        "enabled": settings.get("enabled"),
        "dueCount": len(due_items),
        "changed": changed,
        "dryRun": dry_run,
        "due": due_items[:50],
        "diagnostics": diagnostics,
    }


def reminder_job_auth_error(handler):
    secret = env_value("REMINDER_CRON_SECRET")
    if not secret:
        return 503, "Reminder cron secret is not configured"

    provided = handler.headers.get("X-Reminder-Secret", "")
    auth = handler.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        provided = provided or auth.split(" ", 1)[1].strip()

    if not provided or not hmac.compare_digest(provided, secret):
        return 401, "Invalid reminder cron secret"

    return None


def reminder_ledger_id():
    return env_value("SUPABASE_REMINDER_LEDGER_ID", "main-car") or "main-car"


def supabase_reminder_mode_enabled():
    mode = env_value("REMINDER_DATA_SOURCE", "auto").lower()
    if mode in ("local", "json", "file"):
        return False
    # Use the service role key for scheduled jobs because cron is not acting as a
    # signed-in user and must update reminder audit metadata server-side.
    return bool(supabase_url() and env_value("SUPABASE_SERVICE_ROLE_KEY"))


def call_supabase_rpc(function_name, body=None):
    return request_json(
        f"{supabase_url()}/rest/v1/rpc/{function_name}",
        method="POST",
        body=body or {},
        api_key=env_value("SUPABASE_SERVICE_ROLE_KEY"),
    )


def load_supabase_reminder_state():
    ledger_id = reminder_ledger_id()
    try:
        response = call_supabase_rpc("scheduled_reminder_state", {"p_ledger_id": ledger_id})
        if isinstance(response, dict) and isinstance(response.get("state"), dict):
            return response["state"], {"ledgerId": ledger_id, "rpc": "scheduled_reminder_state", "updatedAt": response.get("updated_at")}
    except urllib.error.HTTPError as error:
        # Older deployments may not have the RPC yet. Fall back to the REST row so
        # the reminder job can still use Supabase production state after the app
        # patch is deployed, then surface the RPC setup issue in diagnostics.
        if error.code not in (404, 400):
            raise
    rows = request_json(
        f"{supabase_url()}/rest/v1/car_share_ledgers?id=eq.{urllib.parse.quote(ledger_id, safe='')}&select=state,updated_at",
        api_key=env_value("SUPABASE_SERVICE_ROLE_KEY"),
    ) or []
    if rows and isinstance(rows[0].get("state"), dict):
        return rows[0]["state"], {"ledgerId": ledger_id, "rpc": "rest-fallback", "updatedAt": rows[0].get("updated_at")}
    state = {**DEFAULT_STATE}
    return state, {"ledgerId": ledger_id, "rpc": "empty-fallback", "updatedAt": ""}


def save_supabase_reminder_state(state):
    ledger_id = reminder_ledger_id()
    try:
        return call_supabase_rpc("save_scheduled_reminder_state", {"p_ledger_id": ledger_id, "p_state": state})
    except urllib.error.HTTPError as error:
        if error.code not in (404, 400):
            raise
    return request_json(
        f"{supabase_url()}/rest/v1/car_share_ledgers?id=eq.{urllib.parse.quote(ledger_id, safe='')}",
        method="PATCH",
        body={"state": state, "updated_at": datetime.now(timezone.utc).isoformat()},
        prefer="return=representation",
        api_key=env_value("SUPABASE_SERVICE_ROLE_KEY"),
    )



def call_supabase_rpc_as_user(function_name, body=None, user_token=None, timeout=20):
    if not supabase_url() or not supabase_anon_key():
        raise RuntimeError("Supabase server environment variables are missing")
    if not user_token:
        raise PermissionError("Missing Supabase user token")
    return request_json(
        f"{supabase_url()}/rest/v1/rpc/{function_name}",
        method="POST",
        body=body or {},
        token=user_token,
        api_key=supabase_anon_key(),
        timeout=timeout,
    )



def clean_retention_int(value, default, minimum=0, maximum=3650):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(minimum, min(maximum, parsed))


def build_retention_admin_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Retention payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    if not ledger_id:
        raise ValueError("Missing ledgerId")
    return ledger_id, {
        "target_ledger_id": ledger_id,
        "event_retention_days": clean_retention_int(payload.get("eventRetentionDays") or payload.get("event_retention_days"), 30, 1, 3650),
        "stale_push_days": clean_retention_int(payload.get("stalePushDays") or payload.get("stale_push_days"), 180, 1, 3650),
        "test_lab_report_days": clean_retention_int(payload.get("testLabReportDays") or payload.get("test_lab_report_days"), 30, 1, 3650),
        "keep_latest_test_lab_reports": clean_retention_int(payload.get("keepLatestTestLabReports") or payload.get("keep_latest_test_lab_reports"), 10, 0, 1000),
    }


def run_retention_admin_rpc_as_user(action, payload, user, user_token):
    ledger_id, rpc_payload = build_retention_admin_payload(payload)
    assert_user_can_admin_ledger(ledger_id, user, user_token)
    rpc_name = "preview_retention_cleanup" if action == "preview" else "run_retention_cleanup"
    return ledger_id, call_supabase_rpc_as_user(rpc_name, rpc_payload, user_token=user_token) or {}


def build_admin_report_save_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Report save payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    report = payload.get("report") or payload.get("reportPayload") or payload.get("report_payload")
    if not ledger_id:
        raise ValueError("Missing ledgerId")
    if not isinstance(report, dict):
        raise ValueError("Missing report payload")
    return ledger_id, report


def create_report_save_id(report):
    source_id = str(report.get("id") or "testlab").strip() or "testlab"
    cleaned = re.sub(r"[^0-9A-Za-z_-]+", "-", source_id).strip("-") or "testlab"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ").lower()
    return f"{cleaned}-save-{timestamp}-{secrets.token_hex(3)}"


def save_admin_report_as_user(payload, user, user_token):
    ledger_id, report = build_admin_report_save_payload(payload)
    assert_user_can_admin_ledger(ledger_id, user, user_token)
    source_report_id = str(report.get("id") or "").strip() or f"testlab-{int(time.time())}"
    report_id = create_report_save_id({"id": source_report_id})
    stored_report = dict(report)
    stored_report["id"] = report_id
    stored_report["sourceReportId"] = source_report_id
    stored_report["syncedAt"] = datetime.now(timezone.utc).isoformat()
    result = call_supabase_rpc_as_user("upsert_test_lab_report", {
        "target_ledger_id": ledger_id,
        "report_id_value": report_id,
        "report_payload_value": stored_report,
    }, user_token=user_token)
    return ledger_id, stored_report, result


def build_admin_health_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Admin health payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    if not ledger_id:
        raise ValueError("Missing ledgerId")
    return ledger_id


def build_render_admin_route_health(ledger_id, context):
    route_checks = [
        ("stateLoad", "/api/state/load", "Render normalized state load route"),
        ("writeContext", "/api/context/write", "Render write-context route"),
        ("jsonMirrorBackup", "/api/backups/json-mirror", "Render JSON mirror backup route"),
        ("ledgerDirectorySync", "/api/ledgers/sync", "Render ledger directory sync route"),
        ("adminTestDataCreate", "/api/admin/test-data/create", "Render generated test-data create route"),
        ("adminTestDataCleanup", "/api/admin/test-data/cleanup", "Render generated test-data cleanup route"),
        ("adminReportSave", "/api/admin/reports/save", "Render admin report save route"),
        ("adminSecurityHealth", "/api/admin/security-health", "Render admin security-health route"),
        ("retentionPreview", "/api/admin/retention/preview", "Render retention preview route"),
        ("retentionCleanup", "/api/admin/retention/cleanup", "Render retention cleanup route"),
        ("tripUpsert", "/api/trips/upsert", "Render trip save route"),
        ("fuelUpsert", "/api/fuel/upsert", "Render fuel save route"),
        ("bookingUpsert", "/api/bookings/upsert", "Render booking save route"),
        ("bookingDelete", "/api/bookings/delete", "Render booking delete route"),
        ("paymentStatusAction", "/api/payments/status-action", "Render payment-status action route"),
        ("settingsSave", "/api/settings/save", "Render workspace settings save route"),
        ("memberManagement", "/api/members/manage", "Render workspace member-management route"),
        ("vehicleLookup", "/api/vehicle/lookup", "Render vehicle lookup proxy route"),
    ]
    return [
        {
            "id": key,
            "ok": True,
            "route": route,
            "label": label,
            "detail": "Route is mounted in this Render service."
        }
        for key, route, label in route_checks
    ]


def build_render_admin_health(ledger_id, user, user_token):
    if not supabase_url() or not supabase_anon_key():
        raise RuntimeError("Supabase server environment variables are missing")
    context = assert_user_can_admin_ledger(ledger_id, user, user_token)
    checks = [
        {"id": "render", "ok": True, "label": "Render backend is reachable", "detail": "Admin health route responded."},
        {"id": "supabase-config", "ok": True, "label": "Supabase configuration is present", "detail": "SUPABASE_URL and Supabase API key are configured."},
        {"id": "supabase-session", "ok": True, "label": "Supabase session is active", "detail": str(user.get("email") or "")},
        {"id": "workspace-member", "ok": True, "label": "Signed-in user maps to this workspace", "detail": str(context.get("currentMemberId") or "")},
        {"id": "workspace-admin", "ok": bool(context.get("canAdmin")), "label": "Signed-in user is workspace admin", "detail": str(context.get("role") or "")},
        {"id": "open-period", "ok": bool(context.get("openPeriodId")), "label": "Open settlement period is available", "detail": str(context.get("openPeriodId") or "")},
        {"id": "server-rate-limits", "ok": not rate_limit_disabled(), "label": "Server-side route rate limits are enabled", "detail": "Admin, generated test data, retention, backup, and write routes are guarded by per-user/per-ledger in-memory limits."},
    ]
    checks.extend(build_render_admin_route_health(ledger_id, context))
    return {
        "ok": all(bool(check.get("ok")) for check in checks),
        "backend": "render",
        "ledgerId": ledger_id,
        "userEmail": user.get("email"),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "routes": {check.get("id"): check for check in checks if check.get("route")},
        "summary": "Render admin backend, Supabase session, workspace admin permission, and mounted safety routes are ready."
    }


def security_health_pass(name, detail=""):
    return {"ok": True, "name": name, "detail": detail}


def security_health_fail(name, detail=""):
    return {"ok": False, "name": name, "detail": detail, "level": "error"}


def normalize_healthcheck_rpc_result(data=None, error=None):
    name = "Fuel Ledger healthcheck RPC is available"
    if error:
        return security_health_fail(name, str(error))
    data = data if isinstance(data, dict) else {}
    if data.get("ok") is False:
        return security_health_fail(name, data.get("message") or "Healthcheck RPC returned an unhealthy result.")

    close_rpc = data.get("close_settlement_period_exists")
    critical_rpcs = data.get("critical_rpcs") if isinstance(data.get("critical_rpcs"), dict) else {}
    missing_rpcs = [key for key, exists in critical_rpcs.items() if exists is not True]
    if close_rpc is False:
        return security_health_fail("close_settlement_period RPC is installed", "The lightweight healthcheck ran, but close_settlement_period is missing from the schema.")
    if missing_rpcs:
        return security_health_fail("Critical write RPCs are installed", "Missing RPC(s): " + ", ".join(missing_rpcs) + ". Run the latest Supabase migrations before disabling table fallbacks.")

    schema_migrations = data.get("schema_migrations") if isinstance(data.get("schema_migrations"), dict) else {}
    missing_migrations = [item for item in schema_migrations.get("missing_migrations", []) if item]
    if missing_migrations:
        return security_health_fail("Fuel Ledger schema migrations are applied", "Missing migration(s): " + ", ".join(missing_migrations) + ". Run the latest Supabase migrations in order.")

    schema_drift = data.get("schema_drift") if isinstance(data.get("schema_drift"), dict) else {}
    drift_issues = []
    for key in ("missing_tables", "missing_columns", "missing_policies"):
        drift_issues.extend([item for item in schema_drift.get(key, []) if item])
    if drift_issues:
        shown = ", ".join(drift_issues[:12])
        if len(drift_issues) > 12:
            shown += f", and {len(drift_issues) - 12} more"
        return security_health_fail("Fuel Ledger schema shape matches the app", f"Missing schema object(s): {shown}. Run the latest Supabase migrations or re-apply supabase-schema.sql.")

    details = []
    if critical_rpcs:
        details.append(f"{len(critical_rpcs)} critical RPC(s) available")
    elif close_rpc is True:
        details.append("close_settlement_period exists")
    if schema_migrations.get("latest_expected"):
        details.append(f"schema migrations {schema_migrations.get('latest_applied') or 'unknown'}/{schema_migrations.get('latest_expected')}")
    if schema_drift.get("ok") is True:
        details.append("schema drift OK")
    if data.get("ledger_id"):
        details.append(f"ledger {data.get('ledger_id')}")
    result = security_health_pass(name, "; ".join(details) if details else "Healthcheck RPC returned successfully.")
    result["rpcHealth"] = data
    realtime_publication = data.get("realtime_publication") if isinstance(data.get("realtime_publication"), dict) else {}
    if realtime_publication.get("ledger_events_enabled") is False or realtime_publication.get("extra_tables"):
        result["warning"] = True
        result["level"] = "warning"
    return result


def build_render_security_health(ledger_id, user, user_token):
    if not supabase_url() or not supabase_anon_key():
        raise RuntimeError("Supabase server environment variables are missing")
    context = assert_user_can_admin_ledger(ledger_id, user, user_token)
    checks = [security_health_pass("Supabase session is fresh", "Verified by Render through Supabase Auth." )]

    rows = request_json(
        f"{supabase_url()}/rest/v1/ledger_members?select=id,name,email,role,is_active&ledger_id=eq.{quote_postgrest_value(ledger_id)}&is_active=eq.true&limit=100",
        token=user_token,
        api_key=supabase_anon_key(),
        timeout=8,
    ) or []
    checks.append(security_health_pass("Active ledger members are readable", f"{len(rows)} active member row(s)."))
    current_email = str(user.get("email") or "").strip().lower()
    current_row = next((row for row in rows if str(row.get("email") or "").strip().lower() == current_email), None)
    checks.append(security_health_pass("Current Supabase user is linked to an active ledger member", current_row.get("name") or current_email) if current_row else security_health_fail("Current Supabase user is linked to an active ledger member", current_email or "No email found."))
    checks.append(security_health_pass("Current linked member is admin in normalized tables") if str((current_row or {}).get("role") or context.get("role") or "").lower() == "admin" else security_health_fail("Current linked member is admin in normalized tables", "Admin role is required for backend security checks."))

    rpc_payload = call_supabase_rpc_as_user("fuel_ledger_healthcheck", {"target_ledger_id": ledger_id}, user_token=user_token)
    checks.append(normalize_healthcheck_rpc_result(rpc_payload))
    failed = [check for check in checks if not check.get("ok")]
    return {
        "ok": not failed,
        "backend": "render",
        "ledgerId": ledger_id,
        "userEmail": user.get("email"),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "summary": f"Render security health completed with {len(failed)} issue(s)." if failed else "Render security health checks passed.",
    }


def quote_postgrest_value(value):
    return urllib.parse.quote(str(value or ""), safe="")


def select_open_settlement_period_as_user(ledger_id, user_token):
    rows = request_json(
        f"{supabase_url()}/rest/v1/settlement_periods?select=id&ledger_id=eq.{quote_postgrest_value(ledger_id)}&status=eq.open&limit=1",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []
    if rows and rows[0].get("id"):
        return rows[0]["id"]
    return ""


def ensure_open_settlement_period_as_user(ledger_id, user_token):
    existing = select_open_settlement_period_as_user(ledger_id, user_token)
    if existing:
        return existing
    try:
        created = request_json(
            f"{supabase_url()}/rest/v1/settlement_periods?select=id",
            method="POST",
            body={"ledger_id": ledger_id, "status": "open", "label": "Current period"},
            token=user_token,
            api_key=supabase_anon_key(),
            prefer="return=representation",
        ) or []
        if created and created[0].get("id"):
            return created[0]["id"]
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
    retry = select_open_settlement_period_as_user(ledger_id, user_token)
    if retry:
        return retry
    raise RuntimeError("Could not create or find an open settlement period")



def normalize_vehicle_plate(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "").strip()).upper()[:16]


def parse_vehicle_float(*values):
    for value in values:
        try:
            if value is None or value == "":
                continue
            if isinstance(value, str):
                value = value.replace(",", ".")
            parsed = float(value)
            if parsed > 0:
                return round(parsed, 2)
        except (TypeError, ValueError):
            continue
    return None


def vehicle_nested_get(data, *paths):
    for path in paths:
        current = data
        ok = True
        for part in path.split("."):
            if isinstance(current, dict) and part in current:
                current = current.get(part)
            else:
                ok = False
                break
        if ok and current not in (None, ""):
            return current
    return None


def normalize_vehicle_fuel(value):
    text = str(value or "").strip().lower()
    if "diesel" in text:
        return "diesel"
    if any(term in text for term in ("benzin", "petrol", "gasoline", "95")):
        return "95"
    if any(term in text for term in ("electric", "elbil", "ev")):
        return "electric"
    if "hybrid" in text:
        return "hybrid"
    return text[:40]


def sanitize_vehicle_lookup_response(raw, plate, source_label):
    data = raw
    if isinstance(raw, list) and raw:
        data = raw[0]
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data.get("data")
    if not isinstance(data, dict):
        data = {}
    consumption = parse_vehicle_float(
        vehicle_nested_get(data, "consumptionLPer100Km", "consumption_l_per_100km", "fuel.consumptionLPer100Km", "technical.consumption_l_per_100km", "technical.fuel_consumption_combined"),
        vehicle_nested_get(data, "consumption", "fuelConsumption", "fuel_consumption"),
    )
    # Nummerplade Tjek exposes fuel usage as km/l in data.environment.fuel_usage.
    # Convert it to the app's L/100 km setting before it reaches the browser.
    km_per_l = parse_vehicle_float(vehicle_nested_get(data, "kmPerLiter", "km_per_liter", "fuel.kmPerLiter", "environment.fuel_usage"))
    if not consumption and km_per_l:
        consumption = round(100 / km_per_l, 2)
    vehicle = {
        "plate": normalize_vehicle_plate(vehicle_nested_get(data, "plate", "registrationNumber", "numberPlate", "regno", "vehicle.registration_number") or plate),
        "make": str(vehicle_nested_get(data, "make", "brand", "manufacturer", "vehicle.make") or "")[:80],
        "model": str(vehicle_nested_get(data, "model", "vehicle.model") or "")[:120],
        "variant": str(vehicle_nested_get(data, "variant", "version", "modelVariant", "vehicle.variant") or "")[:120],
        "fuelType": normalize_vehicle_fuel(vehicle_nested_get(data, "fuelType", "fuel_type", "fuel", "technical.fuel_type", "vehicle.fuel_type")),
        "consumptionLPer100Km": consumption,
        "tankCapacityL": parse_vehicle_float(vehicle_nested_get(data, "tankCapacityL", "tank_capacity_l", "fuel.tankCapacityL", "technical.tank_capacity_l")),
        "co2GPerKm": parse_vehicle_float(vehicle_nested_get(data, "co2GPerKm", "co2_g_per_km", "co2", "emissions.co2", "environment.co2_emission")),
        "year": str(vehicle_nested_get(data, "year", "modelYear", "model_year", "vehicle.model_year") or "")[:20],
        "firstRegDate": str(vehicle_nested_get(data, "firstRegDate", "first_reg_date", "vehicle.first_reg_date") or "")[:32],
        "color": str(vehicle_nested_get(data, "color", "vehicle.color") or "")[:40],
        "chassisType": str(vehicle_nested_get(data, "chassisType", "chassis_type", "vehicle.chassis_type") or "")[:60],
        "engineVolumeCc": parse_vehicle_float(vehicle_nested_get(data, "engineVolumeCc", "engine_volume", "engine.volume", "vehicle.engine_volume")),
        "enginePowerKw": parse_vehicle_float(vehicle_nested_get(data, "enginePowerKw", "engine_power", "engine.power_kw", "vehicle.engine_power")),
        "isHybrid": vehicle_nested_get(data, "isHybrid", "is_hybrid", "vehicle.is_hybrid"),
        "euroNorm": str(vehicle_nested_get(data, "euroNorm", "euro_norm", "environment.euro_norm") or "")[:40],
        "particleFilter": vehicle_nested_get(data, "particleFilter", "particle_filter", "environment.particle_filter"),
        "drivingNoiseDb": parse_vehicle_float(vehicle_nested_get(data, "drivingNoiseDb", "driving_noise", "environment.driving_noise")),
        "motDate": str(vehicle_nested_get(data, "motDate", "mot.date", "mot_info.date", "vehicle.mot_info.date") or "")[:32],
        "motResult": str(vehicle_nested_get(data, "motResult", "mot.result", "mot_info.result", "vehicle.mot_info.result") or "")[:80],
        "motMileageKm": parse_vehicle_float(vehicle_nested_get(data, "motMileageKm", "mot.mileage", "mot_info.mileage", "vehicle.mot_info.mileage", "vehicle.mileage")),
        "nextInspectionDate": str(vehicle_nested_get(data, "nextInspectionDate", "mot.next_inspection_date", "mot_info.next_inspection_date", "vehicle.mot_info.next_inspection_date") or "")[:32],
        "source": source_label,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
    # Keep VIN/raw equipment out of the browser payload by default; they are not needed for fuel sharing.
    return {key: value for key, value in vehicle.items() if value not in (None, "")}


def vehicle_lookup_url_for_plate(plate):
    template = env_value("VEHICLE_LOOKUP_API_URL")
    if not template:
        return ""
    if "{plate}" in template:
        return template.replace("{plate}", urllib.parse.quote(plate))
    delimiter = "&" if "?" in template else "?"
    param = env_value("VEHICLE_LOOKUP_PLATE_PARAM", "plate") or "plate"
    return f"{template}{delimiter}{urllib.parse.quote(param)}={urllib.parse.quote(plate)}"


def fetch_vehicle_lookup(plate):
    url = vehicle_lookup_url_for_plate(plate)
    if not url:
        return {"ok": False, "code": "VEHICLE_LOOKUP_NOT_CONFIGURED", "message": "Vehicle lookup API is not configured on Render. Keep using manual fuel settings."}, 200
    headers = {"Accept": "application/json", "User-Agent": "FuelLedger/1.0"}
    api_key = env_value("VEHICLE_LOOKUP_API_KEY")
    if api_key:
        header_name = env_value("VEHICLE_LOOKUP_API_KEY_HEADER", "Authorization") or "Authorization"
        prefix = env_value("VEHICLE_LOOKUP_API_KEY_PREFIX", "Bearer ")
        headers[header_name] = f"{prefix}{api_key}" if prefix else api_key
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=8) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding", "").lower() == "gzip":
            raw = gzip.decompress(raw)
        data = json.loads(raw.decode("utf-8-sig", errors="replace")) if raw else {}
    source = env_value("VEHICLE_LOOKUP_SOURCE_LABEL", "Configured vehicle lookup API")
    return {"ok": True, "code": "VEHICLE_LOOKUP_OK", "vehicle": sanitize_vehicle_lookup_response(data, plate, source), "message": "Vehicle lookup completed."}, 200

def build_write_context_backend_payload(payload, user):
    if not isinstance(payload, dict):
        raise ValueError("Write context payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    if not ledger_id:
        raise ValueError("Missing ledgerId")
    if not supabase_url() or not supabase_anon_key():
        raise RuntimeError("Supabase server environment variables are missing")
    return ledger_id


def get_write_context_as_user(ledger_id, user, user_token):
    rows = request_json(
        f"{supabase_url()}/rest/v1/ledger_members?select=id,name,email,role,is_active&ledger_id=eq.{quote_postgrest_value(ledger_id)}&is_active=eq.true",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []
    if not rows:
        raise PermissionError("No active ledger members found for this workspace")

    user_email = str(user.get("email") or "").strip().lower()
    current = next((row for row in rows if str(row.get("email") or "").strip().lower() == user_email), None)
    if not current or not current.get("id"):
        raise PermissionError("Signed-in user is not an active member of this workspace")

    open_period_id = ensure_open_settlement_period_as_user(ledger_id, user_token)
    member_ids_by_name = {str(row.get("name") or ""): row.get("id") for row in rows if row.get("name") and row.get("id")}
    return {
        "ledgerId": ledger_id,
        "openPeriodId": open_period_id,
        "memberIdsByName": member_ids_by_name,
        "currentMemberId": current.get("id"),
        "role": current.get("role") or "member",
        "canWrite": True,
        "canAdmin": current.get("role") == "admin",
        "activeMemberIds": [str(row.get("id")) for row in rows if row.get("id")],
    }

def assert_member_ids_belong_to_context(context, member_ids, label="member"):
    active_ids = {str(value) for value in (context.get("activeMemberIds") or []) if str(value or "").strip()}
    checked = [str(value) for value in member_ids if str(value or "").strip()]
    missing = [value for value in checked if value not in active_ids]
    if missing:
        raise PermissionError(f"{label} must belong to the active workspace")


def assert_member_scoped_write_allowed(context, target_member_id, action_label):
    target = str(target_member_id or "").strip()
    if not target:
        raise ValueError(f"{action_label} requires a member id")
    assert_member_ids_belong_to_context(context, [target], action_label)
    if context.get("canAdmin"):
        return
    if target != str(context.get("currentMemberId") or ""):
        raise PermissionError(f"Only workspace admins can save {action_label} for another member")


def assert_trip_write_allowed(context, rpc_payload):
    assert_member_scoped_write_allowed(context, rpc_payload.get("driver_member_id"), "trip driver")
    assert_member_ids_belong_to_context(context, rpc_payload.get("participant_member_ids") or [], "trip participants")


def assert_payment_status_action_allowed(context, rpc_payload):
    payer = str(rpc_payload.get("payer_member_id") or "").strip()
    recipient = str(rpc_payload.get("recipient_member_id") or "").strip()
    assert_member_ids_belong_to_context(context, [payer, recipient], "payment members")
    if context.get("canAdmin"):
        return
    current = str(context.get("currentMemberId") or "").strip()
    next_status = str(rpc_payload.get("next_status") or "").strip().lower()
    if next_status == "paid" and current == payer:
        return
    if next_status in {"requested", "open"} and current == recipient:
        return
    raise PermissionError("Only involved workspace members can update this payment status")


def select_booking_owner_as_user(ledger_id, legacy_booking_id, user_token):
    ledger_q = quote_postgrest_value(ledger_id)
    booking_q = quote_postgrest_value(legacy_booking_id)
    rows = request_json(
        f"{supabase_url()}/rest/v1/car_bookings?select=member_id&ledger_id=eq.{ledger_q}&legacy_id=eq.{booking_q}&deleted_at=is.null&limit=1",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []
    if not rows:
        raise PermissionError("Booking must belong to the active workspace")
    return rows[0].get("member_id")

def get_state_load_context_as_service(ledger_id, user):
    """Authorize a signed-in user for state load, then read workspace state server-side.

    Regular invited members must be able to load their workspace even when table
    RLS is stricter than the app state view. We still verify the Supabase user
    first, then use the service role only after the user is confirmed as an
    active member of the requested ledger.
    """
    ledger_q = quote_postgrest_value(ledger_id)
    rows = request_json(
        f"{supabase_url()}/rest/v1/ledger_members?select=id,name,email,role,is_active&ledger_id=eq.{ledger_q}&is_active=eq.true",
        api_key=supabase_key(),
    ) or []
    if not rows:
        raise PermissionError("No active ledger members found for this workspace")

    user_email = str(user.get("email") or "").strip().lower()
    current = next((row for row in rows if str(row.get("email") or "").strip().lower() == user_email), None)
    if not current or not current.get("id"):
        raise PermissionError("Signed-in user is not an active member of this workspace")

    open_period_id = ensure_open_settlement_period_as_service(ledger_id)
    member_ids_by_name = {str(row.get("name") or ""): row.get("id") for row in rows if row.get("name") and row.get("id")}
    return {
        "ledgerId": ledger_id,
        "openPeriodId": open_period_id,
        "memberIdsByName": member_ids_by_name,
        "currentMemberId": current.get("id"),
        "role": current.get("role") or "member",
        "canWrite": True,
        "canAdmin": current.get("role") == "admin",
        "activeMemberIds": [str(row.get("id")) for row in rows if row.get("id")],
    }


def select_open_settlement_period_as_service(ledger_id):
    rows = request_json(
        f"{supabase_url()}/rest/v1/settlement_periods?select=id&ledger_id=eq.{quote_postgrest_value(ledger_id)}&status=eq.open&limit=1",
        api_key=supabase_key(),
    ) or []
    if rows and rows[0].get("id"):
        return rows[0]["id"]
    return ""


def ensure_open_settlement_period_as_service(ledger_id):
    existing = select_open_settlement_period_as_service(ledger_id)
    if existing:
        return existing
    try:
        created = request_json(
            f"{supabase_url()}/rest/v1/settlement_periods?select=id",
            method="POST",
            body={"ledger_id": ledger_id, "status": "open", "label": "Current period"},
            api_key=supabase_key(),
            prefer="return=representation",
        ) or []
        if created and created[0].get("id"):
            return created[0]["id"]
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
    retry = select_open_settlement_period_as_service(ledger_id)
    if retry:
        return retry
    raise RuntimeError("Could not create or find an open settlement period")


def get_normalized_state_rows_as_user(ledger_id, user, user_token):
    context = get_state_load_context_as_service(ledger_id, user)
    ledger_q = quote_postgrest_value(ledger_id)
    ledger = select_ledger_settings_as_service(ledger_id)
    members = request_json(
        f"{supabase_url()}/rest/v1/ledger_members?select=id,name,email,role,is_active,mobilepay_phone,created_at&ledger_id=eq.{ledger_q}&is_active=eq.true&order=created_at.asc",
        api_key=supabase_key(),
    ) or []
    periods = request_json(
        f"{supabase_url()}/rest/v1/settlement_periods?select=id,status,label,closed_at,snapshot_json,created_at&ledger_id=eq.{ledger_q}&order=created_at.asc",
        api_key=supabase_key(),
    ) or []
    trips = request_json(
        f"{supabase_url()}/rest/v1/trips?select=id,legacy_id,period_id,driver_member_id,trip_date,start_km,end_km,note,deleted_at,created_at&ledger_id=eq.{ledger_q}&deleted_at=is.null&order=trip_date.asc",
        api_key=supabase_key(),
    ) or []
    fuel = request_json(
        f"{supabase_url()}/rest/v1/fuel_payments?select=id,legacy_id,period_id,payer_member_id,payment_date,amount,currency,liters,price_per_liter,odometer,station_name,station_brand,station_lat,station_lng,user_lat,user_lng,full_tank,deleted_at,created_at&ledger_id=eq.{ledger_q}&deleted_at=is.null&order=payment_date.asc",
        api_key=supabase_key(),
    ) or []
    bookings = request_json(
        f"{supabase_url()}/rest/v1/car_bookings?select=id,legacy_id,member_id,start_at,end_at,purpose,deleted_at,created_by_member_id,created_at&ledger_id=eq.{ledger_q}&deleted_at=is.null&order=start_at.asc",
        api_key=supabase_key(),
    ) or []
    requests = request_json(
        f"{supabase_url()}/rest/v1/settlement_requests?select=id,period_id,from_member_id,to_member_id,amount,currency,status&ledger_id=eq.{ledger_q}",
        api_key=supabase_key(),
    ) or []
    trip_participants = []
    trip_ids = [str(row.get("id") or "").strip() for row in trips if str(row.get("id") or "").strip()]
    if trip_ids:
        in_values = ",".join(quote_postgrest_value(value) for value in trip_ids)
        trip_participants = request_json(
            f"{supabase_url()}/rest/v1/trip_participants?select=trip_id,member_id&trip_id=in.({in_values})",
            api_key=supabase_key(),
        ) or []
    return {
        "context": context,
        "ledger": ledger,
        "members": members,
        "periods": periods,
        "trips": trips,
        "fuel": fuel,
        "bookings": bookings,
        "requests": requests,
        "tripParticipants": trip_participants,
    }




def clamp_number(value, fallback, minimum=None, maximum=None):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = float(fallback)
    if minimum is not None:
        parsed = max(float(minimum), parsed)
    if maximum is not None:
        parsed = min(float(maximum), parsed)
    return round(parsed, 2)


def clean_settings_vehicle_info(value):
    if not isinstance(value, dict):
        return {}
    allowed = {
        "plate", "make", "model", "variant", "fuelType", "consumptionLPer100Km", "tankCapacityL",
        "co2GPerKm", "year", "firstRegDate", "color", "chassisType", "engineVolumeCc",
        "enginePowerKw", "isHybrid", "euroNorm", "particleFilter", "drivingNoiseDb",
        "motDate", "motResult", "motMileageKm", "nextInspectionDate", "source", "checkedAt"
    }
    cleaned = {}
    for key, raw in value.items():
        if key not in allowed:
            continue
        if isinstance(raw, (int, float, bool)):
            cleaned[key] = raw
        else:
            text = str(raw or "").strip()
            if text:
                cleaned[key] = text[:240]
    return cleaned


def select_ledger_settings_as_service(ledger_id, require_vehicle_columns=False):
    ledger_q = quote_postgrest_value(ledger_id)
    extended_select = "id,slug,name,currency,fuel_type,estimated_consumption_l_per_100km,fuel_tank_capacity_l,fallback_fuel_price,low_fuel_threshold_percent,vehicle_plate,vehicle_info,vehicle_lookup_source,vehicle_lookup_at"
    base_select = "id,slug,name,currency,fuel_type,estimated_consumption_l_per_100km,fuel_tank_capacity_l,fallback_fuel_price,low_fuel_threshold_percent"
    try:
        rows = request_json(
            f"{supabase_url()}/rest/v1/ledgers?select={extended_select}&id=eq.{ledger_q}",
            api_key=supabase_key(),
            timeout=SETTINGS_SAVE_SUPABASE_TIMEOUT,
        ) or []
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
        if error.code == 400 and any(column in raw for column in ("vehicle_plate", "vehicle_info", "vehicle_lookup_source", "vehicle_lookup_at")):
            if require_vehicle_columns:
                raise SettingsSchemaMissingError("Apply Supabase migration 038_vehicle_settings_columns.sql before saving vehicle settings.")
            rows = request_json(
                f"{supabase_url()}/rest/v1/ledgers?select={base_select}&id=eq.{ledger_q}",
                api_key=supabase_key(),
                timeout=SETTINGS_SAVE_SUPABASE_TIMEOUT,
            ) or []
        else:
            raise urllib.error.HTTPError(error.url, error.code, raw, error.headers, None)
    row = rows[0] if isinstance(rows, list) and rows else {}
    if require_vehicle_columns and row and not all(key in row for key in ("vehicle_plate", "vehicle_info", "vehicle_lookup_source", "vehicle_lookup_at")):
        raise SettingsSchemaMissingError("Apply Supabase migration 038_vehicle_settings_columns.sql before saving vehicle settings.")
    return row


def build_settings_save_payload(payload, user):
    if not isinstance(payload, dict):
        raise ValueError("Settings save payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    if not ledger_id:
        raise ValueError("Settings save requires ledgerId")
    allowed_ledger = build_write_context_backend_payload({"ledgerId": ledger_id}, user)
    if allowed_ledger != ledger_id:
        raise PermissionError("Cannot save settings for a different workspace")
    settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
    now = str(settings.get("updatedAt") or payload.get("updatedAt") or datetime.now(timezone.utc).isoformat()).strip()
    vehicle_info = clean_settings_vehicle_info(settings.get("vehicleInfo"))
    vehicle_plate = normalize_vehicle_plate(settings.get("vehiclePlate") or vehicle_info.get("plate") or "")
    if vehicle_plate and vehicle_info and not vehicle_info.get("plate"):
        vehicle_info["plate"] = vehicle_plate
    if vehicle_info and not vehicle_info.get("checkedAt"):
        vehicle_info["checkedAt"] = str(settings.get("vehicleLookupAt") or now)
    ledger = {
        "id": ledger_id,
        "slug": str(settings.get("slug") or ledger_id).strip() or ledger_id,
        "name": str(settings.get("name") or "Fuel Ledger").strip() or "Fuel Ledger",
        "currency": str(settings.get("currency") or "DKK").strip()[:12] or "DKK",
        "fuel_type": str(settings.get("fuelType") or "diesel").strip()[:40] or "diesel",
        "estimated_consumption_l_per_100km": clamp_number(settings.get("fuelConsumption"), 5.3, 0.1, 100),
        "fuel_tank_capacity_l": clamp_number(settings.get("fuelTankCapacity"), 55, 1, 1000),
        "fallback_fuel_price": clamp_number(settings.get("fuelFallbackPrice"), 14.5, 0.1, 1000),
        "low_fuel_threshold_percent": clamp_number(settings.get("fuelWarningThreshold"), 70, 1, 100),
        "vehicle_plate": vehicle_plate,
        "vehicle_info": vehicle_info,
        "vehicle_lookup_source": str(settings.get("vehicleLookupSource") or ("lookup" if vehicle_info else "manual")).strip()[:120] or "manual",
        "vehicle_lookup_at": str(settings.get("vehicleLookupAt") or vehicle_info.get("checkedAt") or "").strip() or None,
        "updated_at": now,
    }
    members = payload.get("members") if isinstance(payload.get("members"), list) else []
    cleaned_members = []
    seen_names = set()
    for raw in members:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        cleaned_members.append({
            "ledger_id": ledger_id,
            "name": name,
            "email": str(raw.get("email") or "").strip().lower() or None,
            "role": "admin" if str(raw.get("role") or "").strip().lower() == "admin" else "member",
            "mobilepay_phone": str(raw.get("mobilepayPhone") or raw.get("mobilepay_phone") or "").strip()[:40] or None,
            "is_active": True,
            "updated_at": now,
        })
    if not cleaned_members:
        raise ValueError("Settings save requires at least one active member")
    return ledger, cleaned_members


def upsert_settings_as_service(ledger, members):
    ledger_id = str(ledger.get("id") or "").strip()
    requested_vehicle = bool(ledger.get("vehicle_plate") or ledger.get("vehicle_info") or ledger.get("vehicle_lookup_source") or ledger.get("vehicle_lookup_at"))
    try:
        ledger_result = request_json(
            f"{supabase_url()}/rest/v1/ledgers?on_conflict=id&select=id,slug,currency,fuel_type,estimated_consumption_l_per_100km,fuel_tank_capacity_l,fallback_fuel_price,low_fuel_threshold_percent,vehicle_plate,vehicle_info,vehicle_lookup_source,vehicle_lookup_at,updated_at",
            method="POST",
            body=ledger,
            prefer="resolution=merge-duplicates,return=representation",
            api_key=supabase_key(),
            timeout=SETTINGS_SAVE_SUPABASE_TIMEOUT,
        ) or []
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
        optional_columns = ("vehicle_plate", "vehicle_info", "vehicle_lookup_source", "vehicle_lookup_at")
        if error.code == 400 and any(column in raw for column in optional_columns):
            raise SettingsSchemaMissingError("Apply Supabase migration 038_vehicle_settings_columns.sql before saving vehicle settings.")
        raise urllib.error.HTTPError(error.url, error.code, raw, error.headers, None)

    saved = ledger_result[0] if isinstance(ledger_result, list) and ledger_result else {}
    if not saved:
        saved = select_ledger_settings_as_service(ledger_id, require_vehicle_columns=requested_vehicle)
    elif requested_vehicle and not all(key in saved for key in ("vehicle_plate", "vehicle_info", "vehicle_lookup_source", "vehicle_lookup_at")):
        raise SettingsSchemaMissingError("Apply Supabase migration 038_vehicle_settings_columns.sql before saving vehicle settings.")

    if requested_vehicle:
        read_back = select_ledger_settings_as_service(ledger_id, require_vehicle_columns=True)
        expected_plate = str(ledger.get("vehicle_plate") or "").strip().upper()
        actual_plate = str(read_back.get("vehicle_plate") or "").strip().upper()
        expected_info = ledger.get("vehicle_info") if isinstance(ledger.get("vehicle_info"), dict) else {}
        actual_info = read_back.get("vehicle_info") if isinstance(read_back.get("vehicle_info"), dict) else {}
        if expected_plate and actual_plate != expected_plate:
            raise RuntimeError("Settings save verification failed: vehicle plate was not persisted.")
        if expected_info and not actual_info:
            raise RuntimeError("Settings save verification failed: vehicle details were not persisted.")
        saved = read_back

    member_result = []
    member_warning = ""
    try:
        member_result = request_json(
            f"{supabase_url()}/rest/v1/ledger_members?on_conflict=ledger_id,name&select=id,name,role,email,mobilepay_phone",
            method="POST",
            body=members,
            prefer="resolution=merge-duplicates,return=representation",
            api_key=supabase_key(),
            timeout=SETTINGS_MEMBER_SYNC_TIMEOUT,
        ) or []
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
        if error.code == 400 and "mobilepay_phone" in raw:
            fallback_members = []
            for member in members:
                item = dict(member)
                item.pop("mobilepay_phone", None)
                fallback_members.append(item)
            try:
                member_result = request_json(
                    f"{supabase_url()}/rest/v1/ledger_members?on_conflict=ledger_id,name&select=id,name,role,email",
                    method="POST",
                    body=fallback_members,
                    prefer="resolution=merge-duplicates,return=representation",
                    api_key=supabase_key(),
                    timeout=SETTINGS_MEMBER_SYNC_TIMEOUT,
                ) or []
            except (TimeoutError, socket.timeout, urllib.error.URLError) as member_error:
                member_warning = f"Member directory sync skipped after settings save: {member_error}"
                member_result = []
        else:
            raise urllib.error.HTTPError(error.url, error.code, raw, error.headers, None)
    except (TimeoutError, socket.timeout, urllib.error.URLError) as member_error:
        member_warning = f"Member directory sync skipped after settings save: {member_error}"
        member_result = []


    settings = {
        "currency": saved.get("currency") or ledger.get("currency"),
        "fuelType": saved.get("fuel_type") or ledger.get("fuel_type"),
        "fuelConsumption": saved.get("estimated_consumption_l_per_100km") or ledger.get("estimated_consumption_l_per_100km"),
        "fuelTankCapacity": saved.get("fuel_tank_capacity_l") or ledger.get("fuel_tank_capacity_l"),
        "fuelFallbackPrice": saved.get("fallback_fuel_price") or ledger.get("fallback_fuel_price"),
        "fuelWarningThreshold": saved.get("low_fuel_threshold_percent") or ledger.get("low_fuel_threshold_percent"),
        "vehiclePlate": saved.get("vehicle_plate") if "vehicle_plate" in saved else "",
        "vehicleInfo": saved.get("vehicle_info") if isinstance(saved.get("vehicle_info"), dict) else {},
        "vehicleLookupSource": saved.get("vehicle_lookup_source") if "vehicle_lookup_source" in saved else "",
        "vehicleLookupAt": saved.get("vehicle_lookup_at") if "vehicle_lookup_at" in saved else "",
        "updatedAt": saved.get("updated_at") or ledger.get("updated_at"),
    }
    persisted = {
        "vehiclePlate": bool(settings.get("vehiclePlate")),
        "vehicleInfo": bool(settings.get("vehicleInfo")),
        "fuelType": bool(settings.get("fuelType")),
        "fuelTankCapacity": bool(settings.get("fuelTankCapacity")),
        "fuelConsumption": bool(settings.get("fuelConsumption")),
    }
    return {
        "ledgerId": ledger_id,
        "settings": settings,
        "persisted": persisted,
        "verified": True,
        "members": member_result,
        "memberCount": len(member_result) if isinstance(member_result, list) else 0,
        "memberWarning": member_warning,
    }


def normalize_backend_member_payload(raw):
    if not isinstance(raw, dict):
        raise ValueError("Member payload must be an object")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("Member name is required")
    role = "admin" if str(raw.get("role") or "").strip().lower() == "admin" else "member"
    email = str(raw.get("email") or "").strip().lower() or None
    phone = str(raw.get("mobilepayPhone") or raw.get("mobilepay_phone") or "").strip() or None
    member_id = str(raw.get("id") or raw.get("memberId") or raw.get("member_id") or "").strip() or None
    return {
        "id": member_id,
        "name": name,
        "email": email,
        "mobilepay_phone": phone,
        "role": role,
        "is_active": bool(raw.get("isActive", raw.get("is_active", True))),
    }


def list_members_as_user(ledger_id, user, user_token):
    assert_user_can_admin_ledger(ledger_id, user, user_token)
    ledger_q = urllib.parse.quote(str(ledger_id), safe="")
    return request_json(
        f"{supabase_url()}/rest/v1/ledger_members?select=id,ledger_id,name,email,role,is_active,mobilepay_phone,created_at,updated_at&ledger_id=eq.{ledger_q}&order=is_active.desc,name.asc",
        token=user_token,
        api_key=supabase_anon_key(),
        timeout=5,
    ) or []


def upsert_member_as_user(ledger_id, member, user, user_token):
    assert_user_can_admin_ledger(ledger_id, user, user_token)
    return call_supabase_rpc_as_user("upsert_ledger_member_admin", {
        "target_ledger_id": ledger_id,
        "target_member_id": member.get("id") or None,
        "member_name": member.get("name"),
        "member_email": member.get("email") or None,
        "member_mobilepay_phone": member.get("mobilepay_phone") or None,
        "member_role": member.get("role"),
        "member_is_active": member.get("is_active") is not False,
    }, user_token=user_token, timeout=6)


def set_member_active_as_user(ledger_id, member_id, is_active, user, user_token):
    if not member_id:
        raise ValueError("Missing memberId")
    assert_user_can_admin_ledger(ledger_id, user, user_token)
    return call_supabase_rpc_as_user("set_ledger_member_active_admin", {
        "target_ledger_id": ledger_id,
        "target_member_id": member_id,
        "member_is_active": bool(is_active),
    }, user_token=user_token, timeout=6)


def build_ledger_directory_sync_payload(payload, user):
    if not isinstance(payload, dict):
        raise ValueError("Ledger directory sync payload must be an object")
    ledger = payload.get("ledger") if isinstance(payload.get("ledger"), dict) else {}
    members = payload.get("members") if isinstance(payload.get("members"), list) else []
    ledger_id = str(ledger.get("id") or payload.get("ledgerId") or "").strip()
    if not ledger_id:
        raise ValueError("Ledger directory sync requires ledger.id")
    slug = str(ledger.get("slug") or ledger_id).strip()
    if not slug:
        raise ValueError("Ledger directory sync requires ledger.slug")
    allowed_ledger = build_write_context_backend_payload({"ledgerId": ledger_id}, user)
    if allowed_ledger != ledger_id:
        raise PermissionError("Cannot sync a different workspace")

    cleaned_ledger = {
        "id": ledger_id,
        "slug": slug,
        "name": str(ledger.get("name") or "Fuel Ledger").strip() or "Fuel Ledger",
        "currency": str(ledger.get("currency") or "DKK").strip() or "DKK",
        "fuel_type": str(ledger.get("fuel_type") or "diesel").strip() or "diesel",
        "estimated_consumption_l_per_100km": ledger.get("estimated_consumption_l_per_100km"),
        "fuel_tank_capacity_l": ledger.get("fuel_tank_capacity_l"),
        "fallback_fuel_price": ledger.get("fallback_fuel_price"),
        "low_fuel_threshold_percent": ledger.get("low_fuel_threshold_percent"),
        "updated_at": ledger.get("updated_at") or datetime.now(timezone.utc).isoformat(),
    }
    for numeric_key, fallback in (
        ("estimated_consumption_l_per_100km", 5.3),
        ("fuel_tank_capacity_l", 55),
        ("fallback_fuel_price", 14.5),
        ("low_fuel_threshold_percent", 70),
    ):
        try:
            cleaned_ledger[numeric_key] = float(cleaned_ledger.get(numeric_key) or fallback)
        except (TypeError, ValueError):
            cleaned_ledger[numeric_key] = fallback

    cleaned_members = []
    seen_names = set()
    for raw in members:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        cleaned_members.append({
            "ledger_id": ledger_id,
            "name": name,
            "email": str(raw.get("email") or "").strip().lower() or None,
            "role": "admin" if str(raw.get("role") or "").strip().lower() == "admin" else "member",
            "is_active": bool(raw.get("is_active", True)),
            "updated_at": raw.get("updated_at") or cleaned_ledger["updated_at"],
        })
    if not cleaned_members:
        raise ValueError("Ledger directory sync requires at least one member")
    return cleaned_ledger, cleaned_members


def assert_user_can_admin_ledger(ledger_id, user, user_token):
    context = get_write_context_as_user(ledger_id, user, user_token)
    if not context.get("canAdmin"):
        raise PermissionError("Only workspace admins can sync the ledger directory")
    return context


def upsert_ledger_directory_as_user(ledger, members, user_token):
    ledger_id = str(ledger.get("id") or "").strip()
    try:
        ledger_result = request_json(
            f"{supabase_url()}/rest/v1/ledgers?on_conflict=id&select=id,slug",
            method="POST",
            body=ledger,
            token=user_token,
            prefer="resolution=merge-duplicates,return=representation",
            api_key=supabase_anon_key(),
        ) or []
    except urllib.error.HTTPError as error:
        # Older production databases may not have fuel_tank_capacity_l yet.
        raw = error.read().decode("utf-8")
        if error.code == 400 and "fuel_tank_capacity_l" in raw and "fuel_tank_capacity_l" in ledger:
            fallback = dict(ledger)
            fallback.pop("fuel_tank_capacity_l", None)
            ledger_result = request_json(
                f"{supabase_url()}/rest/v1/ledgers?on_conflict=id&select=id,slug",
                method="POST",
                body=fallback,
                token=user_token,
                prefer="resolution=merge-duplicates,return=representation",
                api_key=supabase_anon_key(),
            ) or []
        else:
            raise urllib.error.HTTPError(error.url, error.code, raw, error.headers, None)

    member_result = request_json(
        f"{supabase_url()}/rest/v1/ledger_members?on_conflict=ledger_id,name&select=id,name,role",
        method="POST",
        body=members,
        token=user_token,
        prefer="resolution=merge-duplicates,return=representation",
        api_key=supabase_anon_key(),
    ) or []
    return {"ledger": ledger_result[0] if isinstance(ledger_result, list) and ledger_result else None, "members": member_result, "memberCount": len(member_result) if isinstance(member_result, list) else 0, "ledgerId": ledger_id}



def build_json_mirror_backup_payload(payload, user):
    if not isinstance(payload, dict):
        raise ValueError("JSON mirror backup payload must be an object")
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
    if not ledger_id:
        raise ValueError("JSON mirror backup requires ledgerId")
    allowed_ledger = build_write_context_backend_payload({"ledgerId": ledger_id}, user)
    if allowed_ledger != ledger_id:
        raise PermissionError("Cannot save a JSON mirror for a different workspace")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise ValueError("JSON mirror backup requires a state object")
    updated_at = str(payload.get("updatedAt") or payload.get("updated_at") or datetime.now(timezone.utc).isoformat()).strip()
    if not updated_at:
        updated_at = datetime.now(timezone.utc).isoformat()
    reason = str(payload.get("reason") or "").strip()
    return ledger_id, state, updated_at, reason


def upsert_json_mirror_as_user(ledger_id, state, updated_at, user_token):
    result = request_json(
        f"{supabase_url()}/rest/v1/car_share_ledgers?on_conflict=id&select=id,updated_at",
        method="POST",
        body={"id": ledger_id, "state": state, "updated_at": updated_at},
        token=user_token,
        prefer="resolution=merge-duplicates,return=representation",
        api_key=supabase_anon_key(),
    ) or []
    return result[0] if isinstance(result, list) and result else {"id": ledger_id, "updated_at": updated_at}


def build_trip_upsert_rpc_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Trip upsert payload must be an object")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    trip = payload.get("trip") if isinstance(payload.get("trip"), dict) else {}
    participants = payload.get("participantMemberIds")
    if not isinstance(participants, list):
        participants = payload.get("participant_member_ids") if isinstance(payload.get("participant_member_ids"), list) else []

    required = {
        "target_ledger_id": context.get("ledgerId") or payload.get("ledgerId") or trip.get("ledger_id"),
        "target_open_period_id": context.get("openPeriodId") or payload.get("openPeriodId") or trip.get("period_id"),
        "legacy_trip_id": trip.get("legacy_id") or payload.get("legacyTripId") or payload.get("legacy_trip_id"),
        "driver_member_id": trip.get("driver_member_id") or payload.get("driver_member_id"),
        "trip_date_value": trip.get("trip_date") or payload.get("trip_date_value"),
        "start_km_value": trip.get("start_km", payload.get("start_km_value")),
        "end_km_value": trip.get("end_km", payload.get("end_km_value")),
        "note_value": trip.get("note", payload.get("note_value")),
        "participant_member_ids": [str(value) for value in participants if str(value or "").strip()],
    }

    missing = [name for name in ("target_ledger_id", "target_open_period_id", "legacy_trip_id", "driver_member_id", "trip_date_value") if not required.get(name)]
    if missing:
        raise ValueError(f"Missing trip upsert field(s): {', '.join(missing)}")
    if not required["participant_member_ids"]:
        raise ValueError("Trip must include at least one participant")

    try:
        required["start_km_value"] = float(required["start_km_value"] or 0)
        required["end_km_value"] = float(required["end_km_value"] or 0)
    except (TypeError, ValueError):
        raise ValueError("Trip odometer values must be numeric")

    return required

def build_fuel_upsert_rpc_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Fuel upsert payload must be an object")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    fuel = payload.get("fuel") if isinstance(payload.get("fuel"), dict) else {}

    required = {
        "target_ledger_id": context.get("ledgerId") or payload.get("ledgerId") or fuel.get("ledger_id"),
        "target_open_period_id": context.get("openPeriodId") or payload.get("openPeriodId") or fuel.get("period_id"),
        "legacy_fuel_id": fuel.get("legacy_id") or payload.get("legacyFuelId") or payload.get("legacy_fuel_id"),
        "payer_member_id": fuel.get("payer_member_id") or payload.get("payer_member_id"),
        "payment_date_value": fuel.get("payment_date") or payload.get("payment_date_value"),
        "amount_value": fuel.get("amount", payload.get("amount_value")),
        "currency_value": fuel.get("currency") or payload.get("currency_value") or "DKK",
        "liters_value": fuel.get("liters", payload.get("liters_value")),
        "price_per_liter_value": fuel.get("price_per_liter", payload.get("price_per_liter_value")),
        "odometer_value": fuel.get("odometer", payload.get("odometer_value")),
        "station_name_value": fuel.get("station_name") or payload.get("station_name_value"),
        "station_brand_value": fuel.get("station_brand") or payload.get("station_brand_value"),
        "station_lat_value": fuel.get("station_lat", payload.get("station_lat_value")),
        "station_lng_value": fuel.get("station_lng", payload.get("station_lng_value")),
        "user_lat_value": fuel.get("user_lat", payload.get("user_lat_value")),
        "user_lng_value": fuel.get("user_lng", payload.get("user_lng_value")),
        "full_tank_value": bool(fuel.get("full_tank", payload.get("full_tank_value", False))),
    }

    missing = [name for name in ("target_ledger_id", "target_open_period_id", "legacy_fuel_id", "payer_member_id", "payment_date_value") if not required.get(name)]
    if missing:
        raise ValueError(f"Missing fuel upsert field(s): {', '.join(missing)}")

    numeric_defaults = {
        "amount_value": 0,
        "liters_value": 0,
        "price_per_liter_value": None,
        "odometer_value": None,
        "station_lat_value": None,
        "station_lng_value": None,
        "user_lat_value": None,
        "user_lng_value": None,
    }
    for key, default in numeric_defaults.items():
        value = required.get(key)
        if value is None or value == "":
            required[key] = default
            continue
        try:
            required[key] = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Fuel field {key} must be numeric")

    return required



def build_admin_test_data_rpc_payload(payload, context):
    if not isinstance(payload, dict):
        raise ValueError("Admin test data payload must be an object")
    entry_type = str(payload.get("type") or "").strip().lower()
    entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
    ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or context.get("ledgerId") or "").strip()
    if not ledger_id:
        raise ValueError("Admin test data requires ledgerId")
    if ledger_id != context.get("ledgerId"):
        raise PermissionError("Cannot create generated test data for a different workspace")
    if not context.get("canAdmin"):
        raise PermissionError("Only workspace admins can create generated test data")

    member_ids_by_name = context.get("memberIdsByName") or {}
    if entry_type == "trip":
        driver = str(entry.get("driver") or "").strip()
        driver_member_id = member_ids_by_name.get(driver)
        if not driver_member_id:
            raise ValueError("Generated test trip driver must be an active workspace member")
        participant_names = entry.get("participants") if isinstance(entry.get("participants"), list) else []
        participant_member_ids = [member_ids_by_name.get(str(name or "").strip()) for name in participant_names]
        participant_member_ids = [str(value) for value in participant_member_ids if value]
        if not participant_member_ids:
            participant_member_ids = [str(driver_member_id)]
        return "trip", build_trip_upsert_rpc_payload({
            "context": {"ledgerId": ledger_id, "openPeriodId": context.get("openPeriodId")},
            "participantMemberIds": participant_member_ids,
            "trip": {
                "legacy_id": entry.get("id"),
                "driver_member_id": driver_member_id,
                "trip_date": entry.get("date"),
                "start_km": entry.get("startKm"),
                "end_km": entry.get("endKm"),
                "note": entry.get("note"),
            },
        })

    if entry_type == "fuel":
        payer = str(entry.get("payer") or "").strip()
        payer_member_id = member_ids_by_name.get(payer)
        if not payer_member_id:
            raise ValueError("Generated test fuel payer must be an active workspace member")
        amount = entry.get("amount") or 0
        liters = entry.get("liters") or 0
        price_per_liter = entry.get("pricePerLiter")
        if price_per_liter in (None, ""):
            try:
                price_per_liter = float(amount or 0) / float(liters or 0) if float(liters or 0) else None
            except (TypeError, ValueError, ZeroDivisionError):
                price_per_liter = None
        station_info = entry.get("stationInfo") if isinstance(entry.get("stationInfo"), dict) else {}
        location = entry.get("location") if isinstance(entry.get("location"), dict) else {}
        return "fuel", build_fuel_upsert_rpc_payload({
            "context": {"ledgerId": ledger_id, "openPeriodId": context.get("openPeriodId")},
            "fuel": {
                "legacy_id": entry.get("id"),
                "payer_member_id": payer_member_id,
                "payment_date": entry.get("date"),
                "amount": amount,
                "currency": payload.get("currency") or "DKK",
                "liters": liters,
                "price_per_liter": price_per_liter,
                "odometer": entry.get("odometer"),
                "station_name": entry.get("station") or station_info.get("name"),
                "station_brand": station_info.get("brand"),
                "station_lat": station_info.get("latitude"),
                "station_lng": station_info.get("longitude"),
                "user_lat": location.get("latitude"),
                "user_lng": location.get("longitude"),
                "full_tank": bool(entry.get("fullTank")),
            },
        })

    raise ValueError("Admin test data type must be trip or fuel")

def build_booking_upsert_rpc_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Booking upsert payload must be an object")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    booking = payload.get("booking") if isinstance(payload.get("booking"), dict) else {}

    required = {
        "target_ledger_id": context.get("ledgerId") or payload.get("ledgerId") or booking.get("ledger_id"),
        "legacy_booking_id": booking.get("legacy_id") or payload.get("legacyBookingId") or payload.get("legacy_booking_id"),
        "booking_member_id": booking.get("member_id") or payload.get("booking_member_id"),
        "start_at_value": booking.get("start_at") or payload.get("start_at_value"),
        "end_at_value": booking.get("end_at") or payload.get("end_at_value"),
        "purpose_value": booking.get("purpose", payload.get("purpose_value")),
    }

    missing = [name for name in ("target_ledger_id", "legacy_booking_id", "booking_member_id", "start_at_value", "end_at_value") if not required.get(name)]
    if missing:
        raise ValueError(f"Missing booking upsert field(s): {', '.join(missing)}")

    return required




GENERATED_TEST_PREFIX = "auto-test-"
GENERATED_TEST_MARKER = "[AUTO TEST]"

def is_generated_normalized_trip_row(row):
    return str(row.get("legacy_id") or "").startswith(GENERATED_TEST_PREFIX) or GENERATED_TEST_MARKER in str(row.get("note") or "")

def is_generated_normalized_fuel_row(row):
    return str(row.get("legacy_id") or "").startswith(GENERATED_TEST_PREFIX) or GENERATED_TEST_MARKER in str(row.get("station_name") or "")

def is_generated_normalized_booking_row(row):
    return str(row.get("legacy_id") or "").startswith(GENERATED_TEST_PREFIX) or GENERATED_TEST_MARKER in str(row.get("purpose") or "")

def select_generated_rows_for_cleanup(ledger_id, open_period_id, user_token):
    ledger_q = quote_postgrest_value(ledger_id)
    trips = request_json(
        f"{supabase_url()}/rest/v1/trips?select=id,legacy_id,period_id,note,deleted_at&ledger_id=eq.{ledger_q}&deleted_at=is.null",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []
    fuel = request_json(
        f"{supabase_url()}/rest/v1/fuel_payments?select=id,legacy_id,period_id,station_name,deleted_at&ledger_id=eq.{ledger_q}&deleted_at=is.null",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []
    bookings = request_json(
        f"{supabase_url()}/rest/v1/car_bookings?select=id,legacy_id,purpose,deleted_at&ledger_id=eq.{ledger_q}&deleted_at=is.null",
        token=user_token,
        api_key=supabase_anon_key(),
    ) or []

    def in_open_period(row):
        return (not open_period_id) or (not row.get("period_id")) or str(row.get("period_id")) == str(open_period_id)

    return {
        "trips": [row for row in trips if in_open_period(row) and is_generated_normalized_trip_row(row)],
        "fuel": [row for row in fuel if in_open_period(row) and is_generated_normalized_fuel_row(row)],
        "bookings": [row for row in bookings if is_generated_normalized_booking_row(row)],
    }

def soft_delete_generated_rows_as_user(table, rows, user_token):
    ids = [str(row.get("id") or "").strip() for row in rows if str(row.get("id") or "").strip()]
    if not ids:
        return 0
    id_values = ",".join(quote_postgrest_value(value) for value in ids)
    request_json(
        f"{supabase_url()}/rest/v1/{table}?id=in.({id_values})",
        method="PATCH",
        body={"deleted_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()},
        token=user_token,
        api_key=supabase_anon_key(),
        prefer="return=minimal",
    )
    return len(ids)

def cleanup_generated_test_data_as_user(ledger_id, context, user_token):
    if not context.get("canAdmin"):
        raise PermissionError("Only workspace admins can clean generated test data")
    rows = select_generated_rows_for_cleanup(ledger_id, context.get("openPeriodId"), user_token)
    trip_count = soft_delete_generated_rows_as_user("trips", rows["trips"], user_token)
    fuel_count = soft_delete_generated_rows_as_user("fuel_payments", rows["fuel"], user_token)
    booking_count = soft_delete_generated_rows_as_user("car_bookings", rows["bookings"], user_token)
    return {
        "trips": trip_count,
        "fuel": fuel_count,
        "bookings": booking_count,
        "total": trip_count + fuel_count + booking_count,
    }

def build_booking_delete_rpc_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Booking delete payload must be an object")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    required = {
        "target_ledger_id": context.get("ledgerId") or payload.get("ledgerId"),
        "legacy_booking_id": payload.get("legacyBookingId") or payload.get("legacy_booking_id"),
    }

    missing = [name for name in ("target_ledger_id", "legacy_booking_id") if not required.get(name)]
    if missing:
        raise ValueError(f"Missing booking delete field(s): {', '.join(missing)}")

    return required


def build_payment_status_rpc_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Payment action payload must be an object")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    settlement = payload.get("settlement") if isinstance(payload.get("settlement"), dict) else {}
    audit = payload.get("auditEntry") if isinstance(payload.get("auditEntry"), dict) else {}

    required = {
        "target_ledger_id": context.get("ledgerId") or payload.get("ledgerId"),
        "target_open_period_id": context.get("openPeriodId") or payload.get("openPeriodId"),
        "payer_member_id": settlement.get("from_member_id") or payload.get("from_member_id"),
        "recipient_member_id": settlement.get("to_member_id") or payload.get("to_member_id"),
        "amount_value": settlement.get("amount", payload.get("amount")),
        "currency_value": settlement.get("currency") or payload.get("currency") or "DKK",
        "previous_status": payload.get("previousStatus") or payload.get("previous_status") or "open",
        "next_status": payload.get("nextStatus") or payload.get("next_status") or settlement.get("status"),
        "audit_summary": audit.get("summary") or payload.get("audit_summary") or "",
        "audit_detail": audit.get("detail") or payload.get("audit_detail") or "",
        "audit_metadata": audit.get("metadata") if isinstance(audit.get("metadata"), dict) else (payload.get("audit_metadata") if isinstance(payload.get("audit_metadata"), dict) else {}),
        "current_pair_keys": payload.get("currentPairKeys") if isinstance(payload.get("currentPairKeys"), list) else (payload.get("current_pair_keys") if isinstance(payload.get("current_pair_keys"), list) else []),
    }

    missing = [name for name in ("target_ledger_id", "target_open_period_id", "payer_member_id", "recipient_member_id", "next_status") if not required.get(name)]
    if missing:
        raise ValueError(f"Missing payment action field(s): {', '.join(missing)}")

    try:
        required["amount_value"] = float(required["amount_value"] or 0)
    except (TypeError, ValueError):
        raise ValueError("Payment action amount must be numeric")

    required["current_pair_keys"] = [str(value) for value in required["current_pair_keys"] if str(value or "").strip()]
    return required

def run_scheduled_payment_reminders_from_supabase(dry_run=False):
    state, source = load_supabase_reminder_state()
    result = run_scheduled_payment_reminders(state, dry_run=dry_run)
    result["backendMode"] = "supabase"
    result["dataSource"] = source
    diagnostics = result.setdefault("diagnostics", {})
    diagnostics["backendMode"] = "supabase"
    diagnostics["dataSource"] = source
    if result.get("changed") and not dry_run:
        save_supabase_reminder_state(state)
        result["savedToSupabase"] = True
    elif not dry_run:
        result["savedToSupabase"] = False
    return result


def run_scheduled_payment_reminders_from_local_file(dry_run=False):
    state = read_state()
    result = run_scheduled_payment_reminders(state, dry_run=dry_run)
    result["backendMode"] = "local-json"
    result["dataSource"] = {"file": str(DATA_FILE)}
    diagnostics = result.setdefault("diagnostics", {})
    diagnostics["backendMode"] = "local-json"
    diagnostics["dataSource"] = {"file": str(DATA_FILE)}
    if result.get("changed"):
        write_state(state)
        result["state"] = read_state()
    return result


def run_scheduled_payment_reminders_for_environment(dry_run=False):
    if supabase_reminder_mode_enabled():
        return run_scheduled_payment_reminders_from_supabase(dry_run=dry_run)
    return run_scheduled_payment_reminders_from_local_file(dry_run=dry_run)


def apply_payment_action_to_state(state, payload):
    action = str(payload.get("action") or "").strip()
    scope = str(payload.get("scope") or "current").strip()
    audit_entry = normalize_audit_entry(payload.get("auditEntry"))

    if action == "payment_status" and scope == "current":
        key = str(payload.get("paymentKey") or "").strip()
        next_status = normalize_payment_status(payload.get("nextStatus"))
        if not key or next_status not in PAYMENT_STATUSES:
            raise ValueError("Missing paymentKey or invalid nextStatus")
        statuses = state.setdefault("paymentStatuses", {})
        if not isinstance(statuses, dict):
            statuses = {}
            state["paymentStatuses"] = statuses
        statuses[key] = next_status
        state["auditLog"] = prepend_audit(state.get("auditLog"), audit_entry)
        return state

    if action == "payment_reminder" and scope == "current":
        key = str(payload.get("paymentKey") or "").strip()
        if not key:
            raise ValueError("Missing paymentKey")
        state["auditLog"] = prepend_audit(state.get("auditLog"), audit_entry)
        return state

    if action == "payment_status" and scope == "closed":
        period_id = str(payload.get("periodId") or "").strip()
        index = int(payload.get("settlementIndex"))
        next_status = normalize_payment_status(payload.get("nextStatus"))
        if not period_id or next_status != "paid":
            raise ValueError("Closed-period payment actions currently support mark-paid only")
        for period in state.get("closedPeriods", []) or []:
            if str(period.get("id") or "") != period_id:
                continue
            settlements = period.get("settlements") if isinstance(period.get("settlements"), list) else []
            if index < 0 or index >= len(settlements):
                raise ValueError("Invalid closed settlement index")
            settlements[index]["status"] = next_status
            period["auditLog"] = prepend_audit(period.get("auditLog"), audit_entry)
            return state
        raise ValueError("Closed period not found")

    if action == "payment_reminder" and scope == "closed":
        period_id = str(payload.get("periodId") or "").strip()
        if not period_id:
            raise ValueError("Missing periodId")
        for period in state.get("closedPeriods", []) or []:
            if str(period.get("id") or "") == period_id:
                period["auditLog"] = prepend_audit(period.get("auditLog"), audit_entry)
                return state
        raise ValueError("Closed period not found")

    raise ValueError("Unsupported payment action")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if self.path.endswith("service-worker.js"):
            self.send_header("Service-Worker-Allowed", "/")
        for name, value in security_headers().items():
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Ledger-Api-Secret")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/state":
            if not authorize_ledger_api(self):
                return
            self.send_json(read_state())
            return
        if self.path.startswith("/api/fuel-price"):
            self.send_json(fetch_fuel_price(self.path))
            return
        if self.path == "/api/push-config":
            self.send_json({
                "enabled": bool(env_value("VAPID_PUBLIC_KEY") and env_value("VAPID_PRIVATE_KEY") and webpush),
                "publicKey": env_value("VAPID_PUBLIC_KEY"),
            })
            return
        super().do_GET()

    def do_PUT(self):
        if self.path != "/api/state":
            self.send_error(404)
            return
        if not authorize_ledger_api(self):
            return

        try:
            payload = read_request_body(self)
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return

        if not isinstance(payload, dict):
            self.send_error(400, "State must be an object")
            return

        write_state(payload)
        self.send_json(read_state())

    def do_POST(self):
        if self.path == "/api/payment-action":
            self.apply_payment_action()
            return
        if self.path == "/api/payments/status-action":
            self.apply_payment_status_action_backend()
            return
        if self.path == "/api/context/write":
            self.get_write_context_backend()
            return
        if self.path == "/api/state/load":
            self.load_state_backend()
            return
        if self.path == "/api/settings/save":
            self.save_settings_backend()
            return
        if self.path == "/api/members/manage":
            self.manage_members_backend()
            return
        if self.path == "/api/ledgers/sync":
            self.sync_ledger_directory_backend()
            return
        if self.path == "/api/backups/json-mirror":
            self.save_json_mirror_backup_backend()
            return
        if self.path == "/api/admin/test-data/create":
            self.create_admin_test_data_backend()
            return
        if self.path == "/api/admin/test-data/cleanup":
            self.cleanup_admin_test_data_backend()
            return
        if self.path == "/api/admin/health":
            self.admin_health_backend()
            return
        if self.path == "/api/admin/reports/save":
            self.save_admin_report_backend()
            return
        if self.path == "/api/admin/security-health":
            self.security_health_backend()
            return
        if self.path == "/api/admin/retention/preview":
            self.preview_retention_cleanup_backend()
            return
        if self.path == "/api/admin/retention/cleanup":
            self.run_retention_cleanup_backend()
            return
        if self.path == "/api/trips/upsert":
            self.upsert_trip_backend()
            return
        if self.path == "/api/fuel/upsert":
            self.upsert_fuel_backend()
            return
        if self.path == "/api/bookings/upsert":
            self.upsert_booking_backend()
            return
        if self.path == "/api/bookings/delete":
            self.delete_booking_backend()
            return
        if self.path == "/api/vehicle/lookup":
            self.lookup_vehicle_backend()
            return
        if self.path == "/api/run-reminders":
            self.run_reminders()
            return
        if self.path == "/api/push-subscriptions":
            self.save_push_subscription()
            return
        if self.path == "/api/send-push":
            self.send_push_notifications()
            return
        self.send_error(404)

    def apply_payment_action(self):
        if not authorize_ledger_api(self):
            return
        try:
            payload = read_request_body(self)
            if not isinstance(payload, dict):
                raise ValueError("Payment action payload must be an object")
            state = read_state()
            updated = apply_payment_action_to_state(state, payload)
            write_state(updated)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "state": read_state()})


    def load_state_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before loading state")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_write_context_backend_payload(payload, user)
            if not check_backend_rate_limit(self, "state-load", user=user, ledger_id=ledger_id):
                return
            state_rows = get_normalized_state_rows_as_user(ledger_id, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "stateRows": state_rows, "backend": "render", "userEmail": user.get("email")})



    def save_settings_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_json({"ok": False, "code": "AUTH_REQUIRED", "message": "Sign in before saving settings."}, status=401)
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger, members = build_settings_save_payload(payload, user)
            if not check_backend_rate_limit(self, "settings-save", user=user, ledger_id=ledger["id"]):
                return
            assert_user_can_admin_ledger(ledger["id"], user, token)
            result = upsert_settings_as_service(ledger, members)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"ok": False, "code": "BAD_REQUEST", "message": str(error)}, status=400)
            return
        except SettingsSchemaMissingError as error:
            self.send_json({"ok": False, "code": "SETTINGS_SCHEMA_MISSING", "message": str(error)}, status=409)
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_json({"ok": False, "code": "SUPABASE_ERROR", "message": body}, status=error.code)
            return
        except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
            self.send_json({"ok": False, "code": "SETTINGS_SAVE_TIMEOUT", "message": f"Settings save timed out while talking to Supabase: {error}"}, status=504)
            return
        except PermissionError as error:
            self.send_json({"ok": False, "code": "FORBIDDEN", "message": str(error)}, status=403)
            return
        except Exception as error:
            self.send_json({"ok": False, "code": "SETTINGS_SAVE_ERROR", "message": str(error)}, status=500)
            return

        self.send_json({"ok": True, "result": result, "settings": result.get("settings"), "backend": "render", "userEmail": user.get("email")})


    def manage_members_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_json({"ok": False, "code": "AUTH_REQUIRED", "message": "Sign in before managing members."}, status=401)
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            if not isinstance(payload, dict):
                raise ValueError("Member management payload must be an object")
            ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
            action = str(payload.get("action") or "list").strip().lower()
            if not ledger_id:
                raise ValueError("Missing ledgerId")
            if not check_backend_rate_limit(self, "admin", user=user, ledger_id=ledger_id):
                return
            if action == "list":
                members = list_members_as_user(ledger_id, user, token)
                self.send_json({"ok": True, "code": "MEMBERS_LOADED", "ledgerId": ledger_id, "members": members, "backend": "render", "userEmail": user.get("email")})
                return
            if action == "upsert":
                member = normalize_backend_member_payload(payload.get("member"))
                result = upsert_member_as_user(ledger_id, member, user, token)
                members = list_members_as_user(ledger_id, user, token)
                self.send_json({"ok": True, "code": "MEMBER_SAVED", "ledgerId": ledger_id, "member": result, "members": members, "backend": "render", "userEmail": user.get("email")})
                return
            if action == "set-active":
                member_id = str(payload.get("memberId") or payload.get("member_id") or "").strip()
                result = set_member_active_as_user(ledger_id, member_id, payload.get("isActive", payload.get("is_active", False)), user, token)
                members = list_members_as_user(ledger_id, user, token)
                self.send_json({"ok": True, "code": "MEMBER_ACCESS_UPDATED", "ledgerId": ledger_id, "member": result, "members": members, "backend": "render", "userEmail": user.get("email")})
                return
            raise ValueError("Unsupported member management action")
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"ok": False, "code": "BAD_REQUEST", "message": str(error)}, status=400)
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_json({"ok": False, "code": "SUPABASE_ERROR", "message": body}, status=error.code)
            return
        except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
            self.send_json({"ok": False, "code": "MEMBER_MANAGEMENT_TIMEOUT", "message": f"Member management timed out while talking to Supabase: {error}"}, status=504)
            return
        except PermissionError as error:
            self.send_json({"ok": False, "code": "FORBIDDEN", "message": str(error)}, status=403)
            return
        except Exception as error:
            self.send_json({"ok": False, "code": "MEMBER_MANAGEMENT_ERROR", "message": str(error)}, status=500)
            return


    def sync_ledger_directory_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before syncing the ledger directory")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger, members = build_ledger_directory_sync_payload(payload, user)
            if not check_backend_rate_limit(self, "admin", user=user, ledger_id=ledger["id"]):
                return
            assert_user_can_admin_ledger(ledger["id"], user, token)
            result = upsert_ledger_directory_as_user(ledger, members, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})



    def save_json_mirror_backup_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before saving a JSON mirror backup")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id, state, updated_at, reason = build_json_mirror_backup_payload(payload, user)
            if not check_backend_rate_limit(self, "json-backup", user=user, ledger_id=ledger_id):
                return
            assert_user_can_admin_ledger(ledger_id, user, token)
            result = upsert_json_mirror_as_user(ledger_id, state, updated_at, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "reason": reason, "userEmail": user.get("email")})


    def create_admin_test_data_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before creating generated test data")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_write_context_backend_payload(payload, user)
            if not check_backend_rate_limit(self, "admin-heavy", user=user, ledger_id=ledger_id):
                return
            context = get_write_context_as_user(ledger_id, user, token)
            entry_type, rpc_payload = build_admin_test_data_rpc_payload(payload, context)
            rpc_name = "upsert_trip_with_participants" if entry_type == "trip" else "upsert_fuel_payment"
            result = call_supabase_rpc_as_user(rpc_name, rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "type": entry_type, "result": result, "backend": "render", "userEmail": user.get("email")})

    def cleanup_admin_test_data_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before cleaning generated test data")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_write_context_backend_payload(payload, user)
            if not check_backend_rate_limit(self, "admin-heavy", user=user, ledger_id=ledger_id):
                return
            context = get_write_context_as_user(ledger_id, user, token)
            counts = cleanup_generated_test_data_as_user(ledger_id, context, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "counts": counts, "backend": "render", "userEmail": user.get("email")})

    def admin_health_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before checking Render admin health")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_admin_health_payload(payload)
            if not check_backend_rate_limit(self, "admin-health", user=user, ledger_id=ledger_id):
                return
            health = build_render_admin_health(ledger_id, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json(health)

    def security_health_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before checking Security Health")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_admin_health_payload(payload)
            if not check_backend_rate_limit(self, "admin-health", user=user, ledger_id=ledger_id):
                return
            health = build_render_security_health(ledger_id, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json(health)

    def save_admin_report_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before saving admin reports")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id, _ = build_admin_report_save_payload(payload)
            if not check_backend_rate_limit(self, "admin", user=user, ledger_id=ledger_id):
                return
            ledger_id, stored_report, result = save_admin_report_as_user(payload, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "ledgerId": ledger_id, "storedReport": stored_report, "result": result, "backend": "render", "userEmail": user.get("email")})

    def preview_retention_cleanup_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before previewing retention cleanup")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_retention_admin_payload(payload)[0]
            if not check_backend_rate_limit(self, "admin", user=user, ledger_id=ledger_id):
                return
            ledger_id, preview = run_retention_admin_rpc_as_user("preview", payload, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "preview": preview, "backend": "render", "ledgerId": ledger_id, "userEmail": user.get("email")})

    def run_retention_cleanup_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before running retention cleanup")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_retention_admin_payload(payload)[0]
            if not check_backend_rate_limit(self, "admin-heavy", user=user, ledger_id=ledger_id):
                return
            ledger_id, cleanup = run_retention_admin_rpc_as_user("cleanup", payload, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8") if hasattr(error, "read") else str(error)
            self.send_error(error.code, body)
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "cleanup": cleanup, "backend": "render", "ledgerId": ledger_id, "userEmail": user.get("email")})

    def get_write_context_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before preparing write context")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            ledger_id = build_write_context_backend_payload(payload, user)
            if not check_backend_rate_limit(self, "write-context", user=user, ledger_id=ledger_id):
                return
            context = get_write_context_as_user(ledger_id, user, token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "context": context, "backend": "render", "userEmail": user.get("email")})

    def apply_payment_status_action_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before updating payment status")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            rpc_payload = build_payment_status_rpc_payload(payload)
            if not check_backend_rate_limit(self, "write", user=user, ledger_id=rpc_payload.get("target_ledger_id")):
                return
            context = get_write_context_as_user(rpc_payload.get("target_ledger_id"), user, token)
            assert_payment_status_action_allowed(context, rpc_payload)
            result = call_supabase_rpc_as_user("apply_payment_status_action", rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})

    def upsert_trip_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before saving a trip")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            rpc_payload = build_trip_upsert_rpc_payload(payload)
            if not check_backend_rate_limit(self, "write", user=user, ledger_id=rpc_payload.get("target_ledger_id")):
                return
            context = get_write_context_as_user(rpc_payload.get("target_ledger_id"), user, token)
            assert_trip_write_allowed(context, rpc_payload)
            result = call_supabase_rpc_as_user("upsert_trip_with_participants", rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})

    def upsert_fuel_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before saving fuel")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            rpc_payload = build_fuel_upsert_rpc_payload(payload)
            if not check_backend_rate_limit(self, "write", user=user, ledger_id=rpc_payload.get("target_ledger_id")):
                return
            context = get_write_context_as_user(rpc_payload.get("target_ledger_id"), user, token)
            assert_member_scoped_write_allowed(context, rpc_payload.get("payer_member_id"), "fuel payer")
            result = call_supabase_rpc_as_user("upsert_fuel_payment", rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})

    def upsert_booking_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before saving a booking")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            rpc_payload = build_booking_upsert_rpc_payload(payload)
            if not check_backend_rate_limit(self, "write", user=user, ledger_id=rpc_payload.get("target_ledger_id")):
                return
            context = get_write_context_as_user(rpc_payload.get("target_ledger_id"), user, token)
            assert_member_scoped_write_allowed(context, rpc_payload.get("booking_member_id"), "booking member")
            result = call_supabase_rpc_as_user("upsert_car_booking", rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})

    def delete_booking_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before deleting a booking")
            return
        token = get_bearer_token(self)
        try:
            payload = read_request_body(self)
            rpc_payload = build_booking_delete_rpc_payload(payload)
            if not check_backend_rate_limit(self, "write", user=user, ledger_id=rpc_payload.get("target_ledger_id")):
                return
            context = get_write_context_as_user(rpc_payload.get("target_ledger_id"), user, token)
            owner_member_id = select_booking_owner_as_user(rpc_payload.get("target_ledger_id"), rpc_payload.get("legacy_booking_id"), token)
            assert_member_scoped_write_allowed(context, owner_member_id, "booking delete")
            result = call_supabase_rpc_as_user("soft_delete_car_booking", rpc_payload, user_token=token)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
            return
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except PermissionError as error:
            self.send_error(403, str(error))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True, "result": result, "backend": "render", "userEmail": user.get("email")})

    def save_push_subscription(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before enabling notifications")
            return
        if not supabase_url() or not supabase_key():
            self.send_error(503, "Supabase server environment variables are missing")
            return

        try:
            payload = read_request_body(self)
            subscription = payload.get("subscription")
        except (ValueError, json.JSONDecodeError, AttributeError):
            self.send_error(400, "Invalid subscription payload")
            return

        endpoint = subscription.get("endpoint") if isinstance(subscription, dict) else ""
        if not endpoint:
            self.send_error(400, "Missing push endpoint")
            return

        body = {
            "user_email": user["email"].lower(),
            "subscription": subscription,
            "updated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        }
        try:
            request_json(
                f"{supabase_url()}/rest/v1/push_subscriptions?on_conflict=user_email",
                method="POST",
                body=body,
                prefer="resolution=merge-duplicates,return=minimal",
            )
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return

        self.send_json({"ok": True})

    def send_push_notifications(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before sending notifications")
            return
        if not webpush:
            self.send_error(503, "pywebpush is not installed")
            return
        if not env_value("VAPID_PUBLIC_KEY") or not env_value("VAPID_PRIVATE_KEY"):
            self.send_error(503, "VAPID keys are missing")
            return
        if not supabase_url() or not supabase_key():
            self.send_error(503, "Supabase server environment variables are missing")
            return

        try:
            payload = read_request_body(self)
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return

        target_email = str(payload.get("targetEmail", "")).strip().lower()
        title = str(payload.get("title", "Fuel Ledger"))[:100]
        body = str(payload.get("body", "You have a new payment request."))[:240]
        url = str(payload.get("url", "/"))[:500]
        tag = str(payload.get("tag", "fuel-ledger"))[:100]

        if not target_email:
            self.send_error(400, "Missing targetEmail")
            return

        if not can_send_push_to(user.get("email"), target_email):
            self.send_error(403, "Push target must be an active member of your ledger")
            return

        encoded_email = urllib.parse.quote(target_email, safe="")
        try:
            subscriptions = request_json(
                f"{supabase_url()}/rest/v1/push_subscriptions?user_email=eq.{encoded_email}&select=id,user_email,subscription"
            ) or []
        except Exception as error:
            self.send_error(500, str(error))
            return

        sent = 0
        failed = 0
        for row in subscriptions:
            subscription = row.get("subscription")
            if not subscription:
                continue
            try:
                webpush(
                    subscription_info=subscription,
                    data=json.dumps({"title": title, "body": body, "url": url, "tag": tag}),
                    vapid_private_key=env_value("VAPID_PRIVATE_KEY"),
                    vapid_claims={"sub": env_value("VAPID_SUBJECT", f"mailto:{user['email']}")},
                )
                sent += 1
            except WebPushException as error:
                failed += 1
                status = getattr(getattr(error, "response", None), "status_code", None)
                if status in (404, 410):
                    row_id = urllib.parse.quote(str(row.get("id", "")), safe="")
                    if row_id:
                        try:
                            request_json(f"{supabase_url()}/rest/v1/push_subscriptions?id=eq.{row_id}", method="DELETE")
                        except Exception:
                            pass
            except Exception:
                failed += 1

        self.send_json({"ok": True, "sent": sent, "failed": failed})


    def lookup_vehicle_backend(self):
        user = current_supabase_user(self)
        if not user or not user.get("email"):
            self.send_error(401, "Sign in before looking up a vehicle")
            return
        try:
            payload = read_request_body(self)
            ledger_id = str(payload.get("ledgerId") or payload.get("ledger_id") or "").strip()
            plate = normalize_vehicle_plate(payload.get("plate") or payload.get("numberPlate") or payload.get("licensePlate") or "")
            if not ledger_id:
                self.send_error(400, "Missing ledgerId")
                return
            if not plate:
                self.send_error(400, "Missing plate")
                return
            if not check_backend_rate_limit(self, "vehicle-lookup", user=user, ledger_id=ledger_id):
                return
            # Any active workspace member may ask Render to lookup the configured
            # vehicle data, but the app UI only applies it to settings for admins.
            get_state_load_context_as_service(ledger_id, user)
            result, status = fetch_vehicle_lookup(plate)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            # Provider problems are expected lookup outcomes, not app-backend
            # failures. Return HTTP 200 with a stable result code so browsers do
            # not show scary 503 console errors and the app can keep manual
            # settings as the safe fallback. Auth/permission failures above still
            # use real HTTP error statuses.
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "code": "VEHICLE_LOOKUP_PROVIDER_ERROR", "message": detail or str(error)}).encode("utf-8"))
        except urllib.error.URLError as error:
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "code": "VEHICLE_LOOKUP_PROVIDER_UNAVAILABLE", "message": str(error)}).encode("utf-8"))
        except PermissionError as error:
            self.send_error(403, str(error))
        except Exception as error:
            self.send_error(500, str(error))

    def run_reminders(self):
        auth_error = reminder_job_auth_error(self)
        if auth_error:
            status, message = auth_error
            self.send_error(status, message)
            return
        try:
            payload = read_request_body(self)
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return
        dry_run = bool(payload.get("dryRun")) if isinstance(payload, dict) else False
        try:
            result = run_scheduled_payment_reminders_for_environment(dry_run=dry_run)
        except urllib.error.HTTPError as error:
            self.send_error(error.code, error.read().decode("utf-8"))
            return
        except Exception as error:
            self.send_error(500, str(error))
            return
        self.send_json(result)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fuel Ledger local server and scheduled reminder runner")
    parser.add_argument("--run-reminders", action="store_true", help="Run the scheduled backend payment reminder scan once and exit")
    parser.add_argument("--dry-run-reminders", action="store_true", help="Show due reminders without writing audit entries")
    args = parser.parse_args(argv)

    if args.run_reminders or args.dry_run_reminders:
        result = run_scheduled_payment_reminders_for_environment(dry_run=args.dry_run_reminders)
        print(json.dumps({key: value for key, value in result.items() if key not in ("due", "state")}, ensure_ascii=False, indent=2))
        if result.get("due"):
            print(json.dumps(result["due"], ensure_ascii=False, indent=2))
        return 0

    port_value = os.environ.get("PORT", "4175")
    try:
        port = int(port_value)
    except (TypeError, ValueError):
        raise SystemExit(f"Invalid PORT value: {port_value!r}")

    host = "0.0.0.0"
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f"Car Share Ledger running at http://{host}:{port}/", flush=True)
    print("Shared data file:", DATA_FILE, flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
