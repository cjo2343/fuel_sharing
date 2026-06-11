#!/usr/bin/env python3
import base64
import json
import gzip
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
    "fuel": [],
    "paymentStatuses": {},
    "closedPeriods": [],
    "lastOdometer": "",
    "fuelType": "diesel",
    "fuelConsumption": 5.3,
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
    for key in ("trips", "fuel", "closedPeriods"):
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


def supabase_url():
    return env_value("SUPABASE_URL")


def supabase_key():
    return env_value("SUPABASE_SERVICE_ROLE_KEY") or env_value("SUPABASE_ANON_KEY")


def supabase_anon_key():
    return env_value("SUPABASE_ANON_KEY") or env_value("SUPABASE_SERVICE_ROLE_KEY")


def request_json(url, method="GET", body=None, token=None, prefer=None, api_key=None):
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
    with urllib.request.urlopen(request, timeout=20) as response:
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


def current_supabase_user(handler):
    url = supabase_url()
    token = get_bearer_token(handler)
    if not url or not token:
        return None

    # Prefer Supabase's own auth check. Use the anon key for this when available;
    # the service role key is still used for server-side database writes.
    try:
        user = request_json(f"{url}/auth/v1/user", token=token, api_key=supabase_anon_key())
        if user and user.get("email"):
            return user
    except Exception:
        pass

    # Do not decode JWT payloads locally here. The server must only trust tokens
    # verified by Supabase Auth; otherwise a forged token could reach push endpoints
    # during an auth outage or misconfiguration.
    return None



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
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/state":
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
        if self.path == "/api/push-subscriptions":
            self.save_push_subscription()
            return
        if self.path == "/api/send-push":
            self.send_push_notifications()
            return
        self.send_error(404)

    def apply_payment_action(self):
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

    def send_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4175"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Car Share Ledger running at http://localhost:{port}/")
    print("Shared data file:", DATA_FILE)
    server.serve_forever()
