export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          operationName?: string
          query?: string
          variables?: Json
          extensions?: Json
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
  public: {
    Tables: {
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
          org_id: string | null
          public_id: string | null
          retention_until: string | null
          revocation_reason: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["anchor_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          created_at?: string
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
          org_id?: string | null
          public_id?: string | null
          retention_until?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["anchor_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          created_at?: string
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
          org_id?: string | null
          public_id?: string | null
          retention_until?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["anchor_status"]
          updated_at?: string
          user_id?: string
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
          actor_ip: unknown | null
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
          actor_ip?: unknown | null
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
          actor_ip?: unknown | null
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
          updated_at: string
          verification_status: string
        }
        Insert: {
          created_at?: string
          display_name: string
          domain?: string | null
          id?: string
          legal_name: string
          updated_at?: string
          verification_status?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          domain?: string | null
          id?: string
          legal_name?: string
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
          flag_id: string
          id: string
          new_value: boolean
          old_value: boolean | null
          reason: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          flag_id: string
          id?: string
          new_value: boolean
          old_value?: boolean | null
          reason?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          flag_id?: string
          id?: string
          new_value?: boolean
          old_value?: boolean | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "switchboard_flag_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "switchboard_flag_history_flag_id_fkey"
            columns: ["flag_id"]
            isOneToOne: false
            referencedRelation: "switchboard_flags"
            referencedColumns: ["id"]
          },
        ]
      }
      switchboard_flags: {
        Row: {
          default_value: boolean
          description: string | null
          id: string
          is_dangerous: boolean
          updated_at: string
          updated_by: string | null
          value: boolean
        }
        Insert: {
          default_value: boolean
          description?: string | null
          id: string
          is_dangerous?: boolean
          updated_at?: string
          updated_by?: string | null
          value: boolean
        }
        Update: {
          default_value?: boolean
          description?: string | null
          id?: string
          is_dangerous?: boolean
          updated_at?: string
          updated_by?: string | null
          value?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "switchboard_flags_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      bulk_create_anchors: {
        Args: {
          anchors_data: Json
        }
        Returns: Json
      }
      claim_anchoring_job: {
        Args: {
          p_worker_id: string
          p_lock_duration_seconds?: number
        }
        Returns: string
      }
      complete_anchoring_job: {
        Args: {
          p_job_id: string
          p_success: boolean
          p_error?: string
        }
        Returns: boolean
      }
      generate_public_id: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_flag: {
        Args: {
          p_flag_id: string
        }
        Returns: boolean
      }
      get_public_anchor: {
        Args: {
          p_public_id: string
        }
        Returns: Json
      }
      get_user_org_id: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      invite_member: {
        Args: {
          invite_email: string
          invite_role: Database["public"]["Enums"]["user_role"]
          org_id: string
        }
        Returns: string
      }
      is_org_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      revoke_anchor: {
        Args: {
          anchor_id: string
        }
        Returns: undefined
      }
      update_profile_onboarding: {
        Args: {
          p_role: Database["public"]["Enums"]["user_role"]
          p_org_legal_name?: string
          p_org_display_name?: string
          p_org_domain?: string
        }
        Returns: Json
      }
    }
    Enums: {
      anchor_status: "PENDING" | "SECURED" | "REVOKED" | "EXPIRED"
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

type PublicSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
        PublicSchema["Views"])
    ? (PublicSchema["Tables"] &
        PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
    ? PublicSchema["Enums"][PublicEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof PublicSchema["CompositeTypes"]
    ? PublicSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

