-- =============================================================================
-- 0019  Public enquiries.
--
-- The marketing site's contact form has to land somewhere real, and the write
-- happens with nobody signed in. That is the only unauthenticated write path in
-- the platform, so it is deliberately narrow: the application role is granted
-- INSERT on this one table and nothing else, and is granted no SELECT, so the
-- public path can deposit an enquiry and can never read one back - not even the
-- row it just wrote.
--
-- Reading them is platform-operator work, under the same access grants and the
-- same audit as everything else in Solvenda Control.
-- =============================================================================

CREATE TABLE platform_enquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  -- Deliberately few fields. This is a first contact from a firm, not a
  -- profile: we ask for what is needed to reply and to know who is asking.
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  organisation   text NOT NULL DEFAULT '' CHECK (length(organisation) <= 200),
  email          text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  message        text NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
  enquiry_type   text NOT NULL DEFAULT 'general'
                 CHECK (enquiry_type IN ('general','demo','pricing','migration',
                                         'security','partnership','press')),
  -- Which page the person came from. Useful, and carries no personal data.
  source_path    text NOT NULL DEFAULT '/contact' CHECK (length(source_path) <= 200),
  status         text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','in-progress','answered','closed','spam')),
  handled_by     uuid REFERENCES platform_operators(id),
  handled_at     timestamptz,
  notes          text
);
CREATE INDEX platform_enquiries_triage ON platform_enquiries (status, submitted_at DESC);

SELECT app.apply_platform_rls('platform_enquiries');

-- The public write path. Permissive policies are OR-ed, so this sits alongside
-- the platform-only policy rather than weakening it: an insert succeeds, and
-- every other verb still requires platform context.
DROP POLICY IF EXISTS platform_enquiries_public_insert ON platform_enquiries;
CREATE POLICY platform_enquiries_public_insert ON platform_enquiries
  FOR INSERT WITH CHECK (true);

-- INSERT only, and deliberately no SELECT: without it the application role
-- cannot use RETURNING either, which is the property we want.
GRANT INSERT ON platform_enquiries TO solvenda_app;
