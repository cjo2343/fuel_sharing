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
    def test_json_api_requires_auth_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            handler = FakeHandler()
            self.assertFalse(server.authorize_ledger_api(handler))
            self.assertEqual(handler.error[0], 503)

    def test_local_json_api_can_explicitly_opt_out(self):
        with patch.dict(os.environ, {"FUEL_LEDGER_ALLOW_UNAUTHENTICATED_LOCAL_API": "1"}, clear=True):
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

class RenderPaymentActionPayloadTests(unittest.TestCase):
    def test_build_payment_status_rpc_payload_from_frontend_contract(self):
        payload = server.build_payment_status_rpc_payload({
            "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
            "settlement": {
                "from_member_id": "22222222-2222-2222-2222-222222222222",
                "to_member_id": "33333333-3333-3333-3333-333333333333",
                "amount": "123.45",
                "currency": "DKK",
                "status": "requested",
            },
            "previousStatus": "open",
            "auditEntry": {"summary": "Payment requested", "detail": "Payment requested detail", "metadata": {"paymentRef": "pay-1"}},
            "currentPairKeys": ["22222222-2222-2222-2222-222222222222->33333333-3333-3333-3333-333333333333", ""],
        })

        self.assertEqual(payload["target_ledger_id"], "main-car")
        self.assertEqual(payload["next_status"], "requested")
        self.assertEqual(payload["previous_status"], "open")
        self.assertEqual(payload["amount_value"], 123.45)
        self.assertEqual(payload["audit_summary"], "Payment requested")
        self.assertEqual(payload["audit_metadata"], {"paymentRef": "pay-1"})
        self.assertEqual(payload["current_pair_keys"], ["22222222-2222-2222-2222-222222222222->33333333-3333-3333-3333-333333333333"])

    def test_build_payment_status_rpc_payload_rejects_missing_member(self):
        with self.assertRaises(ValueError):
            server.build_payment_status_rpc_payload({
                "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
                "settlement": {"to_member_id": "33333333-3333-3333-3333-333333333333", "status": "requested"},
            })


