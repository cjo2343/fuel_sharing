import os
import unittest
from unittest.mock import patch

import server


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class FakeHandler:
    def __init__(self, headers=None):
        self.headers = FakeHeaders(headers or {})
        self.error = None

    def send_error(self, status, message=None):
        self.error = (status, message)


class LedgerApiAuthTests(unittest.TestCase):
    def test_local_json_api_is_open_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            handler = FakeHandler()
            self.assertTrue(server.authorize_ledger_api(handler))
            self.assertIsNone(handler.error)

    def test_required_auth_without_secret_fails_closed(self):
        with patch.dict(os.environ, {"FUEL_LEDGER_REQUIRE_API_AUTH": "1"}, clear=True):
            handler = FakeHandler()
            self.assertFalse(server.authorize_ledger_api(handler))
            self.assertEqual(handler.error[0], 503)

    def test_required_auth_rejects_missing_secret_header(self):
        with patch.dict(os.environ, {"FUEL_LEDGER_REQUIRE_API_AUTH": "1", "FUEL_LEDGER_API_SECRET": "test-secret"}, clear=True):
            handler = FakeHandler()
            self.assertFalse(server.authorize_ledger_api(handler))
            self.assertEqual(handler.error[0], 401)

    def test_required_auth_accepts_header_secret(self):
        with patch.dict(os.environ, {"FUEL_LEDGER_REQUIRE_API_AUTH": "1", "FUEL_LEDGER_API_SECRET": "test-secret"}, clear=True):
            handler = FakeHandler({"X-Ledger-Api-Secret": "test-secret"})
            self.assertTrue(server.authorize_ledger_api(handler))
            self.assertIsNone(handler.error)

    def test_required_auth_accepts_bearer_secret(self):
        with patch.dict(os.environ, {"FUEL_LEDGER_REQUIRE_API_AUTH": "1", "FUEL_LEDGER_API_SECRET": "test-secret"}, clear=True):
            handler = FakeHandler({"Authorization": "Bearer test-secret"})
            self.assertTrue(server.authorize_ledger_api(handler))
            self.assertIsNone(handler.error)


if __name__ == "__main__":
    unittest.main()
