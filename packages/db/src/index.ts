export { Db, createPool, type Queryable, type TenantClient } from "./client.js";
export { assertRlsEnforced, RlsBypassError } from "./guard.js";
export { MIGRATIONS_DIR, migrate, type AppliedMigration } from "./migrate.js";
export {
  countByStatus,
  countDocuments,
  getDocument,
  getFindings,
  insertDocument,
  insertFindings,
  listDocuments,
  type DocumentListItem,
  type DocumentRow,
  type FindingRow,
  type InsertDocumentInput,
  type InsertFindingInput,
  type ListFilters,
  type StatusCount,
} from "./documents.js";
export {
  createTenant,
  getInboxAddress,
  getTenant,
  type CreatedTenant,
  type CreateTenantInput,
  type TenantRow,
} from "./tenants.js";
export {
  archiveDocument,
  chainLinks,
  entriesForDay,
  linkForDay,
  proofForDocument,
  sealArchiveDay,
  utcDay,
  type ArchiveProof,
} from "./archive-store.js";
