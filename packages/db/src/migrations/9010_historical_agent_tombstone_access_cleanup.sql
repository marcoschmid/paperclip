-- Two historical agents were made immutable before their legacy access rows
-- had passed through the retirement cleanup. Keep this bootstrap narrowly
-- bound to those identities and fail closed if either live row has drifted.
-- The table lock closes both the existing-row update race and the absent-row
-- insert race for the fixed identities until the transactional cleanup commits.
LOCK TABLE "agents" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "agents"
		WHERE (
			"id" = '8d403783-c4e2-4746-adad-7689cd95ae33'::uuid
			AND (
				"company_id" <> '0a7df9a5-299e-4d64-a4d4-0c4c63784425'::uuid
				OR "status" <> 'terminated'
			)
		) OR (
			"id" = 'dcd3cadb-8203-4048-be1e-77701a3a43a0'::uuid
			AND (
				"company_id" <> '0d49d45f-63d7-4dd3-9b1e-90992eb45226'::uuid
				OR "status" <> 'terminated'
			)
		)
	) THEN
		RAISE EXCEPTION 'historical tombstone identity requires terminated status and expected company'
			USING ERRCODE = '23514';
	END IF;
END;
$$;
--> statement-breakpoint
UPDATE "agent_api_keys"
SET "revoked_at" = now()
WHERE "agent_id" IN (
	'8d403783-c4e2-4746-adad-7689cd95ae33'::uuid,
	'dcd3cadb-8203-4048-be1e-77701a3a43a0'::uuid
) AND "revoked_at" IS NULL;
--> statement-breakpoint
DELETE FROM "principal_permission_grants"
WHERE "principal_type" = 'agent'
	AND lower("principal_id") IN (
		'8d403783-c4e2-4746-adad-7689cd95ae33',
		'dcd3cadb-8203-4048-be1e-77701a3a43a0'
	);
--> statement-breakpoint
DELETE FROM "company_memberships"
WHERE "principal_type" = 'agent'
	AND "status" = 'active'
	AND lower("principal_id") IN (
		'8d403783-c4e2-4746-adad-7689cd95ae33',
		'dcd3cadb-8203-4048-be1e-77701a3a43a0'
	);
--> statement-breakpoint
DELETE FROM "agent_memberships"
WHERE "agent_id" IN (
	'8d403783-c4e2-4746-adad-7689cd95ae33'::uuid,
	'dcd3cadb-8203-4048-be1e-77701a3a43a0'::uuid
) AND "state" <> 'left';
--> statement-breakpoint
DELETE FROM "company_secret_bindings"
WHERE "target_type" = 'agent'
	AND lower("target_id") IN (
		'8d403783-c4e2-4746-adad-7689cd95ae33',
		'dcd3cadb-8203-4048-be1e-77701a3a43a0'
	);
--> statement-breakpoint
DELETE FROM "user_secret_declarations"
WHERE "target_type" = 'agent'
	AND lower("target_id") IN (
		'8d403783-c4e2-4746-adad-7689cd95ae33',
		'dcd3cadb-8203-4048-be1e-77701a3a43a0'
	);
--> statement-breakpoint
DELETE FROM "company_skill_stars"
WHERE "agent_id" IN (
	'8d403783-c4e2-4746-adad-7689cd95ae33'::uuid,
	'dcd3cadb-8203-4048-be1e-77701a3a43a0'::uuid
);
