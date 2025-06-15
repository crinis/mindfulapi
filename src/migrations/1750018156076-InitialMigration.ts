import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialMigration1750018156076 implements MigrationInterface {
    name = 'InitialMigration1750018156076'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer)`);
        await queryRunner.query(`CREATE TABLE "scans" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "url" varchar NOT NULL, "language" varchar NOT NULL DEFAULT ('en'), "rootElement" varchar, "scannerType" varchar CHECK( "scannerType" IN ('htmlcs','axe') ) NOT NULL DEFAULT ('htmlcs'), "status" varchar CHECK( "status" IN ('pending','running','completed','failed') ) NOT NULL DEFAULT ('pending'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE "temporary_issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer, CONSTRAINT "FK_935e68db021e02610996cc9d385" FOREIGN KEY ("scanId") REFERENCES "scans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
        await queryRunner.query(`INSERT INTO "temporary_issues"("id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId" FROM "issues"`);
        await queryRunner.query(`DROP TABLE "issues"`);
        await queryRunner.query(`ALTER TABLE "temporary_issues" RENAME TO "issues"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "issues" RENAME TO "temporary_issues"`);
        await queryRunner.query(`CREATE TABLE "issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" text NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer)`);
        await queryRunner.query(`INSERT INTO "issues"("id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId" FROM "temporary_issues"`);
        await queryRunner.query(`DROP TABLE "temporary_issues"`);
        await queryRunner.query(`DROP TABLE "scans"`);
        await queryRunner.query(`DROP TABLE "issues"`);
    }

}
