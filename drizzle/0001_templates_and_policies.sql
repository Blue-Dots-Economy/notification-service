CREATE TABLE "notification_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"domain" text,
	"event_type" text,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mode" text NOT NULL,
	"channels" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "policy_status_ck" CHECK ("notification_policy"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "policy_mode_ck" CHECK ("notification_policy"."mode" in ('first_available', 'all'))
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"locale" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body_html" text,
	"body_text" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"provider_template_id" text,
	"sender_id" text,
	"dlt_entity_id" text,
	"dlt_header_id" text,
	"dlt_tag_id" text,
	"approval_ref" text,
	"default_deadline_s" integer,
	"created_by" text NOT NULL,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "template_status_ck" CHECK ("template"."status" in ('draft', 'active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_version_uq" ON "notification_policy" USING btree ("network",coalesce("domain", ''),coalesce("event_type", ''),"version");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_active_uq" ON "notification_policy" USING btree ("network",coalesce("domain", ''),coalesce("event_type", '')) WHERE "notification_policy"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "template_version_uq" ON "template" USING btree ("network","channel","template_key","locale","version");--> statement-breakpoint
CREATE UNIQUE INDEX "template_active_uq" ON "template" USING btree ("network","channel","template_key","locale") WHERE "template"."status" = 'active';