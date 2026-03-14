export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      anchor_chain_index: {
        Row: {
          anchor_id: string | null
          chain_block_height: number | null
          chain_block_timestamp: string | null
          chain_tx_id: string
          confirmations: number | null
          created_at: string
          fingerprint_sha256: string
          id: string
          updated_at: string
        }
        Insert: {
          anchor_id?: string | null
          chain_block_height?: number | null
          chain_block_timestamp?: string | null
          chain_tx_id: string
          confirmations?: number | null
          created_at?: string
          fingerprint_sha256: string
          id?: string
          updated_at?: string
        }
        Update: {
          anchor_id?: string | null
          chain_block_height?: number | null
          chain_block_timestamp?: string | null
          chain_tx_id?: string
          confirmations?: number | null
          created_at?: string
          fingerprint_sha256?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "anchor_chain_index_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
        ]
      }
      anchor_proofs: {
        Row: {
          anchor_id: string
          block_height: number
          block_timestamp: string
          created_at: string
          id: string
          merkle_root: string | null
          proof_path: Json | null
          raw_response: Json | null
          receipt_id: string
        }
        Insert: {
          anchor_id: string
          block_height: number
          block_timestamp: string
          created_at?: string
          id?: string
          merkle_root?: string | null
          proof_path?: Json | null
          raw_response?: Json | null
          receipt_id: string
        }
        Update: {
          anchor_id?: string
          block_height?: number
          block_timestamp?: string
          created_at?: string
          id?: string
          merkle_root?: string | null
          proof_path?: Json | null
          raw_response?: Json | null
          receipt_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "anchor_proofs_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: true
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
        ]
      }
      anchoring_jobs: {
        Row: {
          anchor_id: string
          attempts: number
          claim_expires_at: string | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          id: string
          last_error: string | null
          max_attempts: number
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
        }
        Insert: {
          anchor_id: string
          attempts?: number
          claim_expires_at?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          max_attempts?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Update: {
          anchor_id?: string
          attempts?: number
          claim_expires_at?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          max_attempts?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Relationships: [
          {
            foreignKeyName: "anchoring_jobs_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: true
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
        ]
      }
      anchors: {
        Row: {
          chain_block_height: number | null
          chain_timestamp: string | null
          chain_tx_id: string | null
          created_at: string
          credential_type: Database["public"]["Enums"]["credential_type"] | null
          deleted_at: string | null
          expires_at: string | null
          file_mime: string | null
          file_size: number | null
          filename: string
          fingerprint: string
          id: string
          issued_at: string | null
          label: string | null
          legal_hold: boolean
          metadata: Json | null
          org_id: string | null
          parent_anchor_id: string | null
          public_id: string | null
          retention_until: string | null
          revocation_reason: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["anchor_status"]
          updated_at: string
          user_id: string
          version_number: number
        }
        Insert: {
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          created_at?: string
          credential_type?:
            | Database["public"]["Enums"]["credential_type"]
            | null
          deleted_at?: string | null
          expires_at?: string | null
          file_mime?: string | null
          file_size?: number | null
          filename: string
          fingerprint: string
          id?: string
          issued_at?: string | null
          label?: string | null
          legal_hold?: boolean
          metadata?: Json | null
          org_id?: string | null
          parent_anchor_id?: string | null
          public_id?: string | null
          retention_until?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["anchor_status"]
          updated_at?: string
          user_id: string
          version_number?: number
        }
        Update: {
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          created_at?: string
          credential_type?:
            | Database["public"]["Enums"]["credential_type"]
            | null
          deleted_at?: string | null
          expires_at?: string | null
          file_mime?: string | null
          file_size?: number | null
          filename?: string
          fingerprint?: string
          id?: string
          issued_at?: string | null
          label?: string | null
          legal_hold?: boolean
          metadata?: Json | null
          org_id?: string | null
          parent_anchor_id?: string | null
          public_id?: string | null
          retention_until?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["anchor_status"]
          updated_at?: string
          user_id?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "anchors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anchors_parent_anchor_id_fkey"
            columns: ["parent_anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anchors_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          actor_ip: unknown
          actor_user_agent: string | null
          created_at: string
          details: string | null
          event_category: string
          event_type: string
          id: string
          org_id: string | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          actor_email?: string | null
          actor_id?: string | null
          actor_ip?: unknown
          actor_user_agent?: string | null
          created_at?: string
          details?: string | null
          event_category: string
          event_type: string
          id?: string
          org_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          actor_email?: string | null
          actor_id?: string | null
          actor_ip?: unknown
          actor_user_agent?: string | null
          created_at?: string
          details?: string | null
          event_category?: string
          event_type?: string
          id?: string
          org_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_events: {
        Row: {
          event_type: string
          id: string
          idempotency_key: string | null
          org_id: string | null
          payload: Json
          processed_at: string
          stripe_event_id: string | null
          subscription_id: string | null
          user_id: string | null
        }
        Insert: {
          event_type: string
          id?: string
          idempotency_key?: string | null
          org_id?: string | null
          payload?: Json
          processed_at?: string
          stripe_event_id?: string | null
          subscription_id?: string | null
          user_id?: string | null
        }
        Update: {
          event_type?: string
          id?: string
          idempotency_key?: string | null
          org_id?: string | null
          payload?: Json
          processed_at?: string
          stripe_event_id?: string | null
          subscription_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_events_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      credential_templates: {
        Row: {
          created_at: string
          created_by: string | null
          credential_type: Database["public"]["Enums"]["credential_type"]
          default_metadata: Json | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          credential_type: Database["public"]["Enums"]["credential_type"]
          default_metadata?: Json | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          credential_type?: Database["public"]["Enums"]["credential_type"]
          default_metadata?: Json | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      entitlements: {
        Row: {
          created_at: string
          entitlement_type: string
          id: string
          org_id: string | null
          source: string
          user_id: string | null
          valid_from: string
          valid_until: string | null
          value: Json
        }
        Insert: {
          created_at?: string
          entitlement_type: string
          id?: string
          org_id?: string | null
          source?: string
          user_id?: string | null
          valid_from?: string
          valid_until?: string | null
          value?: Json
        }
        Update: {
          created_at?: string
          entitlement_type?: string
          id?: string
          org_id?: string | null
          source?: string
          user_id?: string | null
          valid_from?: string
          valid_until?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "entitlements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entitlements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      institution_ground_truth: {
        Row: {
          confidence_score: number | null
          created_at: string
          domain: string | null
          embedding: string | null
          id: string
          institution_name: string
          metadata: Json
          source: string
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          domain?: string | null
          embedding?: string | null
          id?: string
          institution_name: string
          metadata?: Json
          source?: string
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          domain?: string | null
          embedding?: string | null
          id?: string
          institution_name?: string
          metadata?: Json
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          org_id: string
          role: Database["public"]["Enums"]["user_role"]
          status: string
          token: string | null
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          org_id: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: string
          token?: string | null
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          org_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: string
          token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role: Database["public"]["Enums"]["user_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          display_name: string
          domain: string | null
          id: string
          legal_name: string
          public_id: string | null
          updated_at: string
          verification_status: string
        }
        Insert: {
          created_at?: string
          display_name: string
          domain?: string | null
          id?: string
          legal_name: string
          public_id?: string | null
          updated_at?: string
          verification_status?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          domain?: string | null
          id?: string
          legal_name?: string
          public_id?: string | null
          updated_at?: string
          verification_status?: string
        }
        Relationships: []
      }
      plans: {
        Row: {
          billing_period: string
          created_at: string
          description: string | null
          features: Json
          id: string
          is_active: boolean
          name: string
          price_cents: number
          records_per_month: number
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          billing_period?: string
          created_at?: string
          description?: string | null
          features?: Json
          id: string
          is_active?: boolean
          name: string
          price_cents?: number
          records_per_month?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          billing_period?: string
          created_at?: string
          description?: string | null
          features?: Json
          id?: string
          is_active?: boolean
          name?: string
          price_cents?: number
          records_per_month?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_public_profile: boolean
          is_verified: boolean
          manual_review_completed_at: string | null
          manual_review_completed_by: string | null
          manual_review_reason: string | null
          org_id: string | null
          public_id: string | null
          requires_manual_review: boolean
          role: Database["public"]["Enums"]["user_role"] | null
          role_set_at: string | null
          subscription_tier: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          is_public_profile?: boolean
          is_verified?: boolean
          manual_review_completed_at?: string | null
          manual_review_completed_by?: string | null
          manual_review_reason?: string | null
          org_id?: string | null
          public_id?: string | null
          requires_manual_review?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          role_set_at?: string | null
          subscription_tier?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_public_profile?: boolean
          is_verified?: boolean
          manual_review_completed_at?: string | null
          manual_review_completed_by?: string | null
          manual_review_reason?: string | null
          org_id?: string | null
          public_id?: string | null
          requires_manual_review?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          role_set_at?: string | null
          subscription_tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      report_artifacts: {
        Row: {
          created_at: string
          file_size: number | null
          filename: string
          id: string
          mime_type: string
          report_id: string
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_size?: number | null
          filename: string
          id?: string
          mime_type?: string
          report_id: string
          storage_path: string
        }
        Update: {
          created_at?: string
          file_size?: number | null
          filename?: string
          id?: string
          mime_type?: string
          report_id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_artifacts_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          expires_at: string | null
          id: string
          idempotency_key: string | null
          org_id: string | null
          parameters: Json
          report_type: Database["public"]["Enums"]["report_type"]
          started_at: string | null
          status: Database["public"]["Enums"]["report_status"]
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string | null
          id?: string
          idempotency_key?: string | null
          org_id?: string | null
          parameters?: Json
          report_type: Database["public"]["Enums"]["report_type"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string | null
          id?: string
          idempotency_key?: string | null
          org_id?: string | null
          parameters?: Json
          report_type?: Database["public"]["Enums"]["report_type"]
          started_at?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          org_id: string | null
          plan_id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          org_id?: string | null
          plan_id: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          org_id?: string | null
          plan_id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      switchboard_flag_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          flag_key: string
          id: string
          new_value: boolean
          old_value: boolean | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          flag_key: string
          id?: string
          new_value: boolean
          old_value?: boolean | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          flag_key?: string
          id?: string
          new_value?: boolean
          old_value?: boolean | null
        }
        Relationships: []
      }
      switchboard_flags: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          flag_key: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          flag_key: string
          id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          flag_key?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      verification_events: {
        Row: {
          anchor_id: string | null
          country_code: string | null
          created_at: string
          fingerprint_provided: boolean
          id: string
          ip_hash: string | null
          method: string
          org_id: string | null
          public_id: string
          referrer: string | null
          result: string
          user_agent: string | null
        }
        Insert: {
          anchor_id?: string | null
          country_code?: string | null
          created_at?: string
          fingerprint_provided?: boolean
          id?: string
          ip_hash?: string | null
          method?: string
          org_id?: string | null
          public_id: string
          referrer?: string | null
          result: string
          user_agent?: string | null
        }
        Update: {
          anchor_id?: string | null
          country_code?: string | null
          created_at?: string
          fingerprint_provided?: boolean
          id?: string
          ip_hash?: string | null
          method?: string
          org_id?: string | null
          public_id?: string
          referrer?: string | null
          result?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_events_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_delivery_logs: {
        Row: {
          attempt_number: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          error_message: string | null
          event_id: string
          event_type: string
          id: string
          idempotency_key: string | null
          next_retry_at: string | null
          payload: Json
          response_body: string | null
          response_status: number | null
          status: string
        }
        Insert: {
          attempt_number?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          error_message?: string | null
          event_id: string
          event_type: string
          id?: string
          idempotency_key?: string | null
          next_retry_at?: string | null
          payload: Json
          response_body?: string | null
          response_status?: number | null
          status: string
        }
        Update: {
          attempt_number?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          error_message?: string | null
          event_id?: string
          event_type?: string
          id?: string
          idempotency_key?: string | null
          next_retry_at?: string | null
          payload?: Json
          response_body?: string | null
          response_status?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_delivery_logs_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          events: string[]
          id: string
          is_active: boolean
          org_id: string
          secret_hash: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          org_id: string
          secret_hash: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          org_id?: string
          secret_hash?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_endpoints_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bulk_create_anchors: { Args: { anchors_data: Json }; Returns: Json }
      check_anchor_quota: { Args: never; Returns: number }
      claim_anchoring_job: {
        Args: { p_lock_duration_seconds?: number; p_worker_id: string }
        Returns: string
      }
      complete_anchoring_job: {
        Args: { p_error?: string; p_job_id: string; p_success: boolean }
        Returns: boolean
      }
      create_webhook_endpoint: {
        Args: { p_events: string[]; p_url: string }
        Returns: Json
      }
      delete_webhook_endpoint: {
        Args: { p_endpoint_id: string }
        Returns: undefined
      }
      generate_public_id: { Args: never; Returns: string }
      get_flag: {
        Args: { p_default?: boolean; p_flag_key: string }
        Returns: boolean
      }
      get_public_anchor: { Args: { p_public_id: string }; Returns: Json }
      get_user_org_id: { Args: never; Returns: string }
      invite_member: {
        Args: {
          invite_email: string
          invite_role: Database["public"]["Enums"]["user_role"]
          org_id: string
        }
        Returns: string
      }
      is_org_admin: { Args: never; Returns: boolean }
      log_verification_event: {
        Args: {
          p_fingerprint_provided?: boolean
          p_method?: string
          p_public_id: string
          p_referrer?: string
          p_result?: string
          p_user_agent?: string
        }
        Returns: undefined
      }
      revoke_anchor:
        | { Args: { anchor_id: string }; Returns: undefined }
        | { Args: { anchor_id: string; reason?: string }; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      update_profile_onboarding: {
        Args: {
          p_org_display_name?: string
          p_org_domain?: string
          p_org_legal_name?: string
          p_role: Database["public"]["Enums"]["user_role"]
        }
        Returns: Json
      }
    }
    Enums: {
      anchor_status: "PENDING" | "SECURED" | "REVOKED" | "EXPIRED"
      credential_type:
        | "DEGREE"
        | "LICENSE"
        | "CERTIFICATE"
        | "TRANSCRIPT"
        | "PROFESSIONAL"
        | "OTHER"
      job_status: "pending" | "processing" | "completed" | "failed"
      report_status: "pending" | "generating" | "completed" | "failed"
      report_type:
        | "anchor_summary"
        | "compliance_audit"
        | "activity_log"
        | "billing_history"
      user_role: "INDIVIDUAL" | "ORG_ADMIN" | "ORG_MEMBER"
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
    Enums: {
      anchor_status: ["PENDING", "SECURED", "REVOKED", "EXPIRED"],
      credential_type: [
        "DEGREE",
        "LICENSE",
        "CERTIFICATE",
        "TRANSCRIPT",
        "PROFESSIONAL",
        "OTHER",
      ],
      job_status: ["pending", "processing", "completed", "failed"],
      report_status: ["pending", "generating", "completed", "failed"],
      report_type: [
        "anchor_summary",
        "compliance_audit",
        "activity_log",
        "billing_history",
      ],
      user_role: ["INDIVIDUAL", "ORG_ADMIN", "ORG_MEMBER"],
    },
  },
} as const
