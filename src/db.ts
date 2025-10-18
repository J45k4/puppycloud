import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export function createDatabase(path: string): Database {
	const instance = new Database(path, { strict: true })
	instance.exec("PRAGMA journal_mode=WAL;")
	instance.exec("PRAGMA foreign_keys=ON;")
	return instance
}

const defaultPath = process.env.DB_PATH || "./puppycloud.db"
export let db = createDatabase(defaultPath)

export function configureDatabaseForTests(path: string): void {
	try {
		db.close()
	} catch {
		// ignore close errors when reconfiguring for tests
	}
	process.env.DB_PATH = path
	db = createDatabase(path)
}

export function closeDatabase(): void {
	try {
		db.close()
	} catch {
		// database may already be closed; ignore for clean shutdowns
	}
}

export function migrate(database: Database = db): void {
	const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url))
	database.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
	if (!existsSync(migrationsDir)) {
		return
	}

	const migrationFiles = readdirSync(migrationsDir)
		.filter((file) => file.endsWith(".sql"))
		.sort()

	for (const file of migrationFiles) {
		const id = file.replace(/\.sql$/, "")
		const already = database.query("SELECT 1 FROM migrations WHERE id = ?").get(id)
		if (already) {
			continue
		}

		const sql = readFileSync(join(migrationsDir, file), "utf8")
		const run = database.transaction(() => {
			database.exec(sql)
			database.query("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(id, now())
		})
		run()
	}
}