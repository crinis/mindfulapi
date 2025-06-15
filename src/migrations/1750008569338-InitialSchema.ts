import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1750008569338 implements MigrationInterface {
    name = 'InitialSchema1750008569338'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Check if tables already exist before creating them
        const scansTable = await queryRunner.hasTable("scans");
        const issuesTable = await queryRunner.hasTable("issues");
        
        if (!scansTable) {
            await queryRunner.query(`CREATE TABLE "scans" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "url" varchar NOT NULL, "language" varchar NOT NULL DEFAULT ('en'), "rootElement" varchar, "status" varchar NOT NULL DEFAULT ('pending'), "scannerType" varchar NOT NULL DEFAULT ('htmlcs'), "ruleIds" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        }
        
        if (!issuesTable) {
            await queryRunner.query(`CREATE TABLE "issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" varchar NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer)`);
        }
        
        // Only add foreign key if it doesn't already exist
        if (!issuesTable) {
            await queryRunner.query(`CREATE TABLE "temporary_issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" varchar NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer, CONSTRAINT "FK_4f80b7de22814f4d6b817c8a68f" FOREIGN KEY ("scanId") REFERENCES "scans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
            
            // Only migrate data if original issues table exists
            const hasIssuesData = await queryRunner.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='issues'`);
            if (hasIssuesData.length > 0) {
                await queryRunner.query(`INSERT INTO "temporary_issues"("id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId" FROM "issues"`);
                await queryRunner.query(`DROP TABLE "issues"`);
            }
            
            await queryRunner.query(`ALTER TABLE "temporary_issues" RENAME TO "issues"`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const issuesTable = await queryRunner.hasTable("issues");
        const scansTable = await queryRunner.hasTable("scans");
        
        if (issuesTable) {
            await queryRunner.query(`ALTER TABLE "issues" RENAME TO "temporary_issues"`);
            await queryRunner.query(`CREATE TABLE "issues" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "ruleId" varchar NOT NULL, "description" varchar NOT NULL, "impact" varchar NOT NULL, "selector" varchar, "context" varchar, "screenshotFilename" varchar, "scanId" integer)`);
            await queryRunner.query(`INSERT INTO "issues"("id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId") SELECT "id", "ruleId", "description", "impact", "selector", "context", "screenshotFilename", "scanId" FROM "temporary_issues"`);
            await queryRunner.query(`DROP TABLE "temporary_issues"`);
            await queryRunner.query(`DROP TABLE "issues"`);
        }
        
        if (scansTable) {
            await queryRunner.query(`DROP TABLE "scans"`);
        }
    }

}
