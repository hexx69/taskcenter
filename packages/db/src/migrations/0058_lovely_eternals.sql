ALTER TABLE "memory_local_records" ADD COLUMN "review_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "reviewed_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "reviewed_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "review_note" text;--> statement-breakpoint
CREATE INDEX "memory_local_records_company_review_created_idx" ON "memory_local_records" USING btree ("company_id","review_state","created_at");