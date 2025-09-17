use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use axum::{
    extract::{Multipart, Path as AxPath, State},
    http::StatusCode,
    response::Html,
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use bytes::Bytes;
use clap::Parser;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, net::TcpListener, sync::mpsc, task::spawn_blocking};
use tracing::info;
use tracing_subscriber::EnvFilter;

mod db;
use db::{
    get_recent_peer_addrs, init_schema, open_db, set_config, set_local_key, upsert_manifest,
    upsert_peer, upsert_peer_addr,
};

// P2P
use futures::StreamExt;
use libp2p::{
    // added imports
    core::ConnectedPoint,
    identity,
    mdns,
    multiaddr::Protocol,
    ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    Multiaddr,
    PeerId,
    Swarm,
};

#[derive(Parser, Debug)]
#[command(name = "PuppyCloud", version)]
struct Cli {
    /// HTTP bind, e.g. 0.0.0.0:9090
    #[arg(long, default_value = "0.0.0.0:9090")]
    http_bind: String,

    /// Data directory
    #[arg(long, default_value = "./data")]
    data: String,

    /// SQLite database path
    #[arg(long, default_value = "puppycloud.db")]
    db: String,

    /// Multiaddr(s) of peers to dial on startup. Repeat --peer to add more.
    #[arg(long, value_name = "ADDR")]
    peer: Vec<String>,
}

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    data_root: PathBuf,
    // P2P
    p2p_peer_id: String,
    p2p_addrs: Arc<Mutex<Vec<String>>>,
    p2p_dial_tx: mpsc::Sender<String>,
    invites: Arc<Mutex<HashMap<String, i64>>>, // password -> expiry unix timestamp
    // auth
    sessions: Arc<Mutex<HashMap<String, String>>>, // session_id -> username
}

#[derive(Debug, Serialize, Deserialize)]
struct ChunkRef {
    id: String,
    size: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileManifest {
    total_size: u64,
    chunks: Vec<ChunkRef>,
    mime: Option<String>,
    created_ts: time::OffsetDateTime,
}

fn chunk_id(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

fn chunk_path(root: &Path, id: &str) -> PathBuf {
    root.join(&id[0..2]).join(&id[2..4]).join(id)
}

// --- Auth extractor & handlers ---
use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2,
};
use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts};
use rand_core::{OsRng, RngCore};

struct RequireAuth(pub String); // username

#[async_trait]
impl FromRequestParts<AppState> for RequireAuth {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let cookies = parts
            .headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let sid = cookies
            .split(';')
            .find_map(|c| {
                let c = c.trim();
                c.strip_prefix("sid=").map(|rest| rest.to_string())
            })
            .ok_or((StatusCode::UNAUTHORIZED, "no session".into()))?;
        let sessions = state.sessions.lock().unwrap();
        if let Some(user) = sessions.get(&sid) {
            Ok(RequireAuth(user.clone()))
        } else {
            Err((StatusCode::UNAUTHORIZED, "invalid session".into()))
        }
    }
}

#[derive(Deserialize)]
struct SetPasswordReq {
    username: String,
    password: String,
    expires_ts: Option<i64>,
}

async fn post_set_password(
    State(state): State<AppState>,
    Json(req): Json<SetPasswordReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if req.username.trim().is_empty() || req.password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            "username and 8+ char password required".into(),
        ));
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon = Argon2::default();
    let hash = argon
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let created_ts = time::OffsetDateTime::now_utc().unix_timestamp();
    let db = state.db.clone();
    let salt_bytes = salt.as_str().as_bytes().to_vec();
    let hash_bytes = hash.hash.unwrap().as_bytes().to_vec();
    spawn_blocking(move || -> Result<(), rusqlite::Error> {
        let conn = db.lock().unwrap();
        db::upsert_user(
            &conn,
            &req.username,
            &hash_bytes,
            &salt_bytes,
            created_ts,
            req.expires_ts,
        )?;
        Ok(())
    })
    .await
    .map_err(intern)?
    .map_err(intern)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
}

