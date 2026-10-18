-- Production schema-only graph fixture, 2026-10-17. External foreign keys omitted; no customer rows.
CREATE TABLE public.projects(id uuid primary key, owner uuid not null);
CREATE TABLE public.bv2_dependency_edges (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"owner" uuid NOT NULL,
"project_id" uuid NOT NULL,
"revision_id" uuid NOT NULL,
"from_path" text NOT NULL,
"to_path" text,
"specifier" text NOT NULL,
"ordinal" integer NOT NULL,
CONSTRAINT "bv2_dependency_edges_ordinal_check" CHECK ((ordinal >= 0)),
CONSTRAINT "bv2_dependency_edges_pkey" PRIMARY KEY (id),
CONSTRAINT "bv2_dependency_edges_revision_ordinal_unique" UNIQUE (revision_id, ordinal)
);
CREATE TABLE public.bv2_file_revisions (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"owner" uuid NOT NULL,
"project_id" uuid NOT NULL,
"path" text NOT NULL,
"content_hash" text NOT NULL,
"size_bytes" integer NOT NULL,
"tokens" integer NOT NULL,
"opaque" boolean DEFAULT false NOT NULL,
"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
"state" text DEFAULT 'building'::text NOT NULL,
"indexer_version" text,
"graph_hash" text,
"symbol_count" integer DEFAULT 0 NOT NULL,
"ref_count" integer DEFAULT 0 NOT NULL,
"edge_count" integer DEFAULT 0 NOT NULL,
"completed_at" timestamp with time zone,
CONSTRAINT "bv2_file_revisions_counts_check" CHECK (((symbol_count >= 0) AND (ref_count >= 0) AND (edge_count >= 0))),
CONSTRAINT "bv2_file_revisions_graph_hash_check" CHECK (((graph_hash IS NULL) OR (graph_hash ~ '^[0-9a-f]{64}$'::text))),
CONSTRAINT "bv2_file_revisions_hash_check" CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
CONSTRAINT "bv2_file_revisions_id_owner_project_path_hash_unique" UNIQUE (id, owner, project_id, path, content_hash),
CONSTRAINT "bv2_file_revisions_id_owner_project_path_unique" UNIQUE (id, owner, project_id, path),
CONSTRAINT "bv2_file_revisions_id_owner_project_unique" UNIQUE (id, owner, project_id),
CONSTRAINT "bv2_file_revisions_owner_project_id_path_content_hash_key" UNIQUE (owner, project_id, path, content_hash),
CONSTRAINT "bv2_file_revisions_pkey" PRIMARY KEY (id),
CONSTRAINT "bv2_file_revisions_ready_check" CHECK ((((state = 'building'::text) AND (completed_at IS NULL)) OR ((state = 'ready'::text) AND (graph_hash IS NOT NULL) AND (indexer_version IS NOT NULL) AND (completed_at IS NOT NULL)))),
CONSTRAINT "bv2_file_revisions_state_check" CHECK ((state = ANY (ARRAY['building'::text, 'ready'::text])))
);
CREATE TABLE public.bv2_symbol_refs (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"owner" uuid NOT NULL,
"project_id" uuid NOT NULL,
"revision_id" uuid NOT NULL,
"from_symbol" uuid NOT NULL,
"ref_name" text NOT NULL,
"resolved_path" text,
"count" integer DEFAULT 1 NOT NULL,
"ordinal" integer NOT NULL,
CONSTRAINT "bv2_symbol_refs_ordinal_check" CHECK ((ordinal >= 0)),
CONSTRAINT "bv2_symbol_refs_pkey" PRIMARY KEY (id),
CONSTRAINT "bv2_symbol_refs_revision_ordinal_unique" UNIQUE (revision_id, ordinal)
);
CREATE TABLE public.bv2_symbols (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"owner" uuid NOT NULL,
"project_id" uuid NOT NULL,
"revision_id" uuid NOT NULL,
"path" text NOT NULL,
"name" text NOT NULL,
"kind" text NOT NULL,
"exported" boolean DEFAULT false NOT NULL,
"is_default" boolean DEFAULT false NOT NULL,
"start_offset" integer NOT NULL,
"end_offset" integer NOT NULL,
"block_hash" text NOT NULL,
"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
"ordinal" integer NOT NULL,
CONSTRAINT "bv2_symbols_id_revision_owner_project_unique" UNIQUE (id, revision_id, owner, project_id),
CONSTRAINT "bv2_symbols_ordinal_check" CHECK ((ordinal >= 0)),
CONSTRAINT "bv2_symbols_pkey" PRIMARY KEY (id),
CONSTRAINT "bv2_symbols_revision_ordinal_unique" UNIQUE (revision_id, ordinal)
);
ALTER TABLE projects ADD UNIQUE(id, owner);
ALTER TABLE bv2_file_revisions ADD FOREIGN KEY(project_id,owner) REFERENCES projects(id,owner) ON DELETE CASCADE;
ALTER TABLE bv2_symbols ADD FOREIGN KEY(revision_id) REFERENCES bv2_file_revisions(id) ON DELETE CASCADE;
ALTER TABLE bv2_symbols ADD FOREIGN KEY(revision_id,owner,project_id,path) REFERENCES bv2_file_revisions(id,owner,project_id,path) ON DELETE CASCADE;
ALTER TABLE bv2_symbol_refs ADD FOREIGN KEY(from_symbol) REFERENCES bv2_symbols(id) ON DELETE CASCADE;
ALTER TABLE bv2_symbol_refs ADD FOREIGN KEY(revision_id) REFERENCES bv2_file_revisions(id) ON DELETE CASCADE;
ALTER TABLE bv2_symbol_refs ADD FOREIGN KEY(revision_id,owner,project_id) REFERENCES bv2_file_revisions(id,owner,project_id) ON DELETE CASCADE;
ALTER TABLE bv2_symbol_refs ADD FOREIGN KEY(from_symbol,revision_id,owner,project_id) REFERENCES bv2_symbols(id,revision_id,owner,project_id) ON DELETE CASCADE;
ALTER TABLE bv2_dependency_edges ADD FOREIGN KEY(revision_id) REFERENCES bv2_file_revisions(id) ON DELETE CASCADE;
ALTER TABLE bv2_dependency_edges ADD FOREIGN KEY(revision_id,owner,project_id,from_path) REFERENCES bv2_file_revisions(id,owner,project_id,path) ON DELETE CASCADE;
