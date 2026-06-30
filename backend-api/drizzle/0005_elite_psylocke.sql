CREATE TABLE "permission_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"perm_code" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"revoked_at" bigint,
	"revoked_by_user_id" uuid,
	"revoke_note" text
);
--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_perm_code_permissions_code_fk" FOREIGN KEY ("perm_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_delegations_to_user_perm_uq" ON "permission_delegations" USING btree ("to_user_id","perm_code","ends_at");