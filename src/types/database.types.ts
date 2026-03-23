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
          provider: string
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
          provider: string
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
          provider?: string
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
          created_at: string
          display_name: string
          domain: string | null
          id: string
          legal_name: string
          org_prefix: string | null
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
          org_prefix?: string | null
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
          org_prefix?: string | null
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
          activation_token: string | null
          activation_token_expires_at: string | null
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
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
          status: Database["public"]["Enums"]["profile_status"] | null
          subscription_tier: string
          updated_at: string
        }
        Insert: {
          activation_token?: string | null
          activation_token_expires_at?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
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
          status?: Database["public"]["Enums"]["profile_status"] | null
          subscription_tier?: string
          updated_at?: string
        }
        Update: {
          activation_token?: string | null
          activation_token_expires_at?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
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
      [_ in never]: never
    }
    Functions: {
      activate_user: {
        Args: { p_password: string; p_token: string }
        Returns: Json
      }
      allocate_monthly_credits: { Args: never; Returns: number }
      anonymize_user_data: { Args: { p_user_id: string }; Returns: Json }
      bulk_create_anchors: { Args: { anchors_data: Json }; Returns: Json }
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
      claim_anchoring_job: {
        Args: { p_lock_duration_seconds?: number; p_worker_id: string }
        Returns: string
      }
      cleanup_expired_data: { Args: never; Returns: Json }
      complete_anchoring_job: {
        Args: { p_error?: string; p_job_id: string; p_success: boolean }
        Returns: boolean
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
      delete_own_account: { Args: never; Returns: Json }
      delete_webhook_endpoint: {
        Args: { p_endpoint_id: string }
        Returns: undefined
      }
      generate_attestation_public_id: {
        Args: { p_attestation_type: string; p_org_prefix: string }
        Returns: string
      }
      generate_public_id: { Args: never; Returns: string }
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
      get_public_anchor: { Args: { p_public_id: string }; Returns: Json }
      get_public_issuer_registry: {
        Args: { p_limit?: number; p_offset?: number; p_org_id: string }
        Returns: Json
      }
      get_public_records_stats: { Args: never; Returns: Json }
      get_public_template: {
        Args: { p_credential_type: string; p_org_id: string }
        Returns: Json
      }
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
      get_user_credits: { Args: { p_user_id?: string }; Returns: Json }
      get_user_org_id: { Args: never; Returns: string }
      get_user_org_ids: { Args: never; Returns: string[] }
      invite_member: {
        Args: {
          invitee_email: string
          invitee_role: Database["public"]["Enums"]["user_role"]
          target_org_id: string
        }
        Returns: string
      }
      is_org_admin: { Args: never; Returns: boolean }
      is_org_admin_of: { Args: { target_org_id: string }; Returns: boolean }
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
        Args: { p_query: string }
        Returns: {
          credential_count: number
          org_domain: string
          org_id: string
          org_name: string
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
      ai_report_status: "QUEUED" | "GENERATING" | "COMPLETE" | "FAILED"
      anchor_status: "PENDING" | "SECURED" | "REVOKED" | "EXPIRED" | "SUBMITTED"
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
      credit_transaction_type:
        | "ALLOCATION"
        | "PURCHASE"
        | "DEDUCTION"
        | "EXPIRY"
        | "REFUND"
      integrity_level: "HIGH" | "MEDIUM" | "LOW" | "FLAGGED"
      job_status: "pending" | "processing" | "completed" | "failed"
      org_member_role: "owner" | "admin" | "member"
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
      anchor_status: ["PENDING", "SECURED", "REVOKED", "EXPIRED", "SUBMITTED"],
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
      ],
      credit_transaction_type: [
        "ALLOCATION",
        "PURCHASE",
        "DEDUCTION",
        "EXPIRY",
        "REFUND",
      ],
      integrity_level: ["HIGH", "MEDIUM", "LOW", "FLAGGED"],
      job_status: ["pending", "processing", "completed", "failed"],
      org_member_role: ["owner", "admin", "member"],
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
