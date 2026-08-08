BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE workspace_role AS ENUM ('owner', 'member');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE source_kind AS ENUM ('website', 'reddit', 'mock_reddit', 'external_provider', 'user_supplied');
CREATE TYPE conversation_kind AS ENUM ('post', 'comment');
CREATE TYPE recommended_action AS ENUM ('reply_helpfully', 'monitor', 'learn', 'avoid');
CREATE TYPE community_risk AS ENUM ('low', 'medium', 'high', 'unknown');
CREATE TYPE opportunity_status AS ENUM ('new', 'saved', 'dismissed', 'replied');
CREATE TYPE insight_kind AS ENUM ('customer_demand', 'customer_problem', 'buyer_intent', 'competitor_gap', 'search_ai_visibility');
CREATE TYPE reply_status AS ENUM ('draft', 'edited', 'copied', 'published');
CREATE TYPE access_product AS ENUM ('market_scan', 'seven_day_pass', 'core');
CREATE TYPE access_status AS ENUM ('active', 'expired', 'revoked');
CREATE TYPE billing_status AS ENUM ('pending', 'active', 'past_due', 'canceled', 'expired', 'refunded');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'retrying', 'succeeded', 'failed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  name varchar(160),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uidx ON users (email);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(64) NOT NULL,
  provider_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_accounts_provider_subject_uidx ON auth_accounts (provider, provider_subject);
CREATE INDEX auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_sessions_token_hash_uidx ON auth_sessions (token_hash);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_url text NOT NULL,
  canonical_domain varchar(253) NOT NULL,
  display_name varchar(200),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX businesses_workspace_domain_uidx ON businesses (workspace_id, canonical_domain);
CREATE INDEX businesses_workspace_idx ON businesses (workspace_id);

CREATE TABLE analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status run_status NOT NULL DEFAULT 'queued',
  stage varchar(80) NOT NULL DEFAULT 'queued',
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  error_code varchar(80),
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_runs_business_created_idx ON analysis_runs (business_id, created_at DESC);

CREATE TABLE source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind source_kind NOT NULL,
  provider varchar(100) NOT NULL,
  provider_external_id varchar(255),
  canonical_url text,
  title text,
  excerpt text,
  content_hash varchar(128) NOT NULL,
  is_mock boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX source_documents_provider_external_uidx ON source_documents (provider, provider_external_id) WHERE provider_external_id IS NOT NULL;
CREATE INDEX source_documents_business_kind_idx ON source_documents (business_id, kind);
CREATE INDEX source_documents_content_hash_idx ON source_documents (business_id, content_hash);

CREATE TABLE website_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid NOT NULL UNIQUE REFERENCES source_documents(id) ON DELETE CASCADE,
  final_url text NOT NULL,
  title text NOT NULL,
  description text,
  extracted_text text NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  category varchar(80) NOT NULL,
  label varchar(200) NOT NULL,
  value jsonb NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_facts_business_category_idx ON profile_facts (business_id, category);

CREATE TABLE profile_fact_sources (
  profile_fact_id uuid NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_fact_id, source_document_id)
);

CREATE TABLE reddit_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid NOT NULL UNIQUE REFERENCES source_documents(id) ON DELETE RESTRICT,
  provider varchar(100) NOT NULL,
  external_id varchar(255) NOT NULL,
  kind conversation_kind NOT NULL,
  parent_external_id varchar(255),
  subreddit varchar(100) NOT NULL,
  title text,
  body text NOT NULL,
  author varchar(100),
  permalink text,
  reddit_score integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  posted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES reddit_conversations(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  rank_score numeric(6,5) NOT NULL CHECK (rank_score BETWEEN 0 AND 1),
  relevance numeric(5,4) NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  buyer_intent numeric(5,4) NOT NULL CHECK (buyer_intent BETWEEN 0 AND 1),
  customer_problem numeric(5,4) NOT NULL CHECK (customer_problem BETWEEN 0 AND 1),
  competitor_complaint numeric(5,4) NOT NULL CHECK (competitor_complaint BETWEEN 0 AND 1),
  semantic_similarity numeric(5,4) NOT NULL CHECK (semantic_similarity BETWEEN 0 AND 1),
  recommended_action recommended_action NOT NULL,
  community_risk community_risk NOT NULL,
  classification jsonb NOT NULL,
  status opportunity_status NOT NULL DEFAULT 'new',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, conversation_id)
);
CREATE INDEX opportunities_business_rank_idx ON opportunities (business_id, rank_score DESC);

