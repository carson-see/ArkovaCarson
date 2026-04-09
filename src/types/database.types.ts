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
      ai_credits: {
        Row: {
          created_at: string
          id: string
          monthly_allocation: number
          org_id: string | null
          period_end: string
          period_start: string
          updated_at: string
          used_this_month: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          period_end?: string
          period_start?: string
          updated_at?: string
          used_this_month?: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          period_end?: string
          period_start?: string
          updated_at?: string
          used_this_month?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_credits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_reports: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          file_url: string | null
          id: string
          org_id: string
          parameters: Json | null
          report_type: string
          requested_by: string
          result: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["ai_report_status"]
          title: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_url?: string | null
          id?: string
          org_id: string
          parameters?: Json | null
          report_type: string
          requested_by: string
          result?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ai_report_status"]
          title: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_url?: string | null
          id?: string
          org_id?: string
          parameters?: Json | null
          report_type?: string
          requested_by?: string
          result?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ai_report_status"]
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_reports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_events: {
        Row: {
          confidence: number | null
          created_at: string
          credits_consumed: number
          duration_ms: number | null
          error_message: string | null
          event_type: string
          fingerprint: string | null
          id: string
          org_id: string | null
          prompt_version: string | null
          provider: string
          result_json: Json | null
          success: boolean
          tokens_used: number | null
          user_id: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          credits_consumed?: number
          duration_ms?: number | null
          error_message?: string | null
          event_type: string
          fingerprint?: string | null
          id?: string
          org_id?: string | null
          prompt_version?: string | null
          provider: string
          result_json?: Json | null
          success?: boolean
          tokens_used?: number | null
          user_id?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string
          credits_consumed?: number
          duration_ms?: number | null
          error_message?: string | null
          event_type?: string
          fingerprint?: string | null
          id?: string
          org_id?: string | null
          prompt_version?: string | null
          provider?: string
          result_json?: Json | null
          success?: boolean
          tokens_used?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
      anchor_recipients: {
        Row: {
          anchor_id: string
          claimed_at: string | null
          created_at: string
          id: string
          recipient_email_hash: string
          recipient_user_id: string | null
        }
        Insert: {
          anchor_id: string
          claimed_at?: string | null
          created_at?: string
          id?: string
          recipient_email_hash: string
          recipient_user_id?: string | null
        }
        Update: {
          anchor_id?: string
          claimed_at?: string | null
          created_at?: string
          id?: string
          recipient_email_hash?: string
          recipient_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "anchor_recipients_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anchor_recipients_recipient_user_id_fkey"
            columns: ["recipient_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          chain_confirmations: number | null
          chain_timestamp: string | null
          chain_tx_id: string | null
          compliance_controls: Json | null
          created_at: string
          credential_type: Database["public"]["Enums"]["credential_type"] | null
          deleted_at: string | null
          description: string | null
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
          payment_source_id: string | null
          payment_source_type: string | null
          public_id: string | null
          recipient_email: string | null
          retention_until: string | null
          revocation_block_height: number | null
          revocation_reason: string | null
          revocation_tx_id: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["anchor_status"]
          updated_at: string
          user_id: string
          version_number: number
        }
        Insert: {
          chain_block_height?: number | null
          chain_confirmations?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          compliance_controls?: Json | null
          created_at?: string
          credential_type?:
            | Database["public"]["Enums"]["credential_type"]
            | null
          deleted_at?: string | null
          description?: string | null
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
          payment_source_id?: string | null
          payment_source_type?: string | null
          public_id?: string | null
          recipient_email?: string | null
          retention_until?: string | null
          revocation_block_height?: number | null
          revocation_reason?: string | null
          revocation_tx_id?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["anchor_status"]
          updated_at?: string
          user_id: string
          version_number?: number
        }
        Update: {
          chain_block_height?: number | null
          chain_confirmations?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          compliance_controls?: Json | null
          created_at?: string
          credential_type?:
            | Database["public"]["Enums"]["credential_type"]
            | null
          deleted_at?: string | null
          description?: string | null
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
          payment_source_id?: string | null
          payment_source_type?: string | null
          public_id?: string | null
          recipient_email?: string | null
          retention_until?: string | null
          revocation_block_height?: number | null
          revocation_reason?: string | null
          revocation_tx_id?: string | null
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
      api_key_usage: {
        Row: {
          api_key_id: string
          id: string
          last_request_at: string | null
          month: string
          org_id: string
          request_count: number
        }
        Insert: {
          api_key_id: string
          id?: string
          last_request_at?: string | null
          month: string
          org_id: string
          request_count?: number
        }
        Update: {
          api_key_id?: string
          id?: string
          last_request_at?: string | null
          month?: string
          org_id?: string
          request_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_key_usage_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_usage_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          is_active: boolean
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          org_id: string
          rate_limit_tier: Database["public"]["Enums"]["api_key_rate_limit_tier"]
          revocation_reason: string | null
          revoked_at: string | null
          scopes: string[]
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          org_id: string
          rate_limit_tier?: Database["public"]["Enums"]["api_key_rate_limit_tier"]
          revocation_reason?: string | null
          revoked_at?: string | null
          scopes?: string[]
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          org_id?: string
          rate_limit_tier?: Database["public"]["Enums"]["api_key_rate_limit_tier"]
          revocation_reason?: string | null
          revoked_at?: string | null
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      attestation_evidence: {
        Row: {
          attestation_id: string
          created_at: string
          description: string | null
          evidence_type: string
          filename: string | null
          fingerprint: string
          id: string
          uploaded_by: string
        }
        Insert: {
          attestation_id: string
          created_at?: string
          description?: string | null
          evidence_type?: string
          filename?: string | null
          fingerprint: string
          id?: string
          uploaded_by: string
        }
        Update: {
          attestation_id?: string
          created_at?: string
          description?: string | null
          evidence_type?: string
          filename?: string | null
          fingerprint?: string
          id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "attestation_evidence_attestation_id_fkey"
            columns: ["attestation_id"]
            isOneToOne: false
            referencedRelation: "attestations"
            referencedColumns: ["id"]
          },
        ]
      }
      attestations: {
        Row: {
          anchor_id: string | null
          attestation_type: Database["public"]["Enums"]["attestation_type"]
          attester_name: string
          attester_org_id: string | null
          attester_title: string | null
          attester_type: Database["public"]["Enums"]["attester_type"]
          attester_user_id: string
          chain_block_height: number | null
          chain_timestamp: string | null
          chain_tx_id: string | null
          claims: Json
          created_at: string
          evidence_fingerprint: string | null
          expires_at: string | null
          fingerprint: string | null
          id: string
          issued_at: string
          jurisdiction: string | null
          metadata: Json | null
          public_id: string
          revocation_reason: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["attestation_status"]
          subject_identifier: string
          subject_type: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          anchor_id?: string | null
          attestation_type: Database["public"]["Enums"]["attestation_type"]
          attester_name: string
          attester_org_id?: string | null
          attester_title?: string | null
          attester_type?: Database["public"]["Enums"]["attester_type"]
          attester_user_id: string
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          claims?: Json
          created_at?: string
          evidence_fingerprint?: string | null
          expires_at?: string | null
          fingerprint?: string | null
          id?: string
          issued_at?: string
          jurisdiction?: string | null
          metadata?: Json | null
          public_id: string
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["attestation_status"]
          subject_identifier: string
          subject_type?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          anchor_id?: string | null
          attestation_type?: Database["public"]["Enums"]["attestation_type"]
          attester_name?: string
          attester_org_id?: string | null
          attester_title?: string | null
          attester_type?: Database["public"]["Enums"]["attester_type"]
          attester_user_id?: string
          chain_block_height?: number | null
          chain_timestamp?: string | null
          chain_tx_id?: string | null
          claims?: Json
          created_at?: string
          evidence_fingerprint?: string | null
          expires_at?: string | null
          fingerprint?: string | null
          id?: string
          issued_at?: string
          jurisdiction?: string | null
          metadata?: Json | null
          public_id?: string
          revocation_reason?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["attestation_status"]
          subject_identifier?: string
          subject_type?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attestations_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attestations_attester_org_id_fkey"
            columns: ["attester_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          actor_id: string | null
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
          actor_id?: string | null
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
          actor_id?: string | null
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
      audit_events_archive: {
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
        Relationships: []
      }
      batch_verification_jobs: {
        Row: {
          api_key_id: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          public_ids: string[]
          results: Json | null
          status: string
          total: number
        }
        Insert: {
          api_key_id: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          public_ids: string[]
          results?: Json | null
          status?: string
          total?: number
        }
        Update: {
          api_key_id?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          public_ids?: string[]
          results?: Json | null
          status?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "batch_verification_jobs_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
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
      credential_embeddings: {
        Row: {
          anchor_id: string
          created_at: string
          embedding: string
          id: string
          model_version: string
          org_id: string
          source_text_hash: string | null
          updated_at: string
        }
        Insert: {
          anchor_id: string
          created_at?: string
          embedding: string
          id?: string
          model_version?: string
          org_id: string
          source_text_hash?: string | null
          updated_at?: string
        }
        Update: {
          anchor_id?: string
          created_at?: string
          embedding?: string
          id?: string
          model_version?: string
          org_id?: string
          source_text_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_embeddings_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: true
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_embeddings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      credential_portfolios: {
        Row: {
          anchor_ids: string[] | null
          attestation_ids: string[] | null
          created_at: string | null
          expires_at: string | null
          id: string
          public_id: string
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          anchor_ids?: string[] | null
          attestation_ids?: string[] | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          public_id: string
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          anchor_ids?: string[] | null
          attestation_ids?: string[] | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          public_id?: string
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
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
          is_system: boolean
          name: string
          org_id: string | null
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
          is_system?: boolean
          name: string
          org_id?: string | null
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
          is_system?: boolean
          name?: string
          org_id?: string | null
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
      credit_transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          id: string
          org_id: string | null
          reason: string | null
          reference_id: string | null
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"]
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          id?: string
          org_id?: string | null
          reason?: string | null
          reference_id?: string | null
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"]
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          id?: string
          org_id?: string | null
          reason?: string | null
          reference_id?: string | null
          transaction_type?: Database["public"]["Enums"]["credit_transaction_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_transactions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      credits: {
        Row: {
          balance: number
          created_at: string
          cycle_end: string | null
          cycle_start: string | null
          id: string
          monthly_allocation: number
          org_id: string | null
          purchased: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          cycle_end?: string | null
          cycle_start?: string | null
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          purchased?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          cycle_end?: string | null
          cycle_start?: string | null
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          purchased?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credits_org_id_fkey"
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
      extraction_feedback: {
        Row: {
          action: string
          anchor_id: string | null
          corrected_value: string | null
          created_at: string
          credential_type: string
          field_key: string
          fingerprint: string
          id: string
          org_id: string | null
          original_confidence: number | null
          original_value: string | null
          provider: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          anchor_id?: string | null
          corrected_value?: string | null
          created_at?: string
          credential_type: string
          field_key: string
          fingerprint: string
          id?: string
          org_id?: string | null
          original_confidence?: number | null
          original_value?: string | null
          provider?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          anchor_id?: string | null
          corrected_value?: string | null
          created_at?: string
          credential_type?: string
          field_key?: string
          fingerprint?: string
          id?: string
          org_id?: string | null
          original_confidence?: number | null
          original_value?: string | null
          provider?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extraction_feedback_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_feedback_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_manifests: {
        Row: {
          anchor_id: string | null
          confidence_scores: Json
          created_at: string
          extracted_fields: Json
          extraction_timestamp: string
          fingerprint: string
          id: string
          manifest_hash: string
          model_id: string
          model_version: string
          org_id: string | null
          prompt_version: string | null
          usage_event_id: string | null
          user_id: string | null
          zk_circuit_version: string | null
          zk_poseidon_hash: string | null
          zk_proof: Json | null
          zk_proof_generated_at: string | null
          zk_proof_generation_ms: number | null
          zk_proof_protocol: string | null
          zk_public_signals: Json | null
        }
        Insert: {
          anchor_id?: string | null
          confidence_scores: Json
          created_at?: string
          extracted_fields: Json
          extraction_timestamp?: string
          fingerprint: string
          id?: string
          manifest_hash: string
          model_id: string
          model_version: string
          org_id?: string | null
          prompt_version?: string | null
          usage_event_id?: string | null
          user_id?: string | null
          zk_circuit_version?: string | null
          zk_poseidon_hash?: string | null
          zk_proof?: Json | null
          zk_proof_generated_at?: string | null
          zk_proof_generation_ms?: number | null
          zk_proof_protocol?: string | null
          zk_public_signals?: Json | null
        }
        Update: {
          anchor_id?: string | null
          confidence_scores?: Json
          created_at?: string
          extracted_fields?: Json
          extraction_timestamp?: string
          fingerprint?: string
          id?: string
          manifest_hash?: string
          model_id?: string
          model_version?: string
          org_id?: string | null
          prompt_version?: string | null
          usage_event_id?: string | null
          user_id?: string | null
          zk_circuit_version?: string | null
          zk_poseidon_hash?: string | null
          zk_proof?: Json | null
          zk_proof_generated_at?: string | null
          zk_proof_generation_ms?: number | null
          zk_proof_protocol?: string | null
          zk_public_signals?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "extraction_manifests_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_manifests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_reports: {
        Row: {
          avg_cost_per_anchor_usd: number | null
          bitcoin_fee_sats: number | null
          bitcoin_fee_usd: number | null
          created_at: string
          details: Json | null
          gross_margin_pct: number | null
          gross_margin_usd: number | null
          id: string
          report_month: string
          stripe_revenue_usd: number | null
          total_anchors: number | null
          total_revenue_usd: number | null
          x402_revenue_usd: number | null
        }
        Insert: {
          avg_cost_per_anchor_usd?: number | null
          bitcoin_fee_sats?: number | null
          bitcoin_fee_usd?: number | null
          created_at?: string
          details?: Json | null
          gross_margin_pct?: number | null
          gross_margin_usd?: number | null
          id?: string
          report_month: string
          stripe_revenue_usd?: number | null
          total_anchors?: number | null
          total_revenue_usd?: number | null
          x402_revenue_usd?: number | null
        }
        Update: {
          avg_cost_per_anchor_usd?: number | null
          bitcoin_fee_sats?: number | null
          bitcoin_fee_usd?: number | null
          created_at?: string
          details?: Json | null
          gross_margin_pct?: number | null
          gross_margin_usd?: number | null
          id?: string
          report_month?: string
          stripe_revenue_usd?: number | null
          total_anchors?: number | null
          total_revenue_usd?: number | null
          x402_revenue_usd?: number | null
        }
        Relationships: []
      }
      grc_connections: {
        Row: {
          access_token_encrypted: string | null
          created_at: string
          created_by: string
          external_org_id: string | null
          external_workspace_id: string | null
          id: string
          is_active: boolean
          last_sync_at: string | null
          last_sync_error: string | null
          last_sync_status:
            | Database["public"]["Enums"]["grc_sync_status"]
            | null
          org_id: string
          platform: Database["public"]["Enums"]["grc_platform"]
          refresh_token_encrypted: string | null
          scopes: string[] | null
          sync_count: number
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token_encrypted?: string | null
          created_at?: string
          created_by: string
          external_org_id?: string | null
          external_workspace_id?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?:
            | Database["public"]["Enums"]["grc_sync_status"]
            | null
          org_id: string
          platform: Database["public"]["Enums"]["grc_platform"]
          refresh_token_encrypted?: string | null
          scopes?: string[] | null
          sync_count?: number
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token_encrypted?: string | null
          created_at?: string
          created_by?: string
          external_org_id?: string | null
          external_workspace_id?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?:
            | Database["public"]["Enums"]["grc_sync_status"]
            | null
          org_id?: string
          platform?: Database["public"]["Enums"]["grc_platform"]
          refresh_token_encrypted?: string | null
          scopes?: string[] | null
          sync_count?: number
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grc_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      grc_sync_logs: {
        Row: {
          anchor_id: string | null
          connection_id: string
          created_at: string
          duration_ms: number | null
          error_message: string | null
          evidence_type: string
          external_evidence_id: string | null
          id: string
          request_payload: Json | null
          response_payload: Json | null
          status: Database["public"]["Enums"]["grc_sync_status"]
        }
        Insert: {
          anchor_id?: string | null
          connection_id: string
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          evidence_type?: string
          external_evidence_id?: string | null
          id?: string
          request_payload?: Json | null
          response_payload?: Json | null
          status?: Database["public"]["Enums"]["grc_sync_status"]
        }
        Update: {
          anchor_id?: string | null
          connection_id?: string
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          evidence_type?: string
          external_evidence_id?: string | null
          id?: string
          request_payload?: Json | null
          response_payload?: Json | null
          status?: Database["public"]["Enums"]["grc_sync_status"]
        }
        Relationships: [
          {
            foreignKeyName: "grc_sync_logs_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grc_sync_logs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "grc_connections"
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
      integrity_scores: {
        Row: {
          anchor_id: string
          computed_at: string
          details: Json | null
          duplicate_check: number | null
          extraction_confidence: number | null
          flags: Json | null
          id: string
          issuer_verification: number | null
          level: Database["public"]["Enums"]["integrity_level"]
          metadata_completeness: number | null
          org_id: string | null
          overall_score: number
          temporal_consistency: number | null
        }
        Insert: {
          anchor_id: string
          computed_at?: string
          details?: Json | null
          duplicate_check?: number | null
          extraction_confidence?: number | null
          flags?: Json | null
          id?: string
          issuer_verification?: number | null
          level: Database["public"]["Enums"]["integrity_level"]
          metadata_completeness?: number | null
          org_id?: string | null
          overall_score: number
          temporal_consistency?: number | null
        }
        Update: {
          anchor_id?: string
          computed_at?: string
          details?: Json | null
          duplicate_check?: number | null
          extraction_confidence?: number | null
          flags?: Json | null
          id?: string
          issuer_verification?: number | null
          level?: Database["public"]["Enums"]["integrity_level"]
          metadata_completeness?: number | null
          org_id?: string | null
          overall_score?: number
          temporal_consistency?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "integrity_scores_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: true
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrity_scores_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      org_members: {
        Row: {
          id: string
          invited_by: string | null
          joined_at: string
          org_id: string
          role: Database["public"]["Enums"]["org_member_role"]
          user_id: string
        }
        Insert: {
          id?: string
          invited_by?: string | null
          joined_at?: string
          org_id: string
          role?: Database["public"]["Enums"]["org_member_role"]
          user_id: string
        }
        Update: {
          id?: string
          invited_by?: string | null
          joined_at?: string
          org_id?: string
          role?: Database["public"]["Enums"]["org_member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          affiliation_fee_status: string | null
          affiliation_grace_expires_at: string | null
          created_at: string
          description: string | null
          display_name: string
          domain: string | null
          domain_verification_method: string | null
          domain_verification_token: string | null
          domain_verification_token_expires_at: string | null
          domain_verified: boolean | null
          domain_verified_at: string | null
          ein_tax_id: string | null
          founded_date: string | null
          id: string
          industry_tag: string | null
          legal_name: string
          linkedin_url: string | null
          location: string | null
          logo_url: string | null
          max_sub_orgs: number | null
          org_prefix: string | null
          org_type: string | null
          parent_approval_status: string | null
          parent_approved_at: string | null
          parent_org_id: string | null
          public_id: string | null
          twitter_url: string | null
          updated_at: string
          verification_status: string
          website_url: string | null
        }
        Insert: {
          affiliation_fee_status?: string | null
          affiliation_grace_expires_at?: string | null
          created_at?: string
          description?: string | null
          display_name: string
          domain?: string | null
          domain_verification_method?: string | null
          domain_verification_token?: string | null
          domain_verification_token_expires_at?: string | null
          domain_verified?: boolean | null
          domain_verified_at?: string | null
          ein_tax_id?: string | null
          founded_date?: string | null
          id?: string
          industry_tag?: string | null
          legal_name: string
          linkedin_url?: string | null
          location?: string | null
          logo_url?: string | null
          max_sub_orgs?: number | null
          org_prefix?: string | null
          org_type?: string | null
          parent_approval_status?: string | null
          parent_approved_at?: string | null
          parent_org_id?: string | null
          public_id?: string | null
          twitter_url?: string | null
          updated_at?: string
          verification_status?: string
          website_url?: string | null
        }
        Update: {
          affiliation_fee_status?: string | null
          affiliation_grace_expires_at?: string | null
          created_at?: string
          description?: string | null
          display_name?: string
          domain?: string | null
          domain_verification_method?: string | null
          domain_verification_token?: string | null
          domain_verification_token_expires_at?: string | null
          domain_verified?: boolean | null
          domain_verified_at?: string | null
          ein_tax_id?: string | null
          founded_date?: string | null
          id?: string
          industry_tag?: string | null
          legal_name?: string
          linkedin_url?: string | null
          location?: string | null
          logo_url?: string | null
          max_sub_orgs?: number | null
          org_prefix?: string | null
          org_type?: string | null
          parent_approval_status?: string | null
          parent_approved_at?: string | null
          parent_org_id?: string | null
          public_id?: string | null
          twitter_url?: string | null
          updated_at?: string
          verification_status?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organizations_parent_org_id_fkey"
            columns: ["parent_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_grace_periods: {
        Row: {
          created_at: string
          downgraded_at: string | null
          grace_end: string
          grace_start: string
          id: string
          notification_sent: boolean
          status: string
          stripe_subscription_id: string | null
          subscription_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          downgraded_at?: string | null
          grace_end?: string
          grace_start?: string
          id?: string
          notification_sent?: boolean
          status?: string
          stripe_subscription_id?: string | null
          subscription_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          downgraded_at?: string | null
          grace_end?: string
          grace_start?: string
          id?: string
          notification_sent?: boolean
          status?: string
          stripe_subscription_id?: string | null
          subscription_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_grace_periods_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
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
          activation_token: string | null
          activation_token_expires_at: string | null
          avatar_url: string | null
          bio: string | null
          created_at: string
          deleted_at: string | null
          disclaimer_accepted_at: string | null
          email: string
          full_name: string | null
          id: string
          identity_verification_session_id: string | null
          identity_verification_status: string | null
          identity_verified_at: string | null
          is_platform_admin: boolean
          is_public_profile: boolean
          is_verified: boolean
          kyc_provider: string | null
          manual_review_completed_at: string | null
          manual_review_completed_by: string | null
          manual_review_reason: string | null
          org_id: string | null
          phone_number: string | null
          phone_verified_at: string | null
          public_id: string | null
          requires_manual_review: boolean
          role: Database["public"]["Enums"]["user_role"] | null
          role_set_at: string | null
          social_links: Json | null
          status: Database["public"]["Enums"]["profile_status"] | null
          subscription_tier: string
          updated_at: string
        }
        Insert: {
          activation_token?: string | null
          activation_token_expires_at?: string | null
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          disclaimer_accepted_at?: string | null
          email: string
          full_name?: string | null
          id: string
          identity_verification_session_id?: string | null
          identity_verification_status?: string | null
          identity_verified_at?: string | null
          is_platform_admin?: boolean
          is_public_profile?: boolean
          is_verified?: boolean
          kyc_provider?: string | null
          manual_review_completed_at?: string | null
          manual_review_completed_by?: string | null
          manual_review_reason?: string | null
          org_id?: string | null
          phone_number?: string | null
          phone_verified_at?: string | null
          public_id?: string | null
          requires_manual_review?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          role_set_at?: string | null
          social_links?: Json | null
          status?: Database["public"]["Enums"]["profile_status"] | null
          subscription_tier?: string
          updated_at?: string
        }
        Update: {
          activation_token?: string | null
          activation_token_expires_at?: string | null
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          disclaimer_accepted_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          identity_verification_session_id?: string | null
          identity_verification_status?: string | null
          identity_verified_at?: string | null
          is_platform_admin?: boolean
          is_public_profile?: boolean
          is_verified?: boolean
          kyc_provider?: string | null
          manual_review_completed_at?: string | null
          manual_review_completed_by?: string | null
          manual_review_reason?: string | null
          org_id?: string | null
          phone_number?: string | null
          phone_verified_at?: string | null
          public_id?: string | null
          requires_manual_review?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          role_set_at?: string | null
          social_links?: Json | null
          status?: Database["public"]["Enums"]["profile_status"] | null
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
      public_record_embeddings: {
        Row: {
          created_at: string
          embedding: string | null
          id: string
          model_version: string | null
          public_record_id: string
        }
        Insert: {
          created_at?: string
          embedding?: string | null
          id?: string
          model_version?: string | null
          public_record_id: string
        }
        Update: {
          created_at?: string
          embedding?: string | null
          id?: string
          model_version?: string | null
          public_record_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_record_embeddings_public_record_id_fkey"
            columns: ["public_record_id"]
            isOneToOne: false
            referencedRelation: "public_records"
            referencedColumns: ["id"]
          },
        ]
      }
      public_records: {
        Row: {
          anchor_id: string | null
          content_hash: string
          created_at: string
          id: string
          metadata: Json | null
          record_type: string
          source: string
          source_id: string
          source_url: string | null
          title: string | null
          training_exported: boolean | null
          updated_at: string
        }
        Insert: {
          anchor_id?: string | null
          content_hash: string
          created_at?: string
          id?: string
          metadata?: Json | null
          record_type: string
          source: string
          source_id: string
          source_url?: string | null
          title?: string | null
          training_exported?: boolean | null
          updated_at?: string
        }
        Update: {
          anchor_id?: string | null
          content_hash?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          record_type?: string
          source?: string
          source_id?: string
          source_url?: string | null
          title?: string | null
          training_exported?: boolean | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_records_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_reports: {
        Row: {
          created_at: string
          discrepancies: Json | null
          id: string
          report_month: string
          report_type: string
          summary: string | null
          total_anchors: number | null
          total_cost_usd: number | null
          total_revenue_usd: number | null
        }
        Insert: {
          created_at?: string
          discrepancies?: Json | null
          id?: string
          report_month: string
          report_type: string
          summary?: string | null
          total_anchors?: number | null
          total_cost_usd?: number | null
          total_revenue_usd?: number | null
        }
        Update: {
          created_at?: string
          discrepancies?: Json | null
          id?: string
          report_month?: string
          report_type?: string
          summary?: string | null
          total_anchors?: number | null
          total_cost_usd?: number | null
          total_revenue_usd?: number | null
        }
        Relationships: []
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
      review_queue_items: {
        Row: {
          anchor_id: string
          assigned_to: string | null
          created_at: string
          flags: Json | null
          id: string
          integrity_score_id: string | null
          org_id: string
          priority: number
          reason: string
          review_action: Database["public"]["Enums"]["review_action"] | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["review_status"]
          updated_at: string
        }
        Insert: {
          anchor_id: string
          assigned_to?: string | null
          created_at?: string
          flags?: Json | null
          id?: string
          integrity_score_id?: string | null
          org_id: string
          priority?: number
          reason: string
          review_action?: Database["public"]["Enums"]["review_action"] | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          updated_at?: string
        }
        Update: {
          anchor_id?: string
          assigned_to?: string | null
          created_at?: string
          flags?: Json | null
          id?: string
          integrity_score_id?: string | null
          org_id?: string
          priority?: number
          reason?: string
          review_action?: Database["public"]["Enums"]["review_action"] | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_queue_items_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_queue_items_integrity_score_id_fkey"
            columns: ["integrity_score_id"]
            isOneToOne: false
            referencedRelation: "integrity_scores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_queue_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      signatures: {
        Row: {
          anchor_id: string | null
          archive_timestamp_id: string | null
          attestation_id: string | null
          completed_at: string | null
          contact_info: string | null
          created_at: string
          created_by: string
          document_fingerprint: string
          format: string
          id: string
          jurisdiction: string | null
          level: string
          location: string | null
          ltv_data_embedded: boolean
          metadata: Json | null
          org_id: string
          public_id: string
          reason: string | null
          revocation_reason: string | null
          revoked_at: string | null
          signature_algorithm: string | null
          signature_value: string | null
          signed_at: string | null
          signed_attributes: Json | null
          signer_certificate_id: string
          signer_name: string | null
          signer_org: string | null
          status: string
          timestamp_token_id: string | null
        }
        Insert: {
          anchor_id?: string | null
          archive_timestamp_id?: string | null
          attestation_id?: string | null
          completed_at?: string | null
          contact_info?: string | null
          created_at?: string
          created_by: string
          document_fingerprint: string
          format: string
          id?: string
          jurisdiction?: string | null
          level: string
          location?: string | null
          ltv_data_embedded?: boolean
          metadata?: Json | null
          org_id: string
          public_id: string
          reason?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          signature_algorithm?: string | null
          signature_value?: string | null
          signed_at?: string | null
          signed_attributes?: Json | null
          signer_certificate_id: string
          signer_name?: string | null
          signer_org?: string | null
          status?: string
          timestamp_token_id?: string | null
        }
        Update: {
          anchor_id?: string | null
          archive_timestamp_id?: string | null
          attestation_id?: string | null
          completed_at?: string | null
          contact_info?: string | null
          created_at?: string
          created_by?: string
          document_fingerprint?: string
          format?: string
          id?: string
          jurisdiction?: string | null
          level?: string
          location?: string | null
          ltv_data_embedded?: boolean
          metadata?: Json | null
          org_id?: string
          public_id?: string
          reason?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          signature_algorithm?: string | null
          signature_value?: string | null
          signed_at?: string | null
          signed_attributes?: Json | null
          signer_certificate_id?: string
          signer_name?: string | null
          signer_org?: string | null
          status?: string
          timestamp_token_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_signatures_archive_tst"
            columns: ["archive_timestamp_id"]
            isOneToOne: false
            referencedRelation: "timestamp_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_signatures_tst"
            columns: ["timestamp_token_id"]
            isOneToOne: false
            referencedRelation: "timestamp_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_attestation_id_fkey"
            columns: ["attestation_id"]
            isOneToOne: false
            referencedRelation: "attestations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_signer_certificate_id_fkey"
            columns: ["signer_certificate_id"]
            isOneToOne: false
            referencedRelation: "signing_certificates"
            referencedColumns: ["id"]
          },
        ]
      }
      signing_certificates: {
        Row: {
          certificate_pem: string
          chain_pem: string[] | null
          created_at: string
          created_by: string
          eu_trusted_list_entry: string | null
          fingerprint_sha256: string
          id: string
          issuer_cn: string
          issuer_org: string | null
          key_algorithm: string
          kms_key_id: string
          kms_provider: string
          metadata: Json | null
          not_after: string
          not_before: string
          org_id: string
          qtsp_name: string | null
          serial_number: string
          status: string
          subject_cn: string
          subject_org: string | null
          trust_level: string
          updated_at: string
        }
        Insert: {
          certificate_pem: string
          chain_pem?: string[] | null
          created_at?: string
          created_by: string
          eu_trusted_list_entry?: string | null
          fingerprint_sha256: string
          id?: string
          issuer_cn: string
          issuer_org?: string | null
          key_algorithm: string
          kms_key_id: string
          kms_provider: string
          metadata?: Json | null
          not_after: string
          not_before: string
          org_id: string
          qtsp_name?: string | null
          serial_number: string
          status?: string
          subject_cn: string
          subject_org?: string | null
          trust_level?: string
          updated_at?: string
        }
        Update: {
          certificate_pem?: string
          chain_pem?: string[] | null
          created_at?: string
          created_by?: string
          eu_trusted_list_entry?: string | null
          fingerprint_sha256?: string
          id?: string
          issuer_cn?: string
          issuer_org?: string | null
          key_algorithm?: string
          kms_key_id?: string
          kms_provider?: string
          metadata?: Json | null
          not_after?: string
          not_before?: string
          org_id?: string
          qtsp_name?: string | null
          serial_number?: string
          status?: string
          subject_cn?: string
          subject_org?: string | null
          trust_level?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signing_certificates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      stats_cache: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
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
      timestamp_tokens: {
        Row: {
          cost_usd: number | null
          created_at: string
          hash_algorithm: string
          id: string
          message_imprint: string
          metadata: Json | null
          org_id: string
          provider_ref: string | null
          qtsp_qualified: boolean
          signature_id: string | null
          token_type: string
          tsa_cert_fingerprint: string
          tsa_name: string
          tsa_url: string
          tst_data: string
          tst_gen_time: string
          tst_serial: string
          verification_status: string | null
          verified_at: string | null
        }
        Insert: {
          cost_usd?: number | null
          created_at?: string
          hash_algorithm?: string
          id?: string
          message_imprint: string
          metadata?: Json | null
          org_id: string
          provider_ref?: string | null
          qtsp_qualified?: boolean
          signature_id?: string | null
          token_type?: string
          tsa_cert_fingerprint: string
          tsa_name: string
          tsa_url: string
          tst_data: string
          tst_gen_time: string
          tst_serial: string
          verification_status?: string | null
          verified_at?: string | null
        }
        Update: {
          cost_usd?: number | null
          created_at?: string
          hash_algorithm?: string
          id?: string
          message_imprint?: string
          metadata?: Json | null
          org_id?: string
          provider_ref?: string | null
          qtsp_qualified?: boolean
          signature_id?: string | null
          token_type?: string
          tsa_cert_fingerprint?: string
          tsa_name?: string
          tsa_url?: string
          tst_data?: string
          tst_gen_time?: string
          tst_serial?: string
          verification_status?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "timestamp_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timestamp_tokens_signature_id_fkey"
            columns: ["signature_id"]
            isOneToOne: false
            referencedRelation: "signatures"
            referencedColumns: ["id"]
          },
        ]
      }
      treasury_cache: {
        Row: {
          balance_confirmed_sats: number
          balance_unconfirmed_sats: number
          block_height: number | null
          btc_price_usd: number | null
          error: string | null
          fee_economy: number | null
          fee_fastest: number | null
          fee_half_hour: number | null
          fee_hour: number | null
          fee_minimum: number | null
          id: number
          last_24h_count: number
          last_secured_at: string | null
          network_name: string | null
          total_pending: number
          total_secured: number
          updated_at: string
          utxo_count: number
        }
        Insert: {
          balance_confirmed_sats?: number
          balance_unconfirmed_sats?: number
          block_height?: number | null
          btc_price_usd?: number | null
          error?: string | null
          fee_economy?: number | null
          fee_fastest?: number | null
          fee_half_hour?: number | null
          fee_hour?: number | null
          fee_minimum?: number | null
          id?: number
          last_24h_count?: number
          last_secured_at?: string | null
          network_name?: string | null
          total_pending?: number
          total_secured?: number
          updated_at?: string
          utxo_count?: number
        }
        Update: {
          balance_confirmed_sats?: number
          balance_unconfirmed_sats?: number
          block_height?: number | null
          btc_price_usd?: number | null
          error?: string | null
          fee_economy?: number | null
          fee_fastest?: number | null
          fee_half_hour?: number | null
          fee_hour?: number | null
          fee_minimum?: number | null
          id?: number
          last_24h_count?: number
          last_secured_at?: string | null
          network_name?: string | null
          total_pending?: number
          total_secured?: number
          updated_at?: string
          utxo_count?: number
        }
        Relationships: []
      }
      unified_credits: {
        Row: {
          billing_cycle_start: string
          carry_over: number
          created_at: string
          id: string
          monthly_allocation: number
          org_id: string | null
          updated_at: string
          used_this_month: number
          user_id: string | null
        }
        Insert: {
          billing_cycle_start?: string
          carry_over?: number
          created_at?: string
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          updated_at?: string
          used_this_month?: number
          user_id?: string | null
        }
        Update: {
          billing_cycle_start?: string
          carry_over?: number
          created_at?: string
          id?: string
          monthly_allocation?: number
          org_id?: string | null
          updated_at?: string
          used_this_month?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "unified_credits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      webhook_dead_letter_queue: {
        Row: {
          created_at: string
          endpoint_id: string
          endpoint_url: string
          error_message: string
          event_id: string
          event_type: string
          failed_at: string
          id: string
          last_attempt: number
          org_id: string
          payload: Json
          resolved: boolean
          resolved_at: string | null
        }
        Insert: {
          created_at?: string
          endpoint_id: string
          endpoint_url: string
          error_message: string
          event_id: string
          event_type: string
          failed_at?: string
          id?: string
          last_attempt?: number
          org_id: string
          payload: Json
          resolved?: boolean
          resolved_at?: string | null
        }
        Update: {
          created_at?: string
          endpoint_id?: string
          endpoint_url?: string
          error_message?: string
          event_id?: string
          event_type?: string
          failed_at?: string
          id?: string
          last_attempt?: number
          org_id?: string
          payload?: Json
          resolved?: boolean
          resolved_at?: string | null
        }
        Relationships: []
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
      x402_payments: {
        Row: {
          amount_usd: number
          created_at: string
          facilitator_url: string
          id: string
          network: string
          payee_address: string
          payer_address: string
          raw_response: Json | null
          token: string
          tx_hash: string
          verification_request_id: string | null
        }
        Insert: {
          amount_usd: number
          created_at?: string
          facilitator_url: string
          id?: string
          network: string
          payee_address: string
          payer_address: string
          raw_response?: Json | null
          token?: string
          tx_hash: string
          verification_request_id?: string | null
        }
        Update: {
          amount_usd?: number
          created_at?: string
          facilitator_url?: string
          id?: string
          network?: string
          payee_address?: string
          payer_address?: string
          raw_response?: Json | null
          token?: string
          tx_hash?: string
          verification_request_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      hypopg_hidden_indexes: {
        Row: {
          am_name: unknown
          index_name: unknown
          indexrelid: unknown
          is_hypo: boolean | null
          schema_name: unknown
          table_name: unknown
        }
        Relationships: []
      }
      hypopg_list_indexes: {
        Row: {
          am_name: unknown
          index_name: string | null
          indexrelid: unknown
          schema_name: unknown
          table_name: unknown
        }
        Relationships: []
      }
      mv_anchor_status_counts: {
        Row: {
          cnt: number | null
          status: string | null
        }
        Relationships: []
      }
      mv_public_records_source_counts: {
        Row: {
          cnt: number | null
          source: string | null
        }
        Relationships: []
      }
      payment_ledger: {
        Row: {
          amount_usd: number | null
          currency: string | null
          details: Json | null
          event_at: string | null
          event_type: string | null
          external_id: string | null
          ledger_id: string | null
          org_id: string | null
          source: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      activate_user: {
        Args: { p_password: string; p_token: string }
        Returns: Json
      }
      admin_change_user_role: {
        Args: { p_new_role: string; p_user_id: string }
        Returns: undefined
      }
      admin_set_platform_admin: {
        Args: { p_is_admin: boolean; p_user_id: string }
        Returns: undefined
      }
      admin_set_user_org: {
        Args: { p_org_id: string; p_org_role?: string; p_user_id: string }
        Returns: undefined
      }
      allocate_monthly_credits: { Args: never; Returns: number }
      anonymize_user_data: { Args: { p_user_id: string }; Returns: Json }
      archive_old_audit_events: {
        Args: { retention_days?: number }
        Returns: number
      }
      batch_insert_anchors: { Args: { p_anchors: Json }; Returns: Json }
      bulk_create_anchors: { Args: { anchors_data: Json }; Returns: Json }
      bulk_promote_confirmed: { Args: { p_tx_ids: string[] }; Returns: number }
      check_ai_credits: {
        Args: { p_org_id?: string; p_user_id?: string }
        Returns: {
          has_credits: boolean
          monthly_allocation: number
          remaining: number
          used_this_month: number
        }[]
      }
      check_anchor_quota: { Args: never; Returns: number }
      check_orphaned_anchors: {
        Args: never
        Returns: {
          anchor_id: string
          created_at: string
          fingerprint: string
          status: string
          user_id: string
        }[]
      }
      check_unified_credits: {
        Args: { p_org_id?: string; p_user_id?: string }
        Returns: {
          has_credits: boolean
          monthly_allocation: number
          remaining: number
          used_this_month: number
        }[]
      }
      claim_anchoring_job: {
        Args: { p_lock_duration_seconds?: number; p_worker_id: string }
        Returns: string
      }
      claim_pending_anchors: {
        Args: {
          p_exclude_pipeline?: boolean
          p_limit?: number
          p_worker_id?: string
        }
        Returns: {
          credential_type: string
          fingerprint: string
          id: string
          metadata: Json
          org_id: string
          public_id: string
          user_id: string
        }[]
      }
      cleanup_expired_data: { Args: never; Returns: Json }
      cleanup_orphaned_anchors: { Args: never; Returns: number }
      complete_anchoring_job: {
        Args: { p_error?: string; p_job_id: string; p_success: boolean }
        Returns: boolean
      }
      count_public_records_by_source: {
        Args: never
        Returns: {
          count: number
          source: string
        }[]
      }
      create_pending_recipient: {
        Args: { p_email: string; p_full_name?: string; p_org_id: string }
        Returns: string
      }
      create_webhook_endpoint: {
        Args: { p_events: string[]; p_url: string }
        Returns: Json
      }
      deduct_ai_credits: {
        Args: { p_amount?: number; p_org_id?: string; p_user_id?: string }
        Returns: boolean
      }
      deduct_credit: {
        Args: {
          p_amount?: number
          p_reason?: string
          p_reference_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      deduct_unified_credits: {
        Args: { p_amount?: number; p_org_id?: string; p_user_id?: string }
        Returns: boolean
      }
      delete_own_account: { Args: never; Returns: Json }
      delete_webhook_endpoint: {
        Args: { p_endpoint_id: string }
        Returns: undefined
      }
      generate_anchor_public_id: {
        Args: { category?: string }
        Returns: string
      }
      generate_attestation_public_id: {
        Args: { p_attestation_type: string; p_org_prefix: string }
        Returns: string
      }
      generate_public_id: { Args: never; Returns: string }
      get_anchor_status_counts: { Args: never; Returns: Json }
      get_anchor_status_counts_fast: { Args: never; Returns: Json }
      get_anchor_tx_stats: { Args: never; Returns: Json }
      get_anchor_type_counts: {
        Args: never
        Returns: {
          count: number
          credential_type: string
          status: string
        }[]
      }
      get_caller_role: { Args: never; Returns: string }
      get_distinct_record_types: {
        Args: never
        Returns: {
          record_type: string
        }[]
      }
      get_edgar_shard_counts: { Args: never; Returns: Json }
      get_extraction_accuracy: {
        Args: { p_credential_type?: string; p_days?: number; p_org_id?: string }
        Returns: {
          acceptance_rate: number
          accepted_count: number
          avg_confidence: number
          credential_type: string
          edited_count: number
          field_key: string
          rejected_count: number
          total_suggestions: number
        }[]
      }
      get_flag: {
        Args: { p_default?: boolean; p_flag_key: string }
        Returns: boolean
      }
      get_my_credentials: {
        Args: never
        Returns: {
          anchor_id: string
          claimed_at: string
          created_at: string
          credential_type: string
          expires_at: string
          filename: string
          fingerprint: string
          issued_at: string
          metadata: Json
          org_id: string
          org_name: string
          public_id: string
          recipient_created_at: string
          recipient_id: string
          status: string
        }[]
      }
      get_org_anchor_stats: { Args: { p_org_id: string }; Returns: Json }
      get_payment_ledger: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          amount_usd: number | null
          currency: string | null
          details: Json | null
          event_at: string | null
          event_type: string | null
          external_id: string | null
          ledger_id: string | null
          org_id: string | null
          source: string | null
          user_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "payment_ledger"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_pending_user_anchors: {
        Args: { p_limit?: number }
        Returns: {
          id: string
        }[]
      }
      get_pipeline_stats: { Args: never; Returns: Json }
      get_public_anchor: { Args: { p_public_id: string }; Returns: Json }
      get_public_issuer_registry: {
        Args: { p_limit?: number; p_offset?: number; p_org_id: string }
        Returns: Json
      }
      get_public_org_profile: { Args: { p_org_id: string }; Returns: Json }
      get_public_org_profiles: {
        Args: { p_limit?: number; p_offset?: number; p_org_id?: string }
        Returns: {
          created_at: string
          description: string
          display_name: string
          domain: string
          founded_date: string
          id: string
          industry_tag: string
          linkedin_url: string
          location: string
          logo_url: string
          org_type: string
          twitter_url: string
          verification_status: string
          website_url: string
        }[]
      }
      get_public_records_page: {
        Args: {
          p_anchor_status?: string
          p_page?: number
          p_page_size?: number
          p_record_type?: string
          p_source?: string
        }
        Returns: Json
      }
      get_public_records_stats: { Args: never; Returns: Json }
      get_public_template: {
        Args: { p_credential_type: string; p_org_id: string }
        Returns: Json
      }
      get_source_date_range: {
        Args: { p_date_field?: string; p_source: string }
        Returns: Json
      }
      get_treasury_stats: { Args: never; Returns: Json }
      get_unembedded_public_records: {
        Args: { p_limit?: number }
        Returns: {
          id: string
          metadata: Json
          record_type: string
          source: string
          title: string
        }[]
      }
      get_user_anchor_stats: { Args: { p_user_id: string }; Returns: Json }
      get_user_credits: { Args: { p_user_id?: string }; Returns: Json }
      get_user_org_id: { Args: never; Returns: string }
      get_user_org_ids: { Args: never; Returns: string[] }
      hypopg: { Args: never; Returns: Record<string, unknown>[] }
      hypopg_create_index: {
        Args: { sql_order: string }
        Returns: Record<string, unknown>[]
      }
      hypopg_drop_index: { Args: { indexid: unknown }; Returns: boolean }
      hypopg_get_indexdef: { Args: { indexid: unknown }; Returns: string }
      hypopg_hidden_indexes: {
        Args: never
        Returns: {
          indexid: unknown
        }[]
      }
      hypopg_hide_index: { Args: { indexid: unknown }; Returns: boolean }
      hypopg_relation_size: { Args: { indexid: unknown }; Returns: number }
      hypopg_reset: { Args: never; Returns: undefined }
      hypopg_reset_index: { Args: never; Returns: undefined }
      hypopg_unhide_all_indexes: { Args: never; Returns: undefined }
      hypopg_unhide_index: { Args: { indexid: unknown }; Returns: boolean }
      index_advisor: {
        Args: { query: string }
        Returns: {
          errors: string[]
          index_statements: string[]
          startup_cost_after: Json
          startup_cost_before: Json
          total_cost_after: Json
          total_cost_before: Json
        }[]
      }
      invite_member:
        | {
            Args: {
              invitee_email: string
              invitee_role: Database["public"]["Enums"]["user_role"]
              target_org_id: string
            }
            Returns: string
          }
        | {
            Args: {
              invitee_email: string
              invitee_role: string
              inviter_user_id: string
              target_org_id: string
            }
            Returns: string
          }
      is_current_user_platform_admin: { Args: never; Returns: boolean }
      is_org_admin: { Args: never; Returns: boolean }
      is_org_admin_of: { Args: { target_org_id: string }; Returns: boolean }
      is_user_verified: { Args: { p_user_id: string }; Returns: boolean }
      join_org_by_domain: { Args: { p_org_id: string }; Returns: Json }
      link_recipient_on_signup: {
        Args: { p_email_hash: string; p_user_id: string }
        Returns: number
      }
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
      lookup_org_by_email_domain: { Args: { p_email: string }; Returns: Json }
      recover_stuck_broadcasts: {
        Args: { p_stale_minutes?: number }
        Returns: {
          anchor_fingerprint: string
          anchor_id: string
          claimed_by: string
          stuck_since: string
        }[]
      }
      refresh_stats_cache: { Args: never; Returns: undefined }
      refresh_stats_materialized_views: { Args: never; Returns: undefined }
      release_advisory_lock: { Args: { lock_id: number }; Returns: boolean }
      revoke_anchor:
        | { Args: { anchor_id: string }; Returns: undefined }
        | { Args: { anchor_id: string; reason?: string }; Returns: undefined }
      sanitize_metadata_for_public: {
        Args: { p_metadata: Json }
        Returns: Json
      }
      search_credential_embeddings: {
        Args: {
          p_match_count?: number
          p_match_threshold?: number
          p_org_id: string
          p_query_embedding: string
        }
        Returns: {
          anchor_id: string
          similarity: number
        }[]
      }
      search_issuer_ground_truth: {
        Args: { p_issuer_name: string }
        Returns: {
          id: string
          match_strategy: string
          name: string
        }[]
      }
      search_organizations_public: {
        Args: { p_query: string }
        Returns: {
          display_name: string
          domain: string
          id: string
        }[]
      }
      search_public_credential_embeddings: {
        Args: {
          p_match_count?: number
          p_match_threshold?: number
          p_query_embedding: string
        }
        Returns: {
          anchor_timestamp: string
          credential_type: string
          expiry_date: string
          issued_date: string
          issuer_name: string
          public_id: string
          similarity: number
          status: string
        }[]
      }
      search_public_credentials: {
        Args: { p_limit?: number; p_query: string }
        Returns: Json[]
      }
      search_public_issuers: {
        Args: { p_limit?: number; p_offset?: number; p_query: string }
        Returns: {
          credential_count: number
          display_name: string
          id: string
          legal_name: string
          public_id: string
          verified: boolean
        }[]
      }
      search_public_record_embeddings: {
        Args: {
          p_match_count?: number
          p_match_threshold?: number
          p_query_embedding: string
        }
        Returns: {
          public_record_id: string
          similarity: number
        }[]
      }
      set_onboarding_plan: { Args: { p_tier: string }; Returns: Json }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      submit_batch_anchors: {
        Args: {
          p_anchor_ids: string[]
          p_batch_id?: string
          p_block_height?: number
          p_block_timestamp?: string
          p_merkle_root?: string
          p_tx_id: string
        }
        Returns: number
      }
      try_advisory_lock: { Args: { lock_id: number }; Returns: boolean }
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
      ai_report_status: "QUEUED" | "GENERATING" | "COMPLETE" | "FAILED"
      anchor_status:
        | "PENDING"
        | "SECURED"
        | "REVOKED"
        | "EXPIRED"
        | "SUBMITTED"
        | "BROADCASTING"
      api_key_rate_limit_tier: "free" | "paid" | "custom"
      attestation_status:
        | "DRAFT"
        | "PENDING"
        | "ACTIVE"
        | "REVOKED"
        | "EXPIRED"
        | "CHALLENGED"
      attestation_type:
        | "VERIFICATION"
        | "ENDORSEMENT"
        | "AUDIT"
        | "APPROVAL"
        | "WITNESS"
        | "COMPLIANCE"
        | "SUPPLY_CHAIN"
        | "IDENTITY"
        | "CUSTOM"
      attester_type:
        | "INSTITUTION"
        | "CORPORATION"
        | "INDIVIDUAL"
        | "REGULATORY"
        | "THIRD_PARTY"
      credential_type:
        | "DEGREE"
        | "LICENSE"
        | "CERTIFICATE"
        | "TRANSCRIPT"
        | "PROFESSIONAL"
        | "OTHER"
        | "CLE"
        | "SEC_FILING"
        | "PATENT"
        | "REGULATION"
        | "PUBLICATION"
        | "BADGE"
        | "ATTESTATION"
        | "FINANCIAL"
        | "LEGAL"
        | "INSURANCE"
        | "CHARITY"
        | "FINANCIAL_ADVISOR"
        | "BUSINESS_ENTITY"
        | "RESUME"
        | "MEDICAL"
        | "MILITARY"
        | "IDENTITY"
      credit_transaction_type:
        | "ALLOCATION"
        | "PURCHASE"
        | "DEDUCTION"
        | "EXPIRY"
        | "REFUND"
      grc_platform: "vanta" | "drata" | "anecdotes"
      grc_sync_status: "pending" | "syncing" | "success" | "failed"
      integrity_level: "HIGH" | "MEDIUM" | "LOW" | "FLAGGED"
      job_status: "pending" | "processing" | "completed" | "failed"
      org_member_role: "owner" | "admin" | "member" | "compliance_officer"
      profile_status: "ACTIVE" | "PENDING_ACTIVATION" | "DEACTIVATED"
      report_status: "pending" | "generating" | "completed" | "failed"
      report_type:
        | "anchor_summary"
        | "compliance_audit"
        | "activity_log"
        | "billing_history"
      review_action: "APPROVE" | "INVESTIGATE" | "ESCALATE" | "DISMISS"
      review_status:
        | "PENDING"
        | "APPROVED"
        | "INVESTIGATING"
        | "ESCALATED"
        | "DISMISSED"
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
      ai_report_status: ["QUEUED", "GENERATING", "COMPLETE", "FAILED"],
      anchor_status: [
        "PENDING",
        "SECURED",
        "REVOKED",
        "EXPIRED",
        "SUBMITTED",
        "BROADCASTING",
      ],
      api_key_rate_limit_tier: ["free", "paid", "custom"],
      attestation_status: [
        "DRAFT",
        "PENDING",
        "ACTIVE",
        "REVOKED",
        "EXPIRED",
        "CHALLENGED",
      ],
      attestation_type: [
        "VERIFICATION",
        "ENDORSEMENT",
        "AUDIT",
        "APPROVAL",
        "WITNESS",
        "COMPLIANCE",
        "SUPPLY_CHAIN",
        "IDENTITY",
        "CUSTOM",
      ],
      attester_type: [
        "INSTITUTION",
        "CORPORATION",
        "INDIVIDUAL",
        "REGULATORY",
        "THIRD_PARTY",
      ],
      credential_type: [
        "DEGREE",
        "LICENSE",
        "CERTIFICATE",
        "TRANSCRIPT",
        "PROFESSIONAL",
        "OTHER",
        "CLE",
        "SEC_FILING",
        "PATENT",
        "REGULATION",
        "PUBLICATION",
        "BADGE",
        "ATTESTATION",
        "FINANCIAL",
        "LEGAL",
        "INSURANCE",
        "CHARITY",
        "FINANCIAL_ADVISOR",
        "BUSINESS_ENTITY",
        "RESUME",
        "MEDICAL",
        "MILITARY",
        "IDENTITY",
      ],
      credit_transaction_type: [
        "ALLOCATION",
        "PURCHASE",
        "DEDUCTION",
        "EXPIRY",
        "REFUND",
      ],
      grc_platform: ["vanta", "drata", "anecdotes"],
      grc_sync_status: ["pending", "syncing", "success", "failed"],
      integrity_level: ["HIGH", "MEDIUM", "LOW", "FLAGGED"],
      job_status: ["pending", "processing", "completed", "failed"],
      org_member_role: ["owner", "admin", "member", "compliance_officer"],
      profile_status: ["ACTIVE", "PENDING_ACTIVATION", "DEACTIVATED"],
      report_status: ["pending", "generating", "completed", "failed"],
      report_type: [
        "anchor_summary",
        "compliance_audit",
        "activity_log",
        "billing_history",
      ],
      review_action: ["APPROVE", "INVESTIGATE", "ESCALATE", "DISMISS"],
      review_status: [
        "PENDING",
        "APPROVED",
        "INVESTIGATING",
        "ESCALATED",
        "DISMISSED",
      ],
      user_role: ["INDIVIDUAL", "ORG_ADMIN", "ORG_MEMBER"],
    },
  },
} as const
