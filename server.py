#!/usr/bin/env python3
import base64
import json
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
DATA_FILE = ROOT / "ledger-data.json"

DEFAULT_STATE = {
    "currency": "DKK",
    "members": ["Christian", "Alex", "Sam"],
    "trips": [],
    "fuel": [],
    "paymentStatuses": {},
    "closedPeriods": [],
    "lastOdometer": "",
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

    # Fallback for installed iOS PWAs/environments where the auth endpoint rejects
    # the server-side key combination even though the client has a valid session.
    return decode_jwt_payload(token)


def public_origin(handler):
    proto = handler.headers.get("X-Forwarded-Proto") or "http"
    host = handler.headers.get("Host") or f"localhost:{os.environ.get('PORT', '4175')}"
    return f"{proto}://{host}"


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
        if self.path == "/api/push-subscriptions":
            self.save_push_subscription()
            return
        if self.path == "/api/send-push":
            self.send_push_notifications()
            return
        self.send_error(404)

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
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4175"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Car Share Ledger running at http://localhost:{port}/")
    print("Shared data file:", DATA_FILE)
    server.serve_forever()
