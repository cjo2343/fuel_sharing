#!/usr/bin/env python3
import base64
import json
import argparse
import gzip
import hmac
import os
import sys
import time
from datetime import datetime, timezone
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


def member_email(state, member_name):
    profiles = state.get("memberProfiles") if isinstance(state.get("memberProfiles"), dict) else {}
    profile = profiles.get(str(member_name or ""), {})
    return str(profile.get("email") or "").strip().lower() if isinstance(profile, dict) else ""


def push_unavailable(reason):
    return {"attempted": False, "sent": 0, "failed": 0, "reason": reason}


def send_backend_payment_reminder_push(state, settlement):
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
    title = "Fuel Ledger payment reminder"
    body = f"{settlement.get('to', 'Someone')} reminded you to pay {amount_text} for shared car fuel."
    sent = 0
    failed = 0
    for row in subscriptions:
        subscription = row.get("subscription")
        if not subscription:
            continue
        try:
            webpush(
                subscription_info=subscription,
                data=json.dumps({"title": title, "body": body, "url": "/#payments", "tag": f"fuel-ledger:payment:{settlement.get('from')}:{settlement.get('to')}:reminder"}),
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
    push_result = send_backend_payment_reminder_push(state, settlement)
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
    }
    if period_id:
        metadata["periodId"] = period_id
    return normalize_audit_entry({
        "actor": "Scheduled reminder job",
        "type": "payment_reminder_sent",
        "entityType": "payment",
        "entityId": payment_key,
        "summary": f"{settlement.get('to') or 'Someone'} reminded {settlement.get('from') or 'someone'} · {amount_text}",
        "detail": f"{settlement.get('from') or 'Someone'} pays {settlement.get('to') or 'someone'} · {amount_text} · {delivery_text} · {detail_suffix}",
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
                payment_key = f"{period_id}:{settlement.get('from')}->{settlement.get('to')}:{settlement.get('currency') or state.get('currency') or 'DKK'}"
                fallback_requested_at = closed_payment_fallback_requested_at(period, settlement)
                due = payment_reminder_due_info(period.get("auditLog"), payment_key, settings, now_ts, fallback_requested_at=fallback_requested_at)
                add_reminder_sample(diagnostics, {
                    "scope": "closed",
                    "periodId": period_id,
                    "settlementIndex": index,
                    "paymentKey": payment_key,
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

    port = int(os.environ.get("PORT", "4175"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Car Share Ledger running at http://localhost:{port}/")
    print("Shared data file:", DATA_FILE)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