async fn post_login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<
    (
        StatusCode,
        [(header::HeaderName, String); 1],
        Json<serde_json::Value>,
    ),
    (StatusCode, String),
> {
    let db = state.db.clone();
    let username = req.username.clone();
    let user = spawn_blocking(move || -> Result<Option<db::UserRow>, rusqlite::Error> {
        let conn = db.lock().unwrap();
        db::get_user(&conn, &username)
    })
    .await
    .map_err(intern)?
    .map_err(intern)?;

    let Some(user) = user else {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    };
    if let Some(exp) = user.expires_ts {
        if time::OffsetDateTime::now_utc().unix_timestamp() > exp {
            return Err((StatusCode::UNAUTHORIZED, "password expired".into()));
        }
    }

    let argon = Argon2::default();
    let salt_b64 = std::str::from_utf8(&user.salt)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let salt = SaltString::from_b64(salt_b64)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let calc = argon
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let calc_hash = calc.hash.unwrap();
    let calc_bytes = calc_hash.as_bytes();
    if calc_bytes != user.pwd_hash.as_slice() {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    }

    let mut sid_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut sid_bytes);
    let sid = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sid_bytes);
    state
        .sessions
        .lock()
        .unwrap()
        .insert(sid.clone(), req.username.clone());
    let cookie = format!("sid={}; Path=/; HttpOnly; SameSite=Lax", sid);

    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({"ok": true})),
    ))
}

async fn post_logout(
    State(state): State<AppState>,
    RequireAuth(user): RequireAuth,
) -> Result<
    (
        StatusCode,
        [(header::HeaderName, String); 1],
        Json<serde_json::Value>,
    ),
    (StatusCode, String),
> {
    let cookie = "sid=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax".to_string();
    let mut sessions = state.sessions.lock().unwrap();
    sessions.retain(|_, v| v != &user);
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({"ok": true})),
    ))
}

// --- P2P setup ---
#[derive(NetworkBehaviour)]
struct PcBehaviour {
    ping: ping::Behaviour,
    mdns: mdns::tokio::Behaviour,
}

