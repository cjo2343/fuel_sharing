// GENERATED FILE — DO NOT EDIT BY HAND.
// Canonical shared DB/RPC payload types for the GoVehlo Supabase schema (GV-223).
// Regenerate with: npm run gen:db-types   (drift guard: npm run check:db-types)
// Source: supabase-schema.sql @ migration 116 · supabase CLI v2.109.1 (exact-pinned)
// Vendored byte-identically by govehlo-mobile (src/types/database.ts) and
// govehlo-web (types/database.ts); the umbrella workflow compares the copies.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      app_announcements: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          starts_at: string | null
          text: string
          url: string | null
          variant: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          starts_at?: string | null
          text: string
          url?: string | null
          variant?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          starts_at?: string | null
          text?: string
          url?: string | null
          variant?: string
        }
        Relationships: []
      }
      car_bookings: {
        Row: {
          created_at: string
          created_by_member_id: string | null
          deleted_at: string | null
          end_at: string
          fuel_stop: Json | null
          id: string
          ledger_id: string
          legacy_id: string | null
          member_id: string | null
          purpose: string | null
          start_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          end_at: string
          fuel_stop?: Json | null
          id?: string
          ledger_id: string
          legacy_id?: string | null
          member_id?: string | null
          purpose?: string | null
          start_at: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          end_at?: string
          fuel_stop?: Json | null
          id?: string
          ledger_id?: string
          legacy_id?: string | null
          member_id?: string | null
          purpose?: string | null
          start_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "car_bookings_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_bookings_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_bookings_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      car_share_ledgers: {
        Row: {
          id: string
          state: Json
          updated_at: string
        }
        Insert: {
          id: string
          state: Json
          updated_at?: string
        }
        Update: {
          id?: string
          state?: Json
          updated_at?: string
        }
        Relationships: []
      }
      expo_push_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          platform?: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fuel_ledger_schema_migrations: {
        Row: {
          applied_at: string
          description: string
          migration_id: string
        }
        Insert: {
          applied_at?: string
          description?: string
          migration_id: string
        }
        Update: {
          applied_at?: string
          description?: string
          migration_id?: string
        }
        Relationships: []
      }
      fuel_payments: {
        Row: {
          amount: number
          created_at: string
          created_by_member_id: string | null
          currency: string
          deleted_at: string | null
          full_tank: boolean
          id: string
          ledger_id: string
          legacy_id: string | null
          liters: number | null
          odometer: number | null
          payer_member_id: string | null
          payment_date: string
          period_id: string | null
          price_per_liter: number | null
          station_brand: string | null
          station_lat: number | null
          station_lng: number | null
          station_name: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by_member_id?: string | null
          currency?: string
          deleted_at?: string | null
          full_tank?: boolean
          id?: string
          ledger_id: string
          legacy_id?: string | null
          liters?: number | null
          odometer?: number | null
          payer_member_id?: string | null
          payment_date: string
          period_id?: string | null
          price_per_liter?: number | null
          station_brand?: string | null
          station_lat?: number | null
          station_lng?: number | null
          station_name?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by_member_id?: string | null
          currency?: string
          deleted_at?: string | null
          full_tank?: boolean
          id?: string
          ledger_id?: string
          legacy_id?: string | null
          liters?: number | null
          odometer?: number | null
          payer_member_id?: string | null
          payment_date?: string
          period_id?: string | null
          price_per_liter?: number | null
          station_brand?: string | null
          station_lat?: number | null
          station_lng?: number | null
          station_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fuel_payments_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_payments_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_payments_payer_member_id_fkey"
            columns: ["payer_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_payments_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "settlement_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_events: {
        Row: {
          actor_email: string | null
          actor_member_id: string | null
          body: string
          created_at: string
          event_type: string
          expires_at: string
          id: string
          ledger_id: string
          metadata: Json
          push_sent_at: string | null
          target_email: string | null
          target_member_id: string | null
          title: string
        }
        Insert: {
          actor_email?: string | null
          actor_member_id?: string | null
          body: string
          created_at?: string
          event_type?: string
          expires_at?: string
          id?: string
          ledger_id: string
          metadata?: Json
          push_sent_at?: string | null
          target_email?: string | null
          target_member_id?: string | null
          title: string
        }
        Update: {
          actor_email?: string | null
          actor_member_id?: string | null
          body?: string
          created_at?: string
          event_type?: string
          expires_at?: string
          id?: string
          ledger_id?: string
          metadata?: Json
          push_sent_at?: string | null
          target_email?: string | null
          target_member_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_events_actor_member_id_fkey"
            columns: ["actor_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_target_member_id_fkey"
            columns: ["target_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_invites: {
        Row: {
          created_at: string
          created_by_member_id: string | null
          expires_at: string | null
          id: string
          invite_code_hash: string
          invited_email: string | null
          ledger_id: string
          max_uses: number
          revoked_at: string | null
          role: string
          updated_at: string
          uses_count: number
        }
        Insert: {
          created_at?: string
          created_by_member_id?: string | null
          expires_at?: string | null
          id?: string
          invite_code_hash: string
          invited_email?: string | null
          ledger_id: string
          max_uses?: number
          revoked_at?: string | null
          role?: string
          updated_at?: string
          uses_count?: number
        }
        Update: {
          created_at?: string
          created_by_member_id?: string | null
          expires_at?: string | null
          id?: string
          invite_code_hash?: string
          invited_email?: string | null
          ledger_id?: string
          max_uses?: number
          revoked_at?: string | null
          role?: string
          updated_at?: string
          uses_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "ledger_invites_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_invites_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_members: {
        Row: {
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          last_seen_at: string | null
          ledger_id: string
          mobilepay_phone: string | null
          name: string
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          last_seen_at?: string | null
          ledger_id: string
          mobilepay_phone?: string | null
          name: string
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          last_seen_at?: string | null
          ledger_id?: string
          mobilepay_phone?: string | null
          name?: string
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_members_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_onboarding_rate_limits: {
        Row: {
          action: string
          actor_email: string
          attempts: number
          id: string
          last_attempt_at: string
          ledger_id: string | null
          scope_key: string
          window_started_at: string
        }
        Insert: {
          action: string
          actor_email: string
          attempts?: number
          id?: string
          last_attempt_at?: string
          ledger_id?: string | null
          scope_key?: string
          window_started_at?: string
        }
        Update: {
          action?: string
          actor_email?: string
          attempts?: number
          id?: string
          last_attempt_at?: string
          ledger_id?: string | null
          scope_key?: string
          window_started_at?: string
        }
        Relationships: []
      }
      ledgers: {
        Row: {
          bootstrap_locked_at: string | null
          close_reminder_enabled: boolean
          created_at: string
          created_by_member_id: string | null
          currency: string
          estimated_consumption_l_per_100km: number
          expense_split_defaults: Json
          fallback_fuel_price: number
          fuel_price_warn_high: number
          fuel_price_warn_low: number
          fuel_sanity_threshold_pct: number
          fuel_tank_capacity_l: number
          fuel_type: string
          high_fuel_threshold_percent: number
          id: string
          insurance_coverage: string | null
          insurance_deductible_dkk: number | null
          insurance_policy_no: string | null
          insurance_premium_dkk: number | null
          insurance_provider: string | null
          insurance_renewal: string | null
          invite_required: boolean
          is_public_signup_enabled: boolean
          join_code: string | null
          join_code_rotated_at: string | null
          low_fuel_threshold_percent: number
          name: string
          next_service_date: string | null
          next_service_km: number | null
          repairs_split_mode: string
          rule_lock_period_after_payment: boolean
          rule_require_requests_before_close: boolean
          settlement_mode: string
          slug: string
          tank_baseline_fraction: number | null
          tank_baseline_odometer: number | null
          tank_baseline_recorded_at: string | null
          updated_at: string
          vehicle_info: Json
          vehicle_lookup_at: string | null
          vehicle_lookup_source: string
          vehicle_plate: string
        }
        Insert: {
          bootstrap_locked_at?: string | null
          close_reminder_enabled?: boolean
          created_at?: string
          created_by_member_id?: string | null
          currency?: string
          estimated_consumption_l_per_100km?: number
          expense_split_defaults?: Json
          fallback_fuel_price?: number
          fuel_price_warn_high?: number
          fuel_price_warn_low?: number
          fuel_sanity_threshold_pct?: number
          fuel_tank_capacity_l?: number
          fuel_type?: string
          high_fuel_threshold_percent?: number
          id: string
          insurance_coverage?: string | null
          insurance_deductible_dkk?: number | null
          insurance_policy_no?: string | null
          insurance_premium_dkk?: number | null
          insurance_provider?: string | null
          insurance_renewal?: string | null
          invite_required?: boolean
          is_public_signup_enabled?: boolean
          join_code?: string | null
          join_code_rotated_at?: string | null
          low_fuel_threshold_percent?: number
          name?: string
          next_service_date?: string | null
          next_service_km?: number | null
          repairs_split_mode?: string
          rule_lock_period_after_payment?: boolean
          rule_require_requests_before_close?: boolean
          settlement_mode?: string
          slug: string
          tank_baseline_fraction?: number | null
          tank_baseline_odometer?: number | null
          tank_baseline_recorded_at?: string | null
          updated_at?: string
          vehicle_info?: Json
          vehicle_lookup_at?: string | null
          vehicle_lookup_source?: string
          vehicle_plate?: string
        }
        Update: {
          bootstrap_locked_at?: string | null
          close_reminder_enabled?: boolean
          created_at?: string
          created_by_member_id?: string | null
          currency?: string
          estimated_consumption_l_per_100km?: number
          expense_split_defaults?: Json
          fallback_fuel_price?: number
          fuel_price_warn_high?: number
          fuel_price_warn_low?: number
          fuel_sanity_threshold_pct?: number
          fuel_tank_capacity_l?: number
          fuel_type?: string
          high_fuel_threshold_percent?: number
          id?: string
          insurance_coverage?: string | null
          insurance_deductible_dkk?: number | null
          insurance_policy_no?: string | null
          insurance_premium_dkk?: number | null
          insurance_provider?: string | null
          insurance_renewal?: string | null
          invite_required?: boolean
          is_public_signup_enabled?: boolean
          join_code?: string | null
          join_code_rotated_at?: string | null
          low_fuel_threshold_percent?: number
          name?: string
          next_service_date?: string | null
          next_service_km?: number | null
          repairs_split_mode?: string
          rule_lock_period_after_payment?: boolean
          rule_require_requests_before_close?: boolean
          settlement_mode?: string
          slug?: string
          tank_baseline_fraction?: number | null
          tank_baseline_odometer?: number | null
          tank_baseline_recorded_at?: string | null
          updated_at?: string
          vehicle_info?: Json
          vehicle_lookup_at?: string | null
          vehicle_lookup_source?: string
          vehicle_plate?: string
        }
        Relationships: []
      }
      message_read_state: {
        Row: {
          last_read_at: string
          ledger_id: string
          member_id: string
        }
        Insert: {
          last_read_at?: string
          ledger_id: string
          member_id: string
        }
        Update: {
          last_read_at?: string
          ledger_id?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_read_state_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_read_state_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          created_at: string
          deleted_at: string | null
          id: string
          ledger_id: string
          sender_member_id: string
        }
        Insert: {
          body: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          ledger_id: string
          sender_member_id: string
        }
        Update: {
          body?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          ledger_id?: string
          sender_member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_member_id_fkey"
            columns: ["sender_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          activity_enabled: boolean
          payments_enabled: boolean
          periods_enabled: boolean
          quiet_end_hour: number
          quiet_hours_enabled: boolean
          quiet_start_hour: number
          snooze_until: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          activity_enabled?: boolean
          payments_enabled?: boolean
          periods_enabled?: boolean
          quiet_end_hour?: number
          quiet_hours_enabled?: boolean
          quiet_start_hour?: number
          snooze_until?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          activity_enabled?: boolean
          payments_enabled?: boolean
          periods_enabled?: boolean
          quiet_end_hour?: number
          quiet_hours_enabled?: boolean
          quiet_start_hour?: number
          snooze_until?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      owner_activity_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_member_id: string | null
          actor_role: string
          actor_user_id: string | null
          created_at: string
          duration_ms: number | null
          id: string
          ledger_id: string | null
          metadata: Json
          ok: boolean
          result_code: string
          route: string
          status_code: number
          summary: string
          workspace_label: string
        }
        Insert: {
          action?: string
          actor_email?: string | null
          actor_member_id?: string | null
          actor_role?: string
          actor_user_id?: string | null
          created_at?: string
          duration_ms?: number | null
          id?: string
          ledger_id?: string | null
          metadata?: Json
          ok?: boolean
          result_code?: string
          route?: string
          status_code?: number
          summary?: string
          workspace_label?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_member_id?: string | null
          actor_role?: string
          actor_user_id?: string | null
          created_at?: string
          duration_ms?: number | null
          id?: string
          ledger_id?: string | null
          metadata?: Json
          ok?: boolean
          result_code?: string
          route?: string
          status_code?: number
          summary?: string
          workspace_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_activity_log_actor_member_id_fkey"
            columns: ["actor_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_activity_log_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_api_rate_limits: {
        Row: {
          action: string
          actor_email: string
          attempts: number
          id: string
          last_attempt_at: string
          window_started_at: string
        }
        Insert: {
          action?: string
          actor_email: string
          attempts?: number
          id?: string
          last_attempt_at?: string
          window_started_at: string
        }
        Update: {
          action?: string
          actor_email?: string
          attempts?: number
          id?: string
          last_attempt_at?: string
          window_started_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          created_at: string
          id: string
          member_id: string | null
          subscription: Json
          updated_at: string
          user_email: string
        }
        Insert: {
          created_at?: string
          id?: string
          member_id?: string | null
          subscription: Json
          updated_at?: string
          user_email: string
        }
        Update: {
          created_at?: string
          id?: string
          member_id?: string | null
          subscription?: Json
          updated_at?: string
          user_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_expenses: {
        Row: {
          amount_dkk: number
          cadence: string
          category: string
          created_at: string
          created_by_member_id: string | null
          deleted_at: string | null
          description: string | null
          id: string
          is_active: boolean
          last_generated_at: string | null
          ledger_id: string
          next_due_date: string
          paid_by_member_id: string | null
          split_config: Json | null
          split_rule: string | null
          updated_at: string
        }
        Insert: {
          amount_dkk?: number
          cadence?: string
          category?: string
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_generated_at?: string | null
          ledger_id: string
          next_due_date: string
          paid_by_member_id?: string | null
          split_config?: Json | null
          split_rule?: string | null
          updated_at?: string
        }
        Update: {
          amount_dkk?: number
          cadence?: string
          category?: string
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_generated_at?: string | null
          ledger_id?: string
          next_due_date?: string
          paid_by_member_id?: string | null
          split_config?: Json | null
          split_rule?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_expenses_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_expenses_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_expenses_paid_by_member_id_fkey"
            columns: ["paid_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_periods: {
        Row: {
          close_reminder_claim_token: string | null
          close_reminder_claimed_at: string | null
          closed_at: string | null
          closed_by_member_id: string | null
          created_at: string
          id: string
          label: string | null
          last_close_reminder_at: string | null
          ledger_id: string
          opened_at: string
          snapshot_json: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          close_reminder_claim_token?: string | null
          close_reminder_claimed_at?: string | null
          closed_at?: string | null
          closed_by_member_id?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_close_reminder_at?: string | null
          ledger_id: string
          opened_at?: string
          snapshot_json?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          close_reminder_claim_token?: string | null
          close_reminder_claimed_at?: string | null
          closed_at?: string | null
          closed_by_member_id?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_close_reminder_at?: string | null
          ledger_id?: string
          opened_at?: string
          snapshot_json?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_periods_closed_by_member_id_fkey"
            columns: ["closed_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_periods_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_requests: {
        Row: {
          amount: number
          created_at: string
          currency: string
          dispute_note: string | null
          from_member_id: string | null
          id: string
          last_reminder_at: string | null
          ledger_id: string
          paid_at: string | null
          paid_claimed_at: string | null
          paid_note: string | null
          period_id: string | null
          reminder_claim_token: string | null
          reminder_claimed_at: string | null
          reminder_count: number
          requested_at: string | null
          requested_by_member_id: string | null
          status: string
          to_member_id: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          dispute_note?: string | null
          from_member_id?: string | null
          id?: string
          last_reminder_at?: string | null
          ledger_id: string
          paid_at?: string | null
          paid_claimed_at?: string | null
          paid_note?: string | null
          period_id?: string | null
          reminder_claim_token?: string | null
          reminder_claimed_at?: string | null
          reminder_count?: number
          requested_at?: string | null
          requested_by_member_id?: string | null
          status?: string
          to_member_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          dispute_note?: string | null
          from_member_id?: string | null
          id?: string
          last_reminder_at?: string | null
          ledger_id?: string
          paid_at?: string | null
          paid_claimed_at?: string | null
          paid_note?: string | null
          period_id?: string | null
          reminder_claim_token?: string | null
          reminder_claimed_at?: string | null
          reminder_count?: number
          requested_at?: string | null
          requested_by_member_id?: string | null
          status?: string
          to_member_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_requests_from_member_id_fkey"
            columns: ["from_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_requests_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_requests_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "settlement_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_requests_requested_by_member_id_fkey"
            columns: ["requested_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_requests_to_member_id_fkey"
            columns: ["to_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
        ]
      }
      test_lab_reports: {
        Row: {
          created_at: string
          created_by_member_id: string | null
          id: string
          ledger_id: string
          report_id: string
          report_payload: Json
          synced_at: string
        }
        Insert: {
          created_at?: string
          created_by_member_id?: string | null
          id?: string
          ledger_id: string
          report_id: string
          report_payload: Json
          synced_at?: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string | null
          id?: string
          ledger_id?: string
          report_id?: string
          report_payload?: Json
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_lab_reports_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_lab_reports_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_participants: {
        Row: {
          created_at: string
          member_id: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          member_id: string
          trip_id: string
        }
        Update: {
          created_at?: string
          member_id?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_participants_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_participants_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          created_at: string
          created_by_member_id: string | null
          deleted_at: string | null
          driver_member_id: string | null
          end_km: number
          id: string
          ledger_id: string
          legacy_id: string | null
          note: string | null
          period_id: string | null
          start_km: number
          trip_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          driver_member_id?: string | null
          end_km: number
          id?: string
          ledger_id: string
          legacy_id?: string | null
          note?: string | null
          period_id?: string | null
          start_km: number
          trip_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          driver_member_id?: string | null
          end_km?: number
          id?: string
          ledger_id?: string
          legacy_id?: string | null
          note?: string | null
          period_id?: string | null
          start_km?: number
          trip_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_member_id_fkey"
            columns: ["driver_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "settlement_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_repairs: {
        Row: {
          cost_dkk: number
          created_at: string
          created_by_member_id: string | null
          deleted_at: string | null
          description: string
          id: string
          ledger_id: string
          odo_km: number | null
          paid_by_member_id: string | null
          period_id: string | null
          repair_date: string
          updated_at: string
          workshop: string | null
        }
        Insert: {
          cost_dkk?: number
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description: string
          id?: string
          ledger_id: string
          odo_km?: number | null
          paid_by_member_id?: string | null
          period_id?: string | null
          repair_date: string
          updated_at?: string
          workshop?: string | null
        }
        Update: {
          cost_dkk?: number
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description?: string
          id?: string
          ledger_id?: string
          odo_km?: number | null
          paid_by_member_id?: string | null
          period_id?: string | null
          repair_date?: string
          updated_at?: string
          workshop?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_repairs_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_repairs_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_repairs_paid_by_member_id_fkey"
            columns: ["paid_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_repairs_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "settlement_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_expenses: {
        Row: {
          amount_dkk: number
          category: string
          created_at: string
          created_by_member_id: string | null
          deleted_at: string | null
          description: string | null
          expense_date: string
          id: string
          ledger_id: string
          occurrence_date: string | null
          paid_by_member_id: string | null
          period_id: string | null
          recurring_expense_id: string | null
          split_config: Json | null
          split_rule: string | null
          updated_at: string
        }
        Insert: {
          amount_dkk?: number
          category?: string
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description?: string | null
          expense_date: string
          id?: string
          ledger_id: string
          occurrence_date?: string | null
          paid_by_member_id?: string | null
          period_id?: string | null
          recurring_expense_id?: string | null
          split_config?: Json | null
          split_rule?: string | null
          updated_at?: string
        }
        Update: {
          amount_dkk?: number
          category?: string
          created_at?: string
          created_by_member_id?: string | null
          deleted_at?: string | null
          description?: string | null
          expense_date?: string
          id?: string
          ledger_id?: string
          occurrence_date?: string | null
          paid_by_member_id?: string | null
          period_id?: string | null
          recurring_expense_id?: string | null
          split_config?: Json | null
          split_rule?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_expenses_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_expenses_ledger_id_fkey"
            columns: ["ledger_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_expenses_paid_by_member_id_fkey"
            columns: ["paid_by_member_id"]
            isOneToOne: false
            referencedRelation: "ledger_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_expenses_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "settlement_periods"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_payment_status_action: {
        Args: {
          amount_value: number
          audit_detail: string
          audit_metadata?: Json
          audit_summary: string
          currency_value: string
          current_pair_keys?: string[]
          next_status: string
          payer_member_id: string
          previous_status: string
          recipient_member_id: string
          target_ledger_id: string
          target_open_period_id: string
        }
        Returns: Json
      }
      calculate_period_entry_fingerprint: {
        Args: { target_ledger_id: string; target_period_id: string }
        Returns: string
      }
      calculate_period_settlement: {
        Args: { target_ledger_id: string; target_period_id: string }
        Returns: Json
      }
      can_manage_car_booking: {
        Args: { p_booking_id: string }
        Returns: boolean
      }
      can_manage_fuel_payment: {
        Args: { p_fuel_payment_id: string }
        Returns: boolean
      }
      can_manage_trip: { Args: { p_trip_id: string }; Returns: boolean }
      check_ledger_invite_email: {
        Args: { invite_code: string; login_email: string }
        Returns: {
          allowed: boolean
          message: string
          restricted: boolean
          result_code: string
        }[]
      }
      check_owner_rate_limit: {
        Args: {
          actor_email: string
          limit_action?: string
          max_attempts?: number
          window_seconds?: number
        }
        Returns: {
          allowed: boolean
          attempts: number
          limit_value: number
          retry_after_seconds: number
        }[]
      }
      claim_due_close_reminders: {
        Args: { batch_limit?: number }
        Returns: {
          admin_emails: string[]
          claim_token: string
          label: string
          ledger_id: string
          period_id: string
        }[]
      }
      claim_due_payment_reminders: {
        Args: { batch_limit?: number }
        Returns: {
          amount: number
          claim_token: string
          creditor_name: string
          debtor_email: string
          ledger_id: string
          request_id: string
        }[]
      }
      claim_due_settlement_confirmations: {
        Args: { p_limit?: number; p_max_age_hours?: number }
        Returns: number
      }
      close_settlement_period: {
        Args: {
          period_snapshot: Json
          target_ledger_id: string
          target_period_id: string
        }
        Returns: Json
      }
      confirm_close_reminders: {
        Args: { confirmations: Json }
        Returns: number
      }
      confirm_payment_reminders: {
        Args: { confirmations: Json }
        Returns: number
      }
      create_ledger_invite: {
        Args: {
          expires_in_hours?: number
          invite_email?: string
          invite_role?: string
          max_uses?: number
          target_ledger_id?: string
        }
        Returns: {
          expires_at: string
          invite_code: string
          invite_id: string
          invited_email: string
          ledger_id: string
          role: string
        }[]
      }
      create_private_ledger_workspace: {
        Args: { workspace_name: string; workspace_slug?: string }
        Returns: {
          admin_member_id: string
          ledger_id: string
          name: string
          slug: string
        }[]
      }
      current_ledger_member_id: {
        Args: { p_ledger_id: string }
        Returns: string
      }
      current_user_email: { Args: never; Returns: string }
      delete_my_account: { Args: never; Returns: Json }
      delete_push_token: { Args: { token_value: string }; Returns: undefined }
      emit_inspection_due_event: {
        Args: { target_ledger_id: string }
        Returns: Json
      }
      enforce_onboarding_rate_limit: {
        Args: {
          limit_action: string
          max_attempts?: number
          target_ledger_id?: string
          window_minutes?: number
        }
        Returns: undefined
      }
      fuel_ledger_healthcheck: {
        Args: { target_ledger_id?: string }
        Returns: Json
      }
      generate_all_due_recurring_expenses: {
        Args: { batch_limit?: number }
        Returns: Json
      }
      generate_due_recurring_expenses: {
        Args: { target_ledger_id: string }
        Returns: Json
      }
      generate_workspace_join_code: { Args: never; Returns: string }
      get_notification_preferences: {
        Args: never
        Returns: {
          activity_enabled: boolean
          payments_enabled: boolean
          periods_enabled: boolean
          quiet_end_hour: number
          quiet_hours_enabled: boolean
          quiet_start_hour: number
          snooze_until: string
        }[]
      }
      get_workspace_join_code: {
        Args: { target_ledger_id?: string }
        Returns: string
      }
      hash_ledger_invite_code: {
        Args: { invite_code: string }
        Returns: string
      }
      insert_repair: {
        Args: {
          cost_dkk_value: number
          description_value: string
          odo_km_value?: number
          paid_by_member_id_value?: string
          repair_date_value: string
          target_ledger_id: string
          workshop?: string
        }
        Returns: Json
      }
      is_ledger_admin: { Args: { p_ledger_id: string }; Returns: boolean }
      is_ledger_member: { Args: { p_ledger_id: string }; Returns: boolean }
      is_operator_context: { Args: never; Returns: boolean }
      is_valid_payment_status_transition: {
        Args: { p_next_status: string; p_previous_status: string }
        Returns: boolean
      }
      list_my_ledgers: {
        Args: never
        Returns: {
          bootstrap_locked_at: string
          invite_required: boolean
          is_public_signup_enabled: boolean
          ledger_id: string
          member_id: string
          name: string
          role: string
          slug: string
        }[]
      }
      mark_messages_read: {
        Args: { target_ledger_id: string }
        Returns: undefined
      }
      member_belongs_to_ledger: {
        Args: { p_ledger_id: string; p_member_id: string }
        Returns: boolean
      }
      member_is_active_in_ledger: {
        Args: { p_ledger_id: string; p_member_id: string }
        Returns: boolean
      }
      normalize_ledger_slug: { Args: { raw_slug: string }; Returns: string }
      post_message: {
        Args: { body_value: string; target_ledger_id: string }
        Returns: Json
      }
      preview_retention_cleanup: {
        Args: {
          event_retention_days?: number
          keep_latest_test_lab_reports?: number
          stale_push_days?: number
          target_ledger_id?: string
          test_lab_report_days?: number
        }
        Returns: Json
      }
      production_activity_reset: {
        Args: { target_ledger_id: string }
        Returns: Json
      }
      purge_generated_test_rows: {
        Args: { dry_run?: boolean; target_ledger_id?: string }
        Returns: Json
      }
      redeem_ledger_invite: {
        Args: { display_name?: string; invite_code: string }
        Returns: {
          ledger_id: string
          member_id: string
          role: string
        }[]
      }
      resolve_ledger_invite: {
        Args: { invite_code: string }
        Returns: {
          ledger_id: string
          ledger_name: string
          member_count: number
          owner_name: string
          role: string
        }[]
      }
      revoke_ledger_invite: {
        Args: { target_invite_id: string; target_ledger_id: string }
        Returns: undefined
      }
      rotate_workspace_join_code: {
        Args: { target_ledger_id?: string }
        Returns: string
      }
      run_retention_cleanup: {
        Args: {
          event_retention_days?: number
          keep_latest_test_lab_reports?: number
          stale_push_days?: number
          target_ledger_id?: string
          test_lab_report_days?: number
        }
        Returns: Json
      }
      save_scheduled_reminder_state: {
        Args: { p_ledger_id: string; p_state: Json }
        Returns: Json
      }
      scheduled_reminder_state: {
        Args: { p_ledger_id?: string }
        Returns: Json
      }
      set_close_reminder_enabled: {
        Args: { enabled: boolean; target_ledger_id: string }
        Returns: undefined
      }
      set_ledger_member_active_admin: {
        Args: {
          member_is_active?: boolean
          target_ledger_id?: string
          target_member_id?: string
        }
        Returns: string
      }
      set_member_name: {
        Args: {
          event_body?: string
          event_title?: string
          new_name: string
          target_ledger_id: string
          target_member_id: string
        }
        Returns: {
          ledger_id: string
          member_id: string
          name: string
        }[]
      }
      set_notification_preferences: {
        Args: {
          activity: boolean
          clear_snooze_value?: boolean
          payments: boolean
          periods: boolean
          quiet_end_hour_value?: number
          quiet_hours_enabled_value?: boolean
          quiet_start_hour_value?: number
          snooze_until_value?: string
        }
        Returns: undefined
      }
      set_tank_baseline: {
        Args: {
          event_body?: string
          event_title?: string
          fraction_value: number
          odometer_value: number
          target_ledger_id: string
        }
        Returns: Json
      }
      settlement_entry_is_locked: {
        Args: { p_ledger_id: string; p_period_id: string }
        Returns: boolean
      }
      soft_delete_car_booking: {
        Args: { legacy_booking_id: string; target_ledger_id: string }
        Returns: Json
      }
      soft_delete_recurring_expense: {
        Args: { recurring_id_value: string; target_ledger_id: string }
        Returns: Json
      }
      soft_delete_workspace_expense: {
        Args: { expense_id_value: string; target_ledger_id: string }
        Returns: Json
      }
      touch_member_presence: {
        Args: { target_ledger_id: string }
        Returns: undefined
      }
      update_ledger_insurance: {
        Args: {
          coverage_value?: string
          deductible_value?: number
          event_body?: string
          event_title?: string
          policy_no_value?: string
          premium_value?: number
          provider_value?: string
          renewal_value?: string
          target_ledger_id: string
        }
        Returns: Json
      }
      update_ledger_settings: {
        Args: {
          expense_split_defaults_value?: Json
          repairs_split_mode_value?: string
          settlement_mode_value?: string
          target_ledger_id: string
          vehicle_info_value?: Json
        }
        Returns: undefined
      }
      update_ledger_vehicle: {
        Args: {
          estimated_consumption_value?: number
          event_body?: string
          event_title?: string
          event_type_value?: string
          fuel_tank_capacity_value?: number
          fuel_type_value?: string
          target_ledger_id: string
          vehicle_info_value?: Json
          vehicle_lookup_at_value?: string
          vehicle_lookup_source_value?: string
          vehicle_plate_value?: string
        }
        Returns: Json
      }
      update_own_ledger_member_mobilepay: {
        Args: { member_mobilepay_phone?: string; target_ledger_id?: string }
        Returns: {
          ledger_id: string
          member_id: string
          mobilepay_phone: string
        }[]
      }
      update_own_ledger_member_profile: {
        Args: {
          member_mobilepay_phone?: string
          member_name?: string
          target_ledger_id?: string
        }
        Returns: {
          email: string
          ledger_id: string
          member_id: string
          mobilepay_phone: string
          name: string
          role: string
        }[]
      }
      upsert_car_booking: {
        Args: {
          booking_member_id: string
          end_at_value: string
          event_body?: string
          event_title?: string
          fuel_stop_value?: Json
          legacy_booking_id: string
          purpose_value: string
          start_at_value: string
          target_ledger_id: string
        }
        Returns: Json
      }
      upsert_fuel_payment: {
        Args: {
          amount_value: number
          currency_value: string
          event_body?: string
          event_title?: string
          full_tank_value: boolean
          legacy_fuel_id: string
          liters_value: number
          odometer_value: number
          payer_member_id: string
          payment_date_value: string
          price_per_liter_value: number
          station_brand_value: string
          station_lat_value: number
          station_lng_value: number
          station_name_value: string
          target_ledger_id: string
          target_open_period_id: string
          user_lat_value: number
          user_lng_value: number
        }
        Returns: Json
      }
      upsert_ledger_member_admin: {
        Args: {
          member_email?: string
          member_is_active?: boolean
          member_mobilepay_phone?: string
          member_name?: string
          member_role?: string
          target_ledger_id?: string
          target_member_id?: string
        }
        Returns: string
      }
      upsert_push_token: {
        Args: { platform_value?: string; token_value: string }
        Returns: undefined
      }
      upsert_recurring_expense: {
        Args: {
          amount_value?: number
          cadence_value?: string
          category_value?: string
          description_value?: string
          event_body?: string
          event_title?: string
          is_active_value?: boolean
          next_due_date_value?: string
          paid_by_value?: string
          recurring_id_value?: string
          split_config_value?: Json
          split_rule_value?: string
          target_ledger_id: string
        }
        Returns: Json
      }
      upsert_settlement_request_status: {
        Args: {
          amount_value: number
          currency_value: string
          current_pair_keys?: string[]
          next_status: string
          p_note?: string
          payer_member_id: string
          recipient_member_id: string
          target_ledger_id: string
          target_open_period_id: string
        }
        Returns: Json
      }
      upsert_test_lab_report: {
        Args: {
          report_id_value: string
          report_payload_value: Json
          target_ledger_id: string
        }
        Returns: Json
      }
      upsert_trip_with_participants: {
        Args: {
          driver_member_id: string
          end_km_value: number
          event_body?: string
          event_title?: string
          legacy_trip_id: string
          note_value: string
          participant_member_ids: string[]
          start_km_value: number
          target_ledger_id: string
          target_open_period_id: string
          trip_date_value: string
        }
        Returns: Json
      }
      upsert_workspace_expense: {
        Args: {
          amount_value?: number
          category_value?: string
          description_value?: string
          event_body?: string
          event_title?: string
          expense_date_value?: string
          expense_id_value?: string
          paid_by_value?: string
          split_config_value?: Json
          split_rule_value?: string
          target_ledger_id: string
          target_open_period_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
