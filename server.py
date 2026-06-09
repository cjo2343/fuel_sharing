#!/usr/bin/env python3
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/state":
            self.send_json(read_state())
            return
        super().do_GET()

    def do_PUT(self):
        if self.path != "/api/state":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return

        if not isinstance(payload, dict):
            self.send_error(400, "State must be an object")
            return

        write_state(payload)
        self.send_json(read_state())

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
