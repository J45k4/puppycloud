use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

pub fn open_db(path: impl AsRef<Path>) -> SqlResult<Connection> {
    Connection::open(path)
}

pub fn init_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS manifests (id TEXT PRIMARY KEY, manifest TEXT NOT NULL)",
        [],
    )?;
    // Peer summary table (one row per peer)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS peers (\n            peer_id   TEXT PRIMARY KEY,\n            last_addr TEXT,\n            last_seen INTEGER NOT NULL\n        )",
        [],
    )?;
    // Peer addresses table (one row per peer address), composite key (peer_id, addr)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS peer_addrs (\n            peer_id   TEXT NOT NULL,\n            addr      TEXT NOT NULL,\n            last_seen INTEGER NOT NULL,\n            PRIMARY KEY(peer_id, addr)\n        )",
        [],
    )?;
    // Config KV table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS config (\n            key   TEXT PRIMARY KEY,\n            value TEXT NOT NULL\n        )",
        [],
    )?;
    // Local keys table, store protobuf-encoded private key bytes
    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_keys (\n            name        TEXT PRIMARY KEY,\n            key         BLOB NOT NULL,\n            created_ts  INTEGER NOT NULL\n        )",
        [],
    )?;
    Ok(())
}

pub fn upsert_manifest(conn: &Connection, id: &str, manifest_json: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO manifests (id, manifest) VALUES (?1, ?2)",
        params![id, manifest_json],
    )?;
    Ok(())
}

pub fn upsert_peer(
    conn: &Connection,
    peer_id: &str,
    last_addr: Option<&str>,
    last_seen: i64,
) -> SqlResult<()> {
    let sql = "INSERT INTO peers (peer_id, last_addr, last_seen) VALUES (?1, ?2, ?3) \
               ON CONFLICT(peer_id) DO UPDATE SET last_addr = excluded.last_addr, last_seen = excluded.last_seen";
    conn.execute(sql, params![peer_id, last_addr, last_seen])?;
    Ok(())
}

pub fn upsert_peer_addr(conn: &Connection, peer_id: &str, addr: &str, last_seen: i64) -> SqlResult<()> {
    let sql = "INSERT INTO peer_addrs (peer_id, addr, last_seen) VALUES (?1, ?2, ?3) \
               ON CONFLICT(peer_id, addr) DO UPDATE SET last_seen = excluded.last_seen";
    conn.execute(sql, params![peer_id, addr, last_seen])?;
    Ok(())
}

pub fn get_config(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM config WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        let v: String = row.get(0)?;
        Ok(Some(v))
    } else {
        Ok(None)
    }
}

pub fn set_config(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?1, ?2)\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_local_key(conn: &Connection, name: &str) -> SqlResult<Option<Vec<u8>>> {
    let mut stmt = conn.prepare("SELECT key FROM local_keys WHERE name = ?1")?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        let v: Vec<u8> = row.get(0)?;
        Ok(Some(v))
    } else {
        Ok(None)
    }
}

pub fn set_local_key(conn: &Connection, name: &str, key_bytes: &[u8], created_ts: i64) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO local_keys (name, key, created_ts) VALUES (?1, ?2, ?3)\n         ON CONFLICT(name) DO UPDATE SET key = excluded.key",
        params![name, key_bytes, created_ts],
    )?;
    Ok(())
}

pub fn get_recent_peer_addrs(
    conn: &Connection,
    limit: usize,
    min_last_seen: Option<i64>,
) -> SqlResult<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Some(min_ts) = min_last_seen {
        let mut stmt = conn.prepare(
            "SELECT peer_id, addr FROM peer_addrs WHERE last_seen >= ?1 ORDER BY last_seen DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![min_ts, limit as i64], |row| {
            let pid: String = row.get(0)?;
            let addr: String = row.get(1)?;
            Ok((pid, addr))
        })?;
        for r in rows {
            out.push(r?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT peer_id, addr FROM peer_addrs ORDER BY last_seen DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let pid: String = row.get(0)?;
            let addr: String = row.get(1)?;
            Ok((pid, addr))
        })?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(out)
}
