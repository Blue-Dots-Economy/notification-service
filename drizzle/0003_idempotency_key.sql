CREATE TABLE "idempotency_key" (
	"network" text NOT NULL,
	"key" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_network_key_pk" PRIMARY KEY("network","key")
);
