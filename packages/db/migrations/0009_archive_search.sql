-- M-05. Search across ten years of archive.
--
-- The failure that matters here is not slowness, it is a search that quietly
-- finds nothing: the user concludes the invoice never arrived, and acts on
-- that. Two things follow - the match has to survive how the name is actually
-- spelled, and the caller has to be able to tell "no such document" apart from
-- "no exact match, here are near ones".
--
-- Spelling is the specific problem for this tenant base. The same supplier is
-- written six ways:
--
--     Şahin Döner   Sahin Doner   Sahin Doener
--     Müller        Muller        Mueller
--
-- German folding expands (ö -> oe), Turkish folding strips (ö -> o), and they
-- disagree. Choosing one loses the other, so both are indexed and the query is
-- matched against both.

-- Trigram matching, needed by the GIN index below and by 0003. Declared here
-- rather than assumed: a fresh database that had never run the test bootstrap
-- failed at 0003, which is not where anyone would look for a missing extension.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

/*
 * Plain ASCII folding, and the case fold both functions rely on.
 *
 * Deliberately not `unaccent()`: that is STABLE, because it depends on a
 * dictionary that can be changed underneath an index, and wrapping it as
 * IMMUTABLE to get past the generated-column check would be a lie the planner
 * believes. `translate` over a fixed character set is immutable in fact.
 *
 * The case fold is done by `translate` rather than left to `lower()` for the
 * same kind of reason. `lower()` is collation-dependent: under a C locale it
 * leaves every non-ASCII letter alone, so "Şahin" stayed "Şahin" and only the
 * lowercase half of a supplier name folded. Mapping the uppercase forms
 * explicitly means the result does not change with the database's lc_ctype -
 * which matters for a STORED column, since rows written under one setting
 * would otherwise never match a query normalised under another. `lower()` is
 * still called last, over what is by then ASCII, where it is collation-safe.
 */
CREATE OR REPLACE FUNCTION belegbox_fold_ascii(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(
    translate(
      value,
      'äöüÄÖÜàáâãåèéêëìíîïòóôõùúûýÀÁÂÃÅÈÉÊËÌÍÎÏÒÓÔÕÙÚÛÝşŞıİğĞçÇñÑ',
      'aouAOUaaaaaeeeeiiiioooouuuyAAAAAEEEEIIIIOOOOUUUYsSiIgGcCnN'
    )
  )
$$;

/*
 * German expansion: the spelling a German speaker types.
 *
 * Expands the umlauts, then hands the rest to the ASCII fold, so a Turkish
 * capital in a German-folded name is still folded rather than left standing.
 */
CREATE OR REPLACE FUNCTION belegbox_fold_de(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT belegbox_fold_ascii(
    replace(replace(replace(replace(replace(replace(replace(
      value,
      'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'),
      'Ä', 'Ae'), 'Ö', 'Oe'), 'Ü', 'Ue'),
      'ß', 'ss')
  )
$$;

/*
 * What a search matches against.
 *
 * Both foldings of every searchable field, in one string. A query folded either
 * way finds its half, so all six spellings above hit the same row. The cost is
 * roughly double the text; the alternative is a search that works for one half
 * of the customer base.
 *
 * STORED rather than a view or an expression index: it is read by every search
 * and inspectable when a match is disputed, which on an archive it will be.
 */
ALTER TABLE documents ADD COLUMN search_text text
  GENERATED ALWAYS AS (
    belegbox_fold_de(
      coalesce(supplier_name, '') || ' ' ||
      coalesce(invoice_number, '') || ' ' ||
      coalesce(supplier_vat_id, '')
    ) || ' ' ||
    belegbox_fold_ascii(
      coalesce(supplier_name, '') || ' ' ||
      coalesce(invoice_number, '') || ' ' ||
      coalesce(supplier_vat_id, '')
    )
  ) STORED;

-- Serves both LIKE '%...%' and similarity(). A btree cannot help a leading
-- wildcard, which is exactly the shape a search over supplier names takes.
CREATE INDEX documents_search_trgm
  ON documents USING gin (search_text gin_trgm_ops);

-- The archive is browsed by period far more often than by receipt order: a
-- Steuerberater asks for a quarter, an auditor for a year.
CREATE INDEX documents_tenant_issued
  ON documents (tenant_id, issued_at DESC NULLS LAST);

-- "Find the 4.200 EUR invoice" is a real way people look for a document they
-- remember by amount rather than by number.
CREATE INDEX documents_tenant_gross
  ON documents (tenant_id, total_gross)
  WHERE total_gross IS NOT NULL;