async fn spawn_p2p(
    addrs_out: Arc<Mutex<Vec<String>>>,
    db: Arc<Mutex<Connection>>,
) -> Result<(String, mpsc::Sender<String>)> {
    // Load or generate the local identity key from DB
    let maybe_key_bytes = spawn_blocking({
        let db = db.clone();
        move || {
            let conn = db.lock().unwrap();
            db::get_local_key(&conn, "node")
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!(e.to_string()))??;

    let local_key = if let Some(bytes) = maybe_key_bytes {
        identity::Keypair::from_protobuf_encoding(&bytes)
            .map_err(|e| anyhow::anyhow!(format!("failed to decode local key: {e}")))?
    } else {
        let k = identity::Keypair::generate_ed25519();
        let enc = k
            .to_protobuf_encoding()
            .map_err(|e| anyhow::anyhow!(format!("failed to encode local key: {e}")))?;
        let ts = time::OffsetDateTime::now_utc().unix_timestamp();
        // Persist the key
        let enc_clone = enc.clone();
        spawn_blocking({
            let db = db.clone();
            move || {
                let conn = db.lock().unwrap();
                set_local_key(&conn, "node", &enc_clone, ts)
            }
        })
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
        k
    };

    let local_peer_id = local_key.public().to_peer_id();
    // Store peer_id in config for easy lookup
    let pid_str = local_peer_id.to_string();
    spawn_blocking({
        let db = db.clone();
        let pid = pid_str.clone();
        move || {
            let conn = db.lock().unwrap();
            set_config(&conn, "peer_id", &pid)
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!(e.to_string()))??;

    // Build the Swarm with TCP + Noise + Yamux
    let mut swarm: Swarm<PcBehaviour> = libp2p::SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default().nodelay(true),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .expect("tcp transport")
        .with_behaviour(|key| {
            let peer_id = key.public().to_peer_id();
            Ok(PcBehaviour {
                ping: ping::Behaviour::default(),
                mdns: mdns::tokio::Behaviour::new(mdns::Config::default(), peer_id)?,
            })
        })
        .expect("behaviour")
        .build();

    // Try to listen on a random TCP port; if in use, retry once
    let addr: Multiaddr = "/ip4/0.0.0.0/tcp/0".parse().expect("valid multiaddr");
    match swarm.listen_on(addr) {
        Ok(_) => {}
        Err(e) => {
            if let libp2p::TransportError::Other(ioe) = &e {
                if ioe.kind() == std::io::ErrorKind::AddrInUse {
                    tracing::warn!("p2p listen addr in use, retrying on random port");
                    let addr2: Multiaddr = "/ip4/0.0.0.0/tcp/0".parse().expect("valid multiaddr");
                    swarm
                        .listen_on(addr2)
                        .map_err(|e| anyhow::anyhow!("p2p listen error: {e}"))?;
                } else {
                    return Err(anyhow::anyhow!("p2p listen error: {e}"));
                }
            } else {
                return Err(anyhow::anyhow!("p2p listen error: {e}"));
            }
        }
    }

    // Channel to request dialing from HTTP handlers
    let (dial_tx, mut dial_rx) = mpsc::channel::<String>(32);

    // Event loop
    tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle dial requests from HTTP endpoint
                Some(addr) = dial_rx.recv() => {
                    match addr.parse::<Multiaddr>() {
                        Ok(ma) => {
                            // Opportunistically persist the address if it contains a /p2p/ component
                            let addr_str = ma.to_string();
                            if let Some(pid) = ma.iter().find_map(|p| {
                                if let Protocol::P2p(mh) = p { PeerId::from_multihash(mh.into()).ok() } else { None }
                            }) {
                                let pid_str = pid.to_string();
                                let db2 = db.clone();
                                let ts = time::OffsetDateTime::now_utc().unix_timestamp();
                                spawn_blocking(move || {
                                    let conn = db2.lock().unwrap();
                                    let _ = upsert_peer(&conn, &pid_str, Some(&addr_str), ts);
                                    let _ = upsert_peer_addr(&conn, &pid_str, &addr_str, ts);
                                });
                            }
                            if let Err(e) = swarm.dial(ma) {
                                tracing::warn!("p2p dial error: {e}");
                            }
                        }
                        Err(e) => tracing::warn!("invalid multiaddr: {e}"),
                    }
                }
                // Handle libp2p events
                ev = swarm.select_next_some() => {
                    match ev {
                        SwarmEvent::NewListenAddr { address, .. } => {
                            tracing::info!("p2p listening on {address}");
                            let mut g = addrs_out.lock().unwrap();
                            if !g.iter().any(|a| a == &address.to_string()) {
                                g.push(address.to_string());
                            }
                        }
                        SwarmEvent::Behaviour(event) => {
                            match event {
                                // mDNS discovered peers -> upsert into DB with addr
                                PcBehaviourEvent::Mdns(mdns_event) => {
                                    match mdns_event {
                                        mdns::Event::Discovered(list) => {
                                            for (pid, addr) in list {
                                                let db2 = db.clone();
                                                let pid_str = pid.to_string();
                                                let addr_str = addr.to_string();
                                                let ts = time::OffsetDateTime::now_utc().unix_timestamp();
                                                spawn_blocking(move || {
                                                    let conn = db2.lock().unwrap();
                                                    let _ = upsert_peer(&conn, &pid_str, Some(&addr_str), ts);
                                                    let _ = upsert_peer_addr(&conn, &pid_str, &addr_str, ts);
                                                });
                                            }
                                        }
                                        mdns::Event::Expired(_list) => {
                                            // optional: could mark peers as stale
                                        }
                                    }
                                }
                                // ignore ping events
                                PcBehaviourEvent::Ping(_) => {}
                            }
                        }
                        SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                            tracing::info!("p2p connected to {peer_id}");
                            // Persist the remote address we connected to
                            let addr_str = match endpoint {
                                ConnectedPoint::Dialer { address, .. } => address.to_string(),
                                ConnectedPoint::Listener { send_back_addr, .. } => send_back_addr.to_string(),
                            };
                            let db2 = db.clone();
                            let pid_str = peer_id.to_string();
                            let ts = time::OffsetDateTime::now_utc().unix_timestamp();
                            spawn_blocking(move || {
                                let conn = db2.lock().unwrap();
                                let _ = upsert_peer(&conn, &pid_str, Some(&addr_str), ts);
                                let _ = upsert_peer_addr(&conn, &pid_str, &addr_str, ts);
                            });
                        }
                        SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                            tracing::warn!("p2p outgoing conn error to {:?}: {error}", peer_id);
                        }
                        SwarmEvent::IncomingConnectionError { error, .. } => {
                            tracing::warn!("p2p incoming conn error: {error}");
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    Ok((pid_str, dial_tx))
}

const INDEX_HTML: &str = include_str!("../../assets/index.html");
const JS_HTML: &str = include_str!("../../assets/puppycloud.js");
const CSS: &str = include_str!("../../assets/puppycloud.css");

#[cfg(debug_assertions)]
async fn js() -> String {
    use tokio::io::AsyncReadExt;

	let mut file = tokio::fs::File::open("../assets/puppycloud.js").await.unwrap();
	let mut contents = String::new();
	file.read_to_string(&mut contents).await.unwrap();
	contents
}

#[cfg(not(debug_assertions))]
async fn js() -> &'static str {
	JS_HTML
}

async fn root() -> Html<&'static str> {
	Html(INDEX_HTML)
}

async fn css() -> &'static str {
	CSS
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cli = Cli::parse();
    let data_root = PathBuf::from(&cli.data);
    std::fs::create_dir_all(&data_root)?;
    let db_path = PathBuf::from(&cli.db);
    let conn = open_db(&db_path)?;
    init_schema(&conn)?;

    // Wrap DB in Arc<Mutex<...>> to share with tasks
    let db = Arc::new(Mutex::new(conn));

    // Start P2P node (with DB handle)
    let p2p_addrs = Arc::new(Mutex::new(Vec::<String>::new()));
    let (p2p_peer_id, p2p_dial_tx) = spawn_p2p(p2p_addrs.clone(), db.clone()).await?;

    // Auto-dial recent peers from DB (e.g., last 7 days, max 32)
    {
        let db2 = db.clone();
        let dial = p2p_dial_tx.clone();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let min_last_seen = now - 7 * 24 * 3600; // 7 days
        if let Ok(list) = spawn_blocking(move || {
            let conn = db2.lock().unwrap();
            get_recent_peer_addrs(&conn, 32, Some(min_last_seen))
        })
        .await
        .unwrap_or_else(|_| Ok::<_, rusqlite::Error>(Vec::new()))
        {
            for (_pid, addr) in list {
                info!("P2P auto-dial recent: {addr}");
                let _ = dial.send(addr).await;
            }
        }
    }

    // Dial any peers supplied via CLI
    for addr in &cli.peer {
        info!("P2P dialing from CLI: {addr}");
        if let Err(e) = p2p_dial_tx.send(addr.clone()).await {
            tracing::warn!("failed to queue dial {addr}: {e}");
        }
    }

    let state = AppState {
        db: db.clone(),
        data_root,
        // P2P
        p2p_peer_id,
        p2p_addrs,
        p2p_dial_tx,
        invites: Arc::new(Mutex::new(std::collections::HashMap::new())),
        // auth
        sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    let app = Router::new()
        .route("/puppycloud.js", get(js))
        .route("/puppycloud.css", get(css))
        .route("/peers", get(peers_html))
        .route("/gallery", get(gallery_html))
        .route("/health", get(|| async { "ok" }))
        .route("/auth/set_password", post(post_set_password))
        .route("/auth/login", post(post_login))
        .route("/auth/logout", post(post_logout))
        .route(
            "/upload",
            post(
                |state: State<AppState>, _auth: RequireAuth, mp: Multipart| async move {
                    upload_file(state, mp).await
                },
            ),
        )
        .route("/chunks/:id", get(get_chunk))
        .route("/p2p/info", get(get_p2p_info))
        .route("/p2p/peers", get(get_p2p_peers))
        // .route(
        //     "/p2p/invite",
        //     post(
        //         |state: State<AppState>, Json(req): Json<InviteReq>| async move {
        //             post_p2p_invite(state, Json(req)).await
        //         },
        //     ),
        // )
        .route(
            "/p2p/invite",
            post(
                |state: State<AppState>, _auth: RequireAuth, Json(req): Json<InviteReq>| async move {
                    post_p2p_invite(state, Json(req)).await
                },
            ),
        )
        .route(
            "/p2p/dial",
            post(
                |state: State<AppState>, _auth: RequireAuth, Json(req): Json<DialReq>| async move {
                    post_p2p_dial(state, Json(req)).await
                },
            ),
        )
        .with_state(state)
        .fallback(get(root));

    let addr: SocketAddr = cli.http_bind.parse()?;
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let fallback = SocketAddr::new(addr.ip(), 0);
            tracing::warn!("HTTP {addr} in use, falling back to {fallback}");
            TcpListener::bind(fallback)
                .await
                .map_err(anyhow::Error::from)?
        }
        Err(e) => return Err(e.into()),
    };
    let actual = listener.local_addr()?;
    info!("HTTP listening on {actual}");
    axum::serve(listener, app).await?;
    Ok(())
}

#[derive(Serialize)]
struct P2pInfo {
    peer_id: String,
    addrs: Vec<String>,
}

async fn get_p2p_info(
    State(state): State<AppState>,
) -> Result<Json<P2pInfo>, (StatusCode, String)> {
    let addrs = state.p2p_addrs.lock().unwrap().clone();
    Ok(Json(P2pInfo {
        peer_id: state.p2p_peer_id.clone(),
        addrs,
    }))
}

#[derive(Serialize)]
struct PeerSummary {
    peer_id: String,
    last_addr: Option<String>,
    last_seen: i64,
}

async fn get_p2p_peers(
    State(state): State<AppState>,
) -> Result<Json<Vec<PeerSummary>>, (StatusCode, String)> {
    let db = state.db.clone();
    let peers: Vec<PeerSummary> =
        spawn_blocking(move || -> Result<Vec<PeerSummary>, rusqlite::Error> {
            let conn = db.lock().unwrap();
            let mut out = Vec::new();
            let mut stmt = conn.prepare(
                "SELECT peer_id, last_addr, last_seen FROM peers ORDER BY last_seen DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![100i64], |row| {
                let peer_id: String = row.get(0)?;
                let last_addr: Option<String> = row.get(1)?;
                let last_seen: i64 = row.get(2)?;
                Ok(PeerSummary {
                    peer_id,
                    last_addr,
                    last_seen,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
        .await
        .map_err(intern)?
        .map_err(intern)?;
    Ok(Json(peers))
}

async fn index_html() -> Result<Html<String>, (StatusCode, String)> {
    let path = std::env::current_dir()
        .map_err(intern)?
        .join("static")
        .join("index.html");
    match tokio::fs::read_to_string(path).await {
        Ok(s) => Ok(Html(s)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn peers_html() -> Result<Html<String>, (StatusCode, String)> {
    let path = std::env::current_dir()
        .map_err(intern)?
        .join("static")
        .join("peers.html");
    match tokio::fs::read_to_string(path).await {
        Ok(s) => Ok(Html(s)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn gallery_html() -> Result<Html<String>, (StatusCode, String)> {
    let path = std::env::current_dir()
        .map_err(intern)?
        .join("static")
        .join("gallery.html");
    match tokio::fs::read_to_string(path).await {
        Ok(s) => Ok(Html(s)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[derive(Deserialize)]
struct DialReq {
    addr: String,
    password: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct InviteReq {
    password: String,
    expires: i64,
}

async fn post_p2p_dial(
    State(state): State<AppState>,
    Json(req): Json<DialReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let exp = {
        let invites = state.invites.lock().unwrap();
        invites.get(&req.password).copied()
    };
    match exp {
        Some(exp) if now <= exp => {
            state
                .p2p_dial_tx
                .send(req.addr.clone())
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(Json(
                serde_json::json!({ "status": "dialing", "addr": req.addr }),
            ))
        }
        _ => Err((StatusCode::UNAUTHORIZED, "invalid or expired invite".into())),
    }
}

async fn post_p2p_invite(
    State(state): State<AppState>,
    Json(req): Json<InviteReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let addr = state
        .p2p_addrs
        .lock()
        .unwrap()
        .first()
        .cloned()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "no p2p address".into()))?;
    state
        .invites
        .lock()
        .unwrap()
        .insert(req.password.clone(), req.expires);
    Ok(Json(
        serde_json::json!({ "addr": addr, "password": req.password, "expires": req.expires }),
    ))
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<FileManifest>, (StatusCode, String)> {
    let mut file_bytes = Vec::new();
    let mut mime: Option<String> = None;
    while let Some(field) = multipart.next_field().await.map_err(intern)? {
        match field.name() {
            Some("file") => {
                file_bytes = field.bytes().await.map_err(intern)?.to_vec();
            }
            Some("mime") => {
                mime = Some(field.text().await.map_err(intern)?);
            }
            _ => {}
        }
    }
    if file_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing file".into()));
    }
    let id = chunk_id(&file_bytes);
    let p = chunk_path(&state.data_root, &id);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(intern)?;
    }
    let mut f = fs::File::create(&p).await.map_err(intern)?;
    f.write_all(&file_bytes).await.map_err(intern)?;
    f.flush().await.map_err(intern)?;

    let man = FileManifest {
        total_size: file_bytes.len() as u64,
        chunks: vec![ChunkRef {
            id: id.clone(),
            size: file_bytes.len() as u32,
        }],
        mime,
        created_ts: time::OffsetDateTime::now_utc(),
    };
    let man_json = serde_json::to_string(&man).map_err(intern)?;
    let db = state.db.clone();
    let id_clone = id.clone();
    spawn_blocking(move || -> Result<(), rusqlite::Error> {
        let conn = db.lock().unwrap();
        upsert_manifest(&conn, &id_clone, &man_json)?;
        Ok(())
    })
    .await
    .map_err(intern)?
    .map_err(intern)?;

    Ok(Json(man))
}

async fn get_chunk(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
) -> Result<(StatusCode, Bytes), (StatusCode, String)> {
    let p = chunk_path(&state.data_root, &id);
    if p.exists() {
        let data = tokio::fs::read(p).await.map_err(intern)?;
        return Ok((StatusCode::OK, Bytes::from(data)));
    }
    Err((StatusCode::NOT_FOUND, "not found".into()))
}

fn intern<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_id() {
        let data = b"hello";
        let id = chunk_id(data);
        assert_eq!(id, blake3::hash(data).to_hex().to_string());
    }

    #[test]
    fn test_chunk_path() {
        let root = PathBuf::from("/tmp/data");
        let id = "1234567890abcdef1234567890abcdef";
        let p = chunk_path(&root, id);
        assert!(p.ends_with(Path::new("12/34/1234567890abcdef1234567890abcdef")));
    }

    #[test]
    fn test_manifest_sqlite() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE manifests (id TEXT PRIMARY KEY, manifest TEXT NOT NULL)",
            [],
        )
        .unwrap();

        let man = FileManifest {
            total_size: 5,
            chunks: vec![ChunkRef {
                id: "abc".into(),
                size: 5,
            }],
            mime: None,
            created_ts: time::OffsetDateTime::now_utc(),
        };
        let man_json = serde_json::to_string(&man).unwrap();
        conn.execute(
            "INSERT INTO manifests (id, manifest) VALUES (?1, ?2)",
            params!["abc", man_json],
        )
        .unwrap();

        let row: String = conn
            .query_row(
                "SELECT manifest FROM manifests WHERE id = ?1",
                params!["abc"],
                |r| r.get(0),
            )
            .unwrap();
        let loaded: FileManifest = serde_json::from_str(&row).unwrap();
        assert_eq!(loaded.total_size, man.total_size);
    }
}
