-- The interface language, per person.
--
-- `users.locale` has been in the schema since 0001 and has never been written
-- to except at signup, where it copied whatever the tenant was created with.
-- The account screen now sets it, which makes two things true that were not
-- before:
--
--   1. It is a *person's* setting, not the business's. Two people in the same
--      Betrieb can read the same invoice in different languages; the tenant's
--      own `locale` stays as the default a new user inherits and as what an API
--      key falls back to, since a key authenticates a business and there is no
--      person to ask.
--
--   2. It can hold something other than 'de' or 'tr'. The CHECK below is the
--      list of languages the product actually speaks - see
--      apps/web/src/lib/i18n/languages.ts, which holds the same ten and the
--      reasoning for them.
--
-- The constraint is here rather than only in the API because the API is not the
-- only writer: the seed, a migration, and a psql session all reach these
-- columns. An unknown code would not corrupt anything - the interface falls
-- back to German and so do the explanations - but it would fail silently, and a
-- setting that quietly does nothing is worse than one that refuses.
--
-- Adding a language means editing this list AND writing a dictionary. Doing
-- only the first gives a picker entry that renders German; doing only the
-- second gives a picker entry the database rejects. Neither is silent, which is
-- the point of having both.

ALTER TABLE users
  ADD CONSTRAINT users_locale_supported
  CHECK (locale IN ('de','tr','en','ru','uk','ar','pl','ro','it','el'));

-- The tenant default is offered in the same picker at signup, so it takes the
-- same list.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_locale_supported
  CHECK (locale IN ('de','tr','en','ru','uk','ar','pl','ro','it','el'));