CREATE TABLE opportunity_sources (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (opportunity_id, source_document_id)
);

CREATE TABLE insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  kind insight_kind NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  implication text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insights_business_created_idx ON insights (business_id, created_at DESC);

CREATE TABLE insight_sources (
  insight_id uuid NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (insight_id, source_document_id)
);

CREATE TABLE competitor_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  competitor_name varchar(200) NOT NULL,
  signal text NOT NULL,
  customer_impact text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX competitor_signals_business_idx ON competitor_signals (business_id);

CREATE TABLE competitor_signal_sources (
  competitor_signal_id uuid NOT NULL REFERENCES competitor_signals(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (competitor_signal_id, source_document_id)
);

CREATE TABLE suggested_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  body text NOT NULL,
  status reply_status NOT NULL DEFAULT 'draft',
  disclosed_connection boolean NOT NULL DEFAULT false,
  generated_by_run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  edited_at timestamptz,
  copied_at timestamptz,
  published_at timestamptz,
  published_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, version)
);

CREATE TABLE reply_sources (
  reply_id uuid NOT NULL REFERENCES suggested_replies(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (reply_id, source_document_id)
);

CREATE TABLE semantic_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_document_id uuid REFERENCES source_documents(id) ON DELETE CASCADE,
  purpose varchar(80) NOT NULL,
  model varchar(120) NOT NULL,
  content_hash varchar(128) NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, purpose, model, content_hash)
);
CREATE INDEX semantic_embeddings_cosine_idx ON semantic_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  run_id uuid REFERENCES analysis_runs(id) ON DELETE SET NULL,
  provider varchar(80) NOT NULL,
  model varchar(120) NOT NULL,
  operation varchar(80) NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_input_tokens >= 0),
  estimated_cost_usd numeric(14,8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  provider_request_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_workspace_created_idx ON ai_usage (workspace_id, created_at DESC);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  type varchar(100) NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key varchar(255),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(160),
  last_error text,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX background_jobs_dedupe_uidx ON background_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX background_jobs_poll_idx ON background_jobs (status, run_at);

CREATE TABLE stripe_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_customer_id varchar(255) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product access_product NOT NULL,
  status billing_status NOT NULL DEFAULT 'pending',
  stripe_checkout_session_id varchar(255) UNIQUE,
  stripe_payment_intent_id varchar(255),
  stripe_subscription_id varchar(255) UNIQUE,
  amount_subtotal integer,
  amount_tax integer,
  amount_total integer,
  currency varchar(3),
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_purchases_business_idx ON billing_purchases (business_id);

CREATE TABLE stripe_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id varchar(255) NOT NULL UNIQUE,
  type varchar(120) NOT NULL,
  livemode boolean NOT NULL,
  payload jsonb NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  purchase_id uuid REFERENCES billing_purchases(id) ON DELETE SET NULL,
  product access_product NOT NULL,
  status access_status NOT NULL DEFAULT 'active',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  verified_stripe_event_id uuid REFERENCES stripe_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (product = 'market_scan' OR verified_stripe_event_id IS NOT NULL),
  CHECK (product <> 'seven_day_pass' OR ends_at IS NOT NULL)
);
CREATE INDEX access_grants_business_status_idx ON access_grants (business_id, status, ends_at);

CREATE TABLE tracked_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reply_id uuid REFERENCES suggested_replies(id) ON DELETE SET NULL,
  slug varchar(80) NOT NULL UNIQUE,
  destination_url text NOT NULL,
  click_count integer NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracked_links_business_idx ON tracked_links (business_id);

CREATE TABLE conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tracked_link_id uuid REFERENCES tracked_links(id) ON DELETE SET NULL,
  reply_id uuid REFERENCES suggested_replies(id) ON DELETE SET NULL,
  kind varchar(80) NOT NULL,
  external_reference varchar(255),
  value_cents integer,
  currency varchar(3),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversions_business_occurred_idx ON conversions (business_id, occurred_at DESC);

COMMIT;