class RenderTripUpsertPayloadTests(unittest.TestCase):
    def test_build_trip_upsert_rpc_payload_from_frontend_contract(self):
        payload = server.build_trip_upsert_rpc_payload({
            "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
            "trip": {
                "legacy_id": "trip-1",
                "driver_member_id": "22222222-2222-2222-2222-222222222222",
                "trip_date": "2026-06-17",
                "start_km": "100",
                "end_km": "150",
                "note": "Test trip",
            },
            "participantMemberIds": ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", ""],
        })

        self.assertEqual(payload["target_ledger_id"], "main-car")
        self.assertEqual(payload["legacy_trip_id"], "trip-1")
        self.assertEqual(payload["start_km_value"], 100.0)
        self.assertEqual(payload["end_km_value"], 150.0)
        self.assertEqual(payload["participant_member_ids"], ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"])

    def test_build_trip_upsert_rpc_payload_rejects_missing_participants(self):
        with self.assertRaises(ValueError):
            server.build_trip_upsert_rpc_payload({
                "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
                "trip": {"legacy_id": "trip-1", "driver_member_id": "22222222-2222-2222-2222-222222222222", "trip_date": "2026-06-17"},
                "participantMemberIds": [],
            })


class RenderFuelUpsertPayloadTests(unittest.TestCase):
    def test_build_fuel_upsert_rpc_payload_from_frontend_contract(self):
        payload = server.build_fuel_upsert_rpc_payload({
            "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
            "fuel": {
                "legacy_id": "fuel-1",
                "payer_member_id": "22222222-2222-2222-2222-222222222222",
                "payment_date": "2026-06-17",
                "amount": "700.50",
                "currency": "DKK",
                "liters": "50",
                "price_per_liter": "14.01",
                "odometer": "12345",
                "station_name": "Test Station",
                "station_brand": "Test Brand",
                "station_lat": "55.1",
                "station_lng": "12.2",
                "user_lat": "55.3",
                "user_lng": "12.4",
                "full_tank": True,
            },
        })

        self.assertEqual(payload["target_ledger_id"], "main-car")
        self.assertEqual(payload["legacy_fuel_id"], "fuel-1")
        self.assertEqual(payload["payer_member_id"], "22222222-2222-2222-2222-222222222222")
        self.assertEqual(payload["amount_value"], 700.5)
        self.assertEqual(payload["liters_value"], 50.0)
        self.assertEqual(payload["price_per_liter_value"], 14.01)
        self.assertTrue(payload["full_tank_value"])

    def test_build_fuel_upsert_rpc_payload_rejects_missing_payer(self):
        with self.assertRaises(ValueError):
            server.build_fuel_upsert_rpc_payload({
                "context": {"ledgerId": "main-car", "openPeriodId": "11111111-1111-1111-1111-111111111111"},
                "fuel": {"legacy_id": "fuel-1", "payment_date": "2026-06-17", "amount": 100},
            })

class RenderMemberWriteScopeTests(unittest.TestCase):
    def context(self, role="member"):
        return {
            "ledgerId": "main-car",
            "openPeriodId": "period-1",
            "currentMemberId": "member-a",
            "activeMemberIds": ["member-a", "member-b"],
            "canAdmin": role == "admin",
        }

    def test_member_can_write_own_trip_with_workspace_participants(self):
        server.assert_trip_write_allowed(self.context(), {
            "driver_member_id": "member-a",
            "participant_member_ids": ["member-a", "member-b"],
        })

    def test_member_cannot_write_trip_for_another_driver(self):
        with self.assertRaises(PermissionError):
            server.assert_trip_write_allowed(self.context(), {
                "driver_member_id": "member-b",
                "participant_member_ids": ["member-a", "member-b"],
            })

    def test_member_cannot_attach_participant_from_another_workspace(self):
        with self.assertRaises(PermissionError):
            server.assert_trip_write_allowed(self.context(), {
                "driver_member_id": "member-a",
                "participant_member_ids": ["member-a", "outside-member"],
            })

    def test_admin_can_write_for_another_active_workspace_member(self):
        server.assert_trip_write_allowed(self.context(role="admin"), {
            "driver_member_id": "member-b",
            "participant_member_ids": ["member-a", "member-b"],
        })

    def test_member_can_write_own_fuel_and_booking_only(self):
        server.assert_member_scoped_write_allowed(self.context(), "member-a", "fuel payer")
        server.assert_member_scoped_write_allowed(self.context(), "member-a", "booking member")
        with self.assertRaises(PermissionError):
            server.assert_member_scoped_write_allowed(self.context(), "member-b", "fuel payer")
        with self.assertRaises(PermissionError):
            server.assert_member_scoped_write_allowed(self.context(), "outside-member", "booking member")

    def test_payment_status_member_permissions_match_frontend_model(self):
        base = {
            "payer_member_id": "member-a",
            "recipient_member_id": "member-b",
        }
        server.assert_payment_status_action_allowed(self.context(), {**base, "next_status": "paid"})
        with self.assertRaises(PermissionError):
            server.assert_payment_status_action_allowed(self.context(), {**base, "next_status": "requested"})

        recipient_context = {
            **self.context(),
            "currentMemberId": "member-b",
        }
        server.assert_payment_status_action_allowed(recipient_context, {**base, "next_status": "requested"})
        server.assert_payment_status_action_allowed(recipient_context, {**base, "next_status": "open"})
        with self.assertRaises(PermissionError):
            server.assert_payment_status_action_allowed(recipient_context, {**base, "next_status": "paid"})

    def test_payment_status_rejects_members_from_other_workspace(self):
        with self.assertRaises(PermissionError):
            server.assert_payment_status_action_allowed(self.context(role="admin"), {
                "payer_member_id": "member-a",
                "recipient_member_id": "outside-member",
                "next_status": "requested",
            })


if __name__ == "__main__":
    unittest.main()
