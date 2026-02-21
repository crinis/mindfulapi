import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds scan-run mode/targets/crawl metadata and page-level issue URLs.
 */
export class ScanRunModesAndPageUrls1761000000000
  implements MigrationInterface
{
  /** TypeORM migration name identifier. */
  name = 'ScanRunModesAndPageUrls1761000000000';

  /**
   * Applies schema/data changes for run modes, crawl metadata, and page URLs.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issues" ADD COLUMN "pageUrl" varchar`,
    );

    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "mode" varchar CHECK( "mode" IN ('single_url','url_list','crawl') ) NOT NULL DEFAULT ('single_url')`,
    );
    await queryRunner.query(`ALTER TABLE "scans" ADD COLUMN "targets" text`);
    await queryRunner.query(`ALTER TABLE "scans" ADD COLUMN "ruleIds" text`);
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlMaxPages" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlMaxDepth" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlSameHostOnly" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlIncludePatterns" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlExcludePatterns" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "crawlConcurrency" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "pagesDiscovered" integer NOT NULL DEFAULT (0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "pagesScanned" integer NOT NULL DEFAULT (0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scans" ADD COLUMN "pagesFailed" integer NOT NULL DEFAULT (0)`,
    );

    await queryRunner.query(
      `UPDATE "scans" SET "targets" = '["' || REPLACE("url", '"', '\\"') || '"]' WHERE "targets" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "scans" SET "pagesDiscovered" = CASE WHEN "status" = 'completed' THEN 1 ELSE 0 END`,
    );
    await queryRunner.query(
      `UPDATE "scans" SET "pagesScanned" = CASE WHEN "status" = 'completed' THEN 1 ELSE 0 END`,
    );
    await queryRunner.query(
      `UPDATE "issues" SET "pageUrl" = (SELECT "s"."url" FROM "scans" "s" WHERE "s"."id" = "issues"."scanId") WHERE "pageUrl" IS NULL`,
    );
  }

  /**
   * Reverts schema/data changes introduced by this migration.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "scans_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "url" varchar NOT NULL, "rootElement" varchar, "status" varchar CHECK( "status" IN ('pending','running','completed','failed') ) NOT NULL DEFAULT ('pending'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `INSERT INTO "scans_old"("id", "url", "rootElement", "status", "createdAt", "updatedAt") SELECT "id", "url", "rootElement", "status", "createdAt", "updatedAt" FROM "scans"`,
    );
    await queryRunner.query(`DROP TABLE "scans"`);
    await queryRunner.query(`ALTER TABLE "scans_old" RENAME TO "scans"`);

    await queryRunner.query(
      `CREATE TABLE "issues_old" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "helpUrl" varchar, "scanId" integer, CONSTRAINT "FK_issues_scan" FOREIGN KEY ("scanId") REFERENCES "scans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "issues_old"("id", "ruleId", "description", "impact", "selector", "context", "helpUrl", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "helpUrl", "scanId" FROM "issues"`,
    );
    await queryRunner.query(`DROP TABLE "issues"`);
    await queryRunner.query(`ALTER TABLE "issues_old" RENAME TO "issues"`);
  }
}
