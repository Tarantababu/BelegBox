export { Db, createPool, type Queryable, type TenantClient } from "./client.js";
export { MIGRATIONS_DIR, migrate, type AppliedMigration } from "./migrate.js";
export {
  countDocuments,
  getDocument,
  insertDocument,
  type DocumentRow,
  type InsertDocumentInput,
} from "./documents.js";
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
