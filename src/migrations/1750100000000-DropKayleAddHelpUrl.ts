import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: drop kayle/HTMLCS-specific columns, add axe-core helpUrl.
 *
 * Changes to `scans`: remove `language` and `scannerType` columns.
 * Changes to `issues`: remove `screenshotFilename`, add `helpUrl`.
 */
export class DropKayleAddHelpUrl1750100000000 implements MigrationInterface {
  /** TypeORM migration name identifier. */
  name = 'DropKayleAddHelpUrl1750100000000';

  /**
   * Applies schema changes for dropping legacy columns and adding help URLs.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Recreate scans table without language and scannerType columns
    await queryRunner.query(
      `CREATE TABLE "scans_new" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "url" varchar NOT NULL, "rootElement" varchar, "status" varchar CHECK( "status" IN ('pending','running','completed','failed') ) NOT NULL DEFAULT ('pending'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `INSERT INTO "scans_new"("id", "url", "rootElement", "status", "createdAt", "updatedAt") SELECT "id", "url", "rootElement", "status", "createdAt", "updatedAt" FROM "scans"`,
    );
    await queryRunner.query(`DROP TABLE "scans"`);
    await queryRunner.query(`ALTER TABLE "scans_new" RENAME TO "scans"`);

    // Recreate issues table without screenshotFilename, with helpUrl
    await queryRunner.query(
      `CREATE TABLE "issues_new" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "helpUrl" varchar, "scanId" integer, CONSTRAINT "FK_issues_scan" FOREIGN KEY ("scanId") REFERENCES "scans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "issues_new"("id", "ruleId", "description", "impact", "selector", "context", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "scanId" FROM "issues"`,
    );
    await queryRunner.query(`DROP TABLE "issues"`);
    await queryRunner.query(`ALTER TABLE "issues_new" RENAME TO "issues"`);
  }

  /**
   * Reverts schema changes introduced by this migration.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore issues table with screenshotFilename, without helpUrl
    await queryRunner.query(
      `CREATE TABLE "issues_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer, CONSTRAINT "FK_issues_scan" FOREIGN KEY ("scanId") REFERENCES "scans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "issues_old"("id", "ruleId", "description", "impact", "selector", "context", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "scanId" FROM "issues"`,
    );
    await queryRunner.query(`DROP TABLE "issues"`);
    await queryRunner.query(`ALTER TABLE "issues_old" RENAME TO "issues"`);

    // Restore scans table with language and scannerType columns
    await queryRunner.query(
      `CREATE TABLE "scans_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "url" varchar NOT NULL, "language" varchar NOT NULL DEFAULT ('en'), "rootElement" varchar, "scannerType" varchar CHECK( "scannerType" IN ('htmlcs','axe') ) NOT NULL DEFAULT ('htmlcs'), "status" varchar CHECK( "status" IN ('pending','running','completed','failed') ) NOT NULL DEFAULT ('pending'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `INSERT INTO "scans_old"("id", "url", "rootElement", "status", "createdAt", "updatedAt") SELECT "id", "url", "rootElement", "status", "createdAt", "updatedAt" FROM "scans"`,
    );
    await queryRunner.query(`DROP TABLE "scans"`);
    await queryRunner.query(`ALTER TABLE "scans_old" RENAME TO "scans"`);
  }
}
